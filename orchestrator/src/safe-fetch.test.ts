/**
 * Guard for the document lane's SSRF protection.
 *
 * `document-ingest.ts` downloads PDFs from URLs discovered by crawling a
 * prospect's site. It used a bare `fetch(..., { redirect: "follow" })`, so a
 * prospect site — or anything that can influence its markup — could redirect
 * the download onto cloud metadata, a router admin page, or a service on the
 * operator's own machine, and whatever came back would be ingested into a demo
 * corpus and published.
 *
 * `assembleManifest` proves the source URL is on the prospect's domain. It
 * says nothing about where a REDIRECT goes, which is the whole gap.
 *
 * `safe-fetch.ts` has a hand-kept twin in Divinci's server repository; neither
 * can import the other, so these tests exist to keep the contract identical.
 */
import { describe, it, expect } from "vitest";
import http from "node:http";
import { Readable } from "node:stream";
import { isPrivateAddress, readCappedBody, safeGet } from "./safe-fetch.js";

/** A readable that emits `buf` in small chunks, like a real socket. */
function streamOf(buf: Buffer): NodeJS.ReadableStream {
  const parts: Buffer[] = [];
  for (let i = 0; i < buf.length; i += 256) parts.push(buf.subarray(i, i + 256));
  return Readable.from(parts);
}

describe("isPrivateAddress", () => {
  it.each([
    ["169.254.169.254", "cloud metadata — the highest-value SSRF target"],
    ["127.0.0.1", "loopback"],
    ["127.1.2.3", "all of 127/8"],
    ["10.0.0.1", "RFC1918"],
    ["172.16.0.1", "RFC1918 lower bound"],
    ["172.31.255.254", "RFC1918 upper bound"],
    ["192.168.1.1", "RFC1918"],
    ["100.64.0.1", "CGNAT"],
    ["0.0.0.0", "this network"],
    ["224.0.0.1", "multicast"],
  ])("blocks %s (%s)", (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each([["8.8.8.8"], ["1.1.1.1"], ["172.15.0.1"], ["172.32.0.1"], ["2606:4700:4700::1111"]])(
    "allows public %s",
    (ip) => expect(isPrivateAddress(ip)).toBe(false),
  );

  it("blocks IPv4-mapped v6, the bypass a v6-only check misses", () => {
    expect(isPrivateAddress("::ffff:169.254.169.254")).toBe(true);
    expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
  });

  it("blocks link-local, ULA and multicast v6", () => {
    for (const ip of ["fe80::1", "fc00::1", "fd00::1", "ff02::1", "::1", "::"]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
  });

  it("treats anything it cannot parse as private", () => {
    for (const v of ["", "not-an-ip", "999.999.999.999", null, undefined]) {
      expect(isPrivateAddress(v)).toBe(true);
    }
  });
});

describe("safeGet", () => {
  it("refuses a non-http scheme", async () => {
    await expect(safeGet("file:///etc/passwd")).rejects.toThrow(/refusing scheme/);
  });

  it("refuses a private IP literal", async () => {
    await expect(safeGet("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(/non-public address/);
  });

  it("refuses a HOSTNAME resolving to a private address — the DNS-guard path", async () => {
    // Not an IP literal, so this only fails if the guarded `lookup` is really
    // wired into the request. That is where rebinding is defeated: the address
    // validated is the address dialled.
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end("must never be read");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const { port } = server.address() as { port: number };
    try {
      await expect(safeGet(`http://localhost:${port}/`)).rejects.toThrow(/non-public address/);
    } finally {
      server.close();
    }
  });

  it("marks a refusal with .ssrf so the caller can distinguish it from a dead link", async () => {
    // document-ingest reports these differently: a dead link is the prospect's
    // problem, a refusal is ours to look at.
    await expect(safeGet("http://10.0.0.1/x").catch((e) => e.ssrf)).resolves.toBe(true);
  });
});

/**
 * The oversize contract, pinned in BOTH directions.
 *
 * This is the whole reason `truncate` is an option rather than a difference
 * between this file's twin copies. Silent truncation is right for a caller
 * that only reads an HTML <head>, and catastrophic here: a truncated PDF,
 * ingested into a published corpus, reporting success.
 */
describe("readCappedBody", () => {
  it("THROWS on an oversize body by default — fail-closed", async () => {
    await expect(readCappedBody(streamOf(Buffer.alloc(5000, 0x41)), 1000)).rejects.toThrow(/byte cap/);
  });

  it("returns EXACTLY maxBytes when the caller opts into truncation", async () => {
    // Not the last whole chunk under the cap — chunk-aligned truncation drops
    // up to a chunk of real content for no reason the caller can observe.
    const body = await readCappedBody(streamOf(Buffer.alloc(5000, 0x41)), 1000, true);
    expect(body.length).toBe(1000);
  });

  it("returns the whole body when it fits, either way", async () => {
    for (const truncate of [false, true]) {
      const body = await readCappedBody(streamOf(Buffer.alloc(500, 0x42)), 1000, truncate);
      expect(body.length).toBe(500);
    }
  });
});
