import { describe, it, expect, afterEach } from "vitest";
import { gatesAreAdvisory, gate2Decision, GATE_STEPS } from "./run-policy.js";

const original = process.env.GATES_BLOCKING;
afterEach(() => {
  if (original === undefined) delete process.env.GATES_BLOCKING;
  else process.env.GATES_BLOCKING = original;
});

describe("gatesAreAdvisory", () => {
  it("is ON by default — Gates 1 and 2 do not pause", () => {
    delete process.env.GATES_BLOCKING;
    expect(gatesAreAdvisory()).toBe(true);
  });

  it("GATES_BLOCKING=1 restores the pause", () => {
    process.env.GATES_BLOCKING = "1";
    expect(gatesAreAdvisory()).toBe(false);
  });

  it("only the exact string '1' restores it — no accidental truthiness", () => {
    // "0", "false" and "" all read as "leave it advisory". A knob that flipped
    // a safety behaviour on any non-empty value would be a trap.
    for (const v of ["0", "false", "", "true", "yes"]) {
      process.env.GATES_BLOCKING = v;
      expect(gatesAreAdvisory(), `GATES_BLOCKING=${JSON.stringify(v)}`).toBe(v !== "1" ? true : false);
    }
  });
});

describe("what advisory mode must NOT weaken", () => {
  it("Gate 2 still REFUSES a run with no QA score", () => {
    // The pause is what was removed; the measurement is what made the gate
    // worth having. 17 of the first 19 runs reached Gate 2 with qaScore=null
    // and were approved anyway — auto-approving an unmeasured demo would
    // rebuild exactly that hole.
    const d = gate2Decision({ qaScore: null, releaseId: "r1" });
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/no QA score/i);
  });

  it("Gate 2 accepts a MEASURED run, including a zero score", () => {
    // 0 is evidence — bad evidence. It must reach the (now non-blocking) gate
    // rather than be treated as unmeasured.
    expect(gate2Decision({ qaScore: 0, releaseId: "r1" }).ok).toBe(true);
    expect(gate2Decision({ qaScore: 0.9, releaseId: "r1" }).ok).toBe(true);
  });

  it("ALLOW_UNSCORED_GATE2 remains the only way past a missing score", () => {
    const d = gate2Decision({ qaScore: null, releaseId: "r1", allowUnscored: true });
    expect(d.ok).toBe(true);
    expect(d.overridden).toBe(true);
  });

  it("Gate 3 (outreach) is still a gate step — nothing reaches a prospect unreviewed", () => {
    // The whole safety argument for making 1 and 2 advisory rests on this.
    expect(GATE_STEPS).toContain("outreach");
  });
});
