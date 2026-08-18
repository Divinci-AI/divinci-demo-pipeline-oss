import { describe, it, expect } from "vitest";
import { isCompatibleShape, extractEnShape, explainEnTsMismatch, validateEnTs } from "./copy-gen.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("isCompatibleShape", () => {
  it("matches identical structures", () => {
    expect(isCompatibleShape({ a: 1, b: { c: "x" } }, { a: 9, b: { c: "y" } })).toBe(true);
  });
  it("rejects missing/extra keys", () => {
    expect(isCompatibleShape({ a: 1, b: 2 }, { a: 1 })).toBe(false);
    expect(isCompatibleShape({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });
  it("rejects array length mismatch", () => {
    // Directional: a LONGER generated array is fine (the renderer indexes by
    // its own meta array, so extras are unused), a SHORTER one is not (it
    // would render undefined). Requiring equality is what made drchatterjee
    // ship "Acme Expert" copy for two months over 6 answers vs 5.
    expect(isCompatibleShape([1, 2, 3], [1, 2])).toBe(true);
    expect(isCompatibleShape([1, 2], [1, 2, 3])).toBe(false);
    expect(isCompatibleShape({ xs: [1, 2] }, { xs: [1, 2] })).toBe(true);
  });
  it("rejects object-vs-array and object-vs-leaf", () => {
    expect(isCompatibleShape({ a: [] }, { a: {} })).toBe(false);
    expect(isCompatibleShape({ a: "s" }, { a: { nested: 1 } })).toBe(false);
  });
  it("compares nested arrays of objects by shape, and allows extras", () => {
    const a = { stats: [{ value: "1", label: "x" }, { value: "2", label: "y" }] };
    const b = { stats: [{ value: "9", label: "p" }, { value: "8", label: "q" }] };
    expect(isCompatibleShape(a, b)).toBe(true);
    // Extra entries are not a defect. CorpusSection renders stats from
    // brand.config.corpus.stats, so an en.ts stats array is not even read —
    // rejecting a longer one only forced the whole file back to neutral copy.
    expect(isCompatibleShape(a, { stats: [{ value: "1", label: "x" }] })).toBe(true);
    // A SHORT one still fails — that is the case that renders undefined.
    expect(isCompatibleShape({ stats: [{ value: "1", label: "x" }] }, a)).toBe(false);
    // …and element SHAPE is still enforced within the positions that exist.
    expect(isCompatibleShape({ stats: [{ value: "1" }, { value: "2" }] }, b)).toBe(false);
  });
});

describe("extractEnShape (AST, no execution)", () => {
  const NEUTRAL = `
    export const en = {
      meta: { title: "t", description: "d" },
      nav: { chat: "c" },
      starters: ["a", "b", "c"],
      cards: [{ badge: "x", title: "y" }, { badge: "p", title: "q" }],
    };
    export type UIStrings = typeof en;
  `;

  it("extracts a structural skeleton matching itself", () => {
    expect(isCompatibleShape(extractEnShape(NEUTRAL), extractEnShape(NEUTRAL))).toBe(true);
  });

  it("accepts a differently-worded but same-shape file", () => {
    const customized = `
      export const en = {
        meta: { title: "MD Spine Care", description: "spine answers" },
        nav: { chat: "Chat" },
        starters: ["What is ACDF?", "Mobi-C?", "XLIF vs ALIF?"],
        cards: [{ badge: "iOS", title: "App" }, { badge: "Web", title: "Offline" }],
      };
      export type UIStrings = typeof en;
    `;
    expect(isCompatibleShape(extractEnShape(customized), extractEnShape(NEUTRAL))).toBe(true);
  });

  it("rejects a file missing a key (the class of bug that broke the build)", () => {
    const broken = `
      export const en = {
        meta: { title: "t" },           // missing description
        nav: { chat: "c" },
        starters: ["a", "b", "c"],
        cards: [{ badge: "x", title: "y" }, { badge: "p", title: "q" }],
      };
      export type UIStrings = typeof en;
    `;
    expect(isCompatibleShape(extractEnShape(broken), extractEnShape(NEUTRAL))).toBe(false);
  });

  it("rejects a wrong array length (e.g. 2 starters instead of 3)", () => {
    const broken = NEUTRAL.replace('["a", "b", "c"]', '["a", "b"]');
    expect(isCompatibleShape(extractEnShape(broken), extractEnShape(NEUTRAL))).toBe(false);
  });
});

describe("explainEnTsMismatch", () => {
  const dir = mkdtempSync(join(tmpdir(), "copygen-"));
  const write = (name: string, obj: string): string => {
    const p = join(dir, name);
    writeFileSync(p, `export const en = ${obj};\n`);
    return p;
  };

  it("says nothing when the copy is compatible", () => {
    const n = write("n1.ts", `{ hero: { headline: "x" } }`);
    const g = write("g1.ts", `{ hero: { headline: "Mach33 AI" } }`);
    expect(explainEnTsMismatch(g, n)).toBeUndefined();
  });

  it("NAMES the key the template added", () => {
    // The actual incident: `header.menuAriaLabel` was added to the template
    // with the mobile nav, every existing generated file predated it, and the
    // run silently shipped a demo titled "Acme Expert AI". The only trace was
    // "failed shape validation", which names nothing — diagnosing it by hand
    // cost most of an hour.
    const n = write("n2.ts", `{ header: { logoAriaLabel: "a", menuAriaLabel: "Menu" } }`);
    const g = write("g2.ts", `{ header: { logoAriaLabel: "Mach33 AI" } }`);
    const why = explainEnTsMismatch(g, n)!;
    expect(why).toContain("menuAriaLabel");
    expect(why).toMatch(/MISSING/);
    expect(why).toMatch(/template add it/);
  });

  it("names a short array rather than just failing", () => {
    const n = write("n3.ts", `{ bios: { bodies: ["a", "b"] } }`);
    const g = write("g3.ts", `{ bios: { bodies: ["only one"] } }`);
    expect(explainEnTsMismatch(g, n)).toMatch(/bodies has 1 entries, template expects 2/);
  });

  it("reports MULTIPLE reasons, so one fix does not reveal the next", () => {
    const n = write("n4.ts", `{ a: { x: "1", y: "2" }, b: { z: "3" } }`);
    const g = write("g4.ts", `{ a: { x: "1" }, b: {} }`);
    const why = explainEnTsMismatch(g, n)!;
    expect(why).toContain("a.y");
    expect(why).toContain("b.z");
  });

  it("does NOT pass vacuously when the object is wrapped", () => {
    // `extractEnShape` walks for `const en = <objectLiteral>`; an `as const`
    // or `satisfies` wrapper is not an object literal, so it yields the LEAF
    // sentinel — and LEAF vs LEAF compares equal, so EVERY generated file
    // would validate. A checker that silently stops checking is the failure
    // this whole area keeps producing, so it is pinned here.
    const n = join(dir, "n-wrapped.ts");
    writeFileSync(n, `export const en = { header: { a: "1" } } as const;\n`);
    const g = join(dir, "g-wrapped.ts");
    writeFileSync(g, `export const en = { totally: { different: "thing" } } as const;\n`);
    expect(validateEnTs(g, n)).toBe(false);
  });

  it("stays agreed with validateEnTs", () => {
    // Two entry points, one verdict — a boolean that disagrees with its own
    // explanation is worse than either alone.
    const n = write("n5.ts", `{ header: { a: "1", b: "2" } }`);
    const g = write("g5.ts", `{ header: { a: "1" } }`);
    expect(validateEnTs(g, n)).toBe(false);
    expect(explainEnTsMismatch(g, n)).toBeDefined();
  });
});
