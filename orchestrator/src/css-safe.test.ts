import { describe, it, expect } from "vitest";
import { safeFontStack, safeCssToken, isAllowedFontLink, safeFontLinks } from "./css-safe.js";
import { brandObjectLiteral, type LandingBrandDraft } from "./landing.js";
import { cleanFontLinks } from "./brand-extract.js";

/** Strings a hostile prospect site could present as a "font family" or style value. */
const PAYLOADS = [
  "x</style><script>alert(1)</script>",
  "Arial; } body { background: url(//evil.example/x) } /*",
  "a{b}",
  "Inter\n</style><img src=x onerror=alert(1)>",
  "x`${alert(1)}`",
  'x"); } @import url(//evil.example/x.css); ("',
  "\\22 ; }",
  "url(javascript:alert(1))",
  "x<!--",
  "Inter, sans-serif; position: fixed; inset: 0",
];

describe("safeFontStack", () => {
  it.each(PAYLOADS)("rejects %j", (p) => {
    expect(safeFontStack(p)).toBeUndefined();
    expect(safeFontStack(`Inter, ${p}`)).toBeUndefined();
  });
  it.each([
    '"Space Mono", ui-monospace, monospace',
    "Inter, sans-serif",
    "'Segoe UI', Roboto, Helvetica Neue, Arial, sans-serif",
    "ff-tisa-sans-web-pro, sans-serif",
    '"Plus Jakarta Sans", "Plus Jakarta Sans Fallback"',
    "-apple-system, BlinkMacSystemFont, system-ui",
  ])("accepts the ordinary stack %s", (s) => expect(safeFontStack(s)).toBe(s));
  it("accepts the long system stacks real sites (Tailwind, Webflow) ship", () => {
    const long = '"Sofia Pro", ui-sans-serif, system-ui, -apple-system, "system-ui", "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"';
    expect(long.length).toBeGreaterThan(200);
    expect(safeFontStack(long)).toBe(long);
  });
  it("rejects empty, over-long and unbalanced-quote stacks", () => {
    expect(safeFontStack("")).toBeUndefined();
    expect(safeFontStack(undefined)).toBeUndefined();
    expect(safeFontStack("a, ".repeat(300))).toBeUndefined();
    expect(safeFontStack('"Inter, sans-serif')).toBeUndefined();
  });
});

describe("safeCssToken", () => {
  it("accepts ordinary weights, tracking, transform, style and variation settings", () => {
    for (const v of ["400", "700", "-0.030em", "-2.9px", "normal", "uppercase", "italic", '"opsz" 24', "500"]) expect(safeCssToken(v)).toBe(v);
  });
  it.each(PAYLOADS.concat(["400; color: red", "1px}"]))("rejects %j", (p) => expect(safeCssToken(p)).toBeUndefined());
});

describe("font links are an allowlist of hosts, not a substring match", () => {
  const ok = [
    "https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap",
    "https://fonts.googleapis.com/css?family=Open+Sans|Roboto",
    "https://use.typekit.net/ik/33LYcYfN21zytks8tR8fc12G.css",
    "https://use.typekit.net/abc1def.css",
  ];
  const bad = [
    "https://evil.example/?u=fonts.googleapis.com/css",
    "https://fonts.googleapis.com.evil.example/css2?family=Inter",
    "https://evil.example/use.typekit.net/x.css",
    "http://fonts.googleapis.com/css2?family=Inter",
    "https://use.typekit.net/",
    "https://use.typekit.net",
    "javascript:alert(1)",
    "data:text/css,body{}",
    'https://fonts.googleapis.com/css2?family=A"onload="x',
    "https://fonts.googleapis.com/css2?family=A B",
    "//fonts.googleapis.com/css2?family=Inter",
    "not a url",
  ];
  it("allows a long multi-weight Google Fonts URL", () => {
    const u = "https://fonts.googleapis.com/css?family=Lato:100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|Open+Sans:300,300i,400,400i,600,600i,700,700i,800,800i&subset=latin&display=swap";
    expect(u.length).toBeGreaterThan(150);
    expect(isAllowedFontLink(u)).toBe(true);
  });
  it.each(ok)("allows %s", (u) => expect(isAllowedFontLink(u)).toBe(true));
  it.each(bad)("refuses %s", (u) => expect(isAllowedFontLink(u)).toBe(false));
  it("cleanFontLinks (extractor) applies the same allowlist", () => {
    expect(cleanFontLinks([...ok, ...bad])).toEqual(ok);
  });
  it("safeFontLinks filters and de-duplicates", () => {
    expect(safeFontLinks([ok[0], ok[0], bad[0]])).toEqual([ok[0]]);
    expect(safeFontLinks(undefined)).toEqual([]);
  });
});

/** The single choke point from a draft (prospect-derived) to brand.config.ts. */
describe("brandObjectLiteral neutralises hostile font data", () => {
  const base: LandingBrandDraft = {
    siteName: "X", domain: "https://x", productName: "X AI", legalName: "X",
    palette: { primary: "#000", dark: "#000", mid: "#000", accent: "#000", cream: "#fff", soft: "#fff", bubble: "#fff", text: "#000" },
    mainSite: "https://x.example", signupUrl: "https://x.example", releaseId: "6a905bc5bbe876cd6ab8ec03", apiBase: "https://api.divinci.app", whitelabelId: "x", workerName: "x",
  } as unknown as LandingBrandDraft;
  const fonts = (d: Partial<LandingBrandDraft>) => JSON.parse(brandObjectLiteral({ ...base, ...d } as LandingBrandDraft)).fonts;

  it.each(PAYLOADS)("a hostile font family never reaches the config: %j", (p) => {
    const f = fonts({ fontFamily: p, displayFontFamily: p, headingFontFamily: p, headingFontWeight: "400" });
    const all = JSON.stringify(f);
    expect(all).not.toMatch(/<|>|;\s*}|`|javascript:|@import|evil\.example/);
    expect(f.family).toMatch(/^ui-sans-serif/); // the safe default
    expect(f.display).toBeUndefined();
    expect(f.headingFamily).toBeUndefined();
  });
  it.each(PAYLOADS)("hostile style values are dropped: %j", (p) => {
    const f = fonts({ displayFontStyle: p, displayFontWeight: p, displayLetterSpacing: p, displayFontVariationSettings: p, displayTextTransform: p,
      headingFontFamily: "Inter, sans-serif", headingFontWeight: p, headingLetterSpacing: p, headingTextTransform: p, headingSubstituteFor: p });
    for (const k of ["displayStyle", "displayWeight", "displayLetterSpacing", "displayVariationSettings", "displayTransform", "headingFontWeight", "headingTracking", "headingTransform", "headingSubstituteFor"]) {
      expect(f[k], k).toBeUndefined();
    }
  });
  it("hostile font links are dropped; real ones kept", () => {
    const real = "https://fonts.googleapis.com/css2?family=Inter&display=swap";
    expect(fonts({ fontLinks: ["https://evil.example/?x=fonts.googleapis.com/css", "javascript:alert(1)", real] }).links).toEqual([real]);
  });
  it("ordinary fonts are passed through untouched", () => {
    const f = fonts({ fontFamily: '"Space Mono", ui-monospace, monospace', headingFontFamily: '"Bebas Neue", sans-serif', headingFontWeight: "400", headingLetterSpacing: "-0.030em", headingTextTransform: "uppercase" });
    expect(f.family).toBe('"Space Mono", ui-monospace, monospace');
    expect(f.headingFamily).toBe('"Bebas Neue", sans-serif');
    expect(f.headingTracking).toBe("-0.030em");
    expect(f.headingTransform).toBe("uppercase");
  });
});
