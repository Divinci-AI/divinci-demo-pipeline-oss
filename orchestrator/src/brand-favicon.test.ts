import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureBrandFavicon, readableOn } from "./landing.js";

/**
 * Every demo with a working logo shipped ACME's favicon.
 *
 * The favicon was written inside `ensureBrandWordmark`, after its
 * `if (draft.logoFile && draft.logoFile !== "logo.svg") return;` early exit —
 * so the moment a logo scraped successfully, the function returned before ever
 * reaching the favicon, and the template placeholder survived: a slate square
 * with a blue "A", `aria-label="Acme Expert"`. Nothing errored and nothing
 * warned; the browser tab was simply another company's initial.
 *
 * The two assets are unrelated, so they are no longer coupled.
 */

const PLACEHOLDER = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="Acme Expert">
  <rect width="32" height="32" rx="7" fill="#2d3748"/>
  <text fill="#4299e1">A</text>
</svg>`;

let dir: string;
const brandDir = () => join(dir, "public", "brand");
const favicon = () => readFileSync(join(brandDir(), "favicon.svg"), "utf8");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "favicon-"));
  mkdirSync(brandDir(), { recursive: true });
  writeFileSync(join(brandDir(), "favicon.svg"), PLACEHOLDER);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("ensureBrandFavicon", () => {
  it("replaces the Acme placeholder EVEN WHEN a logo was extracted", () => {
    // The exact regression: logoFile is set, which used to short-circuit.
    ensureBrandFavicon(dir, {
      siteName: "Acme Renew Integrative Medicine",
      palette: { dark: "#af812e", primary: "#d6ad62" },
    });
    const svg = favicon();
    expect(svg).not.toContain("Acme Expert");
    expect(svg).toContain("Acme Renew Integrative Medicine");
    expect(svg).toContain(">AR<");
  });

  it("uses the brand's own colour, not the template's slate", () => {
    ensureBrandFavicon(dir, { siteName: "Acme Renew", palette: { dark: "#af812e" } });
    expect(favicon()).toContain("#af812e");
    expect(favicon()).not.toContain("#2d3748");
  });

  it("ignores `accent`, which is often the raw link blue off the page", () => {
    // Acme Renew's extracted accent is #0000ee — a browser default, not a brand.
    ensureBrandFavicon(dir, { siteName: "Acme Renew", palette: { dark: "#af812e", accent: "#0000ee" } });
    expect(favicon()).not.toContain("#0000ee");
  });

  it("does NOT overwrite a real favicon dropped in by hand", () => {
    writeFileSync(join(brandDir(), "favicon.svg"), "<svg>the customer's own mark</svg>");
    ensureBrandFavicon(dir, { siteName: "Acme Renew" });
    expect(favicon()).toContain("the customer's own mark");
  });

  it("does NOT overwrite an extracted favicon file", () => {
    ensureBrandFavicon(dir, { siteName: "Acme Renew", faviconFile: "favicon.ico" });
    expect(favicon()).toContain("Acme Expert"); // untouched — the real one is elsewhere
  });

  it("is a no-op when there is no brand dir, rather than throwing", () => {
    const empty = mkdtempSync(join(tmpdir(), "nobrand-"));
    expect(()=>(ensureBrandFavicon(empty, { siteName: "X" }))).not.toThrow();
    expect(existsSync(join(empty, "public", "brand", "favicon.svg"))).toBe(false);
    rmSync(empty, { recursive: true, force: true });
  });
});

describe("readableOn", () => {
  it("picks whichever ink actually scores higher, measured", () => {
    expect(readableOn("#000000")).toBe("#ffffff");
    expect(readableOn("#3b6b3f")).toBe("#ffffff"); // deep green
    expect(readableOn("#ffffff")).toBe("#111111");
    expect(readableOn("#d6ad62")).toBe("#111111"); // light gold
    // ⚠️ Mid-tone gold reads DARK, not light — 6.0:1 with the dark ink versus
    // 3.5:1 with white. Guessing "dark background wants white text" gets this
    // one wrong, which is why the choice is computed rather than assumed.
    expect(readableOn("#af812e")).toBe("#111111");
  });

  it("handles 3-digit hex and falls back safely on junk", () => {
    expect(readableOn("#fff")).toBe("#111111");
    expect(readableOn("not a colour")).toBe("#ffffff");
  });
});
