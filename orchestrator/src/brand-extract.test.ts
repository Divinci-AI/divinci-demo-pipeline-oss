import { describe, it, expect } from "vitest";
import { rgbToHsl, hslToHex, lum, sat, buildPalette, withSansFallback, withGenericFallback, googleFontsUrl, aiProductName, brandNameWithoutAiSuffix, logoIsMark, type RawColors, usableInlineSvg, normalizeExtractedSvg } from "./brand-extract.js";

/** A minimal but real PNG header: signature + IHDR with the given dimensions. */
function png(w: number, h: number): Buffer {
  const b = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

/**
 * The hero lockup renders `[logo] AI` and assumes the logo carries the brand's
 * NAME. True for a wordmark, false for a mark — and the extractor's fallback
 * chain ends at apple-touch-icon / og:image, which are square app icons. That
 * is how AcmePath's hero came to read "⟨A⟩ AI" with "AcmePath" nowhere on it.
 */
describe("logoIsMark", () => {
  it("calls AcmePath's actual 1024x1024 app icon a mark", () => {
    expect(logoIsMark(png(1024, 1024), "png")).toBe(true);
  });

  it("calls a wide wordmark a wordmark", () => {
    expect(logoIsMark(png(600, 120), "png")).toBe(false);
  });

  it("reads an SVG's viewBox, not its width attribute", () => {
    // A responsive SVG carries width="100%", so only viewBox states the aspect.
    const svg = Buffer.from('<svg width="100%" height="100%" viewBox="0 0 512 512"></svg>');
    expect(logoIsMark(svg, "svg")).toBe(true);
  });

  it("falls back to width/height when there is no viewBox", () => {
    expect(logoIsMark(Buffer.from('<svg width="480" height="96"></svg>'), "svg")).toBe(false);
  });

  it("returns undefined when dimensions cannot be read", () => {
    // Not `false`: the caller must keep the existing wordmark assumption rather
    // than act on a guess from a failed parse.
    expect(logoIsMark(Buffer.from("not an image"), "png")).toBeUndefined();
    expect(logoIsMark(Buffer.from("<svg></svg>"), "svg")).toBeUndefined();
  });

  it("reads the BYTES, not the claimed extension", () => {
    // This case previously asserted `undefined` — a PNG labelled "webp" was
    // unreadable because the format came from the label. That assertion
    // encoded the bug: Acme Renew's logo was a WebP served at a `.png` URL, so
    // its dimensions never parsed and their square-ish mark was rendered as
    // though it were a wordmark. The label is now ignored entirely.
    expect(logoIsMark(png(100, 100), "webp")).toBe(true);
    expect(logoIsMark(png(600, 100), "svg")).toBe(false);
  });
});

/**
 * `${org} AI` produced "AcmePath AI AI" — og:site_name already ended in AI.
 * It reached the copy prompts, the chat byline and the example transcript.
 */
describe("aiProductName / brandNameWithoutAiSuffix", () => {
  it("does not double a suffix the brand already has", () => {
    expect(aiProductName("AcmePath AI")).toBe("AcmePath AI");
    expect(aiProductName("Acme Realty")).toBe("Acme Realty AI");
  });

  it("only matches a TRAILING AI — the suffix is appended at the end", () => {
    expect(aiProductName("Xenon AI Labs")).toBe("Xenon AI Labs AI");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(aiProductName("  Jina ai  ")).toBe("Jina ai");
  });

  it("strips the suffix for the lockup, where AI is drawn separately", () => {
    expect(brandNameWithoutAiSuffix("AcmePath AI")).toBe("AcmePath");
    expect(brandNameWithoutAiSuffix("Acme Realty")).toBe("Acme Realty");
  });

  it("never strips a name down to nothing", () => {
    // A brand literally called "AI" must still render something.
    expect(brandNameWithoutAiSuffix("AI")).toBe("AI");
  });
});

describe("withSansFallback", () => {
  it("appends a sans fallback to a bare family (the serif-bug fix)", () => {
    expect(withSansFallback('"Source Sans Pro"')).toBe('"Source Sans Pro", ui-sans-serif, system-ui, sans-serif');
  });
  it("leaves a stack that already has a generic fallback untouched", () => {
    expect(withSansFallback('"Open Sans", sans-serif')).toBe('"Open Sans", sans-serif');
  });
  it("returns a full system stack for empty input", () => {
    expect(withSansFallback("")).toMatch(/sans-serif$/);
  });
});

/**
 * The display face is where withSansFallback's rule inverts. Body copy must
 * never fall through to the UA serif; a heading stack is often deliberately a
 * serif, and appending a sans fallback to it tells the browser "if every serif
 * is missing, use a grotesque" — the opposite of what the brand chose.
 */
describe("withGenericFallback", () => {
  it("preserves a serif generic — AcmePath's heading stack", () => {
    const acmepath = '"Fraunces", "Tiempos", Charter, Georgia, serif';
    expect(withGenericFallback(acmepath)).toBe(acmepath);
    // The body-font helper would have appended a SANS fallback to a serif stack.
    expect(withSansFallback(acmepath)).not.toBe(acmepath);
  });

  it("preserves a sans generic just the same", () => {
    expect(withGenericFallback('"Inter", sans-serif')).toBe('"Inter", sans-serif');
  });

  it("appends sans-serif only when the stack states no intent", () => {
    expect(withGenericFallback('"Fraunces"')).toBe('"Fraunces", sans-serif');
  });

  it("returns undefined for empty input, so 'no distinct face' stays expressible", () => {
    // Not a default stack: the template reads `display ?? family`, and a
    // fabricated value here would silently pin the wrong face.
    expect(withGenericFallback("")).toBeUndefined();
    expect(withGenericFallback(undefined)).toBeUndefined();
  });
});

describe("googleFontsUrl", () => {
  it("builds a css2 link for the primary family", () => {
    expect(googleFontsUrl('"Source Sans Pro", sans-serif')).toBe("https://fonts.googleapis.com/css2?family=Source+Sans+Pro:wght@400;600;700&display=swap");
  });
  it("returns null for generic-only families", () => {
    expect(googleFontsUrl("sans-serif")).toBeNull();
    expect(googleFontsUrl("")).toBeNull();
  });
});

describe("color math", () => {
  it("rgbToHsl basics", () => {
    expect(rgbToHsl(255, 255, 255)[2]).toBeCloseTo(1, 2);   // white → L=1
    expect(rgbToHsl(0, 0, 0)[2]).toBeCloseTo(0, 2);          // black → L=0
    expect(rgbToHsl(128, 128, 128)[1]).toBeCloseTo(0, 2);    // gray → S=0
  });
  it("hslToHex round-trips a saturated color within tolerance", () => {
    const [h, s, l] = rgbToHsl(24, 119, 242); // #1877f2
    const back = hslToHex(h, s, l);
    expect(back).toMatch(/^#[0-9a-f]{6}$/);
    expect(lum(back)).toBeCloseTo(lum("#1877f2"), 1);
  });
  it("lum + sat classify neutrals vs brand colors", () => {
    expect(lum("#ffffff")).toBeGreaterThan(0.95);
    expect(lum("#000000")).toBeLessThan(0.05);
    expect(sat("#1877f2")).toBeGreaterThan(0.5);   // vivid blue
    expect(sat("#808080")).toBeLessThan(0.05);     // gray
  });
});

describe("buildPalette", () => {
  it("maps the dominant brand color to primary and the most saturated to accent", () => {
    const raw: RawColors = {
      bg: { "#172e47": 50000, "#ffffff": 200000, "#f5f5f5": 8000 },
      text: { "#000000": 40, "#333333": 10 },
      headerBg: "#172e47",
      buttonBg: "#1877f2",
      linkColor: "#1877f2",
    };
    const p = buildPalette(raw);
    expect(p.primary).toBe("#172e47");          // header/brand color
    expect(p.accent).toBe("#1877f2");           // most saturated (button)
    expect(lum(p.cream)).toBeGreaterThan(0.9);  // lightest bg
    expect(lum(p.text)).toBeLessThan(0.4);      // darkest text
    expect(p.dark && p.mid).toBeTruthy();
    for (const v of Object.values(p)) expect(v).toMatch(/^#[0-9a-f]{6}$/i);
  });

  // Measured off https://www.acmelongevity.com/ 2026-08-15. A dark-green and
  // gold clinic came back as gold-and-purple: `primary` took the gold CTA and
  // `accent` fell through to the UA's unstyled-link blue.
  const ACMERX: RawColors = {
    bg: {
      "#1a2e20": 2250940, "#f5f0e8": 2155962, "#ffffff": 1516537,
      "#fafaf7": 1089600, "#000000": 921600, "#2c2c2c": 866276,
      "#f8f7f2": 300000, "#233528": 245804, "#e9cc8f": 28468,
    },
    text: { "#2c2c2c": 555, "#3a3a3a": 54, "#afaaa2": 52, "#ffffff": 38, "#000000": 8, "#0000ee": 6 },
    headerBg: undefined,
    buttonBg: "#e9cc8f",
    linkColor: "#0000ee",
  };

  const ACMERX_WITH_BODY: RawColors = { ...ACMERX, bodyBg: "#f5f0e8" };

  it("gives the dark green the structural slot and the gold CTA the accent", () => {
    const p = buildPalette(ACMERX);
    // NOT the gold: a button is an accent, and the dark green covers the most
    // area on the page. Reversing these two is what shipped a gold demo.
    expect(p.primary).toBe("#1a2e20");
    expect(p.accent).toBe("#e9cc8f");
  });

  it("never adopts the browser's unstyled-link blue as a brand color", () => {
    // #0000ee is what the UA paints when the site styled NOTHING, so it is
    // evidence of an absent brand color rather than a brand color. It reached
    // `accent`, and `bubble` is derived from accent — so every citation chip
    // and assistant bubble rendered purple.
    const p = buildPalette(ACMERX);
    for (const v of Object.values(p)) expect(v.toLowerCase()).not.toBe("#0000ee");
    // `bubble` is derived from `accent`, so it must be a tint of the GOLD.
    const hue = (h: string) => {
      const [r, g, b] = [1, 3, 5].map((i)=>(parseInt(h.slice(i, i + 2), 16)));
      return rgbToHsl(r, g, b)[0];
    };
    expect(Math.abs(hue(p.bubble) - hue("#e9cc8f"))).toBeLessThan(2); // degrees
  });

  it("keeps the brand's warm off-white rather than substituting a cooler one", () => {
    // #f5f0e8 has luminance 0.94, under the old 0.96 cutoff, so it was thrown
    // away for a generic blue-grey and the cream site came back cold.
    expect(buildPalette(ACMERX).cream).toBe("#f5f0e8");
  });

  it("takes body text from the most-USED dark color, not the darkest", () => {
    // #000000 appears on 8 elements; #2c2c2c on 555.
    expect(buildPalette(ACMERX).text).toBe("#2c2c2c");
  });

  // Measured off https://acmecyber.com/ 2026-08-16 — a genuinely dark
  // site (body #04090e, panels #091219, cyan #00d4ff, ink #ddeeff) whose demo
  // came back as a WHITE page whose text color was the site's own background.
  const ACMECYBER: RawColors = {
    bg: { "#091219": 1042310, "#070e16": 593628, "#04090e": 95220, "#00d4ff": 26500 },
    text: { "#ddeeff": 106, "#678193": 39, "#00d4ff": 36, "#5c809c": 24, "#ffb700": 8 },
    bodyBg: "#04090e",
    headerBg: "#04090e",
    linkColor: "#00d4ff",
  };

  it("keeps a dark brand dark instead of inventing a white page", () => {
    const p = buildPalette(ACMECYBER);
    expect(lum(p.cream)).toBeLessThan(0.1);   // the PAGE is the site's own near-black
    expect(lum(p.text)).toBeGreaterThan(0.6); // and the ink is light
    expect(p.accent).toBe("#00d4ff");
  });

  it("never uses the site's own background as its ink", () => {
    // The exact shipped bug: text === #04090e === bodyBg.
    const p = buildPalette(ACMECYBER);
    expect(p.text.toLowerCase()).not.toBe(ACMECYBER.bodyBg);
  });

  it("gives a dark page buttons you can actually see", () => {
    // `dark`/`mid` carry the solid chips. Derived from `primary` they came out
    // #10202d on a #091219 page — invisible. On a dark page they must be
    // shades of the ACCENT, the only token with contrast to spend.
    const p = buildPalette(ACMECYBER);
    const ratio = (a: string, b: string) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    expect(ratio(p.dark, p.cream)).toBeGreaterThan(3);
    expect(ratio(p.mid, p.cream)).toBeGreaterThan(3);
  });

  it("judges darkness by the BODY background, not the largest one", () => {
    // acmelongevity.com is a CREAM site whose single largest painted region is
    // a dark-green hero band (2.25M px² vs cream's 2.16M). Area alone calls it
    // dark and inverts a design that was already correct.
    const p = buildPalette(ACMERX_WITH_BODY);
    expect(p.cream).toBe("#f5f0e8");
    expect(p.text).toBe("#2c2c2c");
  });

  it("assumes LIGHT when bodyBg is absent", () => {
    // Drafts extracted before bodyBg existed have no way to answer the
    // question, and the safe answer is the behaviour they already shipped.
    const noBody: RawColors = { ...ACMECYBER, bodyBg: undefined };
    expect(lum(buildPalette(noBody).cream)).toBeGreaterThan(0.9);
  });

  it("falls back to sane defaults when no brand colors are found", () => {
    const p = buildPalette({ bg: { "#ffffff": 100000 }, text: {} });
    expect(p.primary).toMatch(/^#[0-9a-f]{6}$/);
    expect(p.text).toBe("#1a1a1a");
  });
});

// Found 2026-08-09 on acmehealthmd, at Gate 3, after the demo had been built.
// The header/nav selector grabbed a decorative UI glyph and wrote it as the
// logo. It served flawlessly — HTTP 200, image/svg+xml, correct bytes — and
// rendered nothing, because its <use> pointed at a sprite symbol that lives in
// the page, not in the file. Only measuring the painted result caught it.
describe("usableInlineSvg", () => {
  const REAL_LONGEVITY_SITE = '<svg class="open" width="24" height="24" aria-hidden="true" role="img" focusable="false"><use href="#utility-plus"></use></svg>';

  it("rejects the exact glyph that shipped a blank logo", () => {
    expect(usableInlineSvg(REAL_LONGEVITY_SITE)).toBe(false);
  });

  it("rejects anything the author marked aria-hidden — decorative by declaration", () => {
    expect(usableInlineSvg('<svg aria-hidden="true" width="200" height="80"><path d="M0 0h10"/></svg>')).toBe(false);
  });

  it("rejects a <use href='#id'> with no symbol in the same file", () => {
    expect(usableInlineSvg('<svg width="200" height="80"><use href="#brand"></use></svg>')).toBe(false);
    expect(usableInlineSvg('<svg width="200" height="80"><use xlink:href="#brand"></use></svg>')).toBe(false);
  });

  it("ACCEPTS a <use> whose symbol is defined inline — that file is self-contained", () => {
    expect(
      usableInlineSvg('<svg width="200" height="80"><defs><symbol id="b"><path d="M0 0h10"/></symbol></defs><use href="#b"></use></svg>'),
    ).toBe(true);
  });

  it("rejects icon-sized art — a 24px square is an icon whatever it depicts", () => {
    expect(usableInlineSvg('<svg width="24" height="24"><path d="M0 0h10"/></svg>')).toBe(false);
    expect(usableInlineSvg('<svg width="32" height="32"><circle r="4"/></svg>')).toBe(false);
  });

  it("rejects an svg with nothing to draw", () => {
    expect(usableInlineSvg('<svg width="200" height="80"></svg>')).toBe(false);
    expect(usableInlineSvg('<svg width="200" height="80"><title>Logo</title></svg>')).toBe(false);
  });

  it("accepts a real wordmark", () => {
    expect(usableInlineSvg('<svg width="240" height="64" viewBox="0 0 240 64"><path d="M10 10 L60 10 L60 40Z"/><text>Acme</text></svg>')).toBe(true);
  });

  it("accepts art with no width/height attributes (viewBox-only is common)", () => {
    expect(usableInlineSvg('<svg viewBox="0 0 240 64"><path d="M10 10 L60 10"/></svg>')).toBe(true);
  });
});

// The acmezone logo, verbatim, as it was extracted and served on 2026-08-14.
// HTTP 200, image/svg+xml, 316 correct bytes — and naturalWidth 0 in every
// browser, which produced ten "image never loaded" blocking defects across two
// viewports and read as the preflight being over-strict. It was not: the file
// genuinely could not be decoded.
const REAL_ACMEZONE = `<svg viewBox="0 0 24 24" fill="none">
      <path d="M 12 4 L 18.93 16 L 5.07 16 Z"></path>
      <path d="M 15.47 10 L 18.07 8.5"></path>
      <path d="M 8.53 10 L 5.93 8.5"></path>
      <path d="M 12 16 L 12 19"></path>
      <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"></circle>
    </svg>`;

describe("normalizeExtractedSvg", () => {
  it("injects the namespace an inline svg was allowed to omit", () => {
    // Inline in HTML the parser supplies the namespace. Written to a .svg and
    // served as image/svg+xml it is parsed as XML, where it is mandatory.
    expect(normalizeExtractedSvg(REAL_ACMEZONE)).toContain(
      'xmlns="http://www.w3.org/2000/svg"',
    );
  });

  it("leaves an svg that already declares one untouched", () => {
    const ok = '<svg xmlns="http://www.w3.org/2000/svg" width="163" height="40"><path d="M0 0h10"/></svg>';
    expect(normalizeExtractedSvg(ok)).toBe(ok);
  });

  it("does not add a second namespace on a repeat pass", () => {
    const once = normalizeExtractedSvg(REAL_ACMEZONE);
    expect(normalizeExtractedSvg(once)).toBe(once);
    expect(once.match(/xmlns=/g)).toHaveLength(1);
  });

  it("keeps the artwork byte-for-byte apart from the injected attribute", () => {
    // The fix must not "clean up" the customer's mark — only make it loadable.
    expect(normalizeExtractedSvg(REAL_ACMEZONE).replace(' xmlns="http://www.w3.org/2000/svg"', "")).toBe(REAL_ACMEZONE);
  });
});

describe("usableInlineSvg: marks painted only by the page stylesheet", () => {
  it("rejects an outline mark whose stroke colour lives in CSS", () => {
    // fill="none" and no stroke attribute anywhere: inline, the page's CSS
    // strokes it; standalone in an <img>, nothing paints.
    expect(
      usableInlineSvg('<svg viewBox="0 0 24 24" fill="none"><path d="M 12 4 L 18 16 Z"></path></svg>'),
    ).toBe(false);
  });

  it("accepts one whose stroke is on the markup", () => {
    // The control: fill="none" is normal and fine when the stroke travels with
    // the file. Rejecting these too would throw away most real outline logos.
    expect(
      usableInlineSvg('<svg viewBox="0 0 24 24" fill="none" stroke="#327EFF" stroke-width="2"><path d="M 12 4 L 18 16 Z"></path></svg>'),
    ).toBe(true);
  });

  it("accepts one whose children carry real fills", () => {
    expect(
      usableInlineSvg('<svg width="163" height="40" fill="none"><path d="M0 0h10" fill="#327EFF"/></svg>'),
    ).toBe(true);
  });
});

describe("usableInlineSvg: the real acmezone mark", () => {
  it("rejects it — currentColor is not paint in a standalone file", () => {
    // The whole chain in one assertion. Rejecting falls through to logoUrl /
    // apple-touch-icon, which is a real image, per this module's rule that no
    // logo beats a blank one.
    expect(usableInlineSvg(REAL_ACMEZONE)).toBe(false);
  });
});
