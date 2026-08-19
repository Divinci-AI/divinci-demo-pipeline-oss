/**
 * qa-triage.ts — when a run misses the QA gate, decide WHY before spending.
 *
 * WHY THIS EXISTS
 * ===============
 * The obvious response to a failing gate is to rebuild the demo several ways
 * and keep the best. On 2026-08-15 we ran exactly that experiment on
 * acmerenew.com, and it is the reason this module leads with arithmetic
 * instead of arms:
 *
 *   - Arm A, an UNCHANGED config, scored 79, 87, 87 across three replicates
 *     (and 81 historically). An 8-point spread with nothing changed.
 *   - Swapping the entire retrieval stack — qdrant instead of cloudflare-v2,
 *     3072 dims instead of 1536, a deduped 26-doc corpus instead of 14 files —
 *     moved the mean from 84.3% to 84.0%. No measurable gain.
 *   - The actual defect was CORPUS COVERAGE: the crawl had ingested 8 of the
 *     site's 29 pages, `contact-us` four times, and 67 lines of nav/footer
 *     boilerplate. Fixing that was worth +31 points.
 *   - And the standing QA suite could not SEE that improvement. A purpose-built
 *     coverage suite showed 79% → 98% on the same two releases.
 *
 * Two rules follow, and they are the whole design:
 *
 *   1. NEVER compare arms without a noise band. Five arms scored once each,
 *      against an 8-point spread, will crown a winner at random and the report
 *      will look decisive. Establishing the band costs replicates of a config
 *      you already have; skipping it costs a wrong conclusion you will act on.
 *
 *   2. Diagnose before rebuilding. On the one case measured end to end, the
 *      expensive arms bought nothing and the cheap diagnostic found everything.
 *      Corpus and suite defects are also the two that a stack swap actively
 *      HIDES, because a better index over a corpus missing two thirds of the
 *      site still cannot answer questions about the missing pages.
 *
 * This module is pure — it takes measurements and returns a verdict. It runs
 * nothing, spends nothing, and calls no API, so it is cheap to run on every
 * failure and trivial to test. Orchestration lives in run.ts.
 */

/** What is actually wrong, in the order it is worth acting on. */
export type TriageVerdict =
  /** The "failure" is inside the run-to-run spread. Nothing to fix. */
  | "noise"
  /** Not enough replicates to tell noise from signal. Measure before spending. */
  | "inconclusive"
  /** The corpus does not represent the site: under-crawled, duplicated, or furniture-heavy. */
  | "corpus_coverage"
  /** The corpus is fine and retrieval finds it; the suite is asking the wrong questions. */
  | "suite_mis_aimed"
  /** Corpus is fine, retrieval is not finding it. The stack is the limiter. */
  | "retrieval_limited"
  /** Retrieval finds the right chunks and the answers are still poor. */
  | "generation_limited"
  /**
   * Answers are on-topic but wrong, and NOTHING measured so far says why.
   * A symptom, deliberately — see the scorer-split block for why the obvious
   * inference from high relevance is unsound.
   */
  | "answer_incorrect";

/** The axes an arena may vary. Ordered cheapest-first, which is also
 *  most-likely-to-matter-first on the evidence we have. */
export type ArmAxis =
  | "corpus_chunking"
  | "index_embedding"
  | "agentic_search"
  | "base_model";

export interface NoiseBand {
  n: number;
  mean: number;
  sd: number;
  /** mean − 2sd, floored at 0. */
  lo: number;
  /** mean + 2sd, capped at 1. */
  hi: number;
}

export interface TriageInput {
  /** The failing score, 0..1. */
  qaScore: number;
  /** The gate, 0..1. */
  threshold: number;
  /**
   * Prior scores for a COMPARABLE config, 0..1 — same suite, same judge, same
   * stack. Fewer than 3 and no band can be computed, which is itself a finding.
   */
  history?: readonly number[];
  /**
   * Scores from repeatedly running THIS release's own suite, 0..1.
   *
   * ⚠️ Semantically different from `history`, and the difference is the whole
   * point. When `qaScore` is the MEAN of these, it is always inside the band
   * they produce — a mean cannot fall outside its own spread — so the
   * `history` test silently becomes unfailable. That shipped on 2026-08-15
   * and made triage answer `noise` for a release 25.8 points under the gate.
   *
   * With replicates the question changes from "is this draw unusual for this
   * config?" to "is this CONFIG below the gate, given how well we know its
   * mean?", which is a standard-error test against the threshold.
   */
  replicates?: readonly number[];
  /** Per-scorer averages, 0..1, e.g. { "llm-correctness": 0.4, "llm-relevance": 1 }. */
  scorers?: Record<string, number> | null;
  /** From coverage-audit.ts. */
  coverage?: {
    sitemapUrlCount: number;
    ingestedUrlCount: number;
    duplicateCount: number;
  } | null;
  /** From corpus-audit.ts. */
  corpus?: {
    furnitureRatio: number;
    needsRecrawl: boolean;
  } | null;
  /**
   * Score from the COVERAGE suite — "can the assistant state what this site
   * publishes" — with its replicate count and sd.
   *
   * The strongest retrieval evidence available, and the only one whose failure
   * legitimately justifies a RAG arena. Measured 2026-08-16 across six
   * releases: five scored 18-31pp ABOVE their hazard score (retrieval fine,
   * shortfall is guardrail behaviour) and weights-and-biases scored 30.9pp
   * BELOW it (43.5% — it genuinely cannot answer from its own corpus).
   *
   * Probes say whether retrieval returned SOMETHING plausible; this says
   * whether the answer was actually right. w&b passed every probe.
   */
  coverageSuite?: { score: number; sd: number | null; n: number } | null;
  /**
   * Retrieval health from the `probe` step (probe-metrics.ts).
   *
   * This is the measurement that actually speaks to retrieval on this
   * pipeline. The ScoredQA suite is hazard-shaped by design — qa-suite-gen.ts
   * says so — so its score answers "does the assistant over-claim", NOT "did
   * retrieval work". Six releases were investigated as RAG failures on
   * 2026-08-16 before anyone read their probe lines.
   */
  probes?: { meanTop: number; minTop: number; emptyCount: number; weakCount: number; n: number } | null;
  /** From the arena's retrieval metrics, when gold chunks are labelled. */
  retrieval?: {
    recallAtK?: number | null;
    mrr?: number | null;
  } | null;
}

export interface TriageResult {
  verdict: TriageVerdict;
  /** Human-readable, ordered — each line is a measurement, not an opinion. */
  evidence: string[];
  /** Axes worth varying. EMPTY means "do not run an arena", and that is a result. */
  recommendedArms: ArmAxis[];
  noiseBand: NoiseBand | null;
  /** What to do next, in one line, for the Gate card. */
  nextAction: string;
}

/** Coverage below this reads as "we did not ingest the site". */
const COVERAGE_FLOOR = 0.8;
/** Furniture above this reads as "the corpus is mostly nav and footer". */
const FURNITURE_CEILING = 0.35;
/** Retrieval recall below this reads as "the index cannot find its own corpus". */
const RECALL_FLOOR = 0.6;
/** Replicates needed before any arm comparison is meaningful. */
export const MIN_REPLICATES = 3;

export function noiseBand(history: readonly number[]): NoiseBand | null {
  const xs = history.filter((x) => typeof x === "number" && Number.isFinite(x));
  if (xs.length < MIN_REPLICATES) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  // Population sd. These are replicates of one config, not a sample of some
  // wider population, and with n=3 the Bessel correction inflates the band by
  // 22% — enough to swallow a real difference we would want to act on.
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  return {
    n: xs.length,
    mean,
    sd,
    lo: Math.max(0, mean - 2 * sd),
    hi: Math.min(1, mean + 2 * sd),
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function triage(input: TriageInput): TriageResult {
  const evidence: string[] = [];
  const band = noiseBand(input.history ?? []);

  evidence.push(
    `score ${pct(input.qaScore)} vs gate ${pct(input.threshold)} ` +
      `(short by ${pct(input.threshold - input.qaScore)})`,
  );

  // ── 1a. Replicates of THIS release: test the mean against the GATE ───────
  // Not against a band built from the same samples — the mean is always inside
  // that, so the comparison is unfailable. What we can ask is whether the
  // config's true mean is below the threshold, given the standard error.
  const reps = (input.replicates ?? []).filter((x) => Number.isFinite(x));
  if (reps.length >= MIN_REPLICATES) {
    const m = reps.reduce((a, b) => a + b, 0) / reps.length;
    const sd = Math.sqrt(reps.reduce((a, b) => a + (b - m) ** 2, 0) / reps.length);
    const sem = sd / Math.sqrt(reps.length);
    const upper = m + 2 * sem;
    evidence.push(
      `${reps.length} replicates of this release: mean ${pct(m)} sd ${pct(sd)} ` +
        `→ 95% upper bound on the mean ${pct(upper)}`,
    );
    if (upper >= input.threshold) {
      // The config might genuinely meet the gate; this run's shortfall is not
      // established. More replicates would settle it.
      evidence.push(`that upper bound reaches the ${pct(input.threshold)} gate — the shortfall is NOT established`);
      return {
        verdict: "noise",
        evidence,
        recommendedArms: [],
        noiseBand: noiseBand(reps),
        nextAction: "Do not rebuild. Add replicates if you need to resolve it — the gate is inside this config's uncertainty.",
      };
    }
    evidence.push(`that upper bound is below the gate — this config really is short, not unlucky`);
    return diagnose(input, evidence, noiseBand(reps));
  }

  // ── 1b. Noise, before anything else ───────────────────────────────────────
  // Checked first because every downstream conclusion is a comparison, and a
  // comparison inside the noise band is not a conclusion.
  if (!band) {
    evidence.push(
      `only ${input.history?.length ?? 0} comparable prior run(s) — ` +
        `cannot separate a real regression from run-to-run spread ` +
        `(an unchanged config has been measured at 79/87/87 on this pipeline)`,
    );
    return {
      verdict: "inconclusive",
      evidence,
      recommendedArms: [],
      noiseBand: null,
      nextAction:
        `Re-run the SAME config ${MIN_REPLICATES}× to establish the noise band before changing anything.`,
    };
  }

  evidence.push(
    `noise band from ${band.n} replicates: mean ${pct(band.mean)} ± ${pct(2 * band.sd)} ` +
      `→ [${pct(band.lo)}, ${pct(band.hi)}]`,
  );

  if (input.qaScore >= band.lo) {
    // Inside the band. The run is not distinguishable from the runs that
    // passed, so rebuilding it is measuring noise at cost.
    evidence.push(
      `${pct(input.qaScore)} falls INSIDE that band — this run is not ` +
        `distinguishable from the config's own passing runs`,
    );
    return {
      verdict: "noise",
      evidence,
      recommendedArms: [],
      noiseBand: band,
      nextAction:
        "Do not rebuild. Either re-run for a cleaner draw, or raise the replicate count behind the gate.",
    };
  }
  evidence.push(`${pct(input.qaScore)} falls BELOW the band — a real regression`);
  return diagnose(input, evidence, band);
}

/**
 * Everything downstream of "the shortfall is real": corpus first, then
 * retrieval versus generation. Shared by both entry paths so the two cannot
 * drift apart.
 */
function diagnose(input: TriageInput, evidence: string[], band: NoiseBand | null): TriageResult {
  // ── 2. Corpus, before retrieval ───────────────────────────────────────────
  // This is where the only measured win came from, and a stack swap cannot fix
  // it: a better index over a corpus missing two thirds of the site still
  // cannot answer questions about the missing pages.
  if (input.coverage && input.coverage.sitemapUrlCount > 0) {
    const ratio = input.coverage.ingestedUrlCount / input.coverage.sitemapUrlCount;
    evidence.push(
      `coverage ${input.coverage.ingestedUrlCount}/${input.coverage.sitemapUrlCount} ` +
        `sitemap URLs ingested (${pct(ratio)})` +
        (input.coverage.duplicateCount ? `, ${input.coverage.duplicateCount} duplicated` : ""),
    );
    if (ratio < COVERAGE_FLOOR || input.coverage.duplicateCount > 0) {
      return {
        verdict: "corpus_coverage",
        evidence,
        recommendedArms: ["corpus_chunking"],
        noiseBand: band,
        nextAction:
          "Re-crawl for coverage, drop redirect stubs and duplicates, strip boilerplate — then re-measure BEFORE considering a stack change.",
      };
    }
  }

  if (input.corpus) {
    evidence.push(`page furniture ${pct(input.corpus.furnitureRatio)} of corpus`);
    if (input.corpus.needsRecrawl || input.corpus.furnitureRatio > FURNITURE_CEILING) {
      return {
        verdict: "corpus_coverage",
        evidence,
        recommendedArms: ["corpus_chunking"],
        noiseBand: band,
        nextAction: "Strip page furniture and re-ingest — the corpus is mostly nav and footer.",
      };
    }
  }

  // ── 2a. Coverage suite: the strongest retrieval evidence ─────────────────
  // Ranked above the probes because a probe only shows that retrieval returned
  // a plausible-looking chunk. weights-and-biases passed every probe (0 empty,
  // 0 weak) and still scored 43.5% on "state what this site publishes".
  const cov = input.coverageSuite ?? null;
  if (cov && cov.n >= 2) {
    const csem = cov.sd !== null && cov.n > 1 ? cov.sd / Math.sqrt(cov.n) : 0;
    const cUpper = cov.score + 2 * csem;
    evidence.push(
      `coverage suite: ${pct(cov.score)} over ${cov.n} replicate(s)` +
        (cov.sd !== null ? ` (sd ${pct(cov.sd)})` : "") +
        ` vs hazard ${pct(input.qaScore)}`,
    );

    if (cUpper < input.qaScore) {
      // Worse at stating published facts than at declining to over-claim. The
      // corpus is the binding constraint, and this is the one shape where a
      // retrieval arena is buying an answer rather than measuring noise.
      return {
        verdict: "retrieval_limited",
        evidence: [
          ...evidence,
          "the assistant answers guardrail questions better than it answers questions ITS OWN SITE ANSWERS — retrieval is the binding constraint",
        ],
        recommendedArms: ["corpus_chunking", "index_embedding", "agentic_search"],
        noiseBand: band,
        nextAction: `Arena warranted, and score it on the COVERAGE suite — sd ~0.5pp there resolves ~1pp at ${MIN_REPLICATES} replicates, against ~9pp on the hazard suite.`,
      };
    }

    if (cUpper < input.threshold) {
      // Retrieval is not the binding constraint, but there IS headroom. Only
      // the cheapest arm is justified: no ingestion-heavy index or agentic
      // rebuild for a gap this size.
      evidence.push(`coverage is above the hazard score but still short of the ${pct(input.threshold)} gate — some retrieval headroom, not the binding constraint`);
      return {
        verdict: "answer_incorrect",
        evidence,
        recommendedArms: ["corpus_chunking"],
        noiseBand: band,
        nextAction:
          "Corpus work only (coverage, dedupe, boilerplate). Do NOT fund index/embedding or agentic arms — the coverage score says retrieval is not what is holding this back.",
      };
    }

    evidence.push("coverage is at or above the gate — retrieval and grounding are demonstrably fine, so no retrieval arm is justified");
  }

  // ── 2b. Probe evidence: retrieval measured directly ──────────────────────
  // Placed before the scorer heuristics because it is a MEASUREMENT of
  // retrieval, where the scorers are an inference about it.
  const pr = input.probes ?? null;
  if (pr && pr.n >= 3) {
    evidence.push(
      `retrieval probes: n=${pr.n} meanTop ${pr.meanTop.toFixed(3)} minTop ${pr.minTop.toFixed(3)}` +
        (pr.emptyCount ? `, ${pr.emptyCount} EMPTY` : "") +
        (pr.weakCount ? `, ${pr.weakCount} weak` : ""),
    );
    if (pr.emptyCount > 0 || pr.weakCount > 0) {
      return {
        verdict: "retrieval_limited",
        evidence,
        recommendedArms: ["corpus_chunking", "index_embedding", "agentic_search"],
        noiseBand: band,
        nextAction: `Arena warranted — ${pr.emptyCount} probe(s) returned nothing and ${pr.weakCount} matched weakly. >=${MIN_REPLICATES} replicates per arm, compare on overlapping CIs.`,
      };
    }
    // Retrieval demonstrably works. Whatever is wrong is downstream of it, and
    // a retrieval arena would be measuring the wrong axis at real cost.
    evidence.push("every probe retrieved a strong match — retrieval is NOT the limiter, so no retrieval arm is justified");
  }

  // ── 3. Retrieval vs generation ────────────────────────────────────────────
  // Only reachable once the corpus is known good, so a poor score here really
  // is about finding or using the content.
  const recall = input.retrieval?.recallAtK ?? null;
  if (recall !== null) {
    evidence.push(
      `retrieval recall@k ${pct(recall)}` +
        (input.retrieval?.mrr != null ? `, MRR ${input.retrieval.mrr.toFixed(2)}` : ""),
    );
    if (recall < RECALL_FLOOR) {
      return {
        verdict: "retrieval_limited",
        evidence,
        recommendedArms: ["corpus_chunking", "index_embedding", "agentic_search"],
        noiseBand: band,
        nextAction:
          `Arena warranted. Vary chunking, index/embedding and agentic search; ≥${MIN_REPLICATES} replicates per arm, compare on overlapping CIs.`,
      };
    }
    // Retrieval is finding the right chunks and the answer is still wrong.
    return {
      verdict: "generation_limited",
      evidence,
      recommendedArms: ["base_model"],
      noiseBand: band,
      nextAction:
        "Retrieval is finding the right chunks — vary the answering model with retrieval held constant, so the result cannot be confused with a RAG result.",
    };
  }

  // ── 4. No retrieval metrics: the instrument is the unknown ────────────────
  // Corpus checks passed and there are no gold labels, so we cannot tell a bad
  // demo from a suite aimed at content the site does not publish. That
  // ambiguity is exactly what hid a 31-point improvement on Acme Renew.
  // Scorer split, when there are no retrieval metrics.
  //
  // ⚠️ READ THE SCORER BEFORE INFERRING FROM IT. An earlier version of this
  // block claimed that high relevance RULES OUT a mis-aimed suite, on the
  // reasoning that a suite asking about content the site does not publish
  // would score badly on relevance too. That is false. The prompt for
  // `llm-relevance` is:
  //
  //     "Classify generatedAnswer's topical relevance to inputPrompt
  //      (ignore correctness — that's a different scorer)"
  //
  // It compares the ANSWER to the QUESTION. It never inspects retrieved
  // context. So an assistant answering fluently from parametric knowledge
  // about a page the site never published scores 100% relevance while being
  // completely ungrounded — which is precisely the failure we would be trying
  // to detect.
  //
  // What high relevance + low correctness actually establishes: the answers
  // are on topic and wrong. The cause is NOT separable from these two numbers,
  // because all of "retrieved nothing useful", "retrieved something similar
  // but wrong" and "retrieved the right passage and ignored it" produce the
  // identical signature. Naming a cause here would be a guess with a verdict
  // attached to it.
  const sc = input.scorers ?? null;
  const pick = (want: string): number | null => {
    if (!sc) return null;
    const k = Object.keys(sc).find((x) => x.toLowerCase().includes(want));
    return k ? sc[k] : null;
  };
  const relevance = pick("relevance");
  const correctness = pick("correctness");
  if (relevance !== null && correctness !== null) {
    evidence.push(`scorers: relevance ${pct(relevance)}, correctness ${pct(correctness)}`);
    if (relevance < 0.6) {
      // Off-topic answers point at the questions themselves.
      return {
        verdict: "suite_mis_aimed",
        evidence: [...evidence, "answers are not even on topic — suspect the questions before the stack"],
        recommendedArms: [],
        noiseBand: band,
        nextAction:
          "Generate a coverage suite (coverage-suite.ts) and re-score. If it passes, the standing suite is the defect.",
      };
    }
    if (correctness < relevance - 0.15) {
      const probesHealthy = pr !== null && pr.n >= 3 && pr.emptyCount === 0 && pr.weakCount === 0;
      return {
        verdict: "answer_incorrect",
        evidence: [
          ...evidence,
          "answers are on topic and wrong — but relevance compares the ANSWER to the QUESTION and never sees the retrieved context, so this does NOT show whether retrieval or generation is at fault",
        ],
        recommendedArms: [],
        noiseBand: band,
        nextAction: probesHealthy
          ? "Retrieval already measured healthy by the probe step, so the shortfall is downstream of it. Read the failing tests before spending: on this pipeline the generated suite is HAZARD-shaped, and its failures are usually the assistant answering a question it was supposed to decline."
          : "Re-score with the RAGAS preset (context_recall + context_precision + faithfulness). context_recall low ⇒ retrieval; recall high with faithfulness low ⇒ generation. Cheaper than any arm, and it turns this into a diagnosable case.",
      };
    }
  }

  evidence.push("no labelled retrieval metrics — cannot separate a weak demo from a mis-aimed suite");
  return {
    verdict: "suite_mis_aimed",
    evidence,
    recommendedArms: [],
    noiseBand: band,
    nextAction:
      "Generate a coverage suite (coverage-suite.ts) and re-score. If the coverage suite passes, the standing suite is the defect, not the demo.",
  };
}

/** One-screen summary for the Gate card. */
export function formatTriage(t: TriageResult): string {
  const arms = t.recommendedArms.length
    ? t.recommendedArms.map((a) => `\`${a}\``).join(", ")
    : "_none — spending here would measure noise_";
  return [
    `### QA triage — \`${t.verdict}\``,
    "",
    ...t.evidence.map((e) => `- ${e}`),
    "",
    `**Arms worth running:** ${arms}`,
    "",
    `**Next:** ${t.nextAction}`,
  ].join("\n");
}
