/**
 * Per-source yield: what each discovery source actually produced.
 *
 * The question this answers is "is <source> still worth running?", and the
 * answer has to be a funnel rather than a count. A source that queues 50
 * prospects of which 2 reach a live demo is worse than one that queues 6 of
 * which 4 do, and a bare "queued" number ranks them the wrong way round.
 *
 * Two rules this file exists to enforce:
 *
 *   1. NOTHING IS SILENTLY DROPPED. A run whose slug is not in the queue lands
 *      in `unattributed` and is reported. The tempting alternative — skip it —
 *      makes the totals disagree with the runs directory while every
 *      individual number looks reasonable, which is how a report earns trust
 *      it has not got.
 *   2. INFERRED YIELD IS LABELLED. Sources ending `:backfilled` are stamped
 *      from an assumption about history, not from an observation. They are
 *      counted, and they are never merged into the measured buckets.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isInferred, sourceOf, type Source } from "./provenance.js";

export interface SourceYield {
  source: Source;
  inferred: boolean;
  /** In the queue and attributed to this source. */
  queued: number;
  /** Has at least one run directory — i.e. we spent a crawl on it. */
  started: number;
  /** A run reached a published demo link. */
  live: number;
  /** A run got as far as approved outreach. */
  outreach: number;
  /** Runs currently quarantined and needing a human. */
  quarantined: number;
  /**
   * Median age in days of this source's STARTED runs, or null if none.
   *
   * Reported because the funnel is not age-neutral and reading it as if it
   * were produces a confident wrong answer. Measured 2026-08-24: direct
   * prospects converted to outreach 2 where discovered converted 33, which
   * reads as a damning quality gap — until you notice the direct cohort's
   * median run was ten days younger and outreach is the LAST gate. A cohort
   * that has not had time to finish looks identical to one that failed.
   */
  medianAgeDays: number | null;
}

export interface YieldReport {
  bySource: SourceYield[];
  /** Runs on disk whose slug matches no queue entry — reported, never dropped. */
  unattributed: string[];
  totals: { queued: number; started: number; live: number; outreach: number; quarantined: number };
}

interface RunOutcome {
  live: boolean;
  outreach: boolean;
  /** When the run started, from its first log entry. */
  startedAt: number | null;
}

/** Read one run's outcome. An unreadable state file is "not live", never a throw. */
function readRunOutcome(dir: string): RunOutcome {
  try {
    const s = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as Record<string, unknown>;
    const log = Array.isArray(s.log) ? (s.log as Array<{ at?: string }>) : [];
    const at = log[0]?.at ? Date.parse(log[0].at) : NaN;
    return {
      live: typeof s.demoLink === "string" && s.demoLink.length > 0,
      outreach: typeof s.outreachApprovedBy === "string" && s.outreachApprovedBy.length > 0,
      startedAt: Number.isFinite(at) ? at : null,
    };
  } catch {
    return { live: false, outreach: false, startedAt: null };
  }
}

function runDirsBySlug(runsDir: string): Map<string, string[]> {
  const bySlug = new Map<string, string[]>();
  if (!existsSync(runsDir)) return bySlug;
  for (const slug of readdirSync(runsDir)) {
    if (slug.startsWith(".") || slug.startsWith("__")) continue; // dotfiles + __smoke__
    const slugDir = join(runsDir, slug);
    let runs: string[];
    try {
      // manifest.json OR state.json. `hasRun()` in intake.ts — the function that
      // decides whether a prospect has been started — keys on manifest.json,
      // which intake writes BEFORE the first step runs. Counting only
      // state.json here would make this report's "started" mean something
      // narrower than the pipeline's, so a freshly intaken run would show as
      // queued-but-not-started and every source's conversion rate would read
      // slightly high.
      runs = readdirSync(slugDir).filter(
        (r) => existsSync(join(slugDir, r, "manifest.json")) || existsSync(join(slugDir, r, "state.json")),
      );
    } catch {
      continue; // a file where a directory was expected
    }
    if (runs.length) bySlug.set(slug, runs.map((r) => join(slugDir, r)));
  }
  return bySlug;
}

/** Slugs currently quarantined. Keys look like `slug/run-id`. */
function quarantinedSlugs(runsDir: string): Set<string> {
  try {
    const raw = JSON.parse(readFileSync(join(runsDir, ".loop-failures.json"), "utf8")) as Record<string, unknown>;
    return new Set(Object.keys(raw).map((k) => k.split("/")[0]));
  } catch {
    return new Set();
  }
}

export function computeYield(
  queue: Array<{ slug: string; source?: string; requestedBy?: string; directSeq?: number }>,
  runsDir: string,
  /** Injectable clock — a median-age column that moves with the wall clock is untestable. */
  now?: number,
): YieldReport {
  const runs = runDirsBySlug(runsDir);
  const quarantined = quarantinedSlugs(runsDir);

  const acc = new Map<Source, SourceYield>();
  const bump = (src: Source): SourceYield => {
    let row = acc.get(src);
    if (!row) {
      row = { source: src, inferred: isInferred(src), queued: 0, started: 0, live: 0, outreach: 0, quarantined: 0, medianAgeDays: null };
      acc.set(src, row);
    }
    return row;
  };

  const ages = new Map<Source, number[]>();
  const seen = new Set<string>();
  for (const p of queue) {
    const row = bump(sourceOf(p));
    row.queued += 1;
    seen.add(p.slug);
    const dirs = runs.get(p.slug);
    if (!dirs) continue;
    row.started += 1;
    // A prospect counts as live/outreach if ANY of its runs got there — a
    // second run after a failed first is a retry, not a second prospect.
    if (dirs.some((d) => readRunOutcome(d).live)) row.live += 1;
    if (dirs.some((d) => readRunOutcome(d).outreach)) row.outreach += 1;
    if (quarantined.has(p.slug)) row.quarantined += 1;
    // Oldest run for this prospect — the point the funnel started for it.
    const starts = dirs.map((d) => readRunOutcome(d).startedAt).filter((n): n is number => n !== null);
    if (starts.length) {
      const arr = ages.get(sourceOf(p)) ?? [];
      arr.push(Math.min(...starts));
      ages.set(sourceOf(p), arr);
    }
  }

  const NOW = now ?? Date.now();
  for (const [src, xs] of ages) {
    const row = acc.get(src);
    if (!row || !xs.length) continue;
    const sorted = [...xs].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    row.medianAgeDays = Math.round((NOW - median) / 86_400_000);
  }

  const unattributed = [...runs.keys()].filter((slug) => !seen.has(slug)).sort();

  const bySource = [...acc.values()].sort((a, b) => b.started - a.started || b.queued - a.queued);
  const totals = bySource.reduce(
    (t, r) => ({
      queued: t.queued + r.queued,
      started: t.started + r.started,
      live: t.live + r.live,
      outreach: t.outreach + r.outreach,
      quarantined: t.quarantined + r.quarantined,
    }),
    { queued: 0, started: 0, live: 0, outreach: 0, quarantined: 0 },
  );

  return { bySource, unattributed, totals };
}

const pct = (n: number, d: number): string => (d === 0 ? "  — " : `${Math.round((n / d) * 100)}%`.padStart(4));

/** One compact block, safe to print every tick. */
export function renderYield(report: YieldReport): string {
  const lines: string[] = [];
  // Width is derived, not hardcoded: a registered source with a longer name
  // than the header allows would otherwise shove every column right on its own
  // row only, and a misaligned table is read as a broken one.
  const width = Math.max(18, ...report.bySource.map((r) => r.source.length + (r.inferred ? 2 : 0))) + 2;
  lines.push(
    "source yield".padEnd(width) + "queued  started    live  outreach  quarantined   live/started   median age",
  );
  for (const r of report.bySource) {
    const label = (r.source + (r.inferred ? " *" : "")).padEnd(width);
    lines.push(
      `${label}${String(r.queued).padStart(6)}${String(r.started).padStart(9)}` +
        `${String(r.live).padStart(8)}${String(r.outreach).padStart(10)}` +
        `${String(r.quarantined).padStart(13)}${pct(r.live, r.started).padStart(15)}` +
        `${(r.medianAgeDays === null ? "—" : `${r.medianAgeDays}d`).padStart(13)}`,
    );
  }
  if (report.bySource.some((r) => r.inferred)) {
    lines.push("  * inferred from history, not measured — do not quote as a source's real rate");
  }
  if (report.unattributed.length) {
    // Loud, because the alternative is totals that quietly disagree with disk.
    lines.push(
      `  ${report.unattributed.length} run(s) match no queue entry and are in NO source above: ` +
        report.unattributed.slice(0, 6).join(", ") +
        (report.unattributed.length > 6 ? ", …" : ""),
    );
  }
  return lines.join("\n");
}
