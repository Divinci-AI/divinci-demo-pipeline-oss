import { describe, expect, it } from "vitest";
import {
  averageScorers,
  medianIndex,
  summariseReplicates,
  worstTestScore,
} from "./qa-replicates.js";

/** Acme Renew arm A, unchanged config, three replicates. */
const ARM_A = [0.79, 0.87, 0.87];

describe("summariseReplicates", () => {
  it("pools the measured spread of an unchanged config", () => {
    const s = summariseReplicates(ARM_A)!;
    expect(s.n).toBe(3);
    expect(s.mean).toBeCloseTo(0.843, 3);
    expect(s.min).toBe(0.79);
    expect(s.max).toBe(0.87);
    // ~3.8pp — the number every power calculation for the arena depends on.
    expect(s.sd!).toBeCloseTo(0.0377, 3);
  });

  it("reports no sd for a single replicate rather than 0", () => {
    // sd=0 would read as "perfectly reproducible" — the exact opposite of what
    // one run means, and it would let triage compute a zero-width noise band
    // in which every score is a regression.
    const s = summariseReplicates([0.83])!;
    expect(s.n).toBe(1);
    expect(s.sd).toBeNull();
  });

  it("returns null when nothing scored", () => {
    expect(summariseReplicates([])).toBeNull();
    expect(summariseReplicates([NaN as unknown as number])).toBeNull();
  });

  it("survives a partially failed replicate set", () => {
    // Two good runs beat throwing them away because the third timed out.
    expect(summariseReplicates([0.79, 0.87])!.n).toBe(2);
  });
});

describe("medianIndex", () => {
  it("picks a middle run, never the best", () => {
    // Quoting the maximum is how a pipeline reports 87% for a config that also
    // produces 79%.
    // With [0.79, 0.87, 0.87] the sorted middle is 0.87 — equal to the max
    // here, so use a set where best and median differ to state the property.
    const spread = [0.99, 0.6, 0.8];
    expect(spread[medianIndex(spread)]).toBe(0.8);
    expect(spread[medianIndex(spread)]).not.toBe(Math.max(...spread));
    expect(medianIndex(ARM_A)).toBeGreaterThanOrEqual(0);
  });

  it("returns the index into the ORIGINAL order, not the sorted one", () => {
    // The caller uses this index to pull a runId and its counts. An index into
    // the sorted array would link a different run than the one it quotes.
    const scores = [0.9, 0.5, 0.7];
    expect(scores[medianIndex(scores)]).toBe(0.7);
    expect(medianIndex(scores)).toBe(2);
  });

  it("is deterministic under ties and re-ordering", () => {
    // A result that changes with arrival order is not reproducible.
    expect(medianIndex([0.8, 0.8, 0.8])).toBe(medianIndex([0.8, 0.8, 0.8]));
    expect(medianIndex([0.85, 0.85])).toBe(1);
  });

  it("handles an empty set", () => {
    expect(medianIndex([])).toBe(-1);
  });
});

describe("averageScorers", () => {
  it("averages each scorer across replicates", () => {
    const out = averageScorers([
      { correctness: 0.73, relevance: 1.0 },
      { correctness: 0.7, relevance: 1.0 },
    ]);
    expect(out.correctness).toBeCloseTo(0.715, 3);
    expect(out.relevance).toBe(1.0);
  });

  it("does NOT treat a missing scorer as zero", () => {
    // Absent means "this run did not report it". Scoring it 0 would punish a
    // config for a reporting gap and quietly drag a mean down.
    const out = averageScorers([{ completeness: 0.8 }, {}, { completeness: 0.9 }]);
    expect(out.completeness).toBeCloseTo(0.85, 3);
  });

  it("omits a scorer no replicate reported", () => {
    expect(averageScorers([{}, undefined])).toEqual({});
  });
});

describe("worstTestScore", () => {
  it("takes the worst across ALL replicates, not the median run's worst", () => {
    // The safety signal. A 0%-correctness answer seen once in three runs is
    // still an answer the demo can produce — this pipeline has already shipped
    // a fabricated post-op rehab protocol inside a "10/10 passed" run.
    expect(worstTestScore([[0.9, 0.8], [0.0, 0.95], [0.85, 0.9]])).toBe(0);
  });

  it("is null when no test scored", () => {
    expect(worstTestScore([[], []])).toBeNull();
  });
});
