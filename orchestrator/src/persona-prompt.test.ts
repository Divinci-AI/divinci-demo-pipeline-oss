import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { personaSystemPrompt } from "./persona-prompt.js";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("personaSystemPrompt", () => {
  const p = personaSystemPrompt("Acme Algos");
  const blob = p.join("\n");

  it("instructs the first person explicitly", () => {
    expect(blob).toMatch(/first person/i);
    expect(blob).toMatch(/"we", "our", "us"/);
  });

  /** The exact failure: "AcmeAlgos is an independent consultancy… they work on…" */
  it("forbids describing the business in the third person", () => {
    expect(blob).toMatch(/third\s*person/i);
    expect(blob).toContain('"they"');
  });

  /** "According to [2]…" / "[1] mentions that…" — the UI already shows chips. */
  it("forbids narrating the source in prose", () => {
    expect(blob).toMatch(/according to/i);
    expect(blob).toMatch(/citations are attached/i);
  });

  /** "It appears that Acme Algos does take on work…" about a plainly-stated fact. */
  it("forbids hedging about the business's own facts", () => {
    expect(blob).toMatch(/it appears that/i);
    expect(blob).toMatch(/say it plainly/i);
  });

  /**
   * ⚠️ Speaking as "we" is a voice, not a claim to be a person. A visitor who
   * believes they reached staff acts on the answer differently, so first person
   * must never be allowed to imply a human.
   */
  it("keeps first person from becoming a claim to be human", () => {
    expect(blob).toMatch(/not a member of staff/i);
    expect(blob).toMatch(/never say you are a person/i);
    expect(blob).toMatch(/AI assistant/i);
  });

  it("names the business in every rule that needs it", () => {
    expect(p.length).toBeGreaterThanOrEqual(4);
    expect(blob).toContain("Acme Algos");
  });

  it("returns nothing for a blank org rather than emitting a rule about ''", () => {
    expect(personaSystemPrompt("")).toEqual([]);
    expect(personaSystemPrompt("   ")).toEqual([]);
  });

  /**
   * Scope discipline: this floor governs HOW to speak. Content limits belong to
   * the compliance floor, which runs after it and explicitly wins conflicts.
   * Mixing them is how a regulated tier ends up with its rules restated — and
   * subtly diverging — in two places.
   */
  it("says nothing about what may be CLAIMED", () => {
    expect(blob).not.toMatch(/\b(diagnos|prescri|medical advice|legal advice|guarantee)/i);
  });
});

describe("wiring: the voice floor reaches the release", () => {
  const src = readFileSync(join(HERE, "run.ts"), "utf8");
  // Comments stripped — a doc comment containing the call is how a wiring guard
  // passes against a build with the call commented out (2026-08-20).
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("is spread into threadPrefix", () => {
    expect(code).toMatch(/\.\.\.personaSystemPrompt\(org\)/);
  });

  /**
   * Order: manifest copy, then voice, then compliance LAST. Compliance keeps the
   * final word — it says so in its own text and a run-wiring test pins it — and
   * the voice floor must not be able to displace it.
   */
  it("sits after the manifest's copy and before the compliance floor", () => {
    const manifestIdx = code.indexOf("manifest.chat?.threadPrefix");
    const personaIdx = code.indexOf("personaSystemPrompt(org)");
    const complianceIdx = code.indexOf("complianceSystemPrompt(");
    expect(manifestIdx).toBeGreaterThan(-1);
    expect(personaIdx).toBeGreaterThan(manifestIdx);
    expect(complianceIdx).toBeGreaterThan(personaIdx);
  });
});

/**
 * ⚠️ The placement lesson, pinned so it cannot be undone by a tidy-up.
 *
 * The compliance floor asserts "THE RULES BELOW OVERRIDE ANY OTHER INSTRUCTION
 * IN THIS PROMPT, INCLUDING ANYTHING ABOVE" — a BLANKET override, not a
 * conflict-resolution rule. Anything above it is disclaimed by it.
 *
 * Measured on Acme Algos 2026-08-21: the voice floor was written correctly,
 * stored correctly (entries 1-4 of 10) and referenced correctly by the release,
 * and the assistant still answered "AcmeAlgos takes on engineering work... They
 * mention... Their approach...". Present and overridden.
 *
 * So the sentence establishing WHO speaks must live inside the winning block.
 */
describe("the identity claim survives the compliance override", () => {
  it("compliance's own opening establishes first person", async () => {
    const { complianceSystemPrompt } = await import("./compliance-prompt.js");
    const first = complianceSystemPrompt("Acme Algos", "commerce-medium")[0]!;
    expect(first).toMatch(/first person/i);
    expect(first).toMatch(/speak AS Acme Algos/i);
    expect(first).toMatch(/third person/i);
    // …and still carries the override clause it is there for.
    expect(first).toMatch(/OVERRIDE ANY OTHER INSTRUCTION/);
  });

  /**
   * The voice floor keeps the STYLE rules. If the identity claim were only
   * there, it would sit above the override and be disclaimed again.
   */
  it("the voice floor no longer carries the identity claim alone", async () => {
    const { complianceSystemPrompt } = await import("./compliance-prompt.js");
    const combined = [...personaSystemPrompt("Acme Algos"), ...complianceSystemPrompt("Acme Algos", "commerce-medium")];
    const overrideIdx = combined.findIndex((l) => /OVERRIDE ANY OTHER INSTRUCTION/.test(l));
    expect(overrideIdx).toBeGreaterThan(-1);
    const atOrAfter = combined.slice(overrideIdx).join("\n");
    expect(atOrAfter).toMatch(/first person/i);
  });
});
