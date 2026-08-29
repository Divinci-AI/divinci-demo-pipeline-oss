/**
 * Every relative import must resolve to a file git actually TRACKS.
 *
 * THE FAILURE THIS CATCHES: a source file that imports a module which exists
 * on the author's disk but was never committed. Everything passes locally —
 * `tsc`, the whole suite, the app itself — because the working tree HAS the
 * file. A fresh clone just fails. This happened in the upstream repository
 * this project was extracted from, and it is the single most likely way for
 * `main` here to break for a first-time contributor while looking healthy to
 * whoever pushed it.
 *
 * That is why this checks git's index rather than the filesystem: the
 * filesystem is exactly the thing that lies here. `existsSync` would pass on
 * every machine that has the problem and fail on none of them.
 *
 * A file on disk but not in the repo is a normal intermediate state while you
 * work. The bug is only ever committing something that DEPENDS on one.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const SRC = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const REPO = resolve(SRC, "../..");

/**
 * Imports known to be unresolved, with the reason and the date noticed.
 *
 * ACCEPTED DEBT, NEVER A SILENCER. It exists so that a known break cannot hide
 * the NEXT one. Shrink it by committing the file; do not grow it to make a red
 * suite green. The third test below fails once an entry stops describing a
 * real break, so a stale entry cannot quietly become a permanent exemption.
 */
const KNOWN_UNCOMMITTED: Record<string, string> = {};

function trackedFiles(): Set<string> {
  const out = execFileSync("git", ["ls-files", "orchestrator/src"], { cwd: REPO, encoding: "utf8" });
  return new Set(out.split("\n").map((l) => l.trim()).filter(Boolean));
}

function sourceFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "orchestrator/src/*.ts"], { cwd: REPO, encoding: "utf8" });
  return out.split("\n").map((l) => l.trim()).filter((l) => l.endsWith(".ts"));
}

/** `./x.js` in TS-with-NodeNext means `x.ts` on disk. Also try the other suffixes. */
function candidatesFor(spec: string, fromFile: string): string[] {
  const base = resolve(dirname(join(REPO, fromFile)), spec);
  const withoutJs = base.replace(/\.js$/, "");
  return [
    `${withoutJs}.ts`,
    `${withoutJs}.tsx`,
    `${withoutJs}.mts`,
    base,
    join(base, "index.ts"),
    join(withoutJs, "index.ts"),
  ].map((p) => relative(REPO, p));
}

describe("committed code may not import uncommitted code", () => {
  const tracked = trackedFiles();
  const files = sourceFiles();

  it("finds source files to check (guards against the check silently covering nothing)", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(tracked.size).toBeGreaterThan(50);
  });

  it("every relative import resolves to a tracked file", () => {
    const broken: string[] = [];
    for (const file of files) {
      const text = readFileSync(join(REPO, file), "utf8");
      /**
       * Only LINE-START import/export statements.
       *
       * A looser `from ["']...["']` match reads import statements out of
       * STRING LITERALS: landing.ts emits source code for the landing page
       * template, so it contains `\`import { en } from "./ui/en";\`` as data.
       * Four false positives, all from generated code. Real imports sit at the
       * start of a line; embedded ones do not.
       */
      const specs = [
        ...text.matchAll(/^\s*(?:import|export)\b[^\n]*?\bfrom\s*["'](\.[^"']+)["']/gm),
        ...text.matchAll(/^\s*import\s*["'](\.[^"']+)["']/gm),
        ...text.matchAll(/^\s*(?:const|let|var)?[^\n]*?\bawait\s+import\s*\(\s*["'](\.[^"']+)["']/gm),
      ].map((m) => m[1])
        // A template-interpolated specifier cannot be resolved statically.
        .filter((spec) => !spec.includes("${"));
      for (const spec of specs) {
        const cands = candidatesFor(spec, file);
        if (cands.some((c) => tracked.has(c))) continue;
        const leaf = cands[0].split("/").pop() ?? cands[0];
        if (KNOWN_UNCOMMITTED[leaf]) continue;
        broken.push(`${file} imports ${spec} -> none of [${cands.slice(0, 3).join(", ")}] is tracked`);
      }
    }
    expect(broken, `committed code importing uncommitted code:\n  ${broken.join("\n  ")}`).toEqual([]);
  });

  it("the known-uncommitted list still describes a REAL break, so it cannot rot into a silencer", () => {
    // If someone commits canva-deck.ts, this fails and the entry gets deleted —
    // which is the point. A baseline that outlives its cause is a lie.
    for (const leaf of Object.keys(KNOWN_UNCOMMITTED)) {
      const stillMissing = !tracked.has(`orchestrator/src/${leaf}`);
      expect(stillMissing, `${leaf} is now tracked — delete it from KNOWN_UNCOMMITTED`).toBe(true);
    }
  });
});
