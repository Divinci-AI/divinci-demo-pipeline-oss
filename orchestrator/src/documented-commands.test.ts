import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Documentation rots quietly. A README or a skill telling an operator to run a
 * command that no longer exists is worse than no documentation — it is
 * confidently wrong, and an AI agent following a skill will run it, fail, and
 * try to work around a problem that does not exist.
 *
 * This covers the half that can be checked offline: `npm run …` against
 * package.json. The `divinci …` half needs the CLI installed and lives in
 * .github/workflows/documented-commands.yml, on a schedule — the CLI is an
 * external dependency that can break these docs without anyone touching this
 * repository, so it needs a check that runs when nothing has changed.
 */
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function markdownFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git" || entry === "runs") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) markdownFiles(p, acc);
    else if (entry.endsWith(".md")) acc.push(p);
  }
  return acc;
}

describe("every command the documentation tells you to run exists", () => {
  const docs = markdownFiles(REPO);
  const scripts = Object.keys(
    JSON.parse(readFileSync(join(REPO, "orchestrator", "package.json"), "utf8")).scripts ?? {},
  );

  it("finds the documentation to check (guards against silently scanning nothing)", () => {
    // A scan that matches no files passes vacuously — coverage-shaped nothing.
    expect(docs.length).toBeGreaterThan(3);
    expect(docs.some((d) => d.endsWith("README.md"))).toBe(true);
    expect(docs.some((d) => d.includes(".claude/skills"))).toBe(true);
  });

  it("every `npm run <script>` names a real script", () => {
    const missing: string[] = [];
    for (const doc of docs) {
      const text = readFileSync(doc, "utf8");
      for (const m of text.matchAll(/npm run ([a-z][a-z0-9:-]*)/g)) {
        const name = m[1];
        // `npm run build` inside a fenced block may belong to the landing
        // template, which is a separate repository cloned at run time.
        if (name === "build") continue;
        if (!scripts.includes(name)) {
          missing.push(`${doc.replace(REPO + "/", "")}: npm run ${name}`);
        }
      }
    }
    expect([...new Set(missing)], "documented scripts that do not exist").toEqual([]);
  });
});
