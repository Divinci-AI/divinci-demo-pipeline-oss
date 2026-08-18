// One-off: re-run the deterministic polishFoundation passes over an EXISTING
// run's foundation.html (idempotent) so an older demo inherits the latest hero
// treatment, fixed Ask bar, footer legal links, etc. — without claude regen.
// Usage: tsx scripts/_polish.mts <prospect> <run>
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { polishFoundation } from "../src/foundation-polish.js";

const [prospect, run] = process.argv.slice(2);
if (!prospect || !run) throw new Error("usage: _polish.mts <prospect> <run>");

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const landingDir = join(repoRoot, "runs", prospect, run, "landing");
const d = JSON.parse(readFileSync(join(landingDir, "brand-draft.json"), "utf8"));
const before = readFileSync(join(landingDir, "foundation.html"), "utf8");

const after = polishFoundation(before, {
  palette: d.palette,
  heroImageUrl: d.heroImageUrl,
  productName: d.productName,
  corpusVideo: d.corpusVideoUrl ? { videoUrl: d.corpusVideoUrl } : undefined,
  team: { count: (d.bios || []).length, leadName: (d.bios || [])[0]?.name },
});

writeFileSync(join(landingDir, "foundation.html"), after);
const has = (m: string) => (after.includes(m) ? "✓" : "—");
console.log(`polished ${prospect}/${run}: ${before.length}b → ${after.length}b`);
console.log(`  hero-orbit ${has("hero-orbit")}  circle-overlay ${has("circle-overlay")}  df-askbar ${has('id="df-askbar"')}  footer-legal ${has("terms-of-service")}  embed-resize ${has("divinci-embed-height")}`);
