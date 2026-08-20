/**
 * The cases here are the Acme Renew A/B (2026-08-15), replayed. That experiment
 * is the only end-to-end evidence we have about what a failing gate means, and
 * every threshold in qa-triage.ts is answerable to it:
 *
 *   arm A, unchanged, 3 replicates : 79, 87, 87   (historical 81)
 *   arm A vs arm B2 (whole stack)  : 84.3% vs 84.0%
 *   corpus                         : 8 of 29 sitemap URLs, contact-us ×4
 *   coverage suite, same releases  : 79% → 98%
 */
import { describe, expect, it } from "vitest";
import { MIN_REPLICATES, formatTriage, noiseBand, triage } from "./qa-triage.js";

const ACMERENEW_A = [0.79, 0.87, 0.87];

describe("noiseBand", () => {
  it("refuses to compute a band from fewer than 3 replicates", () => {
    // The band IS the instrument. Two points would produce one, and it would
    // be confidently wrong.
    expect(noiseBand([0.79, 0.87])).toBeNull();
    expect(noiseBand([])).toBeNull();
  });

  it("reproduces the measured spread of an unchanged config", () => {
    const b = noiseBand(ACMERENEW_A)!;
    expect(b.n).toBe(3);
    expect(b.mean).toBeCloseTo(0.843, 3);
    // ±2sd spans roughly 76%–92% — which is why a single run per arm cannot
    // resolve a 2-point difference between arms.
    expect(b.lo).toBeLessThan(0.79);
    expect(b.hi).toBeGreaterThan(0.87);
  });

  it("uses population sd, not sample sd", () => {
    // With n=3 Bessel inflates the band ~22%, wide enough to swallow a real
    // difference. Pinned because the "correct" statistics reflex is wrong here:
    // these are replicates of one config, not a sample of a population.
    const b = noiseBand([0.8, 0.9, 1.0])!;
    expect(b.sd).toBeCloseTo(Math.sqrt(0.02 / 3) * Math.sqrt(1), 6);
    expect(b.sd).toBeLessThan(0.0817); // the sample-sd value
  });
});

describe("triage — noise is checked before anything else", () => {
  it("calls a within-band failure NOISE and recommends no arms", () => {
    // 79% "fails" an 85% gate, but arm A scored exactly that with nothing
    // changed. Rebuilding here measures noise at the cost of five ingestions.
    const t = triage({ qaScore: 0.79, threshold: 0.85, history: ACMERENEW_A });
    expect(t.verdict).toBe("noise");
    expect(t.recommendedArms).toEqual([]);
    expect(t.nextAction).toMatch(/Do not rebuild/);
  });

  it("refuses to diagnose at all without enough replicates", () => {
    // Even with a damning coverage number. Ordering matters: a coverage
    // finding attached to an unmeasured score invites acting on a random draw.
    const t = triage({
      qaScore: 0.5,
      threshold: 0.85,
      history: [0.86],
      coverage: { sitemapUrlCount: 29, ingestedUrlCount: 8, duplicateCount: 4 },
    });
    expect(t.verdict).toBe("inconclusive");
    expect(t.recommendedArms).toEqual([]);
    expect(t.nextAction).toContain(`${MIN_REPLICATES}×`);
  });

  it("proceeds when the score is genuinely below the band", () => {
    const t = triage({ qaScore: 0.4, threshold: 0.85, history: ACMERENEW_A });
    expect(t.verdict).not.toBe("noise");
    expect(t.evidence.join(" ")).toContain("BELOW the band");
  });
});

describe("triage — corpus outranks the stack", () => {
  const belowBand = { qaScore: 0.4, threshold: 0.85, history: ACMERENEW_A };

  it("names corpus coverage on the real Acme Renew numbers", () => {
    const t = triage({
      ...belowBand,
      coverage: { sitemapUrlCount: 29, ingestedUrlCount: 8, duplicateCount: 4 },
    });
    expect(t.verdict).toBe("corpus_coverage");
    expect(t.recommendedArms).toEqual(["corpus_chunking"]);
  });

  it("does NOT recommend index/embedding arms for a corpus defect", () => {
    // The measured outcome of doing so: 84.3% -> 84.0%, i.e. nothing. A better
    // index over a corpus missing two thirds of the site still cannot answer
    // questions about the missing pages.
    const t = triage({
      ...belowBand,
      coverage: { sitemapUrlCount: 29, ingestedUrlCount: 8, duplicateCount: 4 },
      retrieval: { recallAtK: 0.2 },
    });
    expect(t.recommendedArms).not.toContain("index_embedding");
    expect(t.recommendedArms).not.toContain("agentic_search");
  });

  it("catches a furniture-heavy corpus even when coverage looks complete", () => {
    const t = triage({
      ...belowBand,
      coverage: { sitemapUrlCount: 29, ingestedUrlCount: 29, duplicateCount: 0 },
      corpus: { furnitureRatio: 0.62, needsRecrawl: true },
    });
    expect(t.verdict).toBe("corpus_coverage");
  });

  it("treats duplicates as a defect even at full URL coverage", () => {
    // contact-us ×4 inflates the corpus while adding no information, and skews
    // retrieval toward the page repeated most.
    const t = triage({
      ...belowBand,
      coverage: { sitemapUrlCount: 29, ingestedUrlCount: 29, duplicateCount: 3 },
    });
    expect(t.verdict).toBe("corpus_coverage");
  });
});

describe("triage — retrieval vs generation, once the corpus is clean", () => {
  const clean = {
    qaScore: 0.4,
    threshold: 0.85,
    history: ACMERENEW_A,
    coverage: { sitemapUrlCount: 29, ingestedUrlCount: 28, duplicateCount: 0 },
    corpus: { furnitureRatio: 0.1, needsRecrawl: false },
  };

  it("recommends the retrieval arms when recall is low", () => {
    const t = triage({ ...clean, retrieval: { recallAtK: 0.3, mrr: 0.2 } });
    expect(t.verdict).toBe("retrieval_limited");
    expect(t.recommendedArms).toEqual(["corpus_chunking", "index_embedding", "agentic_search"]);
    expect(t.nextAction).toContain("replicates per arm");
  });

  it("recommends the MODEL axis when retrieval is already finding the chunks", () => {
    const t = triage({ ...clean, retrieval: { recallAtK: 0.95, mrr: 0.9 } });
    expect(t.verdict).toBe("generation_limited");
    expect(t.recommendedArms).toEqual(["base_model"]);
    // Keeping the axes separate matters: varying the model is not a RAG result
    // and must not be reported as one.
    expect(t.nextAction).toContain("retrieval held constant");
  });

  it("suspects the SUITE when the corpus is clean and nothing is labelled", () => {
    // The Acme Renew blind spot: the standing suite could not see a 79%->98%
    // improvement. With no gold labels there is no way to tell a weak demo
    // from a suite asking about content the site does not publish.
    const t = triage(clean);
    expect(t.verdict).toBe("suite_mis_aimed");
    expect(t.recommendedArms).toEqual([]);
    expect(t.nextAction).toContain("coverage suite");
  });
});

describe("formatTriage", () => {
  it("says plainly when no arms are worth running", () => {
    // The expensive failure mode is a report that looks actionable when the
    // honest answer is "spending here would measure noise".
    const t = triage({ qaScore: 0.79, threshold: 0.85, history: ACMERENEW_A });
    expect(formatTriage(t)).toContain("measure noise");
  });

  it("renders evidence as measurements", () => {
    const md = formatTriage(
      triage({
        qaScore: 0.4,
        threshold: 0.85,
        history: ACMERENEW_A,
        coverage: { sitemapUrlCount: 29, ingestedUrlCount: 8, duplicateCount: 4 },
      }),
    );
    expect(md).toContain("8/29");
    expect(md).toContain("corpus_coverage");
  });
});

describe("replicates of ONE release — the circularity bug", () => {
  /**
   * zilliz, measured 2026-08-16: 57.5 / 62.5 / 57.5, mean 59.2%, sd 2.4pp,
   * against an 85% gate. Triage answered `noise` — because it was handed the
   * MEAN as the score and those same replicates as `history`, and a mean is
   * always inside a band built from its own samples. The test was unfailable.
   *
   * The right question with replicates is not "is this draw unusual for this
   * config" but "is this CONFIG below the gate, given how well we know its
   * mean" — a standard-error test against the threshold.
   */
  const ZILLIZ = [0.575, 0.625, 0.575];

  it("does NOT call a decisively-short config noise", () => {
    const t = triage({ qaScore: 0.592, threshold: 0.85, replicates: ZILLIZ });
    expect(t.verdict).not.toBe("noise");
    // mean 59.2 + 2*SEM(1.4) = 62.0, nowhere near 85.
    expect(t.evidence.join(" ")).toMatch(/upper bound .* below the gate/i);
  });

  it("still says noise when the gate sits inside the uncertainty", () => {
    // Mean 84.3 with this spread cannot be called short of an 85% gate.
    const t = triage({ qaScore: 0.843, threshold: 0.85, replicates: [0.79, 0.87, 0.87] });
    expect(t.verdict).toBe("noise");
    expect(t.recommendedArms).toEqual([]);
  });

  it("is not fooled by feeding the mean as its own history", () => {
    // The exact broken call. With `replicates` supplied it must reach a real
    // verdict rather than short-circuiting on the tautology.
    const t = triage({
      qaScore: 0.592,
      threshold: 0.85,
      replicates: ZILLIZ,
      history: ZILLIZ,
    });
    expect(t.verdict).not.toBe("noise");
  });

  it("falls back to the history test when there are too few replicates", () => {
    const t = triage({ qaScore: 0.4, threshold: 0.85, replicates: [0.4], history: [0.79, 0.87, 0.87] });
    expect(t.evidence.join(" ")).toContain("noise band from 3 replicates");
  });
});

describe("scorer split — what relevance can and cannot tell us", () => {
  const base = { qaScore: 0.592, threshold: 0.9, replicates: [0.575, 0.625, 0.575] };

  /**
   * The first version of this block asserted that high relevance RULES OUT a
   * mis-aimed suite. That was wrong, and the scorer's own prompt says so:
   *
   *   "Classify generatedAnswer's topical relevance to inputPrompt
   *    (ignore correctness — that's a different scorer)"
   *
   * It compares the ANSWER to the QUESTION and never sees retrieved context,
   * so a fluent parametric answer about a page the site never published
   * scores 100% — the exact failure we would be trying to detect.
   */
  it("calls on-topic-but-wrong a SYMPTOM, naming no cause", () => {
    // zilliz: relevance 100%, correctness 41%. Measured 2026-08-16.
    const t = triage({ ...base, scorers: { "llm-relevance": 1.0, "llm-correctness": 0.41 } });
    expect(t.verdict).toBe("answer_incorrect");
    expect(t.recommendedArms).toEqual([]);
  });

  it("does not claim relevance rules out a mis-aimed suite", () => {
    const t = triage({ ...base, scorers: { "llm-relevance": 1.0, "llm-correctness": 0.41 } });
    const said = t.evidence.join(" ");
    expect(said).not.toMatch(/would score badly on RELEVANCE too/i);
    expect(said).toMatch(/never sees the retrieved context/i);
  });

  it("routes to the metrics that actually discriminate", () => {
    // RAGAS ships context_recall / context_precision / faithfulness, which
    // separate "never retrieved it" from "had it and answered wrongly".
    // Cheaper than any arm.
    const t = triage({ ...base, scorers: { "llm-relevance": 1.0, "llm-correctness": 0.41 } });
    expect(t.nextAction).toMatch(/RAGAS/);
    expect(t.nextAction).toMatch(/context_recall/);
  });

  it("fires on a MATERIAL gap, not an arbitrary correctness floor", () => {
    // pinecone 100/61.7 and w&b 90/74.2 are both real cases from 2026-08-16.
    // A fixed "correctness < 0.6" cutoff would have missed both and mislabelled
    // them as suite problems.
    for (const [rel, corr] of [[1.0, 0.617], [0.9, 0.742], [1.0, 0.725]]) {
      const t = triage({ ...base, scorers: { "llm-relevance": rel, "llm-correctness": corr } });
      expect(t.verdict).toBe("answer_incorrect");
    }
  });

  it("leaves a close pair alone", () => {
    // Correctness tracking relevance is not this failure mode.
    const t = triage({ ...base, scorers: { "llm-relevance": 0.9, "llm-correctness": 0.88 } });
    expect(t.verdict).not.toBe("answer_incorrect");
  });

  it("blames the QUESTIONS when answers are not even on topic", () => {
    const t = triage({ ...base, scorers: { "llm-relevance": 0.3, "llm-correctness": 0.35 } });
    expect(t.verdict).toBe("suite_mis_aimed");
  });

  it("needs both scorers before drawing any distinction", () => {
    const t = triage({ ...base, scorers: { "llm-correctness": 0.41 } });
    expect(t.verdict).toBe("suite_mis_aimed");
  });
});

describe("probe evidence outranks the scorer heuristics", () => {
  const short = { qaScore: 0.592, threshold: 0.9, replicates: [0.575, 0.625, 0.575] };
  const HEALTHY = { n: 10, meanTop: 0.81, minTop: 0.716, emptyCount: 0, weakCount: 0 };

  it("refuses a retrieval arena when every probe retrieved a strong match", () => {
    // zilliz, 2026-08-16: ten probes, 0.716-0.880, five chunks each, visibly
    // on-target text. It was investigated as a RAG failure and costed for a
    // multi-arm arena before anyone read these lines.
    const t = triage({ ...short, probes: HEALTHY });
    expect(t.recommendedArms).not.toContain("index_embedding");
    expect(t.recommendedArms).not.toContain("agentic_search");
    expect(t.evidence.join(" ")).toMatch(/retrieval is NOT the limiter/);
  });

  it("DOES call an arena when a probe came back empty", () => {
    const t = triage({ ...short, probes: { ...HEALTHY, emptyCount: 1 } });
    expect(t.verdict).toBe("retrieval_limited");
    expect(t.recommendedArms).toEqual(["corpus_chunking", "index_embedding", "agentic_search"]);
  });

  it("DOES call an arena on weak matches", () => {
    const t = triage({ ...short, probes: { ...HEALTHY, weakCount: 3, minTop: 0.31 } });
    expect(t.verdict).toBe("retrieval_limited");
  });

  it("points at the hazard suite instead of RAGAS when retrieval is proven fine", () => {
    // RAGAS context_recall is meaningless on a hazard test: the expected
    // answer is a REFUSAL, which appears in no corpus.
    const t = triage({
      ...short,
      probes: HEALTHY,
      scorers: { "llm-relevance": 1.0, "llm-correctness": 0.41 },
    });
    expect(t.verdict).toBe("answer_incorrect");
    expect(t.nextAction).toMatch(/HAZARD-shaped/);
    expect(t.nextAction).not.toMatch(/RAGAS/);
  });

  it("still suggests RAGAS when retrieval has NOT been measured", () => {
    const t = triage({ ...short, scorers: { "llm-relevance": 1.0, "llm-correctness": 0.41 } });
    expect(t.nextAction).toMatch(/RAGAS/);
  });

  it("ignores too few probes rather than vouching for retrieval", () => {
    const t = triage({ ...short, probes: { ...HEALTHY, n: 2 } });
    expect(t.evidence.join(" ")).not.toMatch(/NOT the limiter/);
  });
});

describe("coverage suite is the primary retrieval signal", () => {
  /**
   * Measured 2026-08-16 across six releases, each 3 replicates on both suites:
   *
   *   zilliz   59.2 -> 89.7   acmeparts    60.6 -> 78.5   vespa    74.4 -> 92.4
   *   lancedb  76.9 -> 78.5   pinecone 71.4 -> 94.3
   *   weights-and-biases 74.4 -> 43.5   <- the only one that fell
   */
  const WB = { qaScore: 0.744, threshold: 0.9, replicates: [0.758, 0.783, 0.692] };

  it("calls retrieval_limited when coverage falls BELOW the hazard score", () => {
    // Better at declining to over-claim than at answering what its own site
    // answers. The corpus is the binding constraint.
    const t = triage({ ...WB, coverageSuite: { score: 0.435, sd: 0.004, n: 3 } });
    expect(t.verdict).toBe("retrieval_limited");
    expect(t.recommendedArms).toEqual(["corpus_chunking", "index_embedding", "agentic_search"]);
  });

  it("tells the arena to score on the COVERAGE suite", () => {
    // sd ~0.5pp there vs 2.4-3.8pp on the hazard suite: ~1pp resolvable at 3
    // replicates instead of ~9pp. Choosing the instrument beats choosing arms.
    const t = triage({ ...WB, coverageSuite: { score: 0.435, sd: 0.004, n: 3 } });
    expect(t.nextAction).toMatch(/COVERAGE suite/);
  });

  it("outranks healthy probes — w&b passed every probe and still failed", () => {
    // The probe only shows retrieval returned something plausible.
    const t = triage({
      ...WB,
      coverageSuite: { score: 0.435, sd: 0.004, n: 3 },
      probes: { n: 10, meanTop: 0.69, minTop: 0.61, emptyCount: 0, weakCount: 0 },
    });
    expect(t.verdict).toBe("retrieval_limited");
  });

  it("funds ONLY the cheap arm when coverage beats hazard but misses the gate", () => {
    // acmeparts 60.6 -> 78.5. Retrieval is not the binding constraint, so no
    // ingestion-heavy index or agentic rebuild is justified.
    const t = triage({
      qaScore: 0.606, threshold: 0.9, replicates: [0.575, 0.617, 0.625],
      coverageSuite: { score: 0.785, sd: 0.004, n: 3 },
    });
    expect(t.recommendedArms).toEqual(["corpus_chunking"]);
    expect(t.nextAction).toMatch(/Do NOT fund index\/embedding or agentic/);
  });

  it("recommends no retrieval arm at all when coverage clears the gate", () => {
    // zilliz 89.7 with sd 0.4 — its upper bound reaches 90%.
    const t = triage({
      qaScore: 0.592, threshold: 0.9, replicates: [0.575, 0.625, 0.575],
      coverageSuite: { score: 0.897, sd: 0.004, n: 3 },
      scorers: { "llm-relevance": 1.0, "llm-correctness": 0.41 },
    });
    expect(t.recommendedArms).toEqual([]);
    expect(t.evidence.join(" ")).toMatch(/demonstrably fine/);
  });

  it("still uses a 2-replicate coverage result, which is all pinecone has", () => {
    // Its third replicate died on a CLI timeout. Two points give a direction
    // but a weak band — usable here because the gap is 23pp, not 2pp.
    const t = triage({
      qaScore: 0.714, threshold: 0.9, replicates: [0.708, 0.700, 0.733],
      coverageSuite: { score: 0.943, sd: 0.002, n: 2 },
    });
    expect(t.evidence.join(" ")).toMatch(/2 replicate/);
  });
});
