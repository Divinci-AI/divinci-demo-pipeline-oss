/**
 * Deterministic mobile-overflow probe — the counterweight to the design review.
 *
 * The vision reviewer repeatedly reports "horizontally cropped on mobile", and
 * it is not reproducible: five rebuilds of one unchanged page returned 5, 2, 1,
 * 4 and 4 findings. Cropping is one of the few visual claims that can be
 * MEASURED rather than judged, so measure it and stop arguing with pixels.
 *
 * Reports two different things, which are easy to conflate:
 *
 *   pageScrollW > vw   the page itself scrolls sideways — always a real defect
 *   scrollWidth >      an element's content is wider than its box. Only a
 *   clientWidth        defect when overflowX is `hidden`/`clip` AND the element
 *                      is not deliberately truncating; `visible` means the
 *                      content spills but nothing is cut off, which is how
 *                      absolutely-positioned decoration (the hero sparkles)
 *                      legitimately looks from here.
 *
 * Usage: node overflow-probe.mjs <url> [basicAuthUser] [basicAuthPass]
 *
 * Ran against both live demos 2026-08-11: pageScrollW === 390 on each, and
 * every clipped element was either `sr-only` (a 1px screen-reader span, correct)
 * or a Tailwind `truncate` (an intentional ellipsis). The reported mobile chat
 * crop did not reproduce.
 */
import { chromium } from "playwright";

const [url, user, pass] = process.argv.slice(2);
if (!url) {
  console.error("usage: node overflow-probe.mjs <url> [basicAuthUser] [basicAuthPass]");
  process.exit(2);
}

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 390, height: 844 }, // iPhone 14 Pro CSS pixels
  httpCredentials: user ? { username: user, password: pass } : undefined,
});
// Cache-bust: a probe run just after a deploy can otherwise measure the edge's
// previous copy and report a defect the deploy already fixed.
const bust = `${url}${url.includes("?") ? "&" : "?"}_op=${Date.now()}`;
await page.goto(bust, { waitUntil: "networkidle", timeout: 60_000 }).catch(() => {});
await page.waitForTimeout(3000);

const result = await page.evaluate(() => {
  const vw = document.documentElement.clientWidth;
  const past = [];
  const clipped = [];
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && (r.right > vw + 1 || r.left < -1)) {
      past.push({ tag: el.tagName.toLowerCase(), cls: String(el.className || "").slice(0, 60), left: Math.round(r.left), right: Math.round(r.right) });
    }
    if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) {
      const cs = getComputedStyle(el);
      clipped.push({
        tag: el.tagName.toLowerCase(),
        cls: String(el.className || "").slice(0, 60),
        clientW: el.clientWidth,
        scrollW: el.scrollWidth,
        overflowX: cs.overflowX,
        // These clip ON PURPOSE. Flagging them as defects is how a measurement
        // tool earns the same distrust as the vision model it exists to check.
        // `pointer-events-none` + `overflow-hidden` is the decorative-overlay
        // idiom — a gradient or gleam deliberately cropped to its container,
        // invisible to the user and unreachable by the cursor.
        intentional:
          /\b(truncate|sr-only|line-clamp)\b/.test(String(el.className || "")) ||
          (cs.pointerEvents === "none" && cs.position === "absolute"),
      });
    }
  }
  return { vw, pageScrollW: document.documentElement.scrollWidth, past: past.slice(0, 10), clipped: clipped.slice(0, 15) };
});

const realClips = result.clipped.filter((c) => !c.intentional && (c.overflowX === "hidden" || c.overflowX === "clip"));
const pageScrolls = result.pageScrollW > result.vw;

console.log(JSON.stringify({ ...result, verdict: { pageScrollsSideways: pageScrolls, unintentionalClips: realClips.length } }, null, 1));
await browser.close();
process.exit(pageScrolls || realClips.length > 0 ? 1 : 0);
