/**
 * furniture-backfill-cli.ts — run the JSON-LD furniture repair against one or
 * more demo corpora.
 *
 *   npx tsx src/furniture-backfill-cli.ts --list          # what needs it, and how big
 *   npx tsx src/furniture-backfill-cli.ts ansirsd         # repair one
 *   npx tsx src/furniture-backfill-cli.ts --all           # repair every one on the list
 *
 * Reads workspace/vector ids from each prospect's newest run state, and the
 * prod token from the CLI's own session (see resolveWwwRagToken) so there is
 * no second credential to provision.
 *
 * ⚠️ This kicks off SERVER-SIDE work and returns before it finishes. The
 * endpoint answers `{"success":true,"status":"started"}` whether or not it
 * re-fetches a single page, so this prints the chunk count before and tells
 * you to re-audit — it deliberately does NOT claim success on the reply.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { resolveWwwRagToken } from "./www-rag.js";
import {
  extractPageUrls,
  rescrapeRequest,
  rescrapePath,
  MAX_URLS_PER_REQUEST,
  type BackfillTarget,
  type RagFileDoc,
} from "./furniture-backfill.js";

const API = process.env.DIVINCI_API_URL ?? "https://api.divinci.app";
const RUNS = join(process.cwd(), "..", "runs");
const LIST = join(process.cwd(), "..", "research", "metrics", "recrawl-list.txt");

/** The newest run's state for a prospect — where the ids live. */
export function readTarget(prospect: string, runsDir = RUNS): BackfillTarget | undefined {
  const dir = join(runsDir, prospect);
  if (!existsSync(dir)) return undefined;
  const runs = readdirSync(dir).filter((d)=>(existsSync(join(dir, d, "state.json")))).sort();
  const latest = runs.at(-1);
  if (!latest) return undefined;
  const s = JSON.parse(readFileSync(join(dir, latest, "state.json"), "utf8")) as {
    workspaceId?: string; vectorId?: string;
  };
  if (!s.workspaceId || !s.vectorId) return undefined;
  return { prospect, whitelabelId: s.workspaceId, vectorId: s.vectorId };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Every call retries, because the machine's own network is the weak link.
 *
 * ⚠️ On 2026-08-16 a run lost DNS mid-flight and NINE consecutive corpora
 * failed with a bare `fetch failed` — Node surfaces a DNS failure that way, so
 * it is indistinguishable from an API error unless you look. The host was on
 * an iPhone hotspot (172.20.10.x); the API was healthy throughout.
 *
 * The retry is at the TRANSPORT, not around a batch: the outage killed the
 * FIRST call of each prospect (listFiles), before any batch loop existed to
 * protect it. Retrying only batches — which an earlier fix did — would not
 * have saved a single one of the nine.
 *
 * Backoff runs to ~2 minutes total, which is long enough to ride out a hotspot
 * blip and short enough that a genuinely dead network still fails the run
 * rather than hanging it.
 */
async function api(path: string, token: string, method = "GET", body?: unknown, attempts = 5) {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      const r = await fetch(API + path, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await r.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`Non-JSON response from ${path} (status ${r.status}): ${text.slice(0, 200)}`);
      }
      return { status: r.status, body: parsed as Record<string, unknown> };
    } catch (e) {
      lastErr = e;
      if (i === attempts) break;
      const wait = Math.min(30_000, 2_000 * 2 ** (i - 1));
      console.warn(`   … network retry ${i}/${attempts - 1} in ${wait / 1000}s (${e instanceof Error ? e.message : String(e)})`);
      await sleep(wait);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * ⚠️ `/rag-vector/files` takes NO pagination — it is one aggregation with a
 * hard `$limit: 2000` server-side, and `?page=`/`?limit=` are ignored (page 2
 * returns page 1). A corpus at the ceiling is therefore silently truncated,
 * which would look like a completed backfill that quietly skipped pages, so
 * say so loudly rather than returning a short list.
 */
const FILES_SERVER_LIMIT = 2000;

async function listFiles(t: BackfillTarget, token: string): Promise<RagFileDoc[]> {
  const { body } = await api(`/white-label/${t.whitelabelId}/rag-vector/files`, token);
  const docs = (Array.isArray(body) ? body : []) as RagFileDoc[];
  if (docs.length >= FILES_SERVER_LIMIT) {
    console.warn(`⚠️  ${t.prospect}: ${docs.length} docs hits the server's ${FILES_SERVER_LIMIT} ceiling — the list is TRUNCATED and this backfill will miss pages`);
  }
  return docs;
}

async function chunkTotal(t: BackfillTarget, token: string): Promise<number | undefined> {
  const { body } = await api(
    `/white-label/${t.whitelabelId}/rag-vector/${t.vectorId}/all-chunks?offset=0&length=1`, token,
  );
  return typeof body.total === "number" ? body.total : undefined;
}

/**
 * How many URLs to send per bulk-rescrape call.
 *
 * ⚠️ NOT the server's 2000-URL cap. A single 394-page call STALLED at 200/394
 * on 2026-08-15 — `0 failed`, no error, no further log line, and the endpoint
 * had already returned `{"success":true,"status":"started"}` twenty minutes
 * earlier. Root cause was never established (CPU throttling and the request
 * timeout were both ruled out); the leading candidate is the instance being
 * reclaimed, since the work outlives its own HTTP response.
 *
 * Seven 60-URL calls completed where one 394 did not. Batching does not fix
 * the cause — it bounds the loss to one batch, makes truncation VISIBLE
 * (the chunk count stops growing), and retries cheaply, because re-rescraping
 * a page is idempotent.
 */
export const BATCH = 60;

/** Junk WordPress paths — archives and plugin custom post types, not content. */
const JUNK_PATH = /\/(tag|category|author|op_global_element|op_typography_preset|elementor-hf|op_pop_ups|feed|wp-json)(\/|$)/;

export function dropJunkPaths(urls: string[]): string[] {
  return urls.filter((u) => !JUNK_PATH.test(u));
}

/**
 * Wait for a batch's chunks to land, by watching the corpus grow AND THEN
 * STOP.
 *
 * ⚠️ Returning on the FIRST sign of growth is not enough, and the first
 * version of this did exactly that. Chunks arrive gradually, so the very first
 * poll saw `9833 → 9841` — eight chunks out of a 60-page batch — declared the
 * batch done and submitted the next one. Nine batches would have been fired in
 * a few minutes, which is the same concurrent load as the single 394-page call
 * that stalled, i.e. the pacing that made batching work would have been
 * silently removed while the log still read as orderly progress.
 *
 * So: wait for growth to begin, then for it to stop for `quietPolls`
 * consecutive checks. Returns the settled total.
 */
async function waitForBatch(
  t: BackfillTarget,
  token: string,
  from: number,
  { pollMs = 30_000, quietPolls = 3, timeoutMs = 15 * 60_000 } = {},
): Promise<{ total: number; grew: boolean }> {
  const deadline = Date.now() + timeoutMs;
  let last = from;
  let quiet = 0;
  let grew = false;

  while (Date.now() < deadline) {
    await sleep(pollMs);
    const now = await chunkTotal(t, token);
    if (now === undefined) continue;
    if (now > last) {
      grew = true;
      quiet = 0;
      last = now;
      continue;
    }
    // Only start counting quiet polls once something has actually arrived —
    // otherwise a slow start reads as a finished batch.
    if (grew && ++quiet >= quietPolls) return { total: last, grew };
  }
  return { total: last, grew };
}

export async function backfillOne(t: BackfillTarget, token: string): Promise<boolean> {
  const files = await listFiles(t, token);
  const urls = dropJunkPaths(extractPageUrls(files));

  if (urls.length === 0) {
    // Not an error, but never silent: a corpus with no web pages cannot be
    // repaired this way and needs a different route.
    console.warn(`⏭️  ${t.prospect}: no web pages among ${files.length} docs — bulk-rescrape cannot help here`);
    return false;
  }

  let chunks = (await chunkTotal(t, token)) ?? 0;
  console.warn(`🔄 ${t.prospect}: ${urls.length} URLs, ${chunks} chunks before`);
  let ok = true;

  for (let i = 0; i < urls.length; i += BATCH) {
    const batch = urls.slice(i, i + BATCH);

    // A transient network error must cost ONE BATCH, not the rest of the
    // corpus. hughston-clinic died on batch 3 of 9 with a bare `fetch failed`
    // — token still valid, API healthy a moment later — and the remaining 380
    // URLs went unrepaired because the throw escaped to the per-prospect
    // catch. Retry the batch, then skip it and keep going.
    let status = 0;
    let body: Record<string, unknown> = {};
    let sent = false;
    for (let attempt = 1; attempt <= 3 && !sent; attempt++) {
      try {
        ({ status, body } = await api(
          rescrapePath(t.whitelabelId), token, "POST", rescrapeRequest(t.vectorId, batch),
        ));
        sent = true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`   … ${t.prospect} batch ${i}: ${msg} (attempt ${attempt}/3)`);
        if (attempt === 3) { ok = false; break; }
        await sleep(15_000 * attempt);
      }
    }
    if (!sent) continue;
    if (status !== 200) {
      console.error(`   ✖ ${t.prospect} batch ${i}: HTTP ${status} ${JSON.stringify(body).slice(0, 160)}`);
      ok = false;
      continue;
    }
    const { total: after, grew } = await waitForBatch(t, token, chunks);
    if (!grew) {
      // The corpus did not move at all. Say so — this is the silent-stall shape.
      console.error(`   ⚠️  ${t.prospect} batch ${i}..${i + batch.length}: chunk count STILL ${chunks} — did not land`);
      ok = false;
    } else {
      console.warn(`   ${t.prospect} batch ${i}..${i + batch.length} (${batch.length}) → ${chunks} → ${after} chunks (settled)`);
    }
    chunks = after;
  }
  return ok;
}

async function main() {
  const args = process.argv.slice(2);
  const prospects = existsSync(LIST) ? readFileSync(LIST, "utf8").split(/\s+/).filter(Boolean) : [];
  const token = resolveWwwRagToken();

  if (args.includes("--list")) {
    for (const p of prospects) {
      const t = readTarget(p);
      console.warn(t ? `${p.padEnd(30)} wl=${t.whitelabelId} vec=${t.vectorId}` : `${p.padEnd(30)} NO RUN STATE`);
    }
    return;
  }

  if (!token) {
    console.error("❌ no prod token — run `divinci auth login` (or set WWW_RAG_TOKEN)");
    process.exitCode = 1;
    return;
  }

  const wanted = args.includes("--all") ? prospects : args.filter((a)=>(!a.startsWith("--")));
  if (wanted.length === 0) {
    console.error("usage: furniture-backfill-cli.ts [--list] [--all] [<prospect>...]");
    process.exitCode = 1;
    return;
  }

  // --skip lets a resumed run leave already-repaired corpora alone. Rescraping
  // is idempotent, so re-running one is harmless — just slow.
  const skip = new Set(
    args.filter((a)=>(a.startsWith("--skip="))).flatMap((a)=>(a.slice(7).split(","))).filter(Boolean),
  );
  const results: Array<[string, string]> = [];

  for (const p of wanted) {
    if (skip.has(p)) {
      results.push([p, "skipped"]);
      continue;
    }
    const t = readTarget(p);
    if (!t) {
      console.error(`❌ ${p}: no run state with workspaceId+vectorId`);
      results.push([p, "NO STATE"]);
      process.exitCode = 1;
      continue;
    }
    try {
      results.push([p, (await backfillOne(t, token)) ? "ok" : "INCOMPLETE"]);
    } catch (e) {
      console.error(`❌ ${p}: ${e instanceof Error ? e.message : String(e)}`);
      results.push([p, "ERROR"]);
      process.exitCode = 1;
    }
  }

  // A summary that names what did NOT finish. A run that only prints progress
  // leaves you re-reading a 200-line log to find the one batch that stalled.
  console.warn("\n=== SUMMARY");
  for (const [p, r] of results) console.warn(`  ${p.padEnd(32)} ${r}`);
  const bad = results.filter(([, r])=>(r !== "ok" && r !== "skipped"));
  if (bad.length) {
    console.warn(`\n⚠️  ${bad.length} did not complete — re-run them; rescraping is idempotent.`);
    console.warn(`   npx tsx src/furniture-backfill-cli.ts ${bad.map(([p])=>(p)).join(" ")}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
