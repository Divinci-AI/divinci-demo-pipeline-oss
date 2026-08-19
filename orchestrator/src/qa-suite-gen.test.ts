import { describe, it, expect } from "vitest";
import {
  buildQaSuitePrompt,
  validateSuiteYaml,
  stripFences,
  TIER_HAZARDS,
  QA_PURPOSES,
} from "./qa-suite-gen.js";
import type { Manifest } from "./types.js";

const manifest = {
  prospect: "acme",
  prospectName: "Acme Diagnostics",
  anchorCustomer: "attio:deals/x",
  run: "2026-08-04-001",
  created: "2026-08-04",
  complianceTier: "clinic-high",
  complianceNotes: "Regulated IVD catalog.",
  budgets: { crawlPages: 100, embeddingTokens: 1 },
  evalQueries: ["What panels do you offer?", "How does the instrument work?"],
  sources: [],
  approvedBy: null,
  approvedAt: null,
} as unknown as Manifest;

function suite(tests: string): string {
  return [
    "divinciQASuite: v1",
    "metadata:",
    '  name: "Acme suite"',
    "scoreGenerators: []",
    "tests:",
    tests,
  ].join("\n");
}

const okTest = [
  '  - prompt: "Which assays are FDA-cleared?"',
  '    purpose: "evaluation"',
  '    expectedResponse: "States clearance only where sourced; otherwise a failure."',
].join("\n");

describe("buildQaSuitePrompt", () => {
  it("carries the tier's hazard, not a generic instruction", () => {
    const p = buildQaSuitePrompt({ manifest, corpusBrief: "GI panel page" });
    expect(p).toContain(TIER_HAZARDS["clinic-high"]);
    expect(p).not.toContain(TIER_HAZARDS["commerce-medium"]);
  });

  it("demands regression guards — a refuse-everything assistant must not ace it", () => {
    const p = buildQaSuitePrompt({ manifest, corpusBrief: "" });
    expect(p).toMatch(/REGRESSION GUARDS/);
    expect(p).toMatch(/refuses everything/);
  });

  it("forbids rubrics that hardcode an unverifiable answer key", () => {
    // The acmebio suite documents this exact trap: a rubric asserting which
    // products are cleared would grade a wrong regulatory claim as correct.
    const p = buildQaSuitePrompt({ manifest, corpusBrief: "" });
    expect(p).toMatch(/wrong answer key|source-fidelity/);
  });

  it("pins purpose to the one accepted value", () => {
    const p = buildQaSuitePrompt({ manifest, corpusBrief: "" });
    expect(p).toContain("silently discarded");
  });

  it("includes the corpus brief so tests target THIS corpus", () => {
    const p = buildQaSuitePrompt({ manifest, corpusBrief: "Barcoded Magnetic Bead page" });
    expect(p).toContain("Barcoded Magnetic Bead page");
  });

  it("covers every compliance tier — a missing tier would emit an undefined hazard", () => {
    for (const tier of Object.keys(TIER_HAZARDS) as Array<Manifest["complianceTier"]>) {
      const p = buildQaSuitePrompt({
        manifest: { ...manifest, complianceTier: tier },
        corpusBrief: "",
      });
      expect(p).not.toContain("undefined");
    }
  });
});

describe("validateSuiteYaml", () => {
  it("accepts a well-formed suite", () => {
    expect(validateSuiteYaml(suite(okTest)).tests).toHaveLength(1);
  });

  it("REJECTS a purpose outside the enum — the importer would drop it silently", () => {
    const bad = suite(
      [
        '  - prompt: "Q"',
        '    purpose: "adversarial"',
        '    expectedResponse: "R"',
      ].join("\n"),
    );
    expect(() => validateSuiteYaml(bad)).toThrow(/DISCARD/);
  });

  it("accepts every documented purpose value", () => {
    for (const purpose of QA_PURPOSES) {
      const y = suite(
        [`  - prompt: "Q"`, `    purpose: "${purpose}"`, `    expectedResponse: "R"`].join("\n"),
      );
      expect(() => validateSuiteYaml(y)).not.toThrow();
    }
  });

  it("rejects a test with no rubric — an empty rubric scores nothing", () => {
    const bad = suite([`  - prompt: "Q"`, `    purpose: "evaluation"`].join("\n"));
    expect(() => validateSuiteYaml(bad)).toThrow(/expectedResponse/);
  });

  it("rejects a missing v1 header", () => {
    expect(() => validateSuiteYaml("tests: []")).toThrow(/divinciQASuite/);
  });

  it("rejects an empty tests list", () => {
    expect(() => validateSuiteYaml(suite("") + "\n")).toThrow(/tests\[\] is empty|empty/);
  });

  it("rejects prose that is not YAML at all", () => {
    expect(() => validateSuiteYaml("Sure! Here is your suite:")).toThrow();
  });

  it("enforces a minimum test count when asked", () => {
    expect(() => validateSuiteYaml(suite(okTest), 6)).toThrow(/expected at least 6/);
  });
});

describe("stripFences", () => {
  it("unwraps a fenced block the model added despite instructions", () => {
    expect(stripFences("```yaml\ndivinciQASuite: v1\n```")).toBe("divinciQASuite: v1");
  });

  it("leaves unfenced output alone", () => {
    expect(stripFences("divinciQASuite: v1")).toBe("divinciQASuite: v1");
  });
});
