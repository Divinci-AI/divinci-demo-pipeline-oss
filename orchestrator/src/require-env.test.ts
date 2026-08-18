import { describe, it, expect, afterEach } from "vitest";
import { requireEnv, lazyEnv, MissingEnvError } from "./require-env.js";

const NAME = "__REQUIRE_ENV_TEST__";

afterEach(() => {
  delete process.env[NAME];
});

describe("requireEnv", () => {
  it("returns the value when set", () => {
    process.env[NAME] = "a-real-value";
    expect(requireEnv(NAME)).toBe("a-real-value");
  });

  it("throws when unset", () => {
    expect(() => requireEnv(NAME)).toThrow(MissingEnvError);
  });

  /**
   * `FOO=` in a .env file is a far more common way to "unset" something than
   * deleting the line. Treating it as set would hand the caller an empty
   * bucket name or namespace id — which is never meaningful and, worse, is the
   * shape most likely to be silently concatenated into a URL or a path.
   */
  it("treats an empty value as unset", () => {
    process.env[NAME] = "";
    expect(() => requireEnv(NAME)).toThrow(MissingEnvError);
  });

  it("treats a whitespace-only value as unset", () => {
    process.env[NAME] = "   ";
    expect(() => requireEnv(NAME)).toThrow(MissingEnvError);
  });

  it("names the variable AND its purpose — the error is the documentation", () => {
    // Someone hitting this has an unconfigured checkout and no other clue.
    // A bare "missing env var" sends them to grep; the purpose sends them to
    // the right dashboard.
    expect(() => requireEnv(NAME, "the widget registry it writes to")).toThrow(
      /__REQUIRE_ENV_TEST__ — the widget registry it writes to/,
    );
  });
});

describe("lazyEnv", () => {
  /**
   * ⚠️ THE POINT OF THE WHOLE MODULE.
   *
   * A module-level `const X = requireEnv("X")` throws at IMPORT time. That
   * breaks two things at once: `run.ts` loads `orchestrator/.env` AFTER the
   * module graph is evaluated, so the read happens before the file that
   * configures it is read; and every test that merely imports the module dies
   * during collection rather than at an assertion.
   *
   * If someone "simplifies" lazyEnv back to an eager read, this test fails
   * before any of the downstream damage shows up.
   */
  it("does NOT read the environment until it is called", () => {
    delete process.env[NAME];
    const get = lazyEnv(NAME, "something"); // must not throw
    process.env[NAME] = "set-after-construction";
    expect(get()).toBe("set-after-construction");
  });

  it("memoizes, so the read happens once", () => {
    process.env[NAME] = "first";
    const get = lazyEnv(NAME);
    expect(get()).toBe("first");
    process.env[NAME] = "second";
    expect(get()).toBe("first");
  });

  /**
   * The FAILURE is deliberately not memoized. A caller that throws, gets
   * configured, and retries in the same process — which is exactly what a test
   * or a long-running loop does — must see the new value rather than a cached
   * error from before it was set.
   */
  it("does not cache the failure", () => {
    const get = lazyEnv(NAME);
    expect(() => get()).toThrow(MissingEnvError);
    process.env[NAME] = "configured-late";
    expect(get()).toBe("configured-late");
  });

  it("throws the same error type as requireEnv", () => {
    const get = lazyEnv(NAME, "the bucket");
    expect(() => get()).toThrow(MissingEnvError);
    expect(() => get()).toThrow(/the bucket/);
  });
});

describe("the infrastructure variables have no defaults anywhere", () => {
  /**
   * The regression this guards is the one that motivated the module: an
   * account-specific identifier reappearing as a `?? "literal"` fallback.
   *
   * Such a default does not fail loudly when it is wrong — it SUCCEEDS,
   * against somebody else's Cloudflare namespace or R2 bucket or GCP project,
   * and the operator gets no signal at all. Behavioural defaults (model names,
   * thresholds, timeouts) are fine and are deliberately not covered here.
   */
  it("no source file gives an infra variable a fallback", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    const INFRA = [
      "LANDING_KV_NAMESPACE_ID",
      "DEMO_ASSETS_R2_BUCKET",
      "DEMO_ASSETS_R2_BASE",
      "VERTEX_PROJECT",
      "CF_WORKERS_SUBDOMAIN",
    ];
    const roots = [
      dirname(fileURLToPath(import.meta.url)),
      join(dirname(fileURLToPath(import.meta.url)), "..", "scripts"),
    ];

    const offenders: string[] = [];
    for (const root of roots) {
      for (const f of readdirSync(root)) {
        if (!/\.(ts|mts|mjs)$/.test(f) || f.endsWith(".test.ts")) continue;
        const src = readFileSync(join(root, f), "utf8");
        for (const v of INFRA) {
          // `process.env.X ?? "…"` or `process.env.X || "…"`
          if (new RegExp(String.raw`process\.env\.${v}\s*(\?\?|\|\|)\s*["'\`]`).test(src)) {
            offenders.push(`${f}: ${v}`);
          }
        }
      }
    }
    expect(offenders, "these give account-specific infra a fallback default").toEqual([]);
  });
});
