import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// End-to-end integration smoke test for the step machine.
//
// Runs the WHOLE orchestrator (gate1 → … → outreach) as a subprocess with
// DRY_RUN=1, which stubs every external boundary (divinci CLI, ks guard,
// review board gates, Playwright brand extract, wrangler deploy, consumer API).
// No network, no spend, no review board required — it exercises step sequencing,
// idempotent checkpointing, and state transitions offline.
//
// This is the "real confidence investment": the pure-logic unit tests prove
// the leaves; this proves the tree walks end to end and reaches "done".

const here = dirname(fileURLToPath(import.meta.url));
const orchestratorDir = resolve(here, "..");
const repoRoot = resolve(orchestratorDir, "..");
const runDir = join(repoRoot, "runs", "__smoke__", "dry");
const statePath = join(runDir, "state.json");

function runPipeline(): { code: number; out: string } {
  try {
    const out = execFileSync(
      "npx",
      ["tsx", "src/run.ts", "--prospect", "__smoke__", "--run", "dry"],
      { cwd: orchestratorDir, env: { ...process.env, DRY_RUN: "1" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}\n${err.stderr ?? ""}` };
  }
}

function readState(): Record<string, unknown> {
  return JSON.parse(readFileSync(statePath, "utf8"));
}

describe("DRY_RUN pipeline (integration smoke)", () => {
  beforeEach(() => {
    // Always start from a clean slate so we exercise the full walk, not a resume.
    if (existsSync(statePath)) rmSync(statePath);
  });

  it("walks every step from gate1 to done with no external calls", () => {
    const { code, out } = runPipeline();
    expect(code, `pipeline exited non-zero:\n${out}`).toBe(0);
    expect(out).toContain("run complete");

    const state = readState();
    expect(state.step).toBe("done");
    // IDs assigned by the dv() stub.
    expect(state.workspaceId).toBeTruthy();
    expect(state.vectorId).toBeTruthy();
    expect(state.releaseId).toBeTruthy();
    // Gates auto-approved.
    expect(state.demoApprovedBy).toBe("dry-run");
    expect(state.outreachApprovedBy).toBe("dry-run");
    // Landing + demo link wired through to outreach.
    expect(state.landingWorkerName).toBe("demo-__smoke__-landing");
    expect(String(state.landingUrl)).toContain("demo-__smoke__-landing");
    expect(state.demoLink).toBe(state.landingUrl);
  }, 60_000);

  it("is idempotent — a second run resumes at 'done' and changes nothing", () => {
    expect(runPipeline().code).toBe(0);
    const first = readState();
    // Re-run WITHOUT clearing state: cursor starts at "done" → loop is a no-op.
    const { code, out } = runPipeline();
    expect(code, out).toBe(0);
    const second = readState();
    expect(second.step).toBe("done");
    expect(second.workspaceId).toBe(first.workspaceId);
    expect(second.vectorId).toBe(first.vectorId);
  }, 60_000);
});
