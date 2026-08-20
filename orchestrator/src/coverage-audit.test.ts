import { describe, it, expect } from "vitest";
import {
  auditCoverage,
  extractUrlFromTitle,
  fetchSitemapUrls,
  isSitemapIndex,
  normalizeUrl,
  parseRobotsSitemaps,
  parseSitemapUrls,
} from "./coverage-audit.js";

/** The shipped acmerenew.com corpus, as measured 2026-08-15. */
const ACMERENEW_INGESTED_TITLES = [
  "URL: https://acmerenew.com/ 2026-8-14 12:55",
  "URL: https://acmerenew.com/about 2026-8-14 12:58",
  "URL: https://acmerenew.com/about-kimberly-pierson 2026-8-14 12:58",
  "URL: https://acmerenew.com/contact-us 2026-8-14 12:56",
  "URL: https://acmerenew.com/contact-us 2026-8-14 12:57",
  "URL: https://acmerenew.com/contact-us 2026-8-14 12:58",
  "URL: https://acmerenew.com/contact-us 2026-8-14 12:59",
  "URL: https://acmerenew.com/privacy-terms 2026-8-14 12:56",
  "URL: https://acmerenew.com/privacy-terms 2026-8-14 12:57",
  "URL: https://acmerenew.com/privacy-terms 2026-8-14 12:58",
  "URL: https://acmerenew.com/privacy-terms 2026-8-14 12:59",
  "URL: https://acmerenew.com/services/hormone-optimization-therapy 2026-8-14 12:57",
  "URL: https://acmerenew.com/services/pain-regenerative-medicine/what-is-regenerative-medicine/what-is-regenerative-medicine 2026-8-14 12:57",
  "URL: https://acmerenew.com/symptoms/fatigue-low-energy 2026-8-14 12:58",
];

const ACMERENEW_SITEMAP = [
  "https://acmerenew.com",
  "https://acmerenew.com/about",
  "https://acmerenew.com/about-kimberly-pierson",
  "https://acmerenew.com/contact-us",
  "https://acmerenew.com/privacy-terms",
  "https://acmerenew.com/services/hormone-optimization-therapy",
  "https://acmerenew.com/services/iv-therapy-vitamin-injections",
  "https://acmerenew.com/services/medical-weight-loss",
  "https://acmerenew.com/services/pain-regenerative-medicine/a2m",
  "https://acmerenew.com/services/pain-regenerative-medicine/nerve-hydrodissection",
  "https://acmerenew.com/services/pain-regenerative-medicine/orthobiologics",
  "https://acmerenew.com/services/pain-regenerative-medicine/stellate-ganglion-block",
  "https://acmerenew.com/services/pain-regenerative-medicine/what-is-regenerative-medicine/what-is-regenerative-medicine",
  "https://acmerenew.com/services/peptide-therapy",
  "https://acmerenew.com/services/sexual-wellness",
  "https://acmerenew.com/services/skin-aesthetics",
  "https://acmerenew.com/symptoms/anxiety",
  "https://acmerenew.com/symptoms/depression",
  "https://acmerenew.com/symptoms/fatigue-low-energy",
  "https://acmerenew.com/symptoms/joint-pain",
  "https://acmerenew.com/symptoms/low-testosterone",
  "https://acmerenew.com/symptoms/ptsd",
];

describe("URL normalisation", () => {
  it("treats a trailing slash as the same page", () => {
    // Without this every URL on the site reports as BOTH missing and extra.
    expect(normalizeUrl("https://x.com/about/")).toBe(normalizeUrl("https://x.com/about"));
  });

  it("ignores www, case, query and fragment", () => {
    expect(normalizeUrl("HTTPS://WWW.X.com/About?utm=1#top")).toBe("https://x.com/About");
  });

  it("does not collapse distinct paths", () => {
    expect(normalizeUrl("https://x.com/a")).not.toBe(normalizeUrl("https://x.com/b"));
  });

  it("survives a non-URL without throwing", () => {
    expect(() => normalizeUrl("not a url")).not.toThrow();
  });
});

describe("RAG file titles", () => {
  it("stops at the URL and does not swallow the trailing timestamp", () => {
    expect(extractUrlFromTitle("URL: https://acmerenew.com/about 2026-8-14 12:58"))
      .toBe("https://acmerenew.com/about");
  });

  it("falls back to a bare URL in the title", () => {
    expect(extractUrlFromTitle("Crawled https://x.com/p")).toBe("https://x.com/p");
  });

  it("returns null for an uploaded file with no URL", () => {
    expect(extractUrlFromTitle("annual-report.pdf")).toBeNull();
  });
});

describe("sitemaps", () => {
  it("reads <loc> values", () => {
    expect(parseSitemapUrls("<urlset><url><loc>https://x.com/a</loc></url></urlset>"))
      .toEqual(["https://x.com/a"]);
  });

  it("recognises a sitemap index", () => {
    expect(isSitemapIndex("<sitemapindex><sitemap><loc>https://x.com/s1.xml</loc></sitemap></sitemapindex>")).toBe(true);
    expect(isSitemapIndex("<urlset><url><loc>https://x.com/a</loc></url></urlset>")).toBe(false);
  });

  it("follows one level of index nesting", async () => {
    // acmerenew.com's shape exactly: sitemap.xml is an index whose single
    // child holds the pages.
    const pages: Record<string, string> = {
      "https://x.com/sitemap.xml":
        "<sitemapindex><sitemap><loc>https://x.com/sitemap_pages.xml</loc></sitemap></sitemapindex>",
      "https://x.com/sitemap_pages.xml":
        "<urlset><url><loc>https://x.com/a</loc></url><url><loc>https://x.com/b</loc></url></urlset>",
    };
    const urls = await fetchSitemapUrls("https://x.com", async (u) => pages[u] ?? null);
    expect(urls).toEqual(["https://x.com/a", "https://x.com/b"]);
  });

  it("returns [] rather than throwing when the site has no sitemap", async () => {
    const urls = await fetchSitemapUrls("https://x.com", async () => null);
    expect(urls).toEqual([]);
  });
});

describe("robots.txt sitemap discovery", () => {
  it("reads the Sitemap directive whatever its case", () => {
    expect(parseRobotsSitemaps("User-Agent: *\nSITEMAP: https://x.com/a.xml")).toEqual([
      "https://x.com/a.xml",
    ]);
    expect(parseRobotsSitemaps("sitemap:https://x.com/b.xml")).toEqual(["https://x.com/b.xml"]);
  });

  it("collects several declarations in order", () => {
    const robots = "Sitemap: https://x.com/1.xml\nDisallow: /admin/\nSitemap: https://x.com/2.xml";
    expect(parseRobotsSitemaps(robots)).toEqual(["https://x.com/1.xml", "https://x.com/2.xml"]);
  });

  it("ignores a robots.txt with no directive", () => {
    expect(parseRobotsSitemaps("User-Agent: *\nAllow: /")).toEqual([]);
  });

  it("finds probed.space's sitemap, which no conventional filename would", async () => {
    // The real shape, 2026-08-16: every guessed filename 404s, and the declared
    // path has no `.xml` extension. Guessing alone reported `no-sitemap` for a
    // site with 2,863 URLs — and `no-sitemap` does not halt Gate 2, so the
    // demo would have shipped with coverage unmeasured.
    const pages: Record<string, string> = {
      "https://probed.space/robots.txt":
        "User-Agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: https://probed.space/sitemap-index",
      "https://probed.space/sitemap-index":
        "<sitemapindex><sitemap><loc>https://probed.space/sitemap/documents-0.xml</loc></sitemap></sitemapindex>",
      "https://probed.space/sitemap/documents-0.xml":
        "<urlset><url><loc>https://probed.space/documents/a</loc></url></urlset>",
    };
    const urls = await fetchSitemapUrls("https://probed.space", async (u) => pages[u] ?? null);
    expect(urls).toEqual(["https://probed.space/documents/a"]);
  });

  it("still falls back to the conventional names when robots.txt declares none", async () => {
    const pages: Record<string, string> = {
      "https://x.com/robots.txt": "User-Agent: *\nAllow: /",
      "https://x.com/sitemap.xml": "<urlset><url><loc>https://x.com/a</loc></url></urlset>",
    };
    const urls = await fetchSitemapUrls("https://x.com", async (u) => pages[u] ?? null);
    expect(urls).toEqual(["https://x.com/a"]);
  });

  it("does not fetch the same sitemap twice when robots.txt declares the conventional name", async () => {
    const seen: string[] = [];
    const pages: Record<string, string> = {
      "https://x.com/robots.txt": "Sitemap: https://x.com/sitemap.xml",
      "https://x.com/sitemap.xml": "<urlset><url><loc>https://x.com/a</loc></url></urlset>",
    };
    await fetchSitemapUrls("https://x.com", async (u) => {
      seen.push(u);
      return pages[u] ?? null;
    });
    expect(seen.filter((u) => u.endsWith("/sitemap.xml"))).toHaveLength(1);
  });

  it("survives a site with no robots.txt at all", async () => {
    const pages: Record<string, string> = {
      "https://x.com/sitemap.xml": "<urlset><url><loc>https://x.com/a</loc></url></urlset>",
    };
    const urls = await fetchSitemapUrls("https://x.com", async (u) => pages[u] ?? null);
    expect(urls).toEqual(["https://x.com/a"]);
  });
});

describe("auditCoverage", () => {
  it("catches the Acme Renew corpus: 8 of 22 pages, four-way duplicates", () => {
    const a = auditCoverage({
      sitemapUrls: ACMERENEW_SITEMAP,
      fileTitles: ACMERENEW_INGESTED_TITLES,
    });
    expect(a.verdict).toBe("under-crawled");
    expect(a.ingestedUrls).toHaveLength(8);
    expect(a.fileCount).toBe(14);
    // The pages whose absence produced "A2M, or Anti-Aging and Wellness".
    expect(a.missing).toContain("https://acmerenew.com/services/pain-regenerative-medicine/a2m");
    expect(a.missing).toContain("https://acmerenew.com/services/medical-weight-loss");
    expect(a.coverage).toBeLessThan(0.4);
  });

  it("reports the duplicate ingests, worst first", () => {
    const a = auditCoverage({ sitemapUrls: ACMERENEW_SITEMAP, fileTitles: ACMERENEW_INGESTED_TITLES });
    expect(a.duplicates[0].count).toBe(4);
    expect(a.duplicates.map((d) => d.url)).toEqual(
      expect.arrayContaining([
        "https://acmerenew.com/contact-us",
        "https://acmerenew.com/privacy-terms",
      ]),
    );
  });

  it("passes a complete corpus", () => {
    const a = auditCoverage({
      sitemapUrls: ["https://x.com/a", "https://x.com/b"],
      fileTitles: ["URL: https://x.com/a 2026-1-1", "URL: https://x.com/b/ 2026-1-1"],
    });
    expect(a.verdict).toBe("ok");
    expect(a.coverage).toBe(1);
    expect(a.missing).toEqual([]);
  });

  it("a missing sitemap is 'no-sitemap', NEVER 0% under-crawled", () => {
    // A guard that screams because it could not find a sitemap is a guard that
    // gets turned off. Absence of evidence is reported as such.
    const a = auditCoverage({ sitemapUrls: [], fileTitles: ["URL: https://x.com/a 2026-1-1"] });
    expect(a.verdict).toBe("no-sitemap");
    expect(a.coverage).toBeNaN();
    expect(a.summary).toMatch(/NO SITEMAP/);
    expect(a.summary).not.toMatch(/UNDER-CRAWLED/);
  });

  it("counts a page ingested under a trailing-slash variant as covered", () => {
    const a = auditCoverage({
      sitemapUrls: ["https://x.com/about"],
      fileTitles: ["URL: https://x.com/about/ 2026-1-1"],
    });
    expect(a.missing).toEqual([]);
    expect(a.extra).toEqual([]);
  });

  it("separates crawl-discovered extras from sitemap pages", () => {
    const a = auditCoverage({
      sitemapUrls: ["https://x.com/a"],
      fileTitles: ["URL: https://x.com/a 2026-1-1", "URL: https://x.com/hidden 2026-1-1"],
    });
    expect(a.extra).toEqual(["https://x.com/hidden"]);
    expect(a.coverage).toBe(1); // extras must not inflate coverage past 100%
  });

  it("ignores uploaded files that carry no URL", () => {
    const a = auditCoverage({
      sitemapUrls: ["https://x.com/a"],
      fileTitles: ["URL: https://x.com/a 2026-1-1", "brochure.pdf"],
    });
    expect(a.ingestedUrls).toEqual(["https://x.com/a"]);
    expect(a.verdict).toBe("ok");
  });
});
