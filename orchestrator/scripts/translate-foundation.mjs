/**
 * translate-foundation — translate a bespoke foundation.html into a locale,
 * HTML-safely. Parses the file into tokens, collects ONLY visible text nodes
 * and visible attribute values (alt/placeholder/aria-label/title), translates
 * the unique strings via Gemini (forced JSON), and substitutes them back by
 * exact character range (reverse order) — never touching <script>/<style>
 * contents, tags, classes, styles, URLs, or any other markup.
 *
 * Usage: GKEY=... node translate-foundation.mjs <foundation.html> <langName> <out.html>
 */
import { readFileSync, writeFileSync } from "node:fs";

const [src, langName, out] = process.argv.slice(2);
const KEY = process.env.GKEY;
const MODEL = process.env.TR_MODEL || "gemini-2.5-flash";
if (!src || !langName || !out || (!KEY && !process.env.MAP && !process.env.DUMP)) { console.error("need <foundation.html> <langName> <out.html> + GKEY (or MAP=<json>)"); process.exit(1); }

const DUMP = process.env.DUMP === "1" ? true : (process.env.DUMP === "json" ? "json" : false);
const html = readFileSync(src, "utf8");

// decode the handful of entities that legitimately appear in source copy, so
// Gemini sees clean text and the output re-encoder doesn't double-escape.
const decodeEntities = (s) => s
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
  .replace(/&nbsp;/g, " ");
const ATTRS = ["alt", "placeholder", "aria-label", "title"];
const nodes = []; // {start, end, text, type}

// ── tokenize: collect translatable text nodes + visible attribute values ──
let i = 0;
const n = html.length;
while (i < n) {
  if (html[i] === "<") {
    if (html.startsWith("<!--", i)) { const e = html.indexOf("-->", i); i = e < 0 ? n : e + 3; continue; }
    const tagEnd = html.indexOf(">", i);
    if (tagEnd < 0) break;
    const tag = html.slice(i, tagEnd + 1);
    const nameM = tag.match(/^<\/?([a-zA-Z0-9]+)/);
    const tagName = nameM ? nameM[1].toLowerCase() : "";
    // visible attribute values within this tag
    for (const a of ATTRS) {
      const re = new RegExp(`\\b${a}="([^"]*)"`, "g");
      let m;
      while ((m = re.exec(tag))) {
        const v = m[1];
        if (v.trim()) {
          const vStart = i + m.index + m[0].indexOf('"') + 1;
          nodes.push({ start: vStart, end: vStart + v.length, text: v, type: "attr" });
        }
      }
    }
    // skip the body of script/style entirely
    if ((tagName === "script" || tagName === "style") && !tag.startsWith("</") && !tag.endsWith("/>")) {
      const ce = html.indexOf(`</${tagName}>`, tagEnd + 1);
      i = ce < 0 ? n : ce;
      continue;
    }
    i = tagEnd + 1;
  } else {
    const lt = html.indexOf("<", i);
    const end = lt < 0 ? n : lt;
    const text = html.slice(i, end);
    if (text.trim()) nodes.push({ start: i, end, text, type: "text" });
    i = end;
  }
}

// ── unique translatable strings (skip code-ish / number-only / tiny) ──
const translatable = (s) => {
  const t = s.trim();
  if (t.length < 2) return false;
  if (!/[a-zA-Z]/.test(t)) return false;          // must contain letters
  if (/^[{}<>/\\|=;:_\-.\s\d]+$/.test(t)) return false;
  if (/^https?:|^\/|@.*\./.test(t)) return false;  // urls/emails
  return true;
};
const uniq = [...new Set(nodes.map((x) => decodeEntities(x.text.trim())).filter(translatable))];

if (DUMP) {
  if (DUMP === "json") { console.log(JSON.stringify(uniq, null, 0)); process.exit(0); }
  console.log(`# ${uniq.length} translatable strings (text nodes + visible attrs); scripts/styles/markup excluded\n`);
  uniq.forEach((s, idx) => console.log(`${String(idx + 1).padStart(3)}. ${JSON.stringify(s)}`));
  process.exit(0);
}

// ── translate via Gemini (JSON map), in chunks ──
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function translateChunk(strings) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`;
  const prompt = `Translate each English UI string in this JSON array into ${langName}. Return ONLY a JSON object mapping each EXACT original string to its ${langName} translation. Do NOT translate proper nouns: brand/product/company names, the names of people and doctors, "Divinci", "Gemini", and the standalone term "AI" — keep all of those verbatim in the translation. Also keep numbers, units, URLs, and email addresses verbatim. Preserve any inline tokens like {br} exactly. Use natural, fluent ${langName}; for medical/health copy use clear patient-facing language.\n\nSTRINGS:\n${JSON.stringify(strings)}`;
  const body = { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 32768, responseMimeType: "application/json" } };
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) { if (r.status === 429) { await sleep(4000 * (a + 1)); continue; } throw new Error("HTTP " + r.status); }
      const j = await r.json();
      let txt = j?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
      txt = txt.replace(/^```(json)?\s*/i, "").replace(/```\s*$/i, "").trim();
      return JSON.parse(txt);
    } catch (e) { if (a === 3) throw e; await sleep(1500); }
  }
}
// chunk to keep each request well within token limits — unless a pre-built
// translation map is supplied via MAP=<path.json> (skips Gemini entirely, for
// reproducible / offline / hand-vetted translations).
const map = {};
if (process.env.MAP) {
  Object.assign(map, JSON.parse(readFileSync(process.env.MAP, "utf8")));
  const missing = uniq.filter((s) => !(s in map));
  if (missing.length) console.warn(`[${langName}] MAP missing ${missing.length}/${uniq.length} strings — left in English:`, JSON.stringify(missing.slice(0, 5)));
} else {
  const CHUNK = 60;
  for (let k = 0; k < uniq.length; k += CHUNK) {
    const part = uniq.slice(k, k + CHUNK);
    const res = await translateChunk(part);
    Object.assign(map, res || {});
  }
}

// ── substitute back, by range, reverse order (preserve offsets) ──
const escText = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
let result = html;
let translated = 0;
for (const node of nodes.sort((a, b) => b.start - a.start)) {
  const key = decodeEntities(node.text.trim());
  const tr = map[key];
  if (!tr || tr === key) continue;
  // preserve original leading/trailing whitespace around the trimmed text
  const lead = node.text.match(/^\s*/)[0];
  const trail = node.text.match(/\s*$/)[0];
  const replacement = lead + (node.type === "attr" ? escAttr(tr) : escText(tr)) + trail;
  result = result.slice(0, node.start) + replacement + result.slice(node.end);
  translated++;
}
writeFileSync(out, result);
console.log(`[${langName}] strings=${uniq.length} translated=${translated} | scripts/markup preserved`);
