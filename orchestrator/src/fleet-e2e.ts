/**
 * Run the landing-template E2E suite against every DEPLOYED demo.
 *
 * Why a canonical spec source rather than each run's own copy:
 * every run dir carries a snapshot of the template's tests/e2e taken at
 * build time, so the fleet holds 44 slowly-diverging copies. Fixing a stale
 * selector in all of them is 44 edits that immediately start drifting again.
 * This runner points ONE spec tree (the template checkout) at each demo's
 * URL, so a selector is fixed once and every demo is re-tested by the fix.
 *
 * Why red-team is excluded by default: `red-team-api.spec.ts` performs REAL
 * POSTs to /api/chat-send and REAL KV writes. Across 44 live demos that is
 * genuine spend, and it consumes the free-chat quota on sites that are about
 * to be sent to prospects. Opt in per-demo with --include-mutating.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface FleetTarget {
  prospect: string;
  run: string;
  url: string;
  basicAuthUser?: string;
  basicAuthPass?: string;
}

interface StateLike {
  prospect?: string;
  run?: string;
  landingUrl?: string;
  landingBasicAuthUser?: string;
  landingBasicAuthPassword?: string;
  demoTornDownAt?: string;
}

/**
 * Which demos are worth running against.
 *
 * A torn-down demo SHOULD be unreachable, so testing it reports the success
 * of teardown as a fleet failure — the same trap `demo-health` already
 * documents. Runs with no landingUrl have nothing deployed to test.
 *
 * Where a prospect has several runs, only the NEWEST deployed one is taken:
 * the older run's worker is still live, but it is superseded, and reporting
 * failures against a demo nobody will send is noise that buries the demo
 * somebody will.
 */
export function planFleetRun(states: Array<{ dir: string; state: StateLike }>): FleetTarget[] {
  const newest = new Map<string, { run: string; t: FleetTarget }>();
  for (const { state } of states) {
    const prospect = state.prospect;
    const run = state.run;
    if (!prospect || !run || prospect === "__smoke__") continue;
    if (!state.landingUrl) continue;
    if (state.demoTornDownAt) continue;
    const prev = newest.get(prospect);
    if (prev && prev.run >= run) continue;
    newest.set(prospect, {
      run,
      t: {
        prospect,
        run,
        url: state.landingUrl.replace(/\/$/, ""),
        basicAuthUser: state.landingBasicAuthPassword
          ? (state.landingBasicAuthUser ?? "preview")
          : undefined,
        basicAuthPass: state.landingBasicAuthPassword,
      },
    });
  }
  return [...newest.values()].map((v) => v.t).sort((a, b) => a.prospect.localeCompare(b.prospect));
}

export function loadStates(runsDir: string): Array<{ dir: string; state: StateLike }> {
  const out: Array<{ dir: string; state: StateLike }> = [];
  for (const prospect of readdirSync(runsDir, { withFileTypes: true })) {
    if (!prospect.isDirectory() || prospect.name.startsWith(".")) continue;
    const pDir = join(runsDir, prospect.name);
    for (const run of readdirSync(pDir, { withFileTypes: true })) {
      if (!run.isDirectory()) continue;
      const sp = join(pDir, run.name, "state.json");
      if (!existsSync(sp)) continue;
      try {
        out.push({ dir: join(pDir, run.name), state: JSON.parse(readFileSync(sp, "utf8")) });
      } catch {
        /* a half-written state.json is not a fleet-run failure */
      }
    }
  }
  return out;
}

export interface SpecOutcome {
  passed: number;
  failed: number;
  skipped: number;
  failures: Array<{ file: string; title: string; message: string }>;
}

/** Parse Playwright's JSON reporter output into a flat tally. */
export function summarizeReport(report: unknown): SpecOutcome {
  const out: SpecOutcome = { passed: 0, failed: 0, skipped: 0, failures: [] };
  const walk = (suite: Record<string, unknown>): void => {
    for (const s of (suite.suites as Record<string, unknown>[] | undefined) ?? []) walk(s);
    for (const spec of (suite.specs as Record<string, unknown>[] | undefined) ?? []) {
      for (const t of (spec.tests as Record<string, unknown>[] | undefined) ?? []) {
        const status = t.status as string;
        if (status === "expected") out.passed++;
        else if (status === "skipped") out.skipped++;
        else {
          out.failed++;
          const results = (t.results as Record<string, unknown>[] | undefined) ?? [];
          const err = (results[results.length - 1]?.error ?? {}) as { message?: string };
          out.failures.push({
            file: String(spec.file ?? ""),
            title: String(spec.title ?? ""),
            message: (err.message ?? "").split("\n")[0].slice(0, 120),
          });
        }
      }
    }
  };
  const r = report as { suites?: Record<string, unknown>[] };
  for (const s of r.suites ?? []) walk(s);
  return out;
}
