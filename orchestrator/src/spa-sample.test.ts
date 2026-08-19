import { describe, it, expect, vi } from "vitest";
import { likelySpaFromSample, pickContentSample } from "./intake.js";

/**
 * `likelySpa` decides whether every source in the manifest gets
 * `"scraper": "@cloudflare/browser-rendering"` — slower, and flakier in
 * practice. Judging that from the HOMEPAGE alone gets it wrong in both
 * directions, and the false POSITIVE is the common one: a marketing landing
 * page is exactly where a site puts its animation or hero canvas, while the
 * content renders server-side.
 *
 * acmecyber.com: an animated terminal homepage with 98 static words,
 * and CMMC pages carrying 763-1142.
 */

/** Thin, script-heavy — what looksLikeSpa is meant to catch. */
const SHELL = `<html><head><script src="/app.js"></script></head><body><div id="root"></div></body></html>`;
/** Real prose. */
const RICH = `<html><body>${"compliance assessment readiness control ".repeat(120)}</body></html>`;

describe("pickContentSample", () => {
  it("skips the homepage — that is what we are checking against", () => {
    expect(pickContentSample(["https://x.test/", "https://x.test/cmmc-level-2"]))
      .toBe("https://x.test/cmmc-level-2");
  });

  it("skips boilerplate, which is thin on EVERY site", () => {
    // Sampling /privacy would call a healthy site an SPA.
    expect(pickContentSample([
      "https://x.test/",
      "https://x.test/privacy",
      "https://x.test/terms",
      "https://x.test/contact",
      "https://x.test/cmmc-guide",
    ])).toBe("https://x.test/cmmc-guide");
  });

  it("returns undefined when there is nothing but boilerplate", () => {
    expect(pickContentSample(["https://x.test/", "https://x.test/privacy"])).toBeUndefined();
  });

  it("ignores an unparseable URL rather than throwing", () => {
    expect(pickContentSample(["not-a-url", "https://x.test/guide"])).toBe("https://x.test/guide");
  });
});

describe("likelySpaFromSample", () => {
  it("does NOT call the site an SPA when the CONTENT page renders", async () => {
    // The acmecyber shape: animated homepage, server-rendered content.
    const fetchPage = vi.fn().mockResolvedValue(RICH);
    expect(await likelySpaFromSample(SHELL, ["https://x.test/", "https://x.test/cmmc-level-2"], fetchPage))
      .toBe(false);
    expect(fetchPage).toHaveBeenCalledWith("https://x.test/cmmc-level-2");
  });

  it("still catches a REAL SPA, where the content page is thin too", async () => {
    const fetchPage = vi.fn().mockResolvedValue(SHELL);
    expect(await likelySpaFromSample(SHELL, ["https://x.test/", "https://x.test/app"], fetchPage))
      .toBe(true);
  });

  it("short-circuits without a fetch when the homepage already renders", async () => {
    const fetchPage = vi.fn();
    expect(await likelySpaFromSample(RICH, ["https://x.test/a"], fetchPage)).toBe(false);
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("falls back to the HOMEPAGE verdict when no content page can be sampled", async () => {
    // Guessing the cheaper answer here would plan plain-fetch crawls of a real
    // SPA, and every page would come back empty — the worse failure.
    expect(await likelySpaFromSample(SHELL, ["https://x.test/"], vi.fn())).toBe(true);
  });

  it("falls back to the homepage verdict when the sample fetch FAILS", async () => {
    expect(await likelySpaFromSample(SHELL, ["https://x.test/", "https://x.test/a"],
      vi.fn().mockResolvedValue(undefined))).toBe(true);
    expect(await likelySpaFromSample(SHELL, ["https://x.test/", "https://x.test/a"],
      vi.fn().mockRejectedValue(new Error("timeout")))).toBe(true);
  });
});
