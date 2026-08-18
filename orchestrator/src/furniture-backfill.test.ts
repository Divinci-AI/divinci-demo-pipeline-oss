import { describe, it, expect } from "vitest";
import {
  extractPageUrls,
  rescrapeRequest,
  rescrapePath,
  backfillLanded,
  MAX_URLS_PER_REQUEST,
} from "./furniture-backfill.js";

/** Real titles, copied from Ansir's vector. */
const REAL_FILES = [
  { _id: "a", title: "URL: https://ansirsd.com/about 2026-8-14 7:19:48" },
  { _id: "b", title: "URL: https://ansirsd.com/1-million-cups 2026-8-14 7:19:50" },
  { _id: "c", title: "URL: https://ansirsd.com/about 2026-8-14 9:01:02" },
];

describe("extractPageUrls", () => {
  it("pulls the URL out of the generated title and dedupes", () => {
    expect(extractPageUrls(REAL_FILES)).toEqual([
      "https://ansirsd.com/1-million-cups",
      "https://ansirsd.com/about",
    ]);
  });

  it("skips docs that are not web pages", () => {
    // A transcript or an uploaded PDF has no URL to re-fetch. Passing its
    // title through would send junk to bulk-rescrape.
    expect(extractPageUrls([{ _id: "x", title: "Q3 board deck.pdf" }, { _id: "y" }])).toEqual([]);
  });

  it("does not treat a URL mentioned mid-sentence as a page", () => {
    expect(extractPageUrls([{ _id: "z", title: "Notes about https://example.com/pricing" }])).toEqual([]);
  });
});

describe("rescrapeRequest", () => {
  it("sets scraperTool to fetch, excluding the FireCrawl strategies", () => {
    // "fetch" does not force the plain-fetch path (CF Browser Rendering is
    // still tried first) but it does exclude FireCrawl, which reuses a
    // previous scrape's markdown and would apply none of the fix while still
    // reporting success.
    const r = rescrapeRequest("vec1", ["https://a.test/x"]);
    expect(r.scraperTool).toBe("fetch");
    expect(r.forceRescrape).toBe(true);
    expect(r.ragVectorIds).toEqual(["vec1"]);
  });

  it("refuses an empty URL list rather than posting a no-op", () => {
    expect(()=>(rescrapeRequest("vec1", []))).toThrow(/empty/i);
  });

  it("refuses to silently truncate past the server cap", () => {
    const many = Array.from({ length: MAX_URLS_PER_REQUEST + 1 }, (_, i)=>(`https://a.test/${i}`));
    expect(()=>(rescrapeRequest("vec1", many))).toThrow(/batch/i);
  });

  it("requires a vector id", () => {
    expect(()=>(rescrapeRequest("", ["https://a.test/x"]))).toThrow(/vectorId/);
  });
});

describe("rescrapePath", () => {
  it("targets the whitelabel's html-page router", () => {
    expect(rescrapePath("wl1")).toBe("/white-label/wl1/rag-vector/html-page/bulk-rescrape");
  });
});

describe("backfillLanded", () => {
  it("requires the corpus to have grown", () => {
    expect(backfillLanded(422, 431)).toBe(true);
  });

  it("treats an unchanged count as NOT landed", () => {
    // The endpoint answers {"success":true,"status":"started"} whether or not
    // a single page was re-fetched. Only the corpus can say.
    expect(backfillLanded(422, 422)).toBe(false);
  });
});

describe("batching and junk filtering", () => {
  it("batches well under the server's URL cap", async () => {
    // ⚠️ NOT MAX_URLS_PER_REQUEST. A single 394-page call stalled at 200/394
    // with `0 failed` and no error; seven 60-URL calls completed. The batch
    // size exists to bound a failure whose cause was never established, so it
    // must stay far below the cap even though the cap technically allows more.
    const { BATCH } = await import("./furniture-backfill-cli.js");
    expect(BATCH).toBeLessThanOrEqual(100);
    expect(BATCH).toBeLessThan(MAX_URLS_PER_REQUEST);
  });

  it("drops WordPress archives and plugin custom post types", async () => {
    // primumlaw ingested 701 URLs of which 307 were these — 251 /tag/ archives
    // plus op_global_element, op_typography_preset, elementor-hf, author and
    // category. Rescraping them spends the whole budget refreshing junk.
    const { dropJunkPaths } = await import("./furniture-backfill-cli.js");
    expect(dropJunkPaths([
      "https://x.test/real-article",
      "https://x.test/tag/nda",
      "https://x.test/category/business",
      "https://x.test/author/pat",
      "https://x.test/op_global_element/header",
      "https://x.test/op_typography_preset/h1",
      "https://x.test/elementor-hf/footer",
      "https://x.test/feed/",
    ])).toEqual(["https://x.test/real-article"]);
  });

  it("does not drop a real page whose slug merely CONTAINS a junk word", async () => {
    // "/category-management-consulting" is an article, not an archive.
    const { dropJunkPaths } = await import("./furniture-backfill-cli.js");
    expect(dropJunkPaths([
      "https://x.test/category-management-consulting",
      "https://x.test/tagline-writing",
    ])).toEqual([
      "https://x.test/category-management-consulting",
      "https://x.test/tagline-writing",
    ]);
  });
});

describe("the batch wait must settle, not just start", () => {
  it("documents why first-growth is not enough", async () => {
    // Chunks arrive gradually. The first version returned on the first sign of
    // growth and saw `9833 -> 9841` — eight chunks out of a 60-page batch —
    // declared it done, and moved on. Nine batches would have gone out in a few
    // minutes: the same concurrent load as the single 394-page call that
    // stalled, with the log still reading as orderly progress.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./furniture-backfill-cli.ts", import.meta.url), "utf8");
    expect(src).toContain("waitForBatch");
    expect(src).not.toContain("waitForGrowth");
    // It must require consecutive QUIET polls after growth, not one growth.
    expect(src).toMatch(/quietPolls/);
    expect(src).toMatch(/\+\+quiet >= quietPolls/);
  });

  it("only starts counting quiet polls AFTER growth begins", async () => {
    // Otherwise a slow-starting batch reads as a finished one, which is the
    // same false-completion in a different disguise.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./furniture-backfill-cli.ts", import.meta.url), "utf8");
    expect(src).toMatch(/if \(grew && \+\+quiet >= quietPolls\)/);
  });
});

describe("a transient error costs one batch, not the corpus", () => {
  it("retries a failed batch before giving up on it", async () => {
    // hughston-clinic died on batch 3 of 9 with a bare `fetch failed` — token
    // still valid, API healthy moments later — and the remaining 380 URLs went
    // unrepaired because the throw escaped to the per-prospect catch.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./furniture-backfill-cli.ts", import.meta.url), "utf8");
    expect(src).toMatch(/attempt <= 3/);
    expect(src).toMatch(/attempt \d\/3|attempt \$\{attempt\}\/3/);
  });

  it("continues to the NEXT batch after a batch is abandoned", async () => {
    // `continue`, not `throw` — the corpus is repaired in independent pieces,
    // so one unreachable piece must not discard the rest.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./furniture-backfill-cli.ts", import.meta.url), "utf8");
    expect(src).toContain("if (!sent) continue;");
  });

  it("still marks the prospect INCOMPLETE so the summary names it", async () => {
    // Skipping a batch quietly would be worse than failing: the corpus would
    // be partially repaired and reported as done.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./furniture-backfill-cli.ts", import.meta.url), "utf8");
    const retry = src.slice(src.indexOf("attempt <= 3"), src.indexOf("if (!sent) continue;"));
    expect(retry).toContain("ok = false");
  });
});

describe("the network is the weak link, so retry at the transport", () => {
  it("retries EVERY call, not just batches", async () => {
    // A DNS outage killed nine consecutive corpora on the FIRST call of each
    // (listFiles), before any batch loop existed to protect them. A per-batch
    // retry — which an earlier fix added — would not have saved one of them.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./furniture-backfill-cli.ts", import.meta.url), "utf8");
    const apiFn = src.slice(src.indexOf("async function api("), src.indexOf("const FILES_SERVER_LIMIT"));
    expect(apiFn).toMatch(/for \(let i = 1; i <= attempts/);
    expect(apiFn).toMatch(/await sleep\(wait\)/);
  });

  it("still THROWS once attempts are exhausted", async () => {
    // A genuinely dead network must fail the run, not hang it or silently
    // return an empty result that reads as "this corpus has no pages".
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./furniture-backfill-cli.ts", import.meta.url), "utf8");
    const apiFn = src.slice(src.indexOf("async function api("), src.indexOf("const FILES_SERVER_LIMIT"));
    expect(apiFn).toMatch(/throw lastErr/);
  });
});
