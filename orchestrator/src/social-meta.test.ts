import { describe, it, expect } from "vitest";
import { ensureSocialMeta } from "./landing.js";

/**
 * The bespoke generated homepage replaces dist/index.html <head> and all, so it
 * inherits nothing from Landing.astro. All 15 generated demos shipped with no
 * og tags whatsoever — a link posted to Slack or X unfurled as a bare URL.
 */
const META = {
  siteName: "Dr. Mark Hyman",
  description: "Chat 24/7 with an assistant trained on the published work.",
  imageAlt: "Every book. Every episode.",
  pageUrl: "https://demo-drhyman-landing.divinci-ai.workers.dev/",
};

const SHELL = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Dr. Mark Hyman AI — Every book. Every episode. Every answer.</title>
</head>
<body><h1>hi</h1></body>
</html>`;

const get = (html: string, attr: string, key: string) =>
  html.match(new RegExp(`<meta ${attr}="${key}" content="([^"]*)"`, "i"))?.[1];

describe("ensureSocialMeta", () => {
  it("adds the tags an unfurl actually needs", () => {
    const out = ensureSocialMeta(SHELL, META);
    expect(get(out, "property", "og:title")).toContain("Dr. Mark Hyman AI");
    expect(get(out, "property", "og:description")).toBe(META.description);
    expect(get(out, "name", "twitter:card")).toBe("summary_large_image");
  });

  it("makes og:image ABSOLUTE — X rejects a relative one outright", () => {
    const out = ensureSocialMeta(SHELL, META);
    expect(get(out, "property", "og:image")).toBe(
      "https://demo-drhyman-landing.divinci-ai.workers.dev/og.png",
    );
    expect(get(out, "name", "twitter:image")).toMatch(/^https:\/\//);
  });

  it("reuses the shell's own <title> as the share headline", () => {
    // It is the line the copy generator wrote for this brand — a better
    // headline than anything reconstructed from the site name.
    expect(get(ensureSocialMeta(SHELL, META), "property", "og:title")).toBe(
      "Dr. Mark Hyman AI — Every book. Every episode. Every answer.",
    );
  });

  it("is idempotent — running twice does not duplicate tags", () => {
    const once = ensureSocialMeta(SHELL, META);
    const twice = ensureSocialMeta(once, META);
    expect(twice).toBe(once);
    expect(twice.match(/og:title/g)).toHaveLength(1);
  });

  it("never overwrites a tag the generator already emitted", () => {
    const withOwn = SHELL.replace(
      "</head>",
      `<meta property="og:title" content="Hand-written headline">\n</head>`,
    );
    const out = ensureSocialMeta(withOwn, META);
    expect(get(out, "property", "og:title")).toBe("Hand-written headline");
    expect(out.match(/og:title/g)).toHaveLength(1);
    // …but still fills in the ones that ARE missing.
    expect(get(out, "property", "og:image")).toMatch(/og\.png$/);
  });

  it("escapes a brand name containing an ampersand", () => {
    const out = ensureSocialMeta(SHELL, { ...META, siteName: "Smith & Sons" });
    expect(get(out, "property", "og:site_name")).toBe("Smith &amp; Sons");
  });

  it("adds a canonical link when the shell has none", () => {
    expect(ensureSocialMeta(SHELL, META)).toContain(`<link rel="canonical" href="${META.pageUrl}">`);
  });

  it("leaves an existing canonical alone", () => {
    const withCanonical = SHELL.replace("</head>", `<link rel="canonical" href="https://real.example/">\n</head>`);
    const out = ensureSocialMeta(withCanonical, META);
    expect(out.match(/rel="canonical"/g)).toHaveLength(1);
    expect(out).toContain("https://real.example/");
  });

  it("returns the html untouched when there is no </head> to inject into", () => {
    const fragment = "<div>no head here</div>";
    expect(ensureSocialMeta(fragment, META)).toBe(fragment);
  });

  it("falls back to the shell's description meta when none is supplied", () => {
    const withDesc = SHELL.replace("</head>", `<meta name="description" content="From the page.">\n</head>`);
    const out = ensureSocialMeta(withDesc, { ...META, description: undefined });
    expect(get(out, "property", "og:description")).toBe("From the page.");
  });
});
