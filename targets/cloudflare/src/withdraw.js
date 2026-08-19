/**
 * Withdraw a PUBLISHED site because its owner refuses our use.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The crawl-time rights gate protects hosts we have not crawled yet. It cannot
 * protect a host that ALLOWED AI use on the day we crawled it and refuses
 * today: that site is already published, and the gate never runs for it again.
 * On 2026-08-18 fifteen such sites were live, seven of them carrying
 * Cloudflare's Managed robots.txt block, which names
 * `CloudflareBrowserRenderingCrawler` — our exact crawler — with `Disallow: /`.
 *
 * ── Why every step is required ──────────────────────────────────────────────
 * A withdrawal that removes the directory card and stops there is not a
 * withdrawal. Both of these were read off the code, not assumed:
 *
 *   - `release-item.ts` rejects only `status === "draft"`. A DEPRECATED release
 *     STILL SERVES its chat page. So deprecating alone delists a site while it
 *     keeps answering questions from the content its owner refused us.
 *   - The directory governs DISCOVERY only. Anyone holding the release URL is
 *     unaffected by removing the card.
 *
 * The only step that actually ends the use is destroying the site's Turso
 * database, which holds every chunk of their text and its embeddings. The
 * others are real but secondary: they stop new visitors arriving.
 *
 * ⚠️ ORDER IS DELIBERATE. Destroying the database is IRREVERSIBLE, so it runs
 * LAST, after the two cheap reversible steps have already stopped the bleeding.
 * If an earlier step fails we have delisted a site whose content still exists
 * (recoverable). If we destroyed first and then failed, we would have a live
 * directory card pointing at a corpus that no longer exists.
 *
 * ⚠️ `withdrawn` is true ONLY when the corpus is actually gone. Reporting a
 * withdrawal that left the database serving is the specific failure this
 * module is written to prevent, so every step reports its own outcome and a
 * partial withdrawal stays visible instead of rounding up to success.
 */

import { destroyDatabase } from "./turso.js";
import { signPayload } from "./release.js";
import { DONE, PENDING, INFLIGHT } from "./frontier.js";
import { EVENTS, parseEventKey } from "./activity.js";

/**
 * ⚠️ Byte-identical to index.js's slugify, and it must stay that way: it
 * derives the Turso database NAME, so any divergence means we destroy the
 * wrong database — or, far more likely, none at all.
 *
 * The leading `.toLowerCase()` is load-bearing and is NOT in index.js's copy,
 * which lowercases only at the end. `^www\.` is case-sensitive, so
 * "WWW.SI.EDU" would slug to "www-si-edu" while the database is "wrp-si-edu".
 * The destroy would 404, and `destroyCorpus` treats 404 as success (correctly,
 * for idempotence) — so we would report `withdrawn: true` for a corpus that is
 * still serving the content its owner refused us. Normalising first makes that
 * combination unreachable. Frontier keys are already lowercase, so this only
 * ever hardens the caller-supplied path.
 */
export const slugify = (host) =>
  String(host).toLowerCase().replace(/^www\./, "").replace(/[^a-z0-9]+/gi, "-");

/** Remove the WwwRagSite record — what the public directory lists. */
export async function removeFromDirectory(env, host) {
  if (!env.WWW_RAG_THEME_WEBHOOK_SECRET) {
    return { ok: false, reason: "WWW_RAG_THEME_WEBHOOK_SECRET not set" };
  }
  const payload = JSON.stringify({ sites: [{ host, remove: true }] });
  const hex = await signPayload(env.WWW_RAG_THEME_WEBHOOK_SECRET, payload);
  const res = await fetch(`${env.DIVINCI_API_BASE}/api/v1/www-rag-webhook/register-sites`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-divinci-signature": `sha256=${hex}` },
    body: payload,
  });
  const text = await res.text();
  if (!res.ok) return { ok: false, reason: `${res.status}: ${text.slice(0, 200)}` };
  return { ok: true, detail: text.slice(0, 200) };
}

/**
 * Take the release out of service.
 *
 * Deprecate rather than delete: the release leaves every listing endpoint
 * while the record of what we published — and that we withdrew it — survives.
 * A hard delete would destroy the evidence that the refusal was honoured,
 * which is the one artifact worth keeping.
 */
export async function deprecateRelease(env, releaseId) {
  if (!releaseId) return { ok: true, skipped: "no release linked" };
  const res = await fetch(`${env.DIVINCI_API_BASE}/api/v1/releases/${releaseId}/deprecate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.DIVINCI_API_KEY}`, "Content-Type": "application/json" },
  });
  const text = await res.text();
  if (res.status === 404) {
    // ⚠️ DO NOT try to name the cause from the response body. An earlier
    // version guessed "route not deployed" whenever the body did not contain
    // the word "release", and on 2026-08-18 that produced a confidently wrong
    // diagnosis for all 12 releases in the first real withdrawal: the route
    // was deployed and returning 401 to an unauthenticated probe seconds
    // earlier. The actual cause was TENANCY — WWW-RAG sites were migrated to
    // per-site whitelabels, and deprecateRelease throws NOT_FOUND when the
    // release does not belong to the whitelabel the API key resolves to.
    // Both causes emit a bare {"code":"NOT_FOUND","message":"not found"}, so
    // the body cannot distinguish them and any heuristic over it will
    // eventually point at the wrong system.
    return {
      ok: false,
      status: 404,
      reason:
        "404 from the deprecate route. Most likely the release belongs to a " +
        "DIFFERENT whitelabel than this API key (per-site whitelabel migration) " +
        "— the ownership check returns NOT_FOUND. Verify with " +
        "GET /white-label-release/<id> and compare its `whitelabel` to WHITELABEL_ID. " +
        "A genuinely missing route is the other possibility and looks identical here.",
    };
  }
  if (!res.ok) return { ok: false, reason: `${res.status}: ${text.slice(0, 200)}` };
  return { ok: true };
}

/** The step that actually ends the use: every chunk and embedding, gone. */
export async function destroyCorpus(env, slug) {
  const name = `wrp-${slug}`;
  try {
    await destroyDatabase({ org: env.TURSO_ORG, token: env.TURSO_PLATFORM_TOKEN, name });
    return { ok: true, database: name };
  } catch (e) {
    const msg = String(e?.message ?? e);
    // Already gone is success. Withdrawal must be idempotent so a retry after a
    // partial run can finish the job rather than erroring out on step three.
    if (/404|not found/i.test(msg)) return { ok: true, database: name, alreadyGone: true };
    return { ok: false, database: name, reason: msg.slice(0, 200) };
  }
}

/**
 * Publish events naming this host.
 *
 * Without this the public status feed keeps listing a withdrawn site under
 * "last indexed" for up to the 48h retention window — still naming, on our own
 * marketing page, a site we just agreed to stop using.
 */
export async function deleteActivityEvents(bucket, host) {
  let cursor, deleted = 0;
  try {
    do {
      const page = await bucket.list({ prefix: EVENTS, cursor, limit: 1000 });
      for (const o of page.objects) {
        const e = parseEventKey(o.key);
        if (e && e.host === host) { await bucket.delete(o.key); deleted++; }
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  } catch { /* best effort — never fail a withdrawal over the status feed */ }
  return { ok: true, deleted };
}

/** Raw crawl artifacts in R2 — their text, as we fetched it.
 *
 * ⚠️ `links.json` belongs in this list. It is derived from the withdrawn site's
 * own pages — which hosts it points at, and from how many pages — so leaving it
 * behind keeps a record built out of content we agreed to stop using, and would
 * let the site keep appearing as the SOURCE of edges on the public map after it
 * had left the directory. Any new per-site artifact must be added here too.
 */
export async function deleteArtifacts(env, slug) {
  const deleted = [];
  for (const k of [`sites/${slug}/raw.json`, `sites/${slug}/chunks.json`, `sites/${slug}/links.json`]) {
    try { await env.BUCKET.delete(k); deleted.push(k); } catch { /* best effort */ }
  }
  return { ok: true, deleted };
}

/**
 * Withdraw one host. Returns a per-step report.
 *
 * `deps` is injectable so the ORDER invariant — irreversible step last — is
 * testable. It is the property most likely to be broken by a well-meaning
 * refactor and the one whose breakage is least visible afterwards, and ES
 * module namespaces cannot be patched from a test, so a seam is the only way
 * to assert it at all.
 */
export async function withdrawHost(env, { host: rawHost, releaseId, reason, rights }, deps = {}) {
  // Normalise once, here, so the slug, the tombstone key and the evidence key
  // can never disagree about which host this was.
  const host = String(rawHost).toLowerCase();
  const {
    removeFromDirectory: rmDir = removeFromDirectory,
    deprecateRelease: depRel = deprecateRelease,
    destroyCorpus: destroy = destroyCorpus,
    deleteArtifacts: delArt = deleteArtifacts,
    deleteActivityEvents: delEvents = deleteActivityEvents,
  } = deps;
  const slug = slugify(host);
  const steps = {};

  steps.directory = await rmDir(env, host);
  steps.release = await depRel(env, releaseId);
  steps.corpus = await destroy(env, slug);
  steps.artifacts = await delArt(env, slug);
  steps.activity = await delEvents(env.BUCKET, host);

  // Tombstone so the frontier never re-offers it, and so /submit refuses it.
  // The rights gate would refuse it anyway, but that costs a workflow instance
  // to discover, and a submitter would get no useful answer.
  try {
    await env.BUCKET.put(DONE + host, JSON.stringify({
      reason: `withdrawn: ${reason}`, at: Date.now(),
    }));
    await env.BUCKET.delete(PENDING + host);
    await env.BUCKET.delete(INFLIGHT + host);
  } catch { /* bookkeeping must not fail a withdrawal */ }

  const record = {
    host, slug, releaseId: releaseId ?? null, reason,
    withdrawn: steps.corpus.ok === true,
    rights: rights ?? null,
    steps,
    withdrawnAt: new Date().toISOString(),
  };
  // Evidence, kept whatever the outcome. "We asked, they refused, we stopped"
  // is only a claim we can support if it was written down at the time.
  try { await env.BUCKET.put(`withdrawn/${host}.json`, JSON.stringify(record)); } catch { /* */ }
  return record;
}
