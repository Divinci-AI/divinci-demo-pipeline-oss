/**
 * Add a website to the Agentic Recon crawl queue.
 *
 * ── Where this sits ─────────────────────────────────────────────────────────
 * This is the MACHINE-FACING queue door, not a public one. The public front
 * door is `POST /api/v1/www-rag/submit-url` in the monorepo, which already
 * carries the things a public write surface needs and which we should not
 * reimplement here: an authenticated Divinci user, a per-user rate limit, the
 * shared domain denylist, DNS-resolves-public checks, and query-string/
 * fragment stripping (those carry tokens and PII).
 *
 * Two copies of a denylist drift, and the copy that drifts is the one that
 * matters. So: public callers go through the monorepo, which calls this. This
 * endpoint's job is the part only the worker can do — owning the R2 frontier —
 * plus the refusals only the worker knows about.
 *
 * ⚠️ Authenticated with SUBMIT_TOKEN, deliberately NOT TRIGGER_TOKEN. The
 * trigger token can `/run` arbitrary hosts, read the rights ledger and drive
 * `/tick`; this one can only ever put a host in a queue. A leaked submit token
 * should cost us a crawl, not the pipeline.
 *
 * ── Refusals this layer owns ────────────────────────────────────────────────
 *   - already published (the directory is authoritative, and FAILS CLOSED)
 *   - already queued or in flight (idempotent, not an error)
 *   - tombstoned as ai-reserved or withdrawn — the revolving-door guard
 *   - cached robots refusal
 *   - junk/implausible hosts
 *   - frontier full
 *
 * ⚠️ The rights check reads the CACHE ONLY and never fetches robots.txt.
 * Fetching per submission would turn this endpoint into a request amplifier
 * (submit 1,000 hosts, we fetch 1,000 sites). It does not weaken the guarantee:
 * the authoritative gate re-checks robots LIVE immediately before every crawl,
 * so an uncached host is queued and then refused there if it refuses. A cached
 * refusal is answered instantly and honestly instead.
 */

import { PENDING, DONE, INFLIGHT, isPlausibleHost, isJunkHost } from "./frontier.js";

/** Hosts that must never enter the queue regardless of who submits them.
 *  The Workers runtime already refuses private ranges; this is defence in
 *  depth and, more usefully, an immediate honest answer instead of a crawl
 *  that fails opaquely twenty minutes later. */
function isNonPublicHost(host) {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".internal") || host.endsWith(".local") || host.endsWith(".home.arpa")) return true;
  // Bare IPv4 literal — including the cloud metadata address.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  // IPv6 literal (URL parsing leaves the brackets on).
  if (host.startsWith("[") || host.includes(":")) return true;
  return false;
}

/**
 * Normalise a submitted URL or bare host down to a crawlable hostname.
 *
 * Returns { host } or { error }. Deliberately strict: this decides what we go
 * and fetch, so anything ambiguous is refused rather than guessed at.
 */
export function normalizeSubmission(raw) {
  if (typeof raw !== "string" || !raw.trim()) return { error: "url or host is required" };
  const value = raw.trim();

  let u;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return { error: "not a parseable URL" };
  }

  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { error: `unsupported scheme "${u.protocol.replace(":", "")}" — only http and https` };
  }
  // Credentials in a submitted URL are either an accident or an attempt to
  // have us replay someone's secret at a third party. Never carry them.
  if (u.username || u.password) return { error: "credentials in URL are not accepted" };

  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return { error: "no hostname" };
  if (isNonPublicHost(host)) return { error: "host is not publicly routable" };
  if (!isPlausibleHost(host)) return { error: "not a plausible public hostname" };
  if (isJunkHost(host)) return { error: "host is on the junk list (shortener, share endpoint, or ad infrastructure)" };

  // NOTE: the path, query string and fragment are discarded here by design.
  // The crawler is host-scoped, and query strings carry session tokens and
  // PII that must not reach our logs or the frontier.
  return { host };
}

/**
 * Decide what to do with one already-normalised host.
 *
 * Pure over its `checks` input so every refusal path is testable without R2.
 */
export function submissionVerdict({ host, published, tombstone, rights, queued, inflight, frontierFull }) {
  if (frontierFull) {
    return { host, status: "refused", reason: "frontier is full — try again later", retryable: true };
  }
  if (published) return { host, status: "already-published" };
  if (inflight) return { host, status: "already-crawling" };
  if (queued) return { host, status: "already-queued" };

  // The revolving door: a host we withdrew, or that refused us, must not be
  // re-queued by anyone — including an honest submitter who does not know.
  if (tombstone && /ai-reserved|withdrawn/i.test(String(tombstone.reason ?? ""))) {
    return {
      host, status: "refused",
      reason: "this site's robots.txt reserves AI use — we do not crawl it",
      retryable: false,
    };
  }
  if (rights?.reserved) {
    return {
      host, status: "refused",
      reason: "this site's robots.txt reserves AI use — we do not crawl it",
      retryable: false,
    };
  }
  if (tombstone) {
    return { host, status: "refused", reason: `previously retired: ${tombstone.reason ?? "unknown"}`, retryable: false };
  }
  return { host, status: "queued" };
}

/**
 * Full submission: normalise, gather state, decide, and enqueue when accepted.
 *
 * ⚠️ FAILS CLOSED on an unreadable directory. With no directory every host
 * looks new, so a fail-open would let submissions re-queue the entire
 * published corpus as duplicates — the same reasoning as `fetchPublishedHosts`,
 * and the reason that helper returns ok:false rather than an empty set.
 */
export async function submitHost(env, { raw, submittedBy, source, publishedHosts, maxPending, pendingCount }) {
  const norm = normalizeSubmission(raw);
  if (norm.error) return { input: raw, status: "invalid", reason: norm.error };
  const { host } = norm;

  const [doneObj, queuedObj, inflightObj, rightsObj] = await Promise.all([
    env.BUCKET.get(DONE + host),
    env.BUCKET.head(PENDING + host),
    env.BUCKET.head(INFLIGHT + host),
    env.BUCKET.get(`rights/${host}.json`),
  ]);

  const tombstone = doneObj ? await doneObj.json().catch(() => ({})) : null;
  const rights = rightsObj ? await rightsObj.json().catch(() => null) : null;

  // ⚠️ The count comes from the CRON TICK (state/pending-count.json), not from
  // a list() here. Counting at request time was wrong in BOTH directions:
  // list() caps at 1000 keys, so with ~2,900 pending the page is always
  // `truncated`, and the old `truncated ? maxPending <= 1000 : ...` made a cap
  // above 1000 unable to fire at all while a cap at or below 1000 fired on
  // every request. It also ran once PER HOST, so a 20-host batch did 20 list
  // calls to compute nothing.
  //
  // Unknown fails OPEN. A missing counter means "cannot tell", and refusing
  // every submission because a bookkeeping object is absent would be the same
  // class of outage as the index guard and the verification flock that were
  // both removed for exactly that.
  const frontierFull = maxPending > 0
    && typeof pendingCount === "number"
    && pendingCount >= maxPending;

  const verdict = submissionVerdict({
    host,
    published: publishedHosts.has(host),
    tombstone,
    rights,
    queued: Boolean(queuedObj),
    inflight: Boolean(inflightObj),
    frontierFull,
  });

  if (verdict.status === "queued") {
    await env.BUCKET.put(PENDING + host, JSON.stringify({
      reason: "submitted",
      // Retained so an abusive submitter can be identified and so a bad batch
      // can be traced back. An opaque id from the caller — never an email.
      submittedBy: typeof submittedBy === "string" ? submittedBy.slice(0, 128) : undefined,
      source: typeof source === "string" ? source.slice(0, 32) : undefined,
      at: Date.now(),
    }));
  }
  return verdict;
}
