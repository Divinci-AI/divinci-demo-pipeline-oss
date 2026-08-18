import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MIN_SCORE,
  MAX_PAGES,
  REVIEW_MARKERS,
  evaluateGate1,
  robotsForbidsEveryone,
} from "./gate1-auto.js";
import { parseQueue, type QueuedProspect } from "./intake.js";
import type { Manifest } from "./types.js";

const prospect = (over: Partial<QueuedProspect> = {}): QueuedProspect => ({
  slug: "acme",
  name: "Acme",
  url: "https://www.acme.example",
  anchorCustomer: "attio:x",
  complianceTier: "commerce-medium",
  score: 80,
  ...over,
});

const manifest = (over: Partial<Manifest> = {}): Manifest =>
  ({
    prospect: "acme",
    prospectName: "Acme",
    anchorCustomer: "attio:x",
    run: "2026-08-06-001",
    created: "2026-08-06",
    complianceTier: "commerce-medium",
    complianceNotes: "Answer from published pages. Do not quote prices.",
    budgets: { crawlPages: 200, embeddingTokens: 1_000_000 },
    evalQueries: [],
    sources: [
      {
        id: "acme-core",
        url: "https://www.acme.example/docs/",
        tier: "T1",
        type: "html",
        destination: "rag",
        rationale: "docs",
        license: "public web, robots-allowed",
        estPages: 100,
      },
    ],
    ...over,
  }) as Manifest;

describe("evaluateGate1", () => {
  it("approves a plain, well-scoped, on-domain plan", () => {
    const v = evaluateGate1(manifest(), prospect());
    expect(v.approve).toBe(true);
    expect(v.blockers).toEqual([]);
  });

  it("refuses when the prospect has left the queue", () => {
    // No score and no operator note means there is nothing to check against,
    // and "nothing to check" must never read as "nothing wrong".
    const v = evaluateGate1(manifest(), undefined);
    expect(v.approve).toBe(false);
  });

  it("refuses an unscored prospect", () => {
    expect(evaluateGate1(manifest(), prospect({ score: undefined })).approve).toBe(false);
  });

  it("refuses below the score floor", () => {
    const v = evaluateGate1(manifest(), prospect({ score: MIN_SCORE - 1 }));
    expect(v.blockers.join()).toMatch(/score/);
  });

  it("NEVER clears clinic-high — that is a judgement, not a measurement", () => {
    const v = evaluateGate1(
      manifest({ complianceTier: "clinic-high" }),
      prospect({ complianceTier: "clinic-high", score: 99 }),
    );
    expect(v.approve).toBe(false);
    expect(v.blockers.join()).toMatch(/clinic-high/);
  });

  it("honours an operator note asking for review", () => {
    // The queue's notes field is the one channel a human has for recording a
    // doubt. If auto-approval ignored it, it would be decorative from day one.
    for (const notes of [
      "⚠️ TIER GAP — read before Gate 1",
      "Needs review before we build",
      "do not auto-approve, weird licensing",
    ]) {
      expect(evaluateGate1(manifest(), prospect({ notes })).approve).toBe(false);
    }
  });

  it("has a marker for each thing an operator would plausibly write", () => {
    expect(REVIEW_MARKERS.length).toBeGreaterThanOrEqual(4);
  });

  it("refuses a plan over the page budget", () => {
    const big = manifest({
      sources: [{ ...manifest().sources[0], estPages: MAX_PAGES + 1 }],
      budgets: { crawlPages: MAX_PAGES + 500, embeddingTokens: 1 },
    });
    expect(evaluateGate1(big, prospect()).blockers.join()).toMatch(/pages/);
  });

  it("REFUSES an off-domain source even though intake already does", () => {
    // We send this demo back to the company we crawled, so a competitor's page
    // in their corpus is the worst thing this pipeline could ship. Defence in
    // depth, because a machine is doing the approving now.
    const leaky = manifest({
      sources: [{ ...manifest().sources[0], url: "https://competitor.example/blog/" }],
    });
    const v = evaluateGate1(leaky, prospect());
    expect(v.approve).toBe(false);
    expect(v.blockers.join()).toMatch(/off-domain/);
  });

  it("treats a subdomain of the prospect as on-domain", () => {
    const sub = manifest({
      sources: [{ ...manifest().sources[0], url: "https://research.acme.example/analysis/" }],
    });
    expect(evaluateGate1(sub, prospect()).approve).toBe(true);
  });

  it("refuses a manifest with no compliance scope", () => {
    expect(evaluateGate1(manifest({ complianceNotes: "  " }), prospect()).approve).toBe(false);
  });

  it("refuses a held prospect", () => {
    expect(evaluateGate1(manifest(), prospect({ hold: true })).approve).toBe(false);
  });

  it("refuses a plan with no rag sources", () => {
    expect(evaluateGate1(manifest({ sources: [] }), prospect()).approve).toBe(false);
  });

  it("records the evidence it approved on", () => {
    // "Why was this approved?" must be answerable months later without
    // re-deriving it, because nobody read the plan at the time.
    const v = evaluateGate1(manifest(), prospect());
    expect(v.evidence.join(" ")).toMatch(/score 80/);
    expect(v.evidence.join(" ")).toMatch(/on acme.example|on www.acme.example/);
  });

  it("reports EVERY blocker, not just the first", () => {
    const v = evaluateGate1(manifest({ complianceNotes: "", sources: [] }), prospect({ score: 1 }));
    expect(v.blockers.length).toBeGreaterThan(2);
  });
});

describe("robotsForbidsEveryone", () => {
  it("catches a blanket refusal", () => {
    expect(robotsForbidsEveryone("User-agent: *\nDisallow: /")).toBe(true);
  });

  it("ignores a blanket refusal aimed at somebody else", () => {
    expect(robotsForbidsEveryone("User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /")).toBe(false);
  });

  it("does not treat per-path rules as refusal — that is the crawler's job", () => {
    expect(robotsForbidsEveryone("User-agent: *\nDisallow: /admin\nDisallow: /cart")).toBe(false);
  });

  it("treats an empty Disallow as permission, which is what it means", () => {
    expect(robotsForbidsEveryone("User-agent: *\nDisallow:")).toBe(false);
  });

  it("ignores comments", () => {
    expect(robotsForbidsEveryone("User-agent: *\n# Disallow: /\nAllow: /")).toBe(false);
  });

  it("says nothing about an empty file", () => {
    expect(robotsForbidsEveryone("")).toBe(false);
  });
});

describe("against the example queue", () => {
  const queue = parseQueue(
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "..", "research", "prospect-queue.example.yaml"),
      "utf8",
    ),
  );

  it("every clinic-high prospect still requires a human", () => {
    // A regression here would auto-approve a live clinic's patient-facing
    // corpus, which is the single case this gate exists to keep hold of.
    for (const p of queue.filter((q) => q.complianceTier === "clinic-high")) {
      const v = evaluateGate1(manifest({ complianceTier: "clinic-high", prospect: p.slug }), p);
      expect(v.approve, `${p.slug} must not auto-approve`).toBe(false);
    }
  });

  it("does not auto-approve anything an operator flagged", () => {
    for (const p of queue.filter((q) => REVIEW_MARKERS.some((re) => re.test(q.notes ?? "")))) {
      const v = evaluateGate1(manifest({ prospect: p.slug, complianceTier: p.complianceTier }), p);
      expect(v.approve, `${p.slug} carries a review marker`).toBe(false);
    }
  });
});

describe("the robots check must actually reach the site", () => {
  it("passes a HOSTNAME to the same-site guard, not a URL", () => {
    // `sameSiteAs` is a hostname. Passing the full URL made every fetch fail
    // the guard — "www.thorne.com is not https://www.thorne.com" — so the
    // check returned "no robots.txt" for sites it had never reached and
    // recorded that as evidence on the approval. A check that reports a clean
    // result it never performed is the failure this codebase keeps producing.
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "gate1-auto.ts"),
      "utf8",
    );
    expect(src).toMatch(/sameSiteAs:\s*hostname/);
    expect(src).not.toMatch(/sameSiteAs:\s*prospect\.url/);
  });
});
