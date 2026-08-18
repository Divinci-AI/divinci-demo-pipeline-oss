import { describe, it, expect } from "vitest";
import {
  stepTimings, advisoryFailures, countPartialCrawls, wwwRagTallies,
  extractRunMetrics, aggregate, stats,
} from "./metrics.js";

const at = (mins: number) => new Date(Date.UTC(2026, 7, 14, 0, mins, 0)).toISOString();

describe("stepTimings", () => {
  it("measures each step up to the next one", () => {
    const t = stepTimings([
      { at: at(0), msg: "step: ingest" },
      { at: at(5), msg: "step: qa" },
      { at: at(6), msg: "step: gate2" },
    ]);
    expect(t).toEqual([{ step: "ingest", seconds: 300 }, { step: "qa", seconds: 60 }]);
  });

  it("DROPS a multi-day gap rather than averaging wall-clock as work", () => {
    // Runs resume days later. sarvam's ingest step spans 2026-08-10 to 08-13;
    // counting that as 3 days of "ingest" would make every duration useless.
    const t = stepTimings([
      { at: "2026-08-10T12:00:00Z", msg: "step: ingest" },
      { at: "2026-08-13T12:00:00Z", msg: "step: wwwrag" },
      { at: "2026-08-13T12:10:00Z", msg: "step: qa" },
    ]);
    expect(t).toEqual([{ step: "wwwrag", seconds: 600 }]);
  });

  it("ignores unparseable timestamps instead of emitting NaN", () => {
    expect(stepTimings([{ at: "nope", msg: "step: qa" }, { at: at(1), msg: "step: gate2" }])).toEqual([]);
  });
});

describe("log mining", () => {
  it("counts partial crawls", () => {
    expect(countPartialCrawls([
      { msg: "ingest x: crawl CLI exited non-zero … but 23 page(s) indexed — accepting partial corpus." },
      { msg: "ingested y — {" },
    ])).toBe(1);
  });

  it("reads the www-rag tally line, keeping raw counts", () => {
    expect(wwwRagTallies([{ msg: "wwwrag: 114 submitted, 0 already, 0 denied, 5 failed" }]))
      .toEqual({ submitted: 114, failed: 5 });
  });

  it("returns nulls when the step never ran — not zeros", () => {
    // 0 submitted and "never attempted" are different facts; conflating them
    // would show the pre-default-on runs as having contributed zero rather
    // than as having no data.
    expect(wwwRagTallies([{ msg: "step: qa" }])).toEqual({ submitted: null, failed: null });
  });

  it("captures advisory failures that did not stop the run", () => {
    const f = advisoryFailures([
      { msg: "hygiene: ⚠️ ADVISORY STEP FAILED — rag health check: …" },
      { msg: "landing: design review skipped (Command failed: gcloud auth print-access-token)" },
      { msg: "step: qa" },
    ]);
    expect(f).toHaveLength(2);
  });
});

describe("extractRunMetrics", () => {
  const base = {
    prospect: "acme", run: "2026-08-14-001", step: "outreach",
    pagesCrawled: 120, qaScore: 0.95, qaPassedCount: 10, qaTestCount: 10,
    qaMinTestScore: 0.5,
    qaScoreAverages: { "llm-correctness": 1, "llm-relevance": 1, "llm-completeness": 0.85 },
    log: [{ at: at(0), msg: "step: qa" }, { at: at(2), msg: "step: gate2" }],
  } as never;

  it("treats outreach as having reached Gate 3", () => {
    // Gate 3 blocks by design, so `done` is rarer than success. Counting only
    // `done` would report most finished demos as failures.
    const m = extractRunMetrics(base);
    expect(m.reachedGate3).toBe(true);
    expect(m.completed).toBe(false);
  });

  it("keeps raw pass counts beside the percentage", () => {
    const m = extractRunMetrics(base);
    expect(m.qaPassedCount).toBe(10);
    expect(m.qaTestCount).toBe(10);
    // A percentage with no denominator cannot be pooled across runs.
    expect(m.qaScore).toBe(0.95);
  });

  it("defaults an unset scraper to the fetch scraper rather than dropping it", () => {
    const m = extractRunMetrics(base, { sources: [{}, { crawl: { scraper: "@cloudflare/browser-rendering" } }] });
    expect(m.scrapers).toEqual(["@cloudflare/browser-rendering", "@divinci-ai/fetch-scraper"]);
    expect(m.sourceCount).toBe(2);
  });

  it("carries the compliance tier from the QUEUE, not the run", () => {
    const m = extractRunMetrics(base, undefined, { complianceTier: "clinic-high", complianceFlags: ["legal-advice"] });
    expect(m.complianceTier).toBe("clinic-high");
    expect(m.complianceFlags).toEqual(["legal-advice"]);
  });

  it("returns nulls, never 0, for metrics a run never produced", () => {
    const m = extractRunMetrics({ prospect: "x", run: "r", step: "ingest", log: [] } as never);
    expect(m.qaScore).toBeNull();
    expect(m.pagesCrawled).toBeNull();
    expect(m.totalSeconds).toBeNull();
  });
});

describe("stats", () => {
  it("uses the SAMPLE sd so n=1 is not reported as zero variance", () => {
    expect(stats([0.5])!.sd).toBeNaN();
    expect(stats([1, 2, 3])!.sd).toBeCloseTo(1, 10);
  });

  it("returns null for an empty set rather than a zero-filled row", () => {
    expect(stats([])).toBeNull();
  });

  it("medians an even-length set", () => {
    expect(stats([1, 2, 3, 4])!.median).toBe(2.5);
  });
});

describe("aggregate", () => {
  const mk = (o: Partial<ReturnType<typeof extractRunMetrics>>) => ({
    prospect: "p", run: "r", step: "outreach", reachedGate3: true, completed: false,
    pagesCrawled: 10, sourceCount: 1, scrapers: ["@divinci-ai/fetch-scraper"], partialCrawls: 0,
    complianceTier: "commerce-medium", complianceFlags: [], qaScore: 0.9,
    qaPassedCount: 9, qaTestCount: 10, qaMinTestScore: 0.5,
    scorerCorrectness: 1, scorerRelevance: 1, scorerCompleteness: 0.8,
    wwwRagSubmitted: 10, wwwRagFailed: 1, stepTimings: [], totalSeconds: null,
    advisoryFailures: [], hardFailure: null, ...o,
  }) as ReturnType<typeof extractRunMetrics>;

  it("splits QA by scraper so the two can be compared", () => {
    const a = aggregate([
      mk({ qaScore: 0.9 }),
      mk({ qaScore: 0.8, scrapers: ["@cloudflare/browser-rendering"] }),
    ]);
    expect(a.byScraper["@divinci-ai/fetch-scraper"]!.qa!.mean).toBeCloseTo(0.9);
    expect(a.byScraper["@cloudflare/browser-rendering"]!.qa!.mean).toBeCloseTo(0.8);
  });

  it("sums www-rag contribution as raw counts", () => {
    const a = aggregate([mk({}), mk({ wwwRagSubmitted: 5, wwwRagFailed: 2 })]);
    expect(a.wwwRagSubmittedTotal).toBe(15);
    expect(a.wwwRagFailedTotal).toBe(3);
  });

  it("counts a run once per distinct scraper, not once per source", () => {
    const a = aggregate([mk({ scrapers: ["@divinci-ai/fetch-scraper", "@cloudflare/browser-rendering"] })]);
    expect(a.byScraper["@divinci-ai/fetch-scraper"]!.runs).toBe(1);
    expect(a.byScraper["@cloudflare/browser-rendering"]!.runs).toBe(1);
    expect(a.runs).toBe(1);
  });
});
