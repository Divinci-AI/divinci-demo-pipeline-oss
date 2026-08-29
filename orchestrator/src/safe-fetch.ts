/**
 * SSRF-resistant HTTP GET for the document lane.
 *
 * WHY: `document-ingest.ts` downloads PDFs from URLs found by crawling a
 * prospect's site, and did so with a bare `fetch(..., { redirect: "follow" })`.
 * A prospect site — or anything that can influence its markup — could redirect
 * that fetcher onto cloud metadata, a router admin page, or a service on the
 * operator's own machine, and the response would be ingested into a demo
 * corpus and published. `assembleManifest` proves each source URL is on the
 * prospect's domain; it says nothing about where a redirect goes.
 *
 * ⚠️ THE CHECK MUST HAPPEN AT CONNECT TIME. Resolving a hostname, deciding it
 * is public, and THEN fetching leaves a DNS-rebinding window: the attacker's
 * resolver answers the validation lookup publicly and the connection lookup
 * privately. The guard is passed as the request's own `lookup`, so the address
 * validated is the address dialled — which is why this does not simply wrap
 * `fetch`, which offers no hook into resolution.
 *
 * Self-contained on purpose: this file has a hand-kept twin in Divinci's
 * server repository, and neither can import the other. Keep the two in step —
 * and note that `truncate` below is an OPTION precisely because a difference
 * between the copies is the failure mode that invites.
 */
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

const V4_BLOCKS: [string, number][] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];

/** Any address we must never dial. Unknown input counts as private. */
export function isPrivateAddress(ip: unknown): boolean {
  if (typeof ip !== "string" || !ip) return true;
  let addr = ip.trim().toLowerCase();
  const pct = addr.indexOf("%");
  if (pct !== -1) addr = addr.slice(0, pct);

  if (net.isIPv4(addr)) {
    const n = ipv4ToInt(addr);
    if (n === null) return true;
    return V4_BLOCKS.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      return (n & mask) === ((ipv4ToInt(base) as number) & mask);
    });
  }

  if (net.isIPv6(addr)) {
    if (addr === "::" || addr === "::1") return true;
    // ::ffff:169.254.169.254 reaches metadata through a v6 literal.
    const mapped = addr.match(/^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    if (addr.startsWith("64:ff9b:") || addr.startsWith("2002:")) return true;
    const head = parseInt(addr.split(":")[0] || "0", 16);
    if ((head & 0xfe00) === 0xfc00) return true;
    if ((head & 0xffc0) === 0xfe80) return true;
    if ((head & 0xff00) === 0xff00) return true;
    return false;
  }

  return true;
}

type LookupCb = (err: NodeJS.ErrnoException | null, address?: unknown, family?: number) => void;

/** Refuses when ANY resolved address is private — a host answering with both a
 *  public and a private address is a rebinding attempt, not a fallback. */
function guardedLookup(hostname: string, options: dns.LookupAllOptions, callback: LookupCb): void {
  dns.lookup(hostname, { ...options, all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = Array.isArray(addresses) ? addresses : [addresses];
    if (!list.length) return callback(new Error(`no DNS result for ${hostname}`));
    const bad = list.find((a) => isPrivateAddress(a.address));
    if (bad) {
      return callback(Object.assign(new Error(`refusing non-public address ${bad.address} for ${hostname}`), { ssrf: true }));
    }
    if (options?.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

export interface SafeGetResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  url: string;
}

/**
 * Read a response body, stopping at `maxBytes`.
 *
 * Split out of `safeGet` so the oversize contract is TESTABLE. It cannot be
 * exercised end-to-end: the address guard refuses loopback (correctly), so a
 * local test server is unreachable by construction, and the only alternative
 * would be weakening the guard for a test. A pure function over a stream lets
 * the real behaviour be asserted without touching the guard at all.
 */
export async function readCappedBody(
  res: NodeJS.ReadableStream,
  maxBytes: number,
  truncate = false,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  let overran = false;
  await new Promise<void>((resolve, reject) => {
    res.on("data", (c: Buffer) => {
      const room = maxBytes - size;
      size += c.length;
      if (c.length <= room) chunks.push(c);
      else {
        // Keep the PREFIX, not just the whole chunks that fit. Chunk-aligned
        // truncation silently returns up to a chunk less than asked for.
        if (room > 0) chunks.push(c.subarray(0, room));
        overran = true;
        (res as unknown as { destroy: () => void }).destroy();
        resolve();
      }
    });
    res.on("end", resolve);
    res.on("error", reject);
  });
  if (overran && !truncate) throw new Error(`response exceeds the ${maxBytes}-byte cap`);
  return Buffer.concat(chunks);
}

/** GET a URL, revalidating every redirect hop. Throws (with `.ssrf`) on refusal. */
export async function safeGet(
  rawUrl: string,
  opts: {
    headers?: Record<string, string>;
    timeoutMs?: number;
    maxBytes?: number;
    maxRedirects?: number;
    /**
     * What to do when the body runs past `maxBytes`.
     *
     * FAIL-CLOSED BY DEFAULT (throw) — the document lane must never ingest a
     * truncated PDF into a published corpus and report success. A caller that
     * genuinely only needs the START of a response (an HTML `<head>`, say)
     * passes true.
     *
     * ⚠️ An OPTION, not a difference between the two hand-kept copies of this
     * file. It used to be the latter: this copy threw while its twin truncated
     * silently, under a comment in both telling the next reader to keep them
     * in step. Either direction of that sync was a bug.
     */
    truncate?: boolean;
  } = {},
): Promise<SafeGetResult> {
  const { headers = {}, timeoutMs = 15_000, maxBytes = 60 * 1024 * 1024, maxRedirects = 5, truncate = false } = opts;

  let url = new URL(rawUrl);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw Object.assign(new Error(`refusing scheme ${url.protocol}`), { ssrf: true });
    }
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(host) !== 0 && isPrivateAddress(host)) {
      throw Object.assign(new Error(`refusing non-public address ${host}`), { ssrf: true });
    }

    const res: http.IncomingMessage = await new Promise((resolve, reject) => {
      const mod = url.protocol === "https:" ? https : http;
      const req = mod.request(
        url,
        {
          method: "GET",
          headers,
          lookup: guardedLookup as unknown as undefined,
          ...(url.protocol === "https:" ? { servername: host } : {}),
        },
        resolve,
      );
      req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
      req.on("error", reject);
      req.end();
    });

    const location = res.headers.location;
    if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && location) {
      res.resume();
      url = new URL(location, url);
      continue;
    }

    const body = await readCappedBody(res, maxBytes, truncate);

    return { status: res.statusCode ?? 0, headers: res.headers, body, url: url.href };
  }
  throw new Error(`too many redirects (>${maxRedirects})`);
}
