/**
 * Demo expiry teardown (step 3) — makes the advertised expiry actually true.
 *
 * The window is DEMO_EXPIRY_DAYS (outreach-assets.ts), currently 60 days —
 * raised from 14 on 2026-08-10 because the clock starts at Gate 3 APPROVAL
 * while sending is manual, so a 14-day window was really "14 days minus
 * however long the email sat in the queue".
 *
 * ⚠️ Do not restate the number here. This comment said "14 days" for six days
 * after the constant became 60, which is exactly the drift DEMO_EXPIRY_DAYS
 * was made a single source of truth to prevent.
 *
 * Scans every runs/<prospect>/<run>/state.json for demos that are:
 *   - sent      (outreachApprovedBy set)
 *   - expired   (demoExpiresAt <= today, UTC date)
 *   - not yet torn down (no demoTornDownAt)
 * and deprecates the demo release via the admin endpoint
 *   GET /white-label/<ws>/release/<id>/deprecate
 * (release.deprecateRelease() — takes the published release out of service so
 * the public demo link stops serving; workspace + data are preserved, so a
 * returning prospect can be re-published). Stamps demoTornDownAt on success.
 *
 * Idempotent and safe to run on any schedule. Designed to be the daily cron's
 * command:  npm run teardown   (add --dry-run to preview).
 *
 * Auth: uses the divinci CLI's OAuth session (same as the rest of the
 * pipeline's admin calls). review-board creds are not needed here.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunState } from "./types.js";
import { lazyEnv } from "./require-env.js";

const execFileP = promisify(execFile);

const orchestratorDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// .env loader (REVIEW_BOARD_URL/DIVINCI_* — keep in sync with run.ts)
{
  // .env.stage last: it carries a short-lived staging bearer written by
  // capture-stage-token.ts. Kept in its OWN file rather than appended to .env
  // so it can be deleted the moment the cleanup is done, without editing a
  // file the rest of the pipeline depends on.
  for (const name of [".env", ".env.stage"]) {
    const envPath = join(orchestratorDir, name);
    if (!existsSync(envPath)) continue;
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  }
}

const repoRoot = resolve(orchestratorDir, "..");
const runsDir = join(repoRoot, "runs");
const dryRun = process.argv.includes("--dry-run");
const today = new Date().toISOString().slice(0, 10);

interface DueDemo {
  statePath: string;
  state: RunState;
}

function findDueDemos(): DueDemo[] {
  const due: DueDemo[] = [];
  if (!existsSync(runsDir)) return due;
  for (const prospect of readdirSync(runsDir)) {
    const pDir = join(runsDir, prospect);
    let runs: string[];
    try {
      runs = readdirSync(pDir);
    } catch {
      continue;
    }
    for (const run of runs) {
      const statePath = join(pDir, run, "state.json");
      if (!existsSync(statePath)) continue;
      let state: RunState;
      try {
        state = JSON.parse(readFileSync(statePath, "utf8"));
      } catch {
        continue;
      }
      if (!state.outreachApprovedBy) continue; // never sent
      if (!state.releaseId || !state.demoExpiresAt) continue;
      if (state.demoTornDownAt) continue; // already done
      if (state.demoExpiresAt > today) continue; // not yet due
      due.push({ statePath, state });
    }
  }
  return due;
}

/**
 * Superseded demos: an older run whose prospect ALREADY has a newer deployed
 * run. Selected as a pure function so the "never strand a prospect" rule is
 * testable without touching the network.
 *
 * These are the duplicates that accumulate when a prospect is re-run: both the
 * June and the August demo stay live, both hold a Gate 3 task, and both count
 * against the live-site cap. The old one is not expired and was never
 * approved, so the expiry path above will never collect it — on 2026-08-10
 * eleven of them were pinning the cap on their own.
 *
 * Two rules, both load-bearing:
 *   - the SURVIVOR must be deployed (`landingUrl`). Tearing down the older
 *     demo when the newer one never reached the landing step would leave the
 *     prospect with no demo at all.
 *   - an APPROVED older run is left alone. Approval means someone may already
 *     have mailed that exact link, and a link in a sent email must not go dark
 *     because a newer build happened to exist.
 */
export function findSupersededDemos<T extends { prospect: string; run: string; landingUrl?: string; releaseId?: string; outreachApprovedBy?: string; demoTornDownAt?: string }>(
  states: T[],
): T[] {
  const newestDeployed = new Map<string, string>();
  for (const s of states) {
    if (!s.landingUrl || s.demoTornDownAt) continue;
    const cur = newestDeployed.get(s.prospect);
    if (!cur || s.run > cur) newestDeployed.set(s.prospect, s.run);
  }
  return states.filter(
    (s) =>
      s.landingUrl &&
      s.releaseId &&
      !s.demoTornDownAt &&
      !s.outreachApprovedBy &&
      newestDeployed.get(s.prospect) !== undefined &&
      newestDeployed.get(s.prospect)! > s.run,
  );
}

/**
 * The Cloudflare Worker serving a run's landing page.
 *
 * `landingWorkerName` is authoritative; the URL is parsed only for older runs
 * written before that field existed.
 */
export function workerNameFor(
  state: { landingWorkerName?: string; landingUrl?: string },
): string | undefined {
  if (state.landingWorkerName) return state.landingWorkerName;
  const m = /^https:\/\/([a-z0-9-]+)\.[a-z0-9-]+\.workers\.dev/i.exec(state.landingUrl ?? "");
  return m ? m[1] : undefined;
}

/**
 * Which landing WORKERS may be deleted — the step teardown never had.
 *
 * Deprecating the release takes the demo's CHAT out of service. The landing
 * page is a SEPARATE Cloudflare Worker serving its own bundled assets, and
 * nothing ever deleted it — so every demo ever built stayed a live script, and
 * Cloudflare caps Workers per account (500 on the Paid plan). Left alone, a
 * pipeline that builds demos continuously walks into that ceiling.
 *
 * ⛔ The worker is named per PROSPECT (`demo-<prospect>-landing`), NOT per run
 * — exactly like the R2 asset prefix above, and with the same hazard. When a
 * prospect is re-run, the old run and the new one share one worker, so deleting
 * on a per-run basis takes the LIVE demo dark the moment the older superseded
 * run is collected. A worker is therefore deleted only when NO run still
 * entitles it to serve.
 *
 * "Still entitled" is deliberately generous, because the cost of the two
 * mistakes is not symmetric: a worker kept too long costs one script slot, a
 * worker deleted too early takes a prospect's live demo dark mid-outreach.
 *   - a run with no expiry date recorded counts as ALIVE (we cannot show it is
 *     finished, so we do not act on it)
 *   - a worker no run mentions at all is NEVER returned — absence of evidence
 *     is not evidence. Hand-built demos deployed outside the pipeline have no
 *     state file, and collecting them would delete a live page nothing here
 *     knows about.
 *
 * A worker already collected is excluded via `landingWorkerDeletedAt`, or every
 * later run would re-issue a doomed delete for it forever (wrangler exits 1
 * with code 10090 on a missing Worker). The rule is ALL referencing runs must
 * carry the stamp, not any: a prospect re-run after collection recreates the
 * same worker name, and "any" would exclude that new worker permanently.
 */
export function findDeletableWorkers<T extends { demoExpiresAt?: string; demoTornDownAt?: string; landingWorkerName?: string; landingUrl?: string; landingWorkerDeletedAt?: string }>(
  states: T[],
  today: string,
): string[] {
  const referenced = new Map<string, T[]>();
  for (const s of states) {
    const w = workerNameFor(s);
    if (!w) continue;
    const list = referenced.get(w);
    if (list) list.push(s);
    else referenced.set(w, [s]);
  }
  const stillServing = (s: T): boolean => {
    if (s.demoTornDownAt) return false;
    if (!s.demoExpiresAt) return true; // unknown end date — never act on it
    return s.demoExpiresAt > today;
  };
  return [...referenced.entries()]
    .filter(([, runs]) => runs.every((s) => !stillServing(s)))
    .filter(([, runs]) => !runs.every((s) => s.landingWorkerDeletedAt))
    .map(([w]) => w)
    .sort();
}

/**
 * Flags that target the environment a given demo actually lives on.
 *
 * Teardown used to invoke the CLI bare, which silently means "whatever the
 * default profile points at" — prod. Every staging-era demo therefore failed
 * with `Not found: not found`, because the release genuinely does not exist in
 * prod. Twelve superseded demos failed that way on 2026-08-10 and the error
 * reads like a missing record rather than a wrong environment.
 *
 * `--api-url` alone is NOT sufficient: auth is per-environment, so pointing a
 * prod session at staging returns `Permission denied. forbidden`. A staging
 * SESSION is required too, hence `--profile`.
 */
function envFlags(state: RunState): string[] {
  const flags: string[] = [];
  if (state.apiUrl) flags.push("--api-url", state.apiUrl);
  const profile = profileFor(state.apiUrl);
  if (profile) flags.push("--profile", profile);
  return flags;
}

/**
 * Which CLI profile serves a given API URL.
 *
 * `--profile` on the command line wins. Otherwise a per-environment override
 * (TEARDOWN_PROFILE_STAGE) is consulted, so staging can be torn down without
 * disturbing the default profile the hourly loop depends on for prod.
 *
 * Deliberately returns undefined rather than guessing a name: an unknown
 * profile makes the CLI fail loudly, which is the right outcome — quietly
 * falling back to `default` is how a staging teardown ends up authenticated
 * against production.
 */
export function profileFor(apiUrl: string | undefined, env = process.env): string | undefined {
  const explicit = argFlag("--profile", process.argv);
  if (explicit) return explicit;
  if (apiUrl && /\bstage\b/.test(apiUrl)) return env.TEARDOWN_PROFILE_STAGE;
  return undefined;
}

export function argFlag(name: string, argv: string[]): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
}

/**
 * A bearer token for an environment the CLI has no session for.
 *
 * The CLI authenticates per-profile via browser OAuth, and `divinci auth login`
 * writes to `default` whatever profile you ask for — so obtaining a staging
 * session repoints the very profile the hourly loop uses for prod. A bearer
 * lifted from an authenticated staging web session sidesteps that entirely:
 * nothing about the CLI's stored credentials changes.
 *
 * Env-only, never a CLI flag: a flag value is visible in `ps` output, and
 * several agents share this machine.
 */
function bearerFor(apiUrl: string | undefined, env = process.env): string | undefined {
  if (apiUrl && /\bstage\b/.test(apiUrl)) return env.DIVINCI_STAGE_BEARER;
  return env.DIVINCI_BEARER;
}

async function deprecate(state: RunState): Promise<void> {
  const bearer = bearerFor(state.apiUrl);
  if (bearer) {
    const res = await fetch(
      `${state.apiUrl}/white-label/${state.workspaceId}/release/${state.releaseId}/deprecate`,
      { headers: { authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(120_000) },
    );
    if (!res.ok) {
      // Read the body for the reason, but keep it short: this is printed per
      // failure across a whole fleet.
      const body = (await res.text().catch(() => "")).slice(0, 160);
      throw new Error(`HTTP ${res.status} ${res.statusText}${body ? ` — ${body}` : ""}`);
    }
    return;
  }
  await execFileP(
    "divinci",
    [
      "api",
      "GET",
      `/white-label/${state.workspaceId}/release/${state.releaseId}/deprecate`,
      "--no-color",
      ...envFlags(state),
    ],
    { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }
  );
}

const R2_BUCKET = lazyEnv("DEMO_ASSETS_R2_BUCKET", "the R2 bucket demo media was uploaded to");
// Generated demo assets uploaded per prospect (brand-media + headshot finder).
// The headshot is a real person's photo, so cleanup matters for privacy — not
// just hygiene. Best-effort; missing keys are not an error.
const DEMO_ASSET_KEYS = ["hero.webp", "corpus.mp4", "corpus.webm", "corpus-poster.webp", "headshot.webp"];

async function purgeDemoAssets(prospect: string): Promise<number> {
  const CF = { ...process.env };
  delete CF.CLOUDFLARE_API_TOKEN; delete CF.CLOUDFLARE_EMAIL; delete CF.CLOUDFLARE_ACCOUNT_ID;
  let purged = 0;
  for (const key of DEMO_ASSET_KEYS) {
    try {
      await execFileP("npx", ["wrangler", "r2", "object", "delete", `${R2_BUCKET()}/${prospect}/${key}`, "--remote"],
        { env: CF, timeout: 60_000 });
      purged++;
    } catch { /* key may not exist for this prospect — fine */ }
  }
  return purged;
}

/**
 * A Cloudflare Worker name we are willing to pass to a DELETE.
 *
 * The name comes off disk (`state.json`), and it is spread into an argv array
 * for a destructive command. execFile takes no shell, so there is no injection
 * here — but an argv element beginning with `-` is read by wrangler as a FLAG,
 * and a corrupt or hand-edited state could otherwise steer the delete. This is
 * an allowlist for that reason, not a formatting nicety.
 */
export function isSafeWorkerName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(name);
}

/**
 * Did the delete fail only because the Worker is already gone?
 *
 * That is the state we wanted, so it counts as success — otherwise a worker
 * removed by hand is retried on every run for ever. Cloudflare returns 10090
 * ("This Worker does not exist on this account") and wrangler exits 1.
 */
export function isWorkerAlreadyGone(message: string): boolean {
  return /\b10090\b/.test(message) || /does not exist on this account/i.test(message);
}

/**
 * Delete a landing Worker.
 *
 * Uses `wrangler` with the ambient Cloudflare token scrubbed, exactly as the R2
 * purge above does: the orchestrator env carries no CLOUDFLARE_API_TOKEN, so a
 * REST call would fail closed, while wrangler's stored OAuth session is what
 * the pipeline already deploys and purges with.
 *
 * `--force` is required and does double duty — it is also what makes the
 * command non-interactive. Verified against a throwaway worker with stdin
 * closed: it deletes and exits 0 without prompting. Do not drop it on the
 * assumption that it only relaxes the dependency check.
 */
async function deleteLandingWorker(name: string): Promise<void> {
  if (!isSafeWorkerName(name)) throw new Error(`refusing to delete unsafe worker name ${JSON.stringify(name)}`);
  const CF = { ...process.env };
  delete CF.CLOUDFLARE_API_TOKEN; delete CF.CLOUDFLARE_EMAIL; delete CF.CLOUDFLARE_ACCOUNT_ID;
  try {
    await execFileP("npx", ["wrangler", "delete", name, "--force"], { env: CF, timeout: 120_000 });
  } catch (err) {
    const msg = `${(err as Error).message}${(err as { stderr?: string }).stderr ?? ""}`;
    if (!isWorkerAlreadyGone(msg)) throw err;
  }
}

/**
 * Collect the landing Workers of demos that are finished.
 *
 * Runs AFTER the deprecation pass and re-reads state from disk, so a run torn
 * down moments ago is already counted as finished and its worker collected in
 * the same invocation.
 */
async function collectWorkers(): Promise<void> {
  const all = allStates();
  const deletable = findDeletableWorkers(all.map((d) => d.state), today);
  if (!deletable.length) {
    console.log("[teardown] no landing workers to collect.");
    return;
  }
  console.log(`[teardown] ${deletable.length} landing worker(s) to delete${dryRun ? " (dry-run)" : ""}`);
  for (const name of deletable) {
    if (dryRun) {
      console.log(`  would delete worker: ${name}`);
      continue;
    }
    try {
      await deleteLandingWorker(name);
      // Stamp EVERY run that names this worker. Missing one leaves the set
      // partially stamped, which correctly re-attempts next run rather than
      // silently skipping — but writing them all is what stops the retry.
      const stampedAt = new Date().toISOString();
      for (const { statePath, state } of all) {
        if (workerNameFor(state) !== name || state.landingWorkerDeletedAt) continue;
        state.landingWorkerDeletedAt = stampedAt;
        state.log?.push({ at: stampedAt, msg: `teardown: landing worker ${name} deleted` });
        writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
      }
      console.log(`  ✓ deleted worker ${name}`);
    } catch (err) {
      // Never fatal: a worker deleted by hand, or a transient API error, must
      // not stop the rest of the sweep.
      console.error(`  ✗ FAILED deleting worker ${name}: ${(err as Error).message.split("\n")[0]}`);
    }
  }
}

/** All run states on disk, with their paths — the input to either selector. */
function allStates(): DueDemo[] {
  const out: DueDemo[] = [];
  if (!existsSync(runsDir)) return out;
  for (const prospect of readdirSync(runsDir)) {
    let runs: string[];
    try {
      runs = readdirSync(join(runsDir, prospect));
    } catch {
      continue;
    }
    for (const run of runs) {
      const statePath = join(runsDir, prospect, run, "state.json");
      if (!existsSync(statePath)) continue;
      try {
        out.push({ statePath, state: JSON.parse(readFileSync(statePath, "utf8")) });
      } catch {
        /* half-written state.json is not a teardown candidate */
      }
    }
  }
  return out;
}

async function main(): Promise<void> {
  const superseded = process.argv.includes("--superseded");
  let due: DueDemo[];
  if (superseded) {
    const all = allStates();
    const pick = new Set(findSupersededDemos(all.map((d) => d.state)).map((s) => `${s.prospect}/${s.run}`));
    due = all.filter((d) => pick.has(`${d.state.prospect}/${d.state.run}`));
  } else {
    due = findDueDemos();
  }
  if (!due.length) {
    console.log(`[teardown] ${today}: no ${superseded ? "superseded" : "expired"} demos due.`);
    // Still sweep: a run torn down on an earlier pass (before worker collection
    // existed, or whose delete failed) leaves a worker nothing else will ever
    // collect.
    await collectWorkers();
    return;
  }
  console.log(`[teardown] ${today}: ${due.length} ${superseded ? "superseded" : "expired"} demo(s)${dryRun ? " (dry-run)" : ""}`);
  for (const { statePath, state } of due) {
    const label = superseded
      ? `${state.prospect}/${state.run} release ${state.releaseId} (superseded)`
      : `${state.prospect}/${state.run} release ${state.releaseId} (expired ${state.demoExpiresAt})`;
    if (dryRun) {
      // The dry-run must describe what the real run will DO. It previously
      // claimed an R2 purge unconditionally, so a --superseded preview
      // advertised deleting assets it deliberately leaves alone — and a
      // preview that misstates the destructive half is worse than none.
      console.log(
        superseded
          ? `  would deprecate: ${label} — R2 assets under ${state.prospect}/ LEFT IN PLACE (shared with the surviving run)`
          : `  would deprecate: ${label} + purge R2 assets (${DEMO_ASSET_KEYS.length} keys under ${state.prospect}/)`,
      );
      continue;
    }
    try {
      await deprecate(state);
      // ⛔ NEVER purge R2 for a superseded run. Demo assets are keyed by
      // PROSPECT (`<bucket>/<prospect>/hero.webp`), not by run — so the older
      // run shares its prefix with the newer one that is replacing it, and
      // purging here would delete the surviving demo's hero, corpus video and
      // headshot out from under a live page.
      //
      // Nothing is leaked by skipping it: the survivor is still using those
      // exact objects, and they are collected when IT is eventually torn down
      // on expiry.
      const purged = superseded ? 0 : await purgeDemoAssets(state.prospect).catch(() => 0);
      state.demoTornDownAt = new Date().toISOString();
      state.log?.push({
        at: state.demoTornDownAt,
        msg: superseded
          ? "teardown: release deprecated (superseded by a newer deployed run; R2 assets left in place — shared prefix)"
          : `teardown: release deprecated + ${purged} R2 asset(s) purged (expired ${state.demoExpiresAt})`,
      });
      writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
      // "purged 0 R2 asset(s) incl. headshot" reads as though a headshot was
      // collected and there simply were none — in superseded mode nothing is
      // purged BY DESIGN, and a privacy-relevant claim should never be
      // ambiguous about whether it happened.
      console.log(
        superseded
          ? `  ✓ deprecated ${label} (R2 assets retained — still in use by the surviving run)`
          : `  ✓ deprecated ${label} (+ purged ${purged} R2 asset(s) incl. headshot)`,
      );
    } catch (err) {
      console.error(`  ✗ FAILED ${label}: ${(err as Error).message.split("\n")[0]}`);
    }
  }
  await collectWorkers();
}

// Only when RUN as a script — never on import.
//
// This module used to call main() at import time, so merely importing it to
// unit-test a selector executed the real teardown. It printed
// "[teardown] no expired demos due" from inside the test run, which was the
// harmless version; with different argv it would deprecate live releases as a
// side effect of `import`.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
