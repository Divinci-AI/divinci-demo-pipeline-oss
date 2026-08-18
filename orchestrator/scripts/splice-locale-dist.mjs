/**
 * splice-locale-dist — write the bespoke English foundation over dist/index.html
 * and each translated locale-foundations/<code>.html over dist/<code>/index.html,
 * rewriting the chat iframe to /<code>/embed/ and setting <html lang>/dir. Mirrors
 * landing.ts spliceBespokeLocales for manual per-run rollouts.
 *
 * Usage: node splice-locale-dist.mjs <landingDir>
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const landingDir = process.argv[2];
if (!landingDir) { console.error("need <landingDir>"); process.exit(1); }
const site = join(landingDir, "site", "dist");
const lf = join(landingDir, "locale-foundations");
const RTL = new Set(["ar", "he", "ur", "fa"]);

writeFileSync(join(site, "index.html"), readFileSync(join(landingDir, "foundation.html"), "utf8"));
let n = 0, skipped = 0;
for (const f of (existsSync(lf) ? readdirSync(lf) : []).filter((x) => x.endsWith(".html") && !x.startsWith("_"))) {
  const code = f.replace(/\.html$/, "");
  if (!existsSync(join(site, code))) { skipped++; continue; }
  let shell = readFileSync(join(lf, f), "utf8");
  shell = shell.replace(/(<iframe[^>]*\bid="df-(?:hero|example)-embed"[^>]*\bsrc=")\/embed\/(")/g, `$1/${code}/embed/$2`);
  const dir = RTL.has(code) ? ` dir="rtl"` : "";
  shell = shell.replace(/<html\b[^>]*>/i, `<html lang="${code}"${dir}>`);
  writeFileSync(join(site, code, "index.html"), shell);
  n++;
}
console.log(`spliced en + ${n} locale shells${skipped ? ` (${skipped} had no dist dir)` : ""}`);
