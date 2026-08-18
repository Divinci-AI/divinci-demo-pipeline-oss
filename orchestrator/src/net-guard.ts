/**
 * SSRF guard for recon fetches.
 *
 * THE EXPOSURE. Recon reads two things a third party controls completely:
 *
 *   1. `robots.txt` — its `Sitemap:` directive is an arbitrary URL we fetch.
 *   2. sitemap `<loc>` entries ending in .xml, which we follow as nested
 *      sitemap indexes.
 *
 * So a prospect's site — or any site that has been compromised, which is the
 * likelier case — can make this machine issue GETs to hosts of its choosing.
 * On this laptop that includes `http://localhost:7777` (review board, whose /mcp
 * surface is not something to hand a stranger a request against) and
 * `http://169.254.169.254` (cloud metadata). The responses are not discarded
 * either: anything matching `<loc>` lands in recon.json and in the prompt sent
 * to `claude -p`, so there is a narrow exfiltration path, not merely a blind
 * one.
 *
 * Redirects matter as much as the initial URL. `fetch` follows up to 20 hops by
 * default, so validating only the URL we were given is not a control at all —
 * a同-origin sitemap can 302 straight to loopback. Every hop is re-validated.
 *
 * RESIDUAL RISK, stated plainly: the hostname is resolved and checked, then
 * connected to separately, so a DNS answer that changes between the two
 * (rebinding) defeats this. Closing that needs connection-level pinning, which
 * undici does not expose cleanly. Given the prospect queue is human-curated and
 * this runs on a laptop rather than in a cloud account with an instance role,
 * blocking resolution to private space is proportionate — but it is a
 * mitigation, not a proof.
 */
import { lookup } from "node:dns/promises";

export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedUrlError";
  }
}

/** Hostnames that never belong in a public crawl, independent of DNS. */
const BLOCKED_HOST_PATTERNS = [/^localhost$/i, /\.localhost$/i, /\.local$/i, /\.internal$/i, /^metadata\.google\.internal$/i];

/**
 * True for addresses that are not routable on the public internet. Covers the
 * ranges that matter for SSRF rather than every reserved block.
 */
export function isPrivateAddress(ip: string): boolean {
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b, c] = [Number(v4[1]), Number(v4[2]), Number(v4[3])];
    if (a === 10) return true; // 10/8
    if (a === 127) return true; // loopback
    if (a === 0) return true; // "this network"
    if (a === 169 && b === 254) return true; // link-local — cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    // Only two /24s inside 192.0.0.0/16 are reserved: 192.0.0.0/24 (IETF
    // protocol assignments) and 192.0.2.0/24 (TEST-NET-1). Blocking the whole
    // /16 was wrong and blocked REAL prospects — spacenews.com resolves to
    // 192.0.78.25, which is Automattic/WordPress.com and entirely public. A
    // WordPress.com-hosted site is one of the commonest shapes we crawl.
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    if (a >= 224) return true; // multicast + reserved
    return false;
  }

  const ip6 = ip.toLowerCase().split("%")[0]; // strip zone id
  if (ip6 === "::1" || ip6 === "::") return true;
  if (ip6.startsWith("fe80")) return true; // link-local
  if (/^f[cd]/.test(ip6)) return true; // unique local fc00::/7
  // IPv4-mapped (::ffff:127.0.0.1) — classify by the embedded v4 address.
  const mapped = ip6.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isPrivateAddress(mapped[1]);
  return false;
}

/** Registrable-suffix comparison: same host, or a subdomain of it. */
export function isSameSite(host: string, base: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, "");
  const b = base.toLowerCase().replace(/^www\./, "");
  return h === b || h.endsWith(`.${b}`);
}

/**
 * Validate a URL for outbound recon. Throws BlockedUrlError with a reason.
 * `sameSiteAs` (a hostname) additionally restricts to that site.
 */
export async function assertFetchable(
  rawUrl: string,
  opts: { sameSiteAs?: string; resolver?: (host: string) => Promise<string[]> } = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlockedUrlError(`not a valid URL: ${rawUrl}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new BlockedUrlError(`refusing non-HTTP scheme: ${url.protocol}`);

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (BLOCKED_HOST_PATTERNS.some((re) => re.test(host)))
    throw new BlockedUrlError(`refusing internal hostname: ${host}`);

  if (opts.sameSiteAs && !isSameSite(host, opts.sameSiteAs))
    throw new BlockedUrlError(`refusing off-site fetch: ${host} is not ${opts.sameSiteAs}`);

  // An IP literal needs no DNS to be dangerous.
  if (/^[\d.]+$/.test(host) || host.includes(":")) {
    if (isPrivateAddress(host)) throw new BlockedUrlError(`refusing private address: ${host}`);
    return url;
  }

  const addresses = opts.resolver
    ? await opts.resolver(host)
    : await lookup(host, { all: true }).then((rs) => rs.map((r) => r.address)).catch(() => []);

  if (addresses.length === 0) throw new BlockedUrlError(`could not resolve ${host}`);
  // ALL answers must be public: a host that resolves to both a public and a
  // private address is a rebinding attempt, not a coincidence.
  const bad = addresses.find((a) => isPrivateAddress(a));
  if (bad) throw new BlockedUrlError(`${host} resolves to a private address (${bad})`);

  return url;
}

export interface SafeGetOpts {
  sameSiteAs?: string;
  timeoutMs?: number;
  maxRedirects?: number;
  userAgent?: string;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  resolver?: (host: string) => Promise<string[]>;
}

/**
 * GET a URL with every hop validated. Returns undefined on any failure —
 * recon is best-effort and a blocked URL must not abort a run.
 */
export async function safeGet(
  rawUrl: string,
  opts: SafeGetOpts = {},
): Promise<{ body: string; finalUrl: string } | undefined> {
  const doFetch = opts.fetchImpl ?? fetch;
  const maxRedirects = opts.maxRedirects ?? 3;
  let current = rawUrl;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    let url: URL;
    try {
      url = await assertFetchable(current, { sameSiteAs: opts.sameSiteAs, resolver: opts.resolver });
    } catch (err) {
      if (err instanceof BlockedUrlError) console.warn(`[recon] blocked: ${err.message}`);
      return undefined;
    }

    let res: Response;
    try {
      res = await doFetch(url, {
        headers: { "user-agent": opts.userAgent ?? "DivinciDemoPipeline/1.0" },
        // Manual: following automatically would skip validation on every hop
        // after the first, which is where the interesting redirect goes.
        redirect: "manual",
        signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
      });
    } catch {
      return undefined;
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return undefined;
      current = new URL(location, url).toString();
      continue;
    }
    if (!res.ok) return undefined;
    try {
      return { body: await res.text(), finalUrl: url.toString() };
    } catch {
      return undefined;
    }
  }
  console.warn(`[recon] too many redirects from ${rawUrl}`);
  return undefined;
}
