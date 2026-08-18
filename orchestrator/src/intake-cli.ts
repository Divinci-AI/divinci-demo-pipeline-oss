/**
 * Manual intake — build one prospect's run directory without waiting for a tick.
 *
 *   npm run intake -- --next               # take the top of the queue
 *   npm run intake -- --prospect stoneclinic
 *   npm run intake -- --next --dry-run     # recon + plan, write nothing
 *
 * Writes runs/<slug>/<today>-NNN/{manifest.json,recon.json} with
 * `approvedBy: null`. Gate 1 still has to be approved by a person; this command
 * only prepares what they review.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildManifestPrompt,
  intakeProspect,
  loadQueue,
  reconSite,
  selectNextProspect,
} from "./intake.js";

const orchestratorDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(orchestratorDir, "..");
const runsDir = join(repoRoot, "runs");

{
  const envPath = join(orchestratorDir, ".env");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  }
}

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const wantsNext = argv.includes("--next");
const slugIdx = argv.indexOf("--prospect");
const slug = slugIdx >= 0 ? argv[slugIdx + 1] : undefined;

const queuePath = process.env.PROSPECT_QUEUE ?? join(repoRoot, "research", "prospect-queue.yaml");

async function main(): Promise<void> {
  if (!wantsNext && !slug) {
    console.error("usage: npm run intake -- (--next | --prospect <slug>) [--dry-run]");
    process.exit(2);
  }

  const queue = loadQueue(queuePath);
  const apiUrl = process.env.DIVINCI_API_URL ?? "https://api.divinci.app";
  const prospect = slug ? queue.find((p) => p.slug === slug) : selectNextProspect(queue, runsDir, apiUrl);

  if (!prospect) {
    console.error(
      slug
        ? `no prospect "${slug}" in ${queuePath}`
        : "queue is empty — every prospect is held or already has a run",
    );
    process.exit(1);
  }

  // A named prospect bypasses the "already taken" filter, so say so rather than
  // silently creating a second run for a site we have already crawled.
  if (slug && selectNextProspect([prospect], runsDir, apiUrl) === undefined) {
    console.warn(
      `⚠ ${prospect.slug} is held or already has a run — this will create an ADDITIONAL run ` +
        `(a second crawl of ${prospect.url}).`,
    );
  }

  console.log(`intake: ${prospect.name} (${prospect.url}) — tier ${prospect.complianceTier}`);

  if (dryRun) {
    const recon = await reconSite(prospect.url);
    console.log(
      `recon: reachable=${recon.reachable} pages=${recon.sitemapUrls.length} spa=${recon.likelySpa}` +
        (recon.note ? ` note=${recon.note}` : ""),
    );
    for (const p of recon.topPaths.slice(0, 8)) console.log(`  ${p.prefix} — ${p.count}`);
    console.log("\n--- manifest prompt (not sent) ---\n");
    console.log(buildManifestPrompt({ prospect, recon, runId: "dry-run" }));
    return;
  }

  const result = await intakeProspect({ prospect, runsDir });
  console.log(
    `wrote ${result.manifestPath}\n` +
      `  ${result.sourceCount} source(s), ${result.plannedPages} planned pages\n` +
      `  Gate 1 is UNAPPROVED — review the manifest, then:\n` +
      `    npm run demo -- --prospect ${prospect.slug} --run ${result.runId}`,
  );
}

void main().catch((err) => {
  console.error(`intake failed: ${(err as Error).message}`);
  process.exit(1);
});
