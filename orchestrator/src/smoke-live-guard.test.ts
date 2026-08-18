import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SMOKE_PROSPECT, smokeLiveRefusal } from "./run-policy.js";
import { DRY_RUN_PLACEHOLDERS } from "./dry-run-placeholders.js";

const orchestratorDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The documented smoke command performed a REAL production run for as long as
 * it was documented — see smokeLiveRefusal's header for what it created. These
 * tests are the reason that cannot come back silently.
 */
describe("the synthetic fixture cannot run against a live API", () => {
  it("refuses __smoke__ when DRY_RUN is not set", () => {
    expect(smokeLiveRefusal(SMOKE_PROSPECT, {})).toContain("refusing to run the synthetic");
  });

  it("names the fix in the refusal — a guard that only says no costs an hour", () => {
    const msg = smokeLiveRefusal(SMOKE_PROSPECT, {}) ?? "";
    expect(msg).toContain("npm run smoke");
    expect(msg).toContain("DRY_RUN=1");
  });

  it("allows the dry run the docs actually mean", () => {
    expect(smokeLiveRefusal(SMOKE_PROSPECT, { DRY_RUN: "1" })).toBeNull();
  });

  it("allows a deliberate live run behind SMOKE_ALLOW_LIVE", () => {
    expect(smokeLiveRefusal(SMOKE_PROSPECT, { SMOKE_ALLOW_LIVE: "1" })).toBeNull();
  });

  it("only the exact string '1' opens either door — no accidental truthiness", () => {
    for (const v of ["0", "", "true", "yes", "false"]) {
      expect(smokeLiveRefusal(SMOKE_PROSPECT, { DRY_RUN: v }), `DRY_RUN=${v}`).not.toBeNull();
      expect(smokeLiveRefusal(SMOKE_PROSPECT, { SMOKE_ALLOW_LIVE: v }), `SMOKE_ALLOW_LIVE=${v}`).not.toBeNull();
    }
  });

  it("never blocks a real prospect", () => {
    for (const p of ["mdspinecare", "smoke", "__smoke__x", "acme"]) {
      expect(smokeLiveRefusal(p, {}), p).toBeNull();
    }
  });

  /**
   * The unit tests above prove the predicate. This proves it is WIRED — the
   * failure mode being guarded against is a correct predicate nobody calls.
   * It must exit non-zero BEFORE the auth preflight, so it also holds for
   * someone with a live session, which is exactly who got burned.
   */
  it("run.ts exits non-zero on a live __smoke__ invocation, without calling out", () => {
    let code = 0;
    let output = "";
    try {
      output = execFileSync(
        "npx",
        ["tsx", "src/run.ts", "--prospect", SMOKE_PROSPECT, "--run", "dry"],
        {
          cwd: orchestratorDir,
          env: {
            ...process.env,
            // DRY_RUN deliberately unset — this is the invocation the README had.
            DRY_RUN: "",
            SMOKE_ALLOW_LIVE: "",
            // ⚠️ AND the API is pointed somewhere unreachable, because THIS TEST
            // MUST NOT BE ABLE TO DO THE THING IT TESTS FOR. Mutation-testing the
            // guard by unwiring it ran the fixture live against production for 60
            // seconds and created a real workspace, which had to be deleted by
            // hand. A test that verifies a guard against live writes must not
            // depend on that guard to avoid making them.
            DIVINCI_API_URL: "http://127.0.0.1:1",
          },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 30_000,
        },
      );
    } catch (e: unknown) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      code = err.status ?? -1;
      output = (err.stdout ?? "") + (err.stderr ?? "");
    }
    expect(code).not.toBe(0);
    expect(output).toContain("refusing to run the synthetic");
    // If it got as far as authenticating, the guard is in the wrong place.
    expect(output).not.toContain("auth: ok");
  });

  it("npm run smoke exists and forces DRY_RUN itself", () => {
    const pkg = JSON.parse(
      readFileSync(resolve(orchestratorDir, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.smoke, "npm run smoke is what every doc now points at").toBeDefined();

    const entry = readFileSync(resolve(orchestratorDir, "scripts/smoke.mts"), "utf8");
    expect(entry).toContain('DRY_RUN: "1"');
    expect(entry).toContain(SMOKE_PROSPECT);
  });

  /**
   * `npm test` passed with no configuration while the smoke command died on the
   * first infrastructure variable — because the placeholders lived in the vitest
   * config and nowhere else. One declaration, both consumers, or they drift
   * apart again and only one path stays runnable by a stranger.
   */
  it("tests and the smoke run read the SAME placeholder declaration", () => {
    const declaration = readFileSync(resolve(orchestratorDir, "src/dry-run-placeholders.ts"), "utf8");
    for (const key of Object.keys(DRY_RUN_PLACEHOLDERS)) {
      expect(declaration, `${key} must be declared in the shared module`).toContain(key);
    }
    for (const consumer of ["vitest.config.ts", "scripts/smoke.mts"]) {
      const text = readFileSync(resolve(orchestratorDir, consumer), "utf8");
      expect(text, `${consumer} must import the shared placeholders`).toContain("DRY_RUN_PLACEHOLDERS");
      for (const key of Object.keys(DRY_RUN_PLACEHOLDERS)) {
        expect(text, `${consumer} re-declares ${key} — that is the drift`).not.toContain(`${key}:`);
      }
    }
  });

  it("every placeholder is unusable — a plausible one becomes a default again", () => {
    for (const [key, value] of Object.entries(DRY_RUN_PLACEHOLDERS)) {
      expect(value, `${key}=${value} does not look obviously fake`).toMatch(/invalid|not-set/);
    }
  });

  /**
   * THE DURABLE HALF. The guard above stops a live smoke run; this stops the
   * DOCUMENTATION from telling anyone to attempt one.
   *
   * The command was wrong in the README, in AGENTS.md and in the setup skill
   * from the day each was written, and nothing noticed — no test read the
   * docs. Prose is exempt (the warnings explaining the trap have to be able to
   * quote it); only fenced shell blocks are checked, because those are what a
   * reader copies.
   */
  it("no fenced command documents a __smoke__ run without DRY_RUN", () => {
    const repoRoot = resolve(orchestratorDir, "..");
    const skip = new Set(["node_modules", ".git", "runs", "dist"]);
    const docs: string[] = [];
    (function walk(dir: string) {
      for (const entry of readdirSync(dir)) {
        if (skip.has(entry)) continue;
        const full = resolve(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith(".md")) docs.push(full);
      }
    })(repoRoot);
    // A scan that matches nothing passes vacuously — refuse rather than "pass".
    expect(docs.length).toBeGreaterThan(3);

    const offenders: string[] = [];
    for (const doc of docs) {
      let inFence = false;
      readFileSync(doc, "utf8").split("\n").forEach((line, i) => {
        if (line.trimStart().startsWith("```")) { inFence = !inFence; return; }
        if (!inFence) return;
        if (!line.includes("--prospect __smoke__")) return;
        if (line.includes("DRY_RUN=1")) return;
        offenders.push(`${doc.slice(repoRoot.length + 1)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(
      offenders,
      `Documented as a runnable command, this performs a REAL production run.\n` +
        `Use \`npm run smoke\`, or prefix DRY_RUN=1:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });
});
