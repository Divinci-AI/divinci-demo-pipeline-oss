import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireRunLock, describeHolder, isAlive, isStale, LOCK_FILE } from "./run-lock.js";

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
