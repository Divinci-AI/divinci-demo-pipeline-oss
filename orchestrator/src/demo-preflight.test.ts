import { describe, it, expect } from "vitest";
import { evaluatePreflight, formatDefects, measureUntilStable, PLACEHOLDER_TEXT, type Measurements, incompleteTranslationDefects, measureDemo, captureScreenshots } from "./demo-preflight.js";

const viewport = (over: Partial<Measurements["viewports"][0]> = {}) => ({
  label: "desktop",
  width: 1440,
  text: "Mach33 AI — answers from our space-sector research.",
  brokenImages: [],
  deadVideos: [],
  horizontalScroll: false,
  navigationReachable: true,
  failedRequests: [],
  ...over,
});

const clean = (over: Partial<Measurements> = {}): Measurements => ({
  url: "https://demo-x-landing.example-account.workers.dev",
  reachable: true,
  viewports: [viewport(), viewport({ label: "mobile", width: 390 })],
  assets: [
    { url: "https://demo-x-landing.example-account.workers.dev/og.png", status: 200, contentType: "image/png" },
  ],
  ogImage: "https://demo-x-landing.example-account.workers.dev/og.png",
  ...over,
});

const blocking = (m: Measurements) => evaluatePreflight(m).filter((d) => d.severity === "blocking");

describe("a healthy demo", () => {
  it("produces no defects at all", () => {
    expect(evaluatePreflight(clean())).toEqual([]);
  });

  it("says so in the formatted output", () => {
    expect(formatDefects([])).toMatch(/no measured defects/);
  });
});

describe("the SPA fallback trap", () => {
  it("BLOCKS an asset answered with HTML", () => {
    // `not_found_handling = "single-page-application"` turns a 404 into a 200
    // carrying index.html, so a broken hero and a working one are the same
    // status code. og.png shipped this way on every demo the pipeline had ever
    // built, and corpus.webm did it again after a transient upload failure.
    const d = blocking(
      clean({
        assets: [
          {
            url: "https://demo-x-landing.example-account.workers.dev/brand/corpus.webm",
            status: 200,
            contentType: "text/html; charset=utf-8",
          },
        ],
      }),
    );
    expect(d).toHaveLength(1);
    expect(d[0].what).toMatch(/MISSING/);
    expect(d[0].what).toContain("/brand/corpus.webm");
  });

  it("BLOCKS a plain HTTP error too", () => {
    expect(
      blocking(clean({ assets: [{ url: "https://x.dev/brand/hero.webp", status: 404, contentType: "text/plain" }] })),
    ).toHaveLength(1);
  });
});

describe("the unfurl card", () => {
  it("BLOCKS a relative og:image — X and LinkedIn will not resolve it", () => {
    const d = blocking(clean({ ogImage: "/og.png" }));
    expect(d[0].what).toMatch(/absolute/);
  });

  it("warns rather than blocks when there is none at all", () => {
    const d = evaluatePreflight(clean({ ogImage: undefined }));
    expect(d.map((x) => x.severity)).toEqual(["warning"]);
  });
});

describe("placeholder copy", () => {
  it("BLOCKS the exact string that shipped", () => {
    // The copy step satisfies shape validation perfectly by echoing the
    // template's own text back, so "Replace this with the founder's bio…"
    // passed every existing check and rendered on a deployed page.
    const d = blocking(clean({ viewports: [viewport({ text: "Replace this with the founder's bio — background." })] }));
    expect(d[0].what).toMatch(/placeholder copy/);
  });

  it("catches the other shapes of nobody-wrote-this", () => {
    for (const text of ["Lorem ipsum dolor", "TODO: write this", "Acme Expert AI", "Your bio here"])
      expect(blocking(clean({ viewports: [viewport({ text })] })), text).toHaveLength(1);
  });

  it("reads the RENDERED text, so a word inside markup is not a false positive", () => {
    // The measurement is innerText. A class name or a comment containing
    // "placeholder" is invisible to a visitor and must be invisible here.
    expect(blocking(clean({ viewports: [viewport({ text: "Ask about our published research." })] }))).toEqual([]);
  });

  it("has a pattern for each way this has actually gone wrong", () => {
    expect(PLACEHOLDER_TEXT.length).toBeGreaterThanOrEqual(5);
  });
});

describe("media that loaded but has nothing in it", () => {
  it("BLOCKS a video with no frames", () => {
    // videoWidth === 0 is how a dead video is distinguishable from a working
    // one; the design review scored a page 0 critical / 0 major with exactly
    // this on it, because an empty well reads as a design choice.
    const d = blocking(clean({ viewports: [viewport({ deadVideos: ["https://x.dev/brand/corpus.webm"] })] }));
    expect(d[0].what).toMatch(/no frames/);
  });

  it("BLOCKS an image that never decoded", () => {
    expect(blocking(clean({ viewports: [viewport({ brokenImages: ["https://x.dev/brand/hero.webp"] })] }))).toHaveLength(1);
  });
});

describe("layout", () => {
  it("BLOCKS sideways scroll", () => {
    expect(blocking(clean({ viewports: [viewport({ label: "mobile", horizontalScroll: true })] }))).toHaveLength(1);
  });

  it("warns when navigation is unreachable", () => {
    // The mobile header carried 3 links at `display: none` with no button
    // anywhere — unreachable on every demo ever sent. A warning rather than a
    // block: the demo still works, the visitor just cannot navigate it.
    const d = evaluatePreflight(clean({ viewports: [viewport({ label: "mobile", navigationReachable: false })] }));
    expect(d).toHaveLength(1);
    expect(d[0].severity).toBe("warning");
  });
});

describe("a demo that did not load", () => {
  it("BLOCKS, and reports the reason rather than every downstream symptom", () => {
    const d = evaluatePreflight({ url: "https://x.dev", reachable: false, viewports: [], assets: [], error: "net::ERR_ABORTED" });
    expect(d).toHaveLength(1);
    expect(d[0].what).toContain("net::ERR_ABORTED");
  });
});

describe("formatDefects", () => {
  it("leads with the blocking ones and says not to send", () => {
    const out = formatDefects([
      { severity: "warning", what: "w" },
      { severity: "blocking", what: "b" },
    ]);
    expect(out.indexOf("do not send")).toBeLessThan(out.indexOf("warning"));
  });

  it("still reports warnings when nothing is blocking", () => {
    const out = formatDefects([{ severity: "warning", what: "no reachable navigation" }]);
    expect(out).toMatch(/No blocking defects/);
    expect(out).toMatch(/no reachable navigation/);
  });
});

describe("measureUntilStable", () => {
  const brokenOnce = (): Measurements =>
    clean({ assets: [{ url: "https://x.dev/brand/hero.webp", status: 200, contentType: "text/html" }] });

  it("does not pay the delay when the first look is clean", async () => {
    let calls = 0;
    const r = await measureUntilStable("https://x.dev", undefined, {
      measure: async () => { calls += 1; return clean(); },
      sleep: async () => { throw new Error("should not sleep"); },
    });
    expect(calls).toBe(1);
    expect(r.retried).toBe(false);
  });

  it("re-measures and reports the SECOND result when the first looks broken", async () => {
    // The preflight runs seconds after `wrangler deploy` and can measure the
    // PREVIOUS build. That produced three false alarms while this was written.
    let calls = 0;
    const r = await measureUntilStable("https://x.dev", undefined, {
      measure: async () => (++calls === 1 ? brokenOnce() : clean()),
      sleep: async () => {},
    });
    expect(calls).toBe(2);
    expect(r.retried).toBe(true);
    expect(r.defects).toEqual([]);
  });

  it("cannot mask a REAL defect — it is still there on the retry", async () => {
    const r = await measureUntilStable("https://x.dev", undefined, {
      measure: async () => brokenOnce(),
      sleep: async () => {},
    });
    expect(r.defects.filter((d) => d.severity === "blocking")).toHaveLength(1);
  });

  it("does not retry for warnings alone — a warning is not an alarm", async () => {
    let calls = 0;
    await measureUntilStable("https://x.dev", undefined, {
      measure: async () => { calls += 1; return clean({ ogImage: undefined }); },
      sleep: async () => { throw new Error("should not sleep"); },
    });
    expect(calls).toBe(1);
  });
});

// Step 4 of closing the bios mismatch (2026-08-09): the one preflight check
// that asks whether content is RIGHT, not whether it rendered. Every existing
// check called EvoNexus's French page healthy while six of its eight bio cards
// showed an English role among fluent French.
describe("incompleteTranslationDefects", () => {
  it("flags cards that have a role in English and none in the translation", () => {
    const d = incompleteTranslationDefects({
      default: ["Co-Founder", "EvoNexus Team", "Team", "Team"],
      localized: ["Co-fondateur", "Équipe EvoNexus", "", ""],
      lang: "fr",
    });
    expect(d).toHaveLength(1);
    expect(d[0].what).toContain("2 of 4");
    expect(d[0].what).toContain("2, 3");
  });

  it("is a WARNING, not blocking — the page is coherent and sendable", () => {
    // Blocking would park demos over a missing role beside a name and a photo,
    // and teach people to skip the gate.
    const d = incompleteTranslationDefects({ default: ["CEO"], localized: [""], lang: "fr" });
    expect(d[0].severity).toBe("warning");
  });

  it("says nothing when every card is translated", () => {
    expect(
      incompleteTranslationDefects({ default: ["Co-Founder"], localized: ["Co-fondateur"], lang: "fr" }),
    ).toEqual([]);
  });

  it("says nothing when there are no bio cards at all", () => {
    expect(incompleteTranslationDefects({ default: [], localized: [], lang: "fr" })).toEqual([]);
  });

  it("says nothing when the translated page could not be measured", () => {
    // A demo with no /fr/ is not a defect.
    expect(incompleteTranslationDefects(undefined)).toEqual([]);
  });

  it("does not flag a card that is blank on BOTH pages", () => {
    // No role anywhere is a design choice, not a translation gap.
    expect(
      incompleteTranslationDefects({ default: ["CEO", ""], localized: ["PDG", ""], lang: "fr" }),
    ).toEqual([]);
  });

  it("treats whitespace as absent", () => {
    expect(
      incompleteTranslationDefects({ default: ["CEO"], localized: ["   "], lang: "fr" })[0].severity,
    ).toBe("warning");
  });
});

// 2026-08-09: screenshots were first taken inline on the measuring page, and a
// full-page capture of a long landing page — after extractBrand and findTeam had
// already driven Chromium in the same process — took the browser down. Preflight
// then reported "browser has been closed" on a page that was fine. The gate lost
// its measurement to a convenience feature.
describe("screenshots must not be able to break the measurement", () => {
  it("measureDemo takes no screenshot parameter", () => {
    // Its signature is the contract: capture cannot happen on the measuring page.
    expect(measureDemo.length).toBeLessThanOrEqual(2);
  });

  it("captureScreenshots resolves to [] rather than throwing on a dead URL", () => {
    // A missing screenshot is a worse review; a thrown error would be a failed
    // gate. Those must not share a failure mode.
    return expect(
      captureScreenshots("http://127.0.0.1:1/nope", "/tmp/shots-test-none"),
    ).resolves.toEqual([]);
  }, 90_000);
});
