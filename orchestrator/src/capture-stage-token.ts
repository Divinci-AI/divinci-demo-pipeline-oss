/**
 * Capture a staging bearer token from the clipboard — WITHOUT ever printing it.
 *
 * Why the clipboard and not devtools output: a token pasted into a terminal or
 * read back through a browser-automation tool lands in the session transcript,
 * and a transcript is not a place a live credential can be un-published from.
 * This repo has already had to rotate a token twice for exactly that reason.
 * So the value travels clipboard → file and is never rendered.
 *
 * Usage (after copying the token in the staging tab's console):
 *   npx tsx src/capture-stage-token.ts
 *
 * Writes orchestrator/.env.stage (mode 600, gitignored) and reports only
 * non-secret facts: a SHA-256 prefix to verify it against the source, and the
 * JWT's expiry so a stale token is diagnosed as stale rather than as "the API
 * is broken".
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const orchestratorDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outPath = join(orchestratorDir, ".env.stage");

const token = execFileSync("pbpaste", { encoding: "utf8" }).trim();

if (!token) {
  console.error("✘ clipboard is empty — copy the token first (see the console snippet)");
  process.exit(1);
}
// Shape check only. A wrong-but-plausible paste (a URL, a workspace id) should
// fail here rather than 90 seconds later as an opaque 401.
if (token.split(".").length !== 3 || token.length < 100) {
  console.error(
    `✘ clipboard does not hold a JWT (got ${token.split(".").length} dot-separated part(s), ${token.length} chars).` +
      " Nothing was written.",
  );
  process.exit(1);
}

let exp = "unknown";
let aud = "unknown";
try {
  const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as {
    exp?: number;
    aud?: string | string[];
  };
  if (payload.exp) exp = new Date(payload.exp * 1000).toISOString();
  if (payload.aud) aud = Array.isArray(payload.aud) ? payload.aud.join(", ") : payload.aud;
} catch {
  /* an opaque token is still usable — only the diagnostics are lost */
}

writeFileSync(outPath, `DIVINCI_STAGE_BEARER=${token}\n`, { mode: 0o600 });
chmodSync(outPath, 0o600);

console.log(`✓ wrote ${outPath} (mode 600, gitignored)`);
console.log(`  sha256[:16]  ${createHash("sha256").update(token).digest("hex").slice(0, 16)}`);
console.log(`  expires      ${exp}`);
console.log(`  audience     ${aud}`);
if (exp !== "unknown" && new Date(exp).getTime() < Date.now()) {
  console.error("  ⚠ ALREADY EXPIRED — re-copy a fresh token before running teardown.");
  process.exit(2);
}
