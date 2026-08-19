// "Already published" = present in the directory this deployment publishes to.
//
// The directory API lists every site BY HOST regardless of which whitelabel its
// vector lives under, which is what makes it authoritative when sites are split
// across per-site whitelabels. Do not replace this with a rag-vector list on one
// whitelabel: once sites are split, that returns only the handful of unmigrated
// vectors, so nearly every site reads as "new" and gets re-published as a
// duplicate.
//
// ── TWO MODES ───────────────────────────────────────────────────────────────
//
// `DIRECTORY_URL` set — SHARED-DIRECTORY mode. There is a directory beyond this
// deployment (the Open Web Vectors corpus, or your own multi-writer one), so it
// is the authority on what exists and this worker must ask before publishing.
//
// `DIRECTORY_URL` unset — OWN-CORPUS mode, the default for a fresh deployment.
// Nothing else writes to your corpus, so this worker's own R2 `seeds/done/` set
// is a complete record of what it has published and no remote call is needed or
// wanted. Pointing a private deployment at somebody else's directory would make
// it skip every host THEY have published, which is silently the wrong corpus.
//
// The mode is inferred from the variable rather than being its own flag, so the
// two cannot disagree.

/**
 * Fetch the set of published hosts.
 *
 * ⚠️ SHARED-DIRECTORY mode FAILS CLOSED. An empty or unreachable directory
 * returns `ok:false` and an EMPTY set, and callers must treat that as "cannot
 * tell" — never as "nothing is published". With no directory every host looks
 * new, so a fail-open would re-publish the entire corpus as duplicate vectors.
 * This exact fetch returned nothing during a network blip on 2026-08-13 and the
 * guard correctly refused the whole pass.
 *
 * Retries, because a single transient failure otherwise costs a whole pass.
 *
 * ⚠️ OWN-CORPUS mode returns `ok:true` with an EMPTY set and `local:true`. That
 * is NOT a fail-open: there is no remote record to be unable to reach, and the
 * caller substitutes the R2 `done` set, which is the complete authority here.
 * Callers MUST branch on `local` and consult `done` — returning an empty set
 * without that check would republish on every request. See the `local` branch
 * in the workflow's directory-check step.
 */
export async function fetchPublishedHosts(env, attempts = 3) {
  const url = env?.DIRECTORY_URL;
  if (!url) return { ok: true, hosts: new Set(), count: 0, local: true };

  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(40_000) });
      if (res.ok) {
        const sites = (await res.json())?.sites ?? [];
        if (sites.length) {
          const hosts = new Set();
          for (const s of sites) {
            const h = s?.host;
            if (!h) continue;
            // Accept www-stripping on both sides so www.nist.gov and nist.gov
            // cannot dual-publish.
            const bare = h.replace(/^www\./, "");
            hosts.add(h).add(bare).add(`www.${bare}`);
          }
          return { ok: true, hosts, count: sites.length, local: false };
        }
      }
    } catch {
      // fall through to retry
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, (i + 1) * 5000));
  }
  return { ok: false, hosts: new Set(), count: 0, local: false };
}
