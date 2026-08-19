import { describe, it, expect } from "vitest";
import { isSystemFont, googleFontsUrl, googleFontsCandidates } from "./brand-extract.js";

/**
 * The Acme Renew demo shipped two 403s on every page load:
 *
 *   GET https://fonts.googleapis.com/css2?family=Georgia:wght@400;600;700  403
 *   GET https://fonts.googleapis.com/css2?family=Times:wght@400;600;700    403
 *
 * Georgia and Times are web-safe system fonts. Google answers an unknown
 * family with **403 Forbidden**, not 404, and the request is a render-blocking
 * <link rel="stylesheet"> in <head> — so it costs a DNS + TLS + round trip to
 * fail, on every load, and fills the console with errors that make a demo look
 * broken to anyone who opens devtools.
 *
 * The code's own comment claimed unknown families "just 404 the link
 * harmlessly". Both halves were wrong.
 */
describe("isSystemFont", () => {
  it("knows the two that actually 403'd", () => {
    expect(isSystemFont("Georgia")).toBe(true);
    expect(isSystemFont("Times")).toBe(true);
  });

  it("is case- and quote-insensitive, as extracted CSS is neither", () => {
    // A computed font-family arrives as e.g. `"Times New Roman"` or `GEORGIA`.
    expect(isSystemFont('"Times New Roman"')).toBe(true);
    expect(isSystemFont("  GEORGIA  ")).toBe(true);
    expect(isSystemFont("'Helvetica Neue'")).toBe(true);
  });

  it("does NOT claim real Google families", () => {
    // A false positive here silently stops loading a webfont the brand
    // actually uses, which is worse than a wasted request: the page renders
    // in the wrong typeface and nothing errors.
    for (const f of ["Inter", "Roboto", "Open Sans", "Lato", "Montserrat", "Fraunces", "Playfair Display", "Source Sans 3"]) {
      expect(isSystemFont(f), f).toBe(false);
    }
  });
});

describe("googleFontsUrl", () => {
  it("returns null for a system font instead of a URL that 403s", () => {
    expect(googleFontsUrl("Georgia, serif")).toBeNull();
    expect(googleFontsUrl("Times, ui-sans-serif, system-ui, sans-serif")).toBeNull();
  });

  it("still builds a URL for a real Google family", () => {
    expect(googleFontsUrl("Inter, sans-serif")).toBe(
      "https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap",
    );
  });

  it("still returns null for a bare generic", () => {
    expect(googleFontsUrl("serif")).toBeNull();
  });
});

describe("googleFontsCandidates", () => {
  it("returns nothing for a system font", () => {
    // The variable-font path builds several URLs, so an unguarded system font
    // would have produced up to four 403s rather than one.
    expect(googleFontsCandidates("Georgia", { opsz: true, italic: true })).toEqual([]);
  });

  it("still returns candidates for a real family", () => {
    expect(googleFontsCandidates("Fraunces", { opsz: true }).length).toBeGreaterThan(0);
  });
});

describe("Acme Renew's real extracted stacks", () => {
  // Verbatim from runs/acmerenew/2026-08-14-001/landing/brand-draft.json.
  const BODY = "Times, ui-sans-serif, system-ui, sans-serif";
  const DISPLAY = "Georgia, serif";

  it("produces no font links at all — both families are already installed", () => {
    expect(googleFontsUrl(BODY)).toBeNull();
    expect(googleFontsUrl(DISPLAY)).toBeNull();
    expect(googleFontsCandidates(DISPLAY, { opsz: true, italic: true })).toEqual([]);
  });
});

describe("pruneDeadFontLinks", () => {
  it("drops Acme Renew's two 403 links and keeps the real one", async () => {
    const { pruneDeadFontLinks } = await import("./landing.js");
    // Verbatim from the draft.
    const links = [
      "https://fonts.googleapis.com/css2?family=Times:wght@400;600;700&display=swap",
      "https://fonts.googleapis.com/css2?family=Georgia:wght@400;600;700&display=swap",
      "https://fonts.googleapis.com/css?family=Inter:100,400,700%7CMontserrat:100,400,700&display=swap",
    ];
    expect(pruneDeadFontLinks(links)).toEqual([links[2]]);
  });

  it("keeps a MIXED link — the hosted families on it still need fetching", async () => {
    const { pruneDeadFontLinks } = await import("./landing.js");
    const mixed = "https://fonts.googleapis.com/css?family=Georgia%7CInter&display=swap";
    expect(pruneDeadFontLinks([mixed])).toEqual([mixed]);
  });

  it("leaves NON-Google stylesheets alone", async () => {
    const { pruneDeadFontLinks } = await import("./landing.js");
    // A Typekit or self-hosted sheet may legitimately serve a same-named face.
    const other = ["https://use.typekit.net/abc.css", "https://primumlaw.com/fonts/georgia.css"];
    expect(pruneDeadFontLinks(other)).toEqual(other);
  });

  it("leaves an unparseable href alone rather than guessing", async () => {
    const { pruneDeadFontLinks } = await import("./landing.js");
    expect(pruneDeadFontLinks(["not a url"])).toEqual(["not a url"]);
  });
});

/**
 * The Acme Renew demo shipped in Times/Georgia while acmerenew.com is set in
 * Inter — its CSS drives everything off `--headlinefont: 'Inter'` and
 * `--contentfont: 'Inter'`, and it loads Inter + Montserrat from Google. The
 * extractor sampled an element carrying one of the theme's four
 * `font-family:Georgia,serif` rules and took that as the brand face, so a demo
 * built for a clean-sans customer read as a serif site.
 */
describe("preferLoadedWebfont", () => {
  const BIO_LINKS = [
    "https://fonts.googleapis.com/css?family=Inter:100,400,700%7CMontserrat:100,400,700&display=swap",
  ];

  it("corrects Acme Renew's mis-sampled system fonts to Inter", async () => {
    const { preferLoadedWebfont } = await import("./brand-extract.js");
    expect(preferLoadedWebfont("Times, ui-sans-serif, system-ui, sans-serif", BIO_LINKS)).toBe("Inter");
    expect(preferLoadedWebfont("Georgia, serif", BIO_LINKS)).toBe("Inter");
  });

  it("NEVER overrides a real webfont reading", async () => {
    // The asymmetry is deliberate: a site may legitimately load a webfont for
    // headings only, so a non-system reading is always believed.
    const { preferLoadedWebfont } = await import("./brand-extract.js");
    expect(preferLoadedWebfont("Fraunces, serif", BIO_LINKS)).toBe("Fraunces, serif");
  });

  it("leaves a system font alone when the page loads NO webfont", async () => {
    // A site genuinely set in Georgia must stay in Georgia.
    const { preferLoadedWebfont } = await import("./brand-extract.js");
    expect(preferLoadedWebfont("Georgia, serif", [])).toBe("Georgia, serif");
    expect(preferLoadedWebfont("Georgia, serif", undefined)).toBe("Georgia, serif");
  });

  it("ignores non-Google stylesheets when looking for the loaded family", async () => {
    const { preferLoadedWebfont } = await import("./brand-extract.js");
    expect(preferLoadedWebfont("Georgia, serif", ["https://use.typekit.net/abc.css"])).toBe("Georgia, serif");
  });
});

describe("loadedGoogleFamilies", () => {
  it("reads both css v1 pipe-separated and css2 repeated families", async () => {
    const { loadedGoogleFamilies } = await import("./brand-extract.js");
    expect(loadedGoogleFamilies([
      "https://fonts.googleapis.com/css?family=Inter:400%7CMontserrat:700&display=swap",
    ])).toEqual(["Inter", "Montserrat"]);
    expect(loadedGoogleFamilies([
      "https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400&display=swap",
    ])).toEqual(["Playfair Display"]);
  });
});
