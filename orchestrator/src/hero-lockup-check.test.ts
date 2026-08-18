import { describe, it, expect } from "vitest";
import { defaultAiNudge, defaultHeaderAiNudge, isTextLockup, nudgeClass } from "./landing.js";
import { readFileSync } from "node:fs";
import {
  gradeLockup, MIN_LOGO_CONTRAST, MAX_ALIGNMENT_DELTA_PX, HERO_PROBE,
  type HeroLockupMeasurement,
} from "./hero-lockup-check.js";

/**
 * These pin the two defects the vision-model review passed as "0 critical,
 * 0 major" on the Ansir demo: a 1.12:1 logo contrast (white wordmark on light
 * tan — invisible) and a 3.5px vertical offset on the AI mark.
 */
const m = (o: Partial<HeroLockupMeasurement>): HeroLockupMeasurement => ({
  contrast: null, logoInk: null, background: null, deltaPx: null, logoSrc: null, ...o,
});

describe("contrast", () => {
  it("flags the real Ansir measurement as CRITICAL", () => {
    const f = gradeLockup(m({ contrast: 1.12 }));
    expect(f).toHaveLength(1);
    expect(f[0]!.kind).toBe("contrast");
    expect(f[0]!.severity).toBe("critical");
    expect(f[0]!.message).toMatch(/effectively invisible/);
  });

  it("below 1.5 is CRITICAL, not minor — the mark is absent, not hard to read", () => {
    // A page whose logo cannot be seen is broken. If this can be graded minor
    // it will be triaged as polish and shipped, which is what happened.
    expect(gradeLockup(m({ contrast: 1.49 }))[0]!.severity).toBe("critical");
    expect(gradeLockup(m({ contrast: 1.51 }))[0]!.severity).toBe("major");
  });

  it("passes a legible mark", () => {
    // White on the brand blue — what the customer's own header does.
    expect(gradeLockup(m({ contrast: 4.6 }))).toEqual([]);
  });

  it("uses 3:1, the WCAG minimum for a graphical object", () => {
    expect(MIN_LOGO_CONTRAST).toBe(3);
    expect(gradeLockup(m({ contrast: 2.99 }))).toHaveLength(1);
    expect(gradeLockup(m({ contrast: 3.01 }))).toHaveLength(0);
  });
});

describe("alignment", () => {
  it("flags the real Ansir offset and says which way it is off", () => {
    const f = gradeLockup(m({ deltaPx: 3.5 }));
    expect(f).toHaveLength(1);
    expect(f[0]!.kind).toBe("alignment");
    expect(f[0]!.message).toMatch(/3\.5px below/);
  });

  it("reports direction, because the fix is a signed nudge", () => {
    expect(gradeLockup(m({ deltaPx: -4 }))[0]!.message).toMatch(/above/);
  });

  it("tolerates sub-pixel error rather than demanding an unreachable zero", () => {
    // A threshold nothing can pass is a check people switch off.
    expect(MAX_ALIGNMENT_DELTA_PX).toBe(1);
    expect(gradeLockup(m({ deltaPx: 0.9 }))).toEqual([]);
  });
});

describe("both at once", () => {
  it("reports contrast AND alignment independently", () => {
    const f = gradeLockup(m({ contrast: 1.12, deltaPx: 3.5 }));
    expect(f.map((x) => x.kind).sort()).toEqual(["alignment", "contrast"]);
  });

  it("a measurement that failed produces NO findings, never a false pass", () => {
    // nulls mean "not measured". Grading them as 0 would report a perfect
    // lockup for a page the probe could not read — the silent-success shape.
    expect(gradeLockup(m({ error: "canvas tainted" }))).toEqual([]);
  });
});

describe("the in-page probe", () => {
  it("resolves colour through canvas, never by parsing computed style", () => {
    // The first version regex-scraped getComputedStyle and read
    // oklch(0.577 0.062 0.111) as an RGB triple — a confident, meaningless
    // 20.34:1 for a logo that was actually at 1.12:1.
    expect(HERO_PROBE).toMatch(/cv0\.fillStyle = css/);
    expect(HERO_PROBE).toMatch(/toRGB/);
  });

  it("picks the AI mark NEAREST the logo, not one in a fixed window", () => {
    // A 200px window matched the sticky header's AI (off-screen) instead of
    // the hero's and reported a 198px misalignment.
    expect(HERO_PROBE).toMatch(/Math\.hypot/);
    expect(HERO_PROBE).toMatch(/sort\(\(a,b\) => a\.d - b\.d\)/);
  });

  it("measures the logo's INK box, not its element box", () => {
    // A logo image is mostly transparent padding; aligning element boxes is
    // what leaves the letters visibly off.
    expect(HERO_PROBE).toMatch(/d\[k\+3\] < 32/);
    expect(HERO_PROBE).toMatch(/inkCenterY/);
  });

  it("reports an error instead of a number when it cannot measure", () => {
    expect(HERO_PROBE).toMatch(/canvas tainted/);
    expect(HERO_PROBE).toMatch(/no opaque pixels/);
    // Text lockups have their own two give-up cases.
    expect(HERO_PROBE).toMatch(/no AI mark found \(text lockup\)/);
    expect(HERO_PROBE).toMatch(/no wordmark text beside the AI mark/);
  });

  it("does NOT give up when the lockup has no logo image", () => {
    // A brand whose logo is a MARK renders its name as styled text, so there
    // is no <img>. The probe used to answer "no in-viewport logo image" and
    // grade nothing — a silent pass. BioRenew shipped with a visibly
    // off-centre AI mark while all four scopes reported NOT MEASURED.
    expect(HERO_PROBE).toContain("measureTextLockup");
    expect(HERO_PROBE).not.toMatch(/return \{ error: "no in-viewport logo image"/);
  });

  it("MEASURES the baseline rather than deriving it from font metrics", () => {
    // ⚠️ This test previously asserted the opposite, and the thing it asserted
    // was wrong. Deriving the baseline from line-height + fontBoundingBox
    // reported -5.6px for a BioRenew lockup the browser had aligned PERFECTLY.
    // A 5.6px "correction" was applied on that number, pushing "AI" visibly
    // below the wordmark — and the same metric then reported +0.0px, i.e. it
    // validated its own error. Measured truth: baseline delta 0.00px before
    // the nudge, 5.60px after.
    //
    // A zero-size inline-block sits with its bottom ON the baseline, which is
    // exactly what items-baseline aligns. No font metrics, no assumptions.
    expect(HERO_PROBE).toContain("baselineOf");
    expect(HERO_PROBE).toMatch(/display:inline-block;width:0;height:0/);
    expect(HERO_PROBE).toMatch(/getBoundingClientRect\(\)\.bottom/);
    // The derived-metric approach must not come back for the text path.
    expect(HERO_PROBE).not.toContain("fontBoundingBoxAscent");
  });

  it("compares the two lockup baselines directly", () => {
    // For two texts at the same size, BASELINE alignment IS correct alignment;
    // the residual optical difference on BioRenew is ~0.43px (cap ascents
    // 36.33 vs 34.92), far below anything worth nudging.
    expect(HERO_PROBE).toMatch(/baselineOf\(ai\.e\) - baselineOf\(w\.e\)/);
  });

  it("finds the wordmark by LOCKUP ANCESTRY, not by nearest distance", () => {
    // The hero's subheading sits directly below the lockup and is centred, so
    // its centre is often CLOSER to the AI's centre than the wordmark's is —
    // the wordmark being a wide box whose centre lies far to the left.
    // Nearest-by-distance therefore measured the AI against
    // "Our services, described in our own words." and reported -62.2px on
    // desktop and +17.8px on mobile for a lockup that is ~3px out. A
    // confidently wrong number is worse than NOT MEASURED — it would drive a
    // 62px "correction".
    expect(HERO_PROBE).toMatch(/hops < 5/);
    // Same-line overlap test: the lockup is baseline-aligned so its own text
    // overlaps the AI vertically; a heading one line below never does.
    expect(HERO_PROBE).toMatch(/o\.r\.top < ai\.r\.bottom && o\.r\.bottom > ai\.r\.top/);
    // And the old heuristic must not come back for the text path.
    expect(HERO_PROBE).not.toMatch(/Math\.max\(60, ai\.r\.height \* 1\.5\)/);
  });

  it("does not report a fabricated contrast for a gradient wordmark", () => {
    // `bg-clip-text` sets -webkit-text-fill-color: transparent, which would
    // otherwise measure as rgba(0,0,0,0) and produce a meaningless ratio.
    expect(HERO_PROBE).toContain("webkitTextFillColor");
  });
});

/**
 * alignAiMark's selector went stale and the failure was a console.warn nobody
 * read. Observed on ansirsd and leadwithimpact.
 */
describe("alignAiMark keeps up with the template", () => {
  const landing = readFileSync(new URL("./landing.ts", import.meta.url), "utf8");
  // Strip comments before asserting on CODE. The first version of the test
  // below matched the doc comment that DESCRIBES the old console.warn
  // behaviour, not the console.error that replaced it — the same
  // comment-vs-code confusion the Harvey key guard hit.
  const code = landing
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

  it("matches the CURRENT template, not only the historical one", () => {
    expect(code).toMatch(/relative inline-block/);
  });

  it("fails LOUDLY when no target matches", () => {
    // The old code warned and returned false; the run carried on shipping an
    // un-centred mark. A warning nobody greps for is not a signal.
    const i = code.indexOf("alignAiMark: hero AI wrapper not found");
    expect(i, "the message must exist in CODE, not only in a comment").toBeGreaterThan(0);
    expect(code.slice(Math.max(0, i - 200), i)).toMatch(/console\.error/);
    // Deliberately NOT asserting the file is free of console.warn —
    // preventHeadlineOrphans warns legitimately, and banning it globally
    // (which an earlier version of this test did) breaks unrelated code.
  });

  it("lists targets explicitly rather than regex-matching a shape", () => {
    // A loose regex would match a structurally similar wrapper and nudge the
    // wrong element, which is worse than not nudging at all.
    expect(code).toMatch(/const targets = \[/);
  });
});

/**
 * Three bugs in this checker, all found by MEASURING a page whose state was
 * independently known rather than by trusting the number it printed.
 */
describe("the probe measures what the visitor sees", () => {
  it("applies the element's CSS filter before sampling", () => {
    // drawImage uses SOURCE pixels. Without this the probe read the white logo
    // file and reported 1.12:1 for a page whose brightness(0) had already made
    // the mark black on cream at 18.21:1 — crying wolf on a fixed page.
    expect(HERO_PROBE).toMatch(/ctx\.filter = cs\.filter/);
    expect(HERO_PROBE).toMatch(/globalAlpha/);
  });

  it("selects LEAF elements for the AI mark, never an ancestor", () => {
    // The wordmark is an <img> with no text, so the whole lockup wrapper's
    // textContent is literally "AI". Nearest-by-distance then picked the
    // CONTAINER, whose box spans both marks and never moves when the AI is
    // nudged — the check printed a frozen 3.5px across three deploys that were
    // each genuinely moving the mark.
    expect(HERO_PROBE).toMatch(/e\.children\.length === 0/);
  });
});

/**
 * The HEADER lockup had the same defect as the hero and was never patched —
 * alignAiMark only ever touched HeroSection.astro. Measured on Ansir: 6.0px
 * offset with `translate: none`, i.e. nothing had ever run on it.
 */
describe("the header lockup is patched and measured too", () => {
  const landing = readFileSync(new URL("./landing.ts", import.meta.url), "utf8");
  const runner = readFileSync(new URL("./hero-lockup-run.ts", import.meta.url), "utf8");

  it("has its own patcher targeting Header.astro", () => {
    expect(landing).toMatch(/export function alignHeaderAiMark/);
    expect(landing).toMatch(/"Header\.astro"/);
  });

  it("takes a SEPARATE nudge from the hero's", () => {
    // The header renders the same logo at 24px against the hero's 56px, and
    // Ansir needs 6px here against 10.5px there — 0.25 vs 0.1875, so not
    // proportional. One shared constant would be wrong for both.
    expect(landing).toMatch(/headerAiMarkNudgePx/);
  });

  it("is measured by the check, not assumed fixed", () => {
    expect(runner).toMatch(/\["hero", "header"\] as const/);
  });

  it("does not require the header to be in the viewport", () => {
    // A sticky header sits above the fold at scroll 0; the hero's
    // in-viewport filter would have excluded it and reported "no logo image",
    // which grades as no findings — a false pass.
    const probe = readFileSync(new URL("./hero-lockup-check.ts", import.meta.url), "utf8");
    expect(probe).toMatch(/scope === "header" \|\|/);
  });
});

/**
 * The nudge is only correct for an IMAGE wordmark. Applying it to a TEXT one
 * makes the alignment worse by exactly its own size — which is why the lockup
 * misalignment kept coming back: it followed the brand's logo SHAPE, not the
 * template, so it reappeared on every mark-logo demo.
 */
describe("the AI nudge follows the lockup TYPE, not the brand", () => {
  it("is zero for a text lockup — the browser already aligns two texts", () => {
    // An <img> baselines on its bottom edge; text baselines on its baseline.
    // Two texts at the same size need no correction at all.
    expect(defaultAiNudge(true)).toEqual({ base: 0, md: 0 });
    expect(defaultHeaderAiNudge(true)).toEqual({ base: 0, md: 0 });
  });

  it("keeps the measured image values for an image wordmark", () => {
    expect(defaultAiNudge(false)).toEqual({ base: 3.75, md: 5 });
    expect(defaultHeaderAiNudge(false)).toEqual({ base: 3, md: 3 });
  });

  it("treats a MARK logo as a text lockup — the template draws the name", () => {
    expect(isTextLockup({ logoIsMark: true, logoFile: "logo.png" })).toBe(true);
  });

  it("treats a missing logo as a text lockup", () => {
    expect(isTextLockup({})).toBe(true);
  });

  it("treats an extracted WORDMARK image as an image lockup", () => {
    expect(isTextLockup({ logoIsMark: false, logoFile: "logo.svg" })).toBe(false);
  });

  it("pins the measured BioRenew numbers this default came from", () => {
    // Deployed hero, 48px Georgia both sides:
    //   with the 5px nudge → AI 7.96px above the wordmark's optical centre
    //   nudge removed      → AI 2.96px above
    // The nudge contributed a clean 5.00px of the 8px error.
    expect(+(7.96 - 2.96).toFixed(2)).toBe(defaultAiNudge(false).md);
  });
});

describe("nudgeClass", () => {
  it("emits the Tailwind class that actually exists for each sign", () => {
    expect(nudgeClass(3.75)).toBe("-translate-y-[3.75px]");
    expect(nudgeClass(-3.5)).toBe("translate-y-[3.50px]");
    expect(nudgeClass(-2.1, "md")).toBe("md:translate-y-[2.10px]");
    expect(nudgeClass(5, "md")).toBe("md:-translate-y-[5.00px]");
  });

  it("never emits a negative arbitrary value", () => {
    // `-translate-y-[-3.5px]` is not a class Tailwind generates, so it
    // silently does nothing — indistinguishable on the page from the nudge
    // having been applied and been wrong.
    expect(nudgeClass(-3.5)).not.toContain("[-");
    expect(nudgeClass(-0.6, "md")).not.toContain("[-");
  });

  it("zero stays on the positive form, so the guard still recognises it", () => {
    expect(nudgeClass(0)).toBe("-translate-y-[0.00px]");
  });
});

describe("the probe must not read a stale edge", () => {
  it("adds a unique cache-buster to the probed URL", async () => {
    const { bustCache } = await import("./hero-lockup-run.js");
    expect(bustCache("https://demo-x.workers.dev/", "abc")).toBe("https://demo-x.workers.dev/?__lockup=abc");
    // Existing query params survive.
    expect(bustCache("https://demo-x.workers.dev/?lang=fr", "abc"))
      .toBe("https://demo-x.workers.dev/?lang=fr&__lockup=abc");
    // Distinct tokens produce distinct URLs, so two deploys a minute apart
    // cannot share an edge cache entry.
    expect(bustCache("https://d.dev/", "1")).not.toBe(bustCache("https://d.dev/", "2"));
  });

  it("is idempotent — probing twice does not stack params", async () => {
    const { bustCache } = await import("./hero-lockup-run.js");
    expect(bustCache(bustCache("https://d.dev/", "1"), "2")).toBe("https://d.dev/?__lockup=2");
  });
});

// Aquillius extracts `primary` and `accent` as the SAME orange (#f96230), so
// the header drew its AI mark in the exact colour of the bar behind it. The
// check reported "contrast 20.97:1 ✅" throughout — that figure is the WHITE
// WORDMARK's, and nothing had ever measured the AI.
describe("the AI mark's own contrast", () => {
  const base = {
    contrast: 20.97, deltaPx: 0, logoInk: [255,255,255] as [number,number,number],
    background: [249,98,48] as [number,number,number], logoSrc: "logo.png",
  };

  it("fails an AI mark painted the colour of its own background", () => {
    const f = gradeLockup({ ...base, aiContrast: 1.0 });
    expect(f.some((x) => x.kind === "contrast" && x.severity === "critical")).toBe(true);
    expect(f.find((x) => x.severity === "critical")!.message).toMatch(/INVISIBLE/);
  });

  it("does not let a high WORDMARK contrast excuse it", () => {
    // The exact shipped state: wordmark 20.97:1, AI 1.0:1, previously ✅.
    expect(gradeLockup({ ...base, aiContrast: 1.0 })).not.toHaveLength(0);
  });

  it("passes a legible AI mark", () => {
    expect(gradeLockup({ ...base, aiContrast: 4.2 })).toHaveLength(0);
  });

  it("stays silent when the AI contrast could not be measured", () => {
    // Absent must mean "unknown", never "zero" — a probe that cannot read the
    // mark must not manufacture a critical finding.
    expect(gradeLockup({ ...base, aiContrast: null })).toHaveLength(0);
    expect(gradeLockup(base)).toHaveLength(0);
  });
});
