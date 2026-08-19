/**
 * qa-replicates.ts — pooling N scored runs of ONE release into one result.
 *
 * WHY REPLICATES AT ALL
 * =====================
 * Measured across the whole back-catalogue on 2026-08-15: 72 scored runs
 * spread over 71 prospects. Almost every release has been scored exactly once,
 * so the dataset contains no replicates and nothing can distinguish a real
 * regression from an unlucky draw. The one replicate measurement that exists —
 * Acme Renew arm A, UNCHANGED — came out 79 / 87 / 87.
 *
 * An 8-point spread on an unchanged config means a single draw decides whether
 * a demo publishes. It also means every downstream comparison (triage's noise
 * band, arena arms, the whole experiment programme) rests on one sample per
 * config. Replicates are the cheapest possible input: no re-crawl, no
 * re-ingest, just the suite again against the same release.
 *
 * The functions here are pure so the pooling rules — which are opinionated —
 * are testable without running a suite.
 */

export interface ReplicateSummary {
  n: number;
  /** The point estimate. Beats any single draw. */
  mean: number;
  /** Population sd. null when n < 2, because one run has no spread. */
  sd: number | null;
  min: number;
  max: number;
}

export function summariseReplicates(scores: readonly number[]): ReplicateSummary | null {
  const xs = scores.filter((x) => typeof x === "number" && Number.isFinite(x));
  if (!xs.length) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  // Population sd, matching qa-triage.ts: these are replicates of one config,
  // not a sample of a wider population, and at n=3 Bessel inflates the spread
  // by 22% — enough to hide a difference worth acting on.
  const sd =
    xs.length > 1
      ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length)
      : null;
  return { n: xs.length, mean, sd, min: Math.min(...xs), max: Math.max(...xs) };
}

/**
 * Index of the replicate to quote counts and a run link from.
 *
 * The MEDIAN, not the best and not the mean. Two properties matter:
 *
 *  - it is a REAL run, so the passed/total counts we report and the run
 *    someone opens in the UI are the same event. A synthetic blend of counts
 *    matches no run at all, and "7/10 passed" that exists nowhere is worse
 *    than a slightly unrepresentative one that does.
 *  - it is not the maximum. Quoting the best replicate is how a pipeline
 *    reports 87% for a config that also produces 79%.
 *
 * Ties and even counts resolve to the upper-middle element, which is
 * arbitrary but deterministic — the alternative is a result that changes when
 * the runs arrive in a different order.
 */
export function medianIndex(scores: readonly number[]): number {
  if (!scores.length) return -1;
  const order = scores.map((s, i) => ({ s, i })).sort((a, b) => a.s - b.s || a.i - b.i);
  return order[Math.floor(order.length / 2)].i;
}

/**
 * Per-scorer averages across replicates.
 *
 * A scorer missing from some replicates is averaged over the ones that have
 * it, not treated as zero — an absent scorer means "this run did not report
 * it", and scoring it 0 would quietly punish a config for a reporting gap.
 */
export function averageScorers(
  perReplicate: readonly (Record<string, number> | undefined)[],
): Record<string, number> {
  const keys = new Set<string>();
  for (const r of perReplicate) for (const k of Object.keys(r ?? {})) keys.add(k);
  const out: Record<string, number> = {};
  for (const k of keys) {
    const vals = perReplicate
      .map((r) => r?.[k])
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    if (vals.length) out[k] = vals.reduce((a, b) => a + b, 0) / vals.length;
  }
  return out;
}

/**
 * The weakest single test seen across ALL replicates.
 *
 * Deliberately the worst observed rather than the median run's worst: this is
 * the safety signal. A 0%-correctness answer that appeared in one run of three
 * is still an answer the demo can produce — and this pipeline has already
 * shipped a fabricated post-op rehab protocol inside a "10/10 passed" run.
 */
export function worstTestScore(perReplicateTests: readonly (readonly number[])[]): number | null {
  const all = perReplicateTests.flat().filter((v) => typeof v === "number" && Number.isFinite(v));
  return all.length ? Math.min(...all) : null;
}
