// The early-abort arithmetic.
//
// ⚠️ The "archive.org shape" below is SYNTHETIC, not observed. It was derived
// when the crawl step was silently capped at 5 minutes, so no real crawl was
// ever seen past that point and a slow host was indistinguishable from an
// unfinishable one. archive.org itself now completes and publishes cleanly.
// The healthy shapes ARE real, and they are the half that matters: they pin
// the guard against killing a crawl that would have succeeded.
import { crawlBudgetVerdict } from "../src/crawl-budget.js";

let fail = 0;
const ok = (c, m) => { if (!c) { console.log("  ❌ " + m); fail++; } else console.log("  ✅ " + m); };

const MIN = 60_000;
const D = 25 * MIN;   // deadline
const G = 5 * MIN;    // grace

// ── Never judge inside the grace period ─────────────────────────────────────
ok(!crawlBudgetVerdict({ elapsedMs: 1 * MIN, done: 0, total: 150, deadlineMs: D, graceMs: G }).abort,
   "silent during grace even with zero rendered");
ok(!crawlBudgetVerdict({ elapsedMs: G, done: 0, total: 9999, deadlineMs: D, graceMs: G }).abort,
   "boundary: exactly at grace is still silent");

// ── Synthetic: a frontier too large to finish ───────────────────────────────
// 20 of 150 after 5 min = 15s/page → 37min projected against a 25min budget.
// No real host has produced this shape; see the header.
const arch = crawlBudgetVerdict({ elapsedMs: 5.5 * MIN, done: 20, total: 150, deadlineMs: D, graceMs: G });
ok(arch.abort, "aborts a crawl that cannot finish in budget");
ok(/projected \d+min vs 25min budget/.test(arch.reason), "reason states projection vs budget");
ok(/20\/150/.test(arch.reason), "reason states progress — the thing the old error omitted");

// ── Nothing rendered at all ─────────────────────────────────────────────────
const dead = crawlBudgetVerdict({ elapsedMs: 6 * MIN, done: 0, total: 150, deadlineMs: D, graceMs: G });
ok(dead.abort && /rendered NOTHING/.test(dead.reason), "aborts when nothing rendered past grace");

// ── The three that SUCCEEDED must not be killed ─────────────────────────────
// en.wikivoyage.org: 197 records, crawl finished well inside budget.
ok(!crawlBudgetVerdict({ elapsedMs: 5.5 * MIN, done: 150, total: 197, deadlineMs: D, graceMs: G }).abort,
   "does NOT abort en.wikivoyage.org's real shape");
// docs.nodejs.org: comparable.
ok(!crawlBudgetVerdict({ elapsedMs: 5.5 * MIN, done: 120, total: 150, deadlineMs: D, graceMs: G }).abort,
   "does NOT abort docs.nodejs.org's real shape");
// dspace.mit.edu: 150 records but only 10 usable — SLOW yield is not slow
// CRAWLING, and this guard must not conflate them. It rendered all 150.
ok(!crawlBudgetVerdict({ elapsedMs: 5.5 * MIN, done: 150, total: 150, deadlineMs: D, graceMs: G }).abort,
   "does NOT abort dspace.mit.edu (low usable yield is a different problem)");

// ── A missing/zero `total` must never cause a false abort ───────────────────
// Projecting from `done` alone can never exceed a deadline we are still inside.
ok(!crawlBudgetVerdict({ elapsedMs: 20 * MIN, done: 5, total: 0, deadlineMs: D, graceMs: G }).abort,
   "absent total does not trigger an abort");
ok(!crawlBudgetVerdict({ elapsedMs: 20 * MIN, done: 5, total: undefined ?? 0, deadlineMs: D, graceMs: G }).abort,
   "undefined total coerced to 0 is still safe");

// ── Just-barely cases around the boundary ───────────────────────────────────
// 100 pages in 10 min = 6s/page; 150 total → 15 min projected. Inside budget.
ok(!crawlBudgetVerdict({ elapsedMs: 10 * MIN, done: 100, total: 150, deadlineMs: D, graceMs: G }).abort,
   "keeps a crawl projected to land just inside budget");
// 50 pages in 10 min = 12s/page; 150 total → 30 min. Outside.
ok(crawlBudgetVerdict({ elapsedMs: 10 * MIN, done: 50, total: 150, deadlineMs: D, graceMs: G }).abort,
   "drops a crawl projected to land just outside budget");

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
