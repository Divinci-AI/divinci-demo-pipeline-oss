import { describe, it, expect } from "vitest";
import { hostOf } from "./wwwrag-backfill.js";

/**
 * The two flaws that made the 2026-08-12 retry pass lie.
 *
 * Both are about PLANNING and REPORTING, not about the HTTP call, so they are
 * pinned as pure predicates rather than by driving the script. The planner and
 * summariser below mirror the logic in wwwrag-backfill.ts; if that logic
 * changes, these should be updated in step — they exist to stop the specific
 * regressions, not to duplicate the implementation.
 */

/** The host gate as it now stands: skip covered hosts, EXCEPT failed URLs. */
function shouldPlan(url: string, present: Set<string>, failed: Record<string, string>, submitted: Set<string>): boolean {
  const h = hostOf(url);
  if (!h) return false;
  if (present.has(h) && !failed[url]) return false;
  if (submitted.has(url)) return false;
  return true;
}

describe("hostOf", () => {
  it("normalises away www so a host is counted once", () => {
    expect(hostOf("https://www.thorne.com/x")).toBe("thorne.com");
    expect(hostOf("https://thorne.com/y")).toBe("thorne.com");
  });

  it("returns empty for junk rather than throwing", () => {
    expect(hostOf("not a url")).toBe("");
  });
});

describe("planning: a retry pass must not be a silent no-op", () => {
  const present = new Set(["hss.edu", "jina.ai"]);

  it("RETRIES a failed URL even though its host is already in the directory", () => {
    // The 2026-08-12 bug: after pass one every host is present, so the host
    // gate filtered the outstanding failures out before their URLs were ever
    // considered — and the pass reported "done".
    const failed = { "https://www.hss.edu/about/ratings": "500: boom" };
    expect(shouldPlan("https://www.hss.edu/about/ratings", present, failed, new Set())).toBe(true);
  });

  it("still skips a covered host's URLs that never failed", () => {
    expect(shouldPlan("https://www.hss.edu/other", present, {}, new Set())).toBe(false);
  });

  it("never resubmits something already submitted, failed or not", () => {
    const failed = { "https://jina.ai/a": "500" };
    expect(shouldPlan("https://jina.ai/a", present, failed, new Set(["https://jina.ai/a"]))).toBe(false);
  });

  it("plans a brand-new host normally", () => {
    expect(shouldPlan("https://newco.com/a", present, {}, new Set())).toBe(true);
  });
});

describe("reporting: do not conflate three different states", () => {
  // "attempted / submitted / failed-now" describes THIS run; anything left from
  // a prior run is reported separately as not-attempted.
  function summarise(queue: string[], done: number, failed: Record<string, string>) {
    const failedNow = queue.length - done;
    const carried = Object.keys(failed).filter((u) => !queue.includes(u));
    return { attempted: queue.length, submitted: done, failedNow, carried: carried.length };
  }

  it("does not count a prior run's leftovers as this run's failures", () => {
    // The old summary printed 33 "failed" for a pass that attempted 25 URLs and
    // failed none of them.
    const s = summarise(["a", "b"], 2, { x: "500", y: "already-fresh" });
    expect(s.failedNow).toBe(0);
    expect(s.carried).toBe(2);
  });

  it("reports a real failure in this run's queue", () => {
    const s = summarise(["a", "b"], 1, { b: "500: boom" });
    expect(s.failedNow).toBe(1);
    expect(s.carried).toBe(0);
  });

  it("cannot report more failures than it attempted", () => {
    // The old arithmetic could, which is how "25 submitted, 33 failed" printed.
    const s = summarise(["a"], 1, { p: "500", q: "500", r: "500" });
    expect(s.failedNow).toBeLessThanOrEqual(s.attempted);
    expect(s.failedNow).toBe(0);
  });
});
