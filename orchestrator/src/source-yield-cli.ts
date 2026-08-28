/**
 * `npm run yield` — what each discovery source actually produced.
 *
 * Read this before adding a source, and before defending one. It is the only
 * thing that turns "is <source> still valuable?" into a number.
 */
import { join } from "node:path";
import { loadQueue } from "./intake.js";
import { computeYield, renderYield } from "./source-yield.js";

const repoRoot = join(import.meta.dirname, "..", "..");
const queuePath = process.env.PROSPECT_QUEUE ?? join(repoRoot, "research", "prospect-queue.yaml");
const runsDir = process.env.RUNS_DIR ?? join(repoRoot, "runs");

const report = computeYield(loadQueue(queuePath), runsDir);
console.log(renderYield(report));
console.log(
  `\ntotals  queued ${report.totals.queued}  started ${report.totals.started}  ` +
    `live ${report.totals.live}  outreach ${report.totals.outreach}  quarantined ${report.totals.quarantined}`,
);
