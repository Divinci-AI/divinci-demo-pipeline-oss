import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { missingDependencies } from "./landing.js";

/**
 * The template clone is reused across builds and `git reset --hard origin/main`
 * brings in whatever the template now declares — but node_modules is untracked,
 * so a template commit that ADDS a dependency leaves the clone's package.json
 * and node_modules disagreeing. Adding @resvg/resvg-js for the unfurl card made
 * every existing clone fail its build with ERR_MODULE_NOT_FOUND.
 *
 * The first attempt at this guard diffed the lockfile across the reset. That
 * only catches the run that performs the update: a clone left drifted by an
 * earlier failed run compares equal to itself and stays broken forever. It did,
 * on the very next attempt. These tests pin the property that actually matters
 * — declared vs installed, right now — rather than how the drift arose.
 */
let dir: string;

function seed(pkg: object, installed: string[]) {
  dir = mkdtempSync(join(tmpdir(), "site-clone-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  for (const name of installed) mkdirSync(join(dir, "node_modules", ...name.split("/")), { recursive: true });
  return dir;
}

afterEach(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => { dir = ""; });

describe("missingDependencies", () => {
  it("reports nothing when every declared package is installed", () => {
    const d = seed({ dependencies: { astro: "^6" }, devDependencies: { tsx: "^4" } }, ["astro", "tsx"]);
    expect(missingDependencies(d)).toEqual([]);
  });

  it("catches a dependency the template added after this clone was installed", () => {
    const d = seed({ dependencies: { astro: "^6", "@resvg/resvg-js": "^2" } }, ["astro"]);
    expect(missingDependencies(d)).toEqual(["@resvg/resvg-js"]);
  });

  it("resolves SCOPED names as a nested directory, not a literal one", () => {
    // node_modules/@resvg/resvg-js — not node_modules/"@resvg/resvg-js".
    // Getting this wrong reports every scoped package as missing forever, so
    // the build reinstalls on every single deploy.
    const d = seed({ dependencies: { "@resvg/resvg-js": "^2" } }, ["@resvg/resvg-js"]);
    expect(missingDependencies(d)).toEqual([]);
  });

  it("checks devDependencies too — the build runs from them", () => {
    // `npm run build` is `tsx scripts/build-og.ts && astro build`, and tsx is a
    // devDependency. Ignoring devDeps would miss exactly the failure we hit.
    const d = seed({ dependencies: {}, devDependencies: { tsx: "^4" } }, []);
    expect(missingDependencies(d)).toEqual(["tsx"]);
  });

  it("reports everything missing when node_modules does not exist at all", () => {
    const d = seed({ dependencies: { astro: "^6", react: "^19" } }, []);
    expect(missingDependencies(d)).toEqual(["astro", "react"]);
  });

  it("returns empty rather than throwing on an unreadable package.json", () => {
    // A dependency check must never be the thing that breaks a deploy.
    dir = mkdtempSync(join(tmpdir(), "site-clone-"));
    writeFileSync(join(dir, "package.json"), "{ not json");
    expect(missingDependencies(dir)).toEqual([]);
  });

  it("returns empty when there is no package.json", () => {
    dir = mkdtempSync(join(tmpdir(), "site-clone-"));
    expect(missingDependencies(dir)).toEqual([]);
  });
});
