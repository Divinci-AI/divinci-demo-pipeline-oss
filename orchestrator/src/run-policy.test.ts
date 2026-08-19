import { describe, it, expect } from "vitest";
import {
  STEP_ORDER,
  GATE_STEPS,
  isGateStep,
  stepOrderViolations,
  resolveCursor,
  validateOnlySteps,
  gate2Decision,
  isHostAlreadyCrawling,
} from "./run-policy.js";

describe("STEP_ORDER", () => {
  it("is well-formed by its own rules", () => {
    expect(stepOrderViolations(STEP_ORDER)).toEqual([]);
  });

  it("runs release BEFORE qa", () => {
    // The two-month-old bug: qa needs the RAG vector attached to the release,
    // and attaching it to an unpublished draft 500s — so with qa first, every
    // fresh run reached it with no releaseId and produced no score at all.
    expect(STEP_ORDER.indexOf("qa")).toBeGreaterThan(STEP_ORDER.indexOf("release"));
  });

  it("deploys the prospect-facing landing page only after human review", () => {
    expect(STEP_ORDER.indexOf("landing")).toBeGreaterThan(STEP_ORDER.indexOf("gate2"));
  });
});

describe("stepOrderViolations", () => {
  // Indices are captured BEFORE mutating: a destructuring swap re-evaluates
  // indexOf on the left-hand side after the first assignment has already moved
  // the element, which silently produces an unswapped array — and four vacuous
  // tests that pass against a pipeline order they never actually changed.
  const swap = (a: string, b: string): string[] => {
    const o = [...STEP_ORDER] as string[];
    const i = o.indexOf(a);
    const j = o.indexOf(b);
    if (i < 0 || j < 0) throw new Error(`swap(${a}, ${b}): not in STEP_ORDER`);
    [o[i], o[j]] = [o[j], o[i]];
    return o;
  };

  it("the swap helper actually swaps (guards the tests below)", () => {
    const o = swap("release", "qa");
    expect(o.indexOf("qa")).toBeLessThan(o.indexOf("release"));
  });

  it("CATCHES the qa-before-release regression", () => {
    expect(stepOrderViolations(swap("release", "qa")).join(" ")).toMatch(/release must precede qa/);
  });

  it("catches gate2 before qa", () => {
    expect(stepOrderViolations(swap("qa", "gate2")).join(" ")).toMatch(/qa must precede gate2/);
  });

  it("catches landing before gate2 — a demo link live before review", () => {
    expect(stepOrderViolations(swap("gate2", "landing")).join(" ")).toMatch(/landing must follow gate2/);
  });

  it("catches spend moved ahead of gate1", () => {
    expect(stepOrderViolations(swap("gate1", "ingest")).join(" ")).toMatch(/gate1 must be first|before gate1/);
  });

  it("catches a duplicated step", () => {
    expect(stepOrderViolations([...STEP_ORDER, "qa"]).join(" ")).toMatch(/duplicate/);
  });

  it("catches a missing step rather than silently indexing -1", () => {
    const without = (STEP_ORDER as readonly string[]).filter((s) => s !== "gate2");
    expect(stepOrderViolations(without).join(" ")).toMatch(/missing step: gate2/);
  });
});

describe("isGateStep", () => {
  it("knows the four human gates", () => {
    for (const g of GATE_STEPS) expect(isGateStep(g)).toBe(true);
  });
  it("does not treat work steps as gates", () => {
    for (const s of ["ingest", "probe", "qa", "release"]) expect(isGateStep(s)).toBe(false);
  });
});

describe("resolveCursor", () => {
  it("resumes at the recorded step", () => {
    expect(resolveCursor("qa")).toBe(STEP_ORDER.indexOf("qa"));
  });

  it("throws on an unknown step instead of restarting from the beginning", () => {
    // Silently returning 0 would re-run gate1..ingest on a finished run —
    // a second crawl of a real company's website.
    expect(() => resolveCursor("nonsense")).toThrow(/unknown step/);
  });
});

describe("validateOnlySteps", () => {
  it("accepts known steps", () => {
    expect(validateOnlySteps(["landing", "outreach"])).toEqual([]);
  });
  it("returns the unknown ones", () => {
    expect(validateOnlySteps(["landing", "nope"])).toEqual(["nope"]);
  });
});

describe("gate2Decision", () => {
  it("passes when there is a score", () => {
    expect(gate2Decision({ qaScore: 0.94, releaseId: "r" })).toEqual({ ok: true, overridden: false });
  });

  it("passes on a score of ZERO — a real, bad result is still evidence", () => {
    // `qaScore ?? ` style checks would treat 0 as absent and refuse a run that
    // was in fact measured, and measured as failing.
    expect(gate2Decision({ qaScore: 0, releaseId: "r" }).ok).toBe(true);
  });

  it("REFUSES with no score", () => {
    const d = gate2Decision({ qaScore: null, releaseId: "r" });
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/no QA score/);
  });

  it("names the missing release when that is the cause", () => {
    // Distinguishes "qa ran and found nothing" from "qa could not run" — the
    // difference between a bad demo and a broken pipeline.
    expect(gate2Decision({ qaScore: null }).reason).toMatch(/releaseId is unset/);
  });

  it("allows an explicit override, and MARKS it as overridden", () => {
    const d = gate2Decision({ qaScore: null, allowUnscored: true });
    expect(d.ok).toBe(true);
    expect(d.overridden).toBe(true);
    expect(d.reason).toMatch(/UNMEASURED/);
  });

  it("does not mark a genuinely scored run as overridden", () => {
    expect(gate2Decision({ qaScore: 0.9, allowUnscored: true }).overridden).toBe(false);
  });
});

// Found 2026-08-08. `divinci rag crawl` answers a host that is already being
// crawled with HTTP 423 "document is locked — Already crawling this host".
// Nothing in the pipeline recognised it, so it surfaced as a generic exit 1.
describe("isHostAlreadyCrawling", () => {
  it("recognises the CLI's wrapped 423 message", () => {
    const err = new Error(
      "divinci rag crawl https://acmedoc.com/blog/ failed: API error (423): " +
        "document is locked — Already crawling this host",
    );
    expect(isHostAlreadyCrawling(err)).toBe(true);
  });

  it("recognises the JSON body form, which carries no bare status code", () => {
    const err = new Error(
      '{"error":{"message":"document is locked","status":423,"code":"API_ERROR",' +
        '"context":"Already crawling this host"}}',
    );
    expect(isHostAlreadyCrawling(err)).toBe(true);
  });

  it("matches the phrase even when the status is absent", () => {
    expect(isHostAlreadyCrawling(new Error("Already crawling this host"))).toBe(true);
  });

  it("does not match an unrelated failure", () => {
    expect(isHostAlreadyCrawling(new Error("crawl CLI exited non-zero"))).toBe(false);
    expect(isHostAlreadyCrawling(new Error("HTTP 403 Forbidden"))).toBe(false);
    expect(isHostAlreadyCrawling(undefined)).toBe(false);
  });

  it("does not match a 423 that is merely part of a larger number", () => {
    // A page count or an id containing 423 must not be read as the status.
    expect(isHostAlreadyCrawling(new Error("indexed 14235 pages"))).toBe(false);
  });
});
