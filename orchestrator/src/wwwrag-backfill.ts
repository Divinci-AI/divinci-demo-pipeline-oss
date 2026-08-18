/**
 * Backfill the WWW-RAG corpus with the pages this pipeline actually crawled.
 *
 * Why this exists: `WWW_RAG_SUBMIT` was never set, anywhere. All 58 runs to
 * date logged `wwwrag: WWW_RAG_SUBMIT not set — skipping global-corpus submit`
 * and contributed nothing, so of 83 hosts this pipeline has crawled, 51 are
 * absent from https://divinci.ai/www-rag/. The 32 that ARE present got there
 * via the WWW-RAG router's own crawling, not from us.
 *
 *   npm run wwwrag:backfill -- --dry-run          # plan only, no writes
 *   npm run wwwrag:backfill                        # submit
 *   npm run wwwrag:backfill -- --per-host 50       # deeper per site
 *   npm run wwwrag:backfill -- --host aiaa.org     # one host
 *
 * Source of URLs is the RAG file listing of each run's own workspace — i.e.
 * exactly the pages we indexed. Deliberately NOT each site's sitemap: that
 * would submit pages we chose not to crawl, which is a different and larger
 * claim than "publish what we already have".
 *
 * ⚠️ This writes to the PUBLIC directory. Every submitted host becomes visible
 * at divinci.ai/www-rag under its own name. Authorised 2026-08-12 for the
 * already-scraped set; it is not a licence to submit arbitrary hosts.
 *
 * Rate limit is 10 submissions / user / minute, server-side, and submit-url is
 * OAuth-only. We pace at 7s and honour any Retry-After.
 *
 * RESUMABLE. Every accepted URL is appended to state.json immediately, so an
 * interrupted run resumes instead of resubmitting — which matters when the
 * full sweep is hours long and the harness may kill a background task.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const orchestratorDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(orchestratorDir, "..");
const runsDir = join(repoRoot, "runs");
const STATE = join(runsDir, ".wwwrag-backfill.json");

const API = process.env.WWW_RAG_API_BASE ?? "https://api.divinci.app";
const MIN_INTERVAL_MS = Number(process.env.WWW_RAG_INTERVAL_MS ?? 7_000);

interface State {
  submitted: string[];
  failed: Record<string, string>;
  startedAt?: string;
}

function loadState(): State {
  if (!existsSync(STATE)) return { submitted: [], failed: {} };
  try {
    return JSON.parse(readFileSync(STATE, "utf8")) as State;
  } catch {
    return { submitted: [], failed: {} };
  }
}

function saveState(s: State): void {
  mkdirSync(dirname(STATE), { recursive: true });
  writeFileSync(STATE, JSON.stringify(s, null, 2) + "\n");
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** URLs this pipeline indexed, per run workspace, via the divinci CLI. */
async function indexedUrls(workspaceId: string, profile?: string): Promise<string[]> {
  const args = ["rag", "files", "--workspace", workspaceId, "--json", "--no-color"];
  if (profile) args.push("--profile", profile);
  const { stdout } = await execFileP("divinci", args, { maxBuffer: 64 * 1024 * 1024 });
  const start = stdout.indexOf("[");
  if (start < 0) return [];
  let files: Array<{ title?: string }>;
  try {
    files = JSON.parse(stdout.slice(start)) as Array<{ title?: string }>;
  } catch {
    return [];
  }
  const urls: string[] = [];
  for (const f of files) {
    // Titles are stamped `URL: https://… <date>` by the crawl.
    const m = /URL:\s*(\S+)/.exec(f.title ?? "");
    if (m) urls.push(m[1]);
  }
  return urls;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function submit(url: string, token: string): Promise<{ ok: boolean; reason?: string; retryAfterMs?: number }> {
  const res = await fetch(`${API}/api/v1/www-rag/submit-url`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (res.status === 429) {
    const ra = Number(res.headers.get("retry-after") ?? 0);
    return { ok: false, reason: "rate-limited", retryAfterMs: (ra > 0 ? ra : 30) * 1000 };
  }
  // 423 = "Already crawling this host". BUSY, not broken — the same signal
  // run-policy.ts's isHostAlreadyCrawling() exists for. Recording it as a
  // failure was wrong: submit-url re-scrapes on the prod side, so submitting
  // several URLs of one host back to back races the crawl the previous one
  // started. First run: 7 of 8 attempts died this way. The real fix is the
  // ROUND-ROBIN ordering below, which puts every other host between two
  // requests to the same one; this branch is the backstop.
  if (res.status === 423) return { ok: false, reason: "host-busy", retryAfterMs: 60_000 };
  // Never `res.json()` bare — a proxy error page throws a raw SyntaxError and
  // loses the status that would explain it.
  const text = await res.text();
  if (!res.ok) return { ok: false, reason: `${res.status}: ${text.slice(0, 120)}` };
  try {
    const body = JSON.parse(text) as { accepted?: boolean; status?: string };
    // `already-fresh` means the page is IN the corpus and current — the goal of
    // this backfill, met by someone else. The server returns accepted:false for
    // it, so a bare `accepted !== false` records a success as a failure: 18 of
    // the first 21 "failures" were this, concentrated on thorne.com,
    // drlongevityrx.com and aurapathai.com, which the crawler fleet had already
    // covered. www-rag.ts has always counted it as submitted; this now agrees.
    if (body.status === "already-fresh") return { ok: true, reason: "already-fresh" };
    return { ok: body.accepted !== false, reason: body.status };
  } catch {
    return { ok: false, reason: `unparseable 200: ${text.slice(0, 120)}` };
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const perHost = Number(argv[argv.indexOf("--per-host") + 1]) || 25;
  const onlyHost = argv.indexOf("--host") >= 0 ? argv[argv.indexOf("--host") + 1] : undefined;

  const token = process.env.WWW_RAG_TOKEN;
  if (!token && !dryRun) throw new Error("WWW_RAG_TOKEN required (prod OAuth bearer; api-key/anon are rejected)");

  // Which hosts the directory already has — never resubmit those.
  const dirRes = await fetch(`${API}/api/v1/www-rag-directory?limit=1000`);
  const dirBody = (await dirRes.json()) as { sites?: Array<Record<string, unknown>> };
  const present = new Set(
    (dirBody.sites ?? []).map((s) => String(s.host ?? s.domain ?? "").toLowerCase().replace(/^www\./, "")),
  );
  console.log(`directory holds ${present.size} host(s)`);

  // Every prod run's workspace. Staging runs are skipped: their workspaces do
  // not exist on the prod side the CLI is authenticated against, so listing
  // them returns nothing and would look like an empty crawl.
  const { readdirSync } = await import("node:fs");
  const targets: Array<{ prospect: string; run: string; workspaceId: string }> = [];
  for (const prospect of readdirSync(runsDir)) {
    let runs: string[];
    try {
      runs = readdirSync(join(runsDir, prospect));
    } catch {
      continue;
    }
    for (const run of runs) {
      const p = join(runsDir, prospect, run, "state.json");
      if (!existsSync(p)) continue;
      try {
        const s = JSON.parse(readFileSync(p, "utf8")) as { workspaceId?: string; apiBase?: string };
        if (!s.workspaceId) continue;
        if (s.apiBase && !s.apiBase.includes("api.divinci.app")) continue;
        targets.push({ prospect, run, workspaceId: s.workspaceId });
      } catch {
        /* unreadable state — skip */
      }
    }
  }
  console.log(`${targets.length} prod run(s) with a workspace`);

  const state = loadState();
  state.startedAt ??= new Date().toISOString();
  const already = new Set(state.submitted);

  // Collect, grouped by host, capped per host.
  const byHost = new Map<string, string[]>();
  for (const t of targets) {
    let urls: string[] = [];
    try {
      urls = await indexedUrls(t.workspaceId);
    } catch (e) {
      console.log(`  ${t.prospect}: could not list files — ${(e as Error).message.slice(0, 80)}`);
      continue;
    }
    for (const u of urls) {
      const h = hostOf(u);
      if (!h) continue;
      if (onlyHost && h !== onlyHost.toLowerCase().replace(/^www\./, "")) continue;
      // Skip hosts the directory already covers — EXCEPT for URLs we recorded
      // as failed. Without that exception a retry pass is a silent no-op: after
      // the first pass every host is present, so the failures get filtered out
      // by HOST before their URLs are ever considered. That is exactly what
      // happened on 2026-08-12 — the sweep planned 25 URLs across 1 host and
      // never looked at the three outstanding failures, while reporting "done".
      if (present.has(h) && !state.failed[u]) continue;
      if (already.has(u)) continue;
      const list = byHost.get(h) ?? [];
      if (list.length >= perHost) continue;
      list.push(u);
      byHost.set(h, list);
    }
  }

  const hosts = [...byHost.keys()].sort();
  const total = [...byHost.values()].reduce((n, l) => n + l.length, 0);
  const mins = Math.round((total * MIN_INTERVAL_MS) / 60_000);
  console.log(`\nplan: ${total} URL(s) across ${hosts.length} host(s), ≤${perHost}/host — ~${mins} min at ${MIN_INTERVAL_MS / 1000}s pacing`);
  for (const h of hosts) console.log(`  ${String(byHost.get(h)!.length).padStart(3)}  ${h}`);
  if (dryRun) return console.log("\n[dry-run] nothing submitted.");
  if (total === 0) return console.log("nothing to do.");

  // ROUND-ROBIN across hosts, not host-by-host.
  //
  // submit-url re-scrapes server-side, so two consecutive submissions for one
  // host race each other and the second gets 423 "Already crawling this host".
  // Draining a host's 25 URLs in a row therefore fails ~24 of them. Interleaving
  // puts (hosts-1) × 7s — over four minutes at this fleet size — between any two
  // requests to the same host, which is longer than a single-page crawl takes.
  const queue: string[] = [];
  for (let i = 0; ; i++) {
    let added = false;
    for (const h of hosts) {
      const list = byHost.get(h)!;
      if (i < list.length) {
        queue.push(list[i]);
        added = true;
      }
    }
    if (!added) break;
  }

  let done = 0;
  const hostsSeen = new Set<string>();
  for (const url of queue) {
    let r = await submit(url, token!);
    if (!r.ok && (r.reason === "rate-limited" || r.reason === "host-busy")) {
      console.log(`  ⏳ ${r.reason} — waiting ${(r.retryAfterMs ?? 30000) / 1000}s (${hostOf(url)})`);
      await sleep(r.retryAfterMs ?? 30_000);
      r = await submit(url, token!);
    }
    if (r.ok) {
      state.submitted.push(url);
      delete state.failed[url];
      done++;
      const h = hostOf(url);
      if (!hostsSeen.has(h)) {
        hostsSeen.add(h);
        console.log(`  ✅ first page accepted for ${h}`);
      }
    } else {
      state.failed[url] = r.reason ?? "unknown";
    }
    saveState(state); // after EVERY url — an interrupted sweep must resume
    if (done > 0 && done % 25 === 0) console.log(`  … ${done}/${total} submitted`);
    await sleep(MIN_INTERVAL_MS);
  }

  // Report THIS run, then the carried-over backlog, separately.
  //
  // The previous version printed `Object.keys(state.failed).length` as "failed",
  // which mixed three different things: URLs this run genuinely failed, URLs a
  // PRIOR run failed and this one never attempted, and `already-fresh` — which
  // is a SUCCESS (the page is in the corpus and current). On 2026-08-12 that
  // read "done — 25 submitted, 33 failed" when the true state was 30 successes
  // recorded wrongly and 3 never retried. A count that conflates "succeeded
  // differently" with "never tried" is worse than no count.
  const attempted = queue.length;
  const failedNow = attempted - done;
  const carried = Object.entries(state.failed).filter(([u]) => !queue.includes(u));
  console.log(`\ndone — attempted ${attempted}, submitted ${done}, failed ${failedNow}`);
  if (failedNow > 0) {
    for (const [u, why] of Object.entries(state.failed).filter(([u]) => queue.includes(u)).slice(0, 10)) {
      console.log(`  ✗ ${u} — ${why}`);
    }
  }
  if (carried.length > 0) {
    console.log(`\n${carried.length} URL(s) carried from earlier runs and NOT attempted this pass:`);
    for (const [u, why] of carried.slice(0, 10)) console.log(`  … ${u} — ${why}`);
    console.log("  (re-run to retry them; they are excluded from the counts above)");
  }
  if (failedNow === 0 && carried.length === 0) console.log("nothing outstanding.");
}

if (process.argv[1] && process.argv[1].endsWith("wwwrag-backfill.ts")) {
  await main();
}
