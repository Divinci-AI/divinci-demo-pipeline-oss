/**
 * Validators for prospect-derived strings that end up inside generated CSS/HTML.
 *
 * WHY THIS EXISTS. A demo is built from a PROSPECT'S website, and its font names,
 * style values and stylesheet links are read straight off that page. They are then
 * concatenated into a `<style>` block (`set:html`) in the landing template and into
 * the preview's stylesheet, all served from OUR domain. A font-family can legally be
 * any quoted string, so `x</style><script>…` is a valid family name; without a gate,
 * a hostile (or merely odd) site could inject markup or CSS into its own demo.
 *
 * These are allowlists, not escapers: an unusual value is DROPPED (the caller falls
 * back to a safe default) rather than rewritten into something that might still
 * parse. The one place they are applied for every demo is `brandObjectLiteral`
 * (landing.ts), the single choke point from a draft to brand.config.ts; the
 * extractor and the preview generator apply them again as defence in depth.
 */

const STACK_CHARS = /^[A-Za-z0-9 _\-"',.]+$/;
const TOKEN_CHARS = /^[A-Za-z0-9 .\-"',%]+$/;

const balanced = (s: string) => (s.match(/"/g)?.length ?? 0) % 2 === 0 && (s.match(/'/g)?.length ?? 0) % 2 === 0;

/** A CSS font-family stack: names, quotes, commas, spaces, hyphens, digits, dots. Nothing that can end a declaration, a rule, a style element or a comment. */
export function safeFontStack(s: string | undefined | null): string | undefined {
  if (typeof s !== "string") return undefined;
  const v = s.trim();
  if (v.length === 0 || v.length > 600) return undefined;
  if (!STACK_CHARS.test(v) || !balanced(v)) return undefined;
  return v;
}

/** A single CSS value such as a weight, tracking, transform, style or variation-settings string. */
export function safeCssToken(s: string | undefined | null): string | undefined {
  if (typeof s !== "string") return undefined;
  const v = s.trim();
  if (v.length === 0 || v.length > 60) return undefined;
  if (!TOKEN_CHARS.test(v) || !balanced(v)) return undefined;
  return v;
}

const FONT_HOSTS = new Set(["fonts.googleapis.com", "use.typekit.net", "fast.fonts.net"]);

/**
 * May this URL be emitted as `<link rel="stylesheet" href>` on a demo page? Only an
 * https stylesheet from a known font host, with a real path. A stylesheet from any
 * other host would let that host restyle (and, via CSS, probe) our page.
 */
export function isAllowedFontLink(u: string | undefined | null): boolean {
  if (typeof u !== "string" || u.length === 0 || u.length > 1500) return false;
  if (!/^[^\s"'<>()\\`]+$/.test(u)) return false;
  let url: URL;
  try { url = new URL(u); } catch { return false; }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  if (!FONT_HOSTS.has(url.hostname)) return false;
  return url.pathname.replace(/\//g, "") !== "";
}

export function safeFontLinks(links: string[] | undefined | null): string[] {
  return Array.from(new Set((links ?? []).filter(isAllowedFontLink)));
}
