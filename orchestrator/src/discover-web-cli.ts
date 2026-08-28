/**
 * `npm run discover:web` — two-stage web-backed partner discovery.
 *
 * DRY BY DEFAULT, and deliberately NOT wired into the loop's tick.
 *
 * Two reasons, both about spend rather than correctness. The pipeline is
 * already backed up — as of 2026-08-24, 72 prospects sit unstarted and 44 runs
 * are quarantined — so an automatic new source would pour candidates into a
 * full bucket. And every intake costs a crawl, embeddings and a release, which
 * is real money spent on a source whose yield is by definition unmeasured on
 * its first run. Run it by hand, read what it proposes, and only then decide
 * whether it earns a slot in the tick. `npm run yield` will say whether it did.
 *
 *   npm run discover:web              # stage A only, print candidates, write nothing
 *   npm run discover:web -- --score   # also run stage B scoring, still write nothing
 *   npm run discover:web -- --write   # score, verify against the live web, APPEND
 *   npm run discover:web -- --count 8 --min-score 70
 *
 * `--write` implies `--score`: nothing is queued that has not been scored
 * against partner-scoring.md and then verified to exist.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadQueue, TIERS } from "./intake.js";
import { findCandidates, scoreCandidates } from "./discover-web.js";
import { mergeScores, writePartners, MIN_PARTNER_SCORE } from "./discover-web-write.js";

const repoRoot = join(import.meta.dirname, "..", "..");
const queuePath = process.env.PROSPECT_QUEUE ?? join(repoRoot, "research", "prospect-queue.yaml");
const rubricPath = join(repoRoot, "research", "partner-scoring.md");

const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(`--${name}`);
const value = (name: string, fallback: number): number => {
  const i = argv.indexOf(`--${name}`);
  const n = i >= 0 ? Number(argv[i + 1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const existing = loadQueue(queuePath).map((p) => ({ name: p.name, url: p.url }));
console.log(`excluding ${existing.length} queued prospect(s)`);
console.log("stage A — web search (this makes real web requests and costs tokens)…");

const { candidates, rejected } = await findCandidates({
  existing,
  count: value("count", 10),
  sinceDays: value("since-days", 120),
});

// Every drop is named. A pass that returns 2 of 10 looks identical to one that
// had a bad night, and the reasons are how we learn the prompt asks wrongly.
for (const r of rejected) console.log(`  dropped: ${r}`);
console.log(`\n${candidates.length} candidate(s):`);
for (const c of candidates) {
  console.log(`  ${c.name}  ${c.url}`);
  console.log(`    signal: ${c.signal}`);
  for (const e of c.evidence) console.log(`    evidence: ${e}`);
}

const write = flag("write");

if (!candidates.length) {
  console.log("\nnothing to score.");
} else if (flag("score") || write) {
  console.log("\nstage B — scoring against research/partner-scoring.md (toolless)…");
  const raw = await scoreCandidates(candidates, readFileSync(rubricPath, "utf8"), TIERS);
  const { scored, rejected: scoreRejects } = mergeScores(candidates, raw);
  for (const r of scoreRejects) console.log(`  ${r}`);
  for (const c of scored) console.log(`  ${String(c.score).padStart(3)}  ${c.name}  (${c.complianceTier})`);

  if (write) {
    console.log(
      `\nverifying against the live web and appending (min score ${value("min-score", MIN_PARTNER_SCORE)})…`,
    );
    const res = await writePartners({
      scored,
      existing: loadQueue(queuePath),
      queuePath,
      today: new Date().toISOString().slice(0, 10),
      minScore: value("min-score", MIN_PARTNER_SCORE),
    });
    // Every drop is named. A pass that queues 1 of 6 looks identical to one
    // that had a bad night, and the reasons are how we learn the prompt asks
    // for the wrong thing.
    for (const r of res.rejected) console.log(`  ${r}`);
    console.log(`\nqueued ${res.added} partner(s) as source=web-search icp=partner.`);
    console.log("Run `npm run yield` from now on to see whether this source earns its place.");
  }
}

if (!write) {
  console.log(
    "\nDRY RUN — nothing was written to the queue. Adding a prospect is a spend " +
      "decision (crawl + embeddings + release), so it stays a human one until this " +
      "source has a yield number. Pass --write when you have read the list above.",
  );
}
