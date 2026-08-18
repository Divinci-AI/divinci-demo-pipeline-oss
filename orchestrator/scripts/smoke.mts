#!/usr/bin/env node
/**
 * `npm run smoke` — the whole pipeline against the synthetic fixture, calling
 * nothing and needing no credentials.
 *
 * This exists as a script rather than a shell one-liner in package.json for two
 * reasons. It has to set DRY_RUN itself — the flag is an ENVIRONMENT variable,
 * and the README once documented `--run dry` as though it were the mode, which
 * ran the fixture live against production. And `VAR=x cmd` is POSIX-shell only,
 * so the one-liner would not work on Windows.
 *
 * The placeholders are only applied where they are ABSENT, so an operator who
 * has real infrastructure configured still runs against their own names.
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DRY_RUN_PLACEHOLDERS } from "../src/dry-run-placeholders.js";

const orchestratorDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const env: NodeJS.ProcessEnv = { ...process.env, DRY_RUN: "1" };
for (const [key, value] of Object.entries(DRY_RUN_PLACEHOLDERS)) {
  if (!env[key]) env[key] = value;
}

const { status } = spawnSync(
  "npx",
  ["tsx", "src/run.ts", "--prospect", "__smoke__", "--run", "dry", ...process.argv.slice(2)],
  { cwd: orchestratorDir, env, stdio: "inherit" },
);
process.exit(status ?? 1);
