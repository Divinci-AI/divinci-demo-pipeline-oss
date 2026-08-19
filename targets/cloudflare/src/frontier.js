/**
 * The self-expanding seed frontier, backed by R2.
 *
 * WHY R2 AND NOT A LIST FILE. Several workflow instances discover hosts at the
 * same time, and a single JSON document would need read-modify-write from each
 * of them — last writer wins, and discoveries vanish. One tiny object per host
 * makes every write idempotent and independent, so concurrency needs no lock.
 *
 * Layout:
 *   seeds/pending/<host>   candidate            {from, at, attempts}
 *   seeds/done/<host>      terminal, never retry {reason, at}
 *   state/inflight/<host>  claimed by a run     {instanceId, at}
 *
 * `done` is a tombstone, not a success log — a host that REFUSES us belongs
 * there just as much as one we published, because the expensive mistake is
 * re-asking a host that already said no on every single cron tick.
 */

export const PENDING = "seeds/pending/";
export const DONE = "seeds/done/";
export const INFLIGHT = "state/inflight/";

/**
 * Outbound hostnames worth crawling next, harvested from a page's markdown.
 *
 * This is the whole discovery engine: the corpus we just built names the sites
 * it considers relevant, which is a far better prior than any seed list we
 * would write by hand. It mirrors the laptop daemon's link-neighborhood
 * expansion, minus the laptop.
 *
 * Deliberately conservative — everything it returns costs a crawl.
 */
export function extractHosts(markdown, selfHost, opts = {}) {
  const max = opts.max ?? 25;
  const out = new Map();
  // Markdown links, bare URLs, and angle-bracket autolinks all reduce to the
  // same thing: an http(s) URL somewhere in the text.
  const re = /https?:\/\/([^\s/?#"'<>)\]]+)/gi;
  let m;
  while ((m = re.exec(markdown)) !== null) {
    let h = m[1].toLowerCase();
    // Strip credentials, port, and a trailing root dot.
    h = h.replace(/^[^@]*@/, "").replace(/:\d+$/, "").replace(/\.$/, "");
    if (!isPlausibleHost(h) || isJunkHost(h)) continue;
    // A subdomain of ourselves is already covered — the crawl runs with
    // includeSubdomains, so re-crawling it would duplicate the corpus.
    if (h === selfHost || h.endsWith("." + selfHost)) continue;
    const bare = selfHost.replace(/^www\./, "");
    if (h === bare || h.endsWith("." + bare)) continue;
    out.set(h, (out.get(h) ?? 0) + 1);
    if (out.size > 4000) break; // pathological page guard
  }
  // Rank by how often the corpus points at them — a host linked once from a
  // footer is a weaker candidate than one linked from every page.
  const ranked = [...out.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max);
  // `withCounts` exists because this function already computes the outbound
  // link graph and then throws it away. The Universe map's hyperlink layer was
  // stuck at 28 of 1,486 sites because it was being reconstructed from Mongo
  // page documents that the Turso pipeline never writes — while the same
  // numbers were being counted here, once per crawl, and dropped on the floor.
  //
  // Default return shape is unchanged on purpose: discovery is the hot path and
  // every existing caller and test expects a bare host list.
  return opts.withCounts ? ranked : ranked.map(([h]) => h);
}


/**
 * Hosts that can never yield a retrievable corpus.
 *
 * Self-expansion harvests every outbound host a page links to, and real pages
 * link constantly to things that are not sites: shorteners, share buttons,
 * donate forms, CDN origins, download redirectors. Each one costs a workflow
 * instance and real browser-seconds to discover it has no text — the density
 * floor catches them, but only AFTER paying for the crawl. With a fixed credit
 * budget, refusing them up front is the difference between spending on corpus
 * and spending on 404-shaped nothing.
 *
 * Deliberately a NARROW list of things that are structurally not content, not
 * a taste filter. When in doubt, let it through and let the density floor rule.
 */
const JUNK_EXACT = new Set([
  // Shorteners and click-trackers — zero content by construction.
  "bit.ly", "t.co", "goo.gl", "ow.ly", "buff.ly", "tinyurl.com", "is.gd",
  "dlvr.it", "trib.al", "lnkd.in", "youtu.be", "fb.me",
  // Share/invite endpoints rather than readable pages.
  "discord.gg", "discord.com", "t.me", "wa.me",
  // ⛔ App stores were on this list and have been REMOVED. They were added on
  // the assumption that a listing page is "not prose"; apps.apple.com then
  // published at 7,012 B/page across 98 pages — above the directory median of
  // 4,662. The assumption was wrong, and it was exactly the kind of guess the
  // header warns against: when in doubt, let it through and let the density
  // floor rule on measured bytes rather than on a hunch about a domain.
  // Ad/analytics infrastructure.
  "doubleclick.net", "googletagmanager.com", "google-analytics.com",
]);

/** Subdomain roles that are functional endpoints, never article text. */
const JUNK_PREFIX = [
  "cdn.", "static.", "assets.", "img.", "images.", "media.", "fonts.",
  "download.", "downloads.", "dl.", "ftp.", "mirror.", "mirrors.",
  "donate.", "login.", "signin.", "signup.", "account.", "accounts.",
  "checkout.", "payments.", "status.", "uptime.", "api.", "cdn-",
];

export function isJunkHost(h) {
  if (JUNK_EXACT.has(h)) return true;
  if (JUNK_PREFIX.some((p) => h.startsWith(p))) return true;
  return false;
}

const BAD_TLD = new Set(["local", "localhost", "test", "invalid", "example", "onion", "internal"]);

export function isPlausibleHost(h) {
  if (!h || h.length > 100 || h.length < 4) return false;
  if (!h.includes(".")) return false;
  // Bare IPs are never a publishable "site" and are often infrastructure.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return false;
  if (h.includes("..") || h.startsWith(".") || h.startsWith("-")) return false;
  if (!/^[a-z0-9.-]+$/.test(h)) return false;
  const tld = h.split(".").pop();
  if (!tld || tld.length < 2 || BAD_TLD.has(tld)) return false;
  if (/^\d+$/.test(tld)) return false;
  return true;
}

/** List every key under a prefix, following the cursor. */
export async function listKeys(bucket, prefix, cap = 5000) {
  const out = [];
  let cursor;
  do {
    const r = await bucket.list({ prefix, cursor, limit: 1000 });
    for (const o of r.objects) out.push(o.key.slice(prefix.length));
    cursor = r.truncated ? r.cursor : undefined;
  } while (cursor && out.length < cap);
  return out;
}

/**
 * Claims that outlived their run.
 *
 * A Workflow has no `finally`, so a run that dies mid-step never releases its
 * claim. Without reaping, every such host is leaked from the frontier
 * permanently and the concurrency budget silently shrinks to zero — the
 * pipeline would go quiet while looking perfectly healthy.
 */
export function isStale(record, now, ttlMs) {
  const at = Number(record?.at ?? 0);
  return !at || now - at > ttlMs;
}

/**
 * Claim a host ATOMICALLY. Returns true if we won it, false if someone else has it.
 *
 * ⚠️ Do NOT implement this as head()-then-put(). Two ticks running seconds
 * apart both read "absent" and both launch — which is exactly what happened on
 * the first night of continuous operation: a manual tick and the cron launched
 * the SAME four hosts 25 seconds apart, and annual.wikimedia.org was crawled
 * twice concurrently.
 *
 * R2 list() is eventually consistent, so the claims written by the first tick
 * were invisible to the second. A conditional put is the only check that
 * cannot be stale: `etagDoesNotMatch: "*"` means "create only if absent", and
 * R2 resolves the race server-side, returning null to the loser.
 */
export async function claimHost(bucket, host, value) {
  try {
    const res = await bucket.put(INFLIGHT + host, JSON.stringify(value), {
      onlyIf: { etagDoesNotMatch: "*" },
    });
    return res !== null;
  } catch {
    // A precondition failure can surface as a throw depending on runtime
    // version. Either way it means we did not get the claim — never assume we did.
    return false;
  }
}
