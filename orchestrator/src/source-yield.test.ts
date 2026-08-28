import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeYield, renderYield } from "./source-yield.js";
import { inferSource, isSource, sourceOf, SOURCES } from "./provenance.js";

let runs: string;

function run(slug: string, id: string, state: Record<string, unknown>): void {
  const dir = join(runs, slug, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify(state));
}

beforeEach(() => {
  runs = mkdtempSync(join(tmpdir(), "yield-test-"));
});
afterEach(() => rmSync(runs, { recursive: true, force: true }));

describe("provenance", () => {
  it("never infers a measured source — only a :backfilled one", () => {
    // The point of the suffix: an unstamped entry must never be countable as
    // evidence about how a source performs.
    expect(inferSource({})).toBe("model-recall:backfilled");
    expect(inferSource({ requestedBy: "discovered" })).toBe("model-recall:backfilled");
  });

  it("treats direct as recorded, not inferred — requestedBy already said so", () => {
    expect(inferSource({ requestedBy: "direct", directSeq: 1 })).toBe("direct");
  });

  it("prefers a stamped source over inference", () => {
    expect(sourceOf({ source: "model-recall", requestedBy: "discovered" })).toBe("model-recall");
  });

  it("rejects an unregistered source rather than creating a bucket for it", () => {
    // Plausible typos for a REGISTERED source. Each would silently create a
    // second bucket and halve the real source's apparent yield, so it reads as
    // two mediocre sources instead of one good one.
    expect(isSource("websearch")).toBe(false);
    expect(isSource("web_search")).toBe(false);
    expect(isSource("web-search ")).toBe(false);
    expect(isSource("Web-Search")).toBe(false);
    expect(isSource("model_recall")).toBe(false);
    expect(isSource("web-search")).toBe(true); // the registered spelling
    for (const s of SOURCES) expect(isSource(s)).toBe(true);
  });
});

describe("computeYield", () => {
  it("counts the funnel, not just the queue", () => {
    run("a", "r1", { demoLink: "https://a.example" });
    run("b", "r1", {}); // started, never went live
    const rep = computeYield(
      [
        { slug: "a", source: "model-recall" },
        { slug: "b", source: "model-recall" },
        { slug: "c", source: "model-recall" }, // queued, never started
      ],
      runs,
    );
    const row = rep.bySource.find((r) => r.source === "model-recall")!;
    expect(row).toMatchObject({ queued: 3, started: 2, live: 1 });
  });

  it("counts a prospect once even when a retry run also went live", () => {
    // Two runs for one prospect is a retry, not two prospects. Counting runs
    // would let a flaky source inflate its own yield by failing repeatedly.
    run("a", "r1", {});
    run("a", "r2", { demoLink: "https://a.example" });
    const rep = computeYield([{ slug: "a", source: "model-recall" }], runs);
    expect(rep.bySource[0]).toMatchObject({ queued: 1, started: 1, live: 1 });
  });

  it("REPORTS runs it cannot attribute instead of dropping them", () => {
    // The rule this module exists for. Dropping makes every visible number
    // look sane while the totals quietly disagree with disk.
    run("ghost", "r1", { demoLink: "https://ghost.example" });
    run("known", "r1", {});
    const rep = computeYield([{ slug: "known", source: "model-recall" }], runs);
    expect(rep.unattributed).toEqual(["ghost"]);
    expect(renderYield(rep)).toMatch(/match no queue entry/);
  });

  it("keeps inferred yield in its own bucket, never merged into the measured one", () => {
    run("stamped", "r1", { demoLink: "x" });
    run("legacy", "r1", { demoLink: "x" });
    const rep = computeYield(
      [{ slug: "stamped", source: "model-recall" }, { slug: "legacy" }],
      runs,
    );
    const sources = rep.bySource.map((r) => r.source).sort();
    expect(sources).toEqual(["model-recall", "model-recall:backfilled"]);
    expect(rep.bySource.find((r) => r.inferred)!.source).toBe("model-recall:backfilled");
    expect(renderYield(rep)).toMatch(/inferred from history, not measured/);
  });

  it("counts quarantined runs against the source that produced them", () => {
    run("stuck", "r1", {});
    writeFileSync(join(runs, ".loop-failures.json"), JSON.stringify({ "stuck/r1": { step: "vector" } }));
    const rep = computeYield([{ slug: "stuck", source: "model-recall" }], runs);
    expect(rep.bySource[0].quarantined).toBe(1);
  });

  it("survives an unreadable state file rather than taking the report down", () => {
    const dir = join(runs, "broken", "r1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.json"), "{not json");
    const rep = computeYield([{ slug: "broken", source: "model-recall" }], runs);
    expect(rep.bySource[0]).toMatchObject({ started: 1, live: 0 });
  });

  it("reports median cohort age, so the funnel is not read as age-neutral", () => {
    // The reason this column exists: on 2026-08-24 direct converted to outreach
    // 2 vs discovered's 33, which reads as a quality gap and is mostly a
    // maturity one — the direct cohort was ten days younger and outreach is
    // the last gate. Without the age, the table invites the wrong decision.
    const NOW = Date.parse("2026-08-24T00:00:00Z");
    const day = 86_400_000;
    const at = (d: number) => ({ log: [{ at: new Date(NOW - d * day).toISOString() }] });
    run("young1", "r1", at(2));
    run("young2", "r1", at(8));
    run("young3", "r1", at(4));
    const rep = computeYield(
      ["young1", "young2", "young3"].map((slug) => ({ slug, source: "model-recall" as const })),
      runs,
      NOW,
    );
    expect(rep.bySource[0].medianAgeDays).toBe(4);
    expect(renderYield(rep)).toMatch(/median age/);
    expect(renderYield(rep)).toMatch(/4d/);
  });

  it("leaves median age null when no run has a usable timestamp", () => {
    run("a", "r1", {}); // no log
    const rep = computeYield([{ slug: "a", source: "model-recall" }], runs, Date.now());
    expect(rep.bySource[0].medianAgeDays).toBeNull();
    expect(renderYield(rep)).toMatch(/—/);
  });

  it("does not count the smoke fixture as a real run", () => {
    run("__smoke__", "dry", { demoLink: "https://smoke.example" });
    const rep = computeYield([], runs);
    expect(rep.unattributed).toEqual([]);
  });
});
