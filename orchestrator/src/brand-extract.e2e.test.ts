/**
 * End-to-end tests in a REAL browser, offline.
 *
 * The unit tests cover the pure helpers; they cannot show that the in-page extraction script reads
 * the right element on a page shaped like a real site, ignores cookie banners and hidden text, or
 * that hostile page data is neutralised on its way to the generated demo. These do, against local
 * fixture pages (any external request is answered with an empty body, so nothing leaves the machine).
 *
 * Needs a Chromium build: `npx playwright install chromium`. When none is installed these tests
 * SKIP rather than fail, so a fresh clone's `npm test` stays green; CI installs the browser, so
 * there they always run.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { chromium, type Browser, type Page } from "playwright";
import { BROWSER_SCRIPT, resolveBodyFamily, trackingInEm, cleanFontLinks, type RawColors } from "./brand-extract.js";
import { brandObjectLiteral, type LandingBrandDraft } from "./landing.js";

const LONG = "We help small teams plan, build and ship dependable software for the organizations that rely on it every day.";

const PAGES: Record<string, string> = {
  // Squarespace-shaped: <body> is the generic fallback, the real faces sit on p / nav / h2.
  "/squarespace": `<!doctype html><html><head><title>t</title>
    <link rel="preconnect" href="https://use.typekit.net/">
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&display=swap">
    <style>
      body { font-family: sans-serif; background: #000; color: #fff; margin: 0 }
      header a { font-family: "Space Mono"; text-transform: uppercase }
      p { font-family: "Space Mono"; font-size: 14px }
      h2 { font-family: rama-gothic-e; font-weight: 600; font-size: 96px; letter-spacing: -2.88px; text-transform: uppercase }
    </style></head><body>
    <header><a href="/">Events</a><a href="/about">About</a></header>
    <main><h2>Stepwise AI for Business Leaders</h2><p>${LONG}</p></main></body></html>`,

  // A cookie banner and hidden/sr-only elements come FIRST in the DOM, in unrelated fonts.
  "/noisy": `<!doctype html><html><head><title>t</title><style>
      body { font-family: sans-serif; margin: 0 }
      #onetrust-banner { font-family: "Comic Sans MS"; position: fixed; bottom: 0 }
      #onetrust-banner h2 { font-family: "Comic Sans MS" }
      .hidden-h1 { display: none; font-family: Papyrus }
      .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; font-family: Impact }
      main p { font-family: "Lora", serif }
      main h1 { font-family: "Playfair Display", serif; font-weight: 700 }
    </style></head><body>
    <div id="onetrust-banner"><h2>We value your privacy</h2><p>${LONG} We use cookies to improve your experience here.</p></div>
    <h1 class="hidden-h1">Hidden heading that is display none</h1>
    <h2 class="sr-only">Screen reader only heading text</h2>
    <main><h1>Welcome to the real page heading</h1><p>${LONG}</p></main></body></html>`,

  // Invisible-but-sized elements (visibility:hidden, opacity:0) come first, and the real content is NOT in <main>,
  // so nothing but the visibility check can keep them from setting the fonts.
  "/invisible-first": `<!doctype html><html><head><title>t</title><style>
      body { font-family: sans-serif; margin: 0 }
      .vis-hidden { visibility: hidden; font-family: Papyrus; font-size: 30px }
      .transparent { opacity: 0; font-family: Impact; font-size: 30px }
      .real-h { font-family: "Playfair Display", serif; font-size: 40px }
      .real-p { font-family: "Lora", serif }
    </style></head><body>
    <h1 class="vis-hidden">Invisible heading with visibility hidden</h1><p class="vis-hidden">${LONG} Invisible paragraph with visibility hidden.</p>
    <h2 class="transparent">Invisible heading with zero opacity</h2><p class="transparent">${LONG} Invisible paragraph with zero opacity.</p>
    <h1 class="real-h">The real, visible heading</h1><p class="real-p">${LONG}</p></body></html>`,

  // Squarespace scroll-reveal: every paragraph/heading sits at opacity:0 (.preFade) until scrolled to,
  // body stays on the UA fallback. A visibility:hidden decoy and a cookie banner come FIRST and must still lose.
  "/reveal-on-scroll": `<!doctype html><html><head><title>t</title><style>
      body { font-family: sans-serif; margin: 0 }
      .preFade { opacity: 0 }
      .decoy { visibility: hidden; font-family: Papyrus; font-size: 30px }
      #cookie-banner p { font-family: Impact }
      .real-h { font-family: "Playfair Display", serif; font-size: 40px }
      .real-p { font-family: "Lora", serif }
    </style></head><body>
    <h1 class="decoy">Decoy heading with visibility hidden</h1><p class="decoy">${LONG} Decoy paragraph.</p>
    <div id="cookie-banner"><p class="preFade">${LONG} We use cookies.</p></div>
    <h2 class="preFade real-h">The real heading waiting to fade in</h2><p class="preFade real-p">${LONG}</p></body></html>`,

  // The page's own JavaScript lies: getComputedStyle returns markup-breaking strings for everything.
  "/hostile": `<!doctype html><html><head><title>t</title><script>
      var EVIL = 'x</style><script>alert(1)<\\/script>';
      window.getComputedStyle = function () {
        return new Proxy({}, { get: function (_t, k) { return k === 'getPropertyValue' ? function () { return EVIL; } : EVIL; } });
      };
    </script></head><body><header><a href="/">x</a></header><main><h1>Heading text here</h1><p>${LONG}</p></main></body></html>`,

  // Body already a real webfont, headings the same face: there must be NO distinct heading.
  "/same-face": `<!doctype html><html><head><title>t</title><style>
      body, h1, h2, p { font-family: "Inter", sans-serif } h1 { font-weight: 700 }
    </style></head><body><main><h1>One typeface everywhere</h1><p>${LONG}</p></main></body></html>`,
};

// Launch for real: Playwright's executablePath() points at the full Chromium build while headless
// runs use a separate headless-shell build, so a file-exists check gives the wrong answer.
const launched: Browser | null = await chromium.launch().catch(() => null);
const hasBrowser = launched !== null;
const d = hasBrowser ? describe : describe.skip;

let server: Server, base: string, browser: Browser, page: Page;
const dialogs: string[] = [];

beforeAll(async () => {
  if (!hasBrowser) return;
  server = createServer((req, res) => {
    const html = PAGES[(req.url ?? "").split("?")[0]];
    res.writeHead(html ? 200 : 404, { "content-type": "text/html" }).end(html ?? "");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = launched!;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  // Offline: answer every non-local request with an empty body.
  await ctx.route("**/*", (route) => route.request().url().startsWith(base) ? route.continue() : route.fulfill({ status: 200, body: "", contentType: "text/css" }));
  page = await ctx.newPage();
  page.on("dialog", (d) => { dialogs.push(d.message()); void d.dismiss(); });
}, 60_000);

afterAll(async () => { await browser?.close(); await new Promise((r) => server?.close(r)); });

async function extract(path: string): Promise<RawColors> {
  await page.goto(base + path, { waitUntil: "load" });
  return (await page.evaluate(BROWSER_SCRIPT)) as RawColors;
}

d("extractor in a real browser: a Squarespace-shaped page (body generic, real faces on children)", () => {
  it("reads the generic body, the paragraph face and the heading treatment separately", async () => {
    const raw = await extract("/squarespace");
    expect(raw.fontFamily).toBe("sans-serif");
    expect(raw.textFont).toContain("Space Mono");
    expect(raw.heading?.family).toContain("rama-gothic-e");
    expect(raw.heading?.weight).toBe("600");
    expect(raw.heading?.textTransform).toBe("uppercase");
    expect(raw.heading?.fontSize).toBe("96px");
  });
  it("resolves the body to the page's own loaded Google font, converts tracking to em", async () => {
    const raw = await extract("/squarespace");
    expect(resolveBodyFamily(raw.fontFamily, raw.textFont, raw.fontLinks)).toMatch(/Space Mono/);
    expect(trackingInEm(raw.heading?.letterSpacing, raw.heading?.fontSize)).toBe("-0.030em");
  });
  it("drops the bare typekit preconnect but keeps the real Google stylesheet", async () => {
    const raw = await extract("/squarespace");
    expect(cleanFontLinks(raw.fontLinks)).toEqual(["https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&display=swap"]);
  });
});

d("extractor in a real browser: noise must not set the brand's fonts", () => {
  it("ignores a cookie banner, a display:none heading and a screen-reader-only heading", async () => {
    const raw = await extract("/noisy");
    expect(raw.textFont).toContain("Lora");
    expect(raw.textFont).not.toMatch(/Comic|Papyrus|Impact/);
    expect(raw.heading?.family).toContain("Playfair Display");
    expect(raw.heading?.family).not.toMatch(/Comic|Papyrus|Impact/);
  });
});

d("extractor in a real browser: invisible elements must not set the brand's fonts", () => {
  it("skips visibility:hidden and opacity:0 elements even though they have a size", async () => {
    const raw = await extract("/invisible-first");
    expect(raw.textFont).toContain("Lora");
    expect(raw.textFont).not.toMatch(/Papyrus|Impact/);
    expect(raw.heading?.family).toContain("Playfair Display");
    expect(raw.heading?.family).not.toMatch(/Papyrus|Impact/);
  });
});

d("extractor in a real browser: scroll-reveal pages (opacity:0 until scrolled)", () => {
  it("falls back to faded-in-waiting copy when nothing is fully visible, but never to hidden or consent elements", async () => {
    const raw = await extract("/reveal-on-scroll");
    expect(raw.textFont).toContain("Lora");
    expect(raw.textFont).not.toMatch(/Papyrus|Impact/);
    expect(raw.heading?.family).toContain("Playfair Display");
    expect(raw.heading?.family).not.toMatch(/Papyrus|Impact/);
  });
});

d("extractor in a real browser: no distinct heading when the page uses one typeface", () => {
  it("reports the same face for body and heading, which the assembly then treats as 'no heading font'", async () => {
    const raw = await extract("/same-face");
    expect(raw.fontFamily).toContain("Inter");
    expect(raw.heading?.family).toBe(raw.fontFamily);
  });
});

d("a HOSTILE page, end to end: page JS -> extraction script -> draft -> brand.config.ts", () => {
  const draftFrom = (raw: RawColors): LandingBrandDraft => ({
    siteName: "X", domain: "https://x", productName: "X AI", legalName: "X",
    palette: { primary: "#000", dark: "#000", mid: "#000", accent: "#000", cream: "#fff", soft: "#fff", bubble: "#fff", text: "#000" },
    mainSite: "https://x.example", signupUrl: "https://x.example", releaseId: "6a905bc5bbe876cd6ab8ec03", apiBase: "https://api.divinci.app", whitelabelId: "x", workerName: "x",
    // exactly what the extractor would hand on, with no sanitising of its own
    fontFamily: raw.fontFamily, displayFontFamily: raw.display?.family,
    headingFontFamily: raw.heading?.family, headingFontWeight: raw.heading?.weight, headingTextTransform: raw.heading?.textTransform, headingLetterSpacing: raw.heading?.letterSpacing,
    displayTextTransform: raw.display?.textTransform, displayFontWeight: raw.display?.weight, displayLetterSpacing: raw.display?.letterSpacing, displayFontStyle: raw.display?.style,
    fontLinks: raw.fontLinks,
  } as unknown as LandingBrandDraft);

  it("the page really does return hostile strings to the script (the premise of the test)", async () => {
    const raw = await extract("/hostile");
    expect(raw.fontFamily).toContain("</style>");
  });

  it("no hostile character reaches the generated config, and nothing executed", async () => {
    const raw = await extract("/hostile");
    const cfg = brandObjectLiteral(draftFrom(raw));
    expect(cfg).not.toMatch(/<\/?style|<script|alert\(1\)|;\s*}/);
    const fonts = JSON.parse(cfg).fonts;
    expect(fonts.family).toMatch(/^ui-sans-serif/);   // safe default, not the hostile string
    expect(fonts.headingFamily).toBeUndefined();
    expect(dialogs).toEqual([]);
  });

  it("rendering the real template's style expression with that config executes nothing", async () => {
    const raw = await extract("/hostile");
    const f = JSON.parse(brandObjectLiteral(draftFrom(raw))).fonts;
    // The two raw `set:html` concatenations from the template, built exactly as Landing.astro builds them.
    const style = `:root{--font-sans:${f.family};--font-display:${f.display ?? f.family};--font-display-weight:${f.displayWeight ?? "500"};}`;
    await page.setContent(`<style>${style}</style><p id="p">ok</p>`);
    expect(dialogs).toEqual([]);
    expect(await page.locator("script").count()).toBe(0);
    expect(await page.locator("#p").innerText()).toBe("ok");
  });
});
