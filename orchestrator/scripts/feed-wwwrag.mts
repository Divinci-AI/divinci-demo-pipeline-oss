#!/usr/bin/env -S npx tsx
/**
 * feed-wwwrag.mts — retroactively feed a finished demo run's crawled pages into
 * the global WWW RAG corpus (the "AutoRag groups" the Divinci extension queries).
 *
 * Why a standalone script (vs the orchestrator's `wwwrag` step): the 3 demo runs
 * already completed PAST that step (they halted at the outreach gate). Re-running
 * the orchestrator would re-execute hygiene→landing (and redeploy the landing
 * worker). This script just does the submit, idempotently, for an existing run.
 *
 * It enumerates each host's INDEXED page URLs (`rag files` — robust across
 * scrapers, unlike crawl-history scrapedPaths which FireCrawl leaves empty) and
 * POSTs each to /api/v1/www-rag/submit-url using the ACTIVE `divinci` OAuth
 * session (submit-url rejects api-key/anon, and OAuth is what the demo run used —
 * so no separate token is needed when the corpus is the SAME env the CLI points
 * at). Paced under the 10/min submit rate-limit; idempotent via a per-run
 * .wwwrag-submitted.json.
 *
 * ⚠️  HARD SAFETY GATE — pollution risk before the fix is deployed:
 * submit-url only routes a host into its OWN per-site vector once the
 * `ensureWwwRagSiteVector` fix (server commit c40bad5170) is DEPLOYED to the
 * target env. On the OLD code an UNREGISTERED host fans every page into ALL
 * project vectors → corrupts the existing ~20 groups. So a live run requires
 * --confirm-fix-deployed (asserting you verified the target env runs the fix).
 *
 * USAGE
 *   # safe preview (no writes):
 *   npx tsx scripts/feed-wwwrag.mts --run 2026-06-29-001 --dry-run
 *
 *   # live (only after confirming staging/prod runs server commit c40bad5170):
 *   npx tsx scripts/feed-wwwrag.mts --run 2026-06-29-001 --confirm-fix-deployed
 *
 *   # one prospect, capped:
 *   npx tsx scripts/feed-wwwrag.mts --run 2026-06-29-001 --prospect acmemarket --limit 25 --confirm-fix-deployed
 *
 * The corpus env = whatever `divinci auth status` points at (the active profile).
 * To target a DIFFERENT env than the active CLI profile, this script is the wrong
 * tool — use the orchestrator `wwwrag` step with WWW_RAG_API_BASE + WWW_RAG_TOKEN.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

const argv = process.argv.slice(2);
const flag = (k: string): string | undefined => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const has = (k: string): boolean => argv.includes(k);

const RUN = flag("--run");
const ONLY_PROSPECT = flag("--prospect");
const LIMIT = flag("--limit") ? parseInt(flag("--limit")!, 10) : Infinity;
const DRY = has("--dry-run");
const CONFIRMED = has("--confirm-fix-deployed");
const DEFAULT_PROSPECTS = ["acmelaunch", "acmeparts", "acmemarket"];

const MIN_INTERVAL_MS = 7_000; // ~8.5/min, under the server's 10/min submit cap
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (!RUN) { console.error("❌ --run <id> is required (e.g. --run 2026-06-29-001)"); process.exit(1); }
if (!DRY && !CONFIRMED) {
  console.error(
    "❌ Refusing to submit live without --confirm-fix-deployed.\n" +
    "   submit-url pollutes the existing WWW-RAG groups UNLESS the target env runs\n" +
    "   server commit c40bad5170 (ensureWwwRagSiteVector). Verify the deploy, then\n" +
    "   pass --confirm-fix-deployed. Or run with --dry-run to preview.",
  );
  process.exit(1);
}

// OAuth-only env (submit-url rejects api keys).
const OAUTH_ENV = { ...process.env };
delete OAUTH_ENV.DIVINCI_API_KEY;

function activeApiUrl(): string {
  try {
    const out = execFileSync("divinci", ["auth", "status", "--no-color"], { env: OAUTH_ENV, encoding: "utf8" });
    return out.match(/API URL:\s*(\S+)/)?.[1] ?? "(unknown)";
  } catch { return "(unknown)"; }
}

/** Indexed page URLs for a workspace (title carries the URL). Same-host filter optional. */
function indexedUrls(workspaceId: string, host?: string): string[] {
  const out = new Set<string>();
  const stdout = execFileSync(
    "divinci",
    ["rag", "files", "--limit", "500", "--json", "--no-color", "--workspace", workspaceId],
    { timeout: 90_000, maxBuffer: 32 * 1024 * 1024, env: OAUTH_ENV, encoding: "utf8" },
  );
  const start = stdout.indexOf("[");
  if (start < 0) return [];
  const files = JSON.parse(stdout.slice(start)) as Array<Record<string, unknown>>;
  for (const f of files) {
    for (const field of [f.title, f.originalFilename, f.originalName]) {
      if (typeof field !== "string") continue;
      const m = field.match(/https?:\/\/[^\s"']+/);
      if (!m) continue;
      const u = m[0].replace(/[#?].*$/, "").replace(/\/+$/, "");
      if (/\/cdn-cgi\//.test(u)) continue; // Cloudflare infra/email-obfuscation junk
      if (host) { try { if (new URL(u).host !== host) continue; } catch { continue; } }
      out.add(u);
    }
  }
  return [...out];
}

interface SubmitBody { url?: string; accepted?: boolean; status?: string; reason?: string; crawlId?: string }

// Cross-env submit target: when set, submission goes via raw fetch to a SEPARATE
// env+token than the one used for enumeration (e.g. enumerate the demo's pages
// from the STAGING workspace via the active `divinci` CLI session, but submit to
// PROD WWW-RAG). Mirrors orchestrator/src/www-rag.ts's design. WWW_RAG_TOKEN must
// be a prod OAuth bearer — submit-url rejects api-key/anon sessions.
const CROSS_ENV_BASE = process.env.WWW_RAG_API_BASE;
const CROSS_ENV_TOKEN = process.env.WWW_RAG_TOKEN;

async function submit(url: string): Promise<SubmitBody> {
  if (CROSS_ENV_BASE && CROSS_ENV_TOKEN) {
    const res = await fetch(`${CROSS_ENV_BASE.replace(/\/+$/, "")}/api/v1/www-rag/submit-url`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: CROSS_ENV_TOKEN.startsWith("Bearer ") ? CROSS_ENV_TOKEN : `Bearer ${CROSS_ENV_TOKEN}`,
      },
      body: JSON.stringify({ url, reason: "divinci-demo-pipeline crawl" }),
    });
    if (res.status === 429) {
      const ra = res.headers.get("retry-after");
      return { url, accepted: false, status: "rate-limited", reason: ra ? `Retry in ${ra}s.` : "rate-limited" };
    }
    const text = await res.text();
    let parsed: SubmitBody;
    try { parsed = JSON.parse(text) as SubmitBody; } catch { throw new Error(`non-JSON response (status ${res.status}): ${text.slice(0, 200)}`); }
    if (res.status >= 400 && !parsed.status) {
      const e = (parsed as unknown as { error?: { message?: string } }).error;
      throw new Error(`HTTP ${res.status}: ${e?.message ?? text.slice(0, 200)}`);
    }
    return parsed;
  }

  const { stdout } = await execFileP(
    "divinci",
    ["api", "POST", "/api/v1/www-rag/submit-url", "--body", JSON.stringify({ url, reason: "divinci-demo-pipeline crawl" }), "--no-color"],
    { timeout: 120_000, maxBuffer: 16 * 1024 * 1024, env: OAUTH_ENV },
  );
  const s = stdout.indexOf("{");
  if (s < 0) throw new Error(`non-JSON response: ${stdout.slice(0, 200)}`);
  return JSON.parse(stdout.slice(s)) as SubmitBody;
}

const prospects = ONLY_PROSPECT ? [ONLY_PROSPECT] : DEFAULT_PROSPECTS;
const submitTarget = CROSS_ENV_BASE && CROSS_ENV_TOKEN ? CROSS_ENV_BASE : activeApiUrl();
console.log(
  `WWW-RAG feed — run ${RUN} | enumerate from: ${activeApiUrl()} | submit to: ${submitTarget} | ` +
    `${DRY ? "DRY-RUN" : "LIVE"} | prospects: ${prospects.join(", ")}`,
);

for (const p of prospects) {
  const runDir = join(repoRoot, "runs", p, RUN);
  const statePath = join(runDir, "state.json");
  if (!existsSync(statePath)) { console.log(`\n[${p}] no state.json — skipping`); continue; }
  const state = JSON.parse(readFileSync(statePath, "utf8")) as { workspaceId?: string; sources?: unknown };
  const manifest = JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8")) as { sources: { url: string; destination: string; type?: string }[] };
  if (!state.workspaceId) { console.log(`\n[${p}] no workspaceId — skipping`); continue; }

  const hosts = manifest.sources
    .filter((s) => s.destination === "rag" && s.type !== "video")
    .map((s) => { try { return new URL(s.url).host; } catch { return null; } })
    .filter((h): h is string => !!h);

  let urls: string[] = [];
  for (const h of hosts) urls.push(...indexedUrls(state.workspaceId, h));
  urls = [...new Set(urls)];
  if (Number.isFinite(LIMIT)) urls = urls.slice(0, LIMIT);

  // Ledger is per SUBMIT TARGET, not just per run — staging and prod feeds must
  // track independently (a host submitted to staging is NOT yet submitted to prod).
  const targetSlug = submitTarget.replace(/^https?:\/\//, "").replace(/[^a-z0-9.-]/gi, "_");
  const ledgerPath = join(runDir, `.wwwrag-submitted.${targetSlug}.json`);
  const ledger: string[] = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, "utf8")) : [];
  const done = new Set(ledger);
  const todo = urls.filter((u) => !done.has(u));

  console.log(`\n[${p}] ${urls.length} indexed URL(s) for ${hosts.join(", ")} — ${todo.length} new, ${urls.length - todo.length} already submitted`);
  if (DRY) { todo.slice(0, 8).forEach((u) => console.log(`   [dry] → ${u}`)); if (todo.length > 8) console.log(`   …and ${todo.length - 8} more`); continue; }

  for (let i = 0; i < todo.length; i++) {
    const url = todo[i]!;
    if (i > 0) await sleep(MIN_INTERVAL_MS);
    try {
      const body = await submit(url);
      if (body.status === "queued" || body.status === "already-fresh") {
        done.add(url); ledger.push(url); writeFileSync(ledgerPath, JSON.stringify([...done], null, 2) + "\n");
        console.log(`   ✓ ${body.status} ${url}${body.crawlId ? ` (${body.crawlId})` : ""}`);
      } else if (body.status === "rate-limited") {
        const wait = (parseInt(body.reason?.match(/(\d+)\s*s/)?.[1] ?? "30", 10)) * 1000;
        console.log(`   … rate-limited, waiting ${wait / 1000}s then retrying ${url}`);
        await sleep(wait);
        const retry = await submit(url);
        if (retry.status === "queued" || retry.status === "already-fresh") { done.add(url); ledger.push(url); writeFileSync(ledgerPath, JSON.stringify([...done], null, 2) + "\n"); console.log(`   ✓ ${retry.status} (retry) ${url}`); }
        else console.log(`   ✗ ${retry.status ?? "?"} ${url}: ${retry.reason ?? ""}`);
      } else {
        console.log(`   ✗ ${body.status ?? "?"} ${url}: ${body.reason ?? ""}`);
      }
    } catch (err) {
      console.log(`   ✗ error ${url}: ${(err as Error).message.split("\n")[0]}`);
    }
  }
  console.log(`[${p}] done — ${done.size} total submitted (ledger: ${ledgerPath})`);
}
console.log("\nWWW-RAG feed complete.");
