import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Publishing a quality number to a PROSPECT is a stricter act than showing one
 * to a Gate 2 reviewer, so the rules that keep it honest are pinned here.
 * run.ts executes on import, so these are source-level wiring guards — the same
 * honest second-best used in run-wiring.test.ts.
 */
const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "run.ts"), "utf8");
/**
 * The function body, bounded by the NEXT function declaration.
 *
 * It used to end at the `/** One-line, prospect-facing` comment above
 * TIER_HAZARD_SUMMARY — which then had to move above the step loop to escape
 * the temporal dead zone, putting the end anchor BEFORE the start anchor. The
 * slice silently became "" and three assertions passed vacuously against an
 * empty string. An extraction test must fail when its anchors move, not
 * quietly stop testing anything.
 */
const fnStart = src.indexOf("function qaEvidenceForLanding(");
const fnEnd = src.indexOf("function draftLandingBrand(", fnStart);
if (fnStart === -1 || fnEnd === -1) throw new Error("qa-landing.test: could not bound qaEvidenceForLanding in run.ts");
const fn = src.slice(fnStart, fnEnd);

describe("landing-page QA claim", () => {
  it("publishes NOTHING when there is no score", () => {
    // A demo with no evidence must not make the claim at all — no "pending",
    // no placeholder, no zero.
    expect(fn).toMatch(/if \(score === undefined \|\| score === null\) return undefined/);
  });

  it("withholds the boast below a publish threshold", () => {
    // Gate 2 can approve a mediocre score for good reasons; that is not the
    // same as putting "68% — adversarially tested" on the page as a selling
    // point. The demo stays sendable, it just does not boast.
    expect(fn).toMatch(/score < QA_PUBLISH_MIN/);
    // Assert the SHAPE and the direction, not the literal. This pinned `?? 0.8`
    // and broke on 2026-08-16 when the gate was raised to 0.90 — i.e. it failed
    // because the control got STRONGER, which is the kind of test that teaches
    // people to edit tests instead of reading them. Weakening it still fails.
    const dflt = /QA_PUBLISH_MIN_SCORE \?\? (0\.\d+)/.exec(src)?.[1];
    expect(dflt).toBeDefined();
    expect(Number(dflt)).toBeGreaterThanOrEqual(0.8);
  });

  it("says what was TESTED, not just a number", () => {
    // A bare percentage invites "of what, graded by whom?" — which we cannot
    // answer crisply, because the suite is ours.
    expect(fn).toMatch(/hazard: TIER_HAZARD_SUMMARY/);
  });

  it("has a prospect-facing hazard line for every compliance tier", () => {
    const table = src.slice(src.indexOf("const TIER_HAZARD_SUMMARY"));
    for (const tier of ["wellness-low", "commerce-medium", "clinic-high", "sensitive-audience"])
      expect(table).toContain(`"${tier}"`);
  });

  it("only adds the QA stat when evidence exists", () => {
    // The stat row must never carry a placeholder or an unearned boast.
    expect(src).toMatch(/\.\.\.\(qa \? \[\{ value: qa\.scorePct/);
  });

  it("does not claim third-party attestation", () => {
    // TrustBench produces signed, independently verifiable manifests. This is a
    // self-reported figure and the copy must not imply otherwise.
    const copy = src.slice(src.indexOf("corpusFraming: qa"), src.indexOf("corpusStats: ["));
    expect(copy).toMatch(/adversarially tested/i);
    expect(copy).not.toMatch(/certified|verified by|independently|attested/i);
  });
});

describe("this test file's own extraction", () => {
  it("bounds a NON-EMPTY function body", () => {
    // The guard against the failure above: an anchor that moves must break the
    // test loudly rather than reduce it to assertions against "".
    expect(fn.length).toBeGreaterThan(200);
    expect(fn).toContain("qaEvidenceForLanding");
  });
});
