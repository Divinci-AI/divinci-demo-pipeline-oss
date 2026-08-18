/**
 * One writer per run directory.
 *
 * `loop.ts` holds a global lock, so the loop can never race itself. Nothing
 * guarded a MANUAL `run.ts` invocation, and the two share a run directory.
 *
 * What that costs, observed 2026-08-08: three `run.ts` processes ran against
 * runs/caseymeans/2026-08-07-001 at once (a background batch, a second batch,
 * and a hand-started run). Each loads state.json at startup, holds it in
 * memory, and calls save() after every step — so the last writer wins with a
 * snapshot taken before the others' work existed. ibji had completed through QA
 * and parked at Gate 2; a losing process rewrote its state back to `ingest`
 * with one source, discarding a finished QA run (0.875) and the id of a review board
 * task that was already open for review.
 *
 * Nothing failed. Both processes reported success. The server-side work was
 * intact the whole time — only the file that remembers it was lost, which is
 * the worst shape for this to take: the pipeline would have re-crawled five
 * sources and opened a SECOND Gate 2 task for a demo that was already built.
 *
 * The lock is per run directory rather than global on purpose: two runs for
 * different prospects share nothing and must stay parallel.
 */
import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const LOCK_FILE = ".run.lock";

export interface LockHolder {
  pid: number;
  at: string;
  /** What the holder is doing — shown on refusal so the operator can judge. */
  argv?: string;
}

/** Is a process with this pid running? */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Should this lock be ignored and taken over?
 *
 * A holder that is no longer running left the file behind by dying — being
 * killed, or the machine restarting. An unreadable or malformed file counts as
 * stale too: a lock nobody can parse would otherwise wedge a run permanently,
 * and the failure mode we are preventing is worse when it cannot be cleared.
 */
export function isStale(held: LockHolder | undefined, alive: (pid: number) => boolean = isAlive): boolean {
  if (!held || typeof held.pid !== "number" || !Number.isInteger(held.pid) || held.pid <= 0) return true;
  return !alive(held.pid);
}

/** Human-readable refusal — it must say WHO holds the lock, not just that it is held. */
export function describeHolder(held: LockHolder | undefined, now: Date = new Date()): string {
  if (!held || typeof held.pid !== "number") return "another process (details unreadable)";
  const started = Date.parse(held.at ?? "");
  const mins = Number.isNaN(started) ? undefined : Math.max(0, Math.round((now.getTime() - started) / 60000));
  const age = mins === undefined ? "start time unknown" : `running ${mins} min`;
  return `pid ${held.pid} (${age})${held.argv ? ` — ${held.argv}` : ""}`;
}

export type LockResult =
  | { ok: true; release: () => void }
  | { ok: false; heldBy: LockHolder | undefined; message: string };

/**
 * Take the lock for `runDir`, or refuse.
 *
 * O_EXCL makes the create-or-fail atomic, so two processes starting at the same
 * instant cannot both win. Exactly one stale takeover is attempted: unbounded
 * retries against a lock nobody can remove would spin forever.
 */
export function acquireRunLock(runDir: string, argv = "", attempt = 1): LockResult {
  const path = join(runDir, LOCK_FILE);
  try {
    const fd = openSync(path, "wx");
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), argv }));
    } finally {
      closeSync(fd);
    }
    return { ok: true, release: () => rmSync(path, { force: true }) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      // A read-only volume or a permission error is not something retrying fixes.
      return { ok: false, heldBy: undefined, message: `cannot take the run lock at ${path}: ${(err as Error).message}` };
    }
    let held: LockHolder | undefined;
    try {
      held = JSON.parse(readFileSync(path, "utf8")) as LockHolder;
    } catch {
      held = undefined;
    }
    if (attempt <= 1 && isStale(held)) {
      rmSync(path, { force: true });
      return acquireRunLock(runDir, argv, attempt + 1);
    }
    return {
      ok: false,
      heldBy: held,
      message:
        `this run is already being worked by ${describeHolder(held)}.\n` +
        `Two processes on one run directory overwrite each other's state.json — ` +
        `that is how a finished run was rewritten back to an earlier step on 2026-08-08.\n` +
        `Wait for it to finish, or stop it first. Lock: ${path}`,
    };
  }
}
