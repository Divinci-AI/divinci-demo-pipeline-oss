/**
 * Which release does the LANDING PAGE actually serve?
 *
 * ⚠️ WHY THIS EXISTS — a silent, total defeat of every release-step fix.
 *
 * There are two release ids per run and nothing kept them equal:
 *
 *   - `state.releaseId`      — what the pipeline reads and WRITES to. The
 *                              release step, ScoredQA and chat resources all
 *                              use this one.
 *   - `landing/brand-draft.json .releaseId` — a SNAPSHOT taken when the landing
 *                              was generated. `landing.ts` bakes it into the
 *                              Worker bundle as DIVINCI_RELEASE_ID, and the
 *                              draft is only regenerated when absent, so it is
 *                              frozen at whatever was current that day.
 *
 * A visitor's browser only ever talks to the baked one. So when the two
 * diverge, every write the pipeline makes lands on a release nobody serves —
 * and it does so reporting complete success at every layer.
 *
 * Measured on 2026-08-23: acmealgos had its first-person voice floor written
 * to release 6a8823f4…, while the live demo served 6a87ec54… and went on
 * answering in the third person. Verifying at the data layer confirmed the
 * prefix existed with all ten entries, which looked exactly like a fix that
 * worked. Four other runs from the same batch carry the same split.
 *
 * `demo-health.ts` already noted this gap in prose — "nothing yet catches one
 * that is up and wrong". This is that check.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ReleaseSplit {
  prospect: string;
  run: string;
  /** What the pipeline writes to. */
  stateReleaseId: string;
  /** What the landing Worker was built with — what a visitor actually hits. */
  servedReleaseId: string;
}

/**
 * Read the release id baked into a run's landing bundle, or undefined when the
 * run has no landing draft (nothing is served, so nothing can diverge).
 */
export function readServedReleaseId(runDir: string): string | undefined {
  const p = join(runDir, "landing", "brand-draft.json");
  if (!existsSync(p)) return undefined;
  try {
    const d = JSON.parse(readFileSync(p, "utf8")) as { releaseId?: unknown };
    return typeof d.releaseId === "string" && d.releaseId ? d.releaseId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Report the split for one run, or null when there is none.
 *
 * Absence of a served id is NOT a split: a run with no landing has no visitor
 * path to disagree with. Reporting it would bury the real cases in noise, and
 * the real cases are the ones where a fix silently does nothing.
 */
export function findReleaseSplit(
  demo: { prospect: string; run: string; state: { releaseId?: string } },
  runDir: string,
): ReleaseSplit | null {
  const stateReleaseId = demo.state.releaseId;
  if (!stateReleaseId) return null;
  const servedReleaseId = readServedReleaseId(runDir);
  if (!servedReleaseId) return null;
  if (servedReleaseId === stateReleaseId) return null;
  return { prospect: demo.prospect, run: demo.run, stateReleaseId, servedReleaseId };
}

/**
 * The sentence to put in front of a human. Deliberately says what it COSTS
 * rather than what it IS — "these two ids differ" reads as bookkeeping, and
 * the first reader of this message dismissed exactly that shape.
 */
export function describeSplit(s: ReleaseSplit): string {
  return (
    `${s.prospect}/${s.run}: the landing page serves release ${s.servedReleaseId}, ` +
    `but the pipeline writes to ${s.stateReleaseId}. Any release-step change ` +
    `(voice, welcome, starters, gate) lands where no visitor can see it and still reports success.`
  );
}
