/**
 * `npm run health` — check every live demo, exit non-zero if any is dark.
 *
 * Suitable as a scheduled job; the loop also runs it each tick.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { existsSync, readFileSync } from "node:fs";
import { checkDemo, findDemos, summarize, type DemoHealth } from "./demo-health.js";

/**
 * Is the loop itself still running?
 *
 * Nothing else can answer this. The loop cannot alert about its own absence,
 * and on 2026-08-05 both LaunchAgents silently vanished from launchd less than
 * two hours after being installed — the loop simply stopped, and the only
 * reason anyone noticed was a manual kickstart failing. A stale status file is
 * the one durable signal, so the health check (which a human runs, and which is
 * not the loop) reports it.
 */
function loopFreshness(runsDir: string): string {
  const p = join(runsDir, ".loop-status.json");
  if (!existsSync(p)) return "⚠ the loop has never completed a tick (runs/.loop-status.json absent)";
  try {
    const { at } = JSON.parse(readFileSync(p, "utf8")) as { at?: string };
    if (!at) return "⚠ last tick has no timestamp";
    const hours = (Date.now() - new Date(at).getTime()) / 3_600_000;
    if (Number.isNaN(hours)) return "⚠ last tick timestamp is unparseable";
    return hours > 3
      ? `⚠ LOOP STALE — last tick ${hours.toFixed(1)}h ago (${at}). Check: ./launchd/install.sh status`
      : `loop: last tick ${hours < 1 ? `${Math.round(hours * 60)}m` : `${hours.toFixed(1)}h`} ago`;
  } catch {
    return "⚠ runs/.loop-status.json is unreadable";
  }
}

const orchestratorDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(orchestratorDir, "..");
const runsDir = join(repoRoot, "runs");

const json = process.argv.includes("--json");

function icon(v: DemoHealth["verdict"]): string {
  return { ok: "✓", open: "🔓", dark: "✗", unreachable: "✗", "gate-broken": "⚠", "no-unfurl": "🔗" }[v];
}

async function main(): Promise<void> {
  const demos = findDemos(runsDir);
  // Concurrent, but modestly: this fans out to real customer-facing hosts.
  const results: DemoHealth[] = [];
  const queue = [...demos];
  const workers = Array.from({ length: 6 }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      results.push(await checkDemo(next));
    }
  });
  await Promise.all(workers);
  results.sort((a, b) => a.prospect.localeCompare(b.prospect));

  if (json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const r of results)
      console.log(`${icon(r.verdict)} ${r.prospect.padEnd(18)} ${r.verdict.padEnd(12)} ${r.detail}`);
  }

  const { failing, open } = summarize(results);
  writeFileSync(
    join(runsDir, ".demo-health.json"),
    `${JSON.stringify({ at: new Date().toISOString(), checked: results.length, failing: failing.length, open: open.length, results }, null, 2)}\n`,
  );

  console.log(
    `\n${results.length} demo(s): ${results.length - failing.length - open.length} ok, ${open.length} open, ${failing.length} FAILING`,
  );
  console.log(loopFreshness(runsDir));
  if (failing.length) {
    for (const f of failing) console.error(`  ✗ ${f.prospect}/${f.run}: ${f.detail}`);
    process.exit(1);
  }
}

void main().catch((err) => {
  console.error(`health check failed: ${(err as Error).message}`);
  process.exit(2);
});
