// One-off: rebuild + redeploy an existing landing run via the real pipeline
// path (buildAndDeployLanding), picking up an edited brand-draft.json.
// Usage: tsx scripts/redeploy-landing.mts <prospect> <run>
import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { buildAndDeployLanding, type LandingBrandDraft } from "../src/landing.js";
import { lazyEnv } from "../src/require-env.js";

// Load orchestrator/.env (same loader semantics as run.ts).
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
if (!prospect || !run) throw new Error("usage: redeploy-landing.mts <prospect> <run>");

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const landingDir = join(repoRoot, "runs", prospect, run, "landing");
const draft = JSON.parse(readFileSync(join(landingDir, "brand-draft.json"), "utf8")) as LandingBrandDraft;
const KV = lazyEnv("LANDING_KV_NAMESPACE_ID", "the Cloudflare KV() namespace backing the landing worker");

// GENERATED MODE must be preserved on a redeploy. run.ts passes the bespoke
// homepage to buildAndDeployLanding; this script did not, so redeploying any
// of the 15 demos that have one would have silently replaced their bespoke
// design with the plain template page — a visible downgrade reported as a
// successful deploy.
const foundation = join(landingDir, "foundation.html");
const generatedHomepageHtml = existsSync(foundation) ? readFileSync(foundation, "utf8") : undefined;

console.log(
  `Redeploying ${draft.workerName}` +
    ` (${generatedHomepageHtml ? "generated mode" : "template mode"})` +
    ` corpusStats=${JSON.stringify(draft.corpusStats?.[0])}…`,
);
const res = await buildAndDeployLanding(landingDir, draft, KV(), { generatedHomepageHtml });
console.log("DEPLOYED:", JSON.stringify(res));
