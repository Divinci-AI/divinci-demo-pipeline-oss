import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { draftBioBodyCount, draftBioArrayCount, syncBioBodyArity } from "./landing.js";

/**
 * syncBioBodyArity was given the BRAND's bio count on the assumption that the
 * copy generator emits one body per bio. Where it does not, syncing the neutral
 * file to the brand's count guarantees the shape mismatch the function exists
 * to prevent — and the failure is quiet: the build keeps the NEUTRAL copy and
 * ships "Acme Expert" under the customer's own domain.
 *
 * That happened. All 17 June demos carry 2 generated bodies against 1 recorded
 * bio; rebuilding them today reverted every one to placeholder copy, and on the
 * three with no bespoke homepage that WAS the visible page.
 */
let dir: string;
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

function draft(bodies: string[]): string {
  dir = mkdtempSync(join(tmpdir(), "bio-arity-"));
  const p = join(dir, "en.draft.ts");
  writeFileSync(p, `export const en = {
  bios: {
    heading: "The team.",
    bodies: [
${bodies.map((b) => `      ${JSON.stringify(b)},`).join("\n")}
    ],
  },
};
`);
  return p;
}

describe("draftBioBodyCount", () => {
  it("counts what shape validation actually compares", () => {
    expect(draftBioBodyCount(draft(["one", "two"]))).toBe(2);
    expect(draftBioBodyCount(draft(["only one"]))).toBe(1);
  });

  it("counts the June shape that triggered the regression", () => {
    // 2 bodies while the brand records 1 bio — syncing to the brand's count
    // set the neutral file to 1 and validation failed.
    expect(draftBioBodyCount(draft(["founder bio", "second bio"]))).toBe(2);
  });

  it("counts literals, not lines — a bio may contain newlines", () => {
    expect(draftBioBodyCount(draft(["line one\\nline two", "second"]))).toBe(2);
  });

  it("is not fooled by an escaped quote inside a bio", () => {
    expect(draftBioBodyCount(draft(['he said \\"hello\\" often', "second"]))).toBe(2);
  });

  it("returns undefined when there is no draft, so the caller falls back", () => {
    dir = mkdtempSync(join(tmpdir(), "bio-arity-"));
    expect(draftBioBodyCount(join(dir, "missing.ts"))).toBeUndefined();
  });

  it("returns undefined for a draft with no bios block", () => {
    dir = mkdtempSync(join(tmpdir(), "bio-arity-"));
    const p = join(dir, "en.draft.ts");
    writeFileSync(p, `export const en = { hero: { headline: "x" } };\n`);
    expect(draftBioBodyCount(p)).toBeUndefined();
  });

  it("returns undefined rather than 0 for an empty bodies array", () => {
    // 0 would make syncBioBodyArity a no-op AND suppress the brand fallback,
    // which is the one combination that silently keeps the wrong arity.
    expect(draftBioBodyCount(draft([]))).toBeUndefined();
  });
});

/**
 * Shape validation compares EVERY parallel array under `bios`. Syncing only
 * `bodies` is not a partial fix — it leaves `roles` mismatched and produces the
 * exact rejection the sync exists to prevent, quietly, after the deploy has
 * already put the placeholder page on the internet.
 *
 * The 2026-08-10 Gate 2 batch: `bios.bodies` synced 2 → 1 correctly and the run
 * was still rejected with `en.bios.roles has 1 entries, template expects 2`.
 * Three demos went live carrying "Acme Expert" in their title, og: tags, chat
 * welcome and CTA.
 */
function neutralSite(roles: string[], bodies: string[]): string {
  dir = mkdtempSync(join(tmpdir(), "bio-sync-"));
  const uiDir = join(dir, "src", "i18n", "ui");
  mkdirSync(uiDir, { recursive: true });
  writeFileSync(
    join(uiDir, "en.ts"),
    `export const en = {
  bios: {
    heading: "The team.",
    roles: [
${roles.map((r) => `      ${JSON.stringify(r)},`).join("\n")}
    ],
    bodies: [
${bodies.map((b) => `      ${JSON.stringify(b)},`).join("\n")}
    ],
  },
};
`,
  );
  return dir;
}

function counts(siteDir: string): { roles: number; bodies: number } {
  const p = join(siteDir, "src", "i18n", "ui", "en.ts");
  const n = (key: string) => {
    const m = readFileSync(p, "utf8").match(new RegExp(`${key}:\\s*\\[([\\s\\S]*?)\\n\\s*\\],`));
    return (m?.[1].match(/(?<!\\)"(?:[^"\\]|\\.)*"/g) ?? []).length;
  };
  return { roles: n("roles"), bodies: n("bodies") };
}

describe("syncBioBodyArity", () => {
  it("syncs roles as well as bodies — the batch that shipped placeholder copy", () => {
    const site = neutralSite(["Founder", "Director"], ["one", "two"]);
    syncBioBodyArity(site, 1, 1);
    // Before the fix this was { roles: 2, bodies: 1 } — and 2 ≠ 1 is the
    // rejection, so fixing bodies alone changed nothing a customer could see.
    expect(counts(site)).toEqual({ roles: 1, bodies: 1 });
  });

  it("lets the two arrays differ — the generator is a model, not a contract", () => {
    const site = neutralSite(["Founder", "Director"], ["one", "two"]);
    syncBioBodyArity(site, 3, 1);
    expect(counts(site)).toEqual({ roles: 1, bodies: 3 });
  });

  it("defaults roleCount to count, so existing call sites keep working", () => {
    const site = neutralSite(["Founder", "Director"], ["one", "two"]);
    syncBioBodyArity(site, 1);
    expect(counts(site)).toEqual({ roles: 1, bodies: 1 });
  });

  it("is a no-op when both already match (idempotent re-deploys)", () => {
    const site = neutralSite(["Founder"], ["one"]);
    const before = readFileSync(join(site, "src", "i18n", "ui", "en.ts"), "utf8");
    syncBioBodyArity(site, 1, 1);
    expect(readFileSync(join(site, "src", "i18n", "ui", "en.ts"), "utf8")).toBe(before);
  });

  it("counts literals, not lines, when deciding the neutral file already matches", () => {
    // A neutral body containing a newline counted as two entries under the old
    // split-on-comma logic, so a matching file was rewritten every build.
    const site = neutralSite(["Founder"], ["line one\nline two"]);
    const before = readFileSync(join(site, "src", "i18n", "ui", "en.ts"), "utf8");
    syncBioBodyArity(site, 1, 1);
    expect(readFileSync(join(site, "src", "i18n", "ui", "en.ts"), "utf8")).toBe(before);
  });
});

describe("draftBioArrayCount", () => {
  it("reads roles independently of bodies", () => {
    dir = mkdtempSync(join(tmpdir(), "bio-arity-"));
    const p = join(dir, "en.draft.ts");
    writeFileSync(p, `export const en = {
  bios: {
    roles: [
      "Founder",
    ],
    bodies: [
      "one",
      "two",
    ],
  },
};
`);
    expect(draftBioArrayCount(p, "roles")).toBe(1);
    expect(draftBioArrayCount(p, "bodies")).toBe(2);
  });
});
