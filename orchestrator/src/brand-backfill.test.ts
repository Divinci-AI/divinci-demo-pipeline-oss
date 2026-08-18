import { describe, it, expect } from "vitest";
import { backfillBrandDraft, repairDoubledAiSuffix, repairRedundantOgSubtitle, BACKFILLABLE_BRAND_FIELDS } from "./landing.js";

/**
 * Brand extraction runs only when `brand-draft.json` is absent. That is right
 * for a normal re-run and permanent for every demo already built: 43 drafts
 * were written before the extractor learned displayFontFamily, logoIsMark and
 * the display cut, so template work depending on those fields silently does
 * nothing for them.
 *
 * The backfill exists to close that — and its one hard requirement is that it
 * never overwrites a human. Several drafts are hand-tuned (AuraPath's wordmark
 * is Fraunces italic 500 at `opsz 24`, set by hand after the extractor got it
 * wrong), and replacing a correction with a fresh guess is a worse failure than
 * missing the field.
 */
describe("backfillBrandDraft", () => {
  it("adds fields the draft is missing", () => {
    const draft: Record<string, unknown> = { siteName: "Acme" };
    const added = backfillBrandDraft(draft, { displayFontFamily: '"Fraunces", serif', logoIsMark: true });
    expect(draft.displayFontFamily).toBe('"Fraunces", serif');
    expect(draft.logoIsMark).toBe(true);
    expect(added).toEqual(["displayFontFamily", "logoIsMark"]);
  });

  it("NEVER overwrites a value the draft already has", () => {
    const draft: Record<string, unknown> = {
      displayFontStyle: "italic",
      displayFontVariationSettings: "'opsz' 24",
    };
    const added = backfillBrandDraft(draft, {
      displayFontStyle: "normal",
      displayFontVariationSettings: "normal",
    });
    expect(draft.displayFontStyle).toBe("italic");
    expect(draft.displayFontVariationSettings).toBe("'opsz' 24");
    expect(added).toEqual([]);
  });

  it("treats null as absent — JSON has no undefined", () => {
    // A field written as absent round-trips through JSON as null, and would
    // otherwise look like a deliberate setting that must be preserved.
    const draft: Record<string, unknown> = { logoIsMark: null };
    backfillBrandDraft(draft, { logoIsMark: true });
    expect(draft.logoIsMark).toBe(true);
  });

  it("preserves `false` — it is a real answer, not a missing one", () => {
    // logoIsMark:false means "this IS a wordmark", which the hero depends on.
    // A truthiness check here would flip every wordmark demo to the mark path.
    const draft: Record<string, unknown> = { logoIsMark: false };
    const added = backfillBrandDraft(draft, { logoIsMark: true });
    expect(draft.logoIsMark).toBe(false);
    expect(added).toEqual([]);
  });

  it("skips fields the fresh extraction could not determine", () => {
    // undefined means "no distinct heading face" / "unreadable dimensions".
    // Writing it would replace nothing with nothing and report a change.
    const draft: Record<string, unknown> = {};
    const added = backfillBrandDraft(draft, { displayFontFamily: undefined, logoIsMark: null });
    expect(added).toEqual([]);
    expect(Object.keys(draft)).toEqual([]);
  });

  it("touches nothing outside the backfillable set", () => {
    // A re-extract must not silently restyle a live demo by replacing its
    // palette or logo — only ADD what could not have been captured before.
    const draft: Record<string, unknown> = { palette: { primary: "#111111" }, logoFile: "logo.png" };
    backfillBrandDraft(draft, { palette: { primary: "#ff0000" }, logoFile: "other.svg", logoIsMark: true });
    expect(draft.palette).toEqual({ primary: "#111111" });
    expect(draft.logoFile).toBe("logo.png");
    expect(draft.logoIsMark).toBe(true);
  });

  it("covers exactly the fields added after the existing drafts were written", () => {
    expect([...BACKFILLABLE_BRAND_FIELDS]).toEqual([
      "displayFontFamily",
      "displayFontStyle",
      "displayFontWeight",
      "displayLetterSpacing",
      "displayFontVariationSettings",
      "logoIsMark",
    ]);
  });
});

/**
 * A REPAIR, not a backfill: it rewrites a value that already exists, which
 * backfillBrandDraft deliberately never does. Narrow on purpose.
 */
describe("repairDoubledAiSuffix", () => {
  it("collapses the doubled suffix that reached the shared card", () => {
    const d: Record<string, unknown> = { productName: "AuraPath AI AI" };
    expect(repairDoubledAiSuffix(d)).toBe("AuraPath AI");
    expect(d.productName).toBe("AuraPath AI");
  });

  it("leaves a correct name untouched and reports no change", () => {
    const d: Record<string, unknown> = { productName: "Greystone AI" };
    expect(repairDoubledAiSuffix(d)).toBeUndefined();
    expect(d.productName).toBe("Greystone AI");
  });

  it("does not touch an AI that is not the trailing pair", () => {
    const d: Record<string, unknown> = { productName: "Xenon AI Labs AI" };
    expect(repairDoubledAiSuffix(d)).toBeUndefined();
  });

  it("ignores a missing or non-string productName", () => {
    expect(repairDoubledAiSuffix({})).toBeUndefined();
    expect(repairDoubledAiSuffix({ productName: 42 })).toBeUndefined();
  });
});

describe("repairRedundantOgSubtitle", () => {
  it("drops the brand name the tagline already carries", () => {
    const d: Record<string, unknown> = {
      ogTagline: "AuraPath AI — answered 24/7.",
      ogSubtitle: "AI-powered answers from AuraPath AI, in any language.",
    };
    expect(repairRedundantOgSubtitle(d)).toBe("AI-powered answers, in any language.");
  });

  it("keeps the name when the tagline does NOT carry it", () => {
    // Then the subtitle is the only place the brand is named, and removing it
    // loses information rather than removing a repetition.
    const d: Record<string, unknown> = {
      ogTagline: "Answered 24/7.",
      ogSubtitle: "AI-powered answers from AuraPath AI, in any language.",
    };
    expect(repairRedundantOgSubtitle(d)).toBeUndefined();
  });

  it("never touches a hand-written subtitle", () => {
    const d: Record<string, unknown> = {
      ogTagline: "AuraPath AI — answered 24/7.",
      ogSubtitle: "Ask anything about our curriculum.",
    };
    expect(repairRedundantOgSubtitle(d)).toBeUndefined();
  });

  it("is idempotent", () => {
    const d: Record<string, unknown> = {
      ogTagline: "AuraPath AI — answered 24/7.",
      ogSubtitle: "AI-powered answers, in any language.",
    };
    expect(repairRedundantOgSubtitle(d)).toBeUndefined();
  });
});
