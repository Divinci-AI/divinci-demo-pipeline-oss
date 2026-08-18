/**
 * migrate-landing-v3 — second round of cross-demo landing fixes (verified on
 * excelspine), retrofitted onto all saved foundation.html + dist/index.html:
 *
 *  1. Pointer-events: hero content uses inline `z-index:10` (no z-10 class), so
 *     `.circle-overlay > [class~="z-10"]{pointer-events:auto}` missed it and the
 *     whole hero (chat iframe + starters) stayed pointer-events:none. Broaden the
 *     selector to also match inline-styled content. (Fixes the dead chat.)
 *  2. Language switcher: add a click→navigate handler (en→/, others→/<code>/);
 *     previously items did nothing.
 *  3. Ask bar: scroll to the #example "Real answers" section instead of the hero.
 *  4. Autofocus: focus the hero embed's first input on load (same-origin).
 *  5. Heading line break: "Real answers,<br>straight from …".
 *  6. Bigger header logo (34→46px height, wider chip).
 *
 * Idempotent: each transform no-ops if its target string is already gone/changed.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RUNS = resolve(dirname(fileURLToPath(import.meta.url)), "../../runs");
const TARGETS = [
  ["excelspine", "2026-06-15-001"], ["amymyersmd", "2026-06-15-001"],
  ["backincontrol", "2026-06-15-001"], ["caseymeans", "2026-06-15-001"],
  ["centenoschultz", "2026-06-15-001"], ["discsportsspine", "2026-06-15-001"],
  ["drchatterjee", "2026-06-15-001"], ["drhyman", "2026-06-15-001"],
  ["drvondawright", "2026-06-15-001"], ["drwilliamli", "2026-06-15-001"],
  ["mdspinecare", "2026-06-10-001"], ["nutritionfacts", "2026-06-15-001"],
  ["peterattiamd", "2026-06-15-001"], ["stoneclinic", "2026-06-14-001"],
  ["texasback", "2026-06-15-001"],
];

const HERO_FOCUS =
  `<script>/*hero-focus*/(function(){var f=document.getElementById('df-hero-embed');if(!f)return;` +
  `var done=false;function fz(){if(done)return;try{var doc=f.contentDocument;if(!doc)return;` +
  `var el=doc.querySelector('textarea,input[type=text],input[type=email],input:not([type])');` +
  `if(el){el.focus({preventScroll:true});done=true;}}catch(e){}}` +
  `f.addEventListener('load',fz);[400,1000,2000].forEach(function(t){setTimeout(fz,t);});})();</script>`;
const LANG_NAV =
  `\n/* navigate to the selected locale (en→/, others→/<code>/) */\n` +
  `d.addEventListener('click',function(e){var i=e.target.closest('.ls-i');if(!i)return;` +
  `var code=i.dataset.locale;try{localStorage.setItem('df-lang',code);}catch(_){}` +
  `location.assign(code==='en'?'/':'/'+code+'/');});`;
const LANG_ANCHOR =
  "d.addEventListener('keydown',function(e){if(e.key==='Escape'){r.classList.remove('open');b.focus();}});";

function apply(html) {
  const flags = [];
  // 1. pointer-events
  const peOld = '.circle-overlay > [class~="z-10"]{pointer-events:auto}';
  const peNew = '.circle-overlay > [class~="z-10"],.circle-overlay > [style*="z-index:10"],.circle-overlay > [style*="z-index: 10"]{pointer-events:auto}';
  if (html.includes(peOld)) { html = html.replace(peOld, peNew); flags.push("ptr"); }
  // 2. language navigation
  if (!html.includes("navigate to the selected locale") && html.includes(LANG_ANCHOR)) {
    html = html.replace(LANG_ANCHOR, LANG_ANCHOR + LANG_NAV); flags.push("lang");
  }
  // 3. ask bar → #example
  const abOld = "heroChat.scrollIntoView({behavior:'smooth',block:'center'});if(bar)bar.classList.remove('show');";
  const abNew = "(document.getElementById('example')||heroChat).scrollIntoView({behavior:'smooth',block:'start'});if(bar)bar.classList.remove('show');";
  if (html.includes(abOld)) { html = html.replace(abOld, abNew); flags.push("ask"); }
  // 4. autofocus
  if (!html.includes("/*hero-focus*/") && html.includes("</body>")) {
    html = html.replace("</body>", `${HERO_FOCUS}\n</body>`); flags.push("focus");
  }
  // 5. heading line break
  if (html.includes("Real answers, straight from")) {
    html = html.replace("Real answers, straight from", "Real answers,<br>straight from"); flags.push("br");
  }
  // 6. bigger logo
  if (html.includes("height:34px;width:auto;max-width:190px")) {
    html = html.split("height:34px;width:auto;max-width:190px").join("height:46px;width:auto;max-width:230px");
    html = html.split("border-radius:12px;padding:5px 10px").join("border-radius:14px;padding:6px 13px");
    flags.push("logo");
  }
  return { html, flags };
}

let n = 0;
for (const [p, run] of TARGETS) {
  const dir = join(RUNS, p, run, "landing");
  const fpath = join(dir, "foundation.html");
  if (!existsSync(fpath)) { console.log(`SKIP ${p}: no foundation.html`); continue; }
  const { html, flags } = apply(readFileSync(fpath, "utf8"));
  writeFileSync(fpath, html);
  const distIdx = join(dir, "site", "dist", "index.html");
  const mirrored = existsSync(distIdx);
  if (mirrored) writeFileSync(distIdx, html);
  n++;
  console.log(`OK ${p.padEnd(16)} [${flags.join(",") || "—"}] dist:${mirrored ? "✓" : "MISSING"}`);
}
console.log(`\nPatched ${n}/${TARGETS.length}. Deploy next.`);
