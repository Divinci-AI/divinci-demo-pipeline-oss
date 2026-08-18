#!/usr/bin/env node
/**
 * Verify that every `divinci …` command this repo's documentation tells you to
 * run still exists in the installed CLI.
 *
 * WHY THIS IS NOT PART OF THE MAIN TEST SUITE
 * The CLI is an EXTERNAL dependency. It can rename or remove a command without
 * anyone touching this repository, so the documentation rots on someone else's
 * release schedule. A check that only runs on our commits would therefore go
 * stale exactly when it matters, which is why the workflow that calls this runs
 * on a SCHEDULE as well as on doc changes.
 *
 * It uses `--help`, which needs no authentication, no network beyond the
 * install, and no account. Nothing here can spend money or touch a workspace.
 *
 *   node orchestrator/scripts/check-documented-cli.mjs
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function markdown(dir, acc = []) {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".git" || e === "runs") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) markdown(p, acc);
    else if (e.endsWith(".md")) acc.push(p);
  }
  return acc;
}

const docs = markdown(REPO);
if (docs.length < 4) {
  // A scan that matches nothing passes vacuously. Refuse rather than "pass".
  console.error(`✗ expected to find documentation to check, found ${docs.length} file(s)`);
  process.exit(1);
}

// `divinci <group>` or `divinci <group> <sub>`; flags and prose are not commands.
const found = new Map(); // "group sub" -> Set(doc)
for (const doc of docs) {
  const text = readFileSync(doc, "utf8");
  for (const m of text.matchAll(/\bdivinci ([a-z][a-z-]*)(?: ([a-z][a-z-]*))?/g)) {
    const [, group, sub] = m;
    if (group.startsWith("-")) continue;
    const key = sub && !sub.startsWith("-") ? `${group} ${sub}` : group;
    if (!found.has(key)) found.set(key, new Set());
    found.get(key).add(relative(REPO, doc));
  }
}

let version = "unknown";
try {
  version = execFileSync("divinci", ["--version"], { encoding: "utf8" }).trim();
} catch {
  console.error("✗ the `divinci` CLI is not installed — npm i -g @divinci-ai/cli");
  process.exit(1);
}

/**
 * ⚠️ EXIT CODE IS NOT AN EXISTENCE TEST, and this is the whole subtlety here.
 *
 * `divinci frobnicate --help` exits 0 — commander does not error on an unknown
 * command when --help is present, it silently prints the ROOT help instead. A
 * first version of this script probed exit status, passed a deliberately
 * invented command, and would have reported the docs healthy forever.
 *
 * Probing WITHOUT --help does distinguish them ("error: unknown command"), but
 * it would also EXECUTE anything that happens to be real — against a live
 * account, spending real money. Not acceptable in a docs check.
 *
 * So: run --help, which never executes anything, and detect the fallback by
 * comparing the output to the help one level up. A real command prints its own
 * help; an invented one reproduces its parent's verbatim.
 */
const helpOf = (args) => {
  try {
    return execFileSync("divinci", [...args, "--help"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000,
    });
  } catch (e) {
    return (e.stdout ?? "") + (e.stderr ?? "");
  }
};

const rootHelp = helpOf([]);

function exists(cmd) {
  const parts = cmd.split(" ");
  const own = helpOf(parts);
  const parent = parts.length > 1 ? helpOf(parts.slice(0, -1)) : rootHelp;
  return own.trim() !== parent.trim();
}

console.log(`checking ${found.size} documented command(s) against divinci ${version}\n`);

const missing = [];
for (const [cmd, where] of [...found].sort()) {
  if (exists(cmd)) {
    console.log(`  ok       divinci ${cmd}`);
  } else {
    console.log(`  MISSING  divinci ${cmd}   (${[...where].join(", ")})`);
    missing.push({ cmd, where: [...where] });
  }
}

if (missing.length) {
  console.error(
    `\n✗ ${missing.length} documented command(s) no longer exist in divinci ${version}.\n` +
      `  The documentation is wrong, not the CLI — an agent following a skill will\n` +
      `  run these and try to work around a failure that is not its fault.`,
  );
  process.exit(1);
}
console.log(`\n✓ all ${found.size} documented commands exist in divinci ${version}`);
