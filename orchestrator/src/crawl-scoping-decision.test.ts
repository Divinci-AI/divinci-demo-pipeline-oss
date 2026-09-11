/**
 * The decision that governs 358 sources across 90 prospects. It shipped inline
 * in run.ts and had never executed in a test — these are the real numbers from
 * the 2026-08-16 fleet audit.
 */
import { describe, expect, it } from "vitest";
import { decideScoping } from "./crawl-scoping.js";

const sitemap = (paths: string[]) => paths.map((p) => `https://example.com${p}`);

describe("decideScoping", () => {
  it("scopes when the path is well represented (the w&b case)", () => {
    // wandb.ai/wandb_fc/ is 1,394 of 13,708 — scoping is exactly right there,
    // and NOT scoping is what produced a corpus with 0% on-target pages.
    const urls = sitemap([...Array(1394)].map((_, i) => `/wandb_fc/r${i}`).concat(
      [...Array(500)].map((_, i) => `/someuser/r${i}`),
    ));
    const d = decideScoping({ urlPath: "/wandb_fc", sitemapUrls: urls, limit: 150 });
    expect(d.scope).toBe(true);
    expect(d.matched).toBe(1394);
    expect(d.reason).not.toMatch(/fewer than the limit/);
  });

  it("REFUSES to scope when the path matches nothing", () => {
    // An empty crawl is strictly worse than the old host-wide behaviour. This
    // is the only case where the code overrides the manifest.
    const d = decideScoping({ urlPath: "/site", sitemapUrls: sitemap(["/a", "/b", "/c"]), limit: 100 });
    expect(d.scope).toBe(false);
    expect(d.reason).toMatch(/does not exist on this site; re-author it/);
  });

  it("scopes but WARNS when matches fall short of the limit (the acmehealthmd case)", () => {
    // /podcast/ is ~3 of 1,166 with a limit of 250. Scoping is what the
    // manifest asked for; the warning is what stops it being a surprise.
    const urls = sitemap([...Array(3)].map((_, i) => `/podcast/e${i}`).concat(
      [...Array(1163)].map((_, i) => `/article-${i}`),
    ));
    const d = decideScoping({ urlPath: "/podcast", sitemapUrls: urls, limit: 250 });
    expect(d.scope).toBe(true);
    expect(d.matched).toBe(3);
    expect(d.reason).toMatch(/3 of 1166/);
    expect(d.reason).toMatch(/fewer than the limit/);
  });

  it("scopes when there is no sitemap to judge against", () => {
    // Doing what the manifest says is the safer default when the check itself
    // is unavailable.
    const d = decideScoping({ urlPath: "/blog", sitemapUrls: [], limit: 50 });
    expect(d.scope).toBe(true);
    expect(d.reason).toMatch(/no sitemap to check against/);
  });

  it("always explains itself — silence is the failure mode", () => {
    // The manifest still READS as though the path scoped the crawl. Every
    // branch has to say what actually happened or the illusion survives.
    for (const urls of [[], sitemap(["/x"]), sitemap(["/blog/a", "/blog/b"])]) {
      const d = decideScoping({ urlPath: "/blog", sitemapUrls: urls, limit: 10 });
      expect(d.reason.length).toBeGreaterThan(20);
    }
  });

  it("matches on a path SEGMENT, not a prefix string", () => {
    // /blog must not swallow /blogging — a substring match would scope in
    // pages nobody asked for and look like it worked.
    const urls = sitemap(["/blogging/a", "/blogging/b"]);
    const d = decideScoping({ urlPath: "/blog", sitemapUrls: urls, limit: 10 });
    expect(d.matched).toBe(0);
    expect(d.scope).toBe(false);
  });

  it("ignores unparseable sitemap entries rather than throwing", () => {
    const d = decideScoping({ urlPath: "/blog", sitemapUrls: ["not a url", "https://example.com/blog/a"], limit: 10 });
    expect(d.matched).toBe(1);
    expect(d.scope).toBe(true);
  });

  // Regression: a manifest that sets sitemap:true on several sources against the
  // same small sitemap, where some sources point at PAGES rather than sections.
  // `${urlPath}/` matches nothing for a page, so scoping was refused and each
  // fell back to a host-wide crawl of the identical URL set — one observed site
  // produced 48 files and 141 crawled pages for 16 real pages. The duplicates
  // then crowd the top-k at retrieval.
  describe("a source that points at a page, not a section", () => {
    const site = sitemap([
      "/", "/about.html", "/contact.html", "/how-we-work.html", "/services.html",
      "/services-advisory.html", "/services-literacy.html", "/services-voice-agents.html",
      "/insights.html", "/insights-off-switch.html", "/insights-pilots-stall.html",
    ]);

    it("confines to the single path instead of crawling the whole host", () => {
      const d = decideScoping({ urlPath: "/services.html", sitemapUrls: site, limit: 40 });
      expect(d.singlePage).toBe(true);
      expect(d.scope).toBe(true);
      expect(d.matched).toBe(0);
      expect(d.reason).toContain("not a section");
    });

    it("does the same for the insights hub", () => {
      const d = decideScoping({ urlPath: "/insights.html", sitemapUrls: site, limit: 60 });
      expect(d.singlePage).toBe(true);
    });

    it("still refuses to scope when the path is in NEITHER form", () => {
      // Not a page in the sitemap and nothing beneath it: a host-wide crawl is
      // the only way to find anything, so the old behaviour must survive.
      const d = decideScoping({ urlPath: "/does-not-exist", sitemapUrls: site, limit: 40 });
      expect(d.singlePage).toBe(false);
      expect(d.scope).toBe(false);
    });

    it("a real section is unaffected — it scopes, and is not a single page", () => {
      const urls = sitemap(["/blog", "/blog/a", "/blog/b", "/other"]);
      const d = decideScoping({ urlPath: "/blog", sitemapUrls: urls, limit: 10 });
      expect(d.singlePage).toBe(false);
      expect(d.scope).toBe(true);
      expect(d.matched).toBe(2);
    });
  });
});
