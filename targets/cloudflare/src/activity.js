/**
 * The optional public crawl-status feed.
 *
 * ── Why this lives in the WORKER ────────────────────────────────────────────
 * It used to be `scripts/report-activity.py`, launched as a background child of
 * `scripts/crawl-daemon.sh`. When the laptop daemon was retired the reporter
 * went with it, and the public page began saying **"Crawler offline"** while
 * the Cloudflare pipeline was healthy and publishing — 619 sites, most recent
 * 17 minutes earlier. A visitor to our marketing page was told our flagship
 * crawler was dead. It was not.
 *
 * The defect was structural, not a missing restart: **the thing reporting
 * liveness was a different process from the thing doing the work.** Any such
 * split has two failure modes that look identical from outside — the worker
 * died, or the reporter died — and only one of them matters. Co-locating them
 * collapses that ambiguity: if this code stops emitting, the crawler really has
 * stopped, because this code only runs inside the crawler's own cron tick.
 *
 * ── Why events are keys, not a rolling document ─────────────────────────────
 * The obvious design is one `activity/recent.json` that each publish appends
 * to. That is a read-modify-write from up to MAX_CONCURRENT (64) workflows at
 * once, so it loses updates by construction.
 *
 * Instead every publish writes ONE tiny immutable object whose KEY carries the
 * whole payload, and the reporter reconstructs everything from a single
 * `list()` with zero `get()` calls. No shared mutable state, so no race.
 *
 * ⚠️ R2 `list()` is EVENTUALLY CONSISTENT (this cost us duplicate crawls once
 * already). A publish from seconds ago may be missing from the next tick's
 * listing. For a 5-minutely status feed that is fine — it appears one tick
 * later — but never reuse this listing for a correctness decision.
 *
 * ── Honesty constraints ─────────────────────────────────────────────────────
 * The Cloudflare pipeline is CONTINUOUS. It has no "pass", so it never sends
 * `passStartedAt`: inventing one would be a fabricated fact on a public page.
 * The `*ThisPass` counters are sent as an explicit ROLLING 24-HOUR window,
 * which is the closest true statement for a crawler that never stops.
 */

export const EVENTS = "activity/events/";

/** Fields are positional; `host` is LAST so it can contain any character
 *  except "/" without the parse becoming ambiguous. */
const SEP = "__";

export function eventKey({ at, pages, chunks, host }) {
  return `${EVENTS}${at}${SEP}${Math.max(0, pages | 0)}${SEP}${Math.max(0, chunks | 0)}${SEP}${host}`;
}

export function parseEventKey(key) {
  if (!key.startsWith(EVENTS)) return null;
  const rest = key.slice(EVENTS.length);
  // limit 3 → the 4th field keeps any separator it contains.
  const i1 = rest.indexOf(SEP);
  const i2 = rest.indexOf(SEP, i1 + SEP.length);
  const i3 = rest.indexOf(SEP, i2 + SEP.length);
  if (i1 < 0 || i2 < 0 || i3 < 0) return null;
  const at = Number(rest.slice(0, i1));
  const pages = Number(rest.slice(i1 + SEP.length, i2));
  const chunks = Number(rest.slice(i2 + SEP.length, i3));
  const host = rest.slice(i3 + SEP.length);
  if (!Number.isFinite(at) || !Number.isFinite(pages) || !Number.isFinite(chunks) || !host) return null;
  return { at, pages, chunks, host };
}

/** Record a successful publish. Best-effort: a status feed must never be able
 *  to fail a publish that already succeeded. */
export async function recordPublish(bucket, { host, pages, chunks, at = Date.now() }) {
  try {
    await bucket.put(eventKey({ at, pages, chunks, host }), "");
    return true;
  } catch {
    return false;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Build the payload, or `null` when there is nothing truthful to say.
 *
 * Pure, so the mapping from a continuous crawler onto a feed designed for a
 * batch one can be tested without a network.
 */
export function buildSnapshot({ events, pending, done, inflight, now, maxRecent = 12, maxInFlight = 12 }) {
  // ⚠️ Bound the window on BOTH sides. `now - at <= DAY` alone admits any
  // future-dated event, and `pruneEvents` (which drops `now - at > retain`)
  // would never remove one — so a single clock-skewed or hand-written key
  // could inflate the public counters permanently. An hour of tolerance
  // absorbs real skew without giving that away.
  const FUTURE_TOLERANCE_MS = 60 * 60 * 1000;
  const recentWindow = events
    .filter((e) => e && Number.isFinite(e.at)
      && now - e.at <= DAY_MS
      && e.at - now <= FUTURE_TOLERANCE_MS)
    .sort((a, b) => b.at - a.at);

  // ⚠️ "crawling" is claimed from CLAIMS HELD, not from recent publishes. A
  // slow site can legitimately produce zero publishes for an hour while 40
  // crawls are in flight, and reporting that as idle is the same lie in the
  // opposite direction — it is what a directory-derived feed would get wrong.
  const state = inflight.length > 0 ? "crawling" : "idle";

  return {
    state,
    // Only claim sites are being fetched when we are actually crawling.
    inFlight: state === "crawling" ? inflight.slice(0, maxInFlight) : [],
    recent: recentWindow.slice(0, maxRecent).map((e) => ({
      host: e.host, pages: e.pages, chunks: e.chunks,
    })),
    // Rolling 24h, NOT a pass. `passStartedAt` is deliberately never sent.
    sitesThisPass: recentWindow.length,
    pagesThisPass: recentWindow.reduce((n, e) => n + e.pages, 0),
    chunksThisPass: recentWindow.reduce((n, e) => n + e.chunks, 0),
    seeds: pending,
    done,
  };
}

/**
 * Drop events older than the retention window.
 *
 * Runs in the cron tick, which is effectively single-writer — pruning from the
 * publish path instead would race 64 ways. Retention is deliberately longer
 * than the 24h reporting window so a late-listing event is never pruned before
 * it has been counted.
 */
export async function pruneEvents(bucket, now, retainMs = 2 * DAY_MS, cap = 2000) {
  let cursor, pruned = 0, scanned = 0;
  do {
    const page = await bucket.list({ prefix: EVENTS, cursor, limit: 1000 });
    for (const o of page.objects) {
      scanned++;
      const e = parseEventKey(o.key);
      if (!e || now - e.at > retainMs) {
        try { await bucket.delete(o.key); pruned++; } catch { /* next tick */ }
      }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor && scanned < cap);
  return { pruned, scanned };
}

export async function listEvents(bucket, cap = 2000) {
  const out = [];
  let cursor;
  do {
    const page = await bucket.list({ prefix: EVENTS, cursor, limit: 1000 });
    for (const o of page.objects) {
      const e = parseEventKey(o.key);
      if (e) out.push(e);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor && out.length < cap);
  return out;
}

/**
 * POST the snapshot.
 *
 * FAIL-OPEN, always. This is a status feed: no failure here may delay, block,
 * or fail a crawl. Returns a report rather than throwing, and that report is
 * surfaced in the /tick response — a reporter that silently stops is exactly
 * the bug this module exists to fix, so its own failure must be visible.
 */
export async function reportActivity(env, snapshot) {
  // ⚠️ NO DEFAULT. This URL used to fall back to the status feed of the
  // deployment this was extracted from — so an unconfigured fork POSTed its
  // crawl state at somebody else's public page. That is the precise failure
  // require-env.js exists to prevent: a wrong default fails loudly, a default
  // naming a real endpoint succeeds and reports to a stranger.
  //
  // Unset is a normal, complete configuration: most deployments have no public
  // status page, and reporting is skipped rather than being an error.
  const url = env.WWW_RAG_ACTIVITY_URL;
  if (!url) {
    return { ok: false, skipped: true, reason: "WWW_RAG_ACTIVITY_URL not set — no status feed configured" };
  }
  if (!env.WWW_RAG_ACTIVITY_TOKEN) {
    return { ok: false, reason: "WWW_RAG_ACTIVITY_TOKEN not set — the public page will read as offline" };
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.WWW_RAG_ACTIVITY_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "www-rag-pipeline/activity",
      },
      body: JSON.stringify(snapshot),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, detail: text.slice(0, 200) };
    return { ok: true, status: res.status, state: snapshot.state };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e).slice(0, 200) };
  }
}

/**
 * The pending-frontier size, written by the cron tick.
 *
 * ⚠️ Exists because counting it at request time is not possible cheaply and
 * the attempt was WRONG IN BOTH DIRECTIONS. `list()` caps at 1000 keys, so with
 * ~2,900 pending the result is always `truncated`, and the arithmetic
 * `truncated ? maxPending <= 1000 : ...` meant a cap above 1000 could NEVER
 * fire (inert) while a cap at or below 1000 fired ALWAYS (blocking every
 * submission). Neither is a backstop.
 *
 * The tick already lists the whole frontier every two minutes, so it can just
 * record the number. Staleness is bounded by the cron period, which is far
 * inside the tolerance of a growth guard.
 */
export const PENDING_COUNT_KEY = "state/pending-count.json";

export async function writePendingCount(bucket, count) {
  try {
    await bucket.put(PENDING_COUNT_KEY, JSON.stringify({ count, at: Date.now() }));
    return true;
  } catch { return false; }
}

/** Returns the count, or null when unknown. Callers must treat null as
 *  "cannot tell" and NOT as zero — see submit.js for why it fails open. */
export async function readPendingCount(bucket) {
  try {
    const o = await bucket.get(PENDING_COUNT_KEY);
    if (!o) return null;
    const rec = await o.json();
    return Number.isFinite(rec?.count) ? rec.count : null;
  } catch { return null; }
}
