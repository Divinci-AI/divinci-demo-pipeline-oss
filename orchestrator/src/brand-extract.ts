/**
 * Brand extractor — pulls a real palette + logo from a prospect's website with
 * headless Chromium (Playwright), so the landing stage skins the template with
 * the customer's actual colors/logo instead of placeholders.
 *
 * Strategy:
 *   - Color: tally computed background/text colors across visible elements,
 *     weighted by on-screen area, plus specific brand signals (header bg,
 *     button bg, link color). Map the dominant non-neutral colors onto the 8
 *     template tokens, deriving shades via HSL math.
 *   - Logo: prefer a header/nav <img>/<svg> tagged "logo", else apple-touch-icon
 *     / favicon, else og:image. Download into the run's brand/ dir.
 *
 * Never throws into the pipeline: callers wrap in try/catch and fall back to the
 * placeholder palette + template logo when extraction fails.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

export interface ExtractedBrand {
  palette: { primary: string; dark: string; mid: string; accent: string; cream: string; soft: string; bubble: string; text: string };
  /** Body font-family stack WITH a guaranteed sans fallback (so it can never
   *  fall through to the UA serif default). */
  fontFamily?: string;
  /** The brand's DISPLAY/heading stack, when it differs from the body font.
   *  Undefined means "no distinct heading face" — the template then falls back
   *  to the body font rather than pinning a duplicate into a second token. */
  displayFontFamily?: string;
  /** The rest of the display treatment, captured from the same element. A
   *  wordmark is a specific CUT, not just a family: AcmePath's is Fraunces
   *  italic 500 at `opsz 24`, which looks nothing like Fraunces upright 400 at
   *  its default `opsz 144`. Each field is undefined when it matches the
   *  browser default and so carries no information. */
  displayFontStyle?: string;
  displayFontWeight?: string;
  displayLetterSpacing?: string;
  displayFontVariationSettings?: string;
  /** Webfont stylesheet URLs to load so the real client font actually renders
   *  (captured from the site + a constructed Google Fonts css2 link). */
  fontLinks?: string[];
  /** filename written into outDir (e.g. "logo.svg"); undefined if none found */
  logoFile?: string;
  /** True when the asset is a square-ish MARK rather than a wordmark, so the
   *  hero must render the brand NAME itself — the logo does not carry it.
   *  Undefined when dimensions were unreadable (keep the wordmark assumption). */
  logoIsMark?: boolean;
  siteName?: string;
  /** True when the logo likely needs darkening on a light bg — inferred from a
   *  DARK site header (a logo built for a dark header is light, and washes out
   *  on the landing's light hero). CORS-safe (no canvas pixel reads). */
  logoIsLight?: boolean;
  /** A real member/patient login URL detected on the site (login/portal/sign-in)
   *  — gates the "Already a patient? Log in" affordance. Undefined = no login. */
  loginUrl?: string;
}

export interface RawColors {
  /** {hex: weightedArea} for background colors */
  bg: Record<string, number>;
  /** {hex: count} for text colors */
  text: Record<string, number>;
  headerBg?: string;
  buttonBg?: string;
  linkColor?: string;
  /**
   * The BODY's own background — the only sound test for a dark design.
   *
   * Not the largest background by area: acmelongevity.com is a cream site
   * whose single biggest painted region is a dark-green hero band (2.25M px²
   * against cream's 2.16M), so area alone calls a light page dark and inverts
   * a design that was already right. Absent on drafts extracted before this
   * field existed, and absence must mean "assume light" — the behaviour those
   * demos already shipped with.
   */
  bodyBg?: string;
  fontFamily?: string;
  display?: DisplayType;
  fontLinks?: string[];
  siteName?: string;
  logoUrl?: string;
  logoSvg?: string;
  loginUrl?: string;
}

const GENERIC_FONTS = new Set(["sans-serif", "serif", "monospace", "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace", "-apple-system", "blinkmacsystemfont", "cursive", "fantasy", "inherit", "initial", "unset"]);

/**
 * Fonts that ship with the OS and are NOT on Google Fonts.
 *
 * Requesting one returns **403 Forbidden**, not 404 — Google rejects an
 * unknown family rather than 404ing it — and the request is a render-blocking
 * <link rel="stylesheet"> in <head>, so it is not free: it costs a DNS +
 * TLS + round trip to fail, on every page load, and fills the console with
 * errors that make a demo look broken to anyone who opens devtools.
 *
 * Acme Renew extracted `Times` for body and `Georgia` for display — both web-safe
 * since the 1990s, neither hosted by Google — and shipped two 403s.
 *
 * These need no loading at all: the family is already on the visitor's machine.
 */
const SYSTEM_FONTS = new Set([
  "georgia", "times", "times new roman", "arial", "arial black", "helvetica",
  "helvetica neue", "courier", "courier new", "verdana", "tahoma",
  "trebuchet ms", "palatino", "palatino linotype", "book antiqua", "garamond",
  "bookman", "bookman old style", "comic sans ms", "impact", "lucida grande",
  "lucida sans", "lucida sans unicode", "lucida console", "geneva", "monaco",
  "segoe ui", "san francisco", "sf pro text", "sf pro display", "menlo",
  "consolas", "cambria", "calibri", "candara", "constantia", "corbel",
  "franklin gothic medium", "gill sans", "century gothic", "optima", "futura",
  "avenir", "avenir next", "didot", "baskerville", "american typewriter",
  "andale mono", "copperplate", "papyrus", "brush script mt", "ms sans serif",
]);

/**
 * Families a page LOADS from Google Fonts, best first.
 *
 * A site's own `<link>` is a stronger statement of intent than a computed
 * `font-family` read off whichever element the extractor happened to sample.
 */
export function loadedGoogleFamilies(links: string[] | undefined): string[] {
  const out: string[] = [];
  for (const href of links ?? []) {
    if (!/fonts\.googleapis\.com\/css/.test(href)) continue;
    let u: URL;
    try { u = new URL(href); } catch { continue; }
    for (const raw of u.searchParams.getAll("family")) {
      for (const part of raw.split("|")) {
        const fam = part.split(":")[0].replace(/\+/g, " ").trim();
        if (fam && !out.includes(fam)) out.push(fam);
      }
    }
  }
  return out;
}

/**
 * Correct a SYSTEM-font reading against what the site actually loads.
 *
 * Acme Renew's demo shipped in Times/Georgia while acmerenew.com is set in
 * **Inter** — its CSS drives everything off `--headlinefont: 'Inter'` and
 * `--contentfont: 'Inter'`, and the page loads Inter + Montserrat from Google.
 * The extractor sampled an element carrying one of the theme's four
 * `font-family:Georgia,serif` rules and took that as the brand face, so the
 * demo read as a serif site next to a customer's clean sans.
 *
 * The asymmetry is the point: concluding a SYSTEM font while the page is
 * paying to download a webfont is almost always a mis-sample, because nobody
 * loads Inter in order to set their body copy in Georgia. The reverse is not
 * true — a site may legitimately load a webfont for headings only — so this
 * only ever replaces a system reading, never a webfont one.
 */
export function preferLoadedWebfont(family: string | undefined, links: string[] | undefined): string | undefined {
  const first = (family || "").split(",")[0].replace(/["']/g, "").trim();
  if (first && !isSystemFont(first)) return family;
  const loaded = loadedGoogleFamilies(links);
  return loaded.length ? loaded[0] : family;
}

/** Is this family already on the visitor's machine (so never worth fetching)? */
export function isSystemFont(family: string): boolean {
  return SYSTEM_FONTS.has(family.replace(/["']/g, "").trim().toLowerCase());
}

/** Ensure a font stack ends in a generic sans fallback — so an unloaded/missing
 *  family never falls through to the browser's serif default (the bug that made
 *  the "AI" lockup + headings render serif). */
export function withSansFallback(family?: string): string {
  const fam = (family || "").trim().replace(/;$/, "");
  if (!fam) return "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
  if (/\b(sans-serif|system-ui|ui-sans-serif|monospace)\b/i.test(fam)) return fam;
  return `${fam}, ui-sans-serif, system-ui, sans-serif`;
}

/** The display treatment read off the brand's own wordmark element. */
export interface DisplayType {
  family: string;
  style?: string;
  weight?: string;
  letterSpacing?: string;
  variationSettings?: string;
}

/**
 * Google Fonts URLs for a display family, best first.
 *
 * The plain `wght@400;600;700` form serves STATIC instances at the family's
 * default optical size. For Fraunces that default is `opsz 144` — the
 * high-contrast display cut — so a page asking for `opsz 24` silently gets the
 * wrong one, and a page asking for italic gets a synthesised oblique. The
 * result is recognisably not the brand's wordmark while being, technically, the
 * right family.
 *
 * A range request (`wght@400..700`) serves the VARIABLE font instead, which is
 * what makes `font-variation-settings` and real italics work. Ranges are
 * validated against the actual font by Google, so a family without `opsz` 400s
 * on the first candidate — hence a list to try in order rather than one guess.
 */
export function googleFontsCandidates(family?: string, opts: { italic?: boolean; opsz?: boolean } = {}): string[] {
  const first = (family || "").split(",")[0].replace(/["']/g, "").trim();
  if (!first || GENERIC_FONTS.has(first.toLowerCase())) return [];
  if (isSystemFont(first)) return [];
  const name = first.replace(/\s+/g, "+");
  const url = (spec: string) => `https://fonts.googleapis.com/css2?family=${name}:${spec}&display=swap`;
  const out: string[] = [];
  if (opts.opsz && opts.italic) out.push(url("ital,opsz,wght@0,9..144,400..700;1,9..144,400..700"));
  if (opts.opsz) out.push(url("opsz,wght@9..144,400..700"));
  if (opts.italic) out.push(url("ital,wght@0,400..700;1,400..700"));
  out.push(url("wght@400..700"));
  // Last resort: the original static form. Always valid, never variable.
  out.push(url("wght@400;600;700"));
  return out;
}

/**
 * The brand's name with the AI suffix, without doubling one it already has.
 *
 * `${org} AI` is right for "Acme Realty" and wrong for "AcmePath AI", which the
 * extractor reads straight off og:site_name — that produced the product name
 * "AcmePath AI AI", carried into copy prompts, the chat byline and the example
 * transcript.
 *
 * Matches only a trailing word, so "Xenon AI Labs" is left alone: the suffix is
 * being appended at the END, so that is the only position that can duplicate.
 */
/**
 * Is this asset a MARK (a square-ish glyph) rather than a WORDMARK?
 *
 * The hero lockup renders `[logo] AI` and relies on the logo carrying the
 * brand's NAME. That holds for a wordmark and fails completely for a mark: the
 * extractor's fallback chain ends at apple-touch-icon / og:image, which are
 * square app icons, so AcmePath's hero read "⟨A⟩ AI" with the word "AcmePath"
 * nowhere on it.
 *
 * Aspect ratio is the signal — a wordmark is wide because it contains a word.
 * The 1.6 threshold sits well clear of both cases in practice (app icons are
 * 1.0; wordmarks here run 3:1 to 6:1) and errs toward "wordmark", which is the
 * safe direction: mislabelling a wordmark as a mark would print the name twice,
 * while the reverse merely preserves today's behaviour.
 *
 * Returns undefined when the dimensions cannot be read, so the caller keeps the
 * existing wordmark assumption rather than guessing from a failed parse.
 *
 * ⚠️ The format is SNIFFED from the bytes, never taken from the extension.
 * Acme Renew's logo URL ended `.png` and an image-optimising CDN served WebP; the
 * file landed on disk as `logo.png`, `pngDimensions` found no IHDR, this
 * returned undefined, and the hero rendered their circular clinic icon beside
 * "AI" with the brand name nowhere on the page. An extension is a claim about
 * a file; the magic bytes are the file.
 */
export type ImageFormat = "svg" | "png" | "webp" | "jpeg" | "gif" | "unknown";

export function sniffImageFormat(buf: Buffer): ImageFormat {
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  if (buf.length >= 8 && buf.toString("binary", 0, 8) === "\x89PNG\r\n\x1a\n") return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 6 && buf.toString("ascii", 0, 4) === "GIF8") return "gif";
  // SVG is text and may open with a comment, an XML declaration or a doctype,
  // so sniff for the tag rather than requiring it at offset 0.
  const head = buf.toString("utf8", 0, Math.min(buf.length, 1024));
  if (/<svg[\s>]/i.test(head)) return "svg";
  return "unknown";
}

export function imageDimensions(buf: Buffer): { w: number; h: number } | undefined {
  switch (sniffImageFormat(buf)) {
    case "svg": return svgDimensions(buf.toString("utf8"));
    case "png": return pngDimensions(buf);
    case "webp": return webpDimensions(buf);
    case "jpeg": return jpegDimensions(buf);
    case "gif": return gifDimensions(buf);
    default: return undefined;
  }
}

export function logoIsMark(buf: Buffer, _ext?: string): boolean | undefined {
  const dims = imageDimensions(buf);
  if (!dims || dims.h <= 0 || dims.w <= 0) return undefined;
  return dims.w / dims.h < 1.6;
}

function pngDimensions(buf: Buffer): { w: number; h: number } | undefined {
  // IHDR is always the first chunk: 8-byte signature, 4-byte length, "IHDR",
  // then width and height as big-endian uint32.
  if (buf.length < 24 || buf.toString("ascii", 12, 16) !== "IHDR") return undefined;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/**
 * WebP carries its canvas size in one of three chunk layouts. All three are
 * little-endian and none of them is at a fixed offset across variants, which
 * is why "it's a RIFF, read offset 24" is not enough.
 */
function webpDimensions(buf: Buffer): { w: number; h: number } | undefined {
  if (buf.length < 30) return undefined;
  const chunk = buf.toString("ascii", 12, 16);
  if (chunk === "VP8X") {
    // Extended: 24-bit canvas width-1 and height-1 at 24 and 27.
    const w = buf.readUIntLE(24, 3) + 1;
    const h = buf.readUIntLE(27, 3) + 1;
    return { w, h };
  }
  if (chunk === "VP8 ") {
    // Lossy: keyframe start code 9d 01 2a, then 14-bit width and height.
    if (!(buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a)) return undefined;
    return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    // Lossless: 0x2f signature, then 14 bits width-1 and 14 bits height-1
    // packed across the next four bytes.
    if (buf[20] !== 0x2f) return undefined;
    const bits = buf.readUInt32LE(21);
    return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
  }
  return undefined;
}

function jpegDimensions(buf: Buffer): { w: number; h: number } | undefined {
  // Walk the marker segments to the frame header. Height precedes width.
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    // SOF0-3, SOF5-7, SOF9-11, SOF13-15 carry the frame size. C4/C8/CC do not
    // (Huffman table, reserved, arithmetic-coding conditioning).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return undefined;
}

function gifDimensions(buf: Buffer): { w: number; h: number } | undefined {
  if (buf.length < 10) return undefined;
  return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
}

function svgDimensions(src: string): { w: number; h: number } | undefined {
  // viewBox first: width/height are often "100%" or absent on a responsive SVG,
  // whereas viewBox always carries the true intrinsic aspect.
  const vb = src.match(/viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  if (vb) return { w: parseFloat(vb[1]), h: parseFloat(vb[2]) };
  const w = src.match(/\bwidth\s*=\s*["']([\d.]+)/i);
  const h = src.match(/\bheight\s*=\s*["']([\d.]+)/i);
  if (w && h) return { w: parseFloat(w[1]), h: parseFloat(h[1]) };
  return undefined;
}

export function aiProductName(org: string): string {
  return /\bai\s*$/i.test(org.trim()) ? org.trim() : `${org.trim()} AI`;
}

/**
 * The brand name to show BESIDE a separately-rendered "AI" — i.e. with a
 * trailing "AI" removed. Inverse of `aiProductName`.
 *
 * The hero lockup draws "AI" as its own styled element, so rendering the full
 * site name next to it reads "AcmePath AI AI" on screen for exactly the brands
 * whose name already carries the suffix.
 */
export function brandNameWithoutAiSuffix(org: string): string {
  return org.trim().replace(/\s*\bai\s*$/i, "").trim() || org.trim();
}

/**
 * Ensure a DISPLAY font stack ends in a generic — without assuming which one.
 *
 * `withSansFallback` is right for body copy, where falling through to the UA
 * serif is the failure. It is wrong here: a display stack is often deliberately
 * a serif (AcmePath's headings are `Fraunces, Tiempos, Charter, Georgia,
 * serif`), and appending a sans fallback to it says "if every serif is missing,
 * use a grotesque" — the opposite of what the brand chose.
 *
 * So an existing generic of ANY kind is preserved untouched, and only a stack
 * with none gets `sans-serif` appended, which is the safe default when the
 * intent is genuinely unknown.
 */
export function withGenericFallback(family?: string): string | undefined {
  const fam = (family || "").trim().replace(/;$/, "");
  if (!fam) return undefined;
  if (/\b(sans-serif|serif|monospace|cursive|fantasy|system-ui|ui-sans-serif|ui-serif|ui-monospace)\b/i.test(fam)) return fam;
  return `${fam}, sans-serif`;
}

/** Build a Google Fonts css2 URL for the PRIMARY family in a stack (covers the
 *  common case — most clinic sites use Google fonts). Returns null for generic
 *  AND for system families.
 *
 *  ⚠️ This used to say "unknown families just 404 the link harmlessly". Both
 *  halves were wrong: Google answers an unknown family with **403**, and a
 *  render-blocking stylesheet that fails is not harmless. */
export function googleFontsUrl(family?: string): string | null {
  const first = (family || "").split(",")[0].replace(/["']/g, "").trim();
  if (!first || GENERIC_FONTS.has(first.toLowerCase())) return null;
  // A system font is already on the machine; asking Google for it returns 403.
  if (isSystemFont(first)) return null;
  return `https://fonts.googleapis.com/css2?family=${first.replace(/\s+/g, "+")}:wght@400;600;700&display=swap`;
}

// ---------------------------------------------------------------- color math

function toHex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0")).join("");
}
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  return [h * 360, s, l];
}
export function hslToHex(h: number, s: number, l: number): string {
  h /= 360;
  const hue = (p: number, q: number, t: number) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  let r: number, g: number, b: number;
  if (s === 0) { r = g = b = l; }
  else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue(p, q, h + 1 / 3); g = hue(p, q, h); b = hue(p, q, h - 1 / 3);
  }
  return toHex(r * 255, g * 255, b * 255);
}
export const lum = (hex: string) => { const [r, g, b] = hexToRgb(hex); return (0.299 * r + 0.587 * g + 0.114 * b) / 255; };
export const sat = (hex: string) => rgbToHsl(...hexToRgb(hex))[1];
const withL = (hex: string, l: number) => { const [h, s] = rgbToHsl(...hexToRgb(hex)); return hslToHex(h, s, l); };

/**
 * Colors the USER-AGENT paints when the site styled nothing. An unstyled link
 * is evidence of the ABSENCE of a brand color, so treating one as a brand
 * color is strictly worse than having no candidate at all — the fallback is at
 * least neutral, whereas #0000ee is a loud blue that appears nowhere on the
 * site. acmelongevity.com styles its footer links not at all; that single
 * element became the demo's accent, and every citation chip and assistant
 * bubble on a green-and-gold clinic site rendered purple.
 */
const UA_DEFAULT_COLORS = new Set(["#0000ee", "#0000ff", "#551a8b", "#800080"]);
const isBrandable = (h: unknown): h is string =>
  typeof h === "string" && /^#[0-9a-f]{6}$/i.test(h) && !UA_DEFAULT_COLORS.has(h.toLowerCase());

/**
 * Below this relative luminance the page needs LIGHT ink, which is what "dark
 * brand" has to mean for the mapping below to decide anything.
 *
 * Derived, not chosen: white text clears WCAG AA (4.5:1) on a background of
 * luminance L while (1.0 + 0.05) / (L + 0.05) >= 4.5, i.e. L <= 0.1833.
 *
 * MUST equal DARK_BRAND_MAX_LUM in the template's src/lib/contrast.ts. This
 * side picks which token mapping to emit; that side picks which surfaces to
 * paint. Disagreement puts light text on a light page.
 */
export const DARK_PAGE_MAX_LUM = 0.1833;

/** Map tallied colors → the 8 template tokens. */
export function buildPalette(raw: RawColors): ExtractedBrand["palette"] {
  const bgSorted = Object.entries(raw.bg).sort((a, b) => b[1] - a[1]).map(([h]) => h);
  // Brand colors = saturated, mid-range lightness, not near-white/black.
  const brandy = (h: string) => sat(h) > 0.18 && lum(h) > 0.06 && lum(h) < 0.92;
  // `primary` is the STRUCTURAL brand color (the template maps it to the dark
  // chrome). A button is an accent by definition, so it seeds `accent` and is
  // only a last resort here — otherwise a gold CTA on a dark-green site
  // becomes the site's base color and the actual base is never used at all.
  const primaryCands = [raw.headerBg, ...bgSorted, raw.buttonBg].filter(isBrandable).filter(brandy);
  const accentCands = [raw.buttonBg, raw.linkColor, ...primaryCands].filter(isBrandable).filter(brandy);

  const primary = primaryCands[0] ?? "#2d3748";
  const accent = accentCands.sort((a, b) => sat(b) - sat(a))[0] ?? primary;
  // The page background is the light color covering the most AREA — not the
  // lightest one found. A site whose body is #f5f0e8 still paints white cards
  // on top of it, and picking the whitest turns a warm cream site stark.
  const lightest = bgSorted.filter((h) => lum(h) > 0.9)[0] ?? "#f7fafc";
  // Likewise body text is the most-USED dark color, not the darkest. #000000
  // appearing on eight elements must not outrank #2c2c2c on five hundred.
  const textCands = Object.entries(raw.text)
    .filter(([h]) => /^#[0-9a-f]{6}$/i.test(h) && lum(h) < 0.4)
    .sort((a, b) => b[1] - a[1])
    .map(([h]) => h);
  const text = textCands[0] ?? "#1a1a1a";

  const primaryL = rgbToHsl(...hexToRgb(primary))[2];

  // A DARK BRAND is not a light brand with unusual colors.
  //
  // Every token below assumed the page is light: `cream` is defined as the
  // lightest background and `text` as the darkest ink. On a site that has no
  // light background and no dark ink, BOTH fall through to their fallbacks and
  // the result inverts the brand. acmecyber.com — body #04090e,
  // panels #091219, cyan #00d4ff, ink #ddeeff — came back as a WHITE page
  // whose text color was #04090e, i.e. the site's own background used as ink.
  //
  // The BODY background decides — see RawColors.bodyBg for why area does not.
  if (raw.bodyBg && isBrandable(raw.bodyBg) && lum(raw.bodyBg) < DARK_PAGE_MAX_LUM) {
    const page = raw.bodyBg;
    const inkCands = Object.entries(raw.text)
      .filter(([h]) => /^#[0-9a-f]{6}$/i.test(h) && lum(h) > 0.6)
      .sort((a, b) => b[1] - a[1])
      .map(([h]) => h);
    const pageL = rgbToHsl(...hexToRgb(page))[2];
    return {
      // The header chrome is the page's own near-black, not a tint of a
      // saturated brand color.
      primary: isBrandable(raw.headerBg) ? raw.headerBg : page,
      // `dark`/`mid` carry the SOLID buttons and starter chips. Deriving them
      // from `primary` is right on a light page — a dark slab against cream —
      // and produces #10202d on #091219 here: a chip you cannot see. On a dark
      // page the accent is the only token with contrast to spend, so they are
      // shades of IT instead.
      dark: withL(accent, 0.38),
      mid: withL(accent, 0.5),
      accent,
      // `cream` is the PAGE, whatever its lightness. The name is a lie on this
      // path; renaming it would touch every template call site, and a wrong
      // color is a worse bug than a stale name.
      cream: page,
      // Panels sit slightly ABOVE the page on a dark design and slightly below
      // on a light one — the direction flips with the theme.
      soft: withL(page, Math.min(0.22, pageL + 0.05)),
      // The user bubble is a dark tint of the accent, not a pale wash: at
      // lightness 0.9 it is a near-white slab on a near-black page.
      bubble: withL(accent, Math.min(0.3, pageL + 0.14)),
      text: inkCands[0] ?? "#e8eef5",
    };
  }

  return {
    primary,
    dark: withL(primary, Math.max(0.12, primaryL - 0.18)),
    mid: withL(primary, Math.min(0.6, primaryL + 0.12)),
    accent,
    // A warm off-white IS the brand's page color. The old `> 0.96` cutoff
    // replaced #f5f0e8 (0.94) with a generic blue-grey, so a cream site came
    // back cooler than the site it was extracted from.
    cream: lum(lightest) > 0.9 ? lightest : "#f7fafc",
    soft: withL(lightest, Math.max(0.9, lum(lightest) - 0.04)),
    bubble: withL(accent, 0.9),
    text,
  };
}

// ---------------------------------------------------------------- extraction

/**
 * Is this inline <svg> usable as a standalone logo file?
 *
 * The selector takes the first <svg> inside header/nav/[class*=logo], which on
 * a real site is often a decorative UI glyph rather than the brand mark. What
 * acmehealthmd.com yielded, verbatim:
 *
 *   <svg class="open" width="24" height="24" aria-hidden="true" role="img"
 *        focusable="false"><use href="#utility-plus"></use></svg>
 *
 * 127 bytes. It is a 24x24 "plus" icon whose <use> points at a sprite symbol
 * defined elsewhere in the page — so written to its own file it references an
 * id that does not exist and renders NOTHING. It then serves perfectly: HTTP
 * 200, image/svg+xml, correct bytes. Only measuring the painted result catches
 * it, which is what preflight did after the demo had already been built.
 *
 * Rejecting it here falls through to logoUrl / apple-touch-icon, which is a
 * real image. No logo at all is better than a blank one.
 */
export function usableInlineSvg(svg: string): boolean {
  // Decorative by the author's own declaration — never the brand mark.
  if (/aria-hidden\s*=\s*["']true["']/i.test(svg)) return false;
  // A <use href="#id"> is only meaningful alongside the sprite that defines
  // that symbol. Standalone it is an empty box. (An inline <symbol>/<defs> in
  // the same string is self-contained and fine.)
  if (/<use\b[^>]*(href|xlink:href)\s*=\s*["']#/i.test(svg) && !/<symbol\b|<defs\b/i.test(svg)) return false;
  // Icon-sized. A logo rendered at 24px square is an icon, whatever it depicts.
  const w = Number(svg.match(/\bwidth\s*=\s*["'](\d+)/i)?.[1] ?? 0);
  const h = Number(svg.match(/\bheight\s*=\s*["'](\d+)/i)?.[1] ?? 0);
  if (w && h && w <= 32 && h <= 32) return false;
  // Nothing to draw: no shape, path, text or image element.
  if (!/<(path|rect|circle|ellipse|polygon|polyline|line|text|image|use)\b/i.test(svg)) return false;
  // Painted only by the page's stylesheet. `fill="none"` with no stroke
  // ANYWHERE is an outline mark whose stroke colour comes from CSS — inline in
  // the document that CSS applies, and in a standalone file loaded through
  // <img> it does not, so the shape is drawn with no fill and no stroke and
  // paints nothing. Same class as the <use> case above: markup that is only
  // meaningful in the context it was lifted from.
  //
  // Checked on the whole string, not the root tag, because a single
  // stroke/fill on any child is enough to make the mark visible — acmezone's had
  // exactly one (`<circle fill="currentColor">`), which is why it rendered as
  // a lone dot rather than nothing at all.
  //
  // `currentColor` does NOT count as paint here. It means "whatever colour the
  // surrounding text is", which is the same context dependency in another
  // form: standalone it falls back to the initial black rather than the
  // brand's. acmezone's mark was exactly this — every stroke from CSS plus one
  // `<circle fill="currentColor">` — so it would have rendered as a lone 1.2px
  // black dot in a 16px box. Loadable, and still not a logo.
  if (/\bfill\s*=\s*["']none["']/i.test(svg) && !/\bstroke\s*=\s*["'](?!none)/i.test(svg)) {
    const painted = /\bfill\s*=\s*["'](?!none|currentcolor)[^"']+["']/i.test(
      svg.replace(/^[^>]*>/, ""), // ignore the root tag's own fill="none"
    );
    if (!painted) return false;
  }
  return true;
}

/**
 * Make an extracted inline <svg> survive on its own.
 *
 * An inline SVG inherits the SVG namespace from the HTML parser, so real sites
 * routinely omit `xmlns` and render perfectly. Write those exact bytes to a
 * .svg file and serve it as image/svg+xml and it is no longer HTML — it is
 * parsed as XML, where the namespace is REQUIRED. The browser cannot decode
 * it, so `<img>` reports naturalWidth 0 with complete true.
 *
 * That is what acmezone's logo did on 2026-08-14: HTTP 200, image/svg+xml, 316
 * correct bytes, and ten "image never loaded" defects. Serving the right file
 * and serving a loadable file are different things, and only the second is
 * visible to a browser.
 *
 * Injected rather than rejected: unlike the sprite-<use> case there is nothing
 * wrong with the artwork, only with markup that was legal in its old context.
 */
export function normalizeExtractedSvg(svg: string): string {
  if (/\bxmlns\s*=/i.test(svg)) return svg;
  return svg.replace(/^(\s*<svg\b)/i, '$1 xmlns="http://www.w3.org/2000/svg"');
}

export async function extractBrand(url: string, outDir: string): Promise<ExtractedBrand> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(url, { waitUntil: "networkidle", timeout: 45_000 }).catch(() => page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }));

    // NOTE: passed as a STRING, not a function — tsx/esbuild's keepNames adds a
    // `__name` helper to named function expressions that isn't defined in the
    // browser context (ReferenceError: __name is not defined). A string body is
    // sent verbatim and runs cleanly in-page.
    const BROWSER_SCRIPT = `(() => {
      function parse(c) {
        var m = c.match(/rgba?\\(([^)]+)\\)/);
        if (!m) return null;
        var p = m[1].split(",").map(function (x) { return parseFloat(x); });
        var r = p[0], g = p[1], b = p[2], a = p[3];
        if (a !== undefined && a < 0.5) return null;
        function hx(n) { return Math.round(n).toString(16).padStart(2, "0"); }
        return "#" + hx(r) + hx(g) + hx(b);
      }
      var bg = {}, text = {};
      var els = Array.prototype.slice.call(document.querySelectorAll("body *"), 0, 4000);
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        var rect = el.getBoundingClientRect();
        var area = Math.max(0, rect.width) * Math.max(0, rect.height);
        if (area < 100) continue;
        var cs = getComputedStyle(el);
        var b = parse(cs.backgroundColor);
        if (b) bg[b] = (bg[b] || 0) + area;
        var t = parse(cs.color);
        if (t && el.textContent && el.textContent.trim().length > 2) text[t] = (text[t] || 0) + 1;
      }
      var header = document.querySelector("header, [role=banner], nav");
      var btn = document.querySelector("button, a[class*=btn], a[class*=button], [class*=cta]");
      var link = document.querySelector("a[href]");
      var siteNameEl = document.querySelector('meta[property="og:site_name"]');
      var siteName = (siteNameEl && siteNameEl.content) || document.title;
      var logoUrl, logoSvg;
      var img = document.querySelector("header img, nav img, [class*=logo] img, img[class*=logo], img[alt*=logo i], img[src*=logo i], a[href='/'] img");
      if (img && img.src) logoUrl = img.src;
      if (!logoUrl) { var svg = document.querySelector("header svg, nav svg, [class*=logo] svg"); if (svg) logoSvg = svg.outerHTML; }
      if (!logoUrl && !logoSvg) { var icon = document.querySelector("link[rel='apple-touch-icon'], link[rel~='icon']"); if (icon && icon.href) logoUrl = icon.href; }
      if (!logoUrl && !logoSvg) { var og = document.querySelector('meta[property="og:image"]'); if (og && og.content) logoUrl = og.content; }
      return {
        bg: bg, text: text,
        // The body's own background — the dark-design test. Falls back to the
        // documentElement, since a page may paint the background on <html>.
        bodyBg: parse(getComputedStyle(document.body).backgroundColor)
          || parse(getComputedStyle(document.documentElement).backgroundColor) || undefined,
        headerBg: header ? (parse(getComputedStyle(header).backgroundColor) || undefined) : undefined,
        buttonBg: btn ? (parse(getComputedStyle(btn).backgroundColor) || undefined) : undefined,
        linkColor: link ? (parse(getComputedStyle(link).color) || undefined) : undefined,
        fontFamily: getComputedStyle(document.body).fontFamily,
        // The DISPLAY face, read off a real heading rather than the body.
        // Reported only when it actually differs, so "no distinct heading font"
        // is expressible and the template can fall back rather than pinning the
        // body face into a second token.
        //
        // Prefers the header's own brand text (the wordmark) over an h1: that
        // is the face the "AI" glyphs sit beside. AcmePath sets IBM Plex Sans
        // on body and Fraunces on its header, and reading only the body put a
        // heavy grotesque next to a serif logo.
        display: (function () {
          var body = getComputedStyle(document.body).fontFamily;
          var cands = [];
          var hdr = document.querySelector("header, [role=banner], nav");
          if (hdr) {
            var brandEl = hdr.querySelector("a[href='/'] span, a[href='#top'] span, [class*=logo] span, [class*=brand] span, a[href='/'], [class*=logo], [class*=brand]");
            if (brandEl) cands.push(brandEl);
          }
          var h = document.querySelector("h1, h2");
          if (h) cands.push(h);
          for (var c = 0; c < cands.length; c++) {
            var cs = getComputedStyle(cands[c]);
            // Only trust an element with visible text of its own; an empty
            // wrapper inherits the body face and would read as "no difference".
            var txt = (cands[c].textContent || "").trim();
            if (cs.fontFamily && cs.fontFamily !== body && txt.length > 0) {
              // The whole treatment, not just the family. A brand's wordmark is
              // a specific CUT — AcmePath's is Fraunces italic 500 at optical
              // size 24, which looks nothing like Fraunces upright 400 at its
              // default opsz 144 (the high-contrast display cut).
              return {
                family: cs.fontFamily,
                style: cs.fontStyle,
                weight: cs.fontWeight,
                letterSpacing: cs.letterSpacing,
                variationSettings: cs.fontVariationSettings,
              };
            }
          }
          return undefined;
        })(),
        fontLinks: Array.prototype.slice.call(document.querySelectorAll('link[href]'))
          .map(function (l) { return l.href; })
          .filter(function (h) { return h.indexOf('fonts.googleapis.com/css') > -1 || h.indexOf('use.typekit.net') > -1 || h.indexOf('fast.fonts.net') > -1; }),
        siteName: siteName,
        logoUrl: logoUrl,
        logoSvg: logoSvg,
        loginUrl: (function () {
          var a = document.querySelector("a[href*='login' i],a[href*='signin' i],a[href*='sign-in' i],a[href*='portal' i],a[href*='mychart' i]");
          if (a && a.href) return a.href;
          var links = document.querySelectorAll('a[href]');
          for (var k = 0; k < links.length; k++) {
            var t = (links[k].textContent || '').toLowerCase().trim();
            if (t === 'log in' || t === 'login' || t === 'sign in' || t === 'patient portal' || t === 'member login' || t === 'patient login') return links[k].href;
          }
          return undefined;
        })(),
      };
    })()`;
    const raw = (await page.evaluate(BROWSER_SCRIPT)) as RawColors;

    // Download / write the logo.
    let logoFile: string | undefined;
    let isMark: boolean | undefined;
    if (raw.logoSvg && usableInlineSvg(raw.logoSvg)) {
      // Normalize BEFORE writing: the file on disk is what gets served, and
      // an inline SVG's markup is not automatically valid standalone.
      const svg = normalizeExtractedSvg(raw.logoSvg);
      writeFileSync(join(outDir, "logo.svg"), svg);
      logoFile = "logo.svg";
      isMark = logoIsMark(Buffer.from(svg, "utf8"), "svg");
    } else if (raw.logoUrl) {
      try {
        const resp = await page.context().request.get(raw.logoUrl, { timeout: 20_000 });
        if (resp.ok()) {
          const buf = await resp.body();
          // Name the file after what it IS, not what the URL or the
          // Content-Type claims. Acme Renew's logo URL ended `.png` and the CDN
          // served WebP; naming it `logo.png` made the dimension read fail
          // silently, so the square clinic mark was rendered as if it were a
          // wordmark. Browsers sniff, so the extension only ever misleads US.
          const sniffed = sniffImageFormat(buf);
          const ct = resp.headers()["content-type"] ?? "";
          const ext = sniffed !== "unknown"
            ? sniffed
            : ct.includes("svg") || raw.logoUrl.endsWith(".svg") ? "svg"
            : ct.includes("png") || raw.logoUrl.endsWith(".png") ? "png"
            : ct.includes("webp") ? "webp" : "img";
          writeFileSync(join(outDir, `logo.${ext}`), buf);
          logoFile = `logo.${ext}`;
          isMark = logoIsMark(buf);
        }
      } catch { /* logo download best-effort */ }
    }

    /**
     * MEASURE the logo's own ink, don't infer it from the header background.
     *
     * This was `raw.headerBg ? lum(raw.headerBg) < 0.4 : false` — "if their
     * header is dark, their logo is probably light". A reasonable proxy that
     * defaults to FALSE when headerBg is missing, i.e. assumes a dark logo.
     *
     * Acme Security's extraction ran against /about/ (its homepage was excluded for
     * spam), found no headerBg, and fell to that default for a WHITE wordmark.
     * The template then placed it on the page's cream background at a contrast
     * ratio of 1.12:1 — invisible — and the vision review passed the page.
     *
     * The logo's lightness is a property of the logo, so read it off the logo:
     * average the non-transparent pixels in-page via canvas. The header proxy
     * stays as the fallback for when the pixels cannot be read (a tainted
     * canvas, a mark that fails to load).
     */
    let logoIsLight = raw.headerBg ? lum(raw.headerBg) < 0.4 : false;
    if (raw.logoUrl || raw.logoSvg) {
      try {
        const measured = (await page.evaluate(`(async (src) => {
          const img = new Image();
          img.crossOrigin = "anonymous";
          img.src = src;
          await img.decode().catch(() => {});
          if (!img.naturalWidth) return null;
          const c = document.createElement("canvas");
          c.width = Math.min(img.naturalWidth, 256);
          c.height = Math.max(1, Math.round(c.width * img.naturalHeight / img.naturalWidth));
          const x = c.getContext("2d");
          x.drawImage(img, 0, 0, c.width, c.height);
          let d; try { d = x.getImageData(0,0,c.width,c.height).data; } catch (e) { return null; }
          let r=0,g=0,b=0,n=0;
          for (let i=0;i<d.length;i+=4) { if (d[i+3] < 32) continue; r+=d[i]; g+=d[i+1]; b+=d[i+2]; n++; }
          if (!n) return null;
          const f=(v)=>{v=v/n/255; return v<=0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055,2.4)};
          return 0.2126*f(r) + 0.7152*f(g) + 0.0722*f(b);
        })(${JSON.stringify(raw.logoUrl ?? "")})`)) as number | null;
        // 0.5 relative luminance: comfortably above mid-grey, so only a
        // genuinely light mark trips it. A dark or mid-tone logo keeps the
        // old behaviour.
        if (measured !== null) logoIsLight = measured > 0.5;
      } catch {
        /* measurement is best-effort — keep the header-background inference */
      }
    }
    const disp = raw.display;
    // Same correction as the body face: a system-font reading on a page that
    // loads a webfont is a mis-sample. Acme Renew's heading face read "Georgia"
    // against a site whose --headlinefont is 'Inter'.
    const displayFontFamily = withGenericFallback(preferLoadedWebfont(disp?.family, raw.fontLinks));

    // Load the display family too. Without its stylesheet the stack resolves to
    // the fallback and the wordmark silently renders in Georgia — which looks
    // like a styling bug rather than a missing webfont.
    //
    // Probe the candidates in order and keep the first that actually serves:
    // the richest form is not valid for every family, and an unvalidated guess
    // fails as a 404 the browser never reports.
    let displayLink: string | undefined;
    for (const cand of googleFontsCandidates(disp?.family, {
      italic: (disp?.style ?? "").includes("italic"),
      opsz: (disp?.variationSettings ?? "").includes("opsz"),
    })) {
      try {
        const r = await page.context().request.get(cand, { timeout: 10_000 });
        if (r.ok()) { displayLink = cand; break; }
      } catch { /* try the next candidate */ }
    }

    // A system-font reading is corrected against the fonts the page LOADS —
    // see preferLoadedWebfont. Done before the links are built so the
    // constructed URL matches the family we actually ship.
    const bodyFamily = preferLoadedWebfont(raw.fontFamily, raw.fontLinks);
    const constructed = [googleFontsUrl(bodyFamily), displayLink].filter((u): u is string => Boolean(u));
    const fontLinks = Array.from(new Set([...constructed, ...(raw.fontLinks ?? [])]));

    // Drop values that merely restate the browser default — carrying "normal"
    // and "400" through to the template would override a future default with a
    // value nobody chose.
    const meaningful = (v: string | undefined, ...defaults: string[]) =>
      v && !defaults.includes(v.trim()) ? v.trim() : undefined;
    return {
      palette: buildPalette(raw),
      fontFamily: withSansFallback(bodyFamily),
      displayFontFamily,
      displayFontStyle: meaningful(disp?.style, "normal"),
      displayFontWeight: meaningful(disp?.weight, "400", "normal"),
      displayLetterSpacing: meaningful(disp?.letterSpacing, "normal", "0px"),
      displayFontVariationSettings: meaningful(disp?.variationSettings, "normal", "none"),
      fontLinks,
      logoIsMark: isMark,
      logoFile,
      siteName: raw.siteName,
      logoIsLight,
      loginUrl: raw.loginUrl,
    };
  } finally {
    await browser.close();
  }
}
