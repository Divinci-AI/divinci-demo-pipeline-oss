import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Source-level wiring guards for run.ts.
 *
 * run.ts EXECUTES the pipeline on import (it is a script, not a module), so
 * these invariants cannot be asserted by importing it. Reading the source is
 * the honest second-best: it catches the reordering/renaming regressions, and
 * it is explicitly NOT a substitute for running the pipeline.
 */
const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "run.ts"), "utf8");

function stepOrder(): string[] {
  const block = src.match(/const steps: Array<\[string, \(\) => Promise<void>\]> = \[([\s\S]*?)\n\];/);
  if (!block) throw new Error("could not find the steps array in run.ts");
  return [...block[1].matchAll(/\["([a-zA-Z0-9]+)",/g)].map((m) => m[1]);
}

describe("pipeline step order", () => {
  it("runs release BEFORE qa", () => {
    // The bug this pins: qa needs the RAG vector linked to the release, and
    // linking it to an unpublished draft 500s — so with qa first, EVERY fresh
    // run reached qa with no releaseId, skipped scoring, and produced a demo
    // with no quality evidence at all. It is why 17 of the first 19 runs carry
    // qaScore=null, acmebio's hand-written suite included.
    const order = stepOrder();
    expect(order.indexOf("release")).toBeGreaterThan(-1);
    expect(order.indexOf("qa")).toBeGreaterThan(order.indexOf("release"));
  });

  it("runs qa BEFORE gate2 — the gate must have evidence to judge", () => {
    const order = stepOrder();
    expect(order.indexOf("gate2")).toBeGreaterThan(order.indexOf("qa"));
  });

  it("keeps every gate before the work it guards", () => {
    const order = stepOrder();
    // Gate 1 guards all spend.
    expect(order.indexOf("gate1")).toBe(0);
    for (const spendStep of ["workspace", "vector", "ingest", "release"])
      expect(order.indexOf(spendStep)).toBeGreaterThan(order.indexOf("gate1"));
    // The branded landing worker — the link a prospect is actually sent — is
    // deployed only after a human has reviewed the demo.
    expect(order.indexOf("landing")).toBeGreaterThan(order.indexOf("gate2"));
    expect(order.indexOf("outreach")).toBeGreaterThan(order.indexOf("landing"));
  });

  it("has no duplicate steps", () => {
    const order = stepOrder();
    expect(new Set(order).size).toBe(order.length);
  });
});

describe("gate 2 evidence guard", () => {
  it("checks for QA evidence BEFORE honouring the legacy approved-by bypass", () => {
    // A pre-set demoApprovedBy is exactly the path that must not skip the
    // evidence check — 11 runs reached the gate carrying "batch-auto".
    // (The decision itself is tested for real in run-policy.test.ts; this only
    // pins that run.ts consults it on the correct side of the bypass.)
    const gate2 = src.slice(src.indexOf("async function gate2("));
    const evidenceAt = gate2.indexOf("gate2Decision(");
    const bypassAt = gate2.indexOf("if (state.demoApprovedBy)");
    expect(evidenceAt).toBeGreaterThan(-1);
    expect(bypassAt).toBeGreaterThan(-1);
    expect(evidenceAt).toBeLessThan(bypassAt);
  });

  it("refuses to start if steps[] drifts from the tested STEP_ORDER", () => {
    // The link that makes run-policy's tests meaningful: without it the policy
    // module documents an order the pipeline does not run.
    expect(src).toContain("stepOrderViolations(order)");
    expect(src).toContain("STEP_ORDER.join(\",\")");
  });

  it("names an explicit override rather than failing with no way forward", () => {
    expect(src).toContain("ALLOW_UNSCORED_GATE2");
  });
});

describe("auth preflight wiring", () => {
  it("runs before any step executes", () => {
    const preflightAt = src.indexOf("SKIP_AUTH_PREFLIGHT");
    const stepLoopAt = src.indexOf("for (; cursor < steps.length; cursor++)");
    expect(preflightAt).toBeGreaterThan(-1);
    expect(preflightAt).toBeLessThan(stepLoopAt);
  });

  it("also covers the ONLY_STEPS path", () => {
    const preflightAt = src.indexOf("SKIP_AUTH_PREFLIGHT");
    const onlyStepsRunAt = src.indexOf("if (onlySteps.length > 0) {");
    expect(preflightAt).toBeLessThan(onlyStepsRunAt);
  });
});

describe("exit codes", () => {
  it("distinguishes parked / infra-down / auth-expired", () => {
    // The loop's ONLY channel for telling these apart; everything used to be 0.
    expect(src).toMatch(/EXIT_GATE_PARKED = 10/);
    expect(src).toMatch(/EXIT_INFRA_DOWN = 20/);
    expect(src).toMatch(/EXIT_AUTH_EXPIRED = 30/);
  });

  it("never exits 0 for a review board-unreachable gate", () => {
    // Each gate's unreachable branch must use the infra code, not exit(0).
    const unreachableBranches = [...src.matchAll(/review board (?:is not running|unreachable)[\s\S]{0,400}?process\.exit\((\w+)\)/g)];
    expect(unreachableBranches.length).toBeGreaterThanOrEqual(3);
    for (const m of unreachableBranches) expect(m[1]).toBe("EXIT_INFRA_DOWN");
  });
});

/** The body of releaseChatCopy() — anchored on the function, since its type
 *  signature above it also mentions threadPrefix. */
function returnedChatCopy(): string {
  const start = src.indexOf("function releaseChatCopy(");
  const tp = src.indexOf("threadPrefix:", src.indexOf("return {", start));
  return src.slice(tp, src.indexOf("msgPrefix:", tp));
}

describe("compliance prompt is a FLOOR, not a default", () => {
  it("always includes complianceSystemPrompt in threadPrefix", () => {
    // This was `manifest.chat?.threadPrefix ?? complianceSystemPrompt(...)`.
    // Intake generates a threadPrefix for EVERY run, so from the moment intake
    // was automated no generated demo carried its tier's compliance floor —
    // Acme Clinic (clinic-high) shipped with only the LLM's own prose in the
    // system slot and scored 0% correctness for inventing a rehab protocol.
    const block = returnedChatCopy();
    expect(block).toContain("complianceSystemPrompt(");
    // The manifest's copy must be spread ALONGSIDE it, never instead of it.
    expect(block).toMatch(/\.\.\.\(manifest\.chat\?\.threadPrefix \?\? \[\]\)/);
    expect(block).not.toMatch(/manifest\.chat\?\.threadPrefix \?\?\s*\n?\s*complianceSystemPrompt/);
  });

  it("puts the compliance floor LAST, so it cannot be contradicted by recency", () => {
    // Presence was not enough. With the floor FIRST, Acme Clinic's generated
    // prefix ended "hand off to the clinic's team", contradicting the floor's
    // "send them BACK to their own surgeon" — and the later instruction won.
    const block = returnedChatCopy();
    expect(block.indexOf("manifest.chat?.threadPrefix")).toBeLessThan(
      block.indexOf("complianceSystemPrompt("),
    );
  });

  it("states that the floor overrides anything above it", () => {
    const prompt = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "compliance-prompt.ts"),
      "utf8",
    );
    expect(prompt).toMatch(/OVERRIDE ANY OTHER INSTRUCTION IN THIS PROMPT/);
    expect(prompt).toMatch(/the one below wins/);
  });
});

describe("no module constant may sit in the temporal dead zone", () => {
  /**
   * run.ts executes the pipeline DURING module evaluation — the step loop is
   * top-level code, not a main(). So a `const` declared below that loop is
   * still in its TDZ while the steps run, and any step that closes over it
   * throws `ReferenceError: Cannot access 'X' before initialization`.
   *
   * This is invisible to everything else: it type-checks, it passes the
   * dry-run smoke test (which does not reach every branch), and it fails only
   * on a real run, in one step. Acme Clinic's landing step died on
   * QA_PUBLISH_MIN and would have died on TIER_HAZARD_SUMMARY four lines
   * later — both had been placed beside the function that used them, which is
   * ordinarily correct and is wrong in this file.
   */
  const lines = src.split("\n");
  const loopIdx = lines.findIndex((l) => l.startsWith("for (; cursor < steps.length"));

  it("finds the execution point (the rest of this file's guards depend on it)", () => {
    expect(loopIdx).toBeGreaterThan(-1);
  });

  it("declares every top-level const/let ABOVE the step loop", () => {
    const offenders = lines
      .map((l, i) => ({ i, m: /^(?:const|let) ([A-Za-z_$][\w$]*)\s*[=:]/.exec(l) }))
      .filter((x) => x.i > loopIdx && x.m)
      .map((x) => `line ${x.i + 1}: ${x.m![1]}`);
    expect(
      offenders,
      `these are in the temporal dead zone while the pipeline runs — move them above line ${loopIdx + 1}`,
    ).toEqual([]);
  });
});

describe("outreach preflight wiring", () => {
  /**
   * Bounded by the NEXT function, not by an arbitrary one.
   *
   * The first version of this ended at `corpusBrief`, which is defined ~900
   * lines EARLIER — so the slice was empty and all four assertions passed
   * against "". That is the same failure qa-landing.test.ts already carries a
   * guard for; an extraction test must break loudly when its anchors move,
   * not quietly stop testing anything. Hence the self-check below.
   */
  const start = src.indexOf("async function outreach(");
  const end = src.indexOf("async function injectDemoLink(", start);
  const outreachFn = src.slice(start, end);

  it("bounds a NON-EMPTY function body", () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(outreachFn.length).toBeGreaterThan(500);
    expect(outreachFn).toContain("outreachTaskId");
  });

  it("measures the demo BEFORE the Gate 3 task is created", () => {
    // The task is what a human reads to decide whether to send. Measuring after
    // it exists would put the result somewhere nobody looks.
    expect(outreachFn.indexOf("measureUntilStable(")).toBeGreaterThan(-1);
    expect(outreachFn.indexOf("measureUntilStable(")).toBeLessThan(outreachFn.indexOf("createTask("));
  });

  it("puts the result at the TOP of the task, above the checklists", () => {
    const desc = outreachFn.slice(outreachFn.indexOf("description: ["));
    expect(desc.indexOf("preflight ?")).toBeLessThan(desc.indexOf("### Drafts to REVIEW"));
  });

  it("re-measures rather than reporting a stale edge copy as a defect", () => {
    // The preflight runs seconds after `wrangler deploy`; measuring the
    // PREVIOUS build and reporting its defects against the new one is the
    // false alarm this module exists to eliminate. It happened three times
    // while this was being written.
    expect(outreachFn).toMatch(/measureUntilStable\(/);
    expect(outreachFn).not.toMatch(/await measureDemo\(/);
  });

  it("never fails the run over a preflight error", () => {
    // A stranded finished demo helps nobody, and Gate 3 is a human's decision.
    const block = outreachFn.slice(outreachFn.indexOf("preflight — measuring"), outreachFn.indexOf("const boardUp"));
    expect(block).toMatch(/catch \(err\)/);
    expect(block).not.toMatch(/process\.exit|fail\(/);
  });

  it("says UNVERIFIED when it could not run — silence would read as clean", () => {
    expect(outreachFn).toMatch(/UNVERIFIED/);
  });
});

describe("gate1 auto-approval reaches runs already parked", () => {
  const gate1Raw = src.slice(src.indexOf("async function gate1("), src.indexOf("async function createWorkspace("));
  /**
   * CODE only — comments stripped.
   *
   * The first version of the ordering assertion below matched the guard string
   * inside a comment that QUOTED it, and reported the code as broken while it
   * was correct. A source-level test that can match prose is testing prose.
   */
  const gate1Fn = gate1Raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

  it("bounds a NON-EMPTY function body, and strips comments", () => {
    expect(gate1Fn.length).toBeGreaterThan(500);
    expect(gate1Fn).toContain("gate1TaskId");
    expect(gate1Fn).not.toContain("It used to sit inside");
  });

  it("is NOT gated on the task not existing yet", () => {
    // It used to sit inside `if (!state.gate1TaskId)`, so a run that
    // reached Gate 1 before auto-approval shipped could never be approved by
    // it — 28 runs sat parked on criteria that all said APPROVE. The same trap
    // springs on any future loosening: the runs that would benefit are exactly
    // the ones already waiting.
    const autoIdx = gate1Fn.indexOf("autoApproveGate1(");
    const guardIdx = gate1Fn.indexOf("if (!state.gate1TaskId)");
    expect(autoIdx).toBeGreaterThan(-1);
    expect(guardIdx === -1 || autoIdx < guardIdx).toBe(true);
  });

  it("refuses to override a human who has already moved the task", () => {
    // CANCELED is a rejection. A machine must not undo it.
    expect(gate1Fn).toMatch(/humanHasMovedIt/);
    expect(gate1Fn).toMatch(/TO_DO/);
    expect(gate1Fn).toMatch(/IN_REVIEW/);
  });

  it("closes the EXISTING task rather than opening a second one", () => {
    // Two tasks for one gate is how a board stops being trustworthy.
    expect(gate1Raw).toMatch(/closed existing task/);
  });
});
