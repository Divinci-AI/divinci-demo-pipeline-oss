/**
 * Landing-stage helpers — build + deploy a per-customer branded landing page
 * from the open-source template (Divinci-AI/divinci-landing-template), wrapping
 * the prospect's published Divinci release.
 *
 * Pipeline shape (design SDK-LANDING-TEMPLATE.md, Steps 2–3):
 *   release → [draft brand.config from research] → [Landing] review board gate
 *           → build + deploy worker → record URL → outreach (demo link = worker)
 *
 * The template is cloned once into runs/<prospect>/<run>/landing/site/ (an
 * isolated working copy, never mutating the shared template), then per-run
 * brand.config.ts is written before the build; the host's own config and the
 * deploy itself live behind LandingHost (see landing-host.ts).
 *
 * Brand extraction note: a full Playwright palette/logo/copy extractor from the
 * prospect's site is the planned upgrade (it would author brand.config.ts
 * automatically). v1 drafts a config from the manifest + research and routes it
 * through the [Landing] gate for human refinement before the (paid) build/deploy.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { explainEnTsMismatch } from "./copy-gen.js";
import { personSurnames } from "./headshot-finder.js";
import { isSystemFont } from "./brand-extract.js";
import { lazyEnv } from "./require-env.js";
import { resolveLandingHost, type LandingHost } from "./landing-host.js";
import { PLACEHOLDER_TEXT } from "./demo-preflight.js";

const execFileP = promisify(execFile);

/**
 * Translate the demo's per-customer en.ts into every advertised locale so the
 * Astro build emits in-language /<code>/ pages (acmenutrition model). Best-effort
 * and key-gated: with no Gemini key the locales simply fall back to English
 * (the prior behaviour), so demo generation never breaks on translation.
 */
async function translateLocales(siteDir: string): Promise<void> {
  const key = process.env.GEMINI_API_KEY || process.env.GKEY || process.env.GOOGLE_API_KEY;
  if (!key) {
    console.warn("[landing] no GEMINI_API_KEY — skipping locale translation (locales fall back to English)");
    return;
  }
  const script = fileURLToPath(new URL("../scripts/translate-locales.mjs", import.meta.url));
  try {
    await execFileP("node", [script, siteDir], {
      env: { ...process.env, GKEY: key },
      timeout: 15 * 60 * 1000,
      maxBuffer: 64 * 1024 * 1024,
    });
    console.log("[landing] translated locale UI strings (in-language /<code>/ pages)");
  } catch (e) {
    console.warn("[landing] locale translation failed — continuing with English fallback:", (e as Error).message?.slice(0, 200));
  }
}

/** Register every non-en src/i18n/ui/<code>.ts into i18n/index.ts (idempotent). */
function registerLocales(siteDir: string): void {
  const uiDir = join(siteDir, "src", "i18n", "ui");
  const idxPath = join(siteDir, "src", "i18n", "index.ts");
  if (!existsSync(idxPath)) return;
  let idx = readFileSync(idxPath, "utf8");
  const imports: string[] = [], entries: string[] = [];
  for (const f of readdirSync(uiDir).filter((f) => f.endsWith(".ts") && f !== "en.ts")) {
    const code = f.replace(/\.ts$/, "");
    if (idx.includes(`from "./ui/${code}"`)) continue;
    const m = readFileSync(join(uiDir, f), "utf8").match(/export const (\w+)\s*:/);
    if (!m) continue;
    imports.push(`import { ${m[1]} } from "./ui/${code}";`);
    entries.push(`  "${code}": ${m[1]},`);
  }
  if (!imports.length) return;
  idx = idx.replace(`import { en, type UIStrings } from "./ui/en";`,
    `import { en, type UIStrings } from "./ui/en";\n${imports.join("\n")}`);
  idx = idx.replace(/const DICTS: Record<string, UIStrings> = \{\n  en,\n/,
    `const DICTS: Record<string, UIStrings> = {\n  en,\n${entries.join("\n")}\n`);
  writeFileSync(idxPath, idx);
  console.log(`[landing] registered ${imports.length} locale dictionary file(s)`);
}

/**
 * Make locale pages in-language. Prefer the run's COMMITTED translations
 * (landing/locales/<code>.ts) for a reproducible, free, deterministic build;
 * only translate via Gemini when none are committed, then archive the result
 * back into landing/locales for next time.
 */
async function applyLocales(landingDir: string, siteDir: string): Promise<void> {
  const committed = join(landingDir, "locales");
  const uiDir = join(siteDir, "src", "i18n", "ui");
  const stamp = join(committed, ".translated-from.sha256");
  const enPath = join(uiDir, "en.ts");
  const enHash = existsSync(enPath)
    ? createHash("sha256").update(readFileSync(enPath)).digest("hex")
    : "";

  if (existsSync(committed)) {
    const files = readdirSync(committed).filter((f) => f.endsWith(".ts") && f !== "en.ts");
    // A CACHE WITH NO INVALIDATION IS A STALE CACHE.
    //
    // This restored the committed translations whenever any existed, without
    // ever asking what they were translated FROM. So regenerating en.ts — the
    // whole point of feeding the team into copy generation — left the locale
    // files describing the PREVIOUS copy. Acme Incubator ended with 8 English roles
    // and a French dictionary holding 2, and six cards on every non-English
    // page had no role at all.
    //
    // The stamp records the en.ts the translations were made from. No stamp
    // means they predate this check and cannot be shown to match, so they are
    // treated as stale: re-translating costs one Gemini call per locale,
    // shipping a half-translated page costs a customer's first impression.
    const stampedHash = existsSync(stamp) ? readFileSync(stamp, "utf8").trim() : "";
    const fresh = stampedHash !== "" && stampedHash === enHash;
    if (files.length && fresh) {
      for (const f of files) copyFileSync(join(committed, f), join(uiDir, f));
      registerLocales(siteDir);
      console.log(`[landing] restored ${files.length} committed locale translation(s) — reproducible build`);
      return;
    }
    if (files.length) {
      console.log(
        `[landing] committed translations are STALE (${stampedHash ? "en.ts changed since they were made" : "no source stamp"}) — re-translating`,
      );
    }
  }

  await translateLocales(siteDir);
  try {
    mkdirSync(committed, { recursive: true });
    for (const f of readdirSync(uiDir).filter((f) => f.endsWith(".ts") && f !== "en.ts")) {
      copyFileSync(join(uiDir, f), join(committed, f));
    }
    // Stamped with the en.ts these were translated FROM, so the next build can
    // tell a reusable cache from a stale one.
    if (enHash) writeFileSync(stamp, enHash + "\n");
    console.log(`[landing] archived fresh translations → ${committed} (commit for reproducibility)`);
  } catch { /* best-effort archive */ }
}

/** code → English language name, mirroring the template's i18n/locales.ts.
 *  Used to tell Gemini which language to translate the bespoke shell into. */
const LOCALE_NAMES: Record<string, string> = Object.fromEntries([
  ["es", "Spanish"], ["fr", "French"], ["de", "German"], ["it", "Italian"],
  ["pt", "Portuguese"], ["nl", "Dutch"], ["pl", "Polish"], ["ru", "Russian"],
  ["uk", "Ukrainian"], ["cs", "Czech"], ["ro", "Romanian"], ["el", "Greek"],
  ["tr", "Turkish"], ["ar", "Arabic"], ["he", "Hebrew"], ["hi", "Hindi"],
  ["bn", "Bengali"], ["ta", "Tamil"], ["te", "Telugu"], ["mr", "Marathi"],
  ["gu", "Gujarati"], ["pa", "Punjabi"], ["ur", "Urdu"], ["fa", "Persian"],
  ["th", "Thai"], ["vi", "Vietnamese"], ["id", "Indonesian"], ["ms", "Malay"],
  ["fil", "Filipino"], ["ja", "Japanese"], ["ko", "Korean"],
  ["zh-hans", "Chinese (Simplified)"], ["zh-hant", "Chinese (Traditional)"],
  ["sw", "Swahili"], ["zu", "Zulu"],
]);
const RTL_LOCALES = new Set(["ar", "he", "ur", "fa"]);

/**
 * Make the per-locale pages use the BESPOKE shell (translated) instead of the
 * plain Astro template — so switching language keeps the rich design, just in
 * another language. For each locale we:
 *   1. obtain a translated foundation (committed landing/locale-foundations/
 *      <code>.html for reproducibility, else translate the English foundation
 *      via Gemini and archive it),
 *   2. point its chat iframe at /<code>/embed/ (in-language chat), set
 *      <html lang>/dir, and splice it over dist/<code>/index.html.
 * Best-effort + key-gated: with no committed file and no Gemini key, the
 * locale keeps the plain template page (prior behaviour) — never breaks a build.
 */
async function spliceBespokeLocales(landingDir: string, siteDir: string, englishFoundation: string): Promise<void> {
  const distDir = join(siteDir, "dist");
  const committed = join(landingDir, "locale-foundations");
  const key = process.env.GEMINI_API_KEY || process.env.GKEY || process.env.GOOGLE_API_KEY;
  // candidate locales = built dist/<code>/ dirs that have an index.html, minus non-locale dirs
  const skip = new Set(["_astro", "embed", "brand", "vendor"]);
  const codes = readdirSync(distDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !skip.has(d.name) && LOCALE_NAMES[d.name]
      && existsSync(join(distDir, d.name, "index.html")))
    .map((d) => d.name);

  const script = fileURLToPath(new URL("../scripts/translate-foundation.mjs", import.meta.url));
  mkdirSync(committed, { recursive: true });
  // English foundation on disk so the translator (CLI, file-based) can read it.
  const enTmp = join(committed, "_en.source.html");
  writeFileSync(enTmp, englishFoundation);

  let spliced = 0, fellBack = 0;
  for (const code of codes) {
    const out = join(committed, `${code}.html`);
    if (!existsSync(out)) {
      if (!key) { fellBack++; continue; } // no committed translation, no key → keep template page
      try {
        await execFileP("node", [script, enTmp, LOCALE_NAMES[code], out], {
          env: { ...process.env, GKEY: key }, timeout: 5 * 60 * 1000, maxBuffer: 64 * 1024 * 1024,
        });
      } catch (e) {
        console.warn(`[landing] bespoke-locale translate failed for ${code}:`, (e as Error).message?.slice(0, 160));
        fellBack++; continue;
      }
    }
    // per-locale rewrites: in-language embed + html lang/dir
    let shell = readFileSync(out, "utf8");
    shell = shell.replace(/(<iframe[^>]*\bid="df-hero-embed"[^>]*\bsrc=")\/embed\/(")/, `$1/${code}/embed/$2`);
    const dirAttr = RTL_LOCALES.has(code) ? ` dir="rtl"` : "";
    shell = shell.replace(/<html\b[^>]*>/i, `<html lang="${code}"${dirAttr}>`);
    writeFileSync(join(distDir, code, "index.html"), shell);
    spliced++;
  }
  try { rmSync(enTmp); } catch { /* best-effort */ }
  console.log(`[landing] bespoke locale shells: ${spliced} spliced${fellBack ? `, ${fellBack} kept template page (no committed translation / no key)` : ""}`);
}

const TEMPLATE_REPO = "https://github.com/Divinci-AI/divinci-landing-template";
// Both moved to landing-host.ts along with everything else that knows about
// Cloudflare. Re-exported because callers outside this module import it.
export { WORKERS_SUBDOMAIN } from "./landing-host.js";

export interface LandingBrandDraft {
  /**
   * Whether a real PERSON was identified for the team section.
   *
   * Undefined or true renders it. False hides it outright — see the note on
   * `sections` below: with no person the card names the organisation under a
   * personal role, which is wrong rather than merely unpolished.
   */
  showBios?: boolean;
  siteName: string;
  /**
   * Short name for the `[name] AI` lockup in the header and hero, when the
   * legal name is too long to sit on one line beside the "AI" glyphs.
   * "Acme Renew Integrative Medicine AI" wrapped to two lines and left "AI"
   * stranded at the upper right. Defaults to siteName — a shortening rule
   * good enough to apply automatically does not exist ("Integrative Medicine"
   * is droppable, "Group"/"Associates"/"Clinic" often are not), so this is set
   * per demo rather than guessed.
   */
  lockupName?: string;
  domain: string;
  productName: string;
  legalName: string;
  palette: Record<string, string>;
  mainSite: string;
  signupUrl: string;
  loginUrl: string;
  releaseId: string;
  apiBase: string;
  whitelabelId: string;
  bios: Array<{ name: string; title: string; blurbKey: string; image?: string }>;
  corpusFraming: string;
  corpusStats: Array<{ value: string; label: string }>;
  fallbackWelcome: string;
  starters: string[];
  ogTagline: string;
  ogSubtitle: string;
  referralSource: string;
  workerName: string;
  /** Extracted brand asset filename in public/brand/ (e.g. "logo.png"); the
   *  template default /brand/logo.svg is used when absent. */
  logoFile?: string;
  /** Extracted CSS font-family stack; the template default is used when absent. */
  fontFamily?: string;
  /** The brand's display/heading stack, when distinct from the body font. */
  displayFontFamily?: string;
  /** The rest of the wordmark's treatment — a wordmark is a specific CUT. */
  displayFontStyle?: string;
  displayFontWeight?: string;
  displayLetterSpacing?: string;
  displayFontVariationSettings?: string;
  /** Logo is light/white (built for a dark header) → hero darkens it. */
  logoIsLight?: boolean;
  /** Per-prospect optical nudge for the AI mark, px. See alignAiMark. */
  aiMarkNudgePx?: { base: number; md: number };
  /** Same, for the HEADER lockup — a different logo size, so a different
   *  offset. Acme Security: hero 10.5px at a 56px logo, header 6px at 24px. */
  headerAiMarkNudgePx?: { base: number; md: number };
  /** True when the logo is a square MARK, so the hero must render the name. */
  logoIsMark?: boolean;
  /**
   * How far the logo image must drop so its LETTERFORMS land on the "AI"
   * baseline, as a fraction of the rendered logo height. Measured from the
   * file by logo-baseline.ts; absent means the logo needed no correction.
   */
  logoBaselineDrop?: number;
  /** Webfont stylesheet URLs to load so the real client font renders. */
  fontLinks?: string[];
  /** True when the client's site offers a real login (gates the "Log in" CTA). */
  hasLogin?: boolean;
  /** Generated-mode feature videos (Imagen→Veo→R2): mobile-app/multimodal + offline. */
  mobileAppVideo?: { videoUrl: string; posterUrl: string };
  offlineVideo?: { videoUrl: string; posterUrl: string };
  /** Generated hero still (Imagen) — absolute R2 URL. Falls back to
   *  /brand/hero.webp (served from the worker) when absent. */
  heroImageUrl?: string;
  /** Generated corpus loop (Veo → WebM) — absolute R2 URL. Falls back to
   *  /brand/corpus.webm when absent. */
  corpusVideoUrl?: string;
  /**
   * Adversarial QA evidence for this demo, present ONLY when the run has a real
   * score at or above the publish threshold. See qaEvidenceForLanding().
   *
   * The Astro template does not render a dedicated QA section yet (that needs a
   * PR to Divinci-AI/divinci-landing-template); until then the figures surface
   * through corpusStats, which the template already renders.
   */
  qa?: {
    /** e.g. "94%" — already formatted, so the template never re-rounds it. */
    scorePct: string;
    passed: number;
    total: number;
    /** Plain-language description of what the suite tried to make it do wrong. */
    hazard: string;
  };
}

/** Build the brand object literal (JSON) from a draft. */
export function brandObjectLiteral(d: LandingBrandDraft): string {
  const obj = {
    identity: { siteName: d.siteName, lockupName: d.lockupName ?? d.siteName, domain: d.domain, productName: d.productName, legalName: d.legalName },
    palette: d.palette,
    // `display` is omitted, not defaulted to `family`: the template reads it as
    // `display ?? family`, so writing the body font here would be a no-op that
    // hides whether a distinct heading face was ever found.
    fonts: {
      family: d.fontFamily || "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
      ...(d.displayFontFamily ? { display: d.displayFontFamily } : {}),
      ...(d.displayFontStyle ? { displayStyle: d.displayFontStyle } : {}),
      ...(d.displayFontWeight ? { displayWeight: d.displayFontWeight } : {}),
      ...(d.displayLetterSpacing ? { displayLetterSpacing: d.displayLetterSpacing } : {}),
      ...(d.displayFontVariationSettings ? { displayVariationSettings: d.displayFontVariationSettings } : {}),
      headingWeight: 700,
      bodyWeight: 400,
      links: pruneDeadFontLinks(d.fontLinks ?? []),
    },
    links: { mainSite: d.mainSite, signupUrl: d.signupUrl, loginUrl: d.loginUrl, bioCreditUrl: d.mainSite, hasLogin: d.hasLogin ?? false },
    divinci: { releaseId: d.releaseId, apiBase: d.apiBase, whitelabelId: d.whitelabelId },
    bios: d.bios,
    corpus: { framing: d.corpusFraming, stats: d.corpusStats },
    chat: { fallbackWelcome: d.fallbackWelcome, starters: d.starters },
    // heroImage / corpusVideo are OMITTED when we have no asset, rather than
    // defaulting to a /brand/ path. The template has never shipped hero.webp or
    // corpus.webm, so those defaults rendered a broken image and an empty video
    // well on every demo generated without art — and the Worker's SPA fallback
    // serves a missing asset as 200 + HTML, so it never 404'd and nothing
    // noticed until preflight measured what the browser actually painted.
    // (logo.svg / favicon.svg ARE shipped, so those defaults stay.)
    media: { logo: d.logoFile ? `/brand/${d.logoFile}` : "/brand/logo.svg", favicon: "/brand/favicon.svg", ...(d.heroImageUrl ? { heroImage: d.heroImageUrl } : {}), ...(d.corpusVideoUrl ? { corpusVideo: d.corpusVideoUrl } : {}), logoIsLight: d.logoIsLight ?? false, logoIsMark: d.logoIsMark ?? false, logoIsTextWordmark: !d.logoFile, ...(typeof d.logoBaselineDrop === "number" ? { logoBaselineDrop: d.logoBaselineDrop } : {}), ogTagline: d.ogTagline, ogSubtitle: d.ogSubtitle },
    referral: { source: d.referralSource },
    /**
     * ⚠️ `demoHost` DERIVES from the domain rather than being computed beside
     * it. These were two independent constructions of the same host, which is
     * how a page came to advertise one host in its canonical/og:url and
     * another in its footer with nothing to notice.
     *
     * The stricter form matters here because this repo has more than one
     * landing host: `identity.domain` is reconciled against the RESOLVED
     * host's `urlFor()` in `buildAndDeployLanding`, so a Vercel deploy gets
     * `slug.vercel.app` in both fields. Recomputing from the Cloudflare
     * subdomain here would reintroduce a workers.dev host on a page that is
     * not on Cloudflare at all.
     */
    deploy: { workerName: d.workerName, demoHost: new URL(d.domain).host },
    // Hide aspirational sections in demos — we don't generate native-app /
    // offline media, so they'd render as empty wells. (Template default shows
    // them; demos opt out.)
    // `showBios` is false when no real PERSON could be identified. The bio card
    // then falls back to the organisation's own name under a personal role, and
    // a deployed demo read "The Acme Finance Group — Founder". That is not a
    // polish issue: it is a false statement on a page we send to that company.
    // An absent section is honest; a wrong one is not.
    sections: { examples: false, comingSoon: false, bios: d.showBios !== false },
  };
  return JSON.stringify(obj, null, 2);
}

/**
 * Splice the customer brand object into the template's existing brand.config.ts,
 * preserving its `BrandConfig` interface + FREE_MESSAGE_QUOTA. Replaces only the
 * `export const brand: BrandConfig = { … };` literal — robust against template
 * changes, and the generated config stays fully typed.
 */
export function applyBrandConfig(originalSource: string, d: LandingBrandDraft): string {
  const re = /export const brand: BrandConfig = \{[\s\S]*?\n\};/;
  if (!re.test(originalSource)) {
    throw new Error("applyBrandConfig: could not find `export const brand: BrandConfig = {…};` in template brand.config.ts");
  }
  return originalSource.replace(re, `export const brand: BrandConfig = ${brandObjectLiteral(d)};`);
}

/** Ensure an isolated working copy of the template exists for this run. */
/**
 * Dependencies declared in the clone's package.json that are not present in its
 * node_modules. Both `dependencies` and `devDependencies`, because the build
 * runs from the repo's own devDependencies (tsx, astro).
 */
export function missingDependencies(siteDir: string): string[] {
  const pkgPath = join(siteDir, "package.json");
  if (!existsSync(pkgPath)) return [];
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    return [];
  }
  const declared = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
  return declared.filter((name) => !existsSync(join(siteDir, "node_modules", ...name.split("/"))));
}

/**
 * Environment for the template's `npm install`.
 *
 * npm 12 REFUSES a project-scoped install outright when `allow-scripts` is set
 * in the USER-level ~/.npmrc:
 *
 *   npm error code EALLOWSCRIPTS
 *   npm error --allow-scripts is not allowed in project-scoped installs.
 *
 * The template already declares `"allowScripts": []` in its own package.json,
 * which is the form npm asks for — but that does not silence the error, because
 * npm objects to the user-level CONFIG EXISTING, not to the absence of a
 * package.json field. So a setting on the developer's machine, for unrelated
 * packages, hard-fails every landing deploy the pipeline attempts.
 *
 * Clearing it for this one child process restores the template's own policy
 * (`allowScripts: []` → no install scripts run) and leaves the user's ~/.npmrc
 * untouched for everything else on the machine.
 *
 * Found 2026-08-08: this had silently blocked EVERY run at the landing step for
 * ~26h. The loop reported only `failed (exit 1)`, and the failing runs still
 * counted against the mid-pipeline cap, so intake stopped too — one machine-local
 * npm config stalled the entire pipeline.
 */
export function npmInstallEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, npm_config_allow_scripts: "" };
}

/**
 * Fields a re-extraction may add to an EXISTING brand draft.
 *
 * Backfill, not overwrite. A draft that already carries a value keeps it —
 * several are hand-tuned (AcmePath's wordmark is Fraunces italic 500 at
 * `opsz 24`, set by hand), and silently replacing a human's correction with a
 * fresh guess is a worse failure than missing the new field entirely.
 *
 * The listed keys are exactly those the extractor learned to produce AFTER the
 * existing drafts were written, which is why those demos cannot acquire them:
 * extraction only runs when `brand-draft.json` is absent, and for 43 demos it
 * never will be again.
 */
export const BACKFILLABLE_BRAND_FIELDS = [
  "displayFontFamily",
  "displayFontStyle",
  "displayFontWeight",
  "displayLetterSpacing",
  "displayFontVariationSettings",
  "logoIsMark",
] as const;

/**
 * Merge newly-extractable fields into an existing draft, leaving everything
 * else — including every hand-edit — untouched. Returns the names of the fields
 * actually added, so the caller can say what changed rather than claiming a
 * refresh that did nothing.
 */
export function backfillBrandDraft(
  draft: Record<string, unknown>,
  extracted: Record<string, unknown>,
): string[] {
  const added: string[] = [];
  for (const key of BACKFILLABLE_BRAND_FIELDS) {
    const current = draft[key];
    // `null` counts as absent: JSON has no `undefined`, so a field written as
    // absent round-trips as null and would otherwise look deliberately set.
    if (current !== undefined && current !== null) continue;
    const next = extracted[key];
    if (next === undefined || next === null) continue;
    draft[key] = next;
    added.push(key);
  }
  return added;
}

/**
 * Collapse a doubled AI suffix in an EXISTING draft's productName.
 *
 * `${org} AI` was applied unconditionally, so a brand whose og:site_name
 * already ended in AI became "AcmePath AI AI". The generator fix only applies
 * at draft CREATION, so every draft written before it keeps the doubled name —
 * and it renders in the shared card's input placeholder ("Ask the AcmePath AI
 * AI…"), the chat byline and the copy prompts.
 *
 * A REPAIR, not a backfill: this rewrites a value that already exists, which
 * `backfillBrandDraft` deliberately never does. Kept narrow for that reason —
 * it only collapses an exact trailing "AI AI", so it cannot touch a name that
 * is merely unusual.
 */
export function repairDoubledAiSuffix(draft: Record<string, unknown>): string | undefined {
  const name = draft.productName;
  if (typeof name !== "string") return undefined;
  const fixed = name.replace(/\s*\bAI\s+AI\s*$/i, " AI").trim();
  if (fixed === name.trim()) return undefined;
  draft.productName = fixed;
  return fixed;
}

/**
 * Drop a redundant brand name from an existing draft's og subtitle.
 *
 * The subtitle was `AI-powered answers from ${org}, in any language.` and sits
 * directly under a tagline that already reads `${org} — answered 24/7.`, below
 * a lockup that renders the wordmark. Three statements of the same name on one
 * card. The generator no longer emits it, but every existing draft still has it.
 *
 * A REPAIR like repairDoubledAiSuffix: narrow, matching only the exact phrasing
 * this pipeline generated, so a hand-written subtitle is never touched.
 */
export function repairRedundantOgSubtitle(draft: Record<string, unknown>): string | undefined {
  const sub = draft.ogSubtitle;
  const tagline = draft.ogTagline;
  if (typeof sub !== "string" || typeof tagline !== "string") return undefined;
  const m = sub.match(/^AI-powered answers from (.+), in any language\.$/);
  if (!m) return undefined;
  // Only when the tagline genuinely repeats it — otherwise the subtitle is the
  // only place the brand is named and removing it loses information.
  if (!tagline.includes(m[1])) return undefined;
  const fixed = "AI-powered answers, in any language.";
  if (sub === fixed) return undefined;
  draft.ogSubtitle = fixed;
  return fixed;
}

async function ensureSiteClone(landingDir: string): Promise<string> {
  const siteDir = join(landingDir, "site");
  if (!existsSync(siteDir)) {
    mkdirSync(landingDir, { recursive: true });
    await execFileP("git", ["clone", "--depth", "1", TEMPLATE_REPO, siteDir], { timeout: 5 * 60 * 1000 });
    await execFileP("npm", ["install"], { cwd: siteDir, timeout: 10 * 60 * 1000, maxBuffer: 64 * 1024 * 1024, env: npmInstallEnv() });
  } else {
    // Reuse the clone but pull the latest template (best-effort; local edits to
    // brand.config/en.ts/wrangler are re-applied below, so hard-reset to origin).
    try {
      await execFileP("git", ["fetch", "--depth", "1", "origin", "main"], { cwd: siteDir, timeout: 3 * 60 * 1000 });
      await execFileP("git", ["reset", "--hard", "origin/main"], { cwd: siteDir, timeout: 60 * 1000 });
    } catch {
      /* offline / detached — keep the existing checkout */
    }
    // The reset can bring in a template commit that adds a DEPENDENCY, and
    // node_modules is not tracked — so the clone happily builds a tree whose
    // package.json and node_modules disagree. Adding @resvg/resvg-js to the
    // og-card step surfaced it: every existing clone failed the build with
    // ERR_MODULE_NOT_FOUND. (It failed closed, so nothing was deployed.)
    //
    // Compare DECLARED against INSTALLED rather than diffing the lockfile
    // across the reset. A lockfile diff only catches the run that performs the
    // update, so a clone left drifted by an earlier failure stays broken
    // forever — which is exactly what happened on the first attempt at this
    // fix. What matters is the state now, not how it got here.
    if (missingDependencies(siteDir).length > 0) {
      console.log(
        `[landing] template dependencies missing (${missingDependencies(siteDir).join(", ")}) — installing`,
      );
      await execFileP("npm", ["install"], { cwd: siteDir, timeout: 10 * 60 * 1000, maxBuffer: 64 * 1024 * 1024, env: npmInstallEnv() });
    }
  }
  return siteDir;
}

/**
 * Drop the clone's node_modules once the worker is deployed.
 *
 * Every run gets its OWN clone under runs/<prospect>/<run>/landing/site, so every
 * run also gets its own full install — ~470MB, of which two copies of the 107MB
 * workerd binary. Nothing reads it after the deploy: the deployed artifact
 * is the worker, and what the run needs to stay reproducible is brand.config.ts,
 * en.ts, wrangler.toml and dist. Measured 2026-08-10: 52 clones held 24GB, or 98%
 * of runs/ — the run outputs themselves were 487MB.
 *
 * Safe because `ensureSiteClone` reinstalls whenever a declared dependency is not
 * present, and an absent node_modules reports EVERY dependency missing (pinned by
 * site-clone-deps.test.ts). So a retry into an already-pruned run dir reinstalls
 * rather than building against a half-empty tree. That existing declared-vs-
 * installed check is what makes this a cleanup and not a landmine — do not
 * replace it with a lockfile diff.
 *
 * Best-effort by design: a deploy that has already succeeded must never be
 * reported as failed because a directory removal did not work.
 */
export function pruneSiteDependencies(siteDir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.LANDING_KEEP_NODE_MODULES === "1") return false;
  const modules = join(siteDir, "node_modules");
  if (!existsSync(modules)) return false;
  try {
    rmSync(modules, { recursive: true, force: true });
    return true;
  } catch (e) {
    console.warn("[landing] could not prune node_modules — continuing:", (e as Error).message?.slice(0, 200));
    return false;
  }
}

/**
 * Inject a small bridge script into the cloned template's `/embed/` page so it
 * (1) auto-resizes to its content height — the host shell iframes it, and a
 * fixed iframe height produces an unwanted inner scrollbar — and (2) accepts
 * `divinci-ask` postMessages from the host shell's fixed Ask bar, routing them
 * to the chat island's existing `divinci:populateInput` event (prefill+focus).
 * Idempotent (skips if the marker is present). Tolerant: a missing embed.astro
 * or </body> is logged, not fatal.
 */
/**
 * Force `emailRequired` false in the chat island so the composer never gates on
 * an address. Targeted at the single derivation rather than ripping the email
 * UI out — the field stays available, it is just no longer a precondition.
 * Throws if the anchor is missing: a silent no-op here would ship the gate on a
 * page we promised was open.
 */
/**
 * Pad/trim the neutral en.ts `bios.bodies` array to `count` entries so a
 * generated en.ts with that many bios can pass shape validation. No-op when the
 * count already matches or the anchor is missing.
 */
/**
 * How many `bios.bodies` entries a generated en.ts actually has.
 *
 * ⚠️ THIS, not the brand's bio count, is what shape validation compares.
 *
 * syncBioBodyArity was given `draft.bios.length` on the assumption that the
 * copy generator emits one body per bio. When it does not, syncing the neutral
 * file to the BRAND's count guarantees the mismatch it exists to prevent.
 *
 * That is not hypothetical. syncBioBodyArity landed 2026-08-03; the June demos
 * were generated with 2 bodies against brands recording 1 bio. Their June
 * builds matched the template's own 2-body default and shipped correct copy.
 * Rebuilding them today synced the neutral file to 1, so validation failed and
 * every one of them silently reverted to the template's "Acme Expert"
 * placeholder — on three demos with no bespoke homepage, that WAS the page.
 *
 * Returns undefined when there is no draft or it cannot be read, so the caller
 * falls back to the brand's count rather than skipping the sync entirely.
 */
export function draftBioBodyCount(enDraftPath: string): number | undefined {
  return draftBioArrayCount(enDraftPath, "bodies");
}

/**
 * How many entries a generated en.ts has in `bios.<key>`.
 *
 * ⚠️ Shape validation compares EVERY parallel array under `bios`, not just
 * `bodies`. Syncing one of them and leaving the other is not a partial fix —
 * it produces exactly the rejection the sync exists to prevent, and the
 * rejection is quiet: the build logs one line and ships the template's
 * "Acme Expert" copy in the title, og: tags, chat welcome and CTA.
 *
 * That is what happened to the 2026-08-10 Gate 2 batch. `bios.bodies` synced
 * 2 → 1 correctly, `bios.roles` stayed at the template's 2 against a generated
 * 1, and the run was rejected with `en.bios.roles has 1 entries, template
 * expects 2` — after a successful deploy, so the placeholder page was live.
 *
 * Counts per-array rather than assuming roles and bodies agree: the generator
 * is a model, and "one role per bio" is a convention it usually follows, not a
 * guarantee. Assuming the arrays match is the same assumption that caused the
 * June regression one level down.
 */
export function draftBioArrayCount(enDraftPath: string, key: "roles" | "bodies"): number | undefined {
  if (!existsSync(enDraftPath)) return undefined;
  try {
    const m = readFileSync(enDraftPath, "utf8").match(new RegExp(`${key}:\\s*\\[([\\s\\S]*?)\\n\\s*\\],`));
    if (!m) return undefined;
    // Count string literals, not lines: a body may itself contain newlines.
    const n = (m[1].match(/(?<!\\)"(?:[^"\\]|\\.)*"/g) ?? []).length;
    return n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

const BIO_FILLER: Record<"roles" | "bodies", (i: number) => string> = {
  bodies: (i) => `Team member ${i + 1} bio placeholder.`,
  roles: (i) => `Team member ${i + 1}`,
};

export function syncBioBodyArity(siteDir: string, count: number, roleCount = count): void {
  syncBioArrayArity(siteDir, "bodies", count);
  syncBioArrayArity(siteDir, "roles", roleCount);
}

function syncBioArrayArity(siteDir: string, key: "roles" | "bodies", count: number): void {
  if (count <= 0) return;
  // Path must match `enTarget` above — an earlier guess of src/i18n/en.ts
  // silently no-op'd via the existsSync guard, so the arity never synced and
  // the placeholder bios shipped anyway.
  const f = join(siteDir, "src", "i18n", "ui", "en.ts");
  if (!existsSync(f)) return;
  const src = readFileSync(f, "utf8");
  const m = src.match(new RegExp(`(${key}:\\s*\\[)([\\s\\S]*?)(\\n\\s*\\],)`));
  if (!m) return;
  const items = m[2].match(/(?<!\\)"(?:[^"\\]|\\.)*"/g) ?? [];
  if (items.length === count) return;
  const filler = Array.from({ length: count }, (_, i) => `      ${JSON.stringify(BIO_FILLER[key](i))},`).join("\n");
  const out = src.replace(m[0], `${m[1]}\n${filler}${m[3]}`);
  writeFileSync(f, out);
  console.log(`[landing] neutral en.ts bios.${key} arity ${items.length} → ${count} (shape-validation parity)`);
}

/**
 * Blank any bio body the copy step left as the template's placeholder.
 *
 * `validateEnTs` checks the generated copy's SHAPE — same keys, same array
 * lengths — which a model satisfies perfectly by echoing the neutral text back.
 * So "Replace this with the founder's bio — background, coverage focus, and the
 * published research the assistant answers from." passes validation and ships.
 *
 * acmeincubator hit this because its team crawl found 0 members: with nobody to write
 * about, the copy step returned the template's own words, and they rendered on a
 * page that was one approval away from a prospect. The design review caught it
 * only after being grounded in the DOM.
 *
 * Blanking rather than deleting is deliberate. BiosSection renders
 * `t.bodies[i] ?? ""`, so an empty body yields a card with a name and a role and
 * no paragraph — which is honest. Removing the entry would change the array
 * arity that `syncBioBodyArity` and `validateEnTs` both key on, and the last
 * time bio arity drifted every demo silently reverted to neutral copy.
 *
 * It does NOT invent a bio. There is no safe way to generate biographical claims
 * about a real person from a page that never mentioned them.
 */
/** How many `bios.roles` entries the applied en.ts has (localized role text). */
export function enRoleCount(enPath: string): number {
  return countBioArray(enPath, "roles");
}

/** How many NON-EMPTY `bios.bodies` entries the applied en.ts has. */
export function enBodyCount(enPath: string): number {
  return countBioArray(enPath, "bodies", true);
}

function countBioArray(enPath: string, key: "roles" | "bodies", nonEmpty = false): number {
  if (!existsSync(enPath)) return 0;
  const m = readFileSync(enPath, "utf8").match(new RegExp(`${key}:\\s*\\[([\\s\\S]*?)\\n\\s*\\],`));
  if (!m) return 0;
  const lits = m[1].match(/"(?:[^"\\]|\\.)*"/g) ?? [];
  return nonEmpty ? lits.filter((l) => l.length > 2).length : lits.length;
}

export function stripPlaceholderBios(enPath: string): number {
  if (!existsSync(enPath)) return 0;
  const src = readFileSync(enPath, "utf8");
  const m = src.match(/(bodies:\s*\[)([\s\S]*?)(\n\s*\],)/);
  if (!m) return 0;
  let n = 0;
  const body = m[2].replace(/"((?:[^"\\]|\\.)*)"/g, (whole, text: string) => {
    if (!PLACEHOLDER_COPY.some((re) => re.test(text))) return whole;
    n += 1;
    return '""';
  });
  if (!n) return 0;
  writeFileSync(enPath, src.replace(m[0], `${m[1]}${body}${m[3]}`));
  return n;
}

/**
 * Which bio bodies describe somebody OTHER than the card they sit on?
 *
 * `brand.config.bios` (who — from the team scraper) and `en.ts bios.bodies`
 * (what is said — from the copy generator) are produced by different processes
 * and joined BY ARRAY INDEX at render time. Nothing binds body[i] to person[i];
 * run.ts merely asserts in a comment that "the generated lead bio belongs to
 * the first member". On acmeincubator.org that assumption was false: the scraper
 * returned Sam Torres first, the generator wrote about Casey Brook, and the
 * demo published Casey Brook's biography under Sam Torres's name and face.
 * Once locale translation started working it published that in fluent French,
 * which made the false attribution more convincing rather than less.
 *
 * Equal array lengths would NOT have prevented this. The invariant that matters
 * is identity, not arity.
 *
 * Deliberately does nothing for a single-bio demo: with one card there is no
 * one to confuse it with, and prose about "our founder" that never states a
 * surname is perfectly good copy. The rule only bites once a team has members
 * who could be mixed up — which is exactly when index-joining goes wrong.
 */
export function misattributedBioBodies(
  bios: Array<{ name: string }>,
  bodies: string[],
): number[] {
  if (bios.length <= 1) return [];
  const surnames = bios.map((b) => personSurnames(b.name));
  const out: number[] = [];
  for (let i = 0; i < bodies.length && i < bios.length; i++) {
    const body = (bodies[i] ?? "").toLowerCase();
    if (!body.trim()) continue; // already empty — nothing to misattribute
    if (surnames[i].some((s) => body.includes(s))) continue; // names its own person
    out.push(i);
  }
  return out;
}

/**
 * Blank every bio body that describes someone other than its own card.
 *
 * Blanks rather than deletes: an empty body renders a name + role + photo card,
 * which the template already supports and run.ts already produces for members
 * 2..N. So the degraded state is a designed layout, not a broken one — a
 * missing sentence beats a false statement about a named person.
 */
export function dropMisattributedBios(enPath: string, bios: Array<{ name: string }>): number[] {
  if (!existsSync(enPath)) return [];
  const src = readFileSync(enPath, "utf8");
  const m = src.match(/(bodies:\s*\[)([\s\S]*?)(\n\s*\],)/);
  if (!m) return [];
  const literals = m[2].match(/"(?:[^"\\]|\\.)*"/g) ?? [];
  const bodies = literals.map((l) => l.slice(1, -1));
  const bad = new Set(misattributedBioBodies(bios, bodies));
  if (!bad.size) return [];
  let i = -1;
  const rebuilt = m[2].replace(/"(?:[^"\\]|\\.)*"/g, (whole) => {
    i += 1;
    return bad.has(i) ? '""' : whole;
  });
  writeFileSync(enPath, src.replace(m[0], `${m[1]}${rebuilt}${m[3]}`));
  return [...bad];
}

/**
 * Strings that mean "nobody wrote this yet".
 *
 * Kept narrow and anchored on instructional phrasing: real copy does not tell
 * the reader to replace it. A loose pattern here would blank legitimate text,
 * which is worse than the placeholder it guards against.
 */
export const PLACEHOLDER_COPY = [
  /\breplace this with\b/i,
  /\bplaceholder\b/i,
  /\blorem ipsum\b/i,
  /\byour (?:bio|text|copy) here\b/i,
  /\bTODO\b/,
];

/**
 * Does this name denote an ORGANISATION rather than a person?
 *
 * `prospectName` carries an optional parenthetical — "Acme Spine Care (Dr. Ken
 * Chang)" — and the pipeline reads it as the lead person's name. Some queue
 * entries use it for the legal entity instead: "Acmeincubator (The Space Finance
 * Group)". The bio card then renders that entity under a personal role, and a
 * deployed demo read "The Acme Finance Group — Founder".
 *
 * Deliberately a suffix/keyword test rather than anything cleverer. It only
 * decides whether to SHOW a section, so a false positive costs a section that
 * would have been thin anyway, while a false negative puts an untrue sentence
 * on a page we send to the company it is untrue about. Those are not
 * symmetrical, so this errs toward hiding.
 */
export function looksLikeOrganisation(name: string): boolean {
  return /\b(?:group|inc|llc|ltd|limited|corp|corporation|co|company|foundation|institute|institution|partners|capital|ventures|holdings|labs|laboratories|associates|clinic|center|centre|society|association|trust|plc|gmbh|ag|sa|bv|nv)\b\.?$/i.test(
    name.trim().replace(/[.,]$/, ""),
  );
}

/** Initials for the favicon: "Acme Bio" → "AB", "Divinci" → "D". */
export function brandInitials(siteName: string): string {
  const words = siteName.split(/[\s\-—]+/).filter((w)=>(/[A-Za-z0-9]/.test(w)));
  const letters = words.map((w)=>(w.replace(/[^A-Za-z0-9]/g, "")[0] ?? "")).filter(Boolean);
  return (letters.slice(0, 2).join("") || siteName.trim()[0] || "?").toUpperCase();
}

/** XML-escape — a siteName with `&` or `<` would otherwise emit invalid SVG
 *  that renders as nothing, i.e. a blank hero. */
function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Helvetica-Bold advance widths (AFM units per 1000em) for the characters a
 *  brand name actually uses. Anything unlisted falls back to 0.6em. */
const HELVETICA_BOLD_ADVANCE: Record<string, number> = {
  " ": 278, "-": 333, ".": 278, "&": 722, "'": 238, ",": 278,
  A: 722, B: 722, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 556,
  K: 722, L: 611, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611,
  U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  a: 556, b: 611, c: 556, d: 611, e: 556, f: 333, g: 611, h: 611, i: 278, j: 278,
  k: 556, l: 278, m: 889, n: 611, o: 611, p: 611, q: 611, r: 389, s: 556, t: 333,
  u: 611, v: 556, w: 778, x: 556, y: 556, z: 500,
  0: 556, 1: 556, 2: 556, 3: 556, 4: 556, 5: 556, 6: 556, 7: 556, 8: 556, 9: 556,
};

/**
 * Width of `text` at `fontSize` in Helvetica Bold, including letter-spacing.
 *
 * The first version guessed a flat 18.6px per character. For "Acme Bio"
 * that produced a 279-unit viewBox around 228 units of glyphs — 51 units of
 * trailing whitespace inside the <img>, which at the hero's rendered height
 * shoved the adjacent "AI" mark ~68px to the right of the wordmark. A logo box
 * wider than its ink is invisible in isolation and only shows up as a layout
 * bug next to whatever sits beside it.
 */
export function wordmarkTextWidth(text: string, fontSize: number, letterSpacing = -1): number {
  const em = [...text].reduce((sum, ch)=>(sum + (HELVETICA_BOLD_ADVANCE[ch] ?? 600)), 0) / 1000;
  const tracking = letterSpacing * Math.max(0, [...text].length - 1);
  return Math.max(1, Math.ceil(em * fontSize + tracking));
}

/**
 * Guarantee `public/brand/{logo,favicon}.svg` name THIS customer.
 *
 * The template ships a neutral placeholder wordmark reading "Acme Expert" so
 * it builds standalone. `brand-extract` only overwrites it when it manages to
 * scrape a logo from the prospect's site; when it doesn't, nothing errors and
 * nothing warns — the placeholder is simply served. Acme Bio's demo
 * went out with "Acme Expert" as its headline for exactly this reason, and the
 * page was otherwise correct (title, copy and chat all said Acme Bio),
 * which is what made it survive review.
 *
 * A generated wordmark is not as good as the real logo. It is strictly better
 * than another company's name, and it fails visibly rather than silently.
 */
export function ensureBrandWordmark(siteDir: string, draft: { siteName: string; logoFile?: string; palette?: { ink?: string; accent?: string } }): void {
  const dir = join(siteDir, "public", "brand");
  if (!existsSync(dir)) return;

  // A real extracted asset wins — only the placeholder is replaced.
  if (draft.logoFile && draft.logoFile !== "logo.svg") return;

  const logoPath = join(dir, "logo.svg");
  if (existsSync(logoPath) && !readFileSync(logoPath, "utf8").includes("Acme Expert")) return;

  const name = draft.siteName.trim();
  const ink = draft.palette?.ink ?? "currentColor";
  const accent = draft.palette?.accent ?? "#4299e1";
  // Measure the glyphs rather than guessing per-character. "over-estimating
  // only adds trailing space" was wrong: the hero sets the <img> height and
  // lets width follow the viewBox, so trailing space inside the box is
  // rendered space on the page — it pushed the adjacent "AI" mark ~68px right
  // of the wordmark. +2 for the anti-aliased right edge of the last glyph.
  const width = Math.max(120, wordmarkTextWidth(name, 30) + 2);

  // `textLength` + `lengthAdjust` pin the rendered text to EXACTLY the box
  // width, in whatever font the viewer's machine actually resolves.
  //
  // Without it the box is sized from Helvetica-Bold metrics while the text is
  // drawn in whatever `Helvetica, Arial, sans-serif` resolves to. On macOS
  // those agree and it looks perfect; on a machine with neither font the
  // generic fallback is wider, the text overruns the viewBox and the renderer
  // CLIPS it — a customer's name truncated mid-word ("Applied BioCod"), on a
  // machine we do not have and therefore never see.
  writeFileSync(logoPath, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} 42" width="${width}" height="42" role="img" aria-label="${xmlEscape(name)}">
  <text x="0" y="31" textLength="${width}" lengthAdjust="spacingAndGlyphs" font-family="Helvetica, Arial, sans-serif" font-size="30" font-weight="800" letter-spacing="-1" fill="${ink}">${xmlEscape(name)}</text>
</svg>
`);

  console.log(`[landing] no extracted logo — generated wordmark for "${name}"`);
}

/**
 * Guarantee the favicon names THIS customer.
 *
 * ⚠️ This used to live inside ensureBrandWordmark, AFTER its
 * `if (draft.logoFile && draft.logoFile !== "logo.svg") return;` early exit —
 * so a demo whose logo scraped successfully never reached the favicon line and
 * shipped the template's placeholder: a slate square with a blue "A", whose
 * aria-label reads "Acme Expert". Every demo with a working logo had another
 * company's initial in its browser tab, which is the majority of them.
 *
 * The favicon has nothing to do with whether the LOGO was extracted, so it is
 * no longer conditioned on it. Same failure shape as the logo placeholder it
 * sits beside: nothing errored, nothing warned, and the tab was simply wrong.
 */
export function ensureBrandFavicon(
  siteDir: string,
  draft: { siteName: string; faviconFile?: string; palette?: { dark?: string; primary?: string; accent?: string; cream?: string } },
): void {
  const dir = join(siteDir, "public", "brand");
  if (!existsSync(dir)) return;

  // A real favicon scraped from the customer's own site always wins.
  if (draft.faviconFile && draft.faviconFile !== "favicon.svg") return;

  const path = join(dir, "favicon.svg");
  if (existsSync(path)) {
    const cur = readFileSync(path, "utf8");
    // Keep anything that is not the shipped placeholder — including a favicon
    // a human dropped in by hand.
    if (!cur.includes("Acme Expert")) return;
  }

  const name = draft.siteName.trim();
  const initials = brandInitials(name);
  // Brand colours, not the template's slate. `accent` is unreliable — it is
  // often the raw link blue lifted off the page (#0000ee on Acme Renew) — so
  // prefer the palette's own dark/primary.
  const bg = draft.palette?.dark ?? draft.palette?.primary ?? "#2d3748";
  const fg = readableOn(bg);
  writeFileSync(path, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32" role="img" aria-label="${xmlEscape(name)}">
  <rect width="32" height="32" rx="7" fill="${bg}"/>
  <text x="16" y="23" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="${initials.length > 1 ? 15 : 20}" font-weight="800" fill="${fg}">${xmlEscape(initials)}</text>
</svg>
`);
  console.log(`[landing] favicon: generated "${initials}" on ${bg} for "${name}"`);
}

/**
 * White or near-black, whichever is legible on `bg`. A fixed foreground makes
 * the initials vanish on roughly half of the palettes we generate.
 */
export const FAVICON_LIGHT_INK = "#ffffff";
export const FAVICON_DARK_INK = "#111111";

function relativeLuminance(hex: string): number | undefined {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return undefined;
  const h = m[1].length === 3 ? m[1].split("").map((c)=>(c + c)).join("") : m[1];
  const [r, g, b] = [0, 2, 4].map((i)=>(parseInt(h.slice(i, i + 2), 16) / 255));
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function readableOn(bg: string): string {
  const L = relativeLuminance(bg);
  if (L === undefined) return FAVICON_LIGHT_INK;
  // Compare against the ACTUAL inks we ship, not idealised #fff/#000 — the
  // dark ink is #111111, and scoring it as pure black overstates it. Mid-tone
  // brand colours are exactly where the two are close enough to matter:
  // #af812e scores 3.5:1 with white and 6.0:1 with dark ink.
  const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  const light = contrast(L, relativeLuminance(FAVICON_LIGHT_INK)!);
  const dark = contrast(L, relativeLuminance(FAVICON_DARK_INK)!);
  return light >= dark ? FAVICON_LIGHT_INK : FAVICON_DARK_INK;
}

/**
 * Optically centre the blue "AI" mark against the wordmark image.
 *
 * The hero lays the two out with `items-end`, i.e. bottom-aligned boxes. That
 * is not optical alignment: the wordmark is an <img> whose SVG carries the text
 * baseline at y=31 of a 42-unit viewBox, so ~26% of the box is empty descender
 * space below the glyphs, while "AI" is live text with its own metrics. The
 * boxes line up and the LETTERS do not.
 *
 * Measured in the browser on the Acme Bio demo: the AI's ink centre sat
 * 5.0px BELOW the wordmark's at the md breakpoint (48px "AI" against a 56px
 * logo). A -5px nudge takes the residual to -0.01px. The base breakpoint is
 * proportionally smaller (36px text / 40px logo), hence 3.75px there.
 *
 * Deliberately px-per-breakpoint rather than `em`: an `em` on this wrapper
 * resolves against ITS inherited font-size (16px), not the 48px of the child —
 * the first attempt moved the mark 1.7px instead of 5px for exactly that
 * reason.
 */
/**
 * ⚠️ THIS SILENTLY STOPPED WORKING. The template moved from
 * `relative inline-flex items-center` to `relative inline-block` (a deliberate
 * change — an inline-flex box exposes a baseline that broke the wrapper), and
 * this kept looking for the old string. It printed
 * `alignAiMark: hero AI wrapper not found — template changed?` and returned
 * false, and the run carried on. Observed on acmesecurity and acmeimpact; how
 * many runs shipped un-nudged is unknown, because a warning nobody greps for is
 * not a signal.
 *
 * The nudge is also NOT a constant. It was calibrated at 5px against Applied
 * Acme Bio's 48px "AI" on a 56px logo; the deployed Acme Security page measured 3.5px on
 * desktop and 4.0px on mobile. A fixed px value is right for exactly one logo
 * size. Treat this as a first approximation and rely on the deterministic
 * hero-lockup check (hero-lockup-check.ts) for the truth — it measures the ink
 * centres of the DEPLOYED page and reports the residual.
 */
/**
 * Does this brand's lockup render its NAME AS TEXT rather than as an image?
 *
 * True when the logo is a mark (so the template draws the name instead) or
 * when there is no logo file at all.
 */
/**
 * Drop Google Fonts links for families Google does not host.
 *
 * Generation is fixed upstream (googleFontsUrl skips system fonts), but every
 * draft written before that fix still carries the bad links — Acme Renew's has
 * `family=Times` and `family=Georgia`, and each is a **403** on every page
 * load, from a render-blocking <link> in <head>. Sanitising here means a
 * redeploy cleans an existing demo without re-running extraction.
 *
 * Only Google css/css2 links are considered: a Typekit or self-hosted
 * stylesheet may legitimately serve a face with the same name.
 */
export function pruneDeadFontLinks(links: string[]): string[] {
  return links.filter((href) => {
    if (!/fonts\.googleapis\.com\/css/.test(href)) return true;
    let fams: string[];
    try {
      const u = new URL(href);
      // css2 uses `family` once per family; css v1 packs them into one
      // `family` separated by `|`, each with an optional `:weights` suffix.
      fams = u.searchParams.getAll("family").flatMap((f) => f.split("|"))
        .map((f) => f.split(":")[0].replace(/\+/g, " ").trim())
        .filter(Boolean);
    } catch {
      return true; // unparseable — leave it alone rather than guess
    }
    if (fams.length === 0) return true;
    // Drop only when EVERY family on the link is a system font; a mixed link
    // still needs fetching for the families Google does host.
    return !fams.every(isSystemFont);
  });
}

export function isTextLockup(draft: { logoIsMark?: boolean; logoFile?: string }): boolean {
  return draft.logoIsMark === true || !draft.logoFile;
}

/**
 * ⚠️ The AI nudge is only correct for an IMAGE wordmark, and applying it to a
 * TEXT one makes the alignment worse by exactly its own size.
 *
 * The nudge exists because an <img> baselines on its BOTTOM EDGE while text
 * baselines on its baseline, so `items-baseline` drops an image wordmark by
 * the font's descender gap. A text lockup has no such gap: both sides are the
 * same face at the same size, so the browser already aligns them.
 *
 * Measured on the deployed Acme Renew hero (48px Georgia, both sides):
 *   with the 5px nudge      AI sits 7.96px above the wordmark's optical centre
 *   with the nudge removed  AI sits 2.96px above
 *
 * i.e. the nudge contributed a clean 5px of the 8px error. This is the
 * "recurring" lockup misalignment: it followed the brand's logo SHAPE, not the
 * template, so it reappeared on every mark-logo demo.
 */
/**
 * ⚠️ A MEASURED logoBaselineDrop supersedes this guess — they fix the SAME
 * defect and stack if both are applied.
 *
 * The nudge moves the AI mark UP by a fixed 3.75/5px; logoBaselineDrop moves
 * the LOGO down by however much that particular file actually needs, read from
 * its alpha channel. Acme Advisors shipped both for one deploy: 5.09px of measured
 * drop plus 5px of guessed lift, i.e. 10px of correction where 5 was called
 * for, and the AI ended up as far below the letters as it had been above them.
 *
 * The measurement wins because it is per-logo — the correction ranges from
 * ~2px to ~14px across the demos we have — and the guess stays for every logo
 * that cannot be measured (an SVG, or one with no alpha channel).
 */
export function defaultAiNudge(textLockup: boolean, measuredDrop?: number): { base: number; md: number } {
  if (textLockup || typeof measuredDrop === "number") return { base: 0, md: 0 };
  return { base: 3.75, md: 5 };
}

export function defaultHeaderAiNudge(textLockup: boolean, measuredDrop?: number): { base: number; md: number } {
  if (textLockup || typeof measuredDrop === "number") return { base: 0, md: 0 };
  return { base: 3, md: 3 };
}

/**
 * A vertical nudge as a Tailwind class.
 *
 * `-translate-y-[Npx]` moves the mark UP by N. A NEGATIVE nudge therefore has
 * to become `translate-y-[Npx]`, not `-translate-y-[-Npx]` — the latter is not
 * a class Tailwind generates, so it silently does nothing and the mark stays
 * exactly where it was. Which is indistinguishable, on the page, from the
 * nudge having been applied and been wrong.
 */
export function nudgeClass(px: number, prefix = ""): string {
  const p = prefix ? `${prefix}:` : "";
  return px < 0 ? `${p}translate-y-[${(-px).toFixed(2)}px]` : `${p}-translate-y-[${px.toFixed(2)}px]`;
}

export function alignAiMark(
  siteDir: string,
  nudge: { base: number; md: number } = { base: 3.75, md: 5 },
): boolean {
  const hero = join(siteDir, "src", "components", "sections", "HeroSection.astro");
  if (!existsSync(hero)) return false;
  const src = readFileSync(hero, "utf8");
  // Matches BOTH forms — a negative nudge emits `translate-y-[Npx]` with no
  // leading dash, and a guard that only knew the positive form would patch a
  // second time on re-run and stack two translates.
  if (/(^|[\s"])-?translate-y-\[[\d.]+px\]/.test(src)) return false; // already nudged (any value)

  // Match the CURRENT template first, then the historical one. Listed rather
  // than regex-matched so a third variant fails loudly instead of matching
  // something structurally similar and nudging the wrong element.
  const targets = [
    '<span class="relative inline-block">',
    '<span class="relative inline-flex items-center">',
  ];
  const target = targets.find((t) => src.includes(t));
  if (!target) {
    // Loud, and it names the fix. The previous console.warn was true, quiet,
    // and acted on by nobody.
    console.error(
      "[landing] ⛔ alignAiMark: hero AI wrapper not found — the template changed again. " +
        `Tried: ${targets.map((t) => JSON.stringify(t)).join(", ")}. ` +
        "The AI mark will render un-centred; update the target list in landing.ts.",
    );
    return false;
  }
  const patched = target.replace(
    'class="relative inline-',
    `class="relative ${nudgeClass(nudge.base)} ${nudgeClass(nudge.md, "md")} inline-`,
  );
  writeFileSync(hero, src.replace(target, patched));
  console.log(`[landing] optically centred the AI mark against the wordmark (matched ${JSON.stringify(target)})`);
  return true;
}

/**
 * The HEADER lockup has the same defect as the hero and was never patched.
 *
 * alignAiMark only ever touched HeroSection.astro, so the header's "AI" sat
 * uncorrected on every demo ever built — measured 6px below the wordmark's ink
 * centre on Acme Security, with `translate: none` confirming nothing had run.
 *
 * A separate function rather than a loop over both files because the OFFSET IS
 * DIFFERENT: the header renders the same logo at 24px against the hero's 56px,
 * and Acme Security needs 6px here against 10.5px there. Not proportional (0.25 vs
 * 0.1875) — it depends on where the ink sits at each rendered size — so the
 * value has to be measured per surface, which is what the deterministic
 * hero-lockup check reports.
 */
export function alignHeaderAiMark(
  siteDir: string,
  nudge: { base: number; md: number } = { base: 3, md: 3 },
): boolean {
  const header = join(siteDir, "src", "components", "Header.astro");
  if (!existsSync(header)) return false;
  const src = readFileSync(header, "utf8");
  if (/(^|[\s"])-?translate-y-\[[\d.]+px\]/.test(src)) return false; // already nudged (either sign)
  const target = '<span class="relative inline-block">';
  if (!src.includes(target)) {
    console.error(
      "[landing] ⛔ alignHeaderAiMark: header AI wrapper not found — the template changed. " +
        `Tried ${JSON.stringify(target)}. The header AI will render un-centred.`,
    );
    return false;
  }
  const patched = target.replace(
    'class="relative inline-',
    `class="relative ${nudgeClass(nudge.base)} ${nudgeClass(nudge.md, "md")} inline-`,
  );
  writeFileSync(header, src.replace(target, patched));
  console.log("[landing] optically centred the AI mark in the header");
  return true;
}

/**
 * Stop the CTA headline stranding its last word on a line of its own.
 *
 * "Ready to ask the Acme Bio AI a question?" wrapped as
 * "… AI a" / "question?" — the orphan reads as a mistake.
 *
 * `text-wrap: pretty` is the browser's own orphan-avoidance pass and it
 * produced exactly the wanted break ("… AI" / "a question?") at every width
 * tested. It is used in preference to a non-breaking space because the
 * headline is GENERATED PER PROSPECT and translated into 36 locales — binding
 * "a question?" by hand fixes one string in one language, and every other
 * locale keeps the orphan. `balance` was tried first and is wrong here: it
 * split the company name ("Acme" / "Bio AI a question?").
 *
 * Browsers without support fall back to today's wrapping, so this cannot
 * regress anything.
 */
export function preventHeadlineOrphans(siteDir: string): boolean {
  const cta = join(siteDir, "src", "components", "sections", "CTASection.astro");
  if (!existsSync(cta)) return false;
  const src = readFileSync(cta, "utf8");
  if (src.includes("[text-wrap:pretty]")) return false;
  const target = '<h2 class="text-3xl font-bold text-white md:text-4xl">';
  if (!src.includes(target)) {
    console.warn("[landing] preventHeadlineOrphans: CTA headline not found — template changed?");
    return false;
  }
  writeFileSync(
    cta,
    src.replace(target, '<h2 class="text-3xl font-bold text-white md:text-4xl [text-wrap:pretty]">'),
  );
  console.log("[landing] CTA headline set to text-wrap:pretty (no orphaned last word)");
  return true;
}

/**
 * Set the chat gate for this demo by rewriting the two constants in the
 * template's brand.config.ts.
 *
 * ⚠️ THIS REPLACED A FIVE-ANCHOR SOURCE PATCH, and the reason is worth keeping.
 * The old `patchOutEmailGate` rewrote five exact strings across ChatIsland.tsx
 * and MessageInput.tsx and threw if any failed to match — deliberately, since a
 * half-applied patch shipped a demo whose send button was enabled, whose label
 * read "Your email ✓", and which answered "email required" when pressed.
 *
 * But it patched the EMAIL gate only, and never the MESSAGE quota beside it. So
 * a direct-handoff demo built with LANDING_NO_EMAIL_GATE=1 had its worker
 * configured for 500 sends while its CLIENT still carried
 * `FREE_MESSAGE_QUOTA = 1` — after a single question the composer was replaced
 * by the sign-up CTA. acmebio, the demo going to a customer, shipped that way:
 * one message, then "sign up". Nothing failed, so nothing said so.
 *
 * Editing the two constants expresses the whole intent in one place, cannot be
 * half-applied, and does not break every time the template's JSX moves.
 */
export interface ChatGateConfig {
  /** No address is collected, ever. */
  noEmailGate: boolean;
  /** Per-visitor send budget for a no-email-gate demo. */
  demoQuota: number;
  /** Worker-side grace window; 0 when the gate is off (the worker ignores it). */
  freeBeforeEmail: number;
  /** Client-side FREE_MESSAGES_BEFORE_EMAIL. */
  clientBeforeEmail: number;
  /** Client-side FREE_MESSAGE_QUOTA. */
  clientQuota: number;
}

/**
 * Decide the chat gate for a demo from the environment.
 *
 * ⚠️ NO EMAIL PROMPT IS THE DEFAULT, and it is deliberate.
 *
 * This used to be `LANDING_NO_EMAIL_GATE === "1"` — opt-IN, set nowhere in the
 * repo and therefore passed by hand on every deploy. Every live demo had it,
 * which is the tell: a flag that must always be passed is a default wearing a
 * disguise, and the one deploy that forgot it would silently put a lead-capture
 * form in front of a prospect's demo. That is precisely what a redeploy did.
 *
 * A demo is a thing you show someone. Asking a stranger to identify themselves
 * before the assistant has answered anything reads as a form standing in front
 * of the product, and it was the most common complaint about these pages.
 *
 * Set LANDING_NO_EMAIL_GATE=0 for a demo where the address IS the point (a cold
 * outreach link whose purpose is lead capture). That path is fully supported —
 * the visitor then gets LANDING_FREE_MESSAGES_BEFORE_EMAIL (default 3) messages
 * before being asked, never the old ask-before-the-first-answer behaviour.
 */
export function resolveChatGate(env: NodeJS.ProcessEnv = process.env): ChatGateConfig {
  const noEmailGate = env.LANDING_NO_EMAIL_GATE !== "0";
  const demoQuota = Number(env.LANDING_DEMO_QUOTA ?? "500") || 500;
  const grace = Number(env.LANDING_FREE_MESSAGES_BEFORE_EMAIL ?? "3") || 0;
  return {
    noEmailGate,
    demoQuota,
    freeBeforeEmail: noEmailGate ? 0 : grace,
    // With no address collected there is no "one more after the email", so the
    // client's cap is exactly the worker's budget — not one more, not one less.
    clientBeforeEmail: noEmailGate ? demoQuota : grace,
    clientQuota: noEmailGate ? 0 : 1,
  };
}

export function configureChatGate(
  siteDir: string,
  opts: { freeMessagesBeforeEmail: number; freeMessageQuota: number },
): void {
  const cfgPath = join(siteDir, "src", "brand.config.ts");
  let src = readFileSync(cfgPath, "utf8");

  const edits: Array<[RegExp, string, string]> = [
    [
      /export const FREE_MESSAGES_BEFORE_EMAIL = \d+;/,
      `export const FREE_MESSAGES_BEFORE_EMAIL = ${opts.freeMessagesBeforeEmail};`,
      "FREE_MESSAGES_BEFORE_EMAIL",
    ],
    [
      /export const FREE_MESSAGE_QUOTA = \d+;/,
      `export const FREE_MESSAGE_QUOTA = ${opts.freeMessageQuota};`,
      "FREE_MESSAGE_QUOTA",
    ],
  ];

  // Verify both anchors BEFORE writing either: the pair only makes sense
  // together, and a template that has moved should fail loudly rather than
  // ship a demo whose client and worker disagree about the gate.
  for (const [re, , name] of edits) {
    const n = src.match(new RegExp(re.source, "g"))?.length ?? 0;
    if (n !== 1) {
      throw new Error(
        `configureChatGate: expected exactly 1 \`${name}\` declaration in brand.config.ts, found ${n} — ` +
          `template changed, re-check before shipping`,
      );
    }
  }
  for (const [re, to] of edits) src = src.replace(re, to);
  writeFileSync(cfgPath, src);
  console.log(
    `[landing] chat gate: ${opts.freeMessagesBeforeEmail} message(s) before email, ` +
      `then ${opts.freeMessageQuota} more`,
  );
}

function patchEmbedBridge(siteDir: string): void {
  const embedPath = join(siteDir, "src", "pages", "embed.astro");
  if (!existsSync(embedPath)) {
    console.warn("[landing] embed.astro not found — skipping embed-bridge patch");
    return;
  }
  let src = readFileSync(embedPath, "utf8");
  if (src.includes("divinci-embed-bridge")) return; // already patched
  const script = `    <script is:inline>
      /* divinci-embed-bridge: auto-resize to content (no inner scroll) +
         accept "ask" messages from the host shell's fixed Ask bar. */
      (function () {
        if (window.parent === window) return; // only when iframed
        // Measure the <main> content, NOT documentElement.scrollHeight: the
        // template pins body/html to min-height:100%, so scrollHeight clamps to
        // the iframe's own height and can never shrink. main grows with the chat.
        var post = function () {
          var m = document.querySelector("main");
          var h = m ? Math.ceil(m.getBoundingClientRect().height + 8) : Math.ceil(document.documentElement.scrollHeight);
          window.parent.postMessage({ type: "divinci-embed-height", height: h }, "*");
        };
        if (window.ResizeObserver) {
          try {
            var ro = new ResizeObserver(post);
            ro.observe(document.body);
            var mainEl = document.querySelector("main");
            if (mainEl) ro.observe(mainEl);
          } catch (e) {}
        }
        window.addEventListener("load", post);
        setTimeout(post, 300); setTimeout(post, 1200);
        window.addEventListener("message", function (e) {
          var d = e && e.data;
          if (!d || d.type !== "divinci-ask" || typeof d.text !== "string") return;
          var text = d.text.trim();
          if (!text) return;
          window.dispatchEvent(new CustomEvent("divinci:populateInput", { detail: { text: text } }));
          window.scrollTo({ top: 0, behavior: "smooth" });
          setTimeout(post, 100);
        });
      })();
    </script>
`;
  if (src.includes("</body>")) {
    src = src.replace("</body>", `${script}  </body>`);
    writeFileSync(embedPath, src);
    console.log("[landing] patched /embed/ with auto-resize + ask bridge");
  } else {
    console.warn("[landing] embed.astro has no </body> — skipping embed-bridge patch");
  }
}

/**
 * Give a bespoke generated homepage the social-share metadata the Astro layout
 * would have provided.
 *
 * The generated shell replaces dist/index.html wholesale, `<head>` included, so
 * it inherits nothing from Landing.astro. All 15 generated demos therefore
 * shipped with no og tags at all — a link posted to Slack or X showed the bare
 * URL. (The template-mode demos had og tags but pointed them at an /og.png that
 * was never built; both halves had to be fixed to make a link unfurl.)
 *
 * Idempotent and non-destructive: a property already present is left alone, so
 * a generator that starts emitting its own og tags silently takes precedence
 * rather than ending up with duplicates.
 */
export function ensureSocialMeta(
  html: string,
  meta: { siteName: string; description?: string; imageAlt?: string; pageUrl: string },
): string {
  const headClose = html.search(/<\/head>/i);
  if (headClose === -1) {
    console.warn("[landing] generated homepage has no </head> — skipping social meta");
    return html;
  }

  const esc = (s: string) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  // Reuse the shell's own <title> — it is the line the copy generator wrote
  // for this brand, so it is a better share headline than anything derived.
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? meta.siteName;
  const description =
    meta.description ??
    html.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i)?.[1] ??
    `Chat with the ${meta.siteName} AI.`;
  // Absolute: X rejects a relative og:image outright, and Slack/LinkedIn
  // resolve one inconsistently.
  const image = new URL("/og.png", meta.pageUrl).href;

  const tags: Array<[string, string, string]> = [
    ["property", "og:site_name", meta.siteName],
    ["property", "og:url", meta.pageUrl],
    ["property", "og:type", "website"],
    ["property", "og:title", title],
    ["property", "og:description", description],
    ["property", "og:image", image],
    ["property", "og:image:type", "image/png"],
    ["property", "og:image:width", "1200"],
    ["property", "og:image:height", "630"],
    ["property", "og:image:alt", meta.imageAlt ?? title],
    ["name", "twitter:card", "summary_large_image"],
    ["name", "twitter:title", title],
    ["name", "twitter:description", description],
    ["name", "twitter:image", image],
  ];

  const missing = tags.filter(
    ([attr, key]) => !new RegExp(`<meta\\s+${attr}=["']${key}["']`, "i").test(html),
  );
  if (missing.length === 0) return html;

  const block =
    "\n" +
    missing.map(([attr, key, value]) => `<meta ${attr}="${key}" content="${esc(value)}">`).join("\n") +
    "\n";
  // A canonical link too, when absent — the same head is reused per locale.
  const canonical = /<link\s+rel=["']canonical["']/i.test(html)
    ? ""
    : `<link rel="canonical" href="${esc(meta.pageUrl)}">\n`;

  console.log(`[landing] injected ${missing.length} social meta tag(s) into the bespoke homepage`);
  return html.slice(0, headClose) + block + canonical + html.slice(headClose);
}

export interface DeployResult {
  url: string;
  workerName: string;
  /** Which LandingHost served this deploy — recorded so teardown can find it. */
  host?: string;
  /** true if the LANDING_PAGE_HMAC_KEY worker secret was set during deploy. */
  hmacSet: boolean;
  /** true if the BASIC_AUTH_PASSWORD preview-gate secret was set during deploy. */
  basicAuthSet?: boolean;
}

/**
 * The words a VISITOR reads on a built page — markup, scripts and styles gone.
 *
 * This is not a nicety. The first version of the gate below matched
 * `PLACEHOLDER_TEXT` against raw HTML and refused EVERY deploy, healthy demos
 * included, because `/\bplaceholder\b/i` matches the email field's
 * `placeholder="you@example.com"` attribute — which every built page has. A
 * guard that grounds the fleet is worse than the defect it was written for.
 *
 * demo-preflight does not need this because it asks a real browser for
 * rendered text. This reads files, so it has to do the stripping itself.
 */
export function visibleText(html: string): string {
  return html
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:nbsp|#x27|#39|quot|amp|lt|gt|mdash|#x2014);/gi, (e) =>
      ({ "&nbsp;": " ", "&#x27;": "'", "&#39;": "'", "&quot;": '"', "&amp;": "&", "&lt;": "<", "&gt;": ">", "&mdash;": "—", "&#x2014;": "—" })[e.toLowerCase()] ?? " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Refuse to deploy a site whose BUILT pages still carry the template's
 * placeholder copy.
 *
 * Every other guard in this file protects one INPUT — the logo, the favicon,
 * the bios, the generated en.ts. This one reads the OUTPUT, immediately before
 * the deploy, and so it holds no matter which input failed.
 *
 * It exists because a demo went live on 2026-08-28 reading "Acme Expert" in
 * its <title>, og: tags, corpus headline, chat input placeholder and all three
 * conversation starters — under the prospect's own demo host. Nothing was
 * broken in a way any existing guard could see:
 *
 *   - The copy generator failed, so NO `en.draft.ts` was ever written. The
 *     loud "generated en.ts REJECTED" warning above only fires when a draft
 *     EXISTS and mismatches, so the absent-draft case passed in silence.
 *   - That prospect's PREVIOUS run had good copy. The rebuild overwrote a
 *     CORRECT live demo with the neutral template — a re-run is not only an
 *     additive operation.
 *   - demo-preflight DID catch it — `/\bacme (?:expert|corp)\b/i`, twice,
 *     blocking — but preflight runs at outreach (Gate 3), which is AFTER the
 *     deploy. So the prospect was never emailed and the placeholder page was
 *     public anyway.
 *
 * The lesson is the shape, not the string: a gate on SENDING is not a gate on
 * PUBLISHING. Same patterns as preflight, deliberately imported rather than
 * re-declared — here the two really are the same job (read a rendered page,
 * decide whether a human wrote it), separated only in time.
 */
export function assertNoPlaceholderCopy(siteDir: string): void {
  const distDir = join(siteDir, "dist");
  if (!existsSync(distDir)) return;

  const pages: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".html")) pages.push(full);
    }
  };
  walk(distDir);

  const hits: string[] = [];
  for (const page of pages) {
    const text = visibleText(readFileSync(page, "utf8"));
    for (const re of PLACEHOLDER_TEXT) {
      const m = text.match(re);
      if (!m) continue;
      const rel = page.slice(distDir.length + 1);
      // The matched TEXT, plus enough around it to recognise where it renders.
      const at = text.indexOf(m[0]);
      const context = text.slice(Math.max(0, at - 60), at + m[0].length + 60);
      hits.push(`${rel}: ${re} → …${context}…`);
      break; // one line per page is enough to act on
    }
  }
  if (!hits.length) return;

  throw new Error(
    `⛔ DEPLOY BLOCKED — ${hits.length} of ${pages.length} built page(s) still carry the ` +
      `template's placeholder copy. Deploying would publish another company's name ` +
      `on this prospect's demo.\n` +
      hits.map((h) => `    ${h}`).join("\n") +
      `\n    fix: regenerate this run's copy (the landing step's copy generator), or ` +
      `copy a good en.draft.ts from a previous run of the same prospect, then rebuild.`,
  );
}

/**
 * Build + deploy the branded landing worker. Writes the brand config + assets
 * (caller drops real logo/hero into <landingDir>/brand/ first; falls back to the
 * template's neutral placeholders), then hands the built site to the
 * configured LandingHost. Everything above that hand-off is host-agnostic.
 */
/**
 * Bind a draft's advertised domain to the host actually being deployed to.
 *
 * Extracted so the decision is unit-testable: `buildAndDeployLanding` clones a
 * repo and shells out to a build, so a regression here could not be caught
 * inside it. This is pure, and the branch above delegates rather than
 * re-deciding.
 *
 * Returns `changedFrom` rather than a boolean so the caller can name the stale
 * value in its warning — "reconciled the host" tells an operator nothing about
 * which two hosts disagreed.
 */
export function reconcileAdvertisedHost(
  draftAsWritten: LandingBrandDraft,
  host: Pick<LandingHost, "urlFor">,
): { draft: LandingBrandDraft; changedFrom?: string } {
  const advertised = host.urlFor(draftAsWritten.workerName);
  if (draftAsWritten.domain === advertised) return { draft: draftAsWritten };
  return { draft: { ...draftAsWritten, domain: advertised }, changedFrom: draftAsWritten.domain };
}

export async function buildAndDeployLanding(
  landingDir: string,
  draftAsWritten: LandingBrandDraft,
  kvNamespaceId: string,
  opts: { generatedHomepageHtml?: string } = {},
): Promise<DeployResult> {
  const siteDir = await ensureSiteClone(landingDir);

  /**
   * Reconcile the advertised host against the one we are ACTUALLY deploying to.
   *
   * `brand-draft.json` is written once, at gate time, and only when absent. Its
   * `domain` is a snapshot of where the demo was going to live on the day it
   * was drafted — so changing the host afterwards (or drafting under a
   * different `LANDING_HOST`) silently invalidates it, and the page ships a
   * canonical and og:url naming a host that may not exist.
   *
   * og:url is what a link preview reads. A demo link shared into Slack, email
   * or LinkedIn would preview a dead host — for a sales artifact whose only job
   * is to be opened by a stranger, the worst place to be wrong.
   *
   * Fixing the DRAFTING code cannot fix this: the draft is already on disk.
   * The reconciliation belongs where the host is actually known, which is here.
   *
   * ⚠️ The parameter is `draftAsWritten` and the reconciled value is bound to
   * `draft`, so that none of the 40-odd later references can reach the stale
   * domain by accident. Do not rename it back.
   */
  const resolvedHost = resolveLandingHost(process.env);
  const { draft, changedFrom } = reconcileAdvertisedHost(draftAsWritten, resolvedHost);
  if (changedFrom)
    console.warn(
      `landing: reconciled advertised host — draft said ${changedFrom}, ` +
        `deploying to ${draft.domain} (${resolvedHost.name}). The draft's domain is a ` +
        `snapshot from gate time; the deploy is what a visitor reaches.`,
    );

  // Splice the customer brand into the template's brand.config.ts (keeps its
  // BrandConfig interface + FREE_MESSAGE_QUOTA intact).
  const cfgPath = join(siteDir, "src", "brand.config.ts");
  writeFileSync(cfgPath, applyBrandConfig(readFileSync(cfgPath, "utf8"), draft));

  // Apply the generated per-customer copy (en.ts) if it exists AND matches the
  // template's shape exactly — otherwise keep the neutral copy so the build
  // never breaks on a bad generation.
  const enDraft = join(landingDir, "en.draft.ts");
  const enTarget = join(siteDir, "src", "i18n", "ui", "en.ts");

  // Keep the NEUTRAL en.ts bio-body count in step with the GENERATED copy's.
  //
  // validateEnTs → sameShape compares generated vs neutral and requires arrays
  // of EQUAL LENGTH, so a brand with 5 team members and a template shipping 2
  // placeholder bodies fails validation — and the failure is silent-ish: the
  // build logs one line, keeps the NEUTRAL copy, and ships the "Replace this
  // with a team member's published bio" placeholder under real people's names.
  //
  // Sync to the DRAFT's count, falling back to the brand's only when there is
  // no draft. Using the brand's count unconditionally assumed the generator
  // emits one body per bio; where it does not, this function CREATED the
  // mismatch it exists to prevent. All 17 June demos had 2 bodies against 1
  // recorded bio, so rebuilding them reverted every one to placeholder copy.
  //
  // Both arrays, independently. Syncing `bodies` alone left `roles` at the
  // template's count and the run was rejected anyway — after deploying, so the
  // placeholder page was already live.
  const enDraftPath = join(landingDir, "en.draft.ts");
  const brandBios = draft.bios?.length ?? 0;
  syncBioBodyArity(
    siteDir,
    draftBioArrayCount(enDraftPath, "bodies") ?? brandBios,
    draftBioArrayCount(enDraftPath, "roles") ?? brandBios,
  );

  if (existsSync(enDraft)) {
    const mismatch = explainEnTsMismatch(enDraft, enTarget);
    if (!mismatch) {
      copyFileSync(enDraft, enTarget);
      console.log("[landing] applied generated per-customer en.ts copy");
      const stripped = stripPlaceholderBios(enTarget);
      if (stripped)
        console.log(
          `[landing] blanked ${stripped} un-customised bio body — the template's own ` +
            `placeholder text was about to ship to a prospect`,
        );
      const misattributed = dropMisattributedBios(enTarget, draft.bios ?? []);
      if (misattributed.length)
        console.warn(
          `[landing] ⚠ blanked ${misattributed.length} bio body at index ${misattributed.join(", ")} — ` +
            `the text described someone other than the person named on that card. ` +
            `Cards: ${misattributed.map((i) => draft.bios?.[i]?.name ?? "?").join(", ")}`,
        );
      // The three numbers that have to agree, on one line, every build. They
      // live in three different files produced by three different processes,
      // and nothing else in the pipeline ever compares them: shape validation
      // checks the generated copy against the TEMPLATE, never against the brand.
      const localizedRoles = enRoleCount(enTarget);
      const bodiesKept = enBodyCount(enTarget);
      console.log(
        `[landing] bios: ${draft.bios?.length ?? 0} card(s) · ${localizedRoles} localized role(s) · ` +
          `${bodiesKept} body/bodies` +
          ((draft.bios?.length ?? 0) > localizedRoles
            ? `  ⚠ ${(draft.bios?.length ?? 0) - localizedRoles} card(s) will show an UNTRANSLATED role on every non-English page`
            : ""),
      );
    } else {
      // Loud, and specific about WHAT. "Keeping neutral copy" means shipping a
      // demo branded "Acme Expert AI" — in the title, the og: tags, the chat
      // welcome and the CTA — so this is not a warning to scroll past.
      console.warn(
        `[landing] ⛔ generated en.ts REJECTED — the demo will ship with NEUTRAL "Acme Expert" copy ` +
          `in its title, og: tags, chat welcome and CTA.\n` +
          `[landing]    reason: ${mismatch}\n` +
          `[landing]    fix: regenerate this run's copy, or give the new template string a literal ` +
          `fallback in its component instead of a key in the neutral en.ts.`,
      );
    }
  } else {
    // No draft AT ALL — copy generation never produced one (its call failed,
    // and run.ts logs that as a skip and carries on). This used to be the
    // silent path: the branch above only speaks when a draft EXISTS and
    // mismatches, so the one case where NOTHING was generated said nothing.
    // A demo shipped on it. Say it as loudly as the rejection does;
    // assertNoPlaceholderCopy is what actually stops the deploy.
    console.warn(
      `[landing] \u26d4 NO generated en.ts found at ${enDraft} \u2014 the demo would ship with ` +
        `NEUTRAL "Acme Expert" copy in its title, og: tags, chat welcome, conversation ` +
        `starters and CTA.\n` +
        `[landing]    cause: the landing step's copy generation failed or was skipped.\n` +
        `[landing]    fix: re-run the landing step, or copy a good en.draft.ts from a previous ` +
        `run of this prospect.`,
    );
  }

  // Copy any prospect assets the caller staged into <landingDir>/brand/.
  const brandSrc = join(landingDir, "brand");
  if (existsSync(brandSrc)) {
    await execFileP("cp", ["-R", `${brandSrc}/.`, join(siteDir, "public", "brand")]);
  }

  // …and if no logo was extracted, replace the TEMPLATE PLACEHOLDER rather
  // than shipping it. See ensureBrandWordmark: the placeholder reads
  // "Acme Expert", so a failed extraction silently puts another company's
  // name in the customer's hero.
  ensureBrandWordmark(siteDir, draft);
  // Unconditional, and deliberately NOT inside ensureBrandWordmark — a demo
  // whose logo scraped fine still needs a favicon that is not Acme's.
  ensureBrandFavicon(siteDir, draft);
  const textLockup = isTextLockup(draft);
  alignAiMark(siteDir, draft.aiMarkNudgePx ?? defaultAiNudge(textLockup, draft.logoBaselineDrop));
  alignHeaderAiMark(siteDir, draft.headerAiMarkNudgePx ?? defaultHeaderAiNudge(textLockup, draft.logoBaselineDrop));
  preventHeadlineOrphans(siteDir);

  // Hand the host its configuration. Everything above this line is
  // host-agnostic — the clone, the brand, the copy, the bios, the build — and
  // everything a specific host needs to know lives behind this interface.
  const { noEmailGate, demoQuota, freeBeforeEmail, clientBeforeEmail, clientQuota } =
    resolveChatGate(process.env);
  const host = resolvedHost;
  const hostCfg = {
    slug: draft.workerName,
    apiBase: draft.apiBase,
    releaseId: draft.releaseId,
    kvNamespaceId,
    chatGate: { noEmailGate, demoQuota, freeBeforeEmail },
  };
  host.configure(siteDir, hostCfg);

  // Patch the cloned template (survives the per-build `git reset --hard`):
  // teach /embed/ to auto-resize to its content (kills the iframe inner scroll)
  // and to accept "ask" messages from the host shell's fixed Ask bar.
  patchEmbedBridge(siteDir);

  // Set the chat gate on the client to match the worker. Both numbers come
  // from the SAME resolveChatGate call above, so the client and the worker
  // cannot be configured to disagree — which is the bug that shipped a demo
  // capped at one message against a 500-message worker.
  //
  // Two shapes (see resolveChatGate for why no-prompt is the default):
  //
  //   Demo (default) — no address, ever. The grace window is set to the whole
  //   per-visitor budget, so the email gate is off as a CONSEQUENCE of the
  //   budget rather than as a separate switch that can drift from it.
  //
  //   Lead-capture link (LANDING_NO_EMAIL_GATE=0) — the visitor gets
  //   FREE_MESSAGES_BEFORE_EMAIL messages, is asked for an address, then gets
  //   one more.
  configureChatGate(siteDir, {
    freeMessagesBeforeEmail: clientBeforeEmail,
    freeMessageQuota: clientQuota,
  });


  // Make /<code>/ pages in-language before the build: reuse the run's committed
  // translations when present (reproducible), else translate fresh + archive.
  await applyLocales(landingDir, siteDir);

  await execFileP("npm", ["run", "build"], { cwd: siteDir, timeout: 10 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });

  // GENERATED MODE: replace the built homepage with the bespoke generated shell.
  // The shell iframes the SAME worker's /embed/ route (relative, same-origin), so
  // /embed/ (real branded SDK chat) + /api/* (HMAC signing) stay intact — one
  // worker, one demo link. Template sections remain at their locale paths.
  if (opts.generatedHomepageHtml) {
    // The bespoke shell carries its OWN <head>, so everything Landing.astro
    // does for social sharing is discarded along with the template homepage.
    // Every one of the 15 generated demos went out with ZERO og tags: shared
    // in Slack or on X they unfurled as a bare link, no title, no image.
    //
    // Injected HERE rather than in the generator so it covers homepages that
    // were generated before this existed, and so a future edit to the
    // generator's <head> cannot quietly drop it again.
    const homepage = ensureSocialMeta(opts.generatedHomepageHtml, {
      siteName: draft.siteName,
      description: draft.ogSubtitle,
      imageAlt: draft.ogTagline,
      pageUrl: `${host.urlFor(draft.workerName)}/`,
    });
    writeFileSync(join(siteDir, "dist", "index.html"), homepage);
    console.log("[landing] generated mode: bespoke homepage spliced over dist/index.html");
    // Locale pages get the SAME bespoke shell, translated — so switching
    // language keeps the rich design (not the plain template page).
    await spliceBespokeLocales(landingDir, siteDir, homepage);
  }

  // Last thing before the site becomes public. See assertNoPlaceholderCopy:
  // this reads the BUILT pages, so it is the one check that does not care
  // which upstream step failed.
  assertNoPlaceholderCopy(siteDir);

  const deployed = await host.deploy(siteDir, hostCfg);

  // Set the landing-page HMAC secret so the worker's anonymous-chat calls are
  // signed. Combined with release.requireSignedAnonymousChat=true (set by the
  // landing stage), this stops anyone who extracts the public release ID from
  // calling the chat API directly and bypassing the per-email quota. The key
  // MUST be one of the API's accepted LANDING_PAGE_HMAC_KEY values.
  const hmacKey = process.env.LANDING_PAGE_HMAC_KEY;
  if (hmacKey) {
    await host.setSecret(siteDir, draft.workerName, "LANDING_PAGE_HMAC_KEY", hmacKey);
  }

  // Basic-Auth preview gate — OFF unless explicitly asked for.
  //
  // ⛔ THIS WAS ON BY DEFAULT UNTIL 2026-08-14 AND IT COST A DEAL. The Applied
  // Acme Bio prospect opened their demo during a scheduled call, hit a password
  // prompt, could not show it to her manager, and the project slipped. The gate
  // existed to stop a half-built demo being browsable by a stranger who
  // guessed the URL — a hypothetical harm — and it was paid for with a real
  // customer-facing outage, repeatedly, because EVERY landing deploy re-applied
  // it from state.json. Unlocking by hand never stuck; the next deploy put it
  // straight back.
  //
  // The default is now OPEN. A demo URL is unguessable, carries a per-visitor
  // spend cap, and is meant to be sent to someone. If a specific run genuinely
  // needs a lock, set LANDING_GATE=1 for that run — deliberately, per run,
  // never persisted.
  //
  // ⚠️ DO NOT REINSTATE A DEFAULT-ON GATE. A gate that defaults on protects an
  // unfinished demo at the cost of silently RE-LOCKING a finished one on the
  // next rebuild — the demo goes dark without anyone touching it, and the link
  // already sent to the client stops working. If you need to protect work in
  // progress, find a mechanism that cannot reach a demo already delivered.
  //
  // LANDING_PUBLIC=1 is still accepted and still forces removal, so existing
  // scripts and the state.landingPublic flag keep working.
  const wantsGate = process.env.LANDING_GATE === "1" && process.env.LANDING_PUBLIC !== "1";

  // ALWAYS clear a stale gate when we are not deploying one. This is the half
  // that actually fixes the incident: previously the secrets were only deleted
  // when LANDING_PUBLIC=1 was passed, so a demo unlocked once and redeployed
  // later came back locked.
  if (!wantsGate) {
    let removed = false;
    for (const name of ["BASIC_AUTH_PASSWORD", "BASIC_AUTH_USERNAME"]) {
      // clearSecret treats "was not set" as success — it is indistinguishable
      // from a failed delete on every host. The deploy verifies the result over
      // HTTP below rather than trusting this.
      await host.clearSecret(siteDir, draft.workerName, name);
      removed = true;
    }
    if (removed) console.log("[landing] cleared any previous preview gate");
  }

  const basicAuthPassword = wantsGate ? process.env.BASIC_AUTH_PASSWORD : undefined;
  const basicAuthUsername = wantsGate ? process.env.BASIC_AUTH_USERNAME : undefined;
  if (basicAuthPassword) {
    await host.setSecret(siteDir, draft.workerName, "BASIC_AUTH_PASSWORD", basicAuthPassword);
    if (basicAuthUsername) {
      await host.setSecret(siteDir, draft.workerName, "BASIC_AUTH_USERNAME", basicAuthUsername);
    }
  }

  // The worker is live and its secrets are set — nothing below reads the clone's
  // dependencies again. Reclaim the ~470MB install (see pruneSiteDependencies).
  if (pruneSiteDependencies(siteDir)) console.log("[landing] pruned node_modules from the run clone");

  return {
    url: deployed.url,
    workerName: draft.workerName,
    host: host.name,
    hmacSet: !!hmacKey,
    basicAuthSet: !!basicAuthPassword,
  };
}

/**
 * Make a freshly-created workspace's default DRAFT release demo-ready BEFORE
 * publishing: attach the RAG vector (so the chat is grounded) and open anonymous
 * chat (so the demo link works without login). GET-merge-POST so we never drop
 * existing fields. Idempotent. Run on the draft — a published release is locked.
 */
export async function configureDemoRelease(
  workspaceId: string,
  releaseId: string,
  vectorId: string,
): Promise<void> {
  const OAUTH_ENV = { ...process.env };
  delete OAUTH_ENV.DIVINCI_API_KEY;
  const { stdout } = await execFileP(
    "divinci", ["api", "GET", `/white-label/${workspaceId}/release/${releaseId}`, "--no-color"],
    { timeout: 60_000, maxBuffer: 16 * 1024 * 1024, env: OAUTH_ENV },
  );
  const cur = JSON.parse(stdout.slice(stdout.indexOf("{"))) as Record<string, unknown>;
  const keep = [
    "slug", "title", "assistant", "promptModeration", "notificationFlaggers", "deIdentification",
    "threadPrefix", "msgPrefix", "conversationStarter", "chatDisclaimer", "chatWelcomeMessage",
    "chatWelcomeMessageOverrides", "ragVectorGroupId", "rerankMaxChunks", "ragTrigger",
    "ragContextDisplayMode", "hybridSearchConfig", "contextCache", "publicResponseCache",
    "productSubReplies", "aiGateway", "testingDomains", "mcpConfig", "supportedLanguages",
    "outputPipelineId", "productOutputPipelineId", "maxAnonymousChatMessages",
  ];
  const body: Record<string, unknown> = { description: cur.description ?? "" };
  for (const k of keep) if (cur[k] != null) body[k] = cur[k];
  // Attach the demo's RAG vector so answers are grounded + cited.
  body.ragIndexes = [{ id: vectorId }];
  // Open anonymous chat so the demo link works without login (the worker
  // enforces the per-email quota itself). NB: do NOT send freeChatGate here —
  // an object shape the /update schema rejects ("Json at slug does not exist").
  body.allowAnonymousChat = true;
  await execFileP(
    "divinci", ["api", "POST", `/white-label/${workspaceId}/release/${releaseId}/update`, "--body", JSON.stringify(body), "--no-color"],
    { timeout: 120_000, maxBuffer: 16 * 1024 * 1024, env: OAUTH_ENV },
  );
}

/**
 * Lock down a demo release: require signed anonymous chat (so the public release
 * ID can't be used to call the chat API directly, bypassing the worker's quota)
 * and cap daily spend. Call ONLY after the worker is deployed WITH its HMAC
 * secret, or the demo chat will 403. Uses the admin GET-merge-POST update.
 */
export async function hardenDemoRelease(
  workspaceId: string,
  releaseId: string,
  spendCapCentsPerDay = 500,
): Promise<void> {
  // Release admin GET/update needs the CLI's OAuth session (admin) — the
  // demo-pipeline-qa API key is forbidden on these endpoints. Strip the key so
  // `divinci api` falls back to OAuth.
  const OAUTH_ENV = { ...process.env };
  delete OAUTH_ENV.DIVINCI_API_KEY;
  const { stdout } = await execFileP(
    "divinci", ["api", "GET", `/white-label/${workspaceId}/release/${releaseId}`, "--no-color"],
    { timeout: 60_000, maxBuffer: 16 * 1024 * 1024, env: OAUTH_ENV },
  );
  const cur = JSON.parse(stdout.slice(stdout.indexOf("{"))) as Record<string, unknown>;
  const keep = [
    "slug", "title", "allowAnonymousChat", "maxAnonymousChatMessages", "assistant",
    "promptModeration", "notificationFlaggers", "deIdentification", "threadPrefix", "msgPrefix",
    "conversationStarter", "chatDisclaimer", "chatWelcomeMessage", "chatWelcomeMessageOverrides",
    "ragVectorGroupId", "rerankMaxChunks", "ragTrigger", "ragContextDisplayMode", "hybridSearchConfig",
    "contextCache", "publicResponseCache", "productSubReplies", "aiGateway", "testingDomains",
    "mcpConfig", "freeChatGate", "supportedLanguages", "outputPipelineId", "productOutputPipelineId",
    "ttsToolOverride", "ttsVoiceOverride", "ttsConfigOverride", "fallbackAssistants",
  ];
  const body: Record<string, unknown> = { description: cur.description ?? "" };
  for (const k of keep) if (cur[k] != null) body[k] = cur[k];
  if (Array.isArray(cur.ragIndexes)) body.ragIndexes = (cur.ragIndexes as Array<{ id: string }>).map((r) => ({ id: r.id }));
  body.requireSignedAnonymousChat = true;
  body.spendCapCentsPerDay = spendCapCentsPerDay;
  await execFileP(
    "divinci", ["api", "POST", `/white-label/${workspaceId}/release/${releaseId}/update`, "--body", JSON.stringify(body), "--no-color"],
    { timeout: 120_000, maxBuffer: 16 * 1024 * 1024, env: OAUTH_ENV },
  );
}
