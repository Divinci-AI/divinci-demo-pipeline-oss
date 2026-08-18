import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findParked, assertReviewable, pct, type ParkedRun } from "./gate2-cli.js";

let dir: string;

function run(prospect: string, state: Record<string, unknown>, runId = "2026-08-11-001"): void {
  const d = join(dir, prospect, runId);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "state.json"), JSON.stringify(state));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gate2-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const parked = (over: Partial<ParkedRun> = {}): ParkedRun => ({
  prospect: "acme",
  run: "2026-08-11-001",
  qaScore: 0.9,
  qaLines: [],
  probeLines: [],
  taskId: "t1",
  ...over,
});

describe("findParked", () => {
  it("returns only runs sitting AT gate2", () => {
    run("at-the-gate", { step: "gate2", qaScore: 0.8, gate2TaskId: "t1" });
    run("still-crawling", { step: "vector" });
    run("already-past", { step: "outreach", qaScore: 0.9, gate2TaskId: "t2" });
    expect(findParked(dir).map((r) => r.prospect)).toEqual(["at-the-gate"]);
  });

  it("does NOT re-list an approved run that kept its gate2 task id", () => {
    // The id survives approval, so filtering on it rather than on `step` would
    // re-approve everything that ever passed this gate, every time.
    run("done-long-ago", { step: "done", gate2TaskId: "t9", qaScore: 0.95 });
    expect(findParked(dir)).toEqual([]);
  });

  it("survives a stray file and unreadable state without losing the rest", () => {
    writeFileSync(join(dir, ".loop-status.json"), "{}");
    run("broken", { step: "gate2" });
    writeFileSync(join(dir, "broken", "2026-08-11-001", "state.json"), "{not json");
    run("good", { step: "gate2", qaScore: 0.7, gate2TaskId: "t1" });
    expect(findParked(dir).map((r) => r.prospect)).toEqual(["good"]);
  });

  it("carries the qa and probe evidence off the run log", () => {
    run("acme", {
      step: "gate2",
      qaScore: 0.5,
      qaPassedCount: 3,
      qaTestCount: 6,
      gate2TaskId: "t1",
      log: [
        { msg: "qa:   ✗ names a competitor" },
        { msg: "qa:   ✓ cites a source" },
        { msg: "probe recall@5 0.62" },
        { msg: "step: qa" },
      ],
    });
    const [r] = findParked(dir);
    expect(r.qaLines).toEqual(["✗ names a competitor", "✓ cites a source"]);
    expect(r.probeLines).toEqual(["probe recall@5 0.62"]);
    expect(r.qaPassedCount).toBe(3);
  });
});

describe("assertReviewable", () => {
  it("refuses an unmeasured run, and says where the deliberate override lives", () => {
    // The whole point of the gate. A batch tool that could approve this would
    // rebuild the hole that let 17 of the first 19 runs through unmeasured.
    const why = assertReviewable(parked({ qaScore: null }));
    expect(why).toMatch(/no QA score/i);
    expect(why).toMatch(/ALLOW_UNSCORED_GATE2/);
  });

  it("treats a zero score as measured — 0 is evidence, and it is BAD evidence", () => {
    // `!r.qaScore` would call a demo that failed every test "unmeasured" and
    // send the reviewer to the override flag instead of to the failures.
    expect(assertReviewable(parked({ qaScore: 0 }))).toBeNull();
  });

  it("distinguishes a missing task from a missing score", () => {
    expect(assertReviewable(parked({ taskId: undefined }))).toMatch(/task id/i);
  });

  it("passes a measured run with a task", () => {
    expect(assertReviewable(parked())).toBeNull();
  });
});

describe("pct", () => {
  it("renders a score, and an absent one as a dash rather than NaN%", () => {
    expect(pct(0.8123)).toBe("81.2%");
    expect(pct(0)).toBe("0.0%");
    expect(pct(null)).toBe("—");
  });
});
