/**
 * CLI: run the canonical landing-template E2E suite against every deployed demo.
 *
 *   npx tsx src/fleet-e2e-cli.ts [--template DIR] [--concurrency N]
 *                                [--include-mutating] [--only PROSPECT,...]
 *
 * Sequentialish on purpose (default 3): each target drives a real Chromium
 * against a live worker. Twelve at once melts the laptop and starts producing
 * timeouts that look like demo failures — which is the exact class of false
 * signal this whole exercise exists to remove.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadStates, planFleetRun, summarizeReport, type FleetTarget, type SpecOutcome } from "./fleet-e2e.js";

const args = process.argv.slice(2);
const flag = (n: string, d?: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? (args[i + 1] ?? "") : d;
};
const TEMPLATE = flag("--template", join(process.env.HOME ?? "", "Documents/divinci-landing-template"))!;
const CONCURRENCY = Number(flag("--concurrency", "3"));
const INCLUDE_MUTATING = args.includes("--include-mutating");
const ONLY = (flag("--only", "") ?? "").split(",").filter(Boolean);
const RUNS = join(process.env.HOME ?? "", "Documents/divinci-demo-pipeline/runs");
const OUT = "/tmp/fleet-e2e";

if (!existsSync(join(TEMPLATE, "tests/e2e"))) {
  console.error(`✘ no spec tree at ${TEMPLATE}/tests/e2e — pass --template DIR`);
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

let targets = planFleetRun(loadStates(RUNS));
if (ONLY.length) targets = targets.filter((t) => ONLY.includes(t.prospect));
if (!targets.length) {
  console.error("✘ no deployed demos selected — refusing to report success on an empty run");
  process.exit(1);
}

console.log(
  `running ${INCLUDE_MUTATING ? "ALL" : "read-only"} specs against ${targets.length} demo(s), ${CONCURRENCY} at a time`,
);
if (!INCLUDE_MUTATING) console.log("(red-team excluded: it makes real chat sends + KV writes on live demos)");

function runOne(t: FleetTarget): Promise<{ t: FleetTarget; outcome: SpecOutcome | null; note?: string }> {
  return new Promise((resolve) => {
    const reportPath = join(OUT, `${t.prospect}.json`);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      E2E_BASE_URL: t.url,
      E2E_DEPLOYED_URL: t.url,
      PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath,
      // FORCE_COLOR makes Playwright's JSON reporter emit ANSI inside strings,
      // which survives JSON.parse and then poisons every message we print.
      FORCE_COLOR: "0",
    };
    if (t.basicAuthPass) {
      env.E2E_BASIC_AUTH_USER = t.basicAuthUser ?? "preview";
      env.E2E_BASIC_AUTH_PASS = t.basicAuthPass;
    }
    const argv = ["playwright", "test", "tests/e2e", "--reporter=json"];
    if (!INCLUDE_MUTATING) argv.push("--grep-invert", "Red-team");

    const child = spawn("npx", argv, { cwd: TEMPLATE, env });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("error", (e) => resolve({ t, outcome: null, note: String(e).slice(0, 90) }));
    child.on("close", () => {
      // Playwright exits non-zero when tests fail — that is data, not an error.
      // Only an unparseable report means we learned nothing.
      //
      // With PLAYWRIGHT_JSON_OUTPUT_NAME set the reporter writes to that FILE
      // and leaves stdout empty, so prefer the file and fall back to stdout.
      try {
        const raw = existsSync(reportPath)
          ? readFileSync(reportPath, "utf8")
          : stdout.slice(stdout.indexOf("{"));
        resolve({ t, outcome: summarizeReport(JSON.parse(raw)) });
      } catch {
        resolve({ t, outcome: null, note: "no parseable report" });
      }
    });
  });
}

const results: Array<{ t: FleetTarget; outcome: SpecOutcome | null; note?: string }> = [];
let cursor = 0;
async function worker(): Promise<void> {
  while (cursor < targets.length) {
    const t = targets[cursor++];
    const r = await runOne(t);
    results.push(r);
    const o = r.outcome;
    console.log(
      `${o && o.failed === 0 ? "✓" : "✘"} ${t.prospect.padEnd(30)} ` +
        (o ? `${o.passed} passed, ${o.failed} failed, ${o.skipped} skipped` : `NO RESULT — ${r.note}`),
    );
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));

const ran = results.filter((r) => r.outcome);
const clean = ran.filter((r) => r.outcome!.failed === 0);
console.log(`\n=== ${clean.length}/${results.length} demos clean; ${results.length - ran.length} produced no result ===`);

// Which failures are FLEET-WIDE vs demo-specific. A defect on 40 demos is one
// bug in the template; a defect on one is that demo. Printing them
// undifferentiated is how 27 identical failures read as 27 problems.
const byTitle = new Map<string, string[]>();
for (const r of ran) for (const f of r.outcome!.failures) {
  const k = `${f.file} › ${f.title}`;
  byTitle.set(k, [...(byTitle.get(k) ?? []), r.t.prospect]);
}
if (byTitle.size) {
  console.log("\nfailures, most widespread first:");
  for (const [k, who] of [...byTitle.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${String(who.length).padStart(3)}×  ${k}`);
    if (who.length <= 3) console.log(`        ${who.join(", ")}`);
  }
}
writeFileSync(join(OUT, "summary.json"), JSON.stringify(results, null, 2));
console.log(`\nreports in ${OUT}`);
