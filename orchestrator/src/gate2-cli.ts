/**
 * `npm run gate2` — review and approve the runs parked at Gate 2.
 *
 * Gate 2 is the last check before a demo link is built and sent to a stranger,
 * and it is the gate this pipeline has historically failed at: 17 of the first
 * 19 runs reached it with `qaScore: null` and were approved anyway. `run.ts`
 * now refuses to present an unmeasured demo at all — but refusing is only half
 * the fix. The other half is making the measured case cheap to act on, because
 * a reviewer who has to open review board, find the task, read a rendered Markdown
 * body and cross-reference a workspace id will, on the twelfth run, skim.
 *
 * So this prints the SAME evidence the review-board task carries, for every parked
 * run at once, and approves by prospect. The evidence is not optional and not
 * behind a flag: listing a run and showing its score are the same operation.
 *
 * ⚠️ This tool CANNOT approve a run that has no QA score, by construction —
 * see `assertReviewable()`. That is deliberate and is not a limitation to work
 * around here: `ALLOW_UNSCORED_GATE2=1` on the run itself is the documented,
 * deliberate, one-run-at-a-time way to pass an unmeasured demo, and it leaves
 * a record in that run's log. A batch tool that could wave through a whole
 * backlog unmeasured would rebuild the exact hole the gate was cut to close.
 *
 *   npm run gate2                     # list everything parked at Gate 2
 *   npm run gate2 -- --approve sarvam acmeanyai
 *   npm run gate2 -- --approve-all --min-score 0.8
 *   npm run gate2 -- --json
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getTask, updateTask, isAvailable } from "./review-board.js";

const orchestratorDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runsDir = join(resolve(orchestratorDir, ".."), "runs");

export interface ParkedRun {
  prospect: string;
  run: string;
  qaScore: number | null;
  qaPassedCount?: number;
  qaTestCount?: number;
  /** Per-test lines the qa step logged — the only per-question detail on disk. */
  qaLines: string[];
  probeLines: string[];
  workspaceId?: string;
  releaseId?: string;
  taskId?: string;
}

interface RunState {
  step?: string;
  qaScore?: number | null;
  qaPassedCount?: number;
  qaTestCount?: number;
  workspaceId?: string;
  releaseId?: string;
  gate2TaskId?: string;
  log?: Array<{ msg?: string }>;
}

/**
 * Every run currently sitting AT Gate 2.
 *
 * Keyed on `state.step`, not on the presence of a Gate 2 task id: a run that
 * was approved keeps its task id forever, so filtering on the id would re-list
 * — and re-approve — work that is already past this gate.
 */
export function findParked(dir: string = runsDir): ParkedRun[] {
  if (!existsSync(dir)) return [];
  const out: ParkedRun[] = [];
  for (const prospect of readdirSync(dir)) {
    const pDir = join(dir, prospect);
    let runs: string[];
    try {
      runs = readdirSync(pDir);
    } catch {
      continue; // a file (e.g. .loop-status.json), not a prospect directory
    }
    for (const run of runs) {
      const p = join(pDir, run, "state.json");
      if (!existsSync(p)) continue;
      let s: RunState;
      try {
        s = JSON.parse(readFileSync(p, "utf8")) as RunState;
      } catch {
        continue;
      }
      if (s.step !== "gate2") continue;
      const msgs = (s.log ?? []).map((e) => e.msg ?? "");
      out.push({
        prospect,
        run,
        qaScore: s.qaScore ?? null,
        qaPassedCount: s.qaPassedCount,
        qaTestCount: s.qaTestCount,
        qaLines: msgs.filter((m) => m.startsWith("qa:   ")).map((m) => m.slice(6)),
        probeLines: msgs.filter((m) => m.startsWith("probe ")),
        workspaceId: s.workspaceId,
        releaseId: s.releaseId,
        taskId: s.gate2TaskId,
      });
    }
  }
  return out.sort((a, b) => a.prospect.localeCompare(b.prospect));
}

export function pct(score: number | null): string {
  return score === null || score === undefined ? "—" : `${(score * 100).toFixed(1)}%`;
}

/**
 * Why this run may not be approved from here, or `null` if it may.
 *
 * Returns the REASON rather than a boolean so the refusal can say which of the
 * two very different problems it hit — "nobody measured this" and "the loop
 * never opened a review task" need different fixes, and a bare `false` sends
 * you looking for the wrong one.
 */
export function assertReviewable(r: ParkedRun): string | null {
  if (r.qaScore === null || r.qaScore === undefined)
    return "no QA score — approve deliberately on the run itself with ALLOW_UNSCORED_GATE2=1";
  if (!r.taskId) return "no review board Gate 2 task id in state.json — let the loop reach this run first";
  return null;
}

function render(rows: ParkedRun[]): string {
  if (rows.length === 0) return "nothing parked at Gate 2.";
  const lines: string[] = [];
  for (const r of rows) {
    const counts =
      r.qaPassedCount !== undefined && r.qaTestCount !== undefined
        ? ` (${r.qaPassedCount}/${r.qaTestCount} passed)`
        : "";
    const blocked = assertReviewable(r);
    lines.push(`${r.prospect}/${r.run}`);
    lines.push(`  QA: ${pct(r.qaScore)}${counts}${blocked ? `   ⚠ ${blocked}` : ""}`);
    // Failing tests first — the reason to look at all. A reviewer scanning
    // twelve of these should not have to read the passes to find the fails.
    const failed = r.qaLines.filter((l) => /^\s*(✗|FAIL)/.test(l));
    for (const l of failed.slice(0, 6)) lines.push(`    ${l}`);
    if (failed.length > 6) lines.push(`    … ${failed.length - 6} more failing`);
    for (const l of r.probeLines.slice(-3)) lines.push(`    ${l.slice(0, 160)}`);
    if (r.releaseId) lines.push(`  release ${r.releaseId}`);
    lines.push("");
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const parked = findParked();

  if (argv.includes("--json")) {
    console.log(JSON.stringify(parked, null, 2));
    return;
  }

  const approveAll = argv.includes("--approve-all");
  const minIdx = argv.indexOf("--min-score");
  const minScore = minIdx >= 0 ? Number(argv[minIdx + 1]) : undefined;
  const approveIdx = argv.indexOf("--approve");
  const named =
    approveIdx >= 0 ? argv.slice(approveIdx + 1).filter((a) => !a.startsWith("--")) : [];

  if (!approveAll && named.length === 0) {
    console.log(render(parked));
    console.log(`${parked.length} run(s) parked at Gate 2.`);
    return;
  }

  let targets = approveAll ? parked : parked.filter((r) => named.includes(r.prospect));
  const missing = named.filter((n) => !parked.some((r) => r.prospect === n));
  for (const m of missing) console.log(`${m}: not parked at Gate 2 — skipped`);

  if (minScore !== undefined) {
    if (!Number.isFinite(minScore)) throw new Error("--min-score needs a number, e.g. 0.8");
    const below = targets.filter((r) => (r.qaScore ?? -1) < minScore);
    for (const r of below) console.log(`${r.prospect}: QA ${pct(r.qaScore)} < ${pct(minScore)} — skipped`);
    targets = targets.filter((r) => (r.qaScore ?? -1) >= minScore);
  }

  if (targets.length === 0) return console.log("nothing to approve.");
  if (!(await isAvailable())) {
    console.error("review board unavailable — approving nothing.");
    process.exit(1);
  }

  for (const r of targets) {
    const blocked = assertReviewable(r);
    if (blocked) {
      console.log(`${r.prospect}: refused — ${blocked}`);
      continue;
    }
    try {
      const before = await getTask(r.taskId!);
      if (before.status === "DONE") {
        console.log(`${r.prospect}: already DONE`);
        continue;
      }
      await updateTask(r.taskId!, { status: "DONE" });
      // Read back. The PATCH echoes the payload, so its response cannot tell
      // you what the task now IS — the same trap as a Mongoose write that
      // returns the field it silently dropped.
      const after = await getTask(r.taskId!);
      console.log(
        `${r.prospect}: QA ${pct(r.qaScore)} — ${before.status} -> ${after.status}` +
          (after.status === "DONE" ? "" : "  ⚠ NOT DONE"),
      );
    } catch (e) {
      console.log(`${r.prospect}: ✗ ${(e as Error).message.slice(0, 160)}`);
    }
  }
}

// Importable for tests without running the CLI.
if (process.argv[1] && process.argv[1].endsWith("gate2-cli.ts")) {
  await main();
}
