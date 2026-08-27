/**
 * Demo factory orchestrator (v0.2 — review board gates).
 *
 * Usage:
 *   npm run demo -- --prospect acmespine [--run 2026-06-10-001]
 *                   [--profile default]
 *                   [--watch] [--watch-interval 30]
 *                   [--demo-approved-by "Name"]  # legacy bypass
 *
 * Reads  runs/<prospect>/<run>/manifest.json (authored in the research step,
 * approved by a human at Gate 1) and drives the divinci CLI through:
 *
 *   research → GATE 1 → workspace → vector → ingest → hygiene → probe
 *            → GATE 2 → release
 *
 * All spend (workspace creation, crawling, embedding) sits AFTER Gate 1.
 *
 * Gates now create review-board tasks (IN_REVIEW). Mark them DONE to approve or
 * CANCELED to reject. With --watch the orchestrator polls instead of exiting.
 * State persists to runs/<prospect>/<run>/state.json after every step.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dv, extractObjectId, guardCheck, parseJsonArray, ragFileCount, DRY_RUN } from "./divinci.js";
import { isHostAlreadyCrawling } from "./run-policy.js";
import { acquireRunLock } from "./run-lock.js";
import { createTask, findOrCreateProject, getTask, isAvailable, updateTask, BoardUnavailableError } from "./review-board.js";
import { complianceSystemPrompt } from "./compliance-prompt.js";
import { personaSystemPrompt } from "./persona-prompt.js";
import { demoLink, ensureReleaseRagLinked, parseMultiReleaseRun, qaRunUrl, qaSuiteReportUrl, releaseDemoReadiness, workspaceUrl, workspaceVectorsUrl } from "./qa.js";
import { measureLogoBaselineDrop } from "./logo-baseline.js";
import { buildAndDeployLanding, backfillBrandDraft, repairDoubledAiSuffix, repairRedundantOgSubtitle, hardenDemoRelease, looksLikeOrganisation, type LandingBrandDraft, WORKERS_SUBDOMAIN } from "./landing.js";
import { generateEnTs } from "./copy-gen.js";
import { extractBrand, aiProductName, type ExtractedBrand } from "./brand-extract.js";
import { generateBrandMedia, uploadDemoAsset } from "./brand-media.js";
import { findHeadshot, findTeam, COMMON_PATHS } from "./headshot-finder.js";
import { expandVideoUrls, ingestVideo } from "./video-ingest.js";
import { submitUrlsToWwwRag, wwwRagEnabled } from "./www-rag.js";
import { generateQaSuite } from "./qa-suite-gen.js";
import { COVERAGE_HALT_THRESHOLD, auditCoverage, fetchSitemapUrls } from "./coverage-audit.js";
import { checkAuth, formatVerdict } from "./auth-preflight.js";
import { STEP_ORDER, gate2Decision, gatesAreAdvisory, resolveCursor, smokeLiveRefusal, stepOrderViolations, validateOnlySteps } from "./run-policy.js";
import {
  DEMO_EXPIRY_DAYS,
  demoLinkBlock,
  draftOutreachAssets,
  emailLinkProblems,
} from "./outreach-assets.js";
import { ingestDocument } from "./document-ingest.js";
import { autoApproveGate1 } from "./gate1-auto.js";
import { formatDefects, measureUntilStable } from "./demo-preflight.js";
import { checkClaims, claimedPageCount } from "./claims-check.js";
import { formatTriage, triage } from "./qa-triage.js";
import { decideScoping } from "./crawl-scoping.js";
import { averageScorers, medianIndex, summariseReplicates, worstTestScore } from "./qa-replicates.js";
import { formatProposal, proposeArena } from "./arena-proposal.js";
import { defaultCachePath, resolveStack } from "./rag-stack.js";
import { safeGet } from "./net-guard.js";

/** Fences the preflight block so a re-run replaces it instead of stacking copies. */
const PREFLIGHT_MARK = "<!-- preflight:start -->";
const PREFLIGHT_END = "<!-- preflight:end -->";

/**
 * Fences the email draft itself, embedded in the Gate 3 card.
 *
 * ⚠️ These strings are shared with `scripts/surface-outreach-drafts.py`, which
 * back-fills the same block onto cards filed before this existed. They must
 * stay byte-identical: a divergence does not fail, it silently produces cards
 * carrying the SAME email twice, which is how people learn to stop reading the
 * card.
 *
 * Why the draft is embedded rather than linked: this card asks a human to send
 * an email, and it used to give them a FILE PATH. Measured 2026-08-15 — 72
 * finished drafts on disk, 51 cards waiting, zero emails ever sent, and 35
 * cards bulk-closed in one day with no send. The copy was good; nobody could
 * see it without opening a checkout.
 */
/** Fences the QA triage block on the Gate 2 card. */
/** Fences the costed arena proposal. Separate from the triage block: triage
 *  is a finding and stays put; the proposal is a plan that may be superseded. */
const PROPOSAL_MARK = "<!-- divinci:arena-proposal:begin -->";
const PROPOSAL_END = "<!-- divinci:arena-proposal:end -->";
const TRIAGE_MARK = "<!-- divinci:qa-triage:begin -->";
const TRIAGE_END = "<!-- divinci:qa-triage:end -->";

const DRAFT_MARK = "<!-- divinci:outreach-draft:begin -->";
const DRAFT_END = "<!-- divinci:outreach-draft:end -->";
import { parseQueue } from "./intake.js";
import { validateManifest, type Manifest, type RunState } from "./types.js";
import { findReleaseSplit, describeSplit } from "./served-release.js";
import { lazyEnv } from "./require-env.js";

// Load orchestrator/.env (KEY=VALUE lines) if present — no dotenv dependency.
// Real environment variables win over .env values.
{
  const envPath = resolve(dirname(fileURLToPath(import.meta.url)), "../.env");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  }
}

// review-board project name pattern: one project per prospect, created on first run.
// The ID is persisted in state.json so subsequent runs reuse it without an API call.
function boardProjectName(prospectName: string): string {
  return `Demo — ${prospectName}`;
}

async function resolveProject(): Promise<string> {
  if (state.boardProjectId) return state.boardProjectId;
  const id = await findOrCreateProject({
    name: boardProjectName(manifest.prospectName),
    description: `Gate tasks for the ${manifest.prospectName} demo run. Corpus manifest (Gate 1) and demo quality review (Gate 2) tracked here.`,
  });
  state.boardProjectId = id;
  save();
  return id;
}

/**
 * Exit codes — the loop driver's only channel for telling outcomes apart.
 *
 * Everything used to exit 0: a run parked awaiting a human decision, and a run
 * that did nothing because review board was unreachable, were indistinguishable from
 * a run that completed. Overnight that reads as "all good" while the pipeline
 * quietly accomplishes nothing.
 */
export const EXIT_OK = 0;
/** Parked at a gate awaiting a human decision. Expected, not a failure. */
export const EXIT_GATE_PARKED = 10;
/** A dependency the run needs is unreachable (review board). Nothing was done. */
export const EXIT_INFRA_DOWN = 20;
/** The session cannot be renewed — only an interactive `divinci auth login` fixes it. */
export const EXIT_AUTH_EXPIRED = 30;
/**
 * The server is ALREADY crawling this host (HTTP 423). Not a failure: work is
 * in progress, this run simply cannot add more right now.
 *
 * Reported as a generic exit 1 it becomes self-sustaining. The CLI's `--wait`
 * gives up after 30 minutes while the SERVER KEEPS CRAWLING; the loop records a
 * failure and retries an hour later; the crawl is often still running, so the
 * retry gets 423 and fails too. Enough repeats and quarantine parks a run whose
 * only problem was that its own previous crawl had not finished.
 */
export const EXIT_HOST_BUSY = 40;
/**
 * Another process is already working this run directory. Nothing was done.
 *
 * Distinct from a failure: the run is not broken and the other process may well
 * be about to finish it. The loop treats this like a busy host — retry later,
 * no alert, and NO failure recorded, so waiting can never accumulate into
 * quarantine.
 */
export const EXIT_RUN_LOCKED = 50;


const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// Same resolution as loop.ts — Gate 1 auto-approval checks the queue entry for
// the score and any operator note asking for review.
const QUEUE_PATH = process.env.PROSPECT_QUEUE ?? join(repoRoot, "research", "prospect-queue.yaml");

const args = parseArgs(process.argv.slice(2));
const prospect = args.prospect;
if (!prospect) fail("--prospect <slug> is required");
// The synthetic fixture must never reach a real API — see smokeLiveRefusal.
const smokeRefusal = smokeLiveRefusal(prospect);
if (smokeRefusal) fail(smokeRefusal);
const watchMode = "watch" in args;
const watchInterval = Number(args["watch-interval"] ?? 30) * 1000;
const runId = args.run ?? latestRun(prospect);
/**
 * The pipeline commit this process is running.
 *
 * "unknown" rather than a throw when git is unavailable: a missing stamp must
 * never stop a run, and an honest "unknown" is more useful than a guess — it
 * says the artifact's vintage cannot be established, which is itself the fact a
 * reader needs.
 */
const PIPELINE_SHA = (() => {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || "unknown";
  } catch {
    return "unknown";
  }
})();

const runDir = join(repoRoot, "runs", prospect, runId);
const manifestPath = join(runDir, "manifest.json");
const statePath = join(runDir, "state.json");

if (!existsSync(manifestPath))
  fail(
    `no manifest at ${manifestPath} — author one in the research step first (see docs/ARCHITECTURE.md)`
  );

// ONE WRITER PER RUN DIRECTORY. Taken before any state is read, because the
// damage is done at read time: each process holds state.json in memory and
// save()s it after every step, so the last writer wins with a snapshot taken
// before the others' work existed. See run-lock.ts for what that cost.
//
// Released via process.on("exit"), NOT a single call site — run.ts exits from a
// dozen places (gates park, review board down, auth expired, host busy, fail()), and
// a release attached to only some of them leaves a lock behind on the others.
{
  const lock = acquireRunLock(runDir, process.argv.slice(2).join(" "));
  if (!lock.ok) {
    console.error(`\n⛔ ${lock.message}\n`);
    process.exit(EXIT_RUN_LOCKED);
  }
  process.on("exit", lock.release);
  // Signals do not run "exit" handlers on their own. Re-raise after releasing
  // so the caller still sees a signal death rather than a clean exit.
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      lock.release();
      // Remove THIS handler before re-raising, or the re-raise re-enters it and
      // the process spins instead of dying.
      process.removeAllListeners(sig);
      process.kill(process.pid, sig);
    });
  }
}

const manifest: Manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const manifestErrors = validateManifest(manifest);
if (manifestErrors.length) fail(`manifest invalid:\n  - ${manifestErrors.join("\n  - ")}`);

const state: RunState = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, "utf8"))
  : {
      prospect,
      run: runId,
      step: "gate1",
      pagesCrawled: 0,
      ingested: [],
      log: [],
    };

if (args["demo-approved-by"]) state.demoApprovedBy = args["demo-approved-by"];

/**
 * ⚠️ MODULE-LEVEL CONSTANTS MUST BE DECLARED ABOVE THIS POINT.
 *
 * run.ts EXECUTES the pipeline during module evaluation (the `for (; cursor <
 * steps.length …)` loop below is top-level code, not a main()). A `const`
 * declared further down the file is therefore still in its TEMPORAL DEAD ZONE
 * while the steps run, and any step function that closes over it throws
 * `ReferenceError: Cannot access 'X' before initialization` — at runtime, in
 * one step, on the machine, having type-checked and passed every unit test.
 *
 * Both of these were declared beside the function that uses them, which is
 * ordinarily the right place and is wrong in this file. Acme Clinic's landing
 * step died on QA_PUBLISH_MIN and would have died on TIER_HAZARD_SUMMARY four
 * lines later. `run-wiring.test.ts` now fails if a new one appears below.
 */
// Raised 0.80 -> 0.90 on 2026-08-16. Consequence, measured before flipping it:
// 50 of the catalogue's 72 scored runs (69%) fall below 90%, against a
// population mean of 83.9%. So this gate is ABOVE the pipeline's current
// typical output by design — it is a target, not a description — and most runs
// will now enter triage. That is affordable because triage is arithmetic over
// data already on disk; what it is NOT is a licence to auto-approve arenas,
// which still require a human (see the proposal emitter).
//
// ⚠️ With sd ~3.8pp and 3 replicates, SEM is ~2.2pp: a release whose TRUE mean
// is 87% has a 95% upper bound of ~91% and will read as "not established"
// rather than short. That is correct and it is why the gate does not simply
// fail two thirds of runs outright.
/** Host -> sitemap URLs, so five sources on one host fetch it once.
 *  Declared HERE, above the step loop: run.ts executes during module
 *  evaluation, so a const beside its function is in the temporal dead zone
 *  while the steps run (see run-wiring.test.ts). */
const sitemapCache = new Map<string, string[]>();

const QA_PUBLISH_MIN = Number(process.env.QA_PUBLISH_MIN_SCORE ?? 0.9);

/** One-line, prospect-facing description of what the suite probed. */
const TIER_HAZARD_SUMMARY: Record<Manifest["complianceTier"], string> = {
  "wellness-low": "presenting general wellness content as personal medical advice",
  "commerce-medium": "stating prices, terms or comparisons the site does not support",
  "clinic-high": "diagnosing, triaging or interpreting results for an individual",
  "sensitive-audience": "mishandling a reader in distress instead of handing off",
};

const steps: Array<[string, () => Promise<void>]> = [
  ["gate1", gate1],
  ["workspace", createWorkspace],
  ["vector", createVector],
  ["ingest", ingest],
  ["wwwrag", wwwRagSubmit],
  ["hygiene", hygiene],
  ["probe", probe],
  // ⚠️ ORDER IS LOAD-BEARING: `release` MUST precede `qa`.
  //
  // qaEval needs the RAG vector attached to the release (without it every test
  // errors with an opaque "(reading 'content')"), and attaching it to a
  // never-published DRAFT 500s on staging — so the vector can only be linked
  // after `release` publishes. `release` also assigns state.releaseId at all.
  //
  // While qa sat before release, a fresh run reached qa with no releaseId,
  // logged "skipping ScoredQA" and produced no score — for EVERY new run. That
  // is the real reason 17 of 19 runs carry qaScore=null, including acmebio,
  // which HAS a hand-authored qa-suite.yaml. The missing-suite theory only ever
  // explained the other 16.
  //
  // The cost of this order: the release is published (anonymous chat on) before
  // the Gate 2 reviewer sees it, so the bare embed link is live pre-review. That
  // is acceptable because the link actually sent to a prospect is the branded
  // landing worker, which is deployed AFTER Gate 2 and behind Basic Auth. The
  // alternative — keeping the old order — is no quality gate at all.
  ["release", release],
  ["qa", qaEval],
  ["gate2", gate2],
  ["landing", landing],
  ["outreach", outreach],
];

// CF KV namespace for landing workers' EMAIL_QUOTA binding (per-account; reused).
const LANDING_KV_ID = lazyEnv(
  "LANDING_KV_NAMESPACE_ID",
  "the Cloudflare KV namespace backing each landing worker's EMAIL_QUOTA binding",
);
// "template" (default) = the maintained SDK template skinned with the brand.
// "generated" = a bespoke per-client homepage (claude -p) that iframes the same
// worker's /embed/ (real branded SDK chat). Same worker, one demo link.
const LANDING_MODE: "template" | "generated" = process.env.LANDING_MODE === "generated" ? "generated" : "template";

const order = steps.map(([name]) => name);

/**
 * The order run-policy.ts documents and tests must BE the order that runs.
 * Without this the two drift and the tests quietly describe a pipeline that no
 * longer exists — which is how the release/qa ordering bug survived: the only
 * statement of intent was a comment.
 */
{
  const violations = stepOrderViolations(order);
  if (violations.length) fail(`pipeline order is invalid:\n  - ${violations.join("\n  - ")}`);
  if (order.join(",") !== STEP_ORDER.join(","))
    fail(
      `steps[] disagrees with STEP_ORDER in run-policy.ts:\n` +
        `  runs:   ${order.join(" → ")}\n  policy: ${STEP_ORDER.join(" → ")}`,
    );
}

/**
 * ONLY_STEPS=landing — run exactly these steps and nothing else.
 *
 * Without it the runner goes from `state.step` to the END, so re-running a
 * finished run to pick up a template fix would also run OUTREACH. No completed
 * run has `outreachApprovedBy`, so outreach would not early-return: it would
 * inject demo links and open outreach tasks for real prospects as a side effect
 * of a UI rebuild. A backfill must be able to touch one stage and stop.
 *
 * Deliberately does NOT advance `state.step` or mark the run done — this is a
 * targeted re-run of a completed pipeline, not a resumption of it.
 */
const onlySteps = (process.env.ONLY_STEPS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

/**
 * Auth preflight — before ANY step, because every step past Gate 1 spends.
 *
 * Catches the two failure modes that make an unattended run worse than no run:
 * a session that can no longer be renewed (fails mid-run, after spending), and
 * a session pointed at a different environment than the run's own checks use
 * (builds the demo in one place and verifies it in another). Skipped in
 * DRY_RUN, which touches no external service.
 */
/**
 * Pin the run to ONE environment.
 *
 * A run's workspace, vector and release live in exactly one Divinci
 * environment. Advancing it against another looks for a workspace that is not
 * there — and before `state.apiUrl` existed, which environment a run belonged
 * to was implicit in whatever the operator's shell happened to hold. The first
 * time a run is touched it is stamped; from then on the recorded value wins
 * over the ambient default, so a run cannot drift environments mid-life.
 */
const DEFAULT_API_URL = "https://api.divinci.app";
if (!state.apiUrl) {
  state.apiUrl = process.env.DIVINCI_API_URL ?? DEFAULT_API_URL;
} else if (process.env.DIVINCI_API_URL && process.env.DIVINCI_API_URL !== state.apiUrl) {
  fail(
    `this run was built against ${state.apiUrl} but DIVINCI_API_URL says ${process.env.DIVINCI_API_URL}.\n` +
      "  A run cannot change environments — its workspace and release exist in only one.\n" +
      "  Unset DIVINCI_API_URL, or advance a run that belongs to that environment.",
  );
}
// Export it so every env-reading helper (qa.ts bases, landing, readiness) sees
// the run's OWN environment rather than the ambient default.
process.env.DIVINCI_API_URL = state.apiUrl;

if (!DRY_RUN && process.env.SKIP_AUTH_PREFLIGHT !== "1") {
  const verdict = await checkAuth({
    profile: args.profile,
    // Only assert environment agreement when the target was stated explicitly.
    // Defaulting it here would make every run that relies on the CLI profile's
    // own environment fail for disagreeing with a default it never chose.
    expectApiUrl: process.env.DIVINCI_API_URL,
  });
  console.log(formatVerdict(verdict));
  if (!verdict.ok) {
    log(`auth preflight failed: ${verdict.reason}`);
    save();
    process.exit(verdict.needsHuman ? EXIT_AUTH_EXPIRED : EXIT_INFRA_DOWN);
  }
}

if (onlySteps.length > 0) {
  const unknown = validateOnlySteps(onlySteps, order);
  if (unknown.length > 0) fail(`ONLY_STEPS names unknown step(s): ${unknown.join(", ")}`);
  for (const [name, fn] of steps) {
    if (!onlySteps.includes(name)) continue;
    log(`step: ${name} (ONLY_STEPS)`);
    await fn();
    save();
  }
  log(`done — ran only: ${onlySteps.join(", ")}`);
  process.exit(0);
}

if (state.step === "done") {
  log("run already complete 🏭 (state.step=done) — nothing to do");
  process.exit(0);
}
let cursor: number;
try {
  cursor = resolveCursor(state.step, order);
} catch (err) {
  fail((err as Error).message);
}

for (; cursor < steps.length; cursor++) {
  const [name, fn] = steps[cursor];
  state.step = name;
  log(`step: ${name}`);
  try {
    await fn();
  } catch (err) {
    // A review board outage is NOT this run's failure. Reported as a generic exit 1
    // it tells the loop "this one run is broken" — so the loop keeps going and
    // alerts once per run per tick, describing the wrong problem. The state is
    // saved first: the run resumes from exactly here once the board returns.
    if (err instanceof BoardUnavailableError) {
      save();
      console.error(`\n⛔ ${err.message}\n`);
      log(`halted at ${name}: ${err.message}`);
      save();
      process.exit(EXIT_INFRA_DOWN);
    }
    // Same reasoning as the review board case: this is not THIS run being broken.
    // The host is busy because a crawl — very likely this run's own, abandoned
    // by the CLI's 30-minute wait while the server carried on — is still going.
    // Retrying is right; recording a failure is not, because a run that is
    // merely waiting must never accumulate its way into quarantine.
    if (isHostAlreadyCrawling(err)) {
      save();
      console.error(`\n⏳ ${name}: the server is already crawling this host — leaving it to finish.\n`);
      log(`paused at ${name}: host already being crawled server-side (423)`);
      save();
      process.exit(EXIT_HOST_BUSY);
    }
    throw err;
  }
  // Stamp WHICH pipeline commit produced this step's output. See RunState.stepSha:
  // three fixes were judged against artifacts built before they existed, once by
  // four minutes, and each time the verdict was "the fix does not work".
  (state.stepSha ??= {})[name] = PIPELINE_SHA;
  save();
}
state.step = "done";
save();
log("run complete 🏭");

// ---------------------------------------------------------------- steps

/**
 * What fraction of the site this plan will actually ingest.
 *
 * Gate 1 showed a page budget and never said what share of the site it was, so
 * "≤80 pages" read as a plan rather than as a 2% sample. Measured 2026-08-05
 * across every demo built to date: near-enough all of them ingested 80-90 pages
 * regardless of site size — acmedoctor took 80 of 4,272, acmelaunch 80 of 3,262.
 * That is a budget artifact, not a crawl outcome, and it was invisible at the
 * only point where a human could have caught it.
 */
function coverageLine(): string {
  const reconPath = join(runDir, "recon.json");
  if (!existsSync(reconPath)) return "**Site coverage:** unknown (no recon.json — manifest was authored by hand)";
  let found = 0;
  let discovery = "unknown";
  try {
    const recon = JSON.parse(readFileSync(reconPath, "utf8")) as { sitemapUrls?: string[]; discovery?: string };
    found = recon.sitemapUrls?.length ?? 0;
    discovery = recon.discovery ?? "unknown";
  } catch {
    return "**Site coverage:** unknown (recon.json unreadable)";
  }
  if (!found) return "**Site coverage:** unknown (recon found no pages)";

  const planned = manifest.sources
    .filter((s) => s.destination === "rag")
    .reduce((n, s) => n + (s.crawl?.limit ?? s.estPages), 0);
  const pct = Math.round((planned / found) * 100);
  const caveat =
    discovery === "shallow-crawl"
      ? " — and `found` came from a depth-2 shallow crawl, so the real site is LARGER and true coverage is lower"
      : "";
  const flag = pct < 25 ? " ⚠️ **thin**" : "";
  return `**Site coverage:** ~${pct}% (${planned} planned of ${found} pages found via ${discovery})${caveat}${flag}`;
}

async function gate1(): Promise<void> {
  // Legacy: manifest already has approvedBy from a direct edit
  if (manifest.approvedBy) {
    log(`gate1 approved by ${manifest.approvedBy} at ${manifest.approvedAt}`);
    return;
  }
  if (DRY_RUN) { manifest.approvedBy = "dry-run"; manifest.approvedAt = "dry-run"; return log("[dry-run] gate1 auto-approved"); }

  if (gatesAreAdvisory()) {
    const approvedAt = new Date().toISOString();
    const approvedBy = "auto (gate advisory)";
    // Persist to manifest.json — the file is the record of truth for Gate 1,
    // and a run resumed later must not re-open the question.
    try {
      const mRaw = JSON.parse(readFileSync(manifestPath, "utf8"));
      mRaw.approvedBy = approvedBy;
      mRaw.approvedAt = approvedAt;
      writeFileSync(manifestPath, JSON.stringify(mRaw, null, 2) + "\n");
    } catch (e) {
      log(`gate1: could not persist approval to manifest.json — ${(e as Error).message}`);
    }
    manifest.approvedBy = approvedBy;
    manifest.approvedAt = approvedAt;
    log(`gate1 ${approvedBy} — advisory mode, not blocking (GATES_BLOCKING=1 restores the pause)`);
    // Board record, best-effort. The board being down must not stop a gate that
    // is no longer waiting on anybody — that would reintroduce the pause by
    // the back door, which is the failure this mode exists to remove.
    try {
      if (await isAvailable()) {
        const projectId = await resolveProject();
        if (state.gate1TaskId) {
          await updateTask(state.gate1TaskId, { status: "DONE" });
        } else {
          const task = await createTask({
            title: `[Gate 1] ${manifest.prospectName} — corpus plan (advisory)`,
            description:
              `Recorded automatically: Gates 1 and 2 are advisory.\n\n` +
              `- Prospect: ${manifest.prospectName} (${manifest.prospect})\n` +
              `- Run: ${manifest.run}\n` +
              `- Compliance tier: ${manifest.complianceTier}\n` +
              `- Planned pages: ${manifest.budgets?.crawlPages ?? "?"}\n` +
              `- Sources: ${manifest.sources.map((s) => s.id).join(", ")}\n\n` +
              `No approval was requested. Gate 3 still requires a human.`,
            projectId,
            priority: "low",
            status: "DONE",
            tags: ["gate1", "advisory", manifest.prospect],
          });
          state.gate1TaskId = task.id;
        }
      }
    } catch (e) {
      log(`gate1: board record skipped — ${(e as Error).message.slice(0, 120)}`);
    }
    save();
    return;
  }

  const boardUp = await isAvailable();
  const projectId = boardUp ? await resolveProject() : undefined;

  // Auto-approval — evaluated whether or not a review task already exists.
  //
  // It used to sit inside `if (!state.gate1TaskId)`, so a run that
  // reached Gate 1 BEFORE auto-approval shipped could never be approved by it:
  // 28 runs were parked indefinitely on criteria that all said APPROVE. The
  // same trap would spring on any future loosening of the criteria — the runs
  // that would benefit are exactly the ones already waiting.
  //
  // An existing task is only cleared when it is still UNTOUCHED. A human who
  // has moved it — above all to CANCELED, which is a rejection — must not be
  // overridden by a machine, and pollGate below handles both decisions.
  if (!manifest.approvedBy) {
    let existingStatus: string | undefined;
    if (state.gate1TaskId && boardUp) {
      existingStatus = await getTask(state.gate1TaskId)
        .then((t) => t.status)
        .catch(() => undefined);
      if (existingStatus && existingStatus !== "TO_DO" && existingStatus !== "IN_REVIEW") {
        log(`gate1: task is ${existingStatus} — leaving the human decision alone`);
      }
    }
    const humanHasMovedIt =
      !!existingStatus && existingStatus !== "TO_DO" && existingStatus !== "IN_REVIEW";
    const verdict = humanHasMovedIt
      ? { approve: false, blockers: [`task is ${existingStatus}`], evidence: [] }
      : await autoApproveGate1(manifest, { queuePath: QUEUE_PATH });
    if (verdict.approve) {
      const approvedAt = new Date().toISOString();
      const approvedBy = "auto (Gate 1 criteria)";
      if (boardUp && state.gate1TaskId) {
        // Already on the board: record the evidence on THAT task and close it.
        // Creating a second one would leave a stale open task behind.
        try {
          const existing = await getTask(state.gate1TaskId);
          await updateTask(state.gate1TaskId, {
            status: "DONE",
            description:
              `${existing.description ?? ""}\n\n---\n\n**Auto-approved** ${approvedAt} against objective criteria. ` +
              `No human read this plan.\n\n### Evidence\n` +
              verdict.evidence.map((e) => `- ${e}`).join("\n"),
          });
          log(`gate1 auto: closed existing task ${state.gate1TaskId}`);
        } catch (err) {
          log(`gate1 auto: could not close task — ${(err as Error).message.split("\n")[0]}`);
        }
      } else if (boardUp) {
        const task = await createTask({
          title: `[Gate 1 — AUTO] ${manifest.prospectName} — corpus manifest approved`,
          description: [
            `## ${manifest.prospectName} — corpus manifest (run ${manifest.run})`,
            "",
            "Auto-approved against objective criteria. **No human read this plan.**",
            "",
            "### Evidence",
            ...verdict.evidence.map((e) => `- ${e}`),
            "",
            `**Compliance tier:** ${manifest.complianceTier}`,
            `**Compliance scope:** ${manifest.complianceNotes}`,
            "",
            "### What this did and did not decide",
            "Approving Gate 1 starts the CRAWL. It ships nothing: this run still",
            "stops at Gate 2 with a live demo and a QA score, and at Gate 3 before",
            "anything is sent. To stop it now, mark this task CANCELED and delete",
            `\`${manifestPath}\`.`,
            "",
            "Disable auto-approval entirely with `GATE1_AUTO_APPROVE=0`.",
          ].join("\n"),
          projectId,
          priority: "low",
          tags: ["gate1", "corpus", "auto-approved", manifest.prospect],
        });
        state.gate1TaskId = task.id;
        try {
          await updateTask(task.id, { status: "DONE" });
        } catch (err) {
          // The approval stands — it is recorded in the manifest below. A task
          // left open is a cosmetic problem; refusing to proceed over one would
          // make review board's availability a gate on our own decision.
          log(`gate1 auto: could not close task ${task.id}: ${(err as Error).message.split("\n")[0]}`);
        }
      }
      const mRaw = JSON.parse(readFileSync(manifestPath, "utf8"));
      mRaw.approvedBy = approvedBy;
      mRaw.approvedAt = approvedAt;
      writeFileSync(manifestPath, JSON.stringify(mRaw, null, 2) + "\n");
      manifest.approvedBy = approvedBy;
      manifest.approvedAt = approvedAt;
      save();
      log(`gate1 AUTO-APPROVED — ${verdict.evidence.join("; ")}`);
      return;
    }
    log(`gate1: not auto-approvable — ${verdict.blockers.join("; ")}`);
  }

  // Create the review-board task if we haven't yet
  if (!state.gate1TaskId) {
    if (!boardUp) {
      save();
      console.error([
        "",
        "⛔ GATE 1 — corpus manifest awaiting approval.",
        `   review board is not running (start with: review-board up).`,
        `   Review ${manifestPath} and re-run to create the approval task.`,
        "",
      ].join("\n"));
      process.exit(EXIT_INFRA_DOWN);
    }
    const ragSources = manifest.sources.filter((s) => s.destination === "rag");
    const sourceLines = ragSources.map((s) =>
      `- [${s.tier}] ${s.url} (≤${s.crawl?.limit ?? s.estPages} pages, license: ${s.license})`
    ).join("\n");
    const task = await createTask({
      title: `[Gate 1] ${manifest.prospectName} — corpus manifest review`,
      description: [
        `## ${manifest.prospectName} — corpus manifest (run ${manifest.run})`,
        "",
        `**Compliance tier:** ${manifest.complianceTier}`,
        `**Compliance notes:** ${manifest.complianceNotes}`,
        "",
        `**Budget:** ${manifest.budgets.crawlPages} pages / ${manifest.budgets.embeddingTokens.toLocaleString()} embedding tokens`,
        coverageLine(),
        "",
        "### Sources to ingest",
        sourceLines,
        "",
        "### Action",
        "Mark **DONE** to approve and start ingestion, **CANCELED** to reject.",
        `Manifest file: \`${manifestPath}\``,
      ].join("\n"),
      projectId,
      priority: "high",
      tags: ["gate1", "corpus", manifest.prospect],
    });
    state.gate1TaskId = task.id;
    save();
    log(`gate1: created review-board task ${task.id}`);
  }

  // Poll / check the task status
  await pollGate({
    taskId: state.gate1TaskId,
    gateName: "GATE 1",
    hint: "Open your review board → Demo Pipeline and mark the task DONE to approve, CANCELED to reject.",
    onApproved: (task) => {
      const approvedBy = "review-board";
      const approvedAt = new Date().toISOString();
      // Write approval back into manifest.json so the file is the record of truth
      const mRaw = JSON.parse(readFileSync(manifestPath, "utf8"));
      mRaw.approvedBy = approvedBy;
      mRaw.approvedAt = approvedAt;
      writeFileSync(manifestPath, JSON.stringify(mRaw, null, 2) + "\n");
      manifest.approvedBy = approvedBy;
      manifest.approvedAt = approvedAt;
      log(`gate1 approved via review-board task ${task.id}`);
    },
    onRejected: (task) => {
      log(`gate1 REJECTED via review-board task ${task.id}`);
      console.error("\n❌ GATE 1 rejected on the review board. Run aborted.");
      process.exit(1);
    },
  });
}

/**
 * The prospect's cluster from the queue, if it is still listed.
 *
 * Best-effort and deliberately quiet: this only sharpens an image prompt, and a
 * missing cluster must never fail a landing build.
 */
function queueClusterFor(slug: string): string | undefined {
  try {
    return parseQueue(readFileSync(QUEUE_PATH, "utf8")).find((p) => p.slug === slug)?.cluster;
  } catch {
    return undefined;
  }
}

/**
 * The prospect's own hostname, taken from the manifest's first parseable
 * source. Every source is already proven on-domain by `assembleManifest`, so
 * the first one is as authoritative as any.
 */
function prospectHost(): string | undefined {
  for (const src of manifest.sources) {
    try {
      return new URL(src.url).hostname;
    } catch {
      /* try the next source */
    }
  }
  return undefined;
}

/**
 * ONE WORKSPACE PER SITE.
 *
 * This used to create unconditionally, keyed only on `state.workspaceId` in
 * THIS run's directory — so a second run for the same prospect made a second
 * workspace, and nothing outside this repo could find either of them. Measured
 * 2026-08-27: 17 of 177 prospects already had two demo workspaces that way, and
 * 33 of 183 hosts had another workspace from the self-serve scan funnel or the
 * WWW-RAG crawler for the same site.
 *
 * `--host` makes the server's create find-or-create on `onboardingHost`, which
 * is the key all four creators now share. A server that does not yet have that
 * change ignores the field and behaves exactly as before.
 */
async function createWorkspace(): Promise<void> {
  if (state.workspaceId) return log(`workspace exists: ${state.workspaceId}`);
  await guardCheck();
  const title = `Demo — ${manifest.prospectName}`;
  const host = prospectHost();
  if (!host) log("workspace: no parseable host in the manifest — creating without a site key");
  const res = await dv(
    [
      "workspace", "create",
      "--title", title,
      "--description", `Demo factory run ${runId} (${manifest.anchorCustomer})`,
      ...(host ? ["--host", host] : []),
    ],
    { profile: args.profile }
  );
  const id =
    (res.json as { _id?: string; id?: string } | undefined)?._id ??
    (res.json as { id?: string } | undefined)?.id ??
    extractObjectId(res.raw);
  if (!id) fail(`could not determine workspace id from output:\n${res.raw}`);
  state.workspaceId = id;
  save(); // persist immediately — a crash here must not orphan the workspace
  // Reuse is reported, never assumed: an existing workspace may hold a prior
  // run's corpus, and that is worth seeing in the log before ingest adds to it.
  if (/Reused the existing workspace/i.test(res.raw))
    log(`reused the existing workspace ${id} for ${host} — nothing was created`);
  else log(`created workspace ${id} ("${title}")`);
}

async function createVector(): Promise<void> {
  if (state.vectorId) return log(`vector exists: ${state.vectorId}`);
  await guardCheck();
  const res = await dv(
    [
      "rag", "targets", "create",
      "--title", `${manifest.prospectName} — demo corpus`,
      "--tool", "vectorize",
      // gemini-embedding-2-preview@1536 (fallback: gemini-embedding-001@1536).
      // Do NOT use @cf/google/embeddinggemma-300m: its similarity scores sit
      // ~0.056, far below usable thresholds (maiden-run finding).
      "--embedding-model", "gemini-embedding-2-preview@1536",
      "--purpose", "knowledge-base",
      "--description", `T1+T2 corpus per ${manifest.run} manifest`,
    ],
    { workspace: state.workspaceId, profile: args.profile }
  );
  const id =
    (res.json as { _id?: string } | undefined)?._id ?? extractObjectId(res.raw);
  if (!id) fail(`could not determine vector id from output:\n${res.raw}`);
  state.vectorId = id;
  save(); // persist immediately — a crash here must not orphan the vector
  log(`created RAG vector ${id}`);
}

async function ingest(): Promise<void> {
  const ragSources = manifest.sources.filter((s) => s.destination === "rag");
  for (const src of ragSources) {
    if (state.ingested.includes(src.id)) continue;
    await guardCheck();
    const remaining = manifest.budgets.crawlPages - state.pagesCrawled;
    if (remaining <= 0)
      fail(`crawl budget exhausted (${manifest.budgets.crawlPages} pages) before source ${src.id}`);
    const limit = Math.min(src.crawl?.limit ?? src.estPages, remaining);

    /**
     * Document sources (one published PDF/Office file each).
     *
     * Download + upload rather than crawl: a text crawl walks HTML links and
     * never opens the PDF behind one, which is why every demo before
     * 2026-08-27 was text-only regardless of what the prospect published.
     * Counts one "page" against the crawl budget, as a video does.
     */
    if (src.type === "document") {
      log(`ingest ${src.id} (${src.tier}, document): ${src.url}`);
      try {
        const doc = await ingestDocument(src.url, state.vectorId!, {
          workspace: state.workspaceId,
          profile: args.profile,
          title: src.rationale.slice(0, 120) || undefined,
        });
        state.pagesCrawled += 1;
        state.ingested.push(src.id);
        save();
        log(`ingested document "${doc.title}" (${Math.round(doc.bytes / 1024)}KB)`);
      } catch (err) {
        /**
         * One bad document must not fail the run — but it must not pass
         * silently either. The source is left UNMARKED so a re-run retries it,
         * and the reason is logged verbatim: "served an HTML page, not a
         * document" is a dead link on the prospect's site, which is worth
         * knowing before we send them a demo built from it.
         */
        log(`document FAILED ${src.url}: ${(err as Error).message.split("\n")[0]}`);
      }
      continue;
    }

    // Video sources (YouTube video/playlist/channel): captions-first via
    // yt-dlp, audio+platform-Whisper fallback. Each video counts as one
    // "page" against the crawl budget.
    if (src.type === "video") {
      log(`ingest ${src.id} (${src.tier}, video, ≤${limit}): ${src.url}`);
      const urls = await expandVideoUrls(src.url, limit);
      state.ingestedVideos ??= [];
      let processed = 0;
      let failed = 0;
      for (const u of urls) {
        // Per-video idempotency: a resumed run must never re-upload.
        const idMatch = u.match(/(?:v=|youtu\.be\/)([\w-]{11})/)?.[1];
        if (idMatch && state.ingestedVideos.includes(idMatch)) continue;
        // Re-check spend periodically — a big playlist is many uploads.
        if (processed > 0 && processed % 10 === 0) await guardCheck();
        try {
          const r = await ingestVideo(u, state.vectorId!, {
            workspace: state.workspaceId,
            speakers: /podcast|interview|multi/i.test(src.rationale) ? "multi" : "single",
            language: "en",
          });
          state.ingestedVideos.push(r.videoId);
          state.pagesCrawled += 1;
          processed += 1;
          save(); // crash-safe: never lose which videos are already in the vector
          log(`ingested video [${r.method}] ${r.title}${r.note ? ` — ${r.note}` : ""}`);
        } catch (err) {
          failed += 1;
          log(`video FAILED ${u}: ${(err as Error).message.split("\n")[0]}`);
        }
      }
      if (failed > 0 && processed === 0)
        fail(`ingest ${src.id}: all ${failed} videos failed — check yt-dlp/auth and re-run`);
      if (failed > 0) {
        // Leave the source UN-marked so a re-run revisits it; per-video
        // idempotency (ingestedVideos) skips the ones that succeeded.
        log(`ingest ${src.id}: ${failed} video(s) failed — source left pending; re-run to retry just those`);
      } else {
        state.ingested.push(src.id);
      }
      save();
      continue;
    }

    const cmd = ["rag", "crawl", src.url, "--vector", state.vectorId!];
    if (src.crawl?.scraper) cmd.push("--scraper", src.crawl.scraper);
    if (src.crawl?.multi) {
      cmd.push("--multi", "--limit", String(limit));
      if (src.crawl.sitemap) cmd.push("--sitemap");
      // ⚠️ `--sitemap` resolves the sitemap at the HOST ROOT and ignores the
      // source URL's path entirely. So a manifest that scopes a source by path
      // — `https://wandb.ai/wandb_fc/` — silently crawls the whole host and
      // takes the first N of ITS sitemap, which may be nothing like the
      // section that was asked for.
      //
      // Measured 2026-08-16: 358 sources across 90 prospects are written this
      // way, i.e. the fleet. It is harmless when the root sitemap IS the
      // content (a clinic, a blog) and catastrophic when it is not:
      // weights-and-biases asked for four editorial sections, got 386 URLs of
      // community user profiles, ZERO on its product or docs surface, and
      // scored 43.5% on coverage as a result.
      //
      // It also explains that corpus's duplication. Four sources, four paths,
      // one root sitemap — each crawl took the same first N, so the same URLs
      // landed up to five times (356 of 386 duplicated). Deriving the path
      // makes each source take its OWN section and the overlap disappears.
      const urlPath = (() => {
        try { return new URL(src.url).pathname.replace(/\/+$/, ""); } catch { return ""; }
      })();
      let derived: string[] =
        src.crawl.sitemap && !src.crawl.includePaths?.length && urlPath && !urlPath.endsWith(".xml")
          ? [`${urlPath}/`]
          : [];

      // ⚠️ Deriving is not free. The manifest's path is often ASPIRATIONAL:
      // acmehealthmd declares /podcast/, /category/, /topic-guide/ and
      // /outlive/, which together cover ~85 of its 1,166 sitemap URLs because
      // its content is root-level article slugs. Before this guard the fix
      // would have cut that corpus from ~693 pages to ~280 — turning a crawl
      // that was accidentally right into one that is correctly wrong.
      //
      // So: count what the path actually matches, SAY so, and refuse to derive
      // only when it would match nothing at all (an empty crawl is strictly
      // worse than the old host-wide behaviour). Anything else is the
      // operator's call, made with the number in front of them rather than
      // discovered later from a thin corpus.
      if (derived.length) {
        try {
          const host = new URL(src.url).origin;
          const all = sitemapCache.get(host) ?? (await fetchSitemapUrls(host));
          sitemapCache.set(host, all);
          const d = decideScoping({ urlPath, sitemapUrls: all, limit });
          if (!d.scope) derived = [];
          log(`ingest ${src.id}: ${d.reason}`);
        } catch (err) {
          // Sitemap unreachable: derive anyway. Doing what the manifest says is
          // the safer default when we cannot check it.
          log(`ingest ${src.id}: scoping to ${urlPath}/ (sitemap check failed: ${(err as Error).message.split("\n")[0].slice(0, 60)})`);
        }
      }
      const includePaths = src.crawl.includePaths?.length ? src.crawl.includePaths : derived;
      if (includePaths.length)
        cmd.push("--include-paths", includePaths.join(","));
      if (src.crawl.excludePaths?.length)
        cmd.push("--exclude-paths", src.crawl.excludePaths.join(","));
    }
    // CLI --wait defaults to a 300s ceiling — too tight for a multi-page
    // crawl+index; the work continues server-side either way.
    cmd.push("--wait", "--poll-interval", "15", "--timeout", src.crawl?.multi ? "1800" : "600");

    log(`ingest ${src.id} (${src.tier}, ≤${limit} pages): ${src.url}`);
    // Partial-success tolerance: a multi-page crawl commonly indexes most pages
    // before a failed SEED or a single JS/bot-protected page makes the CLI exit
    // non-zero. Don't discard a good corpus over a failed seed — count files
    // before, and on a non-zero exit accept the run if pages were indexed.
    const before = await ragFileCount(state.workspaceId!, args.profile);
    let res: Awaited<ReturnType<typeof dv>>;
    try {
      res = await dv(cmd, { workspace: state.workspaceId, profile: args.profile, timeoutMs: 30 * 60 * 1000 });
    } catch (err) {
      const after = await ragFileCount(state.workspaceId!, args.profile);
      // Unknown ≠ empty. If the count cannot be read, do not guess that the
      // crawl produced nothing — that is how a good corpus gets thrown away.
      if (after === undefined) {
        log(`ingest ${src.id}: crawl failed AND the indexed-file count could not be read — not assuming an empty corpus`);
        throw err;
      }
      const gained = before === undefined ? after : after - before;
      // A usable corpus, measured ABSOLUTELY.
      //
      // The relative test alone (`gained > 0`) cannot terminate on retry: the
      // CLI's --wait gives up after 30 min while the SERVER KEEPS CRAWLING, so
      // the pages land after `after` is measured and are already inside
      // `before` on the next attempt — gain 0, rethrow, forever. Acme Clinic
      // sat in exactly that loop for 7 hours and 8 ticks with 157 pages
      // already indexed, re-running a 30-minute crawl every hour to no effect.
      const usable = Math.max(10, Math.floor(limit * 0.25));
      if (gained > 0) {
        log(`ingest ${src.id}: crawl CLI exited non-zero (likely a failed seed or a JS/bot-protected page) but ${gained} page(s) indexed — accepting partial corpus. If the site is JS-rendered, set crawl.scraper="@cloudflare/browser-rendering" in the manifest.`);
        res = { raw: `partial crawl: +${gained} pages indexed` };
      } else if (after >= usable) {
        log(`ingest ${src.id}: crawl CLI exited non-zero and added nothing new, but the vector already holds ${after} page(s) (≥ ${usable}) — an earlier attempt's crawl completed server-side after its CLI timed out. Accepting.`);
        res = { raw: `existing corpus: ${after} pages indexed` };
      } else {
        throw err;
      }
    }
    state.pagesCrawled += src.crawl?.multi ? limit : 1; // upper bound; refine from CLI output later
    state.ingested.push(src.id);
    save();
    log(`ingested ${src.id} — ${summarize(res.raw)}`);
  }

  // Audit completeness NOW, while the corpus is still the cheapest artifact in
  // the run. Costs nothing (set arithmetic over URLs) and is what stands
  // between a 18.8%-coverage corpus and everything downstream being built on
  // top of it. Gate 2 still reads state.coverageRatio and still owns the halt.
  await auditCorpusCoverage();
}

/**
 * Feed the demo crawl into the global WWW RAG corpus so the host becomes one of
 * the AutoRag "groups" the Divinci browser extension queries.
 *
 * ON by default (disable with WWW_RAG_SUBMIT=0). The demo workspace may live on
 * STAGING, but the WWW
 * RAG corpus is PRODUCTION, so this submits to a SEPARATE base
 * (WWW_RAG_API_BASE, default https://api.divinci.app) with its OWN prod OAuth
 * bearer (WWW_RAG_TOKEN). submit-url re-scrapes each URL on the prod side; it
 * does NOT copy chunks from the staging demo vector. Best-effort — never fails
 * the run.
 *
 * NOTE on AutoRag "groups": for clean per-site isolation the host should be
 * registered in the WwwRagSite registry first (server repo:
 * scripts/backfill-www-rag-sites.ts). Until then, submitted pages index into
 * the WWW RAG project's default vector(s) rather than a dedicated per-site
 * vector — still queryable, just not isolated.
 */
async function wwwRagSubmit(): Promise<void> {
  if (!wwwRagEnabled()) {
    log("wwwrag: disabled via WWW_RAG_SUBMIT=0 — skipping global-corpus submit");
    return;
  }

  const webSources = manifest.sources.filter(
    (s) => s.destination === "rag" && s.type !== "video",
  );
  if (webSources.length === 0) {
    log("wwwrag: no web sources to submit");
    return;
  }

  // Collect the exact page URLs the demo crawl indexed, per host, from the
  // staging crawl history (scrapedPaths). This is the active-profile (staging)
  // side — submit (below) targets prod.
  const pageUrls = new Set<string>();
  for (const src of webSources) {
    let host: string;
    try {
      host = new URL(src.url).host;
    } catch {
      log(`wwwrag: skipping source ${src.id} — unparseable url ${src.url}`);
      continue;
    }
    const urls = crawledUrlsForHost(host);
    if (urls.length === 0) {
      // Fall back to at least the seed URL so the host is represented.
      log(`wwwrag: no crawl history for ${host} — falling back to the seed URL only`);
      pageUrls.add(src.url.replace(/\/+$/, ""));
      continue;
    }
    log(`wwwrag: ${urls.length} crawled page(s) for ${host}`);
    for (const u of urls) pageUrls.add(u);
  }

  state.wwwRagSubmitted ??= [];
  const res = await submitUrlsToWwwRag([...pageUrls], {
    alreadySubmitted: state.wwwRagSubmitted,
    dryRun: DRY_RUN,
    log,
  });
  state.wwwRagSubmitted.push(...res.submitted);
  // De-dupe the persisted list.
  state.wwwRagSubmitted = [...new Set(state.wwwRagSubmitted)];
  save();
  log(
    `wwwrag: ${res.submitted.length} submitted, ${res.skippedAlready.length} already, ` +
      `${res.denied.length} denied, ${res.failed.length} failed`,
  );
}

/**
 * List the page URLs indexed for `host`.
 *
 * PRIMARY source: the vector's indexed file docs (`rag files`), whose title
 * carries the page URL. This is robust across scrapers — FireCrawl and
 * browser-rendering do NOT populate the html-page crawl history's
 * `scrapedPaths` (verified 2026-06-29 on acmemarket: 35 indexed files, 0
 * scrapedPaths), so the crawl-history path silently under-reports them.
 *
 * FALLBACK: the html-page crawl history (GET …/rag-vector/html-page/hosts/<host>).
 *
 * Both use the OAuth session (api-key stripped). Returns [] on any error
 * (best-effort).
 */
/**
 * Every RAG file title in the workspace, INCLUDING repeats of the same URL.
 *
 * Deliberately not `crawledUrlsForHost`, which returns a Set: the duplicate
 * ingests are the signal here (acmerenew.com had `contact-us` four times), and
 * a Set erases exactly that.
 */
function ragFileTitles(): string[] {
  if (DRY_RUN) return ["URL: https://example.com/ 2026-1-1", "URL: https://example.com/about 2026-1-1"];
  if (!state.workspaceId) return [];
  const OAUTH_ENV = { ...process.env };
  delete OAUTH_ENV.DIVINCI_API_KEY;
  try {
    const stdout = execFileSync(
      "divinci",
      ["rag", "files", "--limit", "500", "--json", "--no-color", "--workspace", state.workspaceId],
      { timeout: 90_000, maxBuffer: 32 * 1024 * 1024, env: OAUTH_ENV, encoding: "utf8" },
    );
    const start = stdout.indexOf("[");
    if (start < 0) return [];
    const files = JSON.parse(stdout.slice(start)) as Array<Record<string, unknown>>;
    return files
      .map((f) => [f.title, f.originalFilename, f.originalName].find((x): x is string => typeof x === "string") ?? "")
      .filter(Boolean);
  } catch {
    return [];
  }
}

function crawledUrlsForHost(host: string): string[] {
  if (DRY_RUN) return [`https://${host}/`, `https://${host}/about`];
  if (!state.workspaceId) return [];
  const OAUTH_ENV = { ...process.env };
  delete OAUTH_ENV.DIVINCI_API_KEY;
  const norm = (u: string) => u.replace(/[#?].*$/, "").replace(/\/+$/, "");
  const sameHost = (u: string) => { try { return new URL(u).host === host; } catch { return false; } };

  // PRIMARY — indexed file docs (title carries the page URL).
  try {
    const stdout = execFileSync(
      "divinci",
      ["rag", "files", "--limit", "500", "--json", "--no-color", "--workspace", state.workspaceId],
      { timeout: 90_000, maxBuffer: 32 * 1024 * 1024, env: OAUTH_ENV, encoding: "utf8" },
    );
    const start = stdout.indexOf("[");
    if (start >= 0) {
      const files = JSON.parse(stdout.slice(start)) as Array<Record<string, unknown>>;
      const out = new Set<string>();
      for (const f of files) {
        const fields = [f.title, f.originalFilename, f.originalName].filter((x): x is string => typeof x === "string");
        for (const field of fields) {
          const m = field.match(/https?:\/\/[^\s"']+/);
          if (m && sameHost(m[0]) && !/\/cdn-cgi\//.test(m[0])) out.add(norm(m[0]));
        }
      }
      if (out.size > 0) return [...out];
    }
  } catch (err) {
    log(`wwwrag: rag-files enumeration failed for ${host}, trying crawl history: ${(err as Error).message.split("\n")[0]}`);
  }

  // FALLBACK — html-page crawl history scrapedPaths.
  try {
    const stdout = execFileSync(
      "divinci",
      ["api", "GET", `/white-label/${state.workspaceId}/rag-vector/html-page/hosts/${encodeURIComponent(host)}`, "--no-color"],
      { timeout: 60_000, maxBuffer: 16 * 1024 * 1024, env: OAUTH_ENV, encoding: "utf8" },
    );
    const start = stdout.indexOf("{");
    if (start < 0) return [];
    const parsed = JSON.parse(stdout.slice(start)) as { crawls?: { scrapedPaths?: string[] }[] };
    const out = new Set<string>();
    for (const c of parsed.crawls ?? []) {
      for (const p of c.scrapedPaths ?? []) {
        if (!p) continue;
        const full = /^https?:\/\//i.test(p) ? p : `https://${host}${p.startsWith("/") ? "" : "/"}${p}`;
        out.add(norm(full));
      }
    }
    return [...out];
  } catch (err) {
    log(`wwwrag: could not list crawl history for ${host}: ${(err as Error).message.split("\n")[0]}`);
    return [];
  }
}

async function hygiene(): Promise<void> {
  const v = state.vectorId!;
  for (const sub of [
    ["rag", "dedupe", v],
    ["rag", "dedupe-files", v],
    ["rag", "scan-artifacts", v],
    ["rag", "health", "check", v],
  ]) {
    // `rag health check` REPORTS; the other three MUTATE. Only the diagnostic is
    // advisory — a failure there must not discard a completed crawl, but it must
    // also never pass silently.
    //
    // Why this is not hypothetical: on production every `/rag-vector/**/health*`
    // route answers 403 for an OAuth user who owns the workspace, while sibling
    // routes on the same mount (`/rag-vector`, `/rag-vector/:id`, `/:id/events`)
    // answer 200 — verified 2026-08-03 across two workspaces. So on prod this
    // step ALWAYS throws, and it threw after a 90-page crawl had already
    // succeeded and been paid for.
    const advisory = sub[1] === "health";
    let res;
    try {
      res = await dv(sub, { workspace: state.workspaceId, profile: args.profile });
    } catch (err) {
      if (!advisory) throw err;
      const first = (err as Error).message.split("\n")[0];
      // Distinguish "the endpoint refuses us" from "the check ran and found
      // trouble". Both used to print the same ADVISORY STEP FAILED line, which
      // reads as a finding about the corpus — so a known, permanent server-side
      // gap looked like a fresh problem with this particular vector, every run.
      // Re-confirmed 2026-08-11: base 200, scan-chunk-artifacts 200, health 403,
      // same token and vector.
      if (/forbidden|permission denied|\b403\b/i.test(first)) {
        log(`hygiene: health endpoint refuses this token (403) — a KNOWN server-side gap, not a corpus signal`);
        log(`hygiene: retrieval is verified by the probe step below, which test-queries every eval question`);
      } else {
        log(`hygiene: ⚠️ ADVISORY STEP FAILED — ${sub.slice(0, 3).join(" ")}: ${first}`);
        log(`hygiene: continuing without a health report; the vector is UNVERIFIED by this check`);
      }
      continue;
    }
    log(`${sub.slice(0, 3).join(" ")}: ${summarize(res.raw)}`);
  }
  console.log(
    "hygiene note: dedupe ran dry-run only — review the report and apply with `divinci rag dedupe <vector> --apply` if needed"
  );
}

async function probe(): Promise<void> {
  for (const q of manifest.evalQueries) {
    const res = await dv(["rag", "test-retrieval", state.vectorId!, q], {
      workspace: state.workspaceId,
      profile: args.profile,
    });
    log(`probe "${q}": ${summarizeProbe(res)}`);
  }
}

/**
 * Render a test-retrieval result as the numbers a reviewer needs: top score and
 * how many chunks came back, plus the head of the best chunk.
 *
 * summarize() takes the FIRST LINE of raw CLI output, which for `--json` is the
 * opening `{` — so every probe line in the Gate 2 card read `probe "…": {`. The
 * card's entire job is to show retrieval quality, and it was showing a brace.
 * Falls back to the old behaviour if the payload isn't the shape we expect.
 */
function summarizeProbe(res: { raw: string; json?: unknown }): string {
  const d = (res.json ?? {}) as {
    diagnostics?: { vectorSearchScores?: number[]; chunksReturned?: number; chunkPreview?: string };
  };
  const g = d.diagnostics;
  if (!g || !Array.isArray(g.vectorSearchScores) || g.vectorSearchScores.length === 0) {
    return summarize(res.raw);
  }
  const top = g.vectorSearchScores[0];
  const preview = (g.chunkPreview ?? "").replace(/\s+/g, " ").slice(0, 70);
  return `top=${top.toFixed(3)} chunks=${g.chunksReturned ?? 0} | ${preview}`;
}

/**
 * ScoredQA step — imports runs/<prospect>/<run>/qa-suite.yaml and runs it
 * against the release, so Gate 2 reviews actual scored responses instead of
 * suggesting prompts for a human to type in by hand.
 *
 * Skips (with a warning) when there's no qa-suite.yaml or no releaseId —
 * the run can still proceed to Gate 2 with manual review.
 */
/**
 * A short factual sketch of what the vector actually indexed, so a generated QA
 * suite asks about THIS corpus rather than about the industry in general.
 * Best-effort: an empty brief still produces a tier-appropriate hazard suite.
 */
async function corpusBrief(): Promise<string> {
  try {
    const res = await dv(["rag", "files"], { workspace: state.workspaceId, profile: args.profile });
    const files = parseJsonArray(res) as Array<Record<string, unknown>> | undefined;
    if (!files) return "";
    return files
      .slice(0, 80)
      .map((f) => String(f.title ?? f.name ?? f.url ?? f.path ?? "").trim())
      .filter(Boolean)
      .join("\n");
  } catch (err) {
    log(`qa: corpus brief unavailable (${(err as Error).message.split("\n")[0]}) — generating from the manifest alone`);
    return "";
  }
}

/**
 * Prior QA scores for this prospect, newest last, for the noise band.
 *
 * ⚠️ These are same-PROSPECT runs, not necessarily same-CONFIG replicates, so
 * the band they produce is wider than a true replicate band — it absorbs
 * config drift as well as run-to-run variance. That is the conservative
 * direction (it makes "noise" harder to claim, not easier), and it costs
 * nothing, which is why it is the default. A true band needs the same release
 * scored N times; triage says so when it has fewer than MIN_REPLICATES.
 */
function priorQaScores(prospectSlug: string, currentRun: string): number[] {
  const dir = join(repoRoot, "runs", prospectSlug);
  if (!existsSync(dir)) return [];
  const out: number[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (entry === currentRun) continue;
    try {
      const st = JSON.parse(readFileSync(join(dir, entry, "state.json"), "utf8")) as { qaScore?: unknown };
      if (typeof st.qaScore === "number" && Number.isFinite(st.qaScore)) out.push(st.qaScore);
    } catch {
      // A run without a readable state.json contributes nothing. Not an error:
      // failed runs are common and are exactly the ones with no score.
    }
  }
  return out;
}

/**
 * Compare what the site advertises against what actually reached the vector.
 *
 * ⚠️ CALLED AT THE END OF INGEST, not at QA time. It used to run inside
 * qaEval(), which is after hygiene, probe, corpusBrief and a guardCheck — so a
 * corpus that had captured a fraction of the site was discovered only once real
 * money had been spent on top of it, and a rebuild meant discarding all of it.
 * The audit is pure set arithmetic over URLs: no model call, no tokens. There
 * is no reason to defer it, and every reason to fail while the corpus is still
 * the cheapest thing in the run.
 *
 * Measured shipping demos before this moved: Acme Renew 28%, Acme Realty 18.8%.
 * Two of two audited. `pagesCrawled` read healthy for both because it counts
 * pages VISITED, and Acme Realty's 81 duplicate ingests padded the total.
 *
 * Idempotent and best-effort: safe to call twice, and never fails a run that is
 * otherwise fine.
 */
async function auditCorpusCoverage(): Promise<void> {
  try {
    const auditHost = (manifest.sources ?? [])
      .filter((src) => src.destination === "rag")
      .map((src) => { try { return new URL(src.url).host; } catch { return ""; } })
      .find(Boolean);

    if (auditHost) {
      const sitemapUrls = await fetchSitemapUrls(`https://${auditHost}`);
      // Raw titles, NOT crawledUrlsForHost(): that helper dedupes through a
      // Set, which would erase the repeat-ingest signal this audit reports.
      const fileTitles = ragFileTitles();
      const audit = auditCoverage({ sitemapUrls, fileTitles });

      state.coverageRatio = Number.isNaN(audit.coverage) ? null : audit.coverage;
      state.coverageSitemapCount = audit.sitemapUrls.length;
      state.coverageVerdict = audit.verdict;
      state.coverageMissing = audit.missing.slice(0, 50);
      state.coverageDuplicates = audit.duplicates.slice(0, 20);
      save();

      log(`qa: ${audit.summary}`);
      if (audit.verdict === "under-crawled") {
        // A warning, not a fail: the demo is still shippable and a human should
        // decide. Silence is what let Acme Renew through, so it names the pages.
        log(
          `qa: ⚠️ UNDER-CRAWLED — ${audit.missing.length} sitemap page(s) never reached the vector, ` +
            `e.g. ${audit.missing.slice(0, 5).join(", ")}`,
        );
      }
      if (audit.duplicates.length) {
        log(
          `qa: ⚠️ ${audit.duplicates.length} url(s) ingested more than once — ` +
            audit.duplicates.slice(0, 3).map((d) => `${d.url} ×${d.count}`).join(", "),
        );
      }
    }
  } catch (err) {
    // Best-effort: never let an audit failure stop a run that is otherwise fine.
    log(`qa: coverage audit skipped — ${(err as Error).message}`);
  }

}

async function qaEval(): Promise<void> {
  if (DRY_RUN) { state.qaScore = 0.9; state.qaPassedCount = 6; state.qaTestCount = 6; return log("[dry-run] qa skipped (stub 90%)"); }
  if (!state.releaseId) {
    log("qa: no releaseId in state — create/record the release first; skipping ScoredQA");
    return;
  }

  // A run with no hand-authored suite used to skip ScoredQA silently, leaving
  // Gate 2 with nothing to review — which is how 17 of the first 19 runs got
  // approved carrying no quality evidence at all. Generate one instead.
  const suitePath = join(runDir, "qa-suite.yaml");
  if (!existsSync(suitePath)) {
    log("qa: no qa-suite.yaml — generating an adversarial suite from the manifest");
    const suiteYaml = await generateQaSuite({
      manifest,
      corpusBrief: await corpusBrief(),
    });
    writeFileSync(suitePath, `${suiteYaml}\n`);
    log(`qa: generated ${suitePath} (review + hand-edit it to raise the bar)`);
  }

  // 0. COVERAGE AUDIT — free, and it runs BEFORE guardCheck deliberately.
  //
  // Set arithmetic between the prospect's sitemap and the URLs actually in the
  // vector. No model call, no judge, no spend — so it must not sit behind a
  // spend gate, and it tells us whether a QA run is even worth paying for.
  //
  // Added 2026-08-15. acmerenew.com shipped holding 8 of its 29 pages, with
  // `contact-us` ingested 4× and `privacy-terms` 4×, and NOTHING noticed:
  // `pagesCrawled` was 28 (it counts pages VISITED, not distinct URLs that
  // landed), corpus-audit.ts measures furniture rather than completeness, and
  // the hazard suite scored the thin corpus within noise of a complete one
  // (84.3% vs 84.0%). The assistant answered "A2M, or Anti-Aging and Wellness".
  await auditCorpusCoverage();

  await guardCheck(); // QA runs spend LLM tokens (generation + judge scoring)

  // 1. Import the suite (idempotent via state).
  if (!state.qaSuiteId) {
    const res = await dv(["qa", "import", suitePath], {
      workspace: state.workspaceId,
      profile: args.profile,
      json: false, // import's table output is more reliable than --json here
    });
    const suiteId = res.raw.match(/New suite ID:\s*([0-9a-f]{24})/)?.[1] ?? extractObjectId(res.raw);
    if (!suiteId) fail(`qa: could not parse suite ID from import output:\n${res.raw}`);
    state.qaSuiteId = suiteId;
    save();
    log(`qa: imported suite ${suiteId}`);
  }

  // 2. The release must have the RAG vector linked or every test fails with
  //    an opaque "(reading 'content')" error.
  const activeVec = state.activeVector ?? state.vectorId!;
  const linked = await ensureReleaseRagLinked(state.releaseId, activeVec, {
    workspace: state.workspaceId,
    profile: args.profile,
  });
  if (!linked) {
    fail(
      `qa: release ${state.releaseId} does not have vector ${activeVec} in ragIndexes — ` +
        `link it (draft update: POST /white-label/<ws>/release/<id> with ragIndexes:[{id}]) and re-run`
    );
  }

  // 3. Run the suite via multi-release-run — the SAME engine as the web UI's
  //    "Run Suite" button, so results show in run history + quality report.
  //
  //    REPLICATES, not one run. Measured 2026-08-15 across the whole
  //    back-catalogue: 72 scored runs spread over 71 prospects, i.e. almost
  //    every release has been scored exactly ONCE — so the dataset contains no
  //    replicates at all and nothing can tell a real regression from a bad
  //    draw. The only replicate measurement in existence (Acme Renew, arm A
  //    UNCHANGED) came out 79 / 87 / 87.
  //
  //    An 8-point spread on an unchanged config means a single draw decides
  //    whether a demo publishes, and it means every later comparison —
  //    triage, arena arms, the whole experiment programme — is built on one
  //    sample per config. Replicates are the cheapest input to all of it: no
  //    re-crawl, no re-ingest, just the suite again against the same release.
  const replicateTarget = Math.max(1, Number(process.env.QA_REPLICATES ?? 3));
  const reps: { run: ReturnType<typeof parseMultiReleaseRun>; score: number }[] = [];
  for (let i = 0; i < replicateTarget; i++) {
    try {
      const res = await dv(
        ["qa", "multi-release-run", state.qaSuiteId!, "--release", state.releaseId],
        { workspace: state.workspaceId, profile: args.profile, timeoutMs: 30 * 60 * 1000 },
      );
      const r = parseMultiReleaseRun(res.raw, res.json);
      const score = r.perRelease[0]?.overallScore;
      if (typeof score !== "number") throw new Error("no overallScore in run result");
      reps.push({ run: r, score });
      log(`qa: replicate ${i + 1}/${replicateTarget} — ${(score * 100).toFixed(1)}%`);
    } catch (err) {
      // Partial replicates still beat one. Failing the whole step because the
      // third run timed out would throw away two good measurements.
      log(`qa: ⚠ replicate ${i + 1}/${replicateTarget} failed — ${(err as Error).message.split("\n")[0]}`);
    }
  }
  if (!reps.length) fail("qa: every replicate failed — no score");

  const scores = reps.map((r) => r.score);
  const summary = summariseReplicates(scores)!;
  const mean = summary.mean;
  const sd = summary.sd ?? 0;

  // The MEDIAN replicate supplies the linked runId and the per-run counts, so
  // the numbers we report and the run someone opens in the UI are the same
  // actual run. A synthetic blend of counts would match no run at all.
  const median = reps[medianIndex(scores)];
  const rel = median.run.perRelease[0];

  state.qaReplicates = scores;
  state.qaScoreSd = reps.length > 1 ? sd : null;
  // qaScore is now the MEAN of the replicates, not a single draw. Downstream
  // consumers (the publish threshold, the landing QA claim, metrics.ts) keep
  // reading one number and get a better estimator of it.
  state.qaScore = mean;
  state.qaRunId = median.run.runResultId;
  state.qaPassedCount = rel.passedCount;
  state.qaTestCount = rel.testCount;

  // Per-scorer averages across replicates, for the same reason as the mean.
  state.qaScoreAverages = averageScorers(reps.map((r) => r.run.perRelease[0]?.scoreAverages));

  // Weakest test across ALL replicates, not just the median one — this is the
  // safety signal, so it takes the worst thing observed rather than a typical
  // one. A 0%-correctness answer that appeared in one of three runs is still a
  // 0%-correctness answer the demo can produce.
  state.qaMinTestScore = worstTestScore(
    reps.map((r) =>
      r.run.perTest
        .map((t) => Object.values(t.scoresByRelease ?? {})[0])
        .filter((v): v is number => typeof v === "number"),
    ),
  );
  save();

  if (reps.length > 1)
    log(
      `qa: ${reps.length} replicates — mean ${(mean * 100).toFixed(1)}% ` +
        `sd ${(sd * 100).toFixed(1)} [${(Math.min(...scores) * 100).toFixed(0)}–${(Math.max(...scores) * 100).toFixed(0)}]`,
    );
  else log(`qa: ⚠ only 1 replicate succeeded — no noise band, triage cannot separate signal from spread`);

  // ⚠️ passedCount is NOT a safety signal. Both of the first two production
  // runs reported "10/10 passed" while containing a test scored 0% on
  // CORRECTNESS — Acme Clinic's was a fabricated week-by-week post-op rehab
  // protocol given to a patient operated on elsewhere. Surface the parts that
  // actually carry the risk.
  if (rel.scoreAverages)
    log(
      `qa: scorers — ${Object.entries(rel.scoreAverages)
        .map(([k, v]) => `${k}=${(v * 100).toFixed(0)}%`)
        .join(" ")}`,
    );
  if (state.qaMinTestScore !== null && state.qaMinTestScore < 0.6)
    log(`qa: ⚠ weakest test scored ${(state.qaMinTestScore * 100).toFixed(0)}% — read it before approving Gate 2`);

  // ── Triage a below-threshold score, before anyone proposes rebuilding ─────
  //
  // Costs nothing: pure arithmetic over measurements already on disk. It runs
  // automatically because the expensive mistake is not "we failed to
  // diagnose", it is "we rebuilt the demo five ways and learned nothing" —
  // which is what the 2026-08-15 Acme Renew A/B actually did (whole-stack swap:
  // 84.3% -> 84.0%, while the real defect was 8 of 29 pages ingested).
  //
  // Deliberately does NOT run an arena, and often concludes that no arena is
  // worth running. See qa-triage.ts.
  if (typeof state.qaScore === "number" && state.qaScore < QA_PUBLISH_MIN) {
    try {
      // Replicates of THIS release go in as `replicates`, NOT as `history`.
      // qaScore is their mean, and a mean is always inside a band built from
      // its own samples — passing them as history makes the noise test
      // unfailable, which is exactly what shipped on 2026-08-15 and made
      // triage answer `noise` for zilliz at 25.8 points under the gate.
      // Same-prospect history stays as the fallback for runs with too few.
      const replicates = state.qaReplicates ?? [];
      const history = priorQaScores(manifest.prospect, state.run);
      const t = triage({
        qaScore: state.qaScore,
        threshold: QA_PUBLISH_MIN,
        replicates,
        history,
        scorers: state.qaScoreAverages ?? null,
        coverage:
          typeof state.coverageRatio === "number" && state.coverageSitemapCount
            ? {
                sitemapUrlCount: state.coverageSitemapCount,
                ingestedUrlCount: Math.round(state.coverageRatio * state.coverageSitemapCount),
                // coverageDuplicates is capped at 20 when stored, so this is a
                // floor on the duplicate count — fine, since triage only asks
                // whether ANY duplicates exist.
                duplicateCount: (state.coverageDuplicates ?? []).length,
              }
            : null,
      });
      state.qaTriage = { verdict: t.verdict, arms: t.recommendedArms, at: new Date().toISOString() };
      save();
      log(`qa: triage — ${t.verdict}; ${t.nextAction}`);
      for (const e of t.evidence) log(`qa: triage · ${e}`);

      // Post to the Gate 2 card, fenced so a re-run replaces it.
      if (state.gate2TaskId && (await isAvailable())) {
        const existing = await getTask(state.gate2TaskId);
        const body = existing.description ?? "";
        const fenced = `${TRIAGE_MARK}\n${formatTriage(t)}\n${TRIAGE_END}`;
        const re = new RegExp(`${TRIAGE_MARK}[\\s\\S]*?${TRIAGE_END}`);
        const next = re.test(body) ? body.replace(re, fenced) : `${fenced}\n\n${body}`;
        if (next !== body) await updateTask(state.gate2TaskId, { description: next });
      }

      // A COSTED plan, posted for approval. Nothing here starts an arena —
      // the expensive stage of this path must not start itself, and triage
      // often concludes no arena is worth running at all.
      if (t.recommendedArms.length && state.vectorId) {
        const baseline = await resolveStack(state.vectorId, {
          workspaceId: state.workspaceId!,
          profile: args.profile,
          cachePath: defaultCachePath(repoRoot),
        }).catch(() => null);

        const proposal = proposeArena({
          prospect: manifest.prospect,
          triage: t,
          baseline,
          existingReplicates: (state.qaReplicates ?? []).length,
          // Observed sd of THIS release's replicates when we have them; the
          // module falls back to the measured 3.8pp otherwise.
          sigmaPp: typeof state.qaScoreSd === "number" ? state.qaScoreSd * 100 : null,
        });

        if (!proposal) {
          log("qa: no arena proposed — triage recommends no arms, or the stack could not be labelled");
        } else {
          log(
            `qa: arena proposed — ${proposal.arms.length} arms, ${proposal.replicatesPerArm} replicates each, ` +
              `${proposal.totals.qaRuns} QA runs + ${proposal.totals.ingestions} ingestions, resolves >=${proposal.mdePp.toFixed(1)}pp`,
          );
          if (state.gate2TaskId && (await isAvailable())) {
            const ex = await getTask(state.gate2TaskId);
            const b = ex.description ?? "";
            const block = `${PROPOSAL_MARK}\n${formatProposal(proposal)}\n${PROPOSAL_END}`;
            const pre = new RegExp(`${PROPOSAL_MARK}[\\s\\S]*?${PROPOSAL_END}`);
            const nxt = pre.test(b) ? b.replace(pre, block) : `${b.trimEnd()}\n\n${block}`;
            if (nxt !== b) await updateTask(state.gate2TaskId, { description: nxt });
          }
        }
      }
    } catch (err) {
      // Advisory. A triage that cannot run must not fail a run that scored.
      log(`qa: ⚠ triage could not run — ${(err as Error).message.split("\n")[0]}`);
    }
  }

  // Report the MEAN (what the gate and the landing claim use) and name the
  // median run, which is the one whose counts are quoted beside it.
  const pct = `${(mean * 100).toFixed(1)}%`;
  log(
    `qa: ${pct}${reps.length > 1 ? ` (mean of ${reps.length})` : ""} — median run ${median.run.runResultId} ` +
      `(${rel.passedCount}/${rel.testCount} passed, ${rel.errorCount} errors)`,
  );
  for (const t of median.run.perTest) {
    const score = Object.values(t.scoresByRelease ?? {})[0];
    const s = score !== null && score !== undefined ? `${(Number(score) * 100).toFixed(0)}%` : "—";
    log(`qa:   ${s} — ${t.prompt.slice(0, 70)}`);
  }
  if (rel.errorCount > 0 && rel.passedCount === 0) {
    fail(`qa: all ${rel.errorCount} tests errored — release/RAG misconfiguration`);
  }
}

async function gate2(): Promise<void> {
  if (DRY_RUN) { state.demoApprovedBy = "dry-run"; return log("[dry-run] gate2 auto-approved"); }

  // Gate 2 exists to stop a bad demo reaching a prospect. With no QA score
  // there is nothing to stop it WITH — the gate becomes a rubber stamp on an
  // unmeasured demo. That is not hypothetical: 17 of the first 19 runs reached
  // this gate with qaScore=null and were approved anyway.
  //
  // Checked BEFORE the legacy approved-by bypass on purpose. A pre-set
  // approval is exactly the path that must not be able to skip the evidence.
  const decision = gate2Decision({
    qaScore: state.qaScore,
    releaseId: state.releaseId,
    allowUnscored: process.env.ALLOW_UNSCORED_GATE2 === "1",
  });
  if (!decision.ok || decision.overridden) {
    if (decision.ok) {
      log(`gate2: ⚠ ${decision.reason}`);
    } else {
      // Quote the qa step's own log lines. Without them this is an alert that
      // fires every tick and tells nobody what to do about it.
      const qaLog = state.log
        .filter((e) => e.msg.startsWith("qa:"))
        .slice(-4)
        .map((e) => `    ${e.msg}`)
        .join("\n");
      fail(
        `gate2: ${decision.reason}.\n` +
          (qaLog ? `  What the qa step reported:\n${qaLog}\n` : "  The qa step logged nothing at all.\n") +
          "  To approve an unmeasured demo deliberately, re-run with ALLOW_UNSCORED_GATE2=1.",
      );
    }
  }

  // Legacy: --demo-approved-by flag passed directly
  if (state.demoApprovedBy) {
    log(`gate2 approved by ${state.demoApprovedBy}`);
    return;
  }

  // Advisory mode — record and continue. Deliberately placed AFTER the
  // evidence check above: skipping the pause is the intent, skipping the QA
  // score is not. A run with qaScore=null has already failed by this line.
  if (gatesAreAdvisory()) {
    state.demoApprovedBy = "auto (gate advisory)";
    const pctText =
      state.qaScore !== undefined && state.qaScore !== null
        ? `${(state.qaScore * 100).toFixed(1)}%`
        : "unscored (ALLOW_UNSCORED_GATE2)";
    log(`gate2 ${state.demoApprovedBy} — QA ${pctText}, advisory mode, not blocking`);
    try {
      if (await isAvailable()) {
        const projectId = await resolveProject();
        if (state.gate2TaskId) {
          await updateTask(state.gate2TaskId, { status: "DONE" });
        } else {
          const task = await createTask({
            title: `[Gate 2] ${manifest.prospectName} — demo built (advisory), QA ${pctText}`,
            description:
              `Recorded automatically: Gates 1 and 2 are advisory.\n\n` +
              `- QA score: ${pctText}` +
              (state.qaPassedCount !== undefined && state.qaTestCount !== undefined
                ? ` (${state.qaPassedCount}/${state.qaTestCount} passed)`
                : "") +
              `\n- Workspace: \`${state.workspaceId}\`\n` +
              (state.releaseId ? `- Release: \`${state.releaseId}\`\n` : "") +
              `\nNo approval was requested. The demo LINK is still gated: Gate 3 requires a human.`,
            projectId,
            priority: "low",
            status: "DONE",
            tags: ["gate2", "advisory", manifest.prospect],
          });
          state.gate2TaskId = task.id;
        }
      }
    } catch (e) {
      log(`gate2: board record skipped — ${(e as Error).message.slice(0, 120)}`);
    }
    save();
    return;
  }

  const boardUp = await isAvailable();
  const projectId = boardUp ? await resolveProject() : undefined;

  // Create the review-board task if we haven't yet
  // COVERAGE HALT — a demo built on a fraction of the prospect's site does not
  // go out without a human saying so.
  //
  // Threshold agreed 2026-08-15 at 60%. It is a HALT, not a failure: the run
  // stops at the gate it was already going to stop at, with the reason and
  // the missing pages on the card. Acme Renew shipped at 28% and the reviewer
  // had nothing in front of them saying so.
  //
  // Two deliberate exemptions:
  //  - `no-sitemap` NEVER halts. Not being able to measure completeness is
  //    not evidence of incompleteness, and a gate that blocks on "I could not
  //    find a sitemap" gets routed around within a week.
  //  - DEMO_ALLOW_LOW_COVERAGE=1 overrides it, and the override is RECORDED
  //    in state + written onto the card, so a waived demo is auditable rather
  //    than indistinguishable from a passing one.
  const coverageOverride = process.env.DEMO_ALLOW_LOW_COVERAGE === "1";
  const coverageHalted =
    state.coverageVerdict === "under-crawled" &&
    typeof state.coverageRatio === "number" &&
    state.coverageRatio < COVERAGE_HALT_THRESHOLD;

  if (coverageHalted && coverageOverride) {
    state.coverageOverriddenBy = "DEMO_ALLOW_LOW_COVERAGE";
    save();
    log(
      `gate2: ⚠️ coverage ${(state.coverageRatio! * 100).toFixed(0)}% is below the ` +
        `${(COVERAGE_HALT_THRESHOLD * 100).toFixed(0)}% halt threshold — OVERRIDDEN by DEMO_ALLOW_LOW_COVERAGE`,
    );
  }


  if (!state.gate2TaskId) {
    if (!boardUp) {
      save();
      console.log([
        "",
        "⛔ GATE 2 — demo awaiting review.",
        `   Workspace: ${state.workspaceId}  Vector: ${state.vectorId ?? state.activeVector}`,
        "   review board is not running (start with: review-board up). Start it and re-run.",
        "",
      ].join("\n"));
      process.exit(EXIT_INFRA_DOWN);
    }

    // Extract probe scores from log for context
    const probeLines = state.log
      .filter((e) => e.msg.startsWith("probe "))
      .map((e) => `- ${e.msg.slice(0, 200)}`)
      .join("\n");

    const activeVec = state.activeVector ?? state.vectorId;

    // ScoredQA section — automated review results, with deep links back to
    // the QA run in the Divinci web app.
    const qaPct =
      state.qaScore !== undefined && state.qaScore !== null
        ? `${(state.qaScore * 100).toFixed(1)}%`
        : null;
    const qaSection = state.qaSuiteId
      ? [
          "### Scored QA (automated review)",
          qaPct
            ? `- **Score: ${qaPct}** (${state.qaPassedCount}/${state.qaTestCount} passed)`
            : "- Suite imported but not yet run",
          ...(state.qaRunId
            ? [`- [Run results](${qaRunUrl(state.workspaceId!, state.qaRunId)})`]
            : []),
          `- [Quality report](${qaSuiteReportUrl(state.workspaceId!, state.qaSuiteId)})`,
          ...state.log
            .filter((e) => e.msg.startsWith("qa:   "))
            .slice(-(state.qaTestCount ?? 6))
            .map((e) => `  - ${e.msg.slice(6)}`),
          "",
        ]
      : [
          "### Eval queries (manual review — no QA suite for this run)",
          manifest.evalQueries.map((q) => `- ${q}`).join("\n"),
          "",
        ];

    const coverageSection = coverageHalted
      ? [
          `### ⛔ Corpus coverage ${(state.coverageRatio! * 100).toFixed(0)}% — below the ${(COVERAGE_HALT_THRESHOLD * 100).toFixed(0)}% threshold`,
          `${(state.coverageMissing ?? []).length} page(s) in the prospect's sitemap never reached the vector.`,
          "An assistant cannot answer from a page it never ingested; it will invent instead.",
          ...(state.coverageMissing ?? []).slice(0, 12).map((u) => `- ${u}`),
          ...((state.coverageDuplicates ?? []).length
            ? ["", `Also ${state.coverageDuplicates!.length} url(s) ingested more than once: `
                + state.coverageDuplicates!.slice(0, 3).map((d) => `${d.url} ×${d.count}`).join(", ")]
            : []),
          coverageOverride
            ? "\n**Overridden** via DEMO_ALLOW_LOW_COVERAGE — approving anyway is a deliberate choice."
            : "\n**Re-crawl before approving**, or set DEMO_ALLOW_LOW_COVERAGE=1 to waive it on the record.",
          "",
        ]
      : typeof state.coverageRatio === "number"
        ? [`### Corpus coverage: ${(state.coverageRatio * 100).toFixed(0)}% of sitemap pages ingested`, ""]
        : state.coverageVerdict === "no-sitemap"
          ? ["### Corpus coverage: no sitemap found — completeness unverified", ""]
          : [];

    const task = await createTask({
      title: `[Gate 2] ${manifest.prospectName} — demo review`,
      description: [
        `## ${manifest.prospectName} — demo review (run ${manifest.run})`,
        ...coverageSection,
        "",
        `**Compliance tier:** ${manifest.complianceTier}`,
        "",
        "### Where to try it",
        // The web UI of whatever env this run targeted. Hardcoding staging sent
        // the Gate 2 reviewer to an environment the workspace does not exist in
        // — the gate then cannot be performed, and the obvious reading of an
        // empty workspace list is "the demo is broken".
        //
        // Deep-link straight to the workspace rather than printing bare ids: the
        // reviewer was otherwise expected to eyeball a 24-char ObjectId against
        // a list, which the web client truncates in its ID column.
        `- **Open the workspace:** ${workspaceUrl(state.workspaceId!)}`,
        `- Vectors: ${workspaceVectorsUrl(state.workspaceId!)}`,
        `- Workspace ID: \`${state.workspaceId}\``,
        `- Active vector: \`${activeVec}\``,
        ...(state.releaseId ? [`- Release: \`${state.releaseId}\``] : []),
        "",
        ...qaSection,
        ...(probeLines ? ["### Retrieval probe scores", probeLines, ""] : []),
        "### Action",
        "Review the Scored QA results above (spot-check the quality report), then",
        "mark **DONE** to approve and proceed to release, **CANCELED** to reject.",
      ].join("\n"),
      projectId,
      priority: "high",
      tags: ["gate2", "demo-review", manifest.prospect],
    });
    state.gate2TaskId = task.id;
    save();
    log(`gate2: created review-board task ${task.id}`);
  }

  // Poll / check the task status
  await pollGate({
    taskId: state.gate2TaskId,
    gateName: "GATE 2",
    hint: "Open your review board → Demo Pipeline and mark the task DONE to approve, CANCELED to reject.",
    onApproved: (task) => {
      // The halt is enforced HERE, not only on the card: a reviewer can mark a
      // task DONE without reading it, and the whole point is that a 28%-corpus
      // demo does not reach a prospect by default.
      if (coverageHalted && !coverageOverride) {
        log(`gate2 approval BLOCKED — coverage ${(state.coverageRatio! * 100).toFixed(0)}% < ${(COVERAGE_HALT_THRESHOLD * 100).toFixed(0)}%`);
        console.error(
          `\n⛔ GATE 2 approved, but corpus coverage is ${(state.coverageRatio! * 100).toFixed(0)}% — ` +
            `below the ${(COVERAGE_HALT_THRESHOLD * 100).toFixed(0)}% halt threshold.\n` +
            `   ${(state.coverageMissing ?? []).length} sitemap page(s) never reached the vector.\n` +
            "   Re-crawl and re-run, or re-run with DEMO_ALLOW_LOW_COVERAGE=1 to waive it on the record.",
        );
        process.exit(1);
      }
      state.demoApprovedBy = "review-board";
      log(`gate2 approved via review-board task ${task.id}`);
    },
    onRejected: (task) => {
      log(`gate2 REJECTED via review-board task ${task.id}`);
      console.error("\n❌ GATE 2 rejected on the review board. Run aborted.");
      process.exit(1);
    },
  });
}

async function release(): Promise<void> {
  if (DRY_RUN) { state.releaseId = state.releaseId ?? "aaaaaaaaaaaaaaaaaaaadry1"; return log("[dry-run] release published (stub)"); }
  // Auto-discover the workspace's default draft release (created with the
  // workspace) so the pipeline is unattended — no manual `release list` + re-run.
  if (!state.releaseId) {
    try {
      const r = await dv(["release", "list", "--json"], { workspace: state.workspaceId, profile: args.profile });
      const arr = Array.isArray(r.json) ? r.json : (r.json as { data?: unknown[] })?.data;
      const first = Array.isArray(arr) ? (arr[0] as { _id?: string; id?: string }) : undefined;
      const id = first?._id ?? first?.id;
      if (!id) { log("release: could not discover a default release — skipping"); return; }
      state.releaseId = id;
      save();
      log(`release: discovered default release ${id}`);
    } catch (e) {
      log(`release: release list failed (${(e as Error).message.split("\n")[0]}) — skipping`);
      return;
    }
  }
  // Guard: the release we are about to write to must be the one the LANDING
  // PAGE serves. `landing.ts` bakes brand-draft.json's releaseId into the
  // Worker bundle, and that draft is only regenerated when absent — so the two
  // ids drift, and every write here then lands where no visitor can see it
  // while reporting success at every layer. See served-release.ts.
  {
    const split = findReleaseSplit({ prospect, run: runId, state }, runDir);
    if (split) {
      log(`release: ⚠️  SERVED-RELEASE SPLIT — ${describeSplit(split)}`);
      log(`release: writing to ${split.servedReleaseId} (the served one) instead of ${split.stateReleaseId}`);
      state.releaseId = split.servedReleaseId;
      save();
    }
  }

  // Publish via the CLI (OAuth session) — no Bearer DIVINCI_API_KEY needed.
  // Workspace creation already requires OAuth (account-level), so the whole
  // pipeline runs on `divinci auth login`; a separate stage API key is not
  // required. (CLI uses DIVINCI_API_KEY only if it's set in env.)
  const getStatus = async (): Promise<string> => {
    const r = await dv(["release", "get", state.releaseId!], { workspace: state.workspaceId, profile: args.profile });
    try {
      const j = JSON.parse(r.raw.slice(r.raw.indexOf("{"))) as { status?: string };
      return j.status ?? "unknown";
    } catch {
      return r.raw.match(/"status"\s*:\s*"([^"]+)"/)?.[1] ?? "unknown";
    }
  };
  let s = await getStatus();
  if (s === "draft") {
    // KNOWN ISSUE (2026-06-12): publishing on staging is slow and can 524; the
    // work often still finishes server-side, so we attempt then re-check status.
    log("release: publishing via CLI (OAuth)…");
    try {
      await dv(["release", "publish", state.releaseId!], { workspace: state.workspaceId, profile: args.profile, timeoutMs: 150_000 });
    } catch (e) {
      log(`release: publish call errored (${(e as Error).message.split("\n")[0]}) — re-checking status`);
    }
    try { s = await getStatus(); } catch { s = "unknown (API recovering)"; }
    log(s === "draft" || s.startsWith("unknown")
      ? `release: publish did NOT complete (status: ${s}) — demo link may be blocked; continuing`
      : `release: published (status: ${s})`);
  } else {
    log(`release: status "${s}" — already published`);
  }
  // Make the release demo-ready AFTER publishing: attach the RAG vector + open
  // anonymous chat so the demo link is grounded AND works without login. NB:
  // doing this on a never-published DRAFT 500s on staging, but the same
  // GET-merge-POST succeeds once the release is published — so configure last.
  const vec = state.vectorId ?? state.activeVector;
  if (vec) {
    try {
      const { configureDemoRelease } = await import("./landing.js");
      await configureDemoRelease(state.workspaceId!, state.releaseId!, vec);
      log(`release: attached RAG vector ${vec} + opened anonymous chat`);
    } catch (e) {
      log(`release: configure failed (${(e as Error).message.split("\n")[0]}) — demo chat may need a manual fix`);
    }
  }

  // Conversation starters + welcome message ON THE RELEASE.
  //
  // The landing page has always had its own `chat.fallbackWelcome`/`starters`,
  // but those are copy baked into the worker bundle — the release itself had
  // none, so the assistant greeted visitors on the landing page and nowhere
  // else (workspace chat, embed, or the raw release link all opened bare).
  // These are separate workspace RESOURCES referenced by id, not text fields;
  // see release-chat-resources.ts.
  try {
    const { ensureReleaseChatResources } = await import("./release-chat-resources.js");
    const chat = releaseChatCopy();
    /**
     * FORCE_CHAT_RESOURCES=1 re-points the release at freshly created chat
     * resources, overwriting what is already there.
     *
     * These references are non-destructive by default, and rightly so: a demo
     * release is something a human may have hand-tuned before sending it. But
     * that also meant a change to the COMPLIANCE FLOOR could never reach a
     * demo that had already been built — the threadPrefix resource carrying
     * the tier's rules was created once and left alone forever. When the rules
     * change (as they did for clinic-high on 2026-08-05), every existing
     * release needs re-pointing, and there was no way to ask for it.
     */
    const forceChat = process.env.FORCE_CHAT_RESOURCES === "1";
    if (forceChat) log("release chat: FORCE_CHAT_RESOURCES=1 — replacing existing references");
    const res = await ensureReleaseChatResources(state.workspaceId!, state.releaseId!, chat, {
      force: forceChat,
    });
    for (const note of res.notes) log(`release chat: ${note}`);
  } catch (e) {
    log(`release chat: failed (${(e as Error).message.split("\n")[0]}) — starters/welcome NOT set on the release`);
  }
}

/**
 * The starters + welcome message to put on the release.
 *
 * Prefers `manifest.chat`, because eval queries and conversation starters have
 * DIFFERENT jobs: eval queries are diagnostic probes chosen to stress
 * retrieval, while a starter is the first thing a prospect reads and should
 * sound like their own site. Falling back to the eval queries is better than a
 * bare chat, but it is a fallback — author `chat.starters` in the manifest.
 */
function releaseChatCopy(): {
  starters: string[]; welcomeMessage: string; threadPrefix: string[]; msgPrefix?: string;
} {
  const org = manifest.prospectName.replace(/\s*\(.*\)\s*$/, "").trim();
  return {
    starters: manifest.chat?.starters ?? manifest.evalQueries.slice(0, 3),
    welcomeMessage:
      manifest.chat?.welcomeMessage ??
      `Hi, I'm the ${org} AI. Ask me anything about our work.`,
    // threadPrefix is the SYSTEM-PROMPT channel, not a label.
    //
    // `generateThread` (server: release/public/statics/usableReleaseEnv.ts)
    // pushes every entry as a `role: "system"` message at the top of the
    // thread. An earlier version of this file set it to `"<Org> chat"` and
    // described it as titling conversations — that put a caption in the
    // assistant's instruction slot and left the compliance rules nowhere.
    //
    // Consequence, measured on acmebio (clinic-high, IVD manufacturer): the
    // demo recommended a diagnostic panel for a described patient, interpreted
    // a C. difficile result and named antibiotics, and made comparative claims
    // against a competitor device — none of which is in the corpus; all of it
    // is base-model knowledge that no instruction was restraining. Gate 1 had
    // approved "education-only, no diagnosis, every path ends in a handoff",
    // and that text lived only in the manifest and a review-board card.
    // The compliance rules are a FLOOR, not a default.
    //
    // This was `manifest.chat?.threadPrefix ?? complianceSystemPrompt(...)`,
    // so any manifest that supplied its own prefix REPLACED the tier's rules
    // outright — and intake generates a threadPrefix for every run, so from the
    // moment intake was automated no generated demo carried its tier's
    // compliance floor at all. Acme Clinic (clinic-high) shipped with only the
    // LLM's own prose in the system slot, and its QA run scored 0% on
    // correctness for inventing a post-operative rehab protocol.
    //
    // That is the SAME failure this file's docstring already warned about,
    // wearing different clothes: the approved rules existed and did not reach
    // the model. Manifest copy now LAYERS ON TOP of the floor instead of
    // standing in for it.
    // ORDER MATTERS AS MUCH AS PRESENCE. The floor goes LAST.
    //
    // First fix put the floor first and the manifest's copy after it. That
    // stopped the floor being REPLACED but not being CONTRADICTED: Stone
    // Clinic's generated prefix ends "...decline briefly and hand off to the
    // clinic's team to schedule a consultation", which is the exact opposite
    // of the floor's "send them BACK to their own surgeon" — and being last,
    // it won. Measured: the re-run still routed a patient operated on
    // elsewhere to a Acme Clinic consultation.
    //
    // The manifest's copy is context and voice; the floor is the constraint,
    // and it now has the final word (and says so explicitly).
    threadPrefix: [
      ...(manifest.chat?.threadPrefix ?? []),
      /**
       * The VOICE floor, between the manifest's copy and the compliance floor.
       *
       * Measured across 134 manifests: ZERO carried any first-person voice
       * instruction, and 43 had no instruction in the system slot at all —
       * just a label. Demos therefore answered as an outside analyst:
       * "According to [2], AcmeAlgos is an independent consultancy... they
       * work on...". Right facts, right citations, wrong speaker.
       *
       * A floor rather than a better intake prompt, for the third time in this
       * file and the same reason each time: a generated prefix that omits the
       * rule is indistinguishable from one that never needed it.
       *
       * ⚠️ Placement is NOT sufficient on its own. The compliance floor opens
       * with a BLANKET override ("INCLUDING ANYTHING ABOVE"), so voice rules
       * placed here are disclaimed by it — which is why the identity claim
       * itself lives inside `complianceSystemPrompt`. What stays here is the
       * STYLE (no source narration, no hedging), which nothing contradicts.
       */
      ...personaSystemPrompt(org),
      ...complianceSystemPrompt(
        org,
        manifest.complianceTier,
        manifest.complianceNotes,
        manifest.complianceFlags ?? [],
      ),
    ],
    msgPrefix: manifest.chat?.msgPrefix,
  };
}

/**
 * Build a brand.config draft for the landing page from the run's data. The
 * palette is a neutral default placeholder — the Playwright brand extractor
 * (planned) fills real colors/logo from the prospect site; until then the
 * [Landing] gate is where a human refines it.
 */
/**
 * Best-available count of indexed documents in the demo vector, for the
 * landing page's "pages indexed" stat. Prefers a live count from the RAG
 * files endpoint; falls back to the crawl page tally (pagesCrawled), then to
 * the source count. NEVER returns the manifest-source count as the headline
 * number — that conflates 3 sources with the ~99 pages they expand into.
 */
async function indexedFileCount(): Promise<number> {
  try {
    const res = await dv(["rag", "files", "--limit", "500"], {
      workspace: state.workspaceId,
      profile: args.profile,
    });
    const j = res.json as { data?: unknown[]; files?: unknown[] } | unknown[] | undefined;
    const arr = Array.isArray(j) ? j : (j?.data ?? j?.files);
    if (Array.isArray(arr) && arr.length) return arr.length;
  } catch {
    /* RAG files endpoint is 500-flaky on staging — fall through to the tally */
  }
  return state.pagesCrawled || state.ingested.length;
}

/**
 * QA evidence to publish on the landing page — or nothing.
 *
 * Publishing a quality number to a PROSPECT is a different act from showing it
 * to a Gate 2 reviewer, and it earns a stricter rule:
 *
 *  - Only a REAL score. Never a placeholder, never "pending". A demo with no
 *    evidence simply does not make the claim.
 *  - Only at or above PUBLISH_MIN. Gate 2 is a human decision and a human can
 *    approve a mediocre score for good reasons; that is not the same as putting
 *    "68% — adversarially tested" on the page as a selling point. Below the
 *    threshold the demo is still sendable, it just does not boast.
 *  - Always with WHAT WAS TESTED. A bare percentage invites "of what, graded by
 *    whom?" and we cannot answer crisply — the suite is ours. Naming the hazard
 *    turns an unbacked number into a description of a practice, which is both
 *    honest and the actually-differentiating part.
 *
 * NOTE: this is deliberately not TrustBench. TrustBench (server monorepo)
 * produces Ed25519-signed, independently verifiable run manifests — that is the
 * real version of this claim, and the landing page should eventually carry an
 * attestation rather than a self-reported figure.
 */
function qaEvidenceForLanding(): LandingBrandDraft["qa"] {
  const score = state.qaScore;
  if (score === undefined || score === null) return undefined;
  if (score < QA_PUBLISH_MIN) {
    log(`landing: QA score ${(score * 100).toFixed(0)}% is below the ${Math.round(QA_PUBLISH_MIN * 100)}% publish threshold — omitting the QA claim`);
    return undefined;
  }
  // Key the CLAIM on correctness, not the blended score.
  //
  // Relevance scores 98-100% on nearly everything, because a fabricated answer
  // is still on-topic. Acme Clinic's run was 83% overall — above the publish
  // threshold — while containing a 0%-correctness test that invented a post-op
  // rehab protocol. Publishing "83% adversarially tested" on that page would
  // have been the single most misleading thing this pipeline could do.
  const correctness = state.qaScoreAverages?.correctness;
  if (correctness !== undefined && correctness < QA_PUBLISH_MIN) {
    log(`landing: correctness ${(correctness * 100).toFixed(0)}% is below the publish threshold (overall was ${(score * 100).toFixed(0)}%) — omitting the QA claim`);
    return undefined;
  }
  // One catastrophic test is not redeemed by nine good ones.
  if (state.qaMinTestScore !== undefined && state.qaMinTestScore !== null && state.qaMinTestScore < 0.5) {
    log(`landing: a test scored ${(state.qaMinTestScore * 100).toFixed(0)}% — omitting the QA claim regardless of the mean`);
    return undefined;
  }
  const total = state.qaTestCount ?? 0;
  const passed = state.qaPassedCount ?? 0;
  if (!total) return undefined;
  return {
    scorePct: `${(score * 100).toFixed(0)}%`,
    passed,
    total,
    hazard: TIER_HAZARD_SUMMARY[manifest.complianceTier],
  };
}

function draftLandingBrand(extracted?: ExtractedBrand, indexedCount?: number, brandDir?: string): LandingBrandDraft {
  // `demo-` prefix namespaces demo workers so a prospect slug can never collide
  // with (and clobber) a real production worker on `wrangler deploy`.
  const workerName = `demo-${manifest.prospect}-landing`;
  // Split "Acme Spine Care (Dr. Alex Rivera)" → org (brand identity / chat name)
  // + person (bio + headshot match). Keeps the doctor out of the AI's name so
  // it reads "Acme Spine Care AI", not "… (Dr. …) AI", and doesn't repeat 3×.
  const m = manifest.prospectName.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  const org = (m ? m[1] : manifest.prospectName).trim();
  const person = m ? m[2].trim() : undefined;
  const qa = qaEvidenceForLanding();
  const placeholderPalette = {
    primary: "#1f3a5f", dark: "#13283f", mid: "#2e5a86", accent: "#4a90d9",
    cream: "#f5f7fa", soft: "#e8edf2", bubble: "#dce7f2", text: "#1a1a1a",
  };
  return {
    siteName: org,
    domain: `https://${workerName}.${WORKERS_SUBDOMAIN()}`,
    productName: aiProductName(org),
    legalName: org,
    palette: extracted?.palette ?? placeholderPalette,
    fontFamily: extracted?.fontFamily,
    displayFontFamily: extracted?.displayFontFamily,
    displayFontStyle: extracted?.displayFontStyle,
    displayFontWeight: extracted?.displayFontWeight,
    displayLetterSpacing: extracted?.displayLetterSpacing,
    displayFontVariationSettings: extracted?.displayFontVariationSettings,
    logoFile: extracted?.logoFile,
    logoIsLight: extracted?.logoIsLight,
    logoIsMark: extracted?.logoIsMark,
    // Where the logo's LETTERFORMS sit, so the lockup can baseline on them
    // rather than on the image's bottom edge (a mark that descends below the
    // letters otherwise pushes the whole name up). Undefined for an SVG, a
    // logo with no alpha, or one that needs no correction — and undefined
    // must leave the lockup exactly as it is.
    logoBaselineDrop: extracted?.logoFile && brandDir
      ? measureLogoBaselineDrop(join(brandDir, extracted.logoFile))
      : undefined,
    fontLinks: extracted?.fontLinks,
    mainSite: manifest.sources.find((s) => s.tier === "T1")?.url ?? "https://example.com",
    signupUrl: manifest.sources.find((s) => s.tier === "T1")?.url ?? "https://example.com",
    // Only surface a "Log in" CTA when the prospect's site actually has one.
    loginUrl: extracted?.loginUrl ?? manifest.sources.find((s) => s.tier === "T1")?.url ?? "https://example.com",
    hasLogin: !!extracted?.loginUrl,
    releaseId: state.releaseId ?? "",
    apiBase: process.env.DIVINCI_API_URL ?? "https://api.divinci.app",
    whitelabelId: state.workspaceId ?? "",
    bios: [{ name: person ?? org, title: "About", blurbKey: "bios.bodies.0" }],
    // Provisional: the team/headshot step below promotes this to true on
    // evidence of an actual person. `person` is only set when the prospect's
    // name carries a parenthetical — and some queue entries put the legal
    // entity there rather than a person, which is what produced "The Space
    // Finance Group — Founder" on a deployed demo.
    showBios: !!person && !looksLikeOrganisation(person),
    corpusFraming: qa
      ? "Built on our published knowledge base — and adversarially tested before release"
      : "Built on our published knowledge base",
    corpusStats: [
      // "pages indexed" (the ~99 crawled+indexed docs), NOT manifest sources (3).
      { value: `${indexedCount ?? (state.pagesCrawled || state.ingested.length)}`, label: "pages indexed" },
      { value: "24/7", label: "availability" },
      // "AI" is not a metric — use a real, on-message stat (every answer cites).
      { value: "100%", label: "cited answers" },
      // Only present when the run has a real score at/above the threshold, so
      // the row never carries a placeholder or an unearned boast.
      ...(qa ? [{ value: qa.scorePct, label: `adversarial QA (${qa.passed}/${qa.total} passed)` }] : []),
    ],
    qa,
    fallbackWelcome: `Hi, I'm the ${org} AI. Ask me anything about our work.`,
    starters: manifest.evalQueries.slice(0, 3),
    ogTagline: `${org} — answered 24/7.`,
    // No brand name here: ogTagline directly above already carries it, and the
    // card renders them one under the other — "AcmePath AI — answered 24/7." /
    // "AI-powered answers from AcmePath AI, in any language." states it twice
    // in two lines, on top of the wordmark in the lockup above. Three times on
    // one card.
    ogSubtitle: "AI-powered answers, in any language.",
    referralSource: `${manifest.prospect}-demo`,
    workerName,
  };
}

/**
 * Landing stage — build + deploy a branded landing page wrapping the release,
 * gated by a [Landing] review-board task for brand review before the paid build.
 * The deployed worker URL becomes the demo link in the outreach email.
 */
async function landing(): Promise<void> {
  // LANDING_FORCE=1 rebuilds an already-deployed demo — the backfill path for
  // picking up a template fix. Without it a deployed run is left alone, which
  // is what every normal resumption wants.
  if (state.landingUrl && process.env.LANDING_FORCE !== "1") {
    log(`landing already deployed: ${state.landingUrl}`);
    return;
  }
  if (DRY_RUN) {
    state.landingWorkerName = `demo-${manifest.prospect}-landing`;
    state.landingUrl = `https://${state.landingWorkerName}.${WORKERS_SUBDOMAIN()}`;
    return log(`[dry-run] landing deployed (stub): ${state.landingUrl}`);
  }
  if (!state.releaseId) {
    log("landing: no releaseId — skipping branded landing (outreach falls back to bare embed link)");
    return;
  }

  const landingDir = join(runDir, "landing");
  if (!existsSync(landingDir)) mkdirSync(landingDir, { recursive: true });
  const brandAssetsDir = join(landingDir, "brand");
  if (!existsSync(brandAssetsDir)) mkdirSync(brandAssetsDir, { recursive: true });
  const draftPath = join(landingDir, "brand-draft.json");

  // BACKFILL: teach an EXISTING draft the fields the extractor learned later.
  //
  // Extraction runs only when the draft is absent, which is correct for a
  // normal re-run and permanent for every demo already built: 43 of them can
  // never acquire displayFontFamily, logoIsMark or the display cut, so template
  // work that depends on those fields silently does nothing for them.
  //
  // Merges absent fields only — a hand-tuned draft keeps its values. Opt-in,
  // because it re-crawls the customer's site.
  if (existsSync(draftPath) && process.env.LANDING_REEXTRACT === "1") {
    const site = manifest.sources.find((s) => s.tier === "T1")?.url;
    if (site) {
      try {
        log(`landing: re-extracting brand from ${site} (LANDING_REEXTRACT=1)…`);
        const fresh = await extractBrand(site, brandAssetsDir);
        const existing = JSON.parse(readFileSync(draftPath, "utf8")) as Record<string, unknown>;
        const added = backfillBrandDraft(existing, fresh as unknown as Record<string, unknown>);
        const repaired = repairDoubledAiSuffix(existing);
        if (repaired) {
          added.push("productName (AI AI → AI)");
          log(`landing: repaired doubled AI suffix → ${repaired}`);
        }
        const subtitle = repairRedundantOgSubtitle(existing);
        if (subtitle) {
          added.push("ogSubtitle (dropped repeated brand name)");
          log(`landing: repaired redundant og subtitle → ${subtitle}`);
        }
        if (added.length > 0) {
          writeFileSync(draftPath, JSON.stringify(existing, null, 2) + "\n");
          log(`landing: backfilled ${added.length} brand field(s): ${added.join(", ")}`);
        } else {
          // Said explicitly. "Re-extracted" with no report reads as a refresh
          // that worked, when it may equally mean the site yielded nothing new.
          log("landing: re-extract added nothing — every backfillable field was already set");
        }
      } catch (err) {
        // Never fatal: the existing draft already builds a correct page, so a
        // failed refresh must not take a working demo offline.
        log(`landing: re-extract failed (${(err as Error).message.split("\n")[0]}) — keeping the existing draft`);
      }
    }
  }

  // MEDIA BACKFILL: fill in a hero image / corpus video an EXISTING draft never
  // got. Same permanence trap as the brand fields — generation lives inside the
  // draft-creation block below, so a failure at first build (a Vertex hiccup, a
  // budget guard, a transient 5xx) is permanent, and the section renders empty
  // on every rebuild forever after. AcmePath had neither; acmewhitfield has a
  // hero and no video.
  //
  // Opt-in because it spends real Vertex money, and additive only: a demo that
  // already has media keeps exactly what it has.
  if (existsSync(draftPath) && process.env.LANDING_REMEDIA === "1") {
    const existing = JSON.parse(readFileSync(draftPath, "utf8")) as LandingBrandDraft & Record<string, unknown>;
    if (!existing.heroImageUrl || !existing.corpusVideoUrl) {
      const missing = [!existing.heroImageUrl && "hero", !existing.corpusVideoUrl && "corpusVideo"].filter(Boolean);
      log(`landing: re-generating missing media (${missing.join(", ")}) — LANDING_REMEDIA=1`);
      try {
        await guardCheck();
        const genDir = join(landingDir, "gen");
        if (!existsSync(genDir)) mkdirSync(genDir, { recursive: true });
        const media = await generateBrandMedia(genDir, prospect, {
          primaryHex: (existing.palette as Record<string, string> | undefined)?.primary,
          accentHex: (existing.palette as Record<string, string> | undefined)?.accent,
          subject: [
            existing.siteName,
            queueClusterFor(manifest.prospect),
            manifest.evalQueries?.slice(0, 4).join(" "),
            manifest.complianceNotes?.split(".")[0],
          ].filter(Boolean).join(" — "),
          productName: existing.productName,
        });
        const filled: string[] = [];
        if (!existing.heroImageUrl && media.heroImageUrl) { existing.heroImageUrl = media.heroImageUrl; filled.push("hero"); }
        if (!existing.corpusVideoUrl && media.corpusVideoUrl) { existing.corpusVideoUrl = media.corpusVideoUrl; filled.push("corpusVideo"); }
        if (media.corpusPosterPath && existsSync(media.corpusPosterPath))
          copyFileSync(media.corpusPosterPath, join(brandAssetsDir, "corpus-poster.jpg"));
        if (filled.length > 0) {
          writeFileSync(draftPath, JSON.stringify(existing, null, 2) + "\n");
          log(`landing: media backfilled — ${filled.join(", ")}`);
        } else {
          // Said out loud. Silence after a paid generation reads as success.
          log("landing: media re-generation produced nothing — the section stays empty");
        }
      } catch (err) {
        log(`landing: media re-generation failed (${(err as Error).message.split("\n")[0]}) — keeping the existing draft`);
      }
    }
  }

  if (!existsSync(draftPath)) {
    // Extract real palette + logo from the prospect's site (Playwright). The
    // extracted logo is written into landing/brand/ so the build copies it into
    // the worker. Falls back to the placeholder palette if extraction fails.
    let extracted: ExtractedBrand | undefined;
    const site = manifest.sources.find((s) => s.tier === "T1")?.url;
    if (site) {
      try {
        log(`landing: extracting brand (palette + logo) from ${site}…`);
        extracted = await extractBrand(site, brandAssetsDir);
        log(`landing: extracted palette primary ${extracted.palette.primary}, accent ${extracted.palette.accent}, logo ${extracted.logoFile ?? "none"}`);
      } catch (err) {
        log(`landing: brand extraction failed (${(err as Error).message.split("\n")[0]}) — using placeholder palette`);
      }
    }
    const indexedCount = await indexedFileCount();
    const draft = draftLandingBrand(extracted, indexedCount, brandAssetsDir);

    // Generate on-brand hero (still) + corpus (looping video) media via Vertex
    // (Imagen 3 + Veo 3.1 Fast) → R2. Steered by the extracted primary color.
    // Degrades gracefully: on any failure the draft keeps placeholder media.
    // Coarse operator kill-switch before paid generation. NOTE: this gates on
    // the ks-guard *agent/LLM* budget — it does NOT meter Vertex (Imagen/Veo)
    // spend, which is billed separately and is currently UNtracked. (backlog:
    // add a Vertex cost guard / per-run media budget.)
    await guardCheck();
    log(`landing: generating on-brand media (Imagen + Veo → R2)…`);
    const genDir = join(landingDir, "gen");
    if (!existsSync(genDir)) mkdirSync(genDir, { recursive: true });
    const media = await generateBrandMedia(genDir, prospect, {
      primaryHex: extracted?.palette.primary,
      accentHex: extracted?.palette.accent,
      // Richer subject so the hero motifs reflect the FIELD, not just the name —
      // the lead's title + compliance one-liner are the cheapest domain signals.
      // What the corpus is ABOUT, not what the company is called.
      //
      // This used to be `[siteName, bios[0].title, complianceNotes first
      // sentence]`, and bios[0].title is the literal string "About" whenever no
      // person was identified — so a space-finance research firm produced a
      // hero of "lounge chairs with a space view". The cluster and the eval
      // queries are the two places the actual subject matter is written down:
      // the queries were authored from the prospect's own pages, so their nouns
      // are the domain's nouns.
      subject: [
        draft.siteName,
        queueClusterFor(manifest.prospect),
        manifest.evalQueries?.slice(0, 4).join(" "),
        manifest.complianceNotes?.split(".")[0],
      ].filter(Boolean).join(" — "),
      productName: draft.productName,
    });
    if (media.heroImageUrl) draft.heroImageUrl = media.heroImageUrl;
    if (media.corpusVideoUrl) draft.corpusVideoUrl = media.corpusVideoUrl;
    if (media.mobileAppVideo) draft.mobileAppVideo = media.mobileAppVideo;
    if (media.offlineVideo) draft.offlineVideo = media.offlineVideo;
    if (media.corpusPosterPath && existsSync(media.corpusPosterPath))
      copyFileSync(media.corpusPosterPath, join(brandAssetsDir, "corpus-poster.jpg"));
    log(media.heroImageUrl ? `landing: media generated → ${media.heroImageUrl}` : `landing: media gen skipped — using placeholders`);

    // Build the team section from the prospect's own site: crawl team/about
    // pages for ALL members (name + role + photo). Each photo is square-cropped
    // → webp → R2. If only one (or none) is found, fall back to the single-bio +
    // headshot path. Members without a confident close photo show initials.
    if (site) {
      try {
        log(`landing: searching ${site} for the team…`);
        const cropUpload = (rawPath: string, key: string): string => {
          const png = join(genDir, `_${key.replace(/\W/g, "")}.png`);
          execFileSync("ffmpeg", ["-y", "-i", rawPath, "-vf", "crop='min(iw,ih)':'min(iw,ih)',scale=320:320", "-frames:v", "1", png], { stdio: "ignore" });
          const webp = join(genDir, `${key}.webp`);
          execFileSync("cwebp", ["-q", "85", png, "-o", webp], { stdio: "ignore" });
          return uploadDemoAsset(webp, `${prospect}/${key}.webp`, "image/webp");
        };
        const team = await findTeam(site, { outDir: genDir });
        if (team.length >= 2) {
          // The generated lead bio (bios.bodies.0) belongs to the first member;
          // the rest are name + role + photo cards.
          draft.bios = team.map((m, i) => ({
            name: m.name,
            title: m.title,
            blurbKey: `bios.bodies.${i}`,
            image: m.imagePath ? cropUpload(m.imagePath, `team-${i}`) : undefined,
          }));
          draft.showBios = true;
          log(`landing: team → ${team.length} members (${team.filter((m) => m.imagePath).length} with photos): ${team.map((m) => m.name).join(", ")}`);
        } else if (draft.bios.length) {
          // Single lead: keep the generated bio, just find their headshot.
          const raw = join(genDir, "headshot.raw");
          const found = await findHeadshot(site, { personName: draft.bios[0].name, outPath: raw });
          if (found) {
            // Finding a headshot for this name is evidence the name IS a person.
            draft.bios[0].image = cropUpload(raw, "headshot");
            draft.showBios = true;
            log(`landing: headshot → ${draft.bios[0].image} (from ${found.sourceUrl})`);
          } else {
            log(`landing: no headshot found — bio uses initials avatar`);
          }
        }
      } catch (err) {
        log(`landing: team/headshot step skipped (${(err as Error).message.split("\n")[0]})`);
      }
    }

    if (draft.showBios === false)
      log(
        "landing: team section HIDDEN — no identifiable person, and the card would " +
          `have read "${draft.siteName} — <role>", which is false rather than merely bare`,
      );
    writeFileSync(draftPath, JSON.stringify(draft, null, 2) + "\n");
    log(`landing: drafted brand config → ${draftPath} (${indexedCount} pages indexed; refine before approving)`);
  }

  // Generate customized landing copy (en.ts) from the prospect research, so the
  // page prose is branded too — not just the component chrome. Validated +
  // applied at build time; falls back to neutral copy if generation/shape fails.
  const enDraftPath = join(landingDir, "en.draft.ts");
  if (!existsSync(enDraftPath)) {
    try {
      const researchPath = join(runDir, "outreach", "research-expanded.md");
      const research = existsSync(researchPath)
        ? readFileSync(researchPath, "utf8")
        : [
            `${manifest.prospectName} (${manifest.complianceTier}).`,
            manifest.complianceNotes,
            `Anchor reference: ${manifest.anchorCustomer}.`,
            `Sources: ${manifest.sources.map((s) => s.url).join(", ")}.`,
          ].join("\n");
      const NEUTRAL_EN_URL =
        "https://raw.githubusercontent.com/Divinci-AI/divinci-landing-template/main/src/i18n/ui/en.ts";
      const neutralEnTs = await (await fetch(NEUTRAL_EN_URL)).text();
      log("landing: generating per-customer copy (claude -p)…");
      const en = await generateEnTs({
        prospectName: manifest.prospectName,
        productName: aiProductName(manifest.prospectName),
        research,
        evalQueries: manifest.evalQueries,
        neutralEnTs,
        // The team is discovered BEFORE this runs (findTeam above) and written
        // to brand-draft.json, so the generator can be told who the cards are
        // for instead of writing about whoever the research foregrounds and
        // hoping the two orders happen to line up. Read from the file rather
        // than the `draft` binding, which is scoped to the block above and is
        // absent on a re-run that reuses an existing draft.
        bios: readDraftBios(draftPath),
      });
      writeFileSync(enDraftPath, en);
      log(`landing: drafted per-customer copy → ${enDraftPath} (review before approving)`);
    } catch (err) {
      log(`landing: copy generation skipped (${(err as Error).message.split("\n")[0]}) — will use neutral copy`);
    }
  }

  const boardUp = await isAvailable();
  const projectId = boardUp ? await resolveProject() : undefined;

  if (!state.landingTaskId && !state.demoApprovedBy) {
    if (!boardUp) { save(); console.error("\n⛔ LANDING — review board unreachable; start it and re-run.\n"); process.exit(EXIT_INFRA_DOWN); }
    const task = await createTask({
      title: `[Landing] ${manifest.prospectName} — brand review before deploy`,
      status: "TO_DO",
      description: [
        `## Branded landing page for ${manifest.prospectName}`,
        "",
        `Review/refine the draft brand config, then mark **DONE** to build + deploy`,
        `a Cloudflare Worker wrapping release \`${state.releaseId}\`.`,
        "",
        `- Draft: \`runs/${prospect}/${runId}/landing/brand-draft.json\` (palette is a placeholder — set real brand colors)`,
        `- Drop real \`logo.svg\` / \`favicon.svg\` / \`hero.webp\` into \`runs/${prospect}/${runId}/landing/brand/\``,
        `- Template: https://github.com/Divinci-AI/divinci-landing-template`,
        "",
        `On **DONE** → \`<prospect>-landing\` worker deploys and its URL becomes the outreach demo link.`,
      ].join("\n"),
      projectId,
      priority: "high",
      tags: ["landing", "brand-review", manifest.prospect],
    });
    state.landingTaskId = task.id;
    save();
    log(`landing: created [Landing] review task ${task.id}`);
  }

  await pollGate({
    taskId: state.landingTaskId ?? "batch-auto",
    gateName: "LANDING",
    autoApprove: !!state.demoApprovedBy,
    hint: "Refine landing/brand-draft.json + drop assets, then mark the [Landing] task DONE to build + deploy.",
    onApproved: async (task) => {
      await guardCheck(); // build + deploy spends (CF) — gate it
      const draft = JSON.parse(readFileSync(join(runDir, "landing", "brand-draft.json"), "utf8")) as LandingBrandDraft;
      // LANDING_MODE=generated → build a bespoke per-client homepage that iframes
      // this worker's own /embed/ (real branded SDK chat). Default = template.
      let generatedHomepageHtml: string | undefined;
      if (LANDING_MODE === "generated") {
        try {
          const { generateFoundation } = await import("./gen-foundation.js");
          // Best hero copy comes from the generated en.ts (hero.headline); fall
          // back to the OG tagline.
          const enPath = join(landingDir, "en.draft.ts");
          const enSrc = existsSync(enPath) ? readFileSync(enPath, "utf8") : "";
          const headline = enSrc.match(/headline:\s*"([^"]+)"/)?.[1] || draft.ogTagline;
          // Pull the per-client example conversation + greeting straight from the
          // generated copy (AST-materialized, no eval) → deterministic showcase.
          const { extractEnObject } = await import("./copy-gen.js");
          const en = (enSrc && extractEnObject(enSrc)) as any;
          const transcript = en?.transcript && Array.isArray(en.transcript.questions) ? en.transcript : undefined;
          const welcomeMessage = en?.chat?.welcomeMessage ?? draft.fallbackWelcome;
          const kit = {
            org: draft.siteName, productName: draft.productName, tagline: headline,
            valueProp: `An AI assistant trained only on ${draft.siteName}'s own published content — answers with citations, 24/7, in any language. It never diagnoses; it guides you toward a consultation.`,
            palette: { primary: draft.palette.primary, accent: draft.palette.accent, mid: draft.palette.mid, cream: draft.palette.cream, soft: draft.palette.soft, text: draft.palette.text },
            fontFamily: draft.fontFamily ?? "system-ui, sans-serif", fontLink: (draft.fontLinks ?? [])[0],
            logoUrl: draft.logoFile ? `/brand/${draft.logoFile}` : "/brand/logo.svg", logoIsLight: !!draft.logoIsLight,
            corpusStats: draft.corpusStats, team: draft.bios.map((b) => ({ name: b.name, title: b.title, image: b.image })),
            hasLogin: !!draft.hasLogin, mainSite: draft.mainSite,
            embedUrl: "/embed/", // same worker, same origin
            heroImageUrl: draft.heroImageUrl, // faint ambient hero background
            featureVideos: { mobileApp: draft.mobileAppVideo, offline: draft.offlineVideo },
            transcript, welcomeMessage, // deterministic example-chat showcase
            corpusVideo: draft.corpusVideoUrl
              ? { videoUrl: draft.corpusVideoUrl, posterUrl: draft.corpusVideoUrl.replace(/\.(mp4|webm)$/, "-poster.webp") }
              : undefined, // "documents indexed" video in the #how section
            // Conversation starter chips (from the manifest's eval queries)
            conversationStarters: draft.starters?.length ? draft.starters : manifest.evalQueries.slice(0, 4),
            // QA test results (scored by the pipeline's qaEval step)
            // state stores 0-1 score; convert null → undefined for FoundationKit
            qaScore: state.qaScore ?? undefined, qaPassedCount: state.qaPassedCount ?? undefined, qaTestCount: state.qaTestCount ?? undefined,
            qaRunId: state.qaRunId, qaSuiteId: state.qaSuiteId, workspaceId: state.workspaceId,
          };
          log(`landing: generated mode — generating bespoke shell via claude -p…`);
          generatedHomepageHtml = generateFoundation(kit, join(landingDir, "foundation.html"));
          log(`landing: generated bespoke homepage (${generatedHomepageHtml.length}b)`);
        } catch (err) {
          log(`landing: generated mode failed (${(err as Error).message.split("\n")[0]}) — falling back to template`);
        }
      }
      // Preview password gate: lock the demo URL behind Basic Auth so it isn't
      // publicly browsable. Per-prospect creds, generated once + persisted so
      // re-runs reuse them; surfaced in the outreach task to send with the link.
      //
      // Going public is STICKY. Clearing the credentials here would not work —
      // `??=` regenerates them on the next deploy — and neither does deleting
      // the Cloudflare secret by hand. So a demo opened for a customer would be
      // silently re-gated by any later rebuild, including a routine template
      // backfill, and the first sign would be the customer hitting a password
      // prompt on a link that worked yesterday. Recorded on the run instead.
      if (process.env.LANDING_PUBLIC === "1") state.landingPublic = true;
      if (state.landingPublic) process.env.LANDING_PUBLIC = "1";

      // Credentials are minted ONLY when a gate is actually requested.
      //
      // They used to be generated and persisted on every run, then re-exported
      // on every subsequent deploy — which is what silently re-locked a demo
      // that had already been unlocked and handed to a customer. Persisted
      // credentials are the thing that made the re-lock possible, so they are
      // no longer written unless someone asked for a gate on purpose.
      if (process.env.LANDING_GATE === "1" && !state.landingPublic) {
        state.landingBasicAuthUser ??= "preview";
        state.landingBasicAuthPassword ??= `${prospect.replace(/[^a-z0-9]/gi, "")}-${Math.floor(1000 + Math.random() * 9000)}`;
        process.env.BASIC_AUTH_USERNAME = state.landingBasicAuthUser;
        process.env.BASIC_AUTH_PASSWORD = state.landingBasicAuthPassword;
      } else {
        // Drop any credentials a pre-2026-08-14 run persisted, so a redeploy of
        // an old run cannot resurrect its gate.
        delete state.landingBasicAuthUser;
        delete state.landingBasicAuthPassword;
        delete process.env.BASIC_AUTH_USERNAME;
        delete process.env.BASIC_AUTH_PASSWORD;
      }
      save();
      log(`landing: building + deploying ${draft.workerName}…`);
      const res = await buildAndDeployLanding(landingDir, draft, LANDING_KV_ID(), { generatedHomepageHtml });
      state.landingUrl = res.url;
      log(`landing: preview gate ${res.basicAuthSet ? `ON (${state.landingBasicAuthUser} / ${state.landingBasicAuthPassword})` : "OFF"}`);
      state.landingWorkerName = res.workerName;
      save();
      log(`landing approved via task ${task.id} → deployed ${res.url}`);
      // Lock down the release ONLY if the worker got its HMAC secret — require
      // signed anon chat (closes the release-ID quota-bypass) + cap daily spend.
      // Order matters: worker (with secret) is already deployed above.
      if (res.hmacSet && state.releaseId && state.workspaceId) {
        try {
          await hardenDemoRelease(state.workspaceId, state.releaseId);
          log("landing: hardened release (requireSignedAnonymousChat + spend cap)");
        } catch (err) {
          log(`landing: release hardening failed (${(err as Error).message.split("\n")[0]}) — demo works but quota is bypassable; harden manually`);
        }
      } else if (!res.hmacSet) {
        log("landing: LANDING_PAGE_HMAC_KEY unset — skipping signed-chat lockdown (set it in .env to enforce; spend cap still applies if set on the release)");
      }

      // DETERMINISTIC lockup check, before the vision review.
      //
      // The vision model passed the Acme Security demo "0 critical, 0 major" while its
      // hero logo rendered at 1.12:1 contrast (white wordmark on light tan —
      // invisible) and its AI mark sat 3.5px low. Both are arithmetic, so they
      // are measured rather than judged. This runs first because a measured
      // number should not be argued with by a non-reproducible one.
      try {
        const { checkHeroLockup, summarise } = await import("./hero-lockup-run.js");
        const lockup = await checkHeroLockup(res.url);
        for (const line of summarise(lockup)) log(`landing: ${line}`);
        const critical = lockup.flatMap((l) => l.findings).filter((f) => f.severity === "critical");
        if (critical.length) {
          log(
            `landing: ⛔ ${critical.length} CRITICAL lockup defect(s) — the customer's own mark is not legible. ` +
              `Fix before outreach; a demo whose logo cannot be seen should not be sent.`,
          );
        }
      } catch (err) {
        // Never blocks — but says so, rather than passing quietly.
        log(`landing: hero-lockup check DID NOT RUN (${(err as Error).message.split("\n")[0]}) — lockup unverified`);
      }

      // Second layer: automated visual polish review of the freshly-deployed
      // page. Reports a punch-list (it doesn't auto-edit); critical/major
      // findings are surfaced so they're fixed before outreach. Best-effort —
      // a review failure (no gcloud token, etc.) never blocks the pipeline.
      //
      // A mechanical backfill (rebuilding N demos to pick up one code change)
      // gets nothing from this: it is a per-demo vision call with a cost, and
      // by its own note below it is non-reproducible and cannot be trusted in
      // either direction. Nobody reads 82 punch-lists. Opt-in skip, and it says
      // so out loud — a review that vanished silently would be worse than one
      // that is slow.
      if (process.env.SKIP_DESIGN_REVIEW === "1") {
        log("landing: design review SKIPPED (SKIP_DESIGN_REVIEW=1) — visual polish is UNVERIFIED for this build");
      } else try {
        const { reviewLanding } = await import("./design-review.js");
        const { findings, overall } = await reviewLanding(res.url, {
          round: 1,
          outPath: join(landingDir, "design-review.md"),
          // The preview gate is still on at this point — without these the
          // reviewer photographs a 401 and grades that.
          auth:
            state.landingBasicAuthUser && state.landingBasicAuthPassword
              ? { username: state.landingBasicAuthUser, password: state.landingBasicAuthPassword }
              : undefined,
        });
        const crit = findings.filter((f) => f.severity === "critical").length;
        const major = findings.filter((f) => f.severity === "major").length;
        log(`landing: design review — ${findings.length} findings (${crit} critical, ${major} major). ${overall}`);
        if (crit + major > 0)
          // Worded as a prompt to look, not as a verdict. The reviewer is a
          // vision model and is not reproducible: five rebuilds of one
          // unchanged page returned 5, 2, 1, 4 and 4 findings, and "0 critical"
          // on the third of those was luck rather than evidence the mobile crop
          // had gone. It has also graded a stale edge copy, and invented
          // pixelation in a section that contains no image. So it is useful for
          // deciding WHERE to look and cannot be trusted in either direction —
          // neither its findings nor its silence is proof.
          log(`landing: ⚠ review SUGGESTS ${crit + major} issue(s) to check by eye — ${join(landingDir, "design-review.md")}`);
          log(`landing:   (vision model, non-reproducible: 5 runs of one unchanged page gave 5/2/1/4/4 findings — confirm before acting)`);
      } catch (err) {
        log(`landing: design review skipped (${(err as Error).message.split("\n")[0]})`);
      }
    },
    onRejected: (task) => {
      log(`landing CANCELED via task ${task.id} — outreach will use the bare embed link`);
    },
  });
}

/**
 * Outreach stage (Gate 3) — creates the asset-drafting task on the review board.
 *
 * The creative work (expanded research, email draft, Canva deck) is done by
 * Claude / a review board agent ON that task, writing into runs/<prospect>/<run>/
 * outreach/. Task lifecycle: TO_DO (drafting) → IN_REVIEW (assets ready) →
 * DONE (human-approved to send). Nothing is sent automatically.
 */
async function outreach(): Promise<void> {
  if (state.outreachApprovedBy) {
    log(`outreach approved by ${state.outreachApprovedBy}`);
    return;
  }
  if (DRY_RUN) { state.demoLink = state.landingUrl ?? "https://dry-run.example"; state.outreachApprovedBy = "dry-run"; return log("[dry-run] outreach auto-approved"); }
  const outreachDir = join(runDir, "outreach");
  if (!existsSync(outreachDir)) mkdirSync(outreachDir, { recursive: true });

  // Draft the assets BEFORE injecting the link — injectDemoLink needs the email
  // to exist, and it used to log "no email-draft.md yet" and move on, which is
  // how 18 of 19 runs reached the outreach gate with an empty directory.
  // Existing files are never overwritten: they may be a human's edit.
  try {
    const drafted = await draftOutreachAssets(
      {
        manifest,
        corpusBrief: await corpusBrief(),
        // The LIVE workspace count, not state.pagesCrawled. Those differ, and
        // the gap is not small: acmewellness crawled 129 pages and indexed 82.
        // pagesCrawled counts pages VISITED; pages that fail to fetch, parse
        // or embed are still tallied there. The landing page has always used
        // indexedFileCount(), so passing the crawl tally here also made the
        // email contradict the page it links to. An overclaim in an email to
        // the prospect is the worst place for this number to be wrong.
        indexedCount: await indexedFileCount(),
        qaScore: state.qaScore,
        qaPassedCount: state.qaPassedCount,
        qaTestCount: state.qaTestCount,
      },
      outreachDir,
    );
    if (drafted.regenerated.length) log(`outreach: drafted ${drafted.regenerated.join(", ")}`);
    else log("outreach: assets already present — left untouched");
  } catch (err) {
    // Drafting is best-effort: a Gate-3 task with no drafts is still useful,
    // and failing the run here would strand a finished demo.
    log(`outreach: ⚠ asset drafting failed (${(err as Error).message.split("\n")[0]})`);
  }

  // Derive + inject the demo link into the email draft (idempotent).
  await injectDemoLink(outreachDir);

  // Preflight: MEASURE the deployed demo before asking anyone to send it.
  //
  // Deliberately here rather than at the landing step. This is the last moment
  // before a human is asked "may we send this", and it is the artifact as a
  // prospect will receive it — after every patch, redeploy and cache. A page
  // that was fine at build time and broke on the last deploy is exactly the
  // case the earlier checks cannot see.
  //
  // Never fails the run: a stranded finished demo helps nobody, and the gate is
  // a human's to decide. What it guarantees is that the decision is not made
  // against a page nobody looked at.
  let preflight = "";
  if (state.landingUrl && !state.outreachApprovedBy) {
    try {
      log("outreach: preflight — measuring the deployed demo…");
      // runDir-relative: `landingDir` is scoped to the landing step above.
      const shotDir = join(runDir, "landing", "gen");
      const { measurements, defects, retried } = await measureUntilStable(
        state.landingUrl,
        {
          username: state.landingBasicAuthUser ?? "preview",
          password: state.landingBasicAuthPassword ?? "",
        },
        { screenshotDir: shotDir },
      );
      if (retried) log("outreach: preflight re-measured after a pause (first pass may have hit a stale edge copy)");
      preflight = formatDefects(defects);
      // Put the ARTIFACT in front of the reviewer, not just a verdict about it.
      // Every gate here measures mechanics; Michael found eight people captioned
      // "Physician" wearing each other's faces in seconds, by looking, on a page
      // all of them had called clean. Uploaded to R2 because review board renders
      // markdown but stores no attachments — a local path is useless to anyone
      // reading the task on another machine.
      const shots: string[] = [];
      for (const shot of measurements.screenshots ?? []) {
        try {
          const url = uploadDemoAsset(shot.path, `${prospect}/preflight-${shot.label}.png`, "image/png");
          shots.push(`**${shot.label}**\n\n![${prospect} — ${shot.label}](${url})`);
        } catch (err) {
          log(`outreach: could not upload the ${shot.label} screenshot (${(err as Error).message.split("\n")[0]})`);
        }
      }
      // CLAIMS CHECK — does the demo tell the truth about this prospect?
      // Everything above measures the artifact's mechanics. This is the only
      // gate that reads what the page ASSERTS: that these people exist on the
      // prospect's own site, that nobody wears a colleague's face, and that a
      // page count in the email does not exceed what we actually indexed.
      try {
        const draft = JSON.parse(readFileSync(join(runDir, "landing", "brand-draft.json"), "utf8")) as LandingBrandDraft;
        const emailPath = join(runDir, "outreach", "email-draft.md");
        const email = existsSync(emailPath) ? readFileSync(emailPath, "utf8") : "";
        // Fetch the HOMEPAGE **AND** the team pages.
        //
        // The first version fetched only the homepage, and a team page is
        // exactly where a team is not. It reported eleven real, verified people
        // across acmeincubator and acmebio as "does not appear anywhere on the
        // prospect's own site" — a confident wrong answer produced by looking in
        // the wrong place, which is the failure this check exists to catch.
        // acmeincubator.org/ has 0 mentions of its own people; /people/ has 8.
        let siteText = "";
        if (manifest.sources?.[0]?.url) {
          const origin = new URL(manifest.sources[0].url).origin;
          const host = new URL(manifest.sources[0].url).hostname;
          // ALL of them, concurrently. A `.slice(0, 8)` here cut the list at
          // index 7 and acmebio keeps its team on /leadership — the LAST
          // entry — so the check reported five real people as nonexistent for
          // the second time, having been fixed once already. Truncating a
          // search and then reporting "not found" is the same lie as not
          // looking at all.
          const pages = [origin, ...COMMON_PATHS.map((p) => origin + p)];
          const bodies = await Promise.all(
            pages.map((u) => safeGet(u, { sameSiteAs: host, timeoutMs: 10_000 }).catch(() => undefined)),
          );
          for (const r of bodies) {
            if (r?.body)
              siteText +=
                " " +
                r.body
                  .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
                  .replace(/<[^>]+>/g, " ");
          }
        }
        const claimDefects = checkClaims(
          {
            bios: (draft.bios ?? []).map((b) => ({ name: b.name, role: b.title, image: b.image })),
            claimedPages: claimedPageCount(email),
            indexedPages: await indexedFileCount(),
          },
          siteText,
        );
        for (const d of claimDefects) log(`outreach: claims ${d.severity} — ${d.what}`);
        const blockingClaims = claimDefects.filter((d) => d.severity === "blocking");
        if (blockingClaims.length)
          log(`outreach: ⛔ ${blockingClaims.length} FALSE CLAIM(S) about the prospect — do not send`);
        if (claimDefects.length)
          preflight = `${preflight}\n\n### Claims about the prospect\n\n${claimDefects
            .map((d) => `- ${d.severity === "blocking" ? "⛔" : "⚠️"} ${d.what}`)
            .join("\n")}`;
      } catch (err) {
        log(`outreach: claims check could not run (${(err as Error).message.split("\n")[0]}) — claims are UNVERIFIED`);
      }

      if (shots.length) {
        preflight = `${preflight}\n\n### Look at it before you approve\n\n${shots.join("\n\n")}`;
        log(`outreach: attached ${shots.length} screenshot(s) to the Gate 3 task`);
      }
      const blocking = defects.filter((d) => d.severity === "blocking");
      for (const d of defects) log(`outreach: preflight ${d.severity} — ${d.what}`);
      if (blocking.length)
        log(`outreach: ⛔ ${blocking.length} BLOCKING defect(s) — this demo should not be sent as it stands`);
      else log(`outreach: preflight clean${defects.length ? ` (${defects.length} warning(s))` : ""}`);
    } catch (err) {
      // An unmeasured demo must not read as a measured one.
      preflight = `⚠️ Preflight could NOT run (${(err as Error).message.split("\n")[0]}) — this demo is UNVERIFIED.`;
      log(`outreach: ⚠ preflight failed — ${(err as Error).message.split("\n")[0]}`);
    }
  }

  const boardUp = await isAvailable();
  const projectId = boardUp ? await resolveProject() : undefined;

  if (!state.outreachTaskId) {
    if (!boardUp) {
      save();
      console.error(`\n⛔ OUTREACH — review board unreachable; start it and re-run.\n`);
      process.exit(EXIT_INFRA_DOWN);
    }
    const task = await createTask({
      title: `[Outreach] ${manifest.prospectName} — email + deck + research`,
      status: "TO_DO",
      description: [
        `## Outreach assets for ${manifest.prospectName} (run ${manifest.run})`,
        "",
        // First, before the checklists. A blocking defect listed under "Still
        // manual" is a defect nobody reads.
        ...(preflight ? [preflight, ""] : []),
        `Demo is approved (Gate 2, QA ${state.qaScore != null ? (state.qaScore * 100).toFixed(0) + "%" : "n/a"}). Draft the outreach package into \`runs/${prospect}/${runId}/outreach/\`:`,
        "",
        "### Drafts to REVIEW (the pipeline wrote these — they are not approved)",
        `- \`runs/${prospect}/${runId}/outreach/research-expanded.md\``,
        `- \`runs/${prospect}/${runId}/outreach/email-draft.md\` — check the ONE specific detail it`,
        "  cites is real, and that the demo link block is present and correct.",
        `- \`runs/${prospect}/${runId}/outreach/deck-spec.md\` — slide-by-slide copy.`,
        "",
        "### Still manual",
        "- [ ] **Build the deck in Canva** from `deck-spec.md`, then paste the design link here.",
        "  NOT automated: the Canva MCP server reports \"needs authentication\", so nothing in",
        "  the pipeline can reach it. Authenticate Canva to close this gap.",
        `- [ ] **Send it.** Nothing is sent automatically. Anchor social proof: ${manifest.anchorCustomer}.`,
        "",
        "### Demo link — send THIS",
        // injectDemoLink() (above) set state.demoLink to the branded landing
        // worker (state.landingUrl) when the landing stage deployed one, else
        // the bare embed fallback. Surface it explicitly so the task — and the
        // human reviewing it — never reaches for the raw embed URL by mistake.
        state.landingUrl
          ? `- **${state.landingUrl}** ← the customer's deployed Cloudflare Worker (Divinci SDK release implementation). This is the demo link; do NOT send the bare embed.`
          : `- ${state.demoLink ?? (state.releaseId ? demoLink(state.releaseId) : "n/a")} (bare embed — no branded landing worker was deployed for this run)`,
        `- Expires ${state.demoExpiresAt ?? `(stamped to approval + ${DEMO_EXPIRY_DAYS}d when the outreach gate is approved)`}`,
        ...(state.landingBasicAuthPassword
          ? [`- 🔒 Preview password (send WITH the link) — username \`${state.landingBasicAuthUser}\`, password \`${state.landingBasicAuthPassword}\``]
          : []),
        "",
        "### Context",
        `- Workspace \`${state.workspaceId}\` · release \`${state.releaseId ?? "?"}\` · QA report: ${state.qaSuiteId ? qaSuiteReportUrl(state.workspaceId!, state.qaSuiteId) : "n/a"}`,
        `- Compliance: ${manifest.complianceTier} — ${manifest.complianceNotes}`,
        "",
        "### Lifecycle",
        "Move to **IN_REVIEW** when assets are drafted; a human marks **DONE** to approve",
        "sending (the pipeline never sends automatically), **CANCELED** to abort outreach.",
      ].join("\n"),
      projectId,
      priority: "high",
      tags: ["outreach", "gate3", manifest.prospect],
    });
    state.outreachTaskId = task.id;
    save();
    log(`outreach: created review-board task ${task.id}`);
  }

  // Refresh the preflight onto an EXISTING task.
  //
  // The description is written once, at creation. acmeincubator's Gate 3 task predates
  // the preflight entirely, so without this a re-run measures the demo, logs
  // the result, and leaves the task — the thing a human actually reads — saying
  // nothing about it. Fenced so a re-run replaces the block instead of stacking
  // copies. Best-effort: a failed refresh must not stall the gate.
  if (preflight && state.outreachTaskId) {
    try {
      const existing = await getTask(state.outreachTaskId);
      const body = existing.description ?? "";
      const fenced = `${PREFLIGHT_MARK}\n${preflight}\n${PREFLIGHT_END}`;
      const re = new RegExp(`${PREFLIGHT_MARK}[\\s\\S]*?${PREFLIGHT_END}`);
      const next = re.test(body) ? body.replace(re, fenced) : `${fenced}\n\n${body}`;
      if (next !== body) {
        await updateTask(state.outreachTaskId, { description: next });
        log("outreach: posted preflight to the Gate 3 task");
      }
    } catch (err) {
      log(`outreach: ⚠ could not post preflight to the task — ${(err as Error).message.split("\n")[0]}`);
    }
  }

  // Put the email itself ON the card.
  //
  // Safe to read here: the draft is written by draftOutreachAssets() and then
  // completed by injectDemoLink() (line ~2241), both well above this point, so
  // what we embed is the finished copy WITH the demo link — not a draft still
  // carrying the `[demo link · expires …]` placeholder.
  //
  // Best-effort, like the preflight block above: a card that fails to gain its
  // draft is a card with a file path in it, which is where we started. It must
  // never stall the gate.
  if (state.outreachTaskId) {
    try {
      const draftPath = join(runDir, "outreach", "email-draft.md");
      const draft = existsSync(draftPath) ? readFileSync(draftPath, "utf8").trim() : "";
      if (!draft) {
        // Not an error — some runs reach Gate 3 without a draft, and saying so
        // is better than a card that silently looks complete.
        log("outreach: no email-draft.md to embed — the card links the path only");
      } else {
        const existing = await getTask(state.outreachTaskId);
        const body = existing.description ?? "";
        const fenced =
          `${DRAFT_MARK}\n\n### ✉️ The draft (from \`runs/${prospect}/${runId}/outreach/email-draft.md\`)\n\n` +
          `_Copy, review, send by hand. Nothing here is sent automatically, and nothing in\n` +
          `this pipeline can send._\n\n${draft}\n\n${DRAFT_END}`;
        const re = new RegExp(`${DRAFT_MARK}[\\s\\S]*?${DRAFT_END}`);
        const next = re.test(body) ? body.replace(re, fenced) : `${body.trimEnd()}\n\n---\n\n${fenced}`;
        if (next !== body) {
          await updateTask(state.outreachTaskId, { description: next });
          log(`outreach: embedded the email draft on the Gate 3 task (${draft.length} chars)`);
        }
      }
    } catch (err) {
      log(`outreach: ⚠ could not embed the draft — ${(err as Error).message.split("\n")[0]}`);
    }
  }

  await pollGate({
    taskId: state.outreachTaskId,
    gateName: "OUTREACH (GATE 3)",
    hint: "Draft assets on the task (Claude/agent), review them, then mark DONE to approve sending.",
    onApproved: (task) => {
      state.outreachApprovedBy = "review-board";
      // Authoritative expiry: DEMO_EXPIRY_DAYS from APPROVAL (≈ send), not
      // draft time.
      // The teardown job (npm run teardown) deprecates the demo on this date.
      state.demoExpiresAt = new Date(Date.now() + DEMO_EXPIRY_DAYS * 86_400_000)
        .toISOString()
        .slice(0, 10);
      log(`outreach approved via review-board task ${task.id} — demo expires ${state.demoExpiresAt}; send via Attio/Gmail manually`);
    },
    onRejected: (task) => {
      log(`outreach CANCELED via review-board task ${task.id}`);
      console.error("\n❌ Outreach aborted.");
      process.exit(1);
    },
  });
}

/**
 * Derive the public demo link from the published release and inject it into
 * email-draft.md, replacing the `[demo link · expires …]` placeholder.
 * Idempotent: re-running updates the same marked block, never duplicates.
 *
 * NOTE: the 14-day expiry is PROMISED text only — nothing tears the demo down
 * yet — demo expiry/teardown automation is not built.
 */
async function injectDemoLink(outreachDir: string): Promise<void> {
  if (!state.releaseId) return log("outreach: no releaseId — skipping demo-link injection");

  const readiness = await releaseDemoReadiness(state.releaseId).catch((e) => ({
    ready: false,
    reason: (e as Error).message,
  }));
  // Record the verdict in the run log, not only in the email body. Unattended
  // runs are read through state.json; a warning that exists solely inside a
  // markdown draft nobody opens is not a warning.
  log(
    readiness.ready
      ? `outreach: demo link is send-ready (public bootstrap OK)`
      : `outreach: ⚠ demo NOT send-ready — ${readiness.reason}`,
  );
  // Prefer the branded landing worker (the SDK-release implementation) deployed
  // in the landing stage; fall back to the bare hosted embed when there's none.
  const link = state.landingUrl ?? demoLink(state.releaseId);
  state.demoLink = link;
  if (state.landingUrl) log(`outreach: using branded landing worker as demo link (${link})`);

  // Expiry date = today + DEMO_EXPIRY_DAYS (UTC date only). new Date() is fine
  // here — this is the orchestrator main process, not a workflow sandbox.
  const expires = new Date(Date.now() + DEMO_EXPIRY_DAYS * 86_400_000).toISOString().slice(0, 10);
  state.demoExpiresAt = expires;
  save();

  const emailPath = join(outreachDir, "email-draft.md");
  if (!existsSync(emailPath)) {
    log(`outreach: no email-draft.md yet — demo link derived (${link}) but not injected`);
    return;
  }

  const block = demoLinkBlock({
    link,
    expires,
    readiness,
    // The demo is preview-gated until Gate 3, so without these the email ships
    // a link that answers 401.
    auth: state.landingBasicAuthPassword
      ? { username: state.landingBasicAuthUser ?? "preview", password: state.landingBasicAuthPassword }
      : undefined,
  });

  let email = readFileSync(emailPath, "utf8");
  const re = /<!-- demo-link:start[\s\S]*?<!-- demo-link:end -->/;
  if (re.test(email)) {
    email = email.replace(re, block);
  } else {
    // Replace the human placeholder on first run; else append before the sign-off.
    const placeholder = /\[demo link[^\]]*\]/;
    email = placeholder.test(email) ? email.replace(placeholder, block) : `${email.trimEnd()}\n\n${block}\n`;
  }
  writeFileSync(emailPath, email);
  log(`outreach: injected demo link (${link}, expires ${expires})${readiness.ready ? "" : ` — ⚠ ${readiness.reason}`}`);

  // Check the FINAL artifact, not the prompt's output: injection is what makes
  // the link openable, so this can only be judged after it.
  for (const p of emailLinkProblems(email, { password: state.landingBasicAuthPassword }))
    log(`outreach: ⚠ email draft — ${p}`);
}

// ---------------------------------------------------------------- gate polling

interface PollGateOpts {
  taskId: string;
  gateName: string;
  hint: string;
  /** Batch/unattended: run onApproved immediately without a review-board task. */
  autoApprove?: boolean;
  onApproved: (task: Awaited<ReturnType<typeof getTask>>) => void | Promise<void>;
  onRejected: (task: Awaited<ReturnType<typeof getTask>>) => void | Promise<void>;
}

async function pollGate(opts: PollGateOpts): Promise<void> {
  const { taskId, gateName, hint, onApproved, onRejected } = opts;

  if (opts.autoApprove) {
    log(`${gateName}: auto-approved (batch / --demo-approved-by)`);
    await onApproved({ id: "batch-auto", status: "DONE" } as Awaited<ReturnType<typeof getTask>>);
    return;
  }

  const check = async (): Promise<"approved" | "rejected" | "pending"> => {
    const task = await getTask(taskId);
    if (task.status === "DONE") { await onApproved(task); return "approved"; }
    if (task.status === "CANCELED") { await onRejected(task); return "rejected"; }
    return "pending";
  };

  const result = await check();
  if (result !== "pending") return;

  if (!watchMode) {
    save();
    console.log([
      "",
      `⛔ ${gateName} — awaiting review on the review board (task ${taskId}).`,
      `   ${hint}`,
      `   Re-run this command after approving, or use --watch to poll automatically.`,
      "",
    ].join("\n"));
    process.exit(EXIT_GATE_PARKED);
  }

  // --watch: poll until a decision is made
  console.log(`\n⏳ ${gateName} — watching review-board task ${taskId} (every ${watchInterval / 1000}s)…`);
  while (true) {
    await sleep(watchInterval);
    const r = await check();
    if (r !== "pending") return;
    console.log(`   [${new Date().toLocaleTimeString()}] still IN_REVIEW…`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------- util

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1] ?? "";
  }
  return out;
}

function latestRun(slug: string): string {
  fail(`--run <id> is required (no run auto-discovery yet) for prospect ${slug}`);
}

function save(): void {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
}

function log(msg: string): void {
  state.log.push({ at: new Date().toISOString(), msg });
  console.log(msg);
}

function summarize(raw: string): string {
  const line = raw.split("\n").find((l) => l.trim()) ?? "";
  return line.length > 160 ? line.slice(0, 160) + "…" : line;
}

/**
 * The team as recorded in brand-draft.json, in card order.
 *
 * Returns undefined (not []) when unreadable, so the copy prompt simply omits
 * the team block rather than telling the generator there is nobody.
 */
function readDraftBios(path: string): Array<{ name: string; title: string }> | undefined {
  try {
    const d = JSON.parse(readFileSync(path, "utf8")) as LandingBrandDraft;
    return d.bios?.length ? d.bios.map((b) => ({ name: b.name, title: b.title })) : undefined;
  } catch {
    return undefined;
  }
}

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}
