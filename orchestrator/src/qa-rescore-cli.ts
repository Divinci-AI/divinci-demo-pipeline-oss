#!/usr/bin/env tsx
/**
 * qa-rescore-cli.ts — give an already-scored release a real noise band.
 *
 *   tsx src/qa-rescore-cli.ts zilliz acmeparts vespa          # report only
 *   tsx src/qa-rescore-cli.ts --write --gate 0.9 zilliz  # persist replicates
 *   tsx src/qa-rescore-cli.ts --below 0.7 --write        # every alive run under 70%
 *
 * WHY
 * ===
 * 72 of the catalogue's runs were scored exactly once, so every one of them is
 * a single draw and none can be triaged: qa-triage refuses to diagnose without
 * replicates, correctly. Re-scoring costs no re-crawl and no re-ingest — it is
 * the same suite against the same release — and it is the only way to learn
 * whether a low score is a defect or a bad draw.
 *
 * Measured on zilliz 2026-08-16: 57.5 / 62.5 / 57.5. The 59.2% was real, and
 * three runs cost about two minutes.
 *
 * ⚠️ HISTORY IS PRESERVED. `--write` records the replicates and sets qaScore to
 * their mean, but keeps the original single draw in `qaScoreOriginalDraw`. A
 * dataset that silently rewrites its own past cannot be audited, and the
 * original number is what earlier decisions were made against.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dv } from "./divinci.js";
import { parseMultiReleaseRun } from "./qa.js";
import { averageScorers, summariseReplicates } from "./qa-replicates.js";
import { formatTriage, triage } from "./qa-triage.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const runsRoot = join(repoRoot, "runs");

interface Target {
  prospect: string;
  run: string;
  path: string;
  state: Record<string, unknown>;
}

function findTargets(names: string[], below: number | null): Target[] {
  const out: Target[] = [];
  for (const prospect of readdirSync(runsRoot).sort()) {
    if (names.length && !names.includes(prospect)) continue;
    let runs: string[];
    try {
      runs = readdirSync(join(runsRoot, prospect)).sort();
    } catch {
      continue;
    }
    for (const run of runs) {
      const path = join(runsRoot, prospect, run, "state.json");
      if (!existsSync(path)) continue;
      let state: Record<string, unknown>;
      try {
        state = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        continue;
      }
      const s = state.qaScore;
      if (typeof s !== "number") continue;
      if (below !== null && s >= below) continue;
      // A re-score needs the release AND the suite that scored it.
      if (!state.releaseId || !state.qaSuiteId || !state.workspaceId) continue;
      out.push({ prospect, run, path, state });
    }
  }
  return out.sort((a, b) => (a.state.qaScore as number) - (b.state.qaScore as number));
}

async function rescore(t: Target, n: number, gate: number, write: boolean) {
  const original = t.state.qaScore as number;
  console.log(`\n━━ ${t.prospect} / ${t.run} — recorded ${(original * 100).toFixed(1)}%`);

  const scores: number[] = [];
  const scorerRuns: (Record<string, number> | undefined)[] = [];
  for (let i = 1; i <= n; i++) {
    try {
      const res = await dv(
        ["qa", "multi-release-run", String(t.state.qaSuiteId), "--release", String(t.state.releaseId)],
        { workspace: String(t.state.workspaceId), timeoutMs: 30 * 60 * 1000 },
      );
      const run = parseMultiReleaseRun(res.raw, res.json);
      const rel = run.perRelease[0];
      if (typeof rel?.overallScore !== "number") throw new Error("no overallScore");
      scores.push(rel.overallScore);
      scorerRuns.push(rel.scoreAverages as Record<string, number> | undefined);
      console.log(`   ${i}: ${(rel.overallScore * 100).toFixed(1)}%`);
    } catch (e) {
      // Partial sets still beat one draw.
      console.log(`   ${i}: FAILED — ${(e as Error).message.split("\n")[0].slice(0, 120)}`);
    }
  }

  const s = summariseReplicates(scores);
  if (!s) {
    console.log("   no replicate scored — left untouched");
    return null;
  }
  const scorers = averageScorers(scorerRuns);
  console.log(
    `   mean ${(s.mean * 100).toFixed(1)}%  sd ${s.sd === null ? "—" : (s.sd * 100).toFixed(1)}  ` +
      `[${(s.min * 100).toFixed(1)}–${(s.max * 100).toFixed(1)}]  (recorded draw ${(original * 100).toFixed(1)}%)`,
  );

  const t2 = triage({ qaScore: s.mean, threshold: gate, replicates: scores, scorers });
  console.log(
    formatTriage(t2)
      .split("\n")
      .map((l) => `   ${l}`)
      .join("\n"),
  );

  if (write) {
    const next = { ...t.state };
    // Keep the number earlier decisions were made against.
    if (next.qaScoreOriginalDraw === undefined) next.qaScoreOriginalDraw = original;
    next.qaReplicates = scores;
    next.qaScoreSd = s.sd;
    next.qaScore = s.mean;
    if (Object.keys(scorers).length) next.qaScoreAverages = scorers;
    next.qaTriage = { verdict: t2.verdict, arms: t2.recommendedArms, at: new Date().toISOString() };
    writeFileSync(t.path, JSON.stringify(next, null, 2));
    console.log(`   ✍️  written (original draw preserved as qaScoreOriginalDraw)`);
  }
  return { prospect: t.prospect, mean: s.mean, sd: s.sd, verdict: t2.verdict, arms: t2.recommendedArms };
}

async function main() {
  const argv = process.argv.slice(2);
  const write = argv.includes("--write");
  const nAt = argv.indexOf("--replicates");
  const n = nAt >= 0 ? Number(argv[nAt + 1]) : 3;
  const gAt = argv.indexOf("--gate");
  const gate = gAt >= 0 ? Number(argv[gAt + 1]) : 0.9;
  const bAt = argv.indexOf("--below");
  const below = bAt >= 0 ? Number(argv[bAt + 1]) : null;
  const names = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--replicates" && argv[i - 1] !== "--gate" && argv[i - 1] !== "--below");

  const targets = findTargets(names, below);
  if (!targets.length) {
    console.log("no targets (need a run with qaScore, releaseId, qaSuiteId and workspaceId)");
    return;
  }
  console.log(
    `${targets.length} target(s) · ${n} replicates each · gate ${(gate * 100).toFixed(0)}% · ` +
      `${write ? "WRITING" : "report only"}  →  ${targets.length * n} QA runs`,
  );

  const results = [];
  for (const t of targets) results.push(await rescore(t, n, gate, write));

  console.log("\n━━ summary");
  for (const r of results.filter(Boolean)) {
    console.log(
      `   ${(r!.mean * 100).toFixed(1)}%  sd ${r!.sd === null ? "—" : (r!.sd * 100).toFixed(1)}  ` +
        `${r!.prospect.padEnd(24)} ${r!.verdict}${r!.arms.length ? `  arms=${r!.arms.join(",")}` : ""}`,
    );
  }
}

main().catch((e) => {
  console.error(`qa-rescore failed: ${(e as Error).message}`);
  process.exit(1);
});
