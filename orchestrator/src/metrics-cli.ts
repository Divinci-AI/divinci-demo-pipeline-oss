/**
 * metrics-cli.ts — `npm run metrics`
 *
 * Walks every runs/<prospect>/<run>/ on disk, extracts a metrics row, writes
 * research/metrics/runs.jsonl, and prints a summary.
 *
 * JSONL rather than a report, because the point is to POOL these later —
 * release metrics, TrustBench aggregates, blog posts, research. A rendered
 * table is a dead end; one JSON object per run can be re-analysed with
 * questions nobody has asked yet.
 *
 *   npm run metrics                 # write + summarise
 *   npm run metrics -- --stdout     # print the JSONL instead of writing
 *   npm run metrics -- --quiet      # write only
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { extractRunMetrics, aggregate, type RunMetrics, type Stats } from "./metrics.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runsDir = join(repoRoot, "runs");
const outDir = join(repoRoot, "research", "metrics");
const outFile = join(outDir, "runs.jsonl");

const args = new Set(process.argv.slice(2));

function queueIndex(): Record<string, { complianceTier?: string; complianceFlags?: string[] }> {
  const p = join(repoRoot, "research", "prospect-queue.yaml");
  if (!existsSync(p)) return {};
  const doc = parseYaml(readFileSync(p, "utf8")) as { prospects?: Record<string, unknown>[] };
  const out: Record<string, { complianceTier?: string; complianceFlags?: string[] }> = {};
  for (const e of doc.prospects ?? []) {
    const slug = e.slug as string | undefined;
    if (slug) {
      out[slug] = {
        complianceTier: e.complianceTier as string | undefined,
        complianceFlags: (e.complianceFlags as string[] | undefined) ?? [],
      };
    }
  }
  return out;
}

function readJson<T>(p: string): T | undefined {
  try { return JSON.parse(readFileSync(p, "utf8")) as T; } catch { return undefined; }
}

function collect(): RunMetrics[] {
  const q = queueIndex();
  const rows: RunMetrics[] = [];
  if (!existsSync(runsDir)) return rows;
  for (const prospect of readdirSync(runsDir)) {
    const pdir = join(runsDir, prospect);
    let runIds: string[];
    try { runIds = readdirSync(pdir); } catch { continue; }
    for (const run of runIds) {
      const dir = join(pdir, run);
      const state = readJson<Parameters<typeof extractRunMetrics>[0]>(join(dir, "state.json"));
      if (!state?.prospect) continue;
      const manifest = readJson<Parameters<typeof extractRunMetrics>[1]>(join(dir, "manifest.json"));
      rows.push(extractRunMetrics(state, manifest, q[prospect]));
    }
  }
  return rows.sort((a, b) => (a.prospect + a.run).localeCompare(b.prospect + b.run));
}

const f = (s: Stats | null, digits = 3): string =>
  !s ? "—" : `n=${s.n} mean=${s.mean.toFixed(digits)} sd=${Number.isNaN(s.sd) ? "—" : s.sd.toFixed(digits)} ` +
             `median=${s.median.toFixed(digits)} [${s.min.toFixed(digits)}, ${s.max.toFixed(digits)}]`;

const rows = collect();
const sum = aggregate(rows);

if (args.has("--stdout")) {
  for (const r of rows) console.log(JSON.stringify(r));
} else {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outFile, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

if (!args.has("--quiet")) {
  console.log(`\n=== WWW-RAG pipeline metrics — ${sum.runs} run(s) ===`);
  if (!args.has("--stdout")) console.log(`written: ${outFile}`);
  console.log(`reached Gate 3: ${sum.reachedGate3}/${sum.runs}   with a QA score: ${sum.withQa}`);
  console.log(`\nQA overall      ${f(sum.qa)}`);
  console.log(`QA weakest test ${f(sum.qaMinTest)}`);
  console.log(`  correctness   ${f(sum.correctness)}`);
  console.log(`  relevance     ${f(sum.relevance)}`);
  console.log(`  completeness  ${f(sum.completeness)}`);
  console.log(`pages crawled   ${f(sum.pages, 0)}`);
  console.log(`\nby scraper:`);
  for (const [k, v] of Object.entries(sum.byScraper).sort((a, b) => b[1].runs - a[1].runs)) {
    console.log(`  ${k.padEnd(32)} runs=${String(v.runs).padStart(3)}  partial=${(v.partialRate * 100).toFixed(0)}%  qa: ${f(v.qa)}`);
  }
  console.log(`\nby compliance tier:`);
  for (const [k, v] of Object.entries(sum.byTier).sort((a, b) => b[1].runs - a[1].runs)) {
    console.log(`  ${k.padEnd(22)} runs=${String(v.runs).padStart(3)}  qa: ${f(v.qa)}`);
  }
  console.log(`\nruns with a partial crawl: ${sum.partialCrawlRuns}/${sum.runs}`);
  console.log(`www-rag submitted: ${sum.wwwRagSubmittedTotal}   failed: ${sum.wwwRagFailedTotal}`);
  // A mean with no denominator is not poolable; say so where n is thin rather
  // than letting a 2-run cell read like a finding.
  const thin = Object.entries(sum.byScraper).filter(([, v]) => (v.qa?.n ?? 0) < 5).map(([k]) => k);
  if (thin.length) console.log(`\n⚠️  thin cells (QA n<5), do not read as findings: ${thin.join(", ")}`);
  console.log();
}
