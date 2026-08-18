#!/usr/bin/env tsx
/**
 * rag-stack-cli.ts — label the back-catalogue.
 *
 *   tsx src/rag-stack-cli.ts            # resolve every run's stack, cache it
 *   tsx src/rag-stack-cli.ts --report   # cached only, no network
 *   tsx src/rag-stack-cli.ts --refresh  # re-fetch even when cached
 *
 * Walks runs/<prospect>/<run>/state.json, resolves each `vectorId` to a stack
 * descriptor, and prints QA score grouped by stack — the question the dataset
 * could not answer before rag-stack.ts existed.
 *
 * ⚠️ Reads the mean AND the spread, and prints n. On this pipeline an
 * UNCHANGED config has been measured at 79/87/87, so a stack with n=1 tells
 * you nothing at all and a two-point difference between stacks with n=3 is
 * still probably noise. The report shows those numbers rather than ranking
 * arms, deliberately: a leaderboard invites picking a winner that the data
 * does not support.
 *
 * ⚠️ Many old demos are torn down, so their vectors 404. That is expected, not
 * an error — an unlabelled historical run simply cannot join an arm.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cachedStack,
  defaultCachePath,
  isUnlabelled,
  resolveStack,
  stackKey,
  type RagStackDescriptor,
} from "./rag-stack.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const runsRoot = join(repoRoot, "runs");
const cachePath = defaultCachePath(repoRoot);

interface Row {
  prospect: string;
  run: string;
  qaScore: number | null;
  stack: RagStackDescriptor | null;
}

function loadRuns(): { prospect: string; run: string; state: Record<string, unknown> }[] {
  if (!existsSync(runsRoot)) return [];
  const out: { prospect: string; run: string; state: Record<string, unknown> }[] = [];
  for (const prospect of readdirSync(runsRoot).sort()) {
    const pdir = join(runsRoot, prospect);
    let runs: string[];
    try {
      runs = readdirSync(pdir).sort();
    } catch {
      continue; // not a directory (e.g. the cache file itself)
    }
    for (const run of runs) {
      const f = join(pdir, run, "state.json");
      if (!existsSync(f)) continue;
      try {
        out.push({ prospect, run, state: JSON.parse(readFileSync(f, "utf8")) });
      } catch {
        // Unreadable state.json contributes nothing. Common for aborted runs.
      }
    }
  }
  return out;
}

function stats(xs: number[]) {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  return { n: xs.length, mean, sd, min: Math.min(...xs), max: Math.max(...xs) };
}

async function main() {
  const reportOnly = process.argv.includes("--report");
  const refresh = process.argv.includes("--refresh");

  const runs = loadRuns();
  const rows: Row[] = [];
  let fetched = 0;
  let unreadable = 0;

  for (const r of runs) {
    const vectorId = typeof r.state.vectorId === "string" ? r.state.vectorId : null;
    const workspaceId = typeof r.state.workspaceId === "string" ? r.state.workspaceId : null;
    const qaScore = typeof r.state.qaScore === "number" ? r.state.qaScore : null;

    let stack: RagStackDescriptor | null = null;
    if (vectorId) {
      stack = cachedStack(vectorId, cachePath);
      if (!stack && !reportOnly && workspaceId) {
        try {
          stack = await resolveStack(vectorId, { workspaceId, cachePath, refresh });
          if (stack) fetched++;
          else unreadable++;
        } catch {
          unreadable++; // torn-down demo, revoked key — expected for old runs
        }
      }
    }
    rows.push({ prospect: r.prospect, run: r.run, qaScore, stack });
  }

  const byStack = new Map<string, number[]>();
  let unlabelled = 0;
  for (const row of rows) {
    if (row.qaScore === null) continue;
    if (!row.stack || isUnlabelled(row.stack)) {
      unlabelled++;
      continue;
    }
    const k = stackKey(row.stack);
    byStack.set(k, [...(byStack.get(k) ?? []), row.qaScore]);
  }

  console.log(`runs: ${rows.length}   scored: ${rows.filter((r) => r.qaScore !== null).length}`);
  if (!reportOnly) console.log(`resolved this pass: ${fetched}   unreadable (torn down): ${unreadable}`);
  console.log(`scored runs with an unlabelled stack: ${unlabelled}`);
  console.log();

  const entries = [...byStack.entries()].sort((a, b) => b[1].length - a[1].length);
  if (!entries.length) {
    console.log("No labelled stacks yet. Run without --report to resolve them.");
    return;
  }

  console.log("QA score by retrieval stack — n, mean, spread:");
  console.log();
  for (const [k, xs] of entries) {
    const s = stats(xs);
    const warn = s.n < 3 ? "  ⚠ n<3, not comparable" : "";
    console.log(
      `  ${(s.mean * 100).toFixed(1)}%  ±${(s.sd * 100).toFixed(1)}  ` +
        `[${(s.min * 100).toFixed(0)}–${(s.max * 100).toFixed(0)}]  n=${String(s.n).padStart(2)}  ${k}${warn}`,
    );
  }
  console.log();
  console.log(
    "⚠️ An unchanged config has been measured at 79/87/87 on this pipeline. Treat any\n" +
      "   difference smaller than the widest ±sd above as unresolved, not as a winner.",
  );
}

main().catch((e) => {
  console.error(`rag-stack-cli failed: ${(e as Error).message}`);
  process.exit(1);
});
