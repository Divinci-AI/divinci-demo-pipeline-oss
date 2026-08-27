/**
 * The demo loop — one tick of unattended operation.
 *
 * Run it on a schedule (launchd; see docs/LOOP.md). Each tick:
 *
 *   1. takes a lock, so two ticks can never race the same run directory
 *   2. preflights auth — and stops the tick if only a human can fix it
 *   3. tears down demos past their promised expiry
 *   4. advances every in-flight run one step-set
 *   5. tops the prospect queue up when it runs low (discovery)
 *   6. intakes new prospects from the queue, while under the caps
 *   7. writes a status file, so "is the loop alive?" is answerable
 *
 * WHAT THE LOOP DELIBERATELY CANNOT DO. It never approves a gate. Intake writes
 * `approvedBy: null`, so a newly-intaken run walks to Gate 1 and parks having
 * spent nothing; every step that costs money is behind a human decision that
 * the loop can only wait for. This is what makes running it overnight safe:
 * the thing it does at 3am is *prepare work and stop*, not spend.
 *
 * The caps below exist because the failure mode of a loop is volume. A bug that
 * makes intake pick the same prospect twice is a duplicate crawl of a real
 * company's website; a bug that makes it pick every prospect is twenty.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkAuth, formatVerdict } from "./auth-preflight.js";
import { intakeProspect, loadQueue, selectNextProspect } from "./intake.js";
import {
  DISCOVER_WHEN_BACKLOG_BELOW,
  discoverProspects,
  shouldDiscover,
  unstartedBacklog,
} from "./discover.js";
import { createTask, findOrCreateProject, isAvailable } from "./review-board.js";
import { checkDemo, findDemos, summarize, selectChatProbeSlice, CHAT_PROBE_COVERAGE_TICKS, FAILING_VERDICTS } from "./demo-health.js";
import type { DemoHealth, DemoVerdict } from "./demo-health.js";
import type { RunState } from "./types.js";

const execFileP = promisify(execFile);

const orchestratorDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(orchestratorDir, "..");
const runsDir = join(repoRoot, "runs");

// .env loader — keep in sync with run.ts / teardown.ts.
{
  const envPath = join(orchestratorDir, ".env");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  }
}

// ---------------------------------------------------------------- config

const DRY = process.argv.includes("--dry-run");
const QUEUE_PATH = process.env.PROSPECT_QUEUE ?? join(repoRoot, "research", "prospect-queue.yaml");
const LOCK_PATH = join(runsDir, ".loop.lock");
const STATUS_PATH = join(runsDir, ".loop-status.json");
const ATTEMPTS_PATH = join(runsDir, ".loop-attempts.json");
// Which demos we have already raised a task for. Persisted so a demo that stays
// dark does not open a new task every hour — 24 identical tasks a day is how an
// alert channel stops being read.
const ALERTED_PATH = join(runsDir, ".loop-alerted-demos.json");
// Consecutive same-step failures per run. A run that fails identically every
// tick is not making progress and must stop being retried.
const FAILURES_PATH = join(runsDir, ".loop-failures.json");
/** When discovery last topped up the queue. */
const DISCOVERY_PATH = join(runsDir, ".loop-discovery.json");
/**
 * Minimum wall-clock gap between discovery passes.
 *
 * 12h was right at two runs a day. At fifty it would starve intake within
 * hours, and the loop would sit idle against an empty queue while every cap
 * said it had room — the same shape of invisible ceiling as one-intake-per-tick.
 */
const DISCOVER_MIN_HOURS = Number(process.env.LOOP_DISCOVER_MIN_HOURS ?? 3);

/**
 * How many identical consecutive failures before a run is quarantined.
 *
 * Acme Clinic failed at `ingest` on 8 consecutive ticks, re-running a 30-minute
 * crawl each time to no effect. One alert was raised (correctly de-duplicated)
 * and then it burned crawl and embedding spend hourly, silently, for 7 hours.
 * Retrying is right; retrying forever is not.
 */
const MAX_CONSECUTIVE_FAILURES = Number(process.env.LOOP_MAX_CONSECUTIVE_FAILURES ?? 3);

/** Runs mid-pipeline (i.e. NOT waiting on a human). A concurrency cap. */
const MAX_ACTIVE_RUNS = Number(process.env.LOOP_MAX_ACTIVE_RUNS ?? 12);

/**
 * The review backlog is TWO backlogs, and conflating them was throttling the
 * cheap one to protect the expensive one.
 *
 * A run parked at **gate1** has spent nothing: intake does recon plus one model
 * call, and every step that costs money — the crawl, the embeddings, the
 * workspace, the deployed site — is on the far side of that gate. Fifty of them
 * are fifty unreviewed corpus plans on disk.
 *
 * A run with a DEPLOYED landing page is a live demo site carrying someone's
 * brand, and that backlog genuinely cannot grow without limit: past a point,
 * building more demos does not help, it just makes more sites nobody has
 * looked at.
 *
 * ⚠️ "Deployed" is read from `state.landingUrl`, not inferred from the step.
 * This comment used to say gate2 / landing / outreach were live sites, and the
 * code believed it — but the landing step runs AFTER Gate 2, so a run parked at
 * gate2 has a release and no page at all. On 2026-08-07 that stopped intake
 * with "12 LIVE demo site(s) awaiting review … these carry someone's brand"
 * while every one of the twelve had `landingUrl=none`. The cap was enforcing a
 * claim that was false for three quarters of what it counted.
 *
 * One combined cap of 12 also meant the loop stopped taking new prospects once
 * a dozen runs awaited a human, regardless of whether those runs had cost
 * anything.
 */
/**
 * Raised 40 → 80 on 2026-08-07: a 60-prospect queue cannot run against a 40
 * ceiling that already held 38.
 *
 * Note what this bucket now contains. It was justified as "corpus plans, which
 * cost nothing" — true of gate1, and NOT true of gate2, which has already paid
 * for a crawl, embeddings and a release. Capping intake does not unspend that,
 * so the reason to bound it is reviewer attention rather than money: past some
 * point, more built demos nobody has looked at is not progress.
 *
 * The cap that still guards spend-with-a-public-face is MAX_LIVE_PARKED, which
 * is deliberately unchanged.
 */
const MAX_PENDING_REVIEW = Number(process.env.LOOP_MAX_PENDING_REVIEW ?? 80);
/**
 * Raised 12 → 42 on 2026-08-10.
 *
 * The cap is reviewer attention, not spend, and 12 stopped matching how review
 * actually happens here: Gate 3 is reviewed in batches, so the count sits near
 * zero and then jumps by thirty. At 12 the loop spent most of a week refusing
 * to intake — including four prospects handed over directly — while the real
 * blocker was a review session that had not happened yet.
 *
 * 42 is chosen against the queue: 37 demos were live when this was raised, so
 * a ceiling below that is permanently jammed and one only slightly above it
 * jams again on the next batch.
 *
 * ⚠️ This still bounds LIVE, BRANDED pages carrying someone else's name. If it
 * ever needs raising again, prefer tearing down demos that were never sent —
 * a cap that only ever moves up is not a cap.
 */
export const MAX_LIVE_PARKED = Number(process.env.LOOP_MAX_LIVE_PARKED ?? 42);

/**
 * New prospects taken per calendar day.
 *
 * Raised 2 → 50 on 2026-08-06 at Michael's direction. This is safe to raise
 * precisely BECAUSE Gate 1 sits under it: what fifty intakes a day actually
 * buys is fifty recon fetches, fifty manifest generations, and fifty review
 * tasks — not fifty crawls of strangers' websites. The spend still waits for a
 * human.
 *
 * ⚠️ What it DOES buy is fifty Gate 1 tasks a day, which is more than anyone
 * will read. Gate 1 throughput, not this number, is now the real limit on how
 * many demos get built.
 */
const MAX_NEW_RUNS_PER_DAY = Number(process.env.LOOP_MAX_NEW_RUNS_PER_DAY ?? 50);
/**
 * Intakes per tick. The loop ticks hourly, so taking one prospect per tick
 * capped throughput at 24/day no matter what the daily cap said — a limit
 * nothing named and nobody would have found by reading the caps.
 */
const MAX_INTAKE_PER_TICK = Number(process.env.LOOP_MAX_INTAKE_PER_TICK ?? 8);
/** How many runs one tick will try to advance. */
const MAX_RUNS_PER_TICK = Number(process.env.LOOP_MAX_RUNS_PER_TICK ?? 6);
/** Wall-clock ceiling for advancing a single run within a tick. */
const RUN_TIMEOUT_MS = Number(process.env.LOOP_RUN_TIMEOUT_MS ?? 45 * 60 * 1000);

/**
 * Steps that end in a human decision. A run sitting on one of these is not
 * stalled — it is waiting, correctly, and it does not count against the loop's
 * own capacity.
 */
export const GATE_STEPS = new Set(["gate1", "gate2", "landing", "outreach"]);
export function isParked(step: string): boolean {
  return GATE_STEPS.has(step);
}

// Exit codes from run.ts — duplicated deliberately rather than imported, since
// importing run.ts EXECUTES the pipeline (it is a script, not a module).
const EXIT_OK = 0;
const EXIT_GATE_PARKED = 10;
const EXIT_INFRA_DOWN = 20;
const EXIT_AUTH_EXPIRED = 30;
const EXIT_HOST_BUSY = 40;
const EXIT_RUN_LOCKED = 50;

// ---------------------------------------------------------------- lock

/**
 * Exclusive lock via O_EXCL, with stale-holder recovery. A tick that dies
 * without releasing would otherwise wedge the loop permanently — and nobody is
 * watching at 4am to clear it.
 */
function acquireLock(attempt = 1): boolean {
  mkdirSync(runsDir, { recursive: true });
  try {
    const fd = openSync(LOCK_PATH, "wx");
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (err) {
    // Anything other than "already exists" is a real filesystem problem —
    // retrying cannot fix a read-only volume or a permission error, and the
    // old code recursed on it forever.
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      console.error(`[loop] cannot take the lock at ${LOCK_PATH}: ${(err as Error).message}`);
      return false;
    }
    // Bounded: one clear of a stale lock, then give up. Unbounded recursion
    // here would spin forever against a lock nobody can remove.
    if (attempt > 2) {
      console.error(`[loop] lock at ${LOCK_PATH} could not be taken after ${attempt} attempts`);
      return false;
    }
    let held: { pid?: number; at?: string } = {};
    try {
      held = JSON.parse(readFileSync(LOCK_PATH, "utf8")) as { pid?: number; at?: string };
    } catch {
      // Unreadable or corrupt: treat as stale rather than wedging the loop.
    }
    if (held.pid && isAlive(held.pid)) return false;
    console.warn(`[loop] clearing stale lock from pid ${held.pid ?? "?"} (${held.at ?? "unknown time"})`);
    rmSync(LOCK_PATH, { force: true });
    return acquireLock(attempt + 1);
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function releaseLock(): void {
  rmSync(LOCK_PATH, { force: true });
}

// ---------------------------------------------------------------- runs

export interface ActiveRun {
  prospect: string;
  run: string;
  step: string;
  statePath: string;
  /** The environment this run was built against (state.apiUrl). */
  apiUrl?: string;
  /**
   * Whether a branded demo site is actually DEPLOYED for this run.
   *
   * Read from state.landingUrl rather than inferred from the step, because the
   * step was the wrong proxy: `landing` runs AFTER Gate 2, so a run parked at
   * gate2 has a release and no site at all. Counting those as live sites
   * stopped intake with the message "12 LIVE demo site(s) awaiting review …
   * these carry someone's brand" while all twelve had landingUrl=none.
   */
  hasLiveSite?: boolean;
}

/** Every run whose state is not `done`, oldest first. */
export function findActiveRuns(dir = runsDir): ActiveRun[] {
  const out: ActiveRun[] = [];
  if (!existsSync(dir)) return out;
  for (const prospect of readdirSync(dir)) {
    if (prospect.startsWith(".") || prospect.startsWith("__")) continue;
    let runIds: string[];
    try {
      runIds = readdirSync(join(dir, prospect));
    } catch {
      continue;
    }
    for (const run of runIds) {
      const statePath = join(dir, prospect, run, "state.json");
      const manifestPath = join(dir, prospect, run, "manifest.json");
      if (!existsSync(manifestPath)) continue;
      let step = "gate1";
      let apiUrl: string | undefined;
      let hasLiveSite = false;
      if (existsSync(statePath)) {
        try {
          const st = JSON.parse(readFileSync(statePath, "utf8")) as RunState;
          step = st.step ?? "gate1";
          apiUrl = st.apiUrl;
          hasLiveSite = !!st.landingUrl;
        } catch {
          continue;
        }
      }
      if (step === "done") continue;
      out.push({ prospect, run, step, statePath, apiUrl, hasLiveSite });
    }
  }
  return out.sort((a, b) => a.run.localeCompare(b.run));
}

/** New runs created today, counted from run-id dates. */
export function countRunsStartedToday(today: string, dir = runsDir): number {
  return findAllRunIds(dir).filter((id) => id.startsWith(today)).length;
}

/**
 * Choose which runs this tick advances, least-recently-attempted first.
 *
 * A plain `slice(0, N)` over a stably-sorted list takes the SAME N runs every
 * tick, so once the backlog exceeds N the tail is never touched again — a run
 * whose gate was approved would sit approved forever. Rotating by last-attempt
 * guarantees every run gets its turn.
 *
 * ⛔ `isSkipped` is REQUIRED, and it must be applied HERE rather than by the
 * caller after selection. A run the loop refuses to run does not get an
 * attempt stamp, so it keeps sorting first — it holds its selection slot
 * FOREVER. Once the skipped set reaches `limit`, every slot is held by a run
 * that will not move and the loop's throughput is exactly zero, while the log
 * still cheerfully reports N runs "workable".
 *
 * That is not hypothetical: with 23 quarantined runs and a limit of 14, the
 * pipeline advanced NOTHING for 34 consecutive hourly ticks and published no
 * demo, including one whose gate a human had approved.
 */
export function selectRunsToAdvance(
  runs: ActiveRun[],
  attempts: Record<string, string>,
  limit: number,
  isSkipped: (run: ActiveRun) => boolean,
): ActiveRun[] {
  return [...runs]
    .filter((r) => !isSkipped(r))
    .sort((a, b) => {
      const ka = attempts[runKey(a)] ?? "";
      const kb = attempts[runKey(b)] ?? "";
      // Never-attempted (empty string) sorts first — new work is not starved
      // by a long backlog of old work either.
      return ka.localeCompare(kb) || a.run.localeCompare(b.run);
    })
    .slice(0, limit);
}

export function runKey(r: { prospect: string; run: string }): string {
  return `${r.prospect}/${r.run}`;
}

// ------------------------------------------------- demo-alert bookkeeping

/**
 * Verdicts that ONLY the chat probe can produce.
 *
 * ⚠️ This distinction is the whole point of {@link reconcileDemoAlerts}. Every
 * other failing verdict comes from a check that runs on every demo every tick,
 * so "not failing this tick" genuinely means recovered. These two come from a
 * probe that runs on a rotating slice — see CHAT_PROBE_COVERAGE_TICKS — so for
 * 7 ticks out of 8 a chat-blocked demo is not assessed at all and reports `ok`
 * by default.
 */
export const CHAT_ONLY_VERDICTS: DemoVerdict[] = ["chat-blocked", "chat-error"];

/** One alert entry, parsed. `verdict: null` is a pre-2026-08-20 bare key. */
function parseDemoAlert(entry: string, key: string): { verdict: DemoVerdict | null } | null {
  if (entry === key) return { verdict: null };
  const prefix = `demo:${key}:`;
  return entry.startsWith(prefix) ? { verdict: entry.slice(prefix.length) as DemoVerdict } : null;
}

/**
 * Decide which failing demos deserve a NEW task, and which alerts to retire.
 *
 * ⚠️ WHY THIS IS NOT `delete every non-failing key`, which is what it was until
 * 2026-08-20. The chat probe (added 1512fb2, two weeks after this dedupe was
 * written) only runs on ~13 of 104 demos per tick. On the other 7 ticks a
 * persistently chat-blocked demo is never asked, comes back `ok`, and the old
 * code cleared its key — so the next time the rotation reached it, still
 * blocked, it opened ANOTHER task. One card per blocked demo every 8 hours,
 * forever, from a dedupe whose own comment promised "not one per tick".
 *
 * That is what turned ~3 demos banned by the 2026-08-18 abuse defect into a
 * 15-then-20 card "mass outage" that the agent fleet spent two days analysing
 * while the fleet was in fact healthy. A monitor that manufactures its own
 * volume is worse than one that stays quiet: the count itself became evidence.
 *
 * So an alert is retired only when the check that RAISED it actually ran. A
 * legacy bare key carries no verdict, so it is treated as possibly-chat and
 * held until a tick that chat-probes that demo — conservative on purpose:
 * holding an alert one extra rotation costs nothing, dropping one re-opens it.
 *
 * Pure, and returns a NEW set: the caller persists it, and a test can assert
 * the whole rotation without a filesystem or a review board.
 */
export function reconcileDemoAlerts(
  alerted: ReadonlySet<string>,
  results: DemoHealth[],
  chatSlice: ReadonlySet<string>,
): { alerted: Set<string>; toAlert: DemoHealth[] } {
  const next = new Set(alerted);
  const toAlert: DemoHealth[] = [];

  for (const r of results) {
    const key = runKey(r);

    if (FAILING_VERDICTS.includes(r.verdict)) {
      // Keyed by (demo, verdict): a demo that goes dark AFTER being
      // chat-blocked has a different problem and deserves to be said once.
      const entry = `demo:${key}:${r.verdict}`;
      if (!next.has(entry) && !next.has(key)) {
        next.add(entry);
        toAlert.push(r);
      }
      continue;
    }

    for (const e of [...next]) {
      const parsed = parseDemoAlert(e, key);
      if (!parsed) continue;
      const needsChatToClear = parsed.verdict === null || CHAT_ONLY_VERDICTS.includes(parsed.verdict);
      if (needsChatToClear && !chatSlice.has(key)) continue; // never asked — not recovered
      next.delete(e);
    }
  }

  return { alerted: next, toAlert };
}


function readAlerted(): Set<string> {
  try {
    return new Set(JSON.parse(readFileSync(ALERTED_PATH, "utf8")) as string[]);
  } catch {
    return new Set();
  }
}

function writeAlerted(s: Set<string>): void {
  try {
    writeFileSync(ALERTED_PATH, `${JSON.stringify([...s], null, 2)}\n`);
  } catch {
    /* bookkeeping must not kill the tick */
  }
}

export interface FailureRecord {
  step: string;
  count: number;
  lastAt: string;
  /**
   * The most useful line of the failure output.
   *
   * The loop already HAD this — `advanceRun` captures a tail and the review board
   * alert quotes it — but the file an operator opens after an overnight run,
   * `.loop-failures.json`, recorded only `step` and `count`. On 2026-08-06
   * acmeincubator was quarantined after three nights of a one-line npm error, and
   * recovering that line meant re-running a landing deploy by hand.
   *
   * A quarantine is precisely the moment the cause stops being reproducible on
   * demand, so it is the moment the cause must already be written down.
   */
  lastError?: string;
}

/**
 * Pick the line worth keeping out of a failure tail.
 *
 * Node puts the message on the FIRST line of a thrown Error and then a stack;
 * a shell failure usually ends with the real complaint. So prefer the first
 * line that looks like a diagnosis and fall back to the last non-empty line —
 * never the stack frames in between, which identify our code rather than the
 * problem.
 */
export function summarizeFailure(tail: string, max = 300): string | undefined {
  const lines = tail
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(
      (l) =>
        l.trim().length > 0 &&
        !/^\s*at /.test(l) && // stack frames
        // A crashing node process ends with its own version banner. It is the
        // LAST line, so the trailing-line fallback below used to select it —
        // and "Node.js v22.23.1" was recorded as the diagnosis for 12 runs
        // while the real cause sat two lines above it.
        !/^Node\.js v\d/.test(l.trim()),
    );
  if (!lines.length) return undefined;
  // `npm error code EALLOWSCRIPTS` names the failure exactly, where the
  // wrapping `Error: Command failed: npm install` says only that it failed.
  // EXTRACTED rather than line-matched: node embeds the child's stderr inside a
  // quoted, indented blob (`  stderr: 'npm error code X\n' + …`), so the code
  // rarely begins a line.
  const npmCode = lines.map((l) => l.match(/npm error code ([A-Z][A-Z0-9_]+)/)).find(Boolean);
  if (npmCode) return `npm error code ${npmCode[1]}`;

  // Structural punctuation carries no information. Excluded from every
  // candidate list rather than just the fallback: a `}` selected by the
  // keyword rule is exactly as useless as one selected by position.
  const informative = lines.filter((l) => /[A-Za-z0-9]/.test(l));

  // An explicitly thrown Error outranks everything — including a JSON blob,
  // which may not even be an error (a success payload carrying a `message`
  // field would otherwise be reported as the cause of the failure).
  const thrown = informative.find((l) =>
    /^(Error|TypeError|ReferenceError|SyntaxError|RangeError)\b/.test(l.trim()),
  );
  if (thrown) return thrown.trim().slice(0, max);

  // A PRETTY-PRINTED JSON error ends in a line that is just `}`, and none of
  // its lines match the keyword patterns below, so the trailing-line fallback
  // recorded `}` as the diagnosis. Three runs sat quarantined at the retry cap
  // with `lastError: "}"` — unretryable and undiagnosable, because the one
  // field that says why had been discarded. Pull the message out instead.
  const jsonMessage = extractJsonMessage(tail);
  if (jsonMessage) return jsonMessage.slice(0, max);

  if (!informative.length) return undefined;
  const diagnostic =
    informative.find((l) => /\b(error|failed|refused|denied|not allowed|cannot|ENOENT|EACCES)\b/i.test(l)) ??
    informative[informative.length - 1];
  return diagnostic.trim().slice(0, max);
}

/**
 * Pull a human-readable message out of a JSON error blob in `tail`.
 *
 * Scans for a balanced `{...}` and reads the usual message fields. Tolerant by
 * design: the tail is a truncated log, so most candidates will not parse, and
 * failing to find one simply hands back to the line heuristics.
 */
function extractJsonMessage(tail: string): string | undefined {
  for (let i = 0; i < tail.length; i++) {
    if (tail[i] !== "{") continue;
    let depth = 0;
    for (let j = i; j < tail.length; j++) {
      if (tail[j] === "{") depth++;
      else if (tail[j] === "}") {
        depth--;
        if (depth !== 0) continue;
        try {
          const o = JSON.parse(tail.slice(i, j + 1)) as Record<string, unknown>;
          const err = (o.error ?? o) as Record<string, unknown>;
          const msg = err?.message ?? o.message;
          if (typeof msg === "string" && msg.trim()) {
            const code = (err as { code?: unknown })?.code;
            return typeof code === "string" && code ? `${msg.trim()} (${code})` : msg.trim();
          }
        } catch {
          /* not valid JSON — keep scanning */
        }
        break;
      }
    }
  }
  return undefined;
}

/**
 * Split in-flight runs into the three groups the caps actually care about.
 *
 * The distinction that matters is WORKABLE vs everything else. `MAX_ACTIVE_RUNS`
 * is a concurrency cap on work the loop is really doing, so anything that will
 * not move this tick must not consume a slot:
 *
 *   - `parked`   — waiting on a human at a gate.
 *   - `stuck`    — quarantined: failed identically too many times, no longer
 *                  retried. Also waiting on a human, just not at a gate.
 *   - `workable` — everything else. Only these hold a concurrency slot.
 *
 * Pre-emptive, not a post-mortem: at the time of writing nothing is quarantined,
 * because the runs that were failing sat at `landing` and `gate2`, which are
 * PARKED steps and never counted toward the cap anyway. The hazard is a run
 * stuck at a WORK step (`ingest`, `vector`): quarantine stops retrying it, but
 * it would go on occupying a concurrency slot forever, and enough of those
 * would halt intake with nothing actually in flight.
 */
export function partitionRuns<T extends { step: string }>(
  all: T[],
  isStuck: (run: T) => boolean,
): { parked: T[]; stuck: T[]; workable: T[] } {
  const parked = all.filter((r) => isParked(r.step));
  const rest = all.filter((r) => !isParked(r.step));
  return { parked, stuck: rest.filter(isStuck), workable: rest.filter((r) => !isStuck(r)) };
}

/** Decide whether a run has failed identically too many times to keep trying. */
export function isQuarantined(
  rec: FailureRecord | undefined,
  step: string,
  max = MAX_CONSECUTIVE_FAILURES,
): boolean {
  return !!rec && rec.step === step && rec.count >= max;
}

/** Record a failure, resetting the counter when the run moves to a new step. */
export function recordFailure(
  rec: FailureRecord | undefined,
  step: string,
  at: string,
  tail = "",
): FailureRecord {
  // The newest error wins, but an older one is kept rather than erased by an
  // empty tail — a failure with no output must not blank the diagnosis that
  // explained the previous two.
  const lastError = summarizeFailure(tail) ?? (rec && rec.step === step ? rec.lastError : undefined);
  return rec && rec.step === step
    ? { step, count: rec.count + 1, lastAt: at, lastError }
    : { step, count: 1, lastAt: at, lastError };
}

function readFailures(): Record<string, FailureRecord> {
  try {
    return JSON.parse(readFileSync(FAILURES_PATH, "utf8")) as Record<string, FailureRecord>;
  } catch {
    return {};
  }
}

function writeFailures(f: Record<string, FailureRecord>): void {
  try {
    writeFileSync(FAILURES_PATH, `${JSON.stringify(f, null, 2)}\n`);
  } catch {
    /* bookkeeping must not kill the tick */
  }
}

function readAttempts(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(ATTEMPTS_PATH, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function writeAttempts(a: Record<string, string>): void {
  try {
    writeFileSync(ATTEMPTS_PATH, `${JSON.stringify(a, null, 2)}\n`);
  } catch {
    /* the loop must not die over its own bookkeeping */
  }
}

function findAllRunIds(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const ids: string[] = [];
  for (const prospect of readdirSync(dir)) {
    if (prospect.startsWith(".")) continue;
    try {
      for (const run of readdirSync(join(dir, prospect))) {
        if (existsSync(join(dir, prospect, run, "manifest.json"))) ids.push(run);
      }
    } catch {
      /* not a directory */
    }
  }
  return ids;
}

export interface TickReport {
  at: string;
  health?: { checked: number; failing: number; open: number };
  /** Runs left alone because they belong to a different Divinci environment. */
  skippedForeignEnv?: number;
  /** Runs no longer retried because they fail identically every tick. */
  quarantined?: string[];
  advanced: Array<{ prospect: string; run: string; from: string; outcome: string }>;
  intaken?: Array<{ prospect: string; run: string; sources: number; plannedPages: number }>;
  /** Queue top-up: what discovery proposed, kept, and why it dropped the rest. */
  discovered?: { added: number; considered: number; rejected: string[] };
  tornDown: number;
  errors: string[];
  stoppedEarly?: string;
}

/** Human-readable meaning of a run.ts exit code. */
export function describeExit(code: number): { outcome: string; stopTick: boolean; alert: boolean } {
  switch (code) {
    case EXIT_OK:
      return { outcome: "advanced", stopTick: false, alert: false };
    case EXIT_GATE_PARKED:
      return { outcome: "parked at a gate (awaiting a human)", stopTick: false, alert: false };
    case EXIT_INFRA_DOWN:
      // review board is down: every gate in every run will fail the same way, so
      // continuing the tick just repeats one failure N times.
      return { outcome: "a dependency is down", stopTick: true, alert: true };
    case EXIT_AUTH_EXPIRED:
      return { outcome: "session needs an interactive login", stopTick: true, alert: true };
    case EXIT_RUN_LOCKED:
      // Someone else — a hand-started run, or a previous tick that outlived its
      // slot — is working this directory. Not a failure, and re-running would
      // be the very thing the lock exists to prevent.
      return { outcome: "already being worked by another process — skipped", stopTick: false, alert: false };
    case EXIT_HOST_BUSY:
      // The server is still crawling this host — usually this run's own crawl,
      // which the CLI's 30-minute wait abandoned while the server carried on.
      // Not a failure and not worth an alert: the next tick picks it up.
      return { outcome: "host still being crawled server-side — will retry", stopTick: false, alert: false };
    default:
      return { outcome: `failed (exit ${code})`, stopTick: false, alert: true };
  }
}

async function advanceRun(run: ActiveRun): Promise<{ code: number; tail: string }> {
  try {
    const { stdout, stderr } = await execFileP(
      "npx",
      ["tsx", join(orchestratorDir, "src", "run.ts"), "--prospect", run.prospect, "--run", run.run],
      { cwd: orchestratorDir, timeout: RUN_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
    );
    return { code: 0, tail: tail(`${stdout}\n${stderr}`) };
  } catch (err) {
    const e = err as Error & { code?: number; stdout?: string; stderr?: string };
    return { code: typeof e.code === "number" ? e.code : 1, tail: tail(`${e.stdout ?? ""}\n${e.stderr ?? ""}`) };
  }
}

function tail(text: string, lines = 12): string {
  return text.trim().split("\n").slice(-lines).join("\n");
}

// ---------------------------------------------------------------- alerting

/**
 * Raise a review-board task for something only a human can resolve. Best-effort: if
 * the board is the thing that is down, the tick still reports through its status
 * file and exit code.
 */
async function alertHuman(title: string, body: string): Promise<void> {
  if (DRY) return console.log(`[loop] (dry-run) would alert: ${title}`);
  try {
    if (!(await isAvailable())) return console.error(`[loop] ALERT (review board unreachable): ${title}`);
    const projectId = await findOrCreateProject({
      name: "Demo Loop — operations",
      description: "Alerts raised by the unattended demo loop.",
    });
    await createTask({ title, description: body, projectId, priority: "high", status: "TO_DO", tags: ["demo-loop"] });
    console.error(`[loop] ALERT raised on the review board: ${title}`);
  } catch (err) {
    console.error(`[loop] ALERT (could not reach review board): ${title} — ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------- tick

async function tick(): Promise<TickReport> {
  const today = new Date().toISOString().slice(0, 10);
  const report: TickReport = { at: new Date().toISOString(), advanced: [], tornDown: 0, errors: [] };
  const alertedDemos = readAlerted();

  // 1. Auth. Checked once per tick rather than per run: the failure is global,
  //    and probing it N times just multiplies the log noise.
  const verdict = await checkAuth({ expectApiUrl: process.env.DIVINCI_API_URL });
  console.log(formatVerdict(verdict));
  if (!verdict.ok) {
    report.stoppedEarly = `auth: ${verdict.reason}`;
    if (verdict.needsHuman)
      await alertHuman(
        "Demo loop halted — Divinci session needs an interactive login",
        [
          "The unattended demo loop cannot authenticate and no retry will fix it.",
          "",
          `Reason: ${verdict.reason}`,
          `Profile: ${verdict.profile} (${verdict.email ?? "?"}) → ${verdict.apiUrl ?? "?"}`,
          "",
          "Fix: run `divinci auth login` on the loop host, then the next tick resumes on its own.",
        ].join("\n"),
      );
    return report;
  }

  // 2. Teardown — before intake, so expiry is honoured even on a tick that
  //    later stops early. A demo past its promised expiry is a broken promise
  //    to a real company, which outranks starting a new one.
  try {
    const { stdout } = await execFileP("npx", ["tsx", join(orchestratorDir, "src", "teardown.ts"), ...(DRY ? ["--dry-run"] : [])], {
      cwd: orchestratorDir,
      timeout: 15 * 60 * 1000,
      maxBuffer: 8 * 1024 * 1024,
    });
    report.tornDown = (stdout.match(/✓ deprecated/g) ?? []).length;
    if (report.tornDown) console.log(`[loop] tore down ${report.tornDown} expired demo(s)`);
  } catch (err) {
    report.errors.push(`teardown: ${(err as Error).message.split("\n")[0]}`);
  }

  // 2b. Health-check the demos already in the world. Runs BEFORE advancing new
  //     work: a demo that is already live and dark is a prospect looking at a
  //     broken page right now, which outranks building the next one.
  try {
    const demos = findDemos(runsDir);
    // A ROTATING slice gets the chat probe each tick, so the whole fleet is
    // covered every CHAT_PROBE_COVERAGE_TICKS hours. Probing all of them every
    // hour would spend more than this host's entire daily anonymous-chat
    // allowance at the API, and the monitor would start reporting the fleet as
    // blocked by its own traffic — a false outage indistinguishable from a real
    // one. The slot is the wall-clock hour so the rotation advances even when
    // the loop misses ticks.
    const chatSlice = new Set(
      selectChatProbeSlice(demos, new Date().getUTCHours()).map((d) => `${d.prospect}/${d.run}`),
    );
    const results = [];
    for (const d of demos)
      results.push(await checkDemo(d, undefined, { chat: chatSlice.has(`${d.prospect}/${d.run}`) }));
    const { failing, open } = summarize(results);
    report.health = { checked: results.length, failing: failing.length, open: open.length };
    console.log(
      `[loop] demo health: ${results.length} checked (${chatSlice.size} chat-probed, ` +
        `full fleet every ${CHAT_PROBE_COVERAGE_TICKS}h), ${failing.length} failing, ${open.length} open`,
    );
    for (const f of failing) console.error(`[loop]   ✗ ${f.prospect}/${f.run}: ${f.detail}`);

    // One task per failing demo, not one per tick — and, since 2026-08-20, not
    // one per ROTATION either. See reconcileDemoAlerts for why that was not the
    // same promise.
    const { alerted: nextAlerted, toAlert } = reconcileDemoAlerts(alertedDemos, results, chatSlice);
    for (const f of toAlert) {
      await alertHuman(
        `Demo DOWN — ${f.prospect} (${f.verdict})`,
        [`${f.detail}`, "", `Landing: ${f.landingUrl ?? "n/a"}`, `Release: ${f.releaseId ?? "n/a"}`].join("\n"),
      );
    }
    alertedDemos.clear();
    for (const e of nextAlerted) alertedDemos.add(e);
    writeAlerted(alertedDemos);
  } catch (err) {
    report.errors.push(`health: ${(err as Error).message.split("\n")[0]}`);
  }

  // 3. Advance in-flight runs, least-recently-attempted first.
  //
  // Runs belonging to another environment are SKIPPED, not failed. A run's
  // workspace and release exist in exactly one environment, and the 17 staging
  // runs predate the move to production — advancing one against prod would look
  // for a workspace that is not there. Letting run.ts refuse instead would end
  // the whole tick on the first mismatch and never reach the runs that DO match.
  const sessionApiUrl = verdict.apiUrl;
  const everything = findActiveRuns();
  const foreign = everything.filter((r) => r.apiUrl && sessionApiUrl && r.apiUrl !== sessionApiUrl);
  const all = everything.filter((r) => !foreign.includes(r));
  if (foreign.length) {
    report.skippedForeignEnv = foreign.length;
    console.log(
      `[loop] skipping ${foreign.length} run(s) built against another environment ` +
        `(session is ${sessionApiUrl}): ${[...new Set(foreign.map((f) => f.apiUrl))].join(", ")}`,
    );
  }
  const attempts = readAttempts();
  const failures = readFailures();
  const { parked, stuck, workable } = partitionRuns(all, (r) =>
    isQuarantined(failures[runKey(r)], r.step),
  );
  console.log(
    `[loop] ${all.length} run(s): ${workable.length} workable, ${parked.length} awaiting a human` +
      (stuck.length ? `, ${stuck.length} quarantined (need a fix; not holding a slot)` : ""),
  );
  // Quarantine is reported from the PARTITION, not from the selection, and so
  // reports every quarantined run exactly once per tick. Reporting it from
  // inside the selection loop both under-reported (only the ones that fit in
  // the tick budget) and hid the starvation: 14 QUARANTINED lines and
  // `advanced 0` reads as "the loop is busy with broken runs" when what it
  // actually means is that the tick budget was entirely consumed by them.
  for (const run of stuck) {
    const rec = failures[runKey(run)];
    report.quarantined ??= [];
    report.quarantined.push(`${runKey(run)} (${run.step}, ${rec?.count ?? 0} consecutive failures)`);
  }
  if (stuck.length)
    console.error(
      `[loop] ${stuck.length} run(s) QUARANTINED, skipped and NOT holding a tick slot: ` +
        `${stuck.map((r) => `${runKey(r)}(${r.step})`).join(", ")}. ` +
        `Fix them and clear ${FAILURES_PATH} to resume.`,
    );

  for (const run of selectRunsToAdvance(all, attempts, MAX_RUNS_PER_TICK, (r) =>
    isQuarantined(failures[runKey(r)], r.step),
  )) {
    if (DRY) {
      report.advanced.push({ prospect: run.prospect, run: run.run, from: run.step, outcome: "(dry-run) would advance" });
      continue;
    }
    attempts[runKey(run)] = new Date().toISOString();
    writeAttempts(attempts);
    const { code, tail: out } = await advanceRun(run);
    const { outcome, stopTick, alert } = describeExit(code);
    const key = runKey(run);
    // EXIT_HOST_BUSY clears the record too: a run that is WAITING must never
    // accumulate failures, or quarantine eventually parks a healthy run whose
    // only problem was that its previous crawl had not finished yet.
    if (code === EXIT_OK || code === EXIT_GATE_PARKED || code === EXIT_HOST_BUSY || code === EXIT_RUN_LOCKED)
      delete failures[key];
    else if (!stopTick) failures[key] = recordFailure(failures[key], run.step, new Date().toISOString(), out);
    writeFailures(failures);
    // Print the CAUSE, not just the exit code. `failed (exit 1)` is true and
    // useless: on 2026-08-08 every run had been dying on one npm config for
    // ~26h and the log said only that, while the actual message sat unread in
    // .loop-failures.json. A failure line that does not name a cause trains
    // whoever reads it to skim past the whole log.
    const cause = code === EXIT_OK || code === EXIT_GATE_PARKED ? undefined : summarizeFailure(out);
    console.log(`[loop] ${run.prospect}/${run.run} (${run.step}) → ${outcome}${cause ? ` — ${cause}` : ""}`);
    report.advanced.push({ prospect: run.prospect, run: run.run, from: run.step, outcome });

    // De-duplicated on (run, outcome): a run that fails the same way every
    // hour should open one task, not one per tick. Re-alerts if the failure
    // CHANGES, because that is new information.
    const alertKey = `run:${runKey(run)}:${outcome}`;
    if (alert && !alertedDemos.has(alertKey)) {
      alertedDemos.add(alertKey);
      writeAlerted(alertedDemos);
      await alertHuman(`Demo loop — ${run.prospect}/${run.run}: ${outcome}`, ["```", out, "```"].join("\n"));
    }
    if (!alert) {
      // Cleared: drop any stale failure keys for this run so a future failure
      // alerts again.
      for (const k of [...alertedDemos]) if (k.startsWith(`run:${runKey(run)}:`)) alertedDemos.delete(k);
      writeAlerted(alertedDemos);
    }
    if (stopTick) {
      report.stoppedEarly = `${run.prospect}/${run.run}: ${outcome}`;
      return report;
    }
  }

  // 4. Discovery — keep the queue fed.
  //
  // Runs BEFORE the intake caps, and is not subject to them, because the two
  // limit different things. Intake's caps are about spend and review capacity:
  // each new run crawls a real company's website and puts a demo in front of a
  // human. Discovery spends one model call and a handful of HEAD requests, and
  // its output is a queue entry that still stops dead at Gate 1.
  //
  // If it were placed after the caps it would never run on a busy day, which is
  // precisely when the queue is being drained fastest.
  await maybeDiscover(runsDir, sessionApiUrl, today, report);

  // 5. Intake — last, so a tick that is busy advancing real work does not also
  //    take on more of it.
  //
  // Loops rather than taking one prospect, because the loop ticks hourly: one
  // intake per tick is a hard 24/day ceiling that no cap names and that
  // silently overrides LOOP_MAX_NEW_RUNS_PER_DAY however high it is set.
  let startedToday = countRunsStartedToday(today);
  // A run only occupies the LIVE-site budget once a site actually exists.
  // Everything else awaiting a human — a corpus plan at gate1, a built
  // assistant at gate2 with no page deployed — is review backlog, which is
  // cheap and allowed to be deep.
  // Quarantined runs join the review backlog rather than vanishing: they do
  // need a human, and that backlog is deliberately deep, so they no longer
  // throttle intake — but they are still counted somewhere.
  const liveParked = [...parked, ...stuck].filter((r) => r.hasLiveSite).length;
  const pendingReview = parked.length + stuck.length - liveParked;

  for (let taken = 0; taken < MAX_INTAKE_PER_TICK; taken++) {
    const stop = intakeBlockedBy({
      workable: workable.length + taken,
      pendingReview: pendingReview + taken,
      liveParked,
      startedToday,
    });
    if (stop) {
      console.log(`[loop] intake stopped — ${stop}`);
      break;
    }

    let queue;
    try {
      queue = loadQueue(QUEUE_PATH);
    } catch (err) {
      report.errors.push(`queue: ${(err as Error).message}`);
      break;
    }
    const next = selectNextProspect(queue, runsDir, sessionApiUrl);
    if (!next) {
      console.log("[loop] intake stopped — queue is empty (every prospect is held or already has a run)");
      break;
    }
    if (DRY) {
      console.log(`[loop] (dry-run) would intake ${next.slug}`);
      break;
    }

    try {
      console.log(`[loop] intaking ${next.slug} (${next.url})`);
      const result = await intakeProspect({ prospect: next, runsDir });
      (report.intaken ??= []).push({
        prospect: next.slug,
        run: result.runId,
        sources: result.sourceCount,
        plannedPages: result.plannedPages,
      });
      startedToday += 1;
      console.log(
        `[loop] intaked ${next.slug}/${result.runId} — ${result.sourceCount} source(s), ${result.plannedPages} planned pages`,
      );
      // Walk it to Gate 1 immediately: the manifest is unapproved, so this spends
      // nothing and simply puts the review task in front of a human.
      const { code } = await advanceRun({ prospect: next.slug, run: result.runId, step: "gate1", statePath: "" });
      console.log(`[loop] ${next.slug}/${result.runId} → ${describeExit(code).outcome}`);
    } catch (err) {
      const msg = (err as Error).message.split("\n")[0];
      report.errors.push(`intake ${next.slug}: ${msg}`);
      await alertHuman(`Demo loop — intake failed for ${next.slug}`, msg);
      // One prospect failing recon says nothing about the next one, but a
      // failure that repeats every iteration would burn the whole tick. Stop
      // and let the next tick try with a fresh queue.
      break;
    }
  }

  return report;
}

/**
 * Why intake must not take another prospect right now, or undefined if it may.
 *
 * Pulled out and named so each limit states its own reason: a log line reading
 * "intake stopped" without which ceiling was hit is how a cap gets blamed for
 * another cap's behaviour.
 */
export function intakeBlockedBy(n: {
  workable: number;
  pendingReview: number;
  liveParked: number;
  startedToday: number;
}): string | undefined {
  if (n.startedToday >= MAX_NEW_RUNS_PER_DAY)
    return `${n.startedToday} run(s) started today (cap ${MAX_NEW_RUNS_PER_DAY})`;
  if (n.workable >= MAX_ACTIVE_RUNS)
    return `${n.workable} run(s) mid-pipeline (cap ${MAX_ACTIVE_RUNS})`;
  if (n.liveParked >= MAX_LIVE_PARKED)
    return (
      `${n.liveParked} LIVE demo site(s) awaiting review (cap ${MAX_LIVE_PARKED}). ` +
      `These carry someone's brand; more of them does not help.`
    );
  if (n.pendingReview >= MAX_PENDING_REVIEW)
    return (
      `${n.pendingReview} corpus plan(s) awaiting Gate 1 (cap ${MAX_PENDING_REVIEW}). ` +
      `These cost nothing, but nobody is reading them.`
    );
  return undefined;
}

/**
 * Top the queue up when it runs low.
 *
 * Rate-limited on wall-clock rather than on ticks: the loop ticks hourly and a
 * discovery pass costs a model call plus live fetches against strangers'
 * websites, so "once every 12 hours when we are actually short" is the right
 * frequency. The timestamp is persisted, because a loop that restarts would
 * otherwise rediscover on every boot.
 *
 * Failures here are recorded and swallowed. Discovery is a top-up, and a tick
 * that cannot think of new prospects must still advance the runs it has.
 */
async function maybeDiscover(
  runsDir: string,
  apiUrl: string | undefined,
  today: string,
  report: TickReport,
): Promise<void> {
  if (DRY) return;
  let queue;
  try {
    queue = loadQueue(QUEUE_PATH);
  } catch {
    return; // the intake step below reports the parse error properly
  }
  // Keep at least a day's intake in the queue. Deriving the floor from the
  // daily cap means raising one number cannot silently outrun the other.
  const floor = Math.max(DISCOVER_WHEN_BACKLOG_BELOW, MAX_NEW_RUNS_PER_DAY);
  const backlog = unstartedBacklog(queue, runsDir, apiUrl).length;
  if (!shouldDiscover(backlog, floor)) return;

  const last = readDiscoveryState().lastAt;
  const sinceHours = last ? (Date.now() - Date.parse(last)) / 3_600_000 : Infinity;
  if (sinceHours < DISCOVER_MIN_HOURS) {
    console.log(
      `[loop] discovery skipped — backlog ${backlog} but last pass was ${sinceHours.toFixed(1)}h ago ` +
        `(min ${DISCOVER_MIN_HOURS}h)`,
    );
    return;
  }

  console.log(`[loop] discovery — ${backlog} unstarted prospect(s) queued (floor ${floor}); sourcing more`);
  try {
    const res = await discoverProspects({
      queuePath: QUEUE_PATH,
      runsDir,
      rubricPath: join(repoRoot, "research", "adjacency-scoring.md"),
      apiUrl,
      today,
    });
    writeDiscoveryState({ lastAt: new Date().toISOString(), added: res.added });
    report.discovered = { added: res.added, considered: res.considered, rejected: res.rejected };
    console.log(
      `[loop] discovery — considered ${res.considered}, queued ${res.added}, dropped ${res.rejected.length}`,
    );
    // Every drop is named. A discovery pass that silently queues 1 of 6 looks
    // identical to one that had a bad night, and the difference matters: the
    // reasons are how we learn the prompt is asking for the wrong thing.
    for (const r of res.rejected) console.log(`[loop]   dropped: ${r}`);
  } catch (err) {
    const msg = (err as Error).message.split("\n")[0];
    report.errors.push(`discovery: ${msg}`);
    console.error(`[loop] discovery failed: ${msg}`);
  }
}

function readDiscoveryState(): { lastAt?: string } {
  try {
    return JSON.parse(readFileSync(DISCOVERY_PATH, "utf8")) as { lastAt?: string };
  } catch {
    return {};
  }
}

function writeDiscoveryState(s: { lastAt: string; added: number }): void {
  try {
    writeFileSync(DISCOVERY_PATH, `${JSON.stringify(s, null, 2)}\n`);
  } catch {
    /* bookkeeping must not kill the tick */
  }
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  if (!acquireLock()) {
    console.log("[loop] another tick holds the lock — exiting");
    process.exit(EXIT_OK);
  }
  let report: TickReport;
  try {
    report = await tick();
  } catch (err) {
    // A crashed tick must still leave a trace. Without this the status file
    // keeps yesterday's happy report while the loop dies nightly, and the only
    // signal is an unhandled-rejection stack in a log nobody opens.
    const message = (err as Error).message ?? String(err);
    report = {
      at: new Date().toISOString(),
      advanced: [],
      tornDown: 0,
      errors: [`tick crashed: ${message}`],
      stoppedEarly: `tick crashed: ${message}`,
    };
    console.error(`[loop] tick crashed: ${(err as Error).stack ?? message}`);
  } finally {
    releaseLock();
  }

  writeFileSync(STATUS_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `[loop] tick done — advanced ${report.advanced.length}, ` +
      `intaken ${report.intaken?.length ?? 0}, torn down ${report.tornDown}` +
      (report.stoppedEarly ? `, STOPPED: ${report.stoppedEarly}` : ""),
  );
  // A tick that stopped early must not look like a clean tick to launchd.
  process.exit(report.stoppedEarly ? EXIT_INFRA_DOWN : EXIT_OK);
}

/**
 * Only run when invoked directly. Without this guard, importing anything from
 * this module — a test, a future script — would START A TICK as a side effect
 * of the import, crawling a real company's website from a unit test run. This
 * is exactly why loop.ts duplicates run.ts's exit codes rather than importing
 * them: run.ts has no such guard, and importing it executes the pipeline.
 */
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) void main();
