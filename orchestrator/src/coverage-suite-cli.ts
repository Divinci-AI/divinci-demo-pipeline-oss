#!/usr/bin/env tsx
/**
 * coverage-suite-cli.ts — measure whether a demo can state what its prospect
 * actually publishes.
 *
 *   tsx src/coverage-suite-cli.ts zilliz ssip           # generate + run + report
 *   tsx src/coverage-suite-cli.ts --write zilliz        # persist to state.json
 *   tsx src/coverage-suite-cli.ts --replicates 3 --reuse zilliz
 *
 * WHY A SECOND SUITE
 * ==================
 * The pipeline's generated ScoredQA suite is HAZARD-shaped by design
 * (qa-suite-gen.ts): its tests reward declining to over-claim. That is a real
 * property worth gating on, but it answers "does the assistant over-promise",
 * not "does the assistant know what this site says".
 *
 * The two come apart hard. On BioRenew (2026-08-15) a corpus holding 8 of 29
 * pages scored within noise of a complete one on the hazard suite — 84.3% vs
 * 84.0% — while a coverage suite over the same two releases showed 79% -> 98%,
 * with the entire effect on pages the first crawl never ingested.
 *
 * And on 2026-08-16 six releases scoring 59-77% on the hazard suite were
 * investigated as retrieval failures; their probes were healthy on every one,
 * and their failures were hazard tests ("predict our p99 latency", "when does X
 * ship"). Nothing in that pipeline could answer whether retrieval was actually
 * GOOD — only that it was not obviously broken.
 *
 * This is the instrument that can produce a `retrieval_limited` verdict
 * honestly, and therefore the only one whose failures justify a RAG arena.
 *
 * ⚠️ It costs: one generation call per prospect plus N QA runs each. Generated
 * suites are written to runs/<prospect>/<run>/coverage-suite.yaml and reused
 * with --reuse, so a re-measure is only the QA runs.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dv } from "./divinci.js";
import { parseMultiReleaseRun } from "./qa.js";
import { generateCoverageSuite, MAX_PAGES, type CoveragePage } from "./coverage-suite.js";
import { extractUrlFromTitle } from "./coverage-audit.js";
import { averageScorers, summariseReplicates } from "./qa-replicates.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const runsRoot = join(repoRoot, "runs");

interface Ctx {
  prospect: string;
  run: string;
  dir: string;
  statePath: string;
  state: Record<string, any>;
  displayName: string;
}

function loadCtx(prospect: string): Ctx | null {
  const pdir = join(runsRoot, prospect);
  if (!existsSync(pdir)) return null;
  // Newest run that actually has a scored release.
  for (const run of readdirSync(pdir).sort().reverse()) {
    const statePath = join(pdir, run, "state.json");
    if (!existsSync(statePath)) continue;
    let state: Record<string, any>;
    try {
      state = JSON.parse(readFileSync(statePath, "utf8"));
    } catch {
      continue;
    }
    if (!state.vectorId || !state.releaseId || !state.workspaceId) continue;
    let displayName = prospect;
    try {
      displayName = JSON.parse(readFileSync(join(pdir, run, "manifest.json"), "utf8")).prospectName ?? prospect;
    } catch {
      /* manifest optional */
    }
    return { prospect, run, dir: join(pdir, run), statePath, state, displayName };
  }
  return null;
}

/**
 * Pull the vector's chunks and reassemble per-page text.
 *
 * Chunks are grouped by their file title, which encodes the source URL — the
 * same convention coverage-audit.ts reads. A page is only as good as the text
 * we can reconstruct for it, so chunks are concatenated in the order returned
 * rather than sampled.
 */
async function fetchPages(ctx: Ctx, maxChunks: number): Promise<CoveragePage[]> {
  // 1. File index: id -> URL and the TRUE chunk count for that page.
  const files = await dv(["rag", "files", "--limit", "2000"], {
    workspace: String(ctx.state.workspaceId),
    timeoutMs: 5 * 60 * 1000,
  });
  const fj: any = files.json;
  const fileArr: any[] = Array.isArray(fj) ? fj : (fj?.files ?? fj?.page ?? []);
  const meta = new Map<string, { url: string; total: number }>();
  for (const f of fileArr) {
    const id = String(f?._id ?? "");
    if (!id) continue;
    const url =
      (typeof f.sourceUrl === "string" && f.sourceUrl) ||
      extractUrlFromTitle(String(f.title ?? "")) ||
      String(f.title ?? id);
    meta.set(id, { url, total: Number(f.chunksCount) || 0 });
  }

  // 2. Chunks, bounded. `page` is the array key — not `chunks`/`results`,
  //    which is what an earlier version guessed and got zero pages from.
  const parts = new Map<string, string[]>();
  const PAGE = 200;
  for (let offset = 0; offset < maxChunks; offset += PAGE) {
    const res = await dv(
      ["rag", "chunks", String(ctx.state.vectorId), "--offset", String(offset), "--length", String(PAGE)],
      { workspace: String(ctx.state.workspaceId), timeoutMs: 5 * 60 * 1000 },
    );
    const j: any = res.json;
    const chunks: any[] = j?.page ?? [];
    if (!chunks.length) break;
    for (const c of chunks) {
      const fileId = String(c?.docSource?._id ?? "");
      const text = String(c?.text ?? "").trim();
      if (!fileId || !text) continue;
      parts.set(fileId, [...(parts.get(fileId) ?? []), text]);
    }
    if (chunks.length < PAGE) break;
  }

  // 3. Only pages we hold IN FULL.
  //
  // selectPages ranks longest-first, so a page truncated by the chunk budget
  // would be judged short and dropped — or worse, kept and used to generate a
  // question whose answer sits in a chunk we never read. Comparing against the
  // file's own chunksCount removes that bias entirely; the cost is covering
  // fewer pages per pass, which is the right trade for a measurement whose
  // whole purpose is to be trusted.
  const pages: CoveragePage[] = [];
  let partial = 0;
  for (const [fileId, texts] of parts) {
    const m = meta.get(fileId);
    if (!m) continue;
    if (m.total && texts.length < m.total) {
      partial++;
      continue;
    }
    pages.push({ url: m.url, text: texts.join("\n\n") });
  }
  if (partial) console.log(`   (${partial} page(s) only partially fetched — excluded)`);
  return pages;
}

async function runSuite(ctx: Ctx, suiteId: string, n: number) {
  const scores: number[] = [];
  const scorerRuns: (Record<string, number> | undefined)[] = [];
  for (let i = 1; i <= n; i++) {
    try {
      const res = await dv(["qa", "multi-release-run", suiteId, "--release", String(ctx.state.releaseId)], {
        workspace: String(ctx.state.workspaceId),
        timeoutMs: 30 * 60 * 1000,
      });
      const run = parseMultiReleaseRun(res.raw, res.json);
      const rel = run.perRelease[0];
      if (typeof rel?.overallScore !== "number") throw new Error("no overallScore");
      scores.push(rel.overallScore);
      scorerRuns.push(rel.scoreAverages as Record<string, number> | undefined);
      console.log(`   coverage replicate ${i}: ${(rel.overallScore * 100).toFixed(1)}%`);
    } catch (e) {
      console.log(`   coverage replicate ${i}: FAILED — ${(e as Error).message.split("\n")[0].slice(0, 140)}`);
    }
  }
  return { scores, scorers: averageScorers(scorerRuns) };
}

async function one(prospect: string, opts: { n: number; write: boolean; reuse: boolean }) {
  const ctx = loadCtx(prospect);
  if (!ctx) {
    console.log(`\n━━ ${prospect}: no run with a scored release — skipped`);
    return null;
  }
  const hazard = typeof ctx.state.qaScore === "number" ? ctx.state.qaScore : null;
  console.log(
    `\n━━ ${prospect} / ${ctx.run}` + (hazard !== null ? `  (hazard suite: ${(hazard * 100).toFixed(1)}%)` : ""),
  );

  const yamlPath = join(ctx.dir, "coverage-suite.yaml");
  if (!existsSync(yamlPath) || !opts.reuse) {
    const pages = await fetchPages(ctx, MAX_PAGES * 40);
    console.log(`   reconstructed ${pages.length} page(s) from the vector`);
    if (pages.length < 4) {
      console.log("   too few pages to build a coverage suite — skipped");
      return null;
    }
    try {
      const yamlText = await generateCoverageSuite({
        prospect: ctx.prospect,
        displayName: ctx.displayName,
        pages,
      });
      writeFileSync(yamlPath, `${yamlText}\n`);
      console.log(`   generated ${yamlPath.replace(repoRoot, "")}`);
    } catch (e) {
      console.log(`   generation failed — ${(e as Error).message.split("\n")[0]}`);
      return null;
    }
  } else {
    console.log("   reusing existing coverage-suite.yaml");
  }

  // Import as a SEPARATE suite. The hazard suite is left untouched: the two
  // measure different things and must stay independently comparable over time.
  let suiteId: string | undefined = ctx.state.coverageSuiteId;
  if (!suiteId) {
    const res = await dv(["qa", "import", yamlPath], {
      workspace: String(ctx.state.workspaceId),
      json: false,
    });
    suiteId = res.raw.match(/New suite ID:\s*([0-9a-f]{24})/)?.[1];
    if (!suiteId) {
      console.log(`   could not parse a suite id from import output`);
      return null;
    }
    console.log(`   imported coverage suite ${suiteId}`);
  }

  const { scores, scorers } = await runSuite(ctx, suiteId, opts.n);
  const s = summariseReplicates(scores);
  if (!s) {
    console.log("   no coverage replicate scored");
    return null;
  }
  console.log(
    `   coverage mean ${(s.mean * 100).toFixed(1)}%  sd ${s.sd === null ? "—" : (s.sd * 100).toFixed(1)}` +
      (hazard !== null ? `   (hazard ${(hazard * 100).toFixed(1)}%, delta ${((s.mean - hazard) * 100).toFixed(1)}pp)` : ""),
  );

  if (opts.write) {
    const next = { ...ctx.state, coverageSuiteId: suiteId, coverageQaReplicates: scores, coverageQaScore: s.mean, coverageQaScoreSd: s.sd, coverageQaScorers: scorers };
    writeFileSync(ctx.statePath, JSON.stringify(next, null, 2));
    console.log("   ✍️  written to state.json");
  }
  return { prospect, hazard, coverage: s.mean, sd: s.sd, scorers };
}

async function main() {
  const argv = process.argv.slice(2);
  const write = argv.includes("--write");
  const reuse = argv.includes("--reuse");
  const nAt = argv.indexOf("--replicates");
  const n = nAt >= 0 ? Number(argv[nAt + 1]) : 3;
  const names = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--replicates");
  if (!names.length) {
    console.log("usage: coverage-suite-cli.ts [--write] [--reuse] [--replicates N] <prospect...>");
    return;
  }

  const out = [];
  for (const p of names) out.push(await one(p, { n, write, reuse }));

  console.log("\n━━ hazard vs coverage");
  console.log("   prospect             hazard   coverage   delta");
  for (const r of out.filter(Boolean)) {
    const h = r!.hazard === null ? "   —  " : `${(r!.hazard * 100).toFixed(1)}%`;
    const d = r!.hazard === null ? "  —" : `${((r!.coverage - r!.hazard) * 100).toFixed(1)}pp`;
    console.log(`   ${r!.prospect.padEnd(20)} ${h.padStart(6)}   ${(r!.coverage * 100).toFixed(1).padStart(6)}%   ${d.padStart(7)}`);
  }
  console.log(
    "\n   A coverage score WELL BELOW the hazard score means the assistant cannot state\n" +
      "   what the site publishes — the case a retrieval arena exists for. A coverage\n" +
      "   score at or above it means retrieval is doing its job and the shortfall is\n" +
      "   guardrail behaviour, where no RAG arm will help.",
  );
}

main().catch((e) => {
  console.error(`coverage-suite-cli failed: ${(e as Error).message}`);
  process.exit(1);
});
