/**
 * www-rag.ts — feed a demo crawl's pages into the global WWW RAG corpus.
 *
 * After the demo pipeline crawls a prospect's site into its OWN (staging) RAG
 * vector, this submits the SAME crawled page URLs to the WWW RAG contribute
 * endpoint (POST /api/v1/www-rag/submit-url) so the host also lands in the
 * global web index the Divinci browser extension queries — i.e. it becomes one
 * of the AutoRag "groups": a per-site vector, auto-routed when the host is
 * registered in the WwwRagSite registry (otherwise indexed into the WWW RAG
 * project's default vector(s)).
 *
 * Cross-env by design: the demo workspace lives on STAGING, but the WWW RAG
 * corpus the extension queries is PRODUCTION. So this talks to a SEPARATE base
 * (WWW_RAG_API_BASE, default https://api.divinci.app) with its OWN bearer
 * (WWW_RAG_TOKEN) — independent of the staging `divinci` CLI profile the rest
 * of the run uses. Enumerating the crawled URLs (the demo/staging side) is the
 * caller's job; this module only does the prod submit.
 *
 * submit-url is the single-page contribute path: it RE-SCRAPES each URL on the
 * prod side (it does NOT copy chunks from the staging vector). It is rate
 * limited (10 submissions / user / minute) and OAuth-only (api-key/anon
 * sessions are rejected), so we pace submissions and require a bearer token.
 *
 * Best-effort: every failure is logged and swallowed — a www-rag hiccup must
 * never fail a demo run (mirrors the orchestrator's source-tracking posture).
 */
import { existsSync, readFileSync } from "node:fs";

export interface WwwRagSubmitResult {
  submitted: string[];
  skippedAlready: string[];
  denied: { url: string; reason: string }[];
  failed: { url: string; reason: string }[];
}

export interface WwwRagSubmitOptions {
  /** URLs already submitted in a prior (resumed) run — skipped for idempotency. */
  alreadySubmitted?: string[];
  /** Don't actually POST — just log the plan (honours the run's DRY_RUN). */
  dryRun?: boolean;
  /** Progress logger (the orchestrator's `log`). */
  log?: (msg: string) => void;
}

/**
 * ON by default — contributing to the WWW-RAG corpus is part of what a demo run
 * IS, not an extra.
 *
 * It shipped opt-in behind `WWW_RAG_SUBMIT=1`, and that variable was never set
 * anywhere: not in orchestrator/.env, not in the LaunchAgent, not in any run.
 * All 58 runs to date logged `WWW_RAG_SUBMIT not set — skipping global-corpus
 * submit` and contributed nothing, so 51 of the 83 hosts this pipeline crawled
 * were missing from divinci.ai/www-rag entirely. An opt-in nobody opts into is
 * a feature that does not exist, and the skip line was quiet enough that it
 * took a direct question to notice.
 *
 * Disable per-run with `WWW_RAG_SUBMIT=0`.
 */
export function wwwRagEnabled(): boolean {
  const v = process.env.WWW_RAG_SUBMIT;
  return v !== "0" && v !== "false";
}

/**
 * The prod OAuth bearer, falling back to the `divinci` CLI's own credential.
 *
 * submit-url is OAuth-only — api-key and anon sessions are rejected — so this
 * needs a real user token. Requiring it as a hand-set env var was the second
 * half of why this never ran: even with WWW_RAG_SUBMIT flipped on, the step
 * would skip again on a missing token.
 *
 * The CLI already holds a prod OAuth session in ~/.config/divinci/credentials.json
 * (the same one every other step in this pipeline authenticates with), so read
 * it from there rather than inventing a second credential to provision and
 * rotate. Env still wins, for CI or a different identity.
 *
 * ⚠️ Only the `default`/`prod` profile is used, and only when it points at the
 * PROD api. The WWW-RAG corpus is production; submitting a staging token would
 * fail confusingly rather than silently, but there is no reason to try.
 */
export function resolveWwwRagToken(): string | undefined {
  const fromEnv = process.env.WWW_RAG_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    const path = `${process.env.HOME}/.config/divinci/credentials.json`;
    if (!existsSync(path)) return undefined;
    const creds = JSON.parse(readFileSync(path, "utf8")) as {
      profiles?: Record<string, { accessToken?: string; apiUrl?: string; expiresAt?: string }>;
    };
    for (const name of ["default", "prod"]) {
      const p = creds.profiles?.[name];
      if (!p?.accessToken) continue;
      if (p.apiUrl && !p.apiUrl.includes("api.divinci.app")) continue;
      // An expired token would produce a wall of 401s, one per URL, and read as
      // "the corpus rejected us" rather than "log in again".
      if (p.expiresAt && Date.parse(p.expiresAt) < Date.now()) continue;
      return p.accessToken;
    }
  } catch {
    /* unreadable credentials — fall through to undefined */
  }
  return undefined;
}

const DEFAULT_BASE = "https://api.divinci.app";

/**
 * The server limit is 10 submissions / user / 60s. Pace at one per 7s
 * (~8.5/min) to stay comfortably under it, and still honour any 429
 * Retry-After the server hands back.
 */
const MIN_INTERVAL_MS = 7_000;

/**
 * Backoff for a 423 (another crawl holds the lock), longest-tail first.
 *
 * Deliberately longer than MIN_INTERVAL_MS. That interval is paced against the
 * documented rate LIMIT (10/min); the 423 evidence says the lock outlives it —
 * per-run failure was bimodal at 0-4% or 31-52% and the sequence
 * near-alternated, consistent with each submission hitting the previous one's
 * still-running crawl. Two retries at 15s then 45s covers a crawl an order of
 * magnitude slower than the pacing without stalling a 120-URL run.
 */
const LOCK_BACKOFF_MS = [15_000, 45_000];

type SubmitOutcome = "queued" | "already-fresh" | "denied" | "rate-limited" | "locked";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type SubmitStatus = SubmitOutcome | string;
interface SubmitResponseBody {
  url?: string;
  accepted?: boolean;
  status?: SubmitStatus;
  reason?: string;
  crawlId?: string;
}

/**
 * Submit a list of fully-qualified page URLs to the WWW RAG contribute endpoint.
 * Returns a per-URL breakdown; never throws (best-effort).
 */
export async function submitUrlsToWwwRag(
  urls: string[],
  opts: WwwRagSubmitOptions = {},
): Promise<WwwRagSubmitResult> {
  const log = opts.log ?? (() => {});
  const result: WwwRagSubmitResult = { submitted: [], skippedAlready: [], denied: [], failed: [] };

  const already = new Set(opts.alreadySubmitted ?? []);
  // Dedupe + drop already-submitted up front.
  const queue = [...new Set(urls)].filter((u) => {
    if (already.has(u)) {
      result.skippedAlready.push(u);
      return false;
    }
    return true;
  });

  if (queue.length === 0) {
    log(`www-rag: nothing to submit (${result.skippedAlready.length} already submitted)`);
    return result;
  }

  const base = (process.env.WWW_RAG_API_BASE ?? DEFAULT_BASE).replace(/\/+$/, "");
  const token = resolveWwwRagToken();

  if (opts.dryRun) {
    log(`www-rag: [dry-run] would submit ${queue.length} URL(s) to ${base}/api/v1/www-rag/submit-url`);
    for (const u of queue) log(`www-rag: [dry-run]   → ${u}`);
    result.submitted.push(...queue);
    return result;
  }

  if (!token) {
    log(
      "www-rag: no prod OAuth token — skipping global-corpus submit. " +
        "Tried WWW_RAG_TOKEN, then the divinci CLI's prod profile. Run `divinci auth login` " +
        "or set WWW_RAG_TOKEN (submit-url rejects api-key/anon).",
    );
    return result;
  }

  const endpoint = `${base}/api/v1/www-rag/submit-url`;
  log(`www-rag: submitting ${queue.length} page URL(s) to ${endpoint} (paced ~${Math.round(60000 / MIN_INTERVAL_MS)}/min)`);

  for (let i = 0; i < queue.length; i++) {
    const url = queue[i]!;
    if (i > 0) await sleep(MIN_INTERVAL_MS);

    try {
      const body = await postSubmit(endpoint, token, url);
      switch (body.status) {
        case "queued":
          result.submitted.push(url);
          log(`www-rag: queued ${url}${body.crawlId ? ` (crawl ${body.crawlId})` : ""}`);
          break;
        case "already-fresh":
          // Already in the corpus and fresh — count as submitted (idempotent goal met).
          result.submitted.push(url);
          log(`www-rag: already-fresh ${url}`);
          break;
        case "locked": {
          // Back off past a typical crawl and retry twice. Deliberately longer
          // than MIN_INTERVAL_MS: the pacing interval is tuned to the rate
          // LIMIT (10/min), and the evidence says the lock outlives it.
          let done = false;
          for (const wait of LOCK_BACKOFF_MS) {
            log(`www-rag: locked — waiting ${Math.round(wait / 1000)}s then retrying ${url}`);
            await sleep(wait);
            const retry = await postSubmit(endpoint, token, url);
            if (retry.status === "queued" || retry.status === "already-fresh") {
              result.submitted.push(url);
              log(`www-rag: queued (after lock retry) ${url}`);
              done = true;
              break;
            }
            if (retry.status !== "locked") {
              result.failed.push({ url, reason: retry.reason ?? retry.status ?? "unknown" });
              done = true;
              break;
            }
          }
          if (!done) {
            // Still locked after every retry. Record it as failed so the
            // tally stays honest — `wwwrag:backfill` picks these up.
            result.failed.push({ url, reason: "document is locked (after retries)" });
            log(`www-rag: STILL LOCKED after ${LOCK_BACKOFF_MS.length} retries ${url}`);
          }
          break;
        }
        case "rate-limited": {
          // Shouldn't hit at our pace, but honour Retry-After and retry once.
          const wait = parseRetryAfter(body.reason) ?? 30_000;
          log(`www-rag: rate-limited — waiting ${Math.round(wait / 1000)}s then retrying ${url}`);
          await sleep(wait);
          const retry = await postSubmit(endpoint, token, url);
          if (retry.status === "queued" || retry.status === "already-fresh") {
            result.submitted.push(url);
            log(`www-rag: queued (after retry) ${url}`);
          } else {
            result.failed.push({ url, reason: retry.reason ?? retry.status ?? "unknown" });
            log(`www-rag: FAILED (after retry) ${url}: ${retry.reason ?? retry.status}`);
          }
          break;
        }
        case "denied":
          result.denied.push({ url, reason: body.reason ?? "denied" });
          log(`www-rag: denied ${url}: ${body.reason ?? "denied"}`);
          break;
        default:
          result.failed.push({ url, reason: body.reason ?? body.status ?? "unknown" });
          log(`www-rag: unexpected status for ${url}: ${body.status ?? "?"} ${body.reason ?? ""}`);
      }
    } catch (err) {
      result.failed.push({ url, reason: (err as Error).message.split("\n")[0] });
      log(`www-rag: error submitting ${url}: ${(err as Error).message.split("\n")[0]}`);
    }
  }

  log(
    `www-rag: done — ${result.submitted.length} submitted, ${result.skippedAlready.length} already, ` +
      `${result.denied.length} denied, ${result.failed.length} failed`,
  );
  return result;
}

async function postSubmit(endpoint: string, token: string, url: string): Promise<SubmitResponseBody> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: token.startsWith("Bearer ") ? token : `Bearer ${token}`,
    },
    body: JSON.stringify({ url, reason: "divinci-demo-pipeline crawl" }),
  });

  // 429 may come back before the JSON body is read — surface Retry-After.
  if (res.status === 429) {
    const ra = res.headers.get("retry-after");
    return { url, accepted: false, status: "rate-limited", reason: ra ? `Retry in ${ra}s.` : "rate-limited" };
  }

  // 423 is TRANSIENT — another crawl holds the lock. Treated as a hard failure
  // until 2026-08-14, which cost 190 of 679 submissions (28%) across all runs:
  // the URL was dropped and only `wwwrag:backfill` ever recovered it, so the
  // global corpus was complete only if someone remembered to run the backfill.
  //
  // Per-run rates are BIMODAL — 0-4% or 31-52%, nothing between — and the
  // sequence near-alternates (Q F Q F F Q F …), which looks like each
  // submission colliding with the previous one's still-running crawl rather
  // than random contention. The mechanism is not established, and this retry
  // does not depend on it.
  if (res.status === 423) {
    return { url, accepted: false, status: "locked", reason: "document is locked" };
  }

  // Safe JSON parse (text + JSON.parse) per repo convention — submit-url can
  // return an HTML error page on a 5xx/proxy hiccup.
  const text = await res.text();
  let parsed: SubmitResponseBody;
  try {
    parsed = JSON.parse(text) as SubmitResponseBody;
  } catch {
    throw new Error(`non-JSON response (status ${res.status}): ${text.slice(0, 200)}`);
  }

  // An auth/middleware error comes back as { error: { code, message } }.
  if (res.status >= 400 && !parsed.status) {
    const e = (parsed as unknown as { error?: { message?: string } }).error;
    throw new Error(`HTTP ${res.status}: ${e?.message ?? text.slice(0, 200)}`);
  }
  return parsed;
}

function parseRetryAfter(reason?: string): number | null {
  if (!reason) return null;
  const m = reason.match(/(\d+)\s*s/);
  return m ? parseInt(m[1]!, 10) * 1000 : null;
}
