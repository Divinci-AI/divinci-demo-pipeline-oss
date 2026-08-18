/**
 * `discover` on demand — the same pass the loop runs, callable by hand.
 *
 * Exists so a discovery pass can be rehearsed before it runs unattended:
 * `--dry-run` does the model call and every live verification, prints exactly
 * what it would queue and why it dropped the rest, and writes nothing.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { discoverProspects, unstartedBacklog } from "./discover.js";
import { parseQueue } from "./intake.js";

const orchestratorDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(orchestratorDir, "..");

{
  const envPath = join(orchestratorDir, ".env");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  }
}

const dryRun = process.argv.includes("--dry-run");
const countArg = process.argv.indexOf("--count");
const count = countArg > -1 ? Number(process.argv[countArg + 1]) : undefined;
const queuePath = process.env.PROSPECT_QUEUE ?? join(repoRoot, "research", "prospect-queue.yaml");
const runsDir = join(repoRoot, "runs");

const queue = parseQueue(readFileSync(queuePath, "utf8"));
console.log(
  `queue: ${queue.length} prospect(s), ${unstartedBacklog(queue, runsDir).length} unstarted` +
    `${dryRun ? "  [DRY RUN — nothing will be written]" : ""}`,
);

const res = await discoverProspects({
  queuePath,
  runsDir,
  rubricPath: join(repoRoot, "research", "adjacency-scoring.md"),
  today: new Date().toISOString().slice(0, 10),
  count,
  dryRun,
});

console.log(`\nconsidered ${res.considered} · verified ${res.verified.length} · dropped ${res.rejected.length}`);
for (const v of res.verified)
  console.log(
    `  ✓ ${v.slug.padEnd(22)} ${String(v.score).padStart(3)} · ${v.complianceTier}` +
      `${v.complianceFlags?.length ? ` +${v.complianceFlags.join(",")}` : ""} · ` +
      `${v.measuredPages} pages · ${v.url}`,
  );
for (const r of res.rejected) console.log(`  ✗ ${r}`);
if (!dryRun) console.log(`\nqueued ${res.added}`);
