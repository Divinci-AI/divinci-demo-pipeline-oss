/**
 * arena-proposal.ts — turn a triage verdict into a COSTED experiment, and stop.
 *
 * This module proposes. It never ingests, never scores, never spends. The
 * output is a plan on a review-board card that a human approves, because the
 * expensive stage of the below-threshold path should not start itself.
 *
 * WHY IT IS SHAPED THIS WAY
 * =========================
 * Two measurements from 2026-08-15 set every constant here.
 *
 * 1. **The noise floor.** Acme Renew arm A, config UNCHANGED, scored 79 / 87 /
 *    87 — σ ≈ 3.8pp. Across the whole back-catalogue the between-prospect sd
 *    is 8.7pp. So:
 *      - arms MUST be compared within ONE prospect (paired). Comparing across
 *        prospects fights 8.7pp of "this site is harder", which has nothing to
 *        do with retrieval.
 *      - a difference smaller than the minimum detectable effect is not a
 *        result. At 3 replicates per arm the MDE is ~8.7pp; resolving a 2pp
 *        stack difference would need ~60 per arm and is not worth proposing.
 *
 * 2. **Where the wins actually were.** Swapping the entire retrieval stack
 *    moved the mean 84.3% → 84.0% — nothing. Fixing corpus coverage was worth
 *    +31. So `corpus_chunking` is always the first arm when triage allows it,
 *    and the proposal says plainly that the expensive arms have never yet paid.
 *
 * DESIGN: one factor at a time, not factorial
 * ===========================================
 * Four axes crossed at two levels is 16 arms; at 3 replicates that is 48 runs
 * plus 16 ingestions to resolve ~8.7pp. So each arm varies ONE axis from the
 * baseline. The honest cost of that choice: OFAT cannot see interactions — if
 * a new chunker only helps under an agentic index, this design will miss it.
 * That is a real limitation and is stated in the proposal rather than hidden,
 * because the alternative is unaffordable rather than wrong.
 */
import type { ArmAxis, TriageResult } from "./qa-triage.js";
import type { RagStackDescriptor } from "./rag-stack.js";
import { stackKey } from "./rag-stack.js";

/** z(0.975) + z(0.80) — two-sided α=0.05, 80% power. */
const Z_SUM = 1.96 + 0.84;

/** Fallback σ in percentage points when a run has no replicates of its own. */
export const MEASURED_SIGMA_PP = 3.8;

export interface ArmSpec {
  id: string;
  axis: ArmAxis | "baseline";
  label: string;
  /** What differs from the baseline. One line, imperative. */
  change: string;
  /** Fresh ingestions this arm needs (0 = reuses the existing index). */
  ingestions: number;
  /** Known hazard, surfaced before anyone runs it. */
  risk?: string;
}

export interface ArenaProposal {
  prospect: string;
  baselineStack: string;
  sigmaPp: number;
  replicatesPerArm: number;
  /** Smallest difference this design can resolve, in percentage points. */
  mdePp: number;
  arms: ArmSpec[];
  totals: { ingestions: number; qaRuns: number };
  preconditions: string[];
  caveats: string[];
}

/** Smallest true difference resolvable with n per arm, two-sample. */
export function minimumDetectableEffect(sigmaPp: number, nPerArm: number): number {
  if (nPerArm < 2) return Infinity;
  return Z_SUM * sigmaPp * Math.sqrt(2 / nPerArm);
}

/** Replicates per arm needed to resolve a difference of deltaPp. */
export function replicatesFor(sigmaPp: number, deltaPp: number): number {
  if (deltaPp <= 0) return Infinity;
  return Math.ceil((2 * Z_SUM ** 2 * sigmaPp ** 2) / deltaPp ** 2);
}

export interface ProposalInput {
  prospect: string;
  triage: TriageResult;
  baseline: RagStackDescriptor | null;
  /** Replicates already scored for the baseline — they count toward its arm. */
  existingReplicates: number;
  /** Observed sd of those replicates, in percentage points. */
  sigmaPp?: number | null;
  /** Effect worth chasing. Smaller targets cost quadratically more. */
  targetEffectPp?: number;
  /** Hard cap; the proposal reports the resulting MDE rather than exceeding it. */
  maxReplicatesPerArm?: number;
}

function armsForAxis(axis: ArmAxis, baseline: RagStackDescriptor | null): ArmSpec[] {
  const idx = baseline?.indexTool ?? "the current index";
  const emb = baseline?.embeddingModel ?? "the current embedding model";
  switch (axis) {
    case "corpus_chunking":
      return [
        {
          id: "B-corpus",
          axis,
          label: "Corpus coverage + hygiene",
          change:
            "Re-crawl to full sitemap coverage, drop redirect stubs and duplicate URLs, strip boilerplate present on ≥60% of pages. Index and embedding unchanged.",
          ingestions: 1,
          risk:
            "The only change measured to move the score (+31pp on Acme Renew). Run it FIRST — a better index over a corpus missing two thirds of the site still cannot answer about the missing pages.",
        },
      ];
    case "index_embedding":
      return [
        {
          id: "C-index",
          axis,
          label: "Index + embedding swap",
          change: `Rebuild on a different vector index and embedding (from ${idx} / ${emb}). Corpus held constant.`,
          ingestions: 1,
          risk:
            "This exact swap measured 84.3% → 84.0% on Acme Renew — no gain. Worth an arm only because one negative result is not a law, and it is cheap once the corpus is fixed.",
        },
      ];
    case "agentic_search":
      return [
        {
          id: "D-agentic",
          axis,
          label: "Agentic / structural retrieval",
          change:
            "Build one of PageIndex (tree search, no vector lookup), RAPTOR (hierarchical summaries) or LightRAG (entity graph) over the same corpus.",
          ingestions: 1,
          risk:
            "Structurally different retrieval, so the most plausible source of a large effect — and the most expensive arm to build. Its index must be proven non-empty before it is scored.",
        },
      ];
    case "base_model":
      return [
        {
          id: "E-model",
          axis,
          label: "Answering model",
          change:
            "Vary the answering model with retrieval held EXACTLY constant — same release, same index, same corpus.",
          ingestions: 0,
          risk:
            "Measures generation, not retrieval. Keep it on its own axis so a win here is never reported as a RAG result.",
        },
      ];
  }
}

/**
 * Build the proposal, or return null when no experiment is justified.
 *
 * Returns null for `noise`, `inconclusive` and `suite_mis_aimed` — triage
 * recommends no arms for those, and an empty arena is a real answer rather
 * than a failure to plan one.
 */
export function proposeArena(input: ProposalInput): ArenaProposal | null {
  const axes = input.triage.recommendedArms;
  if (!axes.length || !input.baseline) return null;

  const sigmaPp =
    typeof input.sigmaPp === "number" && input.sigmaPp > 0 ? input.sigmaPp : MEASURED_SIGMA_PP;
  const target = input.targetEffectPp ?? 10;
  const cap = input.maxReplicatesPerArm ?? 5;

  // Size for the target, then honour the cap and report what that leaves us
  // able to resolve. Silently exceeding a budget is how an experiment gets
  // approved and then abandoned half-run.
  const wanted = replicatesFor(sigmaPp, target);
  const replicatesPerArm = Math.max(2, Math.min(cap, wanted));
  const mdePp = minimumDetectableEffect(sigmaPp, replicatesPerArm);

  const variants = axes.flatMap((a) => armsForAxis(a, input.baseline));
  const baselineArm: ArmSpec = {
    id: "A-baseline",
    axis: "baseline",
    label: "Baseline (current stack)",
    change: `Unchanged: ${stackKey(input.baseline)}`,
    ingestions: 0,
    risk:
      "Not a control to skip. Its replicates ARE the noise band, and every comparison is against it.",
  };
  const arms = [baselineArm, ...variants];

  // Replicates already scored count toward the baseline arm.
  const baselineQaRuns = Math.max(0, replicatesPerArm - input.existingReplicates);
  const qaRuns = baselineQaRuns + variants.length * replicatesPerArm;
  const ingestions = arms.reduce((a, b) => a + b.ingestions, 0);

  return {
    prospect: input.prospect,
    baselineStack: stackKey(input.baseline),
    sigmaPp,
    replicatesPerArm,
    mdePp,
    arms,
    totals: { ingestions, qaRuns },
    preconditions: [
      "Every arm must prove a NON-EMPTY index before it is scored. Acme Renew arm B1 never produced a usable one; scored blind it would have read as 'that stack is worse' rather than 'that arm did not run'.",
      "All arms run against the SAME prospect. Between-prospect sd is 8.7pp — comparing arms across sites measures site difficulty, not retrieval.",
      "Suite, judge and answering model held constant across arms, except on the base_model arm where the model is the variable.",
    ],
    caveats: [
      `One factor at a time: each arm varies a single axis. Interactions are invisible to this design — a chunker that only helps under an agentic index will read as no effect.`,
      `Differences smaller than ${mdePp.toFixed(1)}pp are UNRESOLVED, not ties. Do not pick a winner inside that band.`,
      wanted > cap
        ? `Sized down: resolving ${target}pp wants ${wanted} replicates/arm, capped at ${cap}. This design resolves ${mdePp.toFixed(1)}pp.`
        : `Sized for a ${target}pp effect at 80% power.`,
    ],
  };
}

export function formatProposal(p: ArenaProposal): string {
  const rows = p.arms
    .map(
      (a) =>
        `| \`${a.id}\` | ${a.label} | ${a.change} | ${a.ingestions} |`,
    )
    .join("\n");
  return [
    `### 🧪 Arena proposal — ${p.prospect}`,
    "",
    `**Nothing has been run.** This is a costed plan awaiting approval.`,
    "",
    `- baseline stack: \`${p.baselineStack}\``,
    `- σ used: **${p.sigmaPp.toFixed(1)}pp** · replicates/arm: **${p.replicatesPerArm}** · resolves ≥ **${p.mdePp.toFixed(1)}pp**`,
    `- cost: **${p.totals.qaRuns} QA runs**, **${p.totals.ingestions} ingestions**`,
    "",
    "| arm | what | change | ingestions |",
    "|---|---|---|---|",
    rows,
    "",
    "**Preconditions**",
    ...p.preconditions.map((s) => `- ${s}`),
    "",
    "**Read this before interpreting the result**",
    ...p.caveats.map((s) => `- ${s}`),
    "",
    "_Approve by moving this card to IN_PROGRESS. Nothing runs until then._",
  ].join("\n");
}
