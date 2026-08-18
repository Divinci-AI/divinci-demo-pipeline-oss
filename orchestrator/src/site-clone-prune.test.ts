import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { missingDependencies, pruneSiteDependencies } from "./landing.js";

/**
 * Each run clones the template into its own runs/<prospect>/<run>/landing/site
 * and installs into it. Nothing reads that install once the worker is deployed,
 * but it was never removed: 52 clones held 24GB while the run outputs they exist
 * to produce were 487MB.
 *
 * The risk in deleting it is a retry building against a tree whose node_modules
 * is gone. These tests pin the two halves of why that cannot happen — the prune
 * is confined to node_modules, and an absent node_modules reports every
 * dependency missing, so the reuse path reinstalls.
 */
let dir: string;

function seedClone(): string {
  dir = mkdtempSync(join(tmpdir(), "site-prune-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { astro: "^6" } }));
  writeFileSync(join(dir, "brand.config.ts"), "export const brand = {};");
  writeFileSync(join(dir, "wrangler.toml"), 'name = "demo"');
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist", "index.html"), "<html></html>");
  mkdirSync(join(dir, "node_modules", "astro"), { recursive: true });
  return dir;
}

beforeEach(() => { dir = ""; });
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

describe("pruneSiteDependencies", () => {
  it("removes node_modules and reports that it did", () => {
    const d = seedClone();
    expect(pruneSiteDependencies(d, {})).toBe(true);
    expect(existsSync(join(d, "node_modules"))).toBe(false);
  });

  it("keeps everything the run needs to stay reproducible", () => {
    // The deployed worker is the artifact; these are what reproduce it. A prune
    // that took dist or brand.config would destroy the run, not tidy it.
    const d = seedClone();
    pruneSiteDependencies(d, {});
    for (const keep of ["package.json", "brand.config.ts", "wrangler.toml", "dist/index.html"]) {
      expect(existsSync(join(d, ...keep.split("/")))).toBe(true);
    }
  });

  it("leaves a pruned clone in a state the reuse path REINSTALLS", () => {
    // This is the whole safety argument. ensureSiteClone reinstalls when a
    // declared dependency is not present, so a retry into a pruned run dir gets
    // a fresh install rather than a build against an empty tree.
    const d = seedClone();
    expect(missingDependencies(d)).toEqual([]);
    pruneSiteDependencies(d, {});
    expect(missingDependencies(d)).toEqual(["astro"]);
  });

  it("honours LANDING_KEEP_NODE_MODULES=1 for debugging a run in place", () => {
    const d = seedClone();
    expect(pruneSiteDependencies(d, { LANDING_KEEP_NODE_MODULES: "1" })).toBe(false);
    expect(existsSync(join(d, "node_modules"))).toBe(true);
  });

  it("only skips on exactly \"1\" — an unset or empty value still prunes", () => {
    const d = seedClone();
    expect(pruneSiteDependencies(d, { LANDING_KEEP_NODE_MODULES: "" })).toBe(true);
    expect(existsSync(join(d, "node_modules"))).toBe(false);
  });

  it("reports false rather than throwing when there is nothing to prune", () => {
    // Second call in a row, or a clone whose install never happened.
    const d = seedClone();
    pruneSiteDependencies(d, {});
    expect(pruneSiteDependencies(d, {})).toBe(false);
  });

  it("never throws when the removal itself fails", () => {
    // The deploy has ALREADY succeeded by the time this runs. A failed cleanup
    // must not turn a live worker into a reported failure.
    const d = seedClone();
    chmodSync(d, 0o500); // read+execute: cannot unlink children
    try {
      expect(() => pruneSiteDependencies(d, {})).not.toThrow();
    } finally {
      chmodSync(d, 0o700);
    }
  });
});
