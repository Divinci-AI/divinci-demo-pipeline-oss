/**
 * The compliance prompt is the only thing standing between an approved Gate 1
 * and an unguarded assistant, and its failure mode is SILENT — a run whose
 * prompt is missing its rules looks identical to one that has them, right up
 * until a QA suite or a prospect finds out.
 *
 * Each test is named after the real failure it prevents.
 */

import { describe, it, expect } from "vitest";
import { complianceSystemPrompt, STRICT_TIERS } from "./compliance-prompt.js";

const NOTES =
  "Acme Bio is an IVD manufacturer. Education-only; no diagnosis; every clinical path ends in a handoff.";

describe("complianceSystemPrompt", () => {
  it("gives clinic-high the hard rule set — the acmebio regression", () => {
    // Live failures this set exists to stop: recommending a diagnostic panel
    // for a described patient, interpreting a C. difficile result and naming
    // antibiotics, and comparative claims against a named competitor.
    const p = complianceSystemPrompt("Acme Bio", "clinic-high", NOTES).join("\n").toLowerCase();
    expect(p).toContain("never recommend");
    expect(p).toContain("never interpret a result");
    expect(p).toContain("never make comparative claims");
    // Intent, not exact phrasing — the sentence gained "and coverage" on
    // 2026-08-05 and a literal match made a correct improvement look like a
    // regression.
    expect(p).toMatch(/regulatory.*status is exact/);
  });

  it("treats sensitive-audience as strict too", () => {
    const p = complianceSystemPrompt("Org", "sensitive-audience", "").join("\n").toLowerCase();
    expect(p).toContain("never interpret a result");
  });

  it("does NOT put clinical refusals on a low-risk tier", () => {
    // A marketplace assistant that refuses to discuss its own products because
    // it inherited clinic rules is a different failure, equally bad.
    const p = complianceSystemPrompt("acmemarket", "wellness-low", "B2B marketplace").join("\n").toLowerCase();
    expect(p).not.toContain("never interpret a result");
    expect(p).toContain("helpfully and factually");
  });

  it("always keeps the 'still be useful' instruction on strict tiers", () => {
    // Without this, the model can pass an over-claiming suite by refusing
    // everything — and a demo that won't answer its own technology question is
    // worthless. The QA suite carries two matching must-answer guards.
    const p = complianceSystemPrompt("Org", "clinic-high", "").join("\n").toLowerCase();
    expect(p).toContain("refusing an ordinary question is also a failure");
  });

  it("carries the manifest's own complianceNotes verbatim", () => {
    // The reviewer's specific concern has to bind the model, not just the card.
    const p = complianceSystemPrompt("Acme Bio", "clinic-high", NOTES);
    expect(p.some((line) => line.includes(NOTES))).toBe(true);
  });

  it("names the organization in the opening instruction", () => {
    const p = complianceSystemPrompt("Acme Bio", "clinic-high", "");
    expect(p[0]).toContain("Acme Bio");
  });

  it("never returns an empty prompt, even with no tier and no notes", () => {
    // An empty array is indistinguishable from "no system prompt configured",
    // which is exactly the state that shipped the unguarded demo.
    for (const tier of ["clinic-high", "wellness-low", "", "nonsense-tier"]) {
      const p = complianceSystemPrompt("Org", tier, undefined);
      expect(p.length).toBeGreaterThan(0);
      expect(p[0].length).toBeGreaterThan(0);
    }
  });

  it("fails SAFE on an unknown tier — no strict rules, but never silently empty", () => {
    // A typo'd tier must not be quietly promoted to strict (over-refusing) nor
    // to nothing at all. It degrades to the low-risk shape, which is honest
    // about what it can claim.
    const p = complianceSystemPrompt("Org", "clinc-high" /* typo */, "").join("\n").toLowerCase();
    expect(p).not.toContain("never interpret a result");
    expect(p).toContain("helpfully and factually");
  });

  it("pins the strict-tier set so adding a tier is a deliberate act", () => {
    expect([...STRICT_TIERS].sort()).toEqual(["clinic-high", "sensitive-audience"]);
  });
});

describe("clinic-high additions (2026-08-05, after the Acme Clinic QA failures)", () => {
  const rules = complianceSystemPrompt("The Acme Clinic", "clinic-high", "").join("\n");

  it("sends a patient treated ELSEWHERE back to their own clinician", () => {
    // The 0%-correctness failure: asked about recovery from surgery performed
    // elsewhere, it offered a Acme Clinic consultation instead. The prompt
    // previously said only "route to the contact/consultation page", which
    // actively encouraged that.
    expect(rules).toMatch(/OUTRANKS THIS ORGANIZATION/);
    expect(rules).toMatch(/send them BACK to that clinician/);
    expect(rules).toMatch(/is a failure, not a helpful handoff/);
  });

  it("forbids recovery timelines, protocols and activity milestones", () => {
    expect(rules).toMatch(/NEVER give a recovery timeline, rehabilitation protocol/);
    expect(rules).toMatch(/never invent stages, weeks or phases/);
  });

  it("forbids explaining terms in a person's own imaging report", () => {
    // It explained what "grade 2 signal" meant. Saying what the words mean IS
    // interpreting the report, which the old wording did not close off.
    expect(rules).toMatch(/Naming what the words mean IS interpreting the report/);
  });

  it("puts a procedure decision with the person and their treating clinician", () => {
    expect(rules).toMatch(/belongs to the person and their treating clinician/);
  });

  it("covers insurance and Medicare, not just regulatory status", () => {
    expect(rules).toMatch(/covered by insurance or Medicare/);
  });

  it("forbids implying an answer is on the website when it was not found", () => {
    // It claimed FDA/Medicare information "can be found" on the clinic's pages.
    expect(rules).toMatch(/Never imply the answer is on the website/);
  });

  it("does NOT put clinic-specific rules on other strict tiers", () => {
    const sensitive = complianceSystemPrompt("X", "sensitive-audience", "").join("\n");
    expect(sensitive).not.toMatch(/rehabilitation protocol/);
    expect(sensitive).toMatch(/NEVER interpret a result/); // shared floor still applies
  });

  it("still tells the assistant to be USEFUL — refusal is also a failure", () => {
    expect(rules).toMatch(/refusing an ordinary question is also a failure/);
  });
});
