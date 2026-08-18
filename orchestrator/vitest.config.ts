import { defineConfig } from "vitest/config";
import { DRY_RUN_PLACEHOLDERS } from "./src/dry-run-placeholders.js";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY `env` IS SET HERE
 * ─────────────────────────────────────────────────────────────────────────────
 * Anything naming external infrastructure — a Cloudflare KV namespace, an R2
 * bucket, a GCP project, a workers.dev subdomain — is read through
 * `requireEnv`/`lazyEnv` and has NO default in source, so a misconfigured run
 * stops instead of quietly writing into somebody else's account
 * (see `src/require-env.ts`).
 *
 * The tests still have to run without an account. These values are obvious
 * placeholders, and they exist so a *test* never depends on real
 * infrastructure and never silently passes because a developer happened to
 * have their own credentials exported.
 *
 * ⚠️ Keep them implausible. A placeholder that looks like a real bucket name
 * is one copy-paste away from becoming a default again — which is the exact
 * failure this indirection was introduced to remove.
 *
 * This list also doubles as the answer to "what must I configure to run the
 * pipeline for real?" — see README.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    env: { ...DRY_RUN_PLACEHOLDERS },

    // Worker limits. The dry-run smoke test spawns a real `tsx src/run.ts`
    // subprocess, so an unbounded pool multiplies actual processes rather than
    // just threads.
    isolate: true,
    pool: "threads",
    poolOptions: {
      threads: {
        singleThread: false,
        maxThreads: 2,
        minThreads: 1,
      },
    },
  },
});
