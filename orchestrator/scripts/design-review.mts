// Run a visual design-review pass on a deployed landing page.
// Usage: tsx scripts/design-review.mts <url> [round] [outPath]
import { reviewLanding } from "../src/design-review.js";

const [url, round, outPath] = process.argv.slice(2);
if (!url) throw new Error("usage: design-review.mts <url> [round] [outPath]");
const { findings, overall } = await reviewLanding(url, {
  round: round ? Number(round) : 1,
  outPath: outPath || undefined,
});
console.log("\nVERDICT:", overall);
console.log(`FINDINGS: ${findings.length}`);
for (const f of findings) console.log(`  [${f.severity}] ${f.area}: ${f.issue}`);
