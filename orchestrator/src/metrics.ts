/**
 * metrics.ts — turn the run artifacts already on disk into a dataset.
 *
 * Every demo run leaves state.json (steps, timings, QA scores) and
 * manifest.json (sources, scraper, tier) behind. Nothing reads them across
 * runs, so ~106 runs of evidence about how well "a website becomes a custom
 * language model" has been accumulating unexamined.
 *
 * DERIVED, NOT INSTRUMENTED — deliberately. Every field here comes from files
 * the pipeline already writes, so the whole history is available retroactively
 * rather than only runs from today forward. That constraint is worth keeping:
 * a metric that needs new instrumentation only ever describes the future, and
 * the interesting comparisons (fetch-scraper vs browser-rendering, corpus size
 * vs QA score) need the past.
 *
 * Feeds: release metrics, TrustBench aggregate numbers, and cross-run analysis.
 *
 * ⚠️ Emit RAW COUNTS, never only percentages. A "94.2%" with no denominator
 * cannot be pooled across runs, weighted, or re-tested later — and pooling is
 * the entire point of collecting these. Keep qaPassedCount/qaTestCount beside
 * qaScore for the same reason.
 */
import type { RunState } from "./types.js";

export interface StepTiming {
  step: string;
  /** Seconds from this step's first log line to the next step's. */
  seconds: number;
}

export interface RunMetrics {
  prospect: string;
  run: string;
  /** Terminal step reached: done | outreach | ingest | vector | … */
  step: string;
  reachedGate3: boolean;
  completed: boolean;

  // ---- corpus
  pagesCrawled: number | null;
  sourceCount: number | null;
  /** Distinct scraper tool ids across the manifest's sources. */
  scrapers: string[];
  /** Sources whose crawl exited non-zero but still indexed pages. */
  partialCrawls: number;

  // ---- compliance (from the queue entry, not the run)
  complianceTier: string | null;
  complianceFlags: string[];

  // ---- quality
  qaScore: number | null;
  qaPassedCount: number | null;
  qaTestCount: number | null;
  qaMinTestScore: number | null;
  scorerCorrectness: number | null;
  scorerRelevance: number | null;
  scorerCompleteness: number | null;

  // ---- global corpus contribution
  wwwRagSubmitted: number | null;
  wwwRagFailed: number | null;

  // ---- cost / duration
  stepTimings: StepTiming[];
  totalSeconds: number | null;

  // ---- failure surface
  advisoryFailures: string[];
  hardFailure: string | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Step durations from log timestamps. A step ends when the next one starts. */
export function stepTimings(log: { at: string; msg: string }[]): StepTiming[] {
  const marks: { step: string; t: number }[] = [];
  for (const e of log) {
    const m = /^step: ([a-z0-9]+)/i.exec(e.msg);
    if (!m) continue;
    const t = Date.parse(e.at);
    if (Number.isNaN(t)) continue;
    // A resumed run re-enters a step; keep the LAST entry so the duration is
    // the attempt that actually progressed, not a stale one from days before.
    marks.push({ step: m[1]!, t });
  }
  const out: StepTiming[] = [];
  for (let i = 0; i < marks.length - 1; i++) {
    const secs = (marks[i + 1]!.t - marks[i]!.t) / 1000;
    // Negative or absurd gaps mean the run was resumed across days — that is
    // wall-clock, not work, and averaging it in would make every step look
    // hours long. Cap at 2h and drop negatives.
    if (secs < 0 || secs > 7200) continue;
    out.push({ step: marks[i]!.step, seconds: Math.round(secs) });
  }
  return out;
}

/** Advisory steps that logged a failure but did not stop the run. */
export function advisoryFailures(log: { msg: string }[]): string[] {
  return log
    .filter((e) => /ADVISORY STEP FAILED|design review skipped|could not verify ks guard/i.test(e.msg))
    .map((e) => e.msg.split("—")[0]!.trim().slice(0, 80));
}

export function countPartialCrawls(log: { msg: string }[]): number {
  return log.filter((e) => /accepting partial corpus/i.test(e.msg)).length;
}

/** www-rag tallies are only in the log line, not in a field. */
export function wwwRagTallies(log: { msg: string }[]): { submitted: number | null; failed: number | null } {
  let submitted: number | null = null;
  let failed: number | null = null;
  for (const e of log) {
    const m = /wwwrag: (\d+) submitted, \d+ already, \d+ denied, (\d+) failed/.exec(e.msg);
    if (m) {
      submitted = Number(m[1]);
      failed = Number(m[2]);
    }
  }
  return { submitted, failed };
}

export interface ManifestLike {
  sources?: { crawl?: { scraper?: string } }[];
}
export interface QueueEntryLike {
  complianceTier?: string;
  complianceFlags?: string[];
}

/**
 * Fields the pipeline writes that `RunState` does not declare. Named here
 * rather than reached via a cast: a cast to Record<string, unknown> compiles
 * away the typo protection, which is how `after["recall@10"]` survived in the
 * Harvey summary — a misspelled key reads as an absent metric.
 */
export interface RunStateMetrics {
  qaScoreAverages?: Record<string, number>;
  qaMinTestScore?: number;
  qaPassedCount?: number;
  qaTestCount?: number;
}

export function extractRunMetrics(
  state: RunState & RunStateMetrics,
  manifest?: ManifestLike,
  queueEntry?: QueueEntryLike,
): RunMetrics {
  const log = (state.log ?? []) as { at: string; msg: string }[];
  const timings = stepTimings(log);
  const avgs = state.qaScoreAverages ?? {};
  const tallies = wwwRagTallies(log);

  const scrapers = [
    ...new Set(
      (manifest?.sources ?? []).map((s) => s.crawl?.scraper ?? "@divinci-ai/fetch-scraper"),
    ),
  ].sort();

  return {
    prospect: state.prospect,
    run: state.run,
    step: state.step,
    // `outreach` is the terminal state for a finished demo — Gate 3 blocks by
    // design, so "done" is rarer than success. Counting only `done` as success
    // would report most completed demos as failures.
    reachedGate3: state.step === "outreach" || state.step === "done",
    completed: state.step === "done",

    pagesCrawled: num(state.pagesCrawled),
    sourceCount: manifest?.sources?.length ?? null,
    scrapers,
    partialCrawls: countPartialCrawls(log),

    complianceTier: queueEntry?.complianceTier ?? null,
    complianceFlags: queueEntry?.complianceFlags ?? [],

    qaScore: num(state.qaScore),
    qaPassedCount: num(state.qaPassedCount),
    qaTestCount: num(state.qaTestCount),
    qaMinTestScore: num(state.qaMinTestScore),
    scorerCorrectness: num(avgs["llm-correctness"]),
    scorerRelevance: num(avgs["llm-relevance"]),
    scorerCompleteness: num(avgs["llm-completeness"]),

    wwwRagSubmitted: tallies.submitted,
    wwwRagFailed: tallies.failed,

    stepTimings: timings,
    totalSeconds: timings.length ? timings.reduce((a, t) => a + t.seconds, 0) : null,

    advisoryFailures: advisoryFailures(log),
    hardFailure: null,
  };
}

// ------------------------------------------------------------------ aggregate

export interface Summary {
  runs: number;
  reachedGate3: number;
  withQa: number;
  qa: Stats | null;
  qaMinTest: Stats | null;
  correctness: Stats | null;
  relevance: Stats | null;
  completeness: Stats | null;
  pages: Stats | null;
  byScraper: Record<string, { runs: number; qa: Stats | null; partialRate: number }>;
  byTier: Record<string, { runs: number; qa: Stats | null }>;
  partialCrawlRuns: number;
  wwwRagSubmittedTotal: number;
  wwwRagFailedTotal: number;
}

export interface Stats { n: number; mean: number; sd: number; min: number; max: number; median: number }

export function stats(xs: number[]): Stats | null {
  const v = xs.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  // Sample sd (n-1). With n=1 the population form would report 0, which reads
  // as "no variance measured" rather than "not measurable from one point".
  const sd = v.length > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1)) : NaN;
  const mid = Math.floor(v.length / 2);
  return {
    n: v.length,
    mean,
    sd,
    min: v[0]!,
    max: v[v.length - 1]!,
    median: v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2,
  };
}

export function aggregate(rows: RunMetrics[]): Summary {
  const qa = rows.map((r) => r.qaScore).filter((x): x is number => x !== null);
  const byScraper: Summary["byScraper"] = {};
  for (const r of rows) {
    for (const s of r.scrapers.length ? r.scrapers : ["(unknown)"]) {
      const b = (byScraper[s] ??= { runs: 0, qa: null, partialRate: 0 });
      b.runs++;
    }
  }
  for (const s of Object.keys(byScraper)) {
    const sub = rows.filter((r) => (r.scrapers.length ? r.scrapers : ["(unknown)"]).includes(s));
    byScraper[s]!.qa = stats(sub.map((r) => r.qaScore).filter((x): x is number => x !== null));
    byScraper[s]!.partialRate = sub.length ? sub.filter((r) => r.partialCrawls > 0).length / sub.length : 0;
  }
  const byTier: Summary["byTier"] = {};
  for (const r of rows) {
    const t = r.complianceTier ?? "(unknown)";
    (byTier[t] ??= { runs: 0, qa: null }).runs++;
  }
  for (const t of Object.keys(byTier)) {
    const sub = rows.filter((r) => (r.complianceTier ?? "(unknown)") === t);
    byTier[t]!.qa = stats(sub.map((r) => r.qaScore).filter((x): x is number => x !== null));
  }

  return {
    runs: rows.length,
    reachedGate3: rows.filter((r) => r.reachedGate3).length,
    withQa: qa.length,
    qa: stats(qa),
    qaMinTest: stats(rows.map((r) => r.qaMinTestScore).filter((x): x is number => x !== null)),
    correctness: stats(rows.map((r) => r.scorerCorrectness).filter((x): x is number => x !== null)),
    relevance: stats(rows.map((r) => r.scorerRelevance).filter((x): x is number => x !== null)),
    completeness: stats(rows.map((r) => r.scorerCompleteness).filter((x): x is number => x !== null)),
    pages: stats(rows.map((r) => r.pagesCrawled).filter((x): x is number => x !== null)),
    byScraper,
    byTier,
    partialCrawlRuns: rows.filter((r) => r.partialCrawls > 0).length,
    wwwRagSubmittedTotal: rows.reduce((a, r) => a + (r.wwwRagSubmitted ?? 0), 0),
    wwwRagFailedTotal: rows.reduce((a, r) => a + (r.wwwRagFailed ?? 0), 0),
  };
}
