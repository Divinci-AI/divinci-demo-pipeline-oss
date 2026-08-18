// One-off: redeploy an existing landing run using the CURRENT (hand-edited)
// foundation.html verbatim — NO claude regeneration. Splices it in as the
// generated homepage and deploys via the real pipeline path.
// Usage: tsx scripts/_dep.mts <prospect> <run>
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAndDeployLanding, type LandingBrandDraft } from "../src/landing.js";
import { lazyEnv } from "../src/require-env.js";

{
  const envPath = resolve(dirname(fileURLToPath(import.meta.url)), "../.env");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  }
}

const [prospect, run] = process.argv.slice(2);
if (!prospect || !run) throw new Error("usage: _dep.mts <prospect> <run>");

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const landingDir = join(repoRoot, "runs", prospect, run, "landing");
const draft = JSON.parse(readFileSync(join(landingDir, "brand-draft.json"), "utf8")) as LandingBrandDraft;
const KV = lazyEnv("LANDING_KV_NAMESPACE_ID", "the Cloudflare KV() namespace backing the landing worker");

// Preview Basic-Auth gate: reuse the per-run password from state.json, or mint +
// persist one (same shape as run.ts) so every hand-deploy stays password-gated.
const statePath = join(repoRoot, "runs", prospect, run, "state.json");
let state: Record<string, unknown> = {};
try { state = JSON.parse(readFileSync(statePath, "utf8")); } catch { /* no state */ }
if (!state.landingBasicAuthUser) state.landingBasicAuthUser = "preview";
if (!state.landingBasicAuthPassword) {
  state.landingBasicAuthPassword = `${prospect.replace(/[^a-z0-9]/gi, "")}-${1000 + Math.floor(Math.random() * 9000)}`;
  try { writeFileSync(statePath, JSON.stringify(state, null, 2)); } catch { /* best effort */ }
}
process.env.BASIC_AUTH_USERNAME = String(state.landingBasicAuthUser);
process.env.BASIC_AUTH_PASSWORD = String(state.landingBasicAuthPassword);
console.log(`Preview gate: ${state.landingBasicAuthUser} / ${state.landingBasicAuthPassword}`);

const foundation = readFileSync(join(landingDir, "foundation.html"), "utf8");
console.log(`Deploying ${draft.workerName} from hand-edited foundation.html (${foundation.length}b)…`);
const res = await buildAndDeployLanding(landingDir, draft, KV(), { generatedHomepageHtml: foundation });
console.log("DEPLOYED:", JSON.stringify(res));
