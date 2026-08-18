import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { COVERAGE_HALT_THRESHOLD, DEFAULT_COVERAGE_THRESHOLD, auditCoverage } from "./coverage-audit.js";

/**
 * The Gate 2 coverage halt.
 *
 * A demo built on a fraction of the prospect's site does not reach them without
 * a human saying so. BioRenew shipped at 28% coverage and the Gate 2 reviewer
 * had nothing in front of them saying so.
 *
 * The halt itself lives in run.ts, where it is entangled with review-board polling
 * and process.exit — so these tests pin the DECISION (via auditCoverage, which
 * is pure) and assert the wiring's load-bearing properties against the source.
 * Source assertions are narrow on purpose: each one names a property that, if
 * quietly changed, turns the gate back into a no-op.
 */

const RUN_TS = readFileSync(new URL("./run.ts", import.meta.url), "utf8");
/** Comments quote the old shapes to warn against them; assert on CODE. */
const CODE = RUN_TS.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("halt threshold", () => {
  it("is stricter than the warn threshold, not the same number", () => {
    // 80% is "tell me", 60% is "stop". Collapsing them makes every warning a
    // blocking failure, which is how a gate gets routed around.
    expect(COVERAGE_HALT_THRESHOLD).toBeLessThan(DEFAULT_COVERAGE_THRESHOLD);
  });

  it("would have halted BioRenew at 8 of 29 pages", () => {
    const a = auditCoverage({
      sitemapUrls: Array.from({ length: 29 }, (_, i) => `https://b.com/p${i}`),
      fileTitles: Array.from({ length: 8 }, (_, i) => `URL: https://b.com/p${i} 2026-1-1`),
    });
    expect(a.verdict).toBe("under-crawled");
    expect(a.coverage).toBeLessThan(COVERAGE_HALT_THRESHOLD);
  });

  it("warns but does NOT halt between the two thresholds", () => {
    // 70%: worth telling the reviewer, not worth blocking the demo.
    const a = auditCoverage({
      sitemapUrls: Array.from({ length: 10 }, (_, i) => `https://b.com/p${i}`),
      fileTitles: Array.from({ length: 7 }, (_, i) => `URL: https://b.com/p${i} 2026-1-1`),
    });
    expect(a.verdict).toBe("under-crawled");
    expect(a.coverage).toBeGreaterThan(COVERAGE_HALT_THRESHOLD);
  });
});

describe("gate 2 wiring", () => {
  it("halts only on 'under-crawled' — never on 'no-sitemap'", () => {
    // Being unable to MEASURE completeness is not evidence of incompleteness.
    // A gate that blocks because it could not find a sitemap gets switched off.
    expect(CODE).toMatch(/coverageHalted\s*=\s*\n?\s*state\.coverageVerdict === "under-crawled"/);
    expect(CODE).not.toMatch(/coverageHalted[\s\S]{0,200}no-sitemap/);
  });

  it("compares against the shared constant, not a literal", () => {
    // An inlined 0.6 drifts away from the documented constant silently.
    expect(CODE).toMatch(/state\.coverageRatio < COVERAGE_HALT_THRESHOLD/);
  });

  it("enforces the halt at APPROVAL, not only on the card", () => {
    // A reviewer can mark a review-board task DONE without reading it. If the halt
    // lived only in the description, the demo would ship anyway — which is
    // exactly the failure this gate exists to prevent.
    const approved = CODE.slice(CODE.indexOf("onApproved:"));
    expect(approved).toMatch(/if \(coverageHalted && !coverageOverride\)/);
    expect(approved.slice(0, 900)).toMatch(/process\.exit\(1\)/);
  });

  it("takes the override from an explicit env flag, exact-matched", () => {
    // `=== "1"` and not a truthy check: a stray "0"/"false" must not waive a
    // gate, and the reader should not have to guess what enables it.
    expect(CODE).toMatch(/process\.env\.DEMO_ALLOW_LOW_COVERAGE === "1"/);
  });

  it("RECORDS the override, so a waived demo is not indistinguishable from a passing one", () => {
    expect(CODE).toMatch(/state\.coverageOverriddenBy\s*=\s*"DEMO_ALLOW_LOW_COVERAGE"/);
  });

  it("puts the missing pages on the review card, not just a percentage", () => {
    // "28%" tells a reviewer nothing actionable; the page list does.
    expect(CODE).toMatch(/state\.coverageMissing[\s\S]{0,120}slice\(0, 12\)/);
  });

  it("runs the audit before guardCheck, since it costs nothing", () => {
    const auditAt = CODE.indexOf("auditCoverage({");
    const guardAt = CODE.indexOf("await guardCheck(); // QA runs spend");
    expect(auditAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(-1);
    expect(auditAt).toBeLessThan(guardAt);
  });
});

describe("the audit runs at INGEST time, not at QA time", () => {
  /**
   * It used to live only inside qaEval(), which is after hygiene, probe,
   * corpusBrief and a guardCheck. A corpus holding a fraction of the site was
   * therefore discovered only once real spend sat on top of it, and rebuilding
   * meant discarding that spend. The audit is pure set arithmetic over URLs —
   * no model call, no tokens — so there is no reason to defer it.
   */
  it("ingest() calls the audit before the run moves on", () => {
    const ingestAt = CODE.indexOf("async function ingest(");
    const qaEvalAt = CODE.indexOf("async function qaEval(");
    expect(ingestAt).toBeGreaterThan(-1);
    expect(qaEvalAt).toBeGreaterThan(ingestAt);
    const ingestBody = CODE.slice(ingestAt, qaEvalAt);
    expect(
      ingestBody,
      "ingest() no longer audits coverage — a thin corpus will again be found " +
        "only after hygiene, probe, corpusBrief and a guardCheck have spent on it",
    ).toMatch(/await auditCorpusCoverage\(\)/);
  });

  it("the audit is a named function, so it cannot drift between call sites", () => {
    // Two call sites now (ingest + qaEval). Inlining it twice is how they
    // diverge silently.
    expect(CODE).toMatch(/async function auditCorpusCoverage\(\)/);
    const calls = CODE.match(/await auditCorpusCoverage\(\)/g) || [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it("it stays best-effort — an audit failure must never fail a good run", () => {
    const fnAt = CODE.indexOf("async function auditCorpusCoverage()");
    const body = CODE.slice(fnAt, fnAt + 2500);
    expect(body, "the audit must swallow its own errors").toMatch(/catch\s*\(/);
  });
});
