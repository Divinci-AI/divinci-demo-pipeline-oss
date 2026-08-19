/**
 * translate-locales — generate src/i18n/ui/<code>.ts for every non-English
 * locale by translating the demo's en.ts via Gemini, acmenutrition-style. Preserves
 * structure, keys, inline tokens ({br}, {kbd}…{/kbd}, {0}), brand names, numbers
 * and URLs; translates only the English prose values.
 *
 * Usage:
 *   GKEY=... node translate-locales.mjs <site-dir> [onlyCode]
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const SITE = process.argv[2];
const ONLY = process.argv[3]; // optional single code for a proof run
const KEY = process.env.GKEY;
const MODEL = process.env.TR_MODEL || "gemini-2.5-flash";
if (!SITE || !KEY) { console.error("need <site-dir> and GKEY"); process.exit(1); }

const enPath = join(SITE, "src/i18n/ui/en.ts");
const enSrc = readFileSync(enPath, "utf8");
// Parse the en object so we can show Gemini the exact JSON shape AND validate
// translated shape. Strip the import + export + trailing type; eval the literal.
function parseEn(src) {
  let body = src.replace(/^[\s\S]*?export const en\s*=\s*/m, "return ");
  body = body.replace(/\}\s*;\s*\/\*\*[\s\S]*$/m, "};"); // drop trailing type/comment
  // eslint-disable-next-line no-new-func
  return Function(body)();
}
const enObj = parseEn(enSrc);
const enJson = JSON.stringify(enObj, null, 2);
function sameShape(a, b) { // keys-only structural check
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object" || a === null) return true;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length || ka.some(k => !(k in b))) return false;
  return ka.every(k => sameShape(a[k], b[k]));
}

// code -> [LanguageName, exportIdentifier]
const LOCALES = {
  es:["Spanish","es"], fr:["French","fr"], de:["German","de"], it:["Italian","it"],
  pt:["Portuguese","pt"], nl:["Dutch","nl"], pl:["Polish","pl"], ru:["Russian","ru"],
  uk:["Ukrainian","uk"], cs:["Czech","cs"], ro:["Romanian","ro"], el:["Greek","el"],
  tr:["Turkish","tr"], ar:["Arabic","ar"], he:["Hebrew","he"], hi:["Hindi","hi"],
  bn:["Bengali","bn"], ta:["Tamil","ta"], te:["Telugu","te"], mr:["Marathi","mr"],
  gu:["Gujarati","gu"], pa:["Punjabi","pa"], ur:["Urdu","ur"], fa:["Persian","fa"],
  th:["Thai","th"], vi:["Vietnamese","vi"], id:["Indonesian","id"], ms:["Malay","ms"],
  fil:["Filipino","fil"], ja:["Japanese","ja"], ko:["Korean","ko"],
  "zh-hans":["Simplified Chinese","zhHans"], "zh-hant":["Traditional Chinese","zhHant"],
  sw:["Swahili","sw"], zu:["Zulu","zu"],
};

function prompt(lang) {
  return `You are a professional localizer. Translate the STRING VALUES of this JSON object into ${lang}.

OUTPUT RULES — follow exactly:
- Output ONLY a single valid JSON object, no markdown fences, no commentary.
- Keep EVERY key and the nesting identical to the source (same shape).
- Preserve inline placeholder tokens EXACTLY: {br}, {kbd}…{/kbd}, and any {0}/{1}/{name} tokens.
- Do NOT translate: brand/product names (Excel Spine Center, Dr. Choll Kim, Divinci, Gemini), numbers, units, URLs.
- Translate ALL human-facing prose values into natural, fluent ${lang}.

SOURCE JSON:
${enJson}`;
}

async function translate(code) {
  const [lang, ident] = LOCALES[code];
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`;
  const body = { contents: [{ parts: [{ text: prompt(lang) }] }],
                 generationConfig: { temperature: 0.3, maxOutputTokens: 32768, responseMimeType: "application/json" } };
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) { if (r.status === 429) { await sleep(4000 * (attempt + 1)); continue; } throw new Error("HTTP " + r.status); }
      const j = await r.json();
      let txt = j?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
      txt = txt.replace(/^```(json)?\s*/i, "").replace(/```\s*$/i, "").trim();
      const obj = JSON.parse(txt); // throws on malformed → retry
      if (!sameShape(obj, enObj)) throw new Error("shape mismatch (keys differ from en)");
      // Emit a guaranteed-valid TS module from the parsed object.
      const ts = `import type { UIStrings } from "./en";\n\n` +
                 `// ${lang} (${code}) — machine-translated; brand names/numbers kept verbatim.\n` +
                 `export const ${ident}: UIStrings = ${JSON.stringify(obj, null, 2)};\n`;
      writeFileSync(join(SITE, `src/i18n/ui/${code}.ts`), ts);
      return { code, ok: true };
    } catch (e) { if (attempt === 3) return { code, ok: false, err: e.message }; await sleep(1500); }
  }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const codes = ONLY ? ONLY.split(",").map(s => s.trim()).filter(Boolean) : Object.keys(LOCALES);
const CONC = 5;
const results = [];
for (let i = 0; i < codes.length; i += CONC) {
  const batch = codes.slice(i, i + CONC);
  const r = await Promise.all(batch.map(translate));
  results.push(...r);
  r.forEach(x => console.log(`${x.ok ? "✓" : "✗"} ${x.code}${x.ok ? "" : "  " + x.err}`));
}
const okCodes = results.filter(r => r.ok).map(r => r.code);
console.log(`\nTranslated ${okCodes.length}/${codes.length}.`);
// emit the registry snippet to wire into i18n/index.ts
const imports = okCodes.map(c => `import { ${LOCALES[c][1]} } from "./ui/${c}";`).join("\n");
const dictEntries = okCodes.map(c => `  "${c}": ${LOCALES[c][1]},`).join("\n");

// Auto-register into i18n/index.ts (idempotent — only adds codes not present).
const idxPath = join(SITE, "src/i18n/index.ts");
let idx = readFileSync(idxPath, "utf8");
const newImports = okCodes.filter(c => !idx.includes(`from "./ui/${c}"`));
if (newImports.length) {
  const imp = newImports.map(c => `import { ${LOCALES[c][1]} } from "./ui/${c}";`).join("\n");
  const ent = newImports.map(c => `  "${c}": ${LOCALES[c][1]},`).join("\n");
  idx = idx.replace(`import { en, type UIStrings } from "./ui/en";`,
                    `import { en, type UIStrings } from "./ui/en";\n${imp}`);
  idx = idx.replace(/const DICTS: Record<string, UIStrings> = \{\n  en,\n/,
                    `const DICTS: Record<string, UIStrings> = {\n  en,\n${ent}\n`);
  writeFileSync(idxPath, idx);
  console.log(`Registered ${newImports.length} new locale(s) in index.ts.`);
} else {
  console.log("All ok locales already registered.");
}
