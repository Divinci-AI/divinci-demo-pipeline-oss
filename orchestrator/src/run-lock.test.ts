import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireRunLock, describeHolder, isAlive, isStale, LOCK_FILE,
  DEFAULT_CROSS_HOST_MAX_AGE_MS, crossHostMaxAgeMs,
} from "./run-lock.js";

const dirs: string[] = [];
function runDir(): string {
  const d = mkdtempSync(join(tmpdir(), "run-lock-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("acquireRunLock", () => {
  it("lets the first process in", () => {
    const r = acquireRunLock(runDir());
    expect(r.ok).toBe(true);
  });

  // The property that matters. On 2026-08-08 three run.ts processes shared one
  // run directory; each held state.json in memory and save()d over the others,
  // rewriting a run that had finished QA and parked at Gate 2 back to `ingest`.
  it("REFUSES a second process while the first holds the lock", () => {
    const d = runDir();
    const first = acquireRunLock(d);
    expect(first.ok).toBe(true);
    const second = acquireRunLock(d);
    expect(second.ok).toBe(false);
  });

  it("names who holds it — 'locked' alone tells an operator nothing", () => {
    const d = runDir();
    acquireRunLock(d, "--prospect ibji --run 2026-08-07-001");
    const second = acquireRunLock(d);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.message).toContain(String(process.pid));
    expect(second.message).toContain("--prospect ibji");
  });

  it("lets the next process in after release", () => {
    const d = runDir();
    const first = acquireRunLock(d);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    first.release();
    expect(acquireRunLock(d).ok).toBe(true);
  });

  it("removes the lock file on release", () => {
    const d = runDir();
    const r = acquireRunLock(d);
    expect(existsSync(join(d, LOCK_FILE))).toBe(true);
    if (!r.ok) return;
    r.release();
    expect(existsSync(join(d, LOCK_FILE))).toBe(false);
  });

  it("takes over a lock whose holder is gone — a killed run must not wedge the directory forever", () => {
    const d = runDir();
    // pid 2^31-1 is not a running process on any sane machine.
    writeFileSync(join(d, LOCK_FILE), JSON.stringify({ pid: 2147483646, at: new Date().toISOString() }));
    expect(acquireRunLock(d).ok).toBe(true);
  });

  it("takes over a corrupt lock rather than wedging", () => {
    const d = runDir();
    writeFileSync(join(d, LOCK_FILE), "{ not json");
    expect(acquireRunLock(d).ok).toBe(true);
  });

  it("records the live pid after a stale takeover, not the dead one", () => {
    const d = runDir();
    writeFileSync(join(d, LOCK_FILE), JSON.stringify({ pid: 2147483646, at: "2020-01-01T00:00:00Z" }));
    acquireRunLock(d);
    expect(JSON.parse(readFileSync(join(d, LOCK_FILE), "utf8")).pid).toBe(process.pid);
  });

  it("two runs for DIFFERENT prospects do not block each other", () => {
    // The lock is per run directory on purpose — a global one would serialise
    // the whole pipeline for no reason.
    expect(acquireRunLock(runDir()).ok).toBe(true);
    expect(acquireRunLock(runDir()).ok).toBe(true);
  });
});

describe("isStale", () => {
  it("treats a live holder as held", () => {
    expect(isStale({ pid: process.pid, at: new Date().toISOString() }, () => true)).toBe(false);
  });

  it("treats a dead holder as stale", () => {
    expect(isStale({ pid: 123, at: "" }, () => false)).toBe(true);
  });

  it("treats a missing or malformed holder as stale — an unparseable lock must be clearable", () => {
    expect(isStale(undefined)).toBe(true);
    expect(isStale({ pid: 0, at: "" } as never)).toBe(true);
    expect(isStale({ pid: -1, at: "" } as never)).toBe(true);
    expect(isStale({ pid: 1.5, at: "" } as never)).toBe(true);
    expect(isStale({} as never)).toBe(true);
  });

  it("isAlive says yes about this very process", () => {
    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(2147483646)).toBe(false);
  });
});

describe("describeHolder", () => {
  it("reports how long the holder has been running", () => {
    const at = new Date("2026-08-08T12:00:00Z").toISOString();
    const msg = describeHolder({ pid: 999, at }, new Date("2026-08-08T12:34:00Z"));
    expect(msg).toContain("pid 999");
    expect(msg).toContain("34 min");
  });

  it("survives an unparseable timestamp without inventing a duration", () => {
    const msg = describeHolder({ pid: 999, at: "not-a-date" });
    expect(msg).toContain("pid 999");
    expect(msg).toContain("start time unknown");
    expect(msg).not.toMatch(/NaN/);
  });

  it("does not claim a negative age when clocks disagree", () => {
    const at = new Date("2026-08-08T12:00:00Z").toISOString();
    const msg = describeHolder({ pid: 999, at }, new Date("2026-08-08T11:00:00Z"));
    expect(msg).not.toContain("-");
  });
});

describe("a pid is only meaningful on the host that wrote it", () => {
  // The container wedge this guards against:
  //
  //   1. a task is OOM-killed mid-tick, leaving .run.lock naming pid 23
  //   2. the next task starts in a FRESH pid namespace
  //   3. npm → node → tsx occupy several low pids, so pid 23 exists — and is
  //      something completely unrelated
  //   4. isStale() asks process.kill(23, 0), gets "alive", and refuses
  //   5. every subsequent tick does the same, forever, reporting success
  //
  // Nondeterministic (it depends how many processes the new container starts),
  // so it passes tests and wedges in production later.
  const ALIVE = () => true;
  const DEAD = () => false;
  const NOW = Date.parse("2026-08-19T12:00:00Z");
  const ago = (ms: number) => new Date(NOW - ms).toISOString();

  it("does NOT trust a live-looking pid from another host", () => {
    const held = { pid: 23, at: ago(60_000), host: "container-a" };
    expect(isStale(held, ALIVE, { now: NOW, host: "container-b", maxAgeMs: 30_000 })).toBe(true);
  });

  it("still respects a RECENT lock from another host — a remote process can be alive", () => {
    // The whole point of a shared volume. Taking this over is the corruption.
    const held = { pid: 23, at: ago(10_000), host: "container-a" };
    expect(isStale(held, ALIVE, { now: NOW, host: "container-b", maxAgeMs: 30_000 })).toBe(false);
  });

  it("uses pid liveness within one host, exactly as before", () => {
    const held = { pid: 23, at: ago(10 * 60 * 60 * 1000), host: "laptop" };
    // Old and same-host: still held, because the process is genuinely running.
    expect(isStale(held, ALIVE, { now: NOW, host: "laptop" })).toBe(false);
    expect(isStale(held, DEAD, { now: NOW, host: "laptop" })).toBe(true);
  });

  it("treats a lock with no host field as same-host — the pre-existing behaviour", () => {
    const held = { pid: 23, at: ago(10 * 60 * 60 * 1000) };
    expect(isStale(held, ALIVE, { now: NOW, host: "anything" })).toBe(false);
    expect(isStale(held, DEAD, { now: NOW, host: "anything" })).toBe(true);
  });

  it("refuses a cross-host lock whose timestamp cannot be read", () => {
    // No evidence either way. A wedged run is recoverable by hand; two writers
    // on one state.json is not.
    const held = { pid: 23, at: "not a date", host: "container-a" };
    expect(isStale(held, ALIVE, { now: NOW, host: "container-b", maxAgeMs: 1 })).toBe(false);
  });

  it("takes over a cross-host lock once it is older than the window", () => {
    const held = { pid: 23, at: ago(7 * 60 * 60 * 1000), host: "container-a" };
    // Default window is 6h.
    expect(isStale(held, ALIVE, { now: NOW, host: "container-b" })).toBe(true);
  });

  it("the default window is far longer than any tick", () => {
    expect(DEFAULT_CROSS_HOST_MAX_AGE_MS).toBeGreaterThan(60 * 60 * 1000);
  });

  it("RUN_LOCK_MAX_AGE_MS overrides it, and junk does not become NaN", () => {
    expect(crossHostMaxAgeMs({ RUN_LOCK_MAX_AGE_MS: "5000" })).toBe(5000);
    expect(crossHostMaxAgeMs({ RUN_LOCK_MAX_AGE_MS: "nonsense" })).toBe(DEFAULT_CROSS_HOST_MAX_AGE_MS);
    expect(crossHostMaxAgeMs({ RUN_LOCK_MAX_AGE_MS: "-1" })).toBe(DEFAULT_CROSS_HOST_MAX_AGE_MS);
    expect(crossHostMaxAgeMs({})).toBe(DEFAULT_CROSS_HOST_MAX_AGE_MS);
  });

  it("records the host when taking the lock, so the next reader can tell", () => {
    const dir = mkdtempSync(join(tmpdir(), "runlock-host-"));
    const got = acquireRunLock(dir, "test");
    expect(got.ok).toBe(true);
    const held = JSON.parse(readFileSync(join(dir, LOCK_FILE), "utf8"));
    expect(typeof held.host).toBe("string");
    expect(held.host.length).toBeGreaterThan(0);
    expect(held.pid).toBe(process.pid);
    if (got.ok) got.release();
    rmSync(dir, { recursive: true, force: true });
  });
});
