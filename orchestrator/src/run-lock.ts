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
import { hostname } from "node:os";

export const LOCK_FILE = ".run.lock";

export interface LockHolder {
  pid: number;
  at: string;
  /** What the holder is doing — shown on refusal so the operator can judge. */
  argv?: string;
  /**
   * WHERE the holder is running. `os.hostname()`, which inside a container is
   * that container's id — so it changes on every task, execution or pod.
   *
   * Recorded because a pid is only meaningful on the machine that wrote it.
   * Absent on locks written before this field existed, which are treated as
   * same-host (the previous behaviour).
   */
  host?: string;
}

/**
 * How long a lock held by a DIFFERENT host may sit before it is assumed
 * abandoned. Cross-host only — see `isStale`.
 *
 * The default is deliberately far longer than any tick: the container targets
 * bound a tick well under an hour, so a cross-host lock still held after six is
 * not a running process, it is wreckage. Set `RUN_LOCK_MAX_AGE_MS` to tighten
 * it, and keep it comfortably ABOVE your longest tick — too short is the one
 * setting that recreates the corruption this lock exists to prevent.
 */
export const DEFAULT_CROSS_HOST_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export function crossHostMaxAgeMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.RUN_LOCK_MAX_AGE_MS;
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CROSS_HOST_MAX_AGE_MS;
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
 *
 * ── ⚠️ A PID IS ONLY MEANINGFUL ON THE HOST THAT WROTE IT ───────────────────
 *
 * This originally asked `process.kill(pid, 0)` and nothing else, which is
 * exactly right on one laptop and wrong the moment the run directory is a
 * shared volume — EFS on Fargate, a GCS mount on Cloud Run. PIDs are namespaced
 * per container, so a lock left behind by a task that was OOM-killed names a
 * pid that the NEXT container is quite likely to have too (npm, node and tsx
 * occupy several low numbers). The new task then reads its own unrelated
 * process as the lock holder, refuses, and the loop stops doing work — quietly,
 * permanently, and reporting success on every tick.
 *
 * It is also nondeterministic, which is the worst property for this to have: it
 * depends on how many processes the new container happened to start, so it
 * passes every test and wedges in production weeks later.
 *
 * So pid liveness is consulted ONLY when the lock was written by this same
 * host. Across hosts the pid says nothing, and age is the only evidence
 * available — hence `maxAgeMs`, applied cross-host only. A cross-host lock that
 * is younger than that is respected, because on a shared volume a remote
 * process genuinely can be alive.
 */
export function isStale(
  held: LockHolder | undefined,
  alive: (pid: number) => boolean = isAlive,
  opts: { now?: number; maxAgeMs?: number; host?: string } = {},
): boolean {
  if (!held || typeof held.pid !== "number" || !Number.isInteger(held.pid) || held.pid <= 0) return true;

  const self = opts.host ?? hostname();
  // A lock with no `host` predates the field; treat it as ours, which is the
  // behaviour it was written under.
  const sameHost = !held.host || held.host === self;
  if (sameHost) return !alive(held.pid);

  const at = Date.parse(held.at ?? "");
  // A cross-host lock with an unreadable timestamp offers no evidence at all.
  // Refuse rather than take it over: a wedged run is recoverable by hand, two
  // writers on one state.json is not.
  if (Number.isNaN(at)) return false;
  const now = opts.now ?? Date.now();
  return now - at > (opts.maxAgeMs ?? crossHostMaxAgeMs());
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
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), argv, host: hostname() }));
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
