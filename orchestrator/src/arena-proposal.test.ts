import { describe, expect, it } from "vitest";
import {
  MEASURED_SIGMA_PP,
  formatProposal,
  minimumDetectableEffect,
  proposeArena,
  replicatesFor,
} from "./arena-proposal.js";
import { triage } from "./qa-triage.js";
import { deriveStack } from "./rag-stack.js";

const BASELINE = deriveStack({
  _id: "v1",
  vectorIndexTool: "cloudflare-v2",
  embeddingModel: "gemini-embedding-2-preview@1536",
});

/** A run genuinely below the noise band, with a clean corpus and poor recall. */
const RETRIEVAL_LIMITED = triage({
  qaScore: 0.4,
  threshold: 0.85,
  history: [0.79, 0.87, 0.87],
  coverage: { sitemapUrlCount: 29, ingestedUrlCount: 28, duplicateCount: 0 },
  corpus: { furnitureRatio: 0.1, needsRecrawl: false },
  retrieval: { recallAtK: 0.3 },
});

describe("power arithmetic", () => {
  it("matches the measured noise floor", () => {
    // σ≈3.8pp from BioRenew's 79/87/87. At 3 replicates a two-arm comparison
    // resolves ~8.7pp — which is why the 2pp difference that experiment
    // reported was never a result.
    expect(minimumDetectableEffect(MEASURED_SIGMA_PP, 3)).toBeCloseTo(8.7, 1);
    expect(minimumDetectableEffect(MEASURED_SIGMA_PP, 10)).toBeCloseTo(4.8, 1);
  });

  it("prices small effects out, as it should", () => {
    // Resolving 2pp needs ~60 runs per arm. The number is the argument.
    expect(replicatesFor(MEASURED_SIGMA_PP, 2)).toBeGreaterThan(50);
    expect(replicatesFor(MEASURED_SIGMA_PP, 10)).toBeLessThanOrEqual(3);
    expect(replicatesFor(MEASURED_SIGMA_PP, 31)).toBeLessThanOrEqual(2);
  });

  it("returns Infinity rather than a comforting number for n<2", () => {
    expect(minimumDetectableEffect(3.8, 1)).toBe(Infinity);
    expect(replicatesFor(3.8, 0)).toBe(Infinity);
  });
});

describe("proposeArena — when NOT to run one", () => {
  it("returns null for a within-band failure", () => {
    const t = triage({ qaScore: 0.79, threshold: 0.85, history: [0.79, 0.87, 0.87] });
    expect(t.verdict).toBe("noise");
    expect(proposeArena({ prospect: "x", triage: t, baseline: BASELINE, existingReplicates: 3 })).toBeNull();
  });

  it("returns null when there are too few replicates to know anything", () => {
    const t = triage({ qaScore: 0.5, threshold: 0.85, history: [0.9] });
    expect(proposeArena({ prospect: "x", triage: t, baseline: BASELINE, existingReplicates: 1 })).toBeNull();
  });

  it("returns null when the stack could not be labelled", () => {
    // Arms that cannot be labelled cannot be compared, so proposing them would
    // produce a result nobody could attribute.
    expect(
      proposeArena({ prospect: "x", triage: RETRIEVAL_LIMITED, baseline: null, existingReplicates: 3 }),
    ).toBeNull();
  });
});

describe("proposeArena — the plan", () => {
  const p = proposeArena({
    prospect: "biorenewim",
    triage: RETRIEVAL_LIMITED,
    baseline: BASELINE,
    existingReplicates: 3,
    sigmaPp: 3.8,
  })!;

  it("always includes the baseline as an arm", () => {
    // Its replicates ARE the noise band; dropping it leaves nothing to compare
    // against.
    expect(p.arms[0].id).toBe("A-baseline");
    expect(p.arms[0].axis).toBe("baseline");
  });

  it("credits replicates already scored against the baseline arm", () => {
    // 3 already run, 3 wanted -> the baseline needs no new QA runs.
    const variants = p.arms.length - 1;
    expect(p.totals.qaRuns).toBe(variants * p.replicatesPerArm);
  });

  it("charges for the baseline when it is short of replicates", () => {
    const q = proposeArena({
      prospect: "x",
      triage: RETRIEVAL_LIMITED,
      baseline: BASELINE,
      existingReplicates: 1,
      sigmaPp: 3.8,
    })!;
    expect(q.totals.qaRuns).toBeGreaterThan(p.totals.qaRuns);
  });

  it("puts the corpus arm first, because it is the only one that has ever paid", () => {
    const ids = p.arms.map((a) => a.id);
    expect(ids).toContain("B-corpus");
    expect(ids.indexOf("B-corpus")).toBeLessThan(ids.indexOf("C-index"));
  });

  it("varies ONE axis per arm — no factorial blow-up", () => {
    // 4 axes crossed at 2 levels would be 16 arms and ~48 runs to resolve 8.7pp.
    const axes = p.arms.filter((a) => a.axis !== "baseline").map((a) => a.axis);
    expect(new Set(axes).size).toBe(axes.length);
    expect(p.arms.length).toBeLessThanOrEqual(5);
  });

  it("does not need a fresh ingestion for the model arm", () => {
    const model = proposeArena({
      prospect: "x",
      triage: triage({
        qaScore: 0.4,
        threshold: 0.85,
        history: [0.79, 0.87, 0.87],
        coverage: { sitemapUrlCount: 29, ingestedUrlCount: 28, duplicateCount: 0 },
        corpus: { furnitureRatio: 0.1, needsRecrawl: false },
        retrieval: { recallAtK: 0.95 },
      }),
      baseline: BASELINE,
      existingReplicates: 3,
    })!;
    expect(model.arms.map((a) => a.id)).toContain("E-model");
    expect(model.totals.ingestions).toBe(0);
  });

  it("requires every arm to prove a non-empty index first", () => {
    // BioRenew arm B1 never produced a usable index. Scored blind it would
    // have read as "that stack is worse" instead of "that arm did not run".
    expect(p.preconditions.join(" ")).toMatch(/NON-EMPTY index/i);
    expect(p.preconditions.join(" ")).toMatch(/B1/);
  });

  it("pins the comparison to ONE prospect", () => {
    expect(p.preconditions.join(" ")).toMatch(/SAME prospect/i);
    expect(p.preconditions.join(" ")).toContain("8.7pp");
  });

  it("states the interaction blind spot rather than hiding it", () => {
    expect(p.caveats.join(" ")).toMatch(/Interactions are invisible/i);
  });

  it("names the band inside which there is no winner", () => {
    expect(p.mdePp).toBeCloseTo(8.7, 1);
    expect(p.caveats.join(" ")).toContain("UNRESOLVED");
  });
});

describe("sizing honours the cap and says so", () => {
  it("reports the achievable MDE instead of silently exceeding the budget", () => {
    // Chasing 3pp wants ~26 replicates/arm. Capped at 4, the design resolves
    // ~7.5pp — and the proposal must say that, or someone approves a plan
    // believing it answers a question it cannot.
    const p = proposeArena({
      prospect: "x",
      triage: RETRIEVAL_LIMITED,
      baseline: BASELINE,
      existingReplicates: 3,
      sigmaPp: 3.8,
      targetEffectPp: 3,
      maxReplicatesPerArm: 4,
    })!;
    expect(p.replicatesPerArm).toBe(4);
    expect(p.mdePp).toBeGreaterThan(3);
    expect(p.caveats.join(" ")).toMatch(/Sized down/);
  });

  it("never proposes fewer than 2 replicates per arm", () => {
    const p = proposeArena({
      prospect: "x",
      triage: RETRIEVAL_LIMITED,
      baseline: BASELINE,
      existingReplicates: 3,
      sigmaPp: 0.1,
    })!;
    expect(p.replicatesPerArm).toBeGreaterThanOrEqual(2);
  });

  it("falls back to the measured sigma when the run has none", () => {
    const p = proposeArena({
      prospect: "x",
      triage: RETRIEVAL_LIMITED,
      baseline: BASELINE,
      existingReplicates: 0,
    })!;
    expect(p.sigmaPp).toBe(MEASURED_SIGMA_PP);
  });
});

describe("formatProposal", () => {
  const md = formatProposal(
    proposeArena({
      prospect: "biorenewim",
      triage: RETRIEVAL_LIMITED,
      baseline: BASELINE,
      existingReplicates: 3,
      sigmaPp: 3.8,
    })!,
  );

  it("leads with the fact that nothing has run", () => {
    expect(md).toContain("Nothing has been run");
  });

  it("shows the cost in units we can actually count", () => {
    // Runs and ingestions, not invented dollars.
    expect(md).toMatch(/\d+ QA runs/);
    expect(md).toMatch(/\d+ ingestions/);
  });

  it("says how approval happens", () => {
    expect(md).toContain("IN_PROGRESS");
  });
});
