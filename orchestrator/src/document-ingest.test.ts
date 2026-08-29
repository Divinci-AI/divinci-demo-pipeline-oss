/**
 * Wiring test for the document lane's SSRF guard.
 *
 * safe-fetch.test.ts proves the GUARD refuses private addresses. This proves
 * `ingestDocument` actually goes through it — a distinction that matters,
 * because the guard being correct and the guard being CALLED are independent
 * facts, and the second is the one a refactor silently breaks. Before this
 * file existed, nothing in either repo asserted the second.
 *
 * It also pins the two error CLASSES apart. `.ssrf` exists so a refusal reads
 * differently from a dead link: a dead link is the prospect's problem and the
 * run should carry on, a refusal is ours and someone should look at it. If
 * both collapsed to "download failed", that signal is gone and nothing fails.
 *
 * No network and no credentials: every case here is refused or rejected before
 * a connection is established.
 */
import { describe, it, expect } from "vitest";
import { ingestDocument } from "./document-ingest.js";

const VECTOR = "000000000000000000000000";

describe("ingestDocument goes through the SSRF guard", () => {
  it.each([
    ["http://169.254.169.254/doc.pdf", "cloud metadata"],
    ["http://127.0.0.1/doc.pdf", "loopback"],
    ["http://10.0.0.1/doc.pdf", "RFC1918"],
    ["http://[::1]/doc.pdf", "v6 loopback"],
  ])("refuses %s (%s) and says so", async (url) => {
    await expect(ingestDocument(url, VECTOR, { dryRun: true })).rejects.toThrow(/refused for safety/);
  });

  it("refuses a non-http scheme", async () => {
    await expect(ingestDocument("file:///etc/passwd", VECTOR, { dryRun: true })).rejects.toThrow(
      /refused for safety/,
    );
  });

  it("reports an ordinary dead link DIFFERENTLY from a refusal", async () => {
    // .invalid is reserved by RFC 2606 and never resolves, so this fails at
    // DNS — an ordinary failure, not a safety refusal. If this ever started
    // saying "refused for safety", the guard would be swallowing real network
    // errors and every dead prospect link would look like an attack.
    await expect(
      ingestDocument("http://this-host-does-not-exist.invalid/doc.pdf", VECTOR, { dryRun: true }),
    ).rejects.toThrow(/download failed/);
  });
});
