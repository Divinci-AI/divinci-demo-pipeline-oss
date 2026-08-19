/**
 * probe-metrics.ts — turn the retrieval probe log lines into DATA.
 *
 * WHY
 * ===
 * `qa-suite-gen.ts` says it plainly: the generated ScoredQA suite is
 * "deliberately HAZARD-SHAPED rather than coverage-shaped. Retrieval quality is
 * already measured by the `probe` step". So the QA score everything gates on
 * measures whether the assistant OVER-CLAIMS, and retrieval quality is measured
 * somewhere else — in log lines, as text, which nothing has ever read across
 * runs.
 *
 * That gap produced a real detour on 2026-08-16. Six releases scoring 59-77%
 * were investigated as candidate RAG failures, and a multi-arm retrieval arena
 * was costed for them. Reading their probe lines took seconds and showed
 * retrieval was fine on every one (top similarity 0.71-0.88, five chunks,
 * visibly on-target text). The failures were hazard tests — "predict our p99
 * latency", "when does X ship", "is Milvus faster than Pinecone" — where the
 * expected answer is a REFUSAL and the assistant answered anyway. No index,
 * embedding or chunker changes that.
 *
 * Structured here so the next such question is answered by a query rather than
 * by an investigation, and so triage can see retrieval health directly instead
 * of inferring it from scorers that never look at retrieved context.
 *
 * DERIVED, NOT INSTRUMENTED — same rule as metrics.ts. These lines are already
 * in every run's state.log, so the whole back-catalogue is readable
 * retroactively rather than only runs from today forward.
 */

/** One `probe "question": top=0.855 chunks=5 | text…` line. */
export interface ProbeResult {
  question: string;
  /** Similarity of the best-matching chunk, 0..1. */
  top: number;
  /** How many chunks came back. Zero is a dark index. */
  chunks: number;
  /** Leading text of the top chunk, when the line carried it. */
  preview: string;
}

export interface ProbeMetrics {
  n: number;
  meanTop: number;
  minTop: number;
  maxTop: number;
  /** Probes returning no chunks at all. Any is a retrieval defect. */
  emptyCount: number;
  /** Probes whose best match is below WEAK_TOP. */
  weakCount: number;
  meanChunks: number;
}

/**
 * Below this, the best chunk is not a convincing match.
 *
 * Calibrated against observed healthy runs (zilliz, acmeparts, pinecone all sat
 * 0.71-0.88 with answers that were visibly on-topic), NOT chosen a priori.
 * It is a screening threshold for "look at this", not a pass mark.
 */
export const WEAK_TOP = 0.6;

const LINE = /^probe\s+"([^"]*)":\s*top=([\d.]+)\s+chunks=(\d+)(?:\s*\|\s*(.*))?$/;

export function parseProbeLine(msg: string): ProbeResult | null {
  const m = LINE.exec(msg.trim());
  if (!m) return null;
  const top = Number(m[2]);
  const chunks = Number(m[3]);
  if (!Number.isFinite(top) || !Number.isFinite(chunks)) return null;
  return { question: m[1], top, chunks, preview: (m[4] ?? "").trim() };
}

export function parseProbes(log: readonly { msg: string }[]): ProbeResult[] {
  const out: ProbeResult[] = [];
  for (const e of log) {
    const r = parseProbeLine(String(e?.msg ?? ""));
    if (r) out.push(r);
  }
  return out;
}

export function summariseProbes(probes: readonly ProbeResult[]): ProbeMetrics | null {
  if (!probes.length) return null;
  const tops = probes.map((p) => p.top);
  return {
    n: probes.length,
    meanTop: tops.reduce((a, b) => a + b, 0) / tops.length,
    minTop: Math.min(...tops),
    maxTop: Math.max(...tops),
    // A probe that returns nothing is the failure mode a similarity average
    // hides: nine good probes and one dark one still average well.
    emptyCount: probes.filter((p) => p.chunks === 0).length,
    weakCount: probes.filter((p) => p.top < WEAK_TOP).length,
    meanChunks: probes.reduce((a, b) => a + b.chunks, 0) / probes.length,
  };
}

/**
 * Is retrieval healthy enough that a RAG arena would be measuring the wrong
 * thing?
 *
 * Deliberately conservative in one direction: it answers "healthy" only when
 * nothing is empty, nothing is weak, and the mean is comfortably above the
 * screening threshold. Anything else returns false, which merely means "do not
 * rule retrieval out" — never "retrieval is broken".
 */
export function retrievalLooksHealthy(m: ProbeMetrics | null): boolean {
  if (!m || m.n < 3) return false;
  return m.emptyCount === 0 && m.weakCount === 0 && m.meanTop >= WEAK_TOP + 0.1;
}
