/**
 * migrate-landing-v2 — retrofit existing demo landing pages with the two
 * GENERAL polish fixes verified on excelspine:
 *
 *   1. Language switcher: move the globe from a fixed top-right overlay (which
 *      collides with the header "Ask the AI" CTA) into the header nav, inline,
 *      right before the CTA. Done by (a) flipping .ls-r from fixed→relative and
 *      (b) injecting a tiny relocation snippet into the existing ls IIFE.
 *
 *   2. Header logo contrast: wrap the header logo <img> in a white rounded
 *      "chip" so a colored/dark logo reads against the dark teal header. Only
 *      applied when logoIsLight === false (a light/white logo must stay
 *      un-chipped). The img is normalized to object-contain + auto width so
 *      wordmark logos are never cropped.
 *
 * Patches runs/<p>/<run>/landing/foundation.html and mirrors the result over
 * site/dist/index.html (generated mode only overwrites the root English page;
 * locale routes serve the native template). Deploy is a separate step.
 *
 * Idempotent: re-running detects the relocation snippet / logo-chip and skips.
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RUNS = resolve(dirname(fileURLToPath(import.meta.url)), "../../runs");

// All demos EXCEPT excelspine (already migrated by hand). doLogo=false for
// light-logo demos (centenoschultz) — a white chip would hide a white logo.
const TARGETS = [
  // excelspine: lang + logo already done by hand (guards skip); included so the
  // glyph carousel reaches it too.
  { p: "excelspine", run: "2026-06-15-001", doLogo: true },
  { p: "amymyersmd", run: "2026-06-15-001", doLogo: true },
  { p: "backincontrol", run: "2026-06-15-001", doLogo: true },
  { p: "caseymeans", run: "2026-06-15-001", doLogo: true },
  { p: "centenoschultz", run: "2026-06-15-001", doLogo: false },
  { p: "discsportsspine", run: "2026-06-15-001", doLogo: true },
  { p: "drchatterjee", run: "2026-06-15-001", doLogo: true },
  { p: "drhyman", run: "2026-06-15-001", doLogo: true },
  { p: "drvondawright", run: "2026-06-15-001", doLogo: true },
  { p: "drwilliamli", run: "2026-06-15-001", doLogo: true },
  { p: "mdspinecare", run: "2026-06-10-001", doLogo: true },
  { p: "nutritionfacts", run: "2026-06-15-001", doLogo: true },
  { p: "peterattiamd", run: "2026-06-15-001", doLogo: true },
  { p: "stoneclinic", run: "2026-06-14-001", doLogo: true },
  { p: "texasback", run: "2026-06-15-001", doLogo: true },
];

const LS_ANCHOR =
  "var r=document.querySelector('.ls-r'),b=r.querySelector('.ls-b'),d=r.querySelector('.ls-d');";
const RELOCATE =
  "\n/* relocate the globe into the header nav (before the Ask-the-AI CTA) so it never overlaps it */\n" +
  "try{var hnav=document.querySelector('header nav')||document.querySelector('header');" +
  "if(hnav){var ask=Array.prototype.find.call(hnav.querySelectorAll('a,button'),function(x){" +
  "return /ask\\s+the\\s+ai/i.test((x.textContent||'').trim());});" +
  "if(ask&&ask.parentNode===hnav){hnav.insertBefore(r,ask);}else{hnav.appendChild(r);}}}catch(e){}";

function migrateLangSwitcher(html) {
  if (!html.includes(".ls-r{position:fixed")) return { html, changed: false };
  let out = html.replace(
    ".ls-r{position:fixed;top:.95rem;right:1.4rem;z-index:999}",
    ".ls-r{position:relative;z-index:60;display:inline-flex;align-items:center}"
  );
  if (out.includes(LS_ANCHOR) && !out.includes("relocate the globe into the header nav")) {
    out = out.replace(LS_ANCHOR, LS_ANCHOR + RELOCATE);
  }
  return { html: out, changed: out !== html };
}

// chip=true (dark/colored logo): wrap in a white chip for contrast on the dark
// header. chip=false (light/white logo): just de-crop — drop rounded-full
// object-cover that crams a wordmark into a circle — keeping it white-on-dark.
function migrateLogo(html, chip) {
  if (html.includes("logo-chip") || html.includes("data-logo-fixed")) return { html, changed: false };
  const hStart = html.indexOf("<header");
  const hEnd = html.indexOf("</header>");
  if (hStart === -1 || hEnd === -1) return { html, changed: false };
  const header = html.slice(hStart, hEnd);
  const m = header.match(/<img\b[^>]*\blogo[^>]*>/i);
  if (!m) return { html, changed: false };
  const imgTag = m[0];
  const src = (imgTag.match(/\bsrc="([^"]*)"/i) || [])[1] || "/brand/logo.webp";
  const alt = (imgTag.match(/\balt="([^"]*)"/i) || [])[1] || "logo";
  const img =
    `<img data-logo-fixed src="${src}" alt="${alt}" style="height:34px;width:auto;` +
    `max-width:190px;object-fit:contain;display:block;flex-shrink:0;">`;
  const replacement = chip
    ? `<span class="logo-chip" style="display:inline-flex;align-items:center;` +
      `background:#ffffff;border-radius:12px;padding:5px 10px;flex-shrink:0;` +
      `box-shadow:0 1px 3px rgba(0,0,0,.18);">${img}</span>`
    : img;
  const newHeader = header.replace(imgTag, replacement);
  return { html: html.slice(0, hStart) + newHeader + html.slice(hStart + header.length), changed: true };
}

// globe→glyph carousel on hover (drfuhrman parity). Operates on the existing
// (pre-glyph) injected language-switcher block. Idempotent via the ls-gl class.
const GLYPH_JS =
  `<script>/*ls-glyph*/(function(){var b=document.querySelector('.ls-b');if(!b)return;` +
  `var gx=b.querySelector('.ls-gl');if(!gx)return;var GL=['あ','中','ع','文','ñ'],gi=0,gt=null;` +
  `b.addEventListener('mouseenter',function(){if(gt)return;gx.textContent=GL[gi%GL.length];` +
  `gt=setInterval(function(){gi++;gx.textContent=GL[gi%GL.length];},900);});` +
  `b.addEventListener('mouseleave',function(){if(gt){clearInterval(gt);gt=null;}gx.textContent='';});})();</script>`;

function migrateGlyph(html) {
  if (html.includes('class="ls-gl"')) return { html, changed: false };
  if (!html.includes(".ls-b svg{flex:none}")) return { html, changed: false };
  let out = html.replace(
    ".ls-b svg{flex:none}",
    ".ls-b{position:relative}.ls-b svg{flex:none;transition:opacity .25s}" +
      ".ls-gl{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;" +
      "font-size:1.15rem;font-weight:700;line-height:1;opacity:0;transition:opacity .25s;pointer-events:none}" +
      ".ls-b:hover svg{opacity:0}.ls-b:hover .ls-gl{opacity:1}"
  );
  out = out.replace(
    '</button><div class="ls-d" role="menu">',
    '<span class="ls-gl" aria-hidden="true"></span></button><div class="ls-d" role="menu">'
  );
  out = out.includes("</body>") ? out.replace("</body>", `${GLYPH_JS}\n</body>`) : out + GLYPH_JS;
  return { html: out, changed: out !== html };
}

let okp = 0;
for (const t of TARGETS) {
  const dir = join(RUNS, t.p, t.run, "landing");
  const fpath = join(dir, "foundation.html");
  if (!existsSync(fpath)) {
    console.log(`SKIP ${t.p}: no foundation.html`);
    continue;
  }
  let html = readFileSync(fpath, "utf8");
  const ls = migrateLangSwitcher(html);
  html = ls.html;
  // t.doLogo controls the white chip (dark logos); light logos still get
  // de-cropped (chip omitted) so a circular crop never truncates a wordmark.
  const lg = migrateLogo(html, t.doLogo);
  html = lg.html;
  const logoChanged = lg.changed;
  const gl = migrateGlyph(html);
  html = gl.html;
  const glyphChanged = gl.changed;
  writeFileSync(fpath, html);
  const distIdx = join(dir, "site", "dist", "index.html");
  let mirrored = false;
  if (existsSync(distIdx)) {
    writeFileSync(distIdx, html);
    mirrored = true;
  }
  okp++;
  console.log(
    `OK ${t.p.padEnd(16)} lang:${ls.changed ? "✓" : "—"} logo:${
      logoChanged ? (t.doLogo ? "chip" : "decrop") : "—"
    } glyph:${glyphChanged ? "✓" : "—"} dist:${mirrored ? "✓" : "MISSING"}`
  );
}
console.log(`\nPatched ${okp}/${TARGETS.length} demos. Mirrored to dist/index.html. Deploy next.`);
