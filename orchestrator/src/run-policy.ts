/**
 * Pipeline order and gate policy — the decisions, separated from the doing.
 *
 * WHY THIS EXISTS. run.ts is ~1,700 lines and executes the pipeline on import,
 * so none of it can be unit-tested; the ordering bug that made ScoredQA
 * impossible for every fresh run lived there undetected for two months and was
 * found by reading, not by a test.
 *
 * This module holds the parts where that class of bug hides — what runs, in
 * what order, and what a gate will accept — as plain data and pure functions.
 * run.ts asserts at startup that its executable step list matches STEP_ORDER,
 * so the order these tests verify is provably the order that runs.
 *
 * It is a slice, not the whole refactor: the twelve step BODIES still live in
 * run.ts closing over module-level state. Extracting those means threading a
 * context through 159 references, and the only end-to-end verification
 * available is a DRY_RUN smoke that stubs every boundary — so it wants a
 * session with a real staging run to check against, not a late-night sweep.
 */

/**
 * The canonical pipeline order.
 *
 * ⚠️ `release` MUST precede `qa`. qaEval needs the RAG vector attached to the
 * release, and attaching it to a never-published draft 500s on staging, so the
 * link can only happen after publish — and `release` is also what assigns
 * state.releaseId at all. While qa ran first, every fresh run reached it with
 * no release, logged "skipping ScoredQA" and produced no score.
 */
export const STEP_ORDER = [
  "gate1",
  "workspace",
  "vector",
  "ingest",
  "wwwrag",
  "hygiene",
  "probe",
  "release",
  "qa",
  "gate2",
  "landing",
  "outreach",
] as const;

export type StepName = (typeof STEP_ORDER)[number];

/** Steps that end in a human decision. */
export const GATE_STEPS: readonly string[] = ["gate1", "gate2", "landing", "outreach"];

export function isGateStep(step: string): boolean {
  return GATE_STEPS.includes(step);
}

/** Steps that cost money, and therefore must sit behind Gate 1. */
export const SPEND_STEPS: readonly string[] = ["workspace", "vector", "ingest", "release", "qa", "landing"];

/**
 * The invariants that make the pipeline safe, checked as data rather than
 * trusted. Returns a list of violations; empty means well-formed.
 */
export function stepOrderViolations(order: readonly string[]): string[] {
  const errors: string[] = [];
  const at = (s: string) => order.indexOf(s);

  if (new Set(order).size !== order.length) errors.push("duplicate step names");

  for (const required of ["gate1", "release", "qa", "gate2", "landing", "outreach"])
    if (at(required) < 0) errors.push(`missing step: ${required}`);
  if (errors.length) return errors;

  if (at("gate1") !== 0) errors.push("gate1 must be first — it guards all spend");
  for (const s of SPEND_STEPS)
    if (at(s) >= 0 && at(s) < at("gate1")) errors.push(`${s} spends money before gate1`);

  if (at("release") > at("qa"))
    errors.push("release must precede qa — qa cannot score a release that does not exist yet");
  if (at("qa") > at("gate2")) errors.push("qa must precede gate2 — the gate needs evidence to judge");
  if (at("landing") < at("gate2"))
    errors.push("landing must follow gate2 — the link sent to a prospect is deployed only after review");
  if (at("outreach") < at("landing")) errors.push("outreach must follow landing");

  return errors;
}

/** Where to resume from. */
export function resolveCursor(stateStep: string, order: readonly string[] = STEP_ORDER): number {
  const i = order.indexOf(stateStep);
  if (i < 0) throw new Error(`unknown step in state.json: ${stateStep}`);
  return i;
}

/** Validate an ONLY_STEPS override. */
export function validateOnlySteps(only: readonly string[], order: readonly string[] = STEP_ORDER): string[] {
  return only.filter((s) => !order.includes(s));
}

export interface QaEvidence {
  qaScore?: number | null;
  releaseId?: string;
  allowUnscored?: boolean;
}

export interface GateDecision {
  /** May the gate proceed? */
  ok: boolean;
  /** True when it proceeds only because the override was set. */
  overridden: boolean;
  reason?: string;
}

/**
 * Gate 2's evidence policy.
 *
 * A gate that exists to catch a bad demo cannot do so with no QA score — it
 * becomes a rubber stamp on an unmeasured demo, which is exactly what happened
 * to 17 of the first 19 runs. Deliberately says WHY when it refuses: an alert
 * that fires every tick without naming a cause is not actionable.
 */
export function gate2Decision(e: QaEvidence): GateDecision {
  const hasEvidence = e.qaScore !== undefined && e.qaScore !== null;
  if (hasEvidence) return { ok: true, overridden: false };
  if (e.allowUnscored)
    return { ok: true, overridden: true, reason: "no QA score — proceeding under ALLOW_UNSCORED_GATE2 (the demo is UNMEASURED)" };
  return {
    ok: false,
    overridden: false,
    reason: e.releaseId
      ? "no QA score for this run — the qa step ran but recorded no result"
      : "no QA score, and state.releaseId is unset — `release` did not complete, so qa could not run",
  };
}

/**
 * Does this error mean "the server is already crawling this host"?
 *
 * `divinci rag crawl` answers a host with a crawl in flight with HTTP 423
 * ("document is locked — Already crawling this host"). Nothing in the pipeline
 * recognised that, so it read as a generic failure — and the failure is
 * self-sustaining, because the CLI's --wait abandons a crawl after 30 minutes
 * while the SERVER KEEPS CRAWLING. The loop then retries an hour later, the
 * crawl is often still running, and the retry is refused the same way.
 *
 * Matches the status and the phrase independently: the CLI surfaces the 423 in
 * a wrapped human-readable message and in a JSON body, and either may reach us.
 * The `\b423\b` bound matters — a page count like "14235" must not read as a
 * status.
 */
export function isHostAlreadyCrawling(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /\b423\b/.test(msg) || /already crawling this host/i.test(msg);
}

/**
 * Are Gates 1 and 2 advisory — recorded as steps, but never blocking?
 *
 * Set at Michael's direction 2026-08-12: "remove the pausing at gate 1 and
 * gate 2 and just use those symbolically as steps throughout the process."
 *
 * What this DOES change: neither gate parks a run waiting for a human. Both
 * still run, still stamp who approved and when, and still open+close a review board
 * task, so the board keeps its audit trail of what was approved and on what
 * evidence. What it does NOT change:
 *
 * - **Gate 2's evidence requirement stays.** `gate2Decision` still refuses a
 *   run with no QA score (override: ALLOW_UNSCORED_GATE2=1). The pause was the
 *   thing removed; the measurement is the thing that made the gate worth
 *   having. 17 of the first 19 runs reached Gate 2 with qaScore=null and were
 *   waved through, and auto-approving an UNMEASURED demo would rebuild exactly
 *   that. A run with no score now FAILS rather than sails past.
 * - **Gate 3 still blocks.** Nothing reaches a prospect without a human. That
 *   is where the outward-facing risk actually lives.
 *
 * ⚠️ Known consequence, stated plainly: Gate 1 is what stood between the queue
 * and crawling a stranger's website. Advisory means every queued prospect
 * crawls on the loop's own schedule, and spends embedding budget, with no
 * human in front of it. The per-run `budgets.crawlPages` and the queue's own
 * `hold: true` are what bound that now.
 *
 * Restore the old blocking behaviour with `GATES_BLOCKING=1`.
 */
export function gatesAreAdvisory(): boolean {
  return process.env.GATES_BLOCKING !== "1";
}

/**
 * The synthetic prospect the smoke run uses.
 *
 * `runs/__smoke__/` is the one fixture in this repository — an invented clinic
 * pointed at example.com. It exists so a fresh clone can exercise every step
 * before any credential is configured, and it is the first thing the README
 * tells a new user to run.
 */
export const SMOKE_PROSPECT = "__smoke__";

/**
 * Refuse to run the synthetic fixture against a real API.
 *
 * ⚠️ THIS GUARD EXISTS BECAUSE THE DOCUMENTED COMMAND DID THE OPPOSITE OF WHAT
 * IT SAID. `--run dry` is a run ID — the name of a directory — and nothing
 * more. The mode flag is the ENVIRONMENT variable `DRY_RUN=1`, which is what
 * `run.dry.test.ts` sets and what the README's `--run dry` was mistaken for.
 *
 * So `npm run demo -- --prospect __smoke__ --run dry`, documented as "decides
 * everything, calls nothing", authenticated against production and performed a
 * REAL run: it created a workspace, a RAG vector, crawled and ingested, pushed
 * to the public WWW-RAG corpus, PUBLISHED a release with anonymous chat open,
 * and spent model budget on QA — before dying on a missing infrastructure
 * variable at the landing step. Verified on a clean clone 2026-08-18; the
 * production workspace it created had to be deleted by hand.
 *
 * It was invisible in the documented ORDER, which is the worst part. README
 * says `npm test` first, and the dry integration test leaves the fixture's
 * state at `done` — so the very next command prints "run already complete —
 * nothing to do" and exits 0. Only someone who skips the tests, or runs the
 * smoke a second time, gets a live run. A guard is therefore the only fix that
 * holds: the docs were wrong for as long as they existed and nothing noticed.
 *
 * The fixture can only ever be a rehearsal — there is no company at
 * example.com to demo to — so a live `__smoke__` run is always a mistake.
 * `SMOKE_ALLOW_LIVE=1` exists for deliberately exercising the real path against
 * it, and must stay explicit.
 *
 * @returns the refusal message, or null if the run may proceed.
 */
export function smokeLiveRefusal(
  prospect: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (prospect !== SMOKE_PROSPECT) return null;
  if (env.DRY_RUN === "1" || env.SMOKE_ALLOW_LIVE === "1") return null;
  return [
    `refusing to run the synthetic "${SMOKE_PROSPECT}" fixture against a live API.`,
    "",
    "  --run dry is a run ID, not a mode. The dry-run flag is an environment",
    "  variable, so the smoke run is:",
    "",
    "      npm run smoke",
    `      DRY_RUN=1 npm run demo -- --prospect ${SMOKE_PROSPECT} --run dry`,
    "",
    "  Without it this creates a real workspace, publishes a real release and",
    "  spends real budget — on a fixture whose company does not exist.",
    "",
    "  If you genuinely mean to exercise the live path: SMOKE_ALLOW_LIVE=1",
  ].join("\n");
}
