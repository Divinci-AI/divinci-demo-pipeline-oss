/**
 * `--sitemap` resolves the sitemap at the HOST ROOT and ignores the source
 * URL's path. A manifest that scopes a source by path therefore crawls the
 * whole host unless include/exclude paths constrain it.
 *
 * Measured across the fleet on 2026-08-16: 358 sources / 90 prospects are
 * written that way. Harmless when the root sitemap IS the content; on
 * weights-and-biases — whose root sitemap is 13,708 community pages — it
 * produced a corpus of 386 URLs with ZERO on the product or docs surface, and
 * 356 of them duplicated because four path-scoped sources each took the same
 * first N of the same sitemap.
 *
 * These assert the derivation in run.ts's ingest command builder, read as
 * source, because the builder is inline in a step function with no seam.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const runTs = readFileSync(join(__dirname, "run.ts"), "utf8");

describe("sitemap crawls inherit the source URL's path", () => {
  it("derives --include-paths from the URL path", () => {
    expect(runTs).toContain("new URL(src.url).pathname");
    expect(runTs).toMatch(/derived: string\[\] =[\s\S]{0,240}includePaths\?\.length/);
  });

  it("only derives when the manifest did not scope it explicitly", () => {
    // An explicit includePaths is the author's intent and must win.
    expect(runTs).toMatch(/src\.crawl\.includePaths\?\.length\s*\?\s*src\.crawl\.includePaths\s*:\s*derived/);
  });

  it("only derives for sitemap crawls", () => {
    // Link-following already follows from the URL, so the path is not ignored
    // there and a derived filter could wrongly exclude a linked section.
    expect(runTs).toMatch(/src\.crawl\.sitemap && !src\.crawl\.includePaths/);
  });

  it("does not derive from a URL that IS a sitemap file", () => {
    // e.g. https://primumlaw.com/page-sitemap.xml — its path is the file, not
    // a section, and filtering on it would match nothing.
    expect(runTs).toContain('!urlPath.endsWith(".xml")');
  });

  it("says out loud when it derives, because the manifest looks unchanged", () => {
    // The manifest still reads as if the path scoped the crawl; only the log
    // shows that it did not until now.
    // The message itself moved into crawl-scoping.ts; what run.ts must still
    // do is emit whatever reason the decision returned.
    expect(runTs).toMatch(/\$\{d\.reason\}/);
  });
});

describe("the derivation is guarded — a manifest path can be aspirational", () => {
  /**
   * The DECISION now lives in crawl-scoping.ts and is behaviourally tested in
   * crawl-scoping-decision.test.ts. These assertions cover only what remains
   * in run.ts: that it fetches the sitemap, delegates the judgement, honours
   * the answer, and logs the reason.
   *
   * Kept deliberately thin. The first version of this block asserted the
   * decision's wording from run.ts's source, and broke the moment the logic was
   * extracted — a test that fails on a refactor which changed no behaviour is a
   * test that teaches people to edit tests.
   */
  it("delegates the judgement rather than inlining it", () => {
    expect(runTs).toContain("decideScoping(");
    expect(runTs).toContain("fetchSitemapUrls(host)");
  });

  it("honours a refusal", () => {
    expect(runTs).toMatch(/if \(!d\.scope\) derived = \[\];/);
  });

  it("logs the reason on every path", () => {
    // Silence is the failure mode: the manifest still reads as though the path
    // scoped the crawl.
    expect(runTs).toMatch(/log\(`ingest \$\{src\.id\}: \$\{d\.reason\}`\)/);
  });

  it("derives anyway when the sitemap cannot be checked", () => {
    expect(runTs).toMatch(/sitemap check failed/);
  });

  it("fetches each host's sitemap once", () => {
    expect(runTs).toContain("sitemapCache");
  });
});
