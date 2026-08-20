import { describe, it, expect } from "vitest";
import { brandObjectLiteral, applyBrandConfig, npmInstallEnv, misattributedBioBodies, defaultAiNudge, defaultHeaderAiNudge, type LandingBrandDraft } from "./landing.js";

const draft: LandingBrandDraft = {
  siteName: "Acme Spine Care",
  domain: "https://demo-acmespine-landing.example-account.workers.dev",
  productName: "Acme Spine Care AI",
  legalName: "Acme Spine Care",
  palette: { primary: "#172e47", dark: "#0f1e2e", mid: "#264c75", accent: "#1877f2", cream: "#ffffff", soft: "#f5f5f5", bubble: "#cfe3fc", text: "#1a1a1a" },
  mainSite: "https://www.acmespine.com",
  signupUrl: "https://www.acmespine.com/contact",
  loginUrl: "https://www.acmespine.com/portal",
  releaseId: "6a293367c50b252c45c6ca47",
  apiBase: "https://api.stage.divinci.app",
  whitelabelId: "6a293367c50b252c45c6ca44",
  bios: [{ name: "Dr. Alex Rivera", title: "About", blurbKey: "bios.bodies.0" }],
  corpusFraming: "Built on our published knowledge base",
  corpusStats: [{ value: "99", label: "sources" }],
  fallbackWelcome: "Hi, I'm the Acme Spine Care AI.",
  starters: ["a", "b", "c"],
  ogTagline: "Spine answers 24/7",
  ogSubtitle: "AI patient education",
  referralSource: "acmespine-demo",
  workerName: "demo-acmespine-landing",
};

describe("brandObjectLiteral", () => {
  const obj = JSON.parse(brandObjectLiteral(draft));

  it("emits all BrandConfig top-level keys (regression: chat was once dropped)", () => {
    expect(Object.keys(obj).sort()).toEqual(
      ["bios", "chat", "corpus", "deploy", "divinci", "fonts", "identity", "links", "media", "palette", "referral", "sections"].sort(),
    );
  });

  it("hides aspirational sections (examples + comingSoon) in demos", () => {
    expect(obj.sections).toEqual({ examples: false, comingSoon: false, bios: true });
  });

  it("shows the team section unless the draft says otherwise", () => {
    // Defaulting to shown keeps every existing run's behaviour: the flag is a
    // suppression, not an opt-in.
    expect(JSON.parse(brandObjectLiteral({ ...draft, showBios: undefined })).sections.bios).toBe(true);
  });

  it("HIDES the team section when no real person was identified", () => {
    // The card falls back to the organisation's own name under a personal role.
    // A deployed demo read "The Acme Finance Group — Founder", which is not a
    // polish issue but a false statement on a page we send to that company.
    expect(JSON.parse(brandObjectLiteral({ ...draft, showBios: false })).sections.bios).toBe(false);
  });

  it("includes chat.fallbackWelcome + starters (the exact key that broke the build)", () => {
    expect(obj.chat.fallbackWelcome).toBe(draft.fallbackWelcome);
    expect(obj.chat.starters).toEqual(draft.starters);
  });

  it("derives media.logo from logoFile when present, else the svg default", () => {
    expect(JSON.parse(brandObjectLiteral(draft)).media.logo).toBe("/brand/logo.svg");
    expect(JSON.parse(brandObjectLiteral({ ...draft, logoFile: "logo.png" })).media.logo).toBe("/brand/logo.png");
  });

  it("uses the extracted fontFamily when present", () => {
    expect(JSON.parse(brandObjectLiteral({ ...draft, fontFamily: "'Source Sans Pro'" })).fonts.family).toContain("Source Sans Pro");
  });

  // Changed 2026-08-08: this used to assert the /brand/ fallbacks, i.e. it
  // pinned the bug. The template has never shipped hero.webp or corpus.webm,
  // so those defaults always rendered a broken image and an empty video well.
  // The pass-through half below is the real requirement and is unchanged.
  it("passes through generated R2 media URLs, and claims nothing when there are none", () => {
    const def = JSON.parse(brandObjectLiteral(draft)).media;
    expect(def.heroImage).toBeUndefined();
    expect(def.corpusVideo).toBeUndefined();
    const gen = JSON.parse(brandObjectLiteral({
      ...draft,
      heroImageUrl: "https://pub-x.r2.dev/acmespine/hero.webp",
      corpusVideoUrl: "https://pub-x.r2.dev/acmespine/corpus.mp4",
    })).media;
    expect(gen.heroImage).toBe("https://pub-x.r2.dev/acmespine/hero.webp");
    expect(gen.corpusVideo).toBe("https://pub-x.r2.dev/acmespine/corpus.mp4");
  });
});

describe("applyBrandConfig", () => {
  const template = [
    "export interface BrandConfig { identity: { siteName: string } }",
    "",
    'export const brand: BrandConfig = {',
    '  identity: { siteName: "Acme Expert" },',
    "};",
    "",
    "export const FREE_MESSAGE_QUOTA = 1;",
  ].join("\n");

  it("splices the new brand object while preserving the interface + quota", () => {
    const out = applyBrandConfig(template, draft);
    expect(out).toContain("export interface BrandConfig");
    expect(out).toContain("export const FREE_MESSAGE_QUOTA = 1;");
    expect(out).toContain("demo-acmespine-landing");
    expect(out).not.toContain("Acme Expert");
  });

  it("throws if the template's brand const is missing", () => {
    expect(() => applyBrandConfig("export const other = {};", draft)).toThrow();
  });
});

// Regression, 2026-08-08: `allow-scripts` in the developer's USER-level ~/.npmrc
// made npm 12 refuse every project-scoped install with EALLOWSCRIPTS, which
// stalled every landing deploy — and, because failing runs still occupy the
// mid-pipeline cap, stopped intake as well. The template already declares
// `"allowScripts": []`; npm objects to the user-level config existing at all.
describe("npmInstallEnv", () => {
  it("clears a user-level allow-scripts that npm 12 refuses to accept", () => {
    const env = npmInstallEnv({ PATH: "/usr/bin", npm_config_allow_scripts: "esbuild,fsevents,workerd" });
    expect(env.npm_config_allow_scripts).toBe("");
  });

  it("clears it even when the developer's machine has never set it", () => {
    // Set explicitly rather than merely absent: npm reads ~/.npmrc itself, so
    // an unset variable is NOT the same as an overridden one.
    expect(npmInstallEnv({ PATH: "/usr/bin" }).npm_config_allow_scripts).toBe("");
  });

  it("passes the rest of the environment through untouched", () => {
    const env = npmInstallEnv({ PATH: "/usr/bin", HOME: "/Users/x", CI: "1" });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/Users/x");
    expect(env.CI).toBe("1");
  });

  it("does not mutate the environment it was handed", () => {
    const base = { npm_config_allow_scripts: "esbuild" };
    npmInstallEnv(base);
    expect(base.npm_config_allow_scripts).toBe("esbuild");
  });
});

// Regression, 2026-08-08. The template ships logo.svg and favicon.svg but has
// never shipped hero.webp or corpus.webm, so defaulting to those paths rendered
// a broken image and an empty video well on every demo generated without art.
// The Worker's SPA fallback serves a missing asset as 200 + HTML, so it never
// 404'd — it was caught only by measuring what the browser painted.
describe("brand media: never claim an asset we do not have", () => {
  const withMedia = (extra: Partial<LandingBrandDraft>) =>
    brandObjectLiteral({ ...draft, ...extra } as LandingBrandDraft);

  it("omits heroImage entirely when there is no hero art", () => {
    const out = withMedia({ heroImageUrl: undefined });
    expect(out).not.toContain("/brand/hero.webp");
    expect(out).not.toContain("heroImage");
  });

  it("omits corpusVideo entirely when there is no corpus video", () => {
    const out = withMedia({ corpusVideoUrl: undefined });
    expect(out).not.toContain("/brand/corpus.webm");
    expect(out).not.toContain("corpusVideo");
  });

  it("still emits them when a real asset exists", () => {
    const out = withMedia({
      heroImageUrl: "https://cdn.example/x/hero.webp",
      corpusVideoUrl: "https://cdn.example/x/corpus.mp4",
    });
    expect(out).toContain("https://cdn.example/x/hero.webp");
    expect(out).toContain("https://cdn.example/x/corpus.mp4");
  });

  it("keeps the logo and favicon defaults — those files ARE shipped", () => {
    const out = withMedia({ logoFile: undefined });
    expect(out).toContain("/brand/logo.svg");
    expect(out).toContain("/brand/favicon.svg");
  });
});

// Steps 1-2 of closing the bios mismatch (2026-08-09). brand.config.bios (WHO,
// from the team scraper) and en.ts bios.bodies (WHAT IS SAID, from the copy
// generator) are produced by different processes and joined BY INDEX at render
// time. Nothing bound body[i] to person[i] — run.ts asserted it in a comment.
// Acme Incubator published Casey Brook's biography under Sam Torres's name, face
// and, once translation worked, in fluent French.
describe("misattributedBioBodies", () => {
  const team = [
    { name: "Dr. Sam Torres" },
    { name: "Dr. Michael Hill" },
    { name: "Dr. Dong-Min Park" },
  ];

  it("flags the body that describes somebody else", () => {
    const bodies = [
      "Casey Brook speaks publicly about Acme Incubator and its portfolio.",
      "Michael Hill publishes the portfolio announcements.",
      "",
    ];
    expect(misattributedBioBodies(team, bodies)).toEqual([0]);
  });

  it("keeps a body that names its own person", () => {
    expect(misattributedBioBodies(team, ["Sam Torres advises the fund."])).toEqual([]);
  });

  it("leaves a SINGLE-bio demo alone — there is nobody to confuse it with", () => {
    // Most of the fleet is one "About" card whose prose legitimately says
    // "our founder" without ever stating a surname. Flagging those would blank
    // good copy across ~40 demos to fix a problem they do not have.
    const one = [{ name: "Dr. Robin Cole" }];
    expect(misattributedBioBodies(one, ["Our founder writes about thyroid health."])).toEqual([]);
  });

  it("ignores bodies that are already empty", () => {
    expect(misattributedBioBodies(team, ["", "", ""])).toEqual([]);
  });

  it("ignores bodies beyond the end of the team", () => {
    expect(misattributedBioBodies(team.slice(0, 1).concat(team[1]), ["Sam Torres leads.", "Michael Hill leads.", "orphan body"]))
      .toEqual([]);
  });

  it("matches on surname, so an honorific or credential does not defeat it", () => {
    expect(misattributedBioBodies(team, ["Torres, Ph.D., advises the fund."])).toEqual([]);
  });
});

describe("a measured logo drop supersedes the guessed AI nudge", () => {
  it("zeroes the nudge when the logo was actually measured", () => {
    // Both fix the same defect. Acme Advisors shipped both for one deploy: 5.09px
    // of measured drop plus 5px of guessed lift, i.e. double the correction —
    // the AI ended as far BELOW the letters as it had been above them.
    expect(defaultAiNudge(false, 0.0909)).toEqual({ base: 0, md: 0 });
    expect(defaultHeaderAiNudge(false, 0.0909)).toEqual({ base: 0, md: 0 });
  });

  it("keeps the guess when the logo could NOT be measured", () => {
    // An SVG or a logo with no alpha yields no measurement, and those demos
    // must keep the behaviour they ship with today.
    expect(defaultAiNudge(false, undefined)).toEqual({ base: 3.75, md: 5 });
    expect(defaultHeaderAiNudge(false, undefined)).toEqual({ base: 3, md: 3 });
  });

  it("still zeroes for a text lockup regardless of any drop", () => {
    expect(defaultAiNudge(true, 0.09)).toEqual({ base: 0, md: 0 });
    expect(defaultAiNudge(true, undefined)).toEqual({ base: 0, md: 0 });
  });
});
