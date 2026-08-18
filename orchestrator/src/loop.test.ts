import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findActiveRuns,
  countRunsStartedToday,
  describeExit,
  selectRunsToAdvance,
  isParked,
  runKey,
  isQuarantined,
  recordFailure,
  summarizeFailure,
  partitionRuns,
  intakeBlockedBy,
  MAX_LIVE_PARKED,
  type ActiveRun,
} from "./loop.js";

const dirs: string[] = [];
function runsFixture(
  spec: Record<string, Record<string, { step?: string; manifest?: boolean }>>,
): string {
  const root = mkdtempSync(join(tmpdir(), "loop-runs-"));
  dirs.push(root);
  for (const [prospect, runs] of Object.entries(spec)) {
    for (const [runId, cfg] of Object.entries(runs)) {
      const dir = join(root, prospect, runId);
      mkdirSync(dir, { recursive: true });
      if (cfg.manifest !== false) writeFileSync(join(dir, "manifest.json"), "{}");
      if (cfg.step) writeFileSync(join(dir, "state.json"), JSON.stringify({ step: cfg.step }));
    }
  }
  return root;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("findActiveRuns", () => {
  it("excludes runs that are done", () => {
    const dir = runsFixture({
      a: { "2026-08-01-001": { step: "done" } },
      b: { "2026-08-02-001": { step: "outreach" } },
    });
    expect(findActiveRuns(dir).map((r) => r.prospect)).toEqual(["b"]);
  });

  it("treats a manifest with no state.json as a fresh run at gate1", () => {
    const dir = runsFixture({ a: { "2026-08-04-001": {} } });
    expect(findActiveRuns(dir)[0].step).toBe("gate1");
  });

  it("ignores a directory with no manifest — an aborted intake is not a run", () => {
    const dir = runsFixture({ a: { "2026-08-04-001": { manifest: false } } });
    expect(findActiveRuns(dir)).toHaveLength(0);
  });

  it("skips the __smoke__ fixture and dotfiles", () => {
    const dir = runsFixture({
      __smoke__: { dry: { step: "outreach" } },
      real: { "2026-08-04-001": { step: "ingest" } },
    });
    expect(findActiveRuns(dir).map((r) => r.prospect)).toEqual(["real"]);
  });

  it("survives a corrupt state.json without dropping the other runs", () => {
    const dir = runsFixture({ a: { "2026-08-01-001": { step: "ingest" } }, b: { "2026-08-02-001": {} } });
    writeFileSync(join(dir, "a", "2026-08-01-001", "state.json"), "{ corrupt");
    expect(findActiveRuns(dir).map((r) => r.prospect)).toEqual(["b"]);
  });

  it("returns runs oldest-first so the backlog drains in order", () => {
    const dir = runsFixture({
      a: { "2026-08-03-001": { step: "ingest" } },
      b: { "2026-08-01-001": { step: "ingest" } },
    });
    expect(findActiveRuns(dir).map((r) => r.run)).toEqual(["2026-08-01-001", "2026-08-03-001"]);
  });
});

describe("countRunsStartedToday", () => {
  it("counts only today's runs — the daily cap is what bounds spend", () => {
    const dir = runsFixture({
      a: { "2026-08-04-001": {} },
      b: { "2026-08-04-002": {}, "2026-07-01-001": {} },
    });
    expect(countRunsStartedToday("2026-08-04", dir)).toBe(2);
  });

  it("is zero on a fresh day", () => {
    expect(countRunsStartedToday("2026-08-05", runsFixture({ a: { "2026-08-04-001": {} } }))).toBe(0);
  });
});

describe("isParked", () => {
  it("counts every gate step as awaiting a human", () => {
    for (const step of ["gate1", "gate2", "landing", "outreach"]) expect(isParked(step)).toBe(true);
  });

  it("does not count work steps", () => {
    for (const step of ["ingest", "hygiene", "probe", "qa", "release"]) expect(isParked(step)).toBe(false);
  });
});

describe("selectRunsToAdvance", () => {
  function runs(n: number): ActiveRun[] {
    return Array.from({ length: n }, (_, i) => ({
      prospect: `p${i}`,
      run: `2026-08-0${(i % 9) + 1}-001`,
      step: "outreach",
      statePath: "",
    }));
  }

  it("does NOT take the same runs every tick — the tail must not starve", () => {
    // The bug this exists to prevent: slice(0, N) over a stable sort advances
    // runs 1-6 forever, so a run whose gate a human approved sits approved.
    const all = runs(12);
    const attempts: Record<string, string> = {};
    const firstTick = selectRunsToAdvance(all, attempts, 6);
    for (const r of firstTick) attempts[runKey(r)] = "2026-08-04T00:00:00.000Z";
    const secondTick = selectRunsToAdvance(all, attempts, 6);

    const overlap = secondTick.filter((r) => firstTick.some((f) => runKey(f) === runKey(r)));
    expect(overlap).toHaveLength(0);
  });

  it("every run gets a turn within ceil(total/limit) ticks", () => {
    const all = runs(12);
    const attempts: Record<string, string> = {};
    const seen = new Set<string>();
    for (let t = 0; t < 2; t++) {
      const picked = selectRunsToAdvance(all, attempts, 6);
      picked.forEach((r, i) => {
        seen.add(runKey(r));
        // Distinct timestamps so ordering is deterministic.
        attempts[runKey(r)] = `2026-08-04T0${t}:0${i}:00.000Z`;
      });
    }
    expect(seen.size).toBe(12);
  });

  it("prefers never-attempted runs so new work is not starved by a backlog", () => {
    const all = runs(3);
    const attempts = {
      [runKey(all[0])]: "2026-08-04T00:00:00.000Z",
      [runKey(all[1])]: "2026-08-04T00:00:01.000Z",
    };
    expect(runKey(selectRunsToAdvance(all, attempts, 1)[0])).toBe(runKey(all[2]));
  });

  it("returns everything when under the limit", () => {
    expect(selectRunsToAdvance(runs(3), {}, 6)).toHaveLength(3);
  });
});

describe("describeExit", () => {
  it("treats a parked gate as normal — it must not alert anyone", () => {
    // Parking is the expected outcome of most ticks. Alerting on it would make
    // the loop's notifications worthless within a night.
    const d = describeExit(10);
    expect(d.alert).toBe(false);
    expect(d.stopTick).toBe(false);
  });

  it("stops the whole tick when a dependency is down", () => {
    // review board being down fails every gate identically; continuing would just
    // repeat one failure once per run.
    const d = describeExit(20);
    expect(d.stopTick).toBe(true);
    expect(d.alert).toBe(true);
  });

  it("stops and alerts when the session needs a human", () => {
    const d = describeExit(30);
    expect(d.stopTick).toBe(true);
    expect(d.alert).toBe(true);
  });

  it("alerts but keeps going on a single run's failure", () => {
    // One prospect's crawl failing must not stop the others' progress.
    const d = describeExit(1);
    expect(d.alert).toBe(true);
    expect(d.stopTick).toBe(false);
  });

  it("treats 0 as a clean advance", () => {
    expect(describeExit(0)).toEqual({ outcome: "advanced", stopTick: false, alert: false });
  });
});

describe("failure quarantine", () => {
  it("does not quarantine a first failure — retrying is right", () => {
    expect(isQuarantined(undefined, "ingest")).toBe(false);
    expect(isQuarantined({ step: "ingest", count: 1, lastAt: "" }, "ingest")).toBe(false);
  });

  it("QUARANTINES a run failing identically past the limit", () => {
    // Stone Clinic failed at `ingest` on 8 consecutive ticks, re-running a
    // 30-minute crawl each time to no effect. One alert, then silent spend.
    expect(isQuarantined({ step: "ingest", count: 3, lastAt: "" }, "ingest")).toBe(true);
  });

  it("does NOT quarantine when the run has moved to a different step", () => {
    // Progress means the retry is working, whatever the count was before.
    expect(isQuarantined({ step: "ingest", count: 9, lastAt: "" }, "probe")).toBe(false);
  });

  it("resets the counter when the step changes", () => {
    const rec = recordFailure({ step: "ingest", count: 2, lastAt: "" }, "probe", "t");
    expect(rec).toEqual({ step: "probe", count: 1, lastAt: "t" });
  });

  it("increments while the step is unchanged", () => {
    expect(recordFailure({ step: "ingest", count: 2, lastAt: "" }, "ingest", "t").count).toBe(3);
  });

  it("writes the CAUSE down, not just the count", () => {
    // A quarantine is the moment the failure stops being reproducible on
    // demand. evonexus was quarantined after three nights of a one-line npm
    // error and recovering it meant re-running a landing deploy by hand.
    const rec = recordFailure(undefined, "landing", "t", "npm error code EALLOWSCRIPTS\n");
    expect(rec.lastError).toBe("npm error code EALLOWSCRIPTS");
  });

  it("keeps the previous cause when a later failure says nothing", () => {
    const first = recordFailure(undefined, "landing", "t", "Error: Command failed: npm install");
    const second = recordFailure(first, "landing", "t2", "");
    expect(second.lastError).toBe("Error: Command failed: npm install");
    expect(second.count).toBe(2);
  });

  it("drops a stale cause when the run moves on", () => {
    const rec = recordFailure({ step: "landing", count: 2, lastAt: "", lastError: "old" }, "probe", "t", "");
    expect(rec.lastError).toBeUndefined();
  });
});

describe("summarizeFailure", () => {
  /**
   * A pretty-printed JSON error ends in a bare `}`, and none of its lines match
   * the keyword rules — so the trailing-line fallback recorded "}" as the
   * cause. Three runs sat at the retry cap with `lastError: "}"`:
   * unretryable AND undiagnosable, because the one field saying why had been
   * thrown away.
   */
  it("reads the message out of a pretty-printed JSON error", () => {
    const tail = [
      "vector: creating index…",
      "{",
      '  "error": {',
      '    "message": "Request timed out after 30000ms",',
      '    "code": "ETIMEDOUT"',
      "  }",
      "}",
    ].join("\n");
    expect(summarizeFailure(tail)).toBe("Request timed out after 30000ms (ETIMEDOUT)");
  });

  it("reads a single-line JSON error too", () => {
    expect(summarizeFailure('{"error":{"message":"forbidden","status":403}}')).toBe("forbidden");
  });

  it("NEVER returns bare punctuation as a diagnosis", () => {
    // The exact shape that quarantined three runs with lastError "}".
    const tail = ["some log line", "{", "  }", "}"].join("\n");
    const out = summarizeFailure(tail);
    expect(out).not.toBe("}");
    expect(out === undefined || /[A-Za-z0-9]/.test(out)).toBe(true);
  });

  it("returns undefined when the tail holds nothing informative at all", () => {
    // Better than a confident "}" — absent reads as unknown, which is true.
    expect(summarizeFailure(["{", "}", "  ]"].join("\n"))).toBeUndefined();
  });

  it("still prefers a thrown Error over an unrelated JSON blob", () => {
    const tail = ['{"ok":true,"message":"fine"}', "Error: Command failed: npm install"].join("\n");
    // The JSON here is not an error; the Error line is the diagnosis.
    expect(summarizeFailure(tail)).toContain("Command failed");
  });

  it("prefers the thrown Error over the stack frames under it", () => {
    // The frames name OUR code; the message names the problem.
    const tail = [
      "landing: building + deploying demo-evonexus-landing…",
      "Error: Command failed: npm install",
      "    at genericNodeError (node:internal/errors:983:15)",
      "    at ChildProcess.exithandler (node:child_process:417:12)",
    ].join("\n");
    expect(summarizeFailure(tail)).toBe("Error: Command failed: npm install");
  });

  it("finds a diagnosis that is not a thrown Error", () => {
    expect(summarizeFailure("step: landing\nnpm error code EALLOWSCRIPTS\n")).toBe(
      "npm error code EALLOWSCRIPTS",
    );
  });

  it("falls back to the last real line rather than giving up", () => {
    expect(summarizeFailure("step: landing\nkilled\n\n")).toBe("killed");
  });

  it("never returns a stack frame", () => {
    expect(summarizeFailure("    at foo (bar.ts:1:1)\n    at baz (qux.ts:2:2)\n")).toBeUndefined();
  });

  it("has nothing to say about empty output", () => {
    expect(summarizeFailure("")).toBeUndefined();
    expect(summarizeFailure("   \n\n  ")).toBeUndefined();
  });

  it("bounds what it stores — this file is read by a human", () => {
    expect(summarizeFailure(`Error: ${"x".repeat(5000)}`)!.length).toBe(300);
  });

  // Regression, 2026-08-08. A crashing node process prints its version banner
  // LAST, so the trailing-line fallback selected it. Twelve runs recorded
  // "Node.js v22.23.1" as their diagnosis — a line that is true of every run
  // the loop has ever made, failing or not, and therefore says nothing.
  it("never reports the node version banner as the diagnosis", () => {
    const tail = [
      "npm error code EALLOWSCRIPTS",
      "npm error --allow-scripts is not allowed in project-scoped installs.",
      "",
      "Node.js v22.23.1",
    ].join("\n");
    expect(summarizeFailure(tail)).toBe("npm error code EALLOWSCRIPTS");
  });

  it("does not fall back to the banner even when it is the only line left", () => {
    expect(summarizeFailure("Node.js v22.23.1\n")).toBeUndefined();
  });

  // The npm code names the failure exactly. Without this preference the
  // generic word-matcher settles for whichever npm line appears first, which
  // in a real dump is the wrapping "Error: Command failed: npm install".
  it("prefers the npm error CODE over the wrapper that reports the exit", () => {
    const tail = [
      "Error: Command failed: npm install",
      "  stderr: 'npm error code EALLOWSCRIPTS\\n' +",
      "    'npm error --allow-scripts is not allowed in project-scoped installs.'",
    ].join("\n");
    expect(summarizeFailure(tail)).toBe("npm error code EALLOWSCRIPTS");
  });

  it("starts at 1 for a run with no history", () => {
    expect(recordFailure(undefined, "ingest", "t")).toEqual({ step: "ingest", count: 1, lastAt: "t" });
  });
});

describe("intake ceilings", () => {
  const clear = { workable: 0, pendingReview: 0, liveParked: 0, startedToday: 0 };

  it("lets intake proceed when nothing is at a limit", () => {
    expect(intakeBlockedBy(clear)).toBeUndefined();
  });

  it("does NOT count unreviewed corpus plans against live demo sites", () => {
    // A run parked at gate1 has spent nothing — no crawl, no workspace, no
    // deployed site. One combined cap of 12 stopped intake once a dozen runs
    // awaited a human regardless of whether they had cost anything, which is
    // what made a high daily rate impossible while looking like a spend control.
    expect(intakeBlockedBy({ ...clear, pendingReview: 30 })).toBeUndefined();
  });

  it("STILL stops at a wall of live demo sites", () => {
    // These carry someone's brand. More of them genuinely does not help.
    //
    // Bound to the constant, not to a literal: this test hardcoded 12 and so
    // failed the moment the cap was raised to 42 — reporting a deliberate
    // config change as a regression. What is worth pinning is that the wall
    // EXISTS and names itself, not what number it currently sits at.
    const why = intakeBlockedBy({ ...clear, liveParked: MAX_LIVE_PARKED });
    expect(why).toMatch(/LIVE demo site/);
  });

  it("lets intake through one below the live-site wall", () => {
    // The other half of the boundary. Without this, a cap accidentally set to
    // zero would still satisfy the test above while blocking everything.
    expect(intakeBlockedBy({ ...clear, liveParked: MAX_LIVE_PARKED - 1 })).toBeUndefined();
  });

  it("stops on the daily cap first, so the log names the real reason", () => {
    // Every ceiling reports itself. "intake stopped" without which one was hit
    // is how a cap gets blamed for another cap's behaviour.
    const why = intakeBlockedBy({ workable: 99, pendingReview: 99, liveParked: 99, startedToday: 999 });
    expect(why).toMatch(/started today/);
  });

  it("caps concurrent mid-pipeline runs", () => {
    expect(intakeBlockedBy({ ...clear, workable: 12 })).toMatch(/mid-pipeline/);
  });

  it("eventually stops even on the cheap backlog", () => {
    // Costing nothing is not a reason to accumulate forever: an unread queue
    // of corpus plans is still an unread queue.
    //
    // Deliberately not pinned to the cap's current value — this asserts that a
    // ceiling EXISTS. Hardcoding 40 made the test fail when the cap was raised
    // to let a 60-prospect queue run, which is a number changing, not the
    // property breaking.
    expect(intakeBlockedBy({ ...clear, pendingReview: 100_000 })).toMatch(/Gate 1/);
  });
});

describe("what counts as a LIVE demo site", () => {
  const parked = (over: Partial<ActiveRun>): ActiveRun =>
    ({ prospect: "p", run: "r", step: "gate2", statePath: "", ...over }) as ActiveRun;

  it("a gate2 run is NOT a live site — landing runs after Gate 2", () => {
    // The cap stopped intake with "12 LIVE demo site(s) awaiting review …
    // these carry someone's brand" while all twelve had landingUrl=none. The
    // step was the wrong proxy for deployment.
    const runs = Array.from({ length: 12 }, () => parked({ hasLiveSite: false }));
    expect(runs.filter((r) => r.hasLiveSite)).toHaveLength(0);
  });

  it("counts deployment, so a deployed run still occupies the budget", () => {
    const runs = [parked({ step: "outreach", hasLiveSite: true }), parked({ hasLiveSite: false })];
    expect(runs.filter((r) => r.hasLiveSite)).toHaveLength(1);
  });

  it("findActiveRuns reports it from state.landingUrl", () => {
    const dir = runsFixture({ a: { "2026-08-07-001": { step: "outreach" } } });
    writeFileSync(
      join(dir, "a", "2026-08-07-001", "state.json"),
      JSON.stringify({ step: "outreach", landingUrl: "https://demo-a.workers.dev" }),
    );
    expect(findActiveRuns(dir)[0].hasLiveSite).toBe(true);
  });

  it("and reports false when no page was ever deployed", () => {
    const dir = runsFixture({ b: { "2026-08-07-001": { step: "gate2" } } });
    expect(findActiveRuns(dir)[0].hasLiveSite).toBe(false);
  });
});

// Pre-emptive guard, 2026-08-08. Quarantine stops RETRYING a hopeless run but
// used to leave it counted as work-in-progress, so it held a concurrency slot
// nothing would ever use. Enough of those and intake halts while reporting runs
// "mid-pipeline" that are not moving at all. Only bites at WORK steps
// (ingest/vector) — gate steps are parked and never counted anyway.
describe("partitionRuns", () => {
  const runs = [
    { step: "gate1", id: "parked-a" },
    { step: "gate2", id: "parked-b" },
    { step: "ingest", id: "stuck" },
    { step: "vector", id: "moving" },
  ];
  const isStuck = (r: { id: string }) => r.id === "stuck";

  it("does not count a quarantined run as workable", () => {
    const { workable } = partitionRuns(runs, isStuck);
    expect(workable.map((r) => r.id)).toEqual(["moving"]);
  });

  it("reports the quarantined run separately rather than dropping it", () => {
    const { stuck } = partitionRuns(runs, isStuck);
    expect(stuck.map((r) => r.id)).toEqual(["stuck"]);
  });

  it("still parks the runs waiting at a gate", () => {
    const { parked } = partitionRuns(runs, isStuck);
    expect(parked.map((r) => r.id)).toEqual(["parked-a", "parked-b"]);
  });

  it("accounts for every run exactly once", () => {
    const { parked, stuck, workable } = partitionRuns(runs, isStuck);
    expect([...parked, ...stuck, ...workable].map((r) => r.id).sort()).toEqual(
      runs.map((r) => r.id).sort(),
    );
  });

  it("a run parked at a gate is never ALSO reported as quarantined", () => {
    // Gate steps are not retried, so a stale failure record must not
    // double-count one run into two backlogs.
    const { parked, stuck } = partitionRuns([{ step: "gate1", id: "x" }], () => true);
    expect(parked).toHaveLength(1);
    expect(stuck).toHaveLength(0);
  });

  it("leaves every run workable when nothing is quarantined", () => {
    const { workable, stuck } = partitionRuns(runs, () => false);
    expect(workable).toHaveLength(2);
    expect(stuck).toHaveLength(0);
  });
});

// Found 2026-08-08 by re-running five stalled runs. drchatterjee failed with:
//   API error (423): document is locked — Already crawling this host
// The pipeline had no handling for 423 anywhere, so it read as a generic
// exit 1. That makes the failure self-sustaining: the CLI's --wait abandons a
// crawl after 30 minutes while the SERVER KEEPS CRAWLING, the loop records a
// failure and retries an hour later, the crawl is often still running, and the
// retry gets 423 too. Enough repeats and quarantine parks a healthy run whose
// only problem was that its own previous crawl had not finished.
describe("describeExit — host busy (423)", () => {
  it("is not a failure and does not alert", () => {
    const d = describeExit(40);
    expect(d.alert).toBe(false);
    expect(d.stopTick).toBe(false);
  });

  it("does not stop the tick — other runs are unaffected by one busy host", () => {
    expect(describeExit(40).stopTick).toBe(false);
  });

  it("says the host is busy rather than that something failed", () => {
    expect(describeExit(40).outcome).toMatch(/crawled server-side|will retry/i);
  });
});
