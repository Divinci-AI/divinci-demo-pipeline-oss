import { describe, expect, it, vi, beforeEach } from "vitest";

const verifyCandidateMock = vi.hoisted(() => vi.fn());
const appendProspectsMock = vi.hoisted(() => vi.fn(() => ({ added: 0, total: 0 })));

vi.mock("./discover.js", async (orig) => {
  const actual = await orig<typeof import("./discover.js")>();
  return { ...actual, verifyCandidate: verifyCandidateMock, appendProspects: appendProspectsMock };
});

const { mergeScores, renderPartnerEntries, verifyPartner, writePartners } = await import(
  "./discover-web-write.js"
);
const { parseQueue } = await import("./intake.js");

const cand = (over: Record<string, unknown> = {}) => ({
  name: "Acme Docs",
  url: "https://acme.com",
  evidence: ["https://acme.com/changelog/ai"],
  signal: "shipped an assistant",
  ...over,
});

const scored = (over: Record<string, unknown> = {}) => ({
  ...cand(),
  score: 90,
  complianceTier: "commerce-medium",
  complianceNotes: "notes",
  cluster: "docs-platform",
  rationale: "why",
  ...over,
});

beforeEach(() => {
  verifyCandidateMock.mockReset();
  appendProspectsMock.mockReset().mockReturnValue({ added: 0, total: 0 });
});

describe("mergeScores", () => {
  it("joins on URL, NOT array position", () => {
    // Stage B is asked for "same order". A model that drops one row would
    // otherwise shift every later score onto the wrong company — silently, and
    // the output would look entirely plausible.
    const a = cand({ name: "A", url: "https://a.com" });
    const b = cand({ name: "B", url: "https://b.com" });
    const { scored: out } = mergeScores(
      [a, b],
      JSON.stringify([{ url: "https://b.com", score: 80, complianceTier: "commerce-medium" }]),
    );
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("B");
    expect(out[0].score).toBe(80);
  });

  it("REFUSES to default an unrecognized complianceTier", () => {
    // The tier picks the assistant's compliance prompt AND its QA hazard set.
    // Guessing it ships an assistant with the wrong guardrails and a QA suite
    // that never probes them.
    const { scored: out, rejected } = mergeScores(
      [cand()],
      JSON.stringify([{ url: "https://acme.com", score: 90, complianceTier: "totally-made-up" }]),
    );
    expect(out).toHaveLength(0);
    expect(rejected.join(" ")).toMatch(/complianceTier/);
  });

  it("rejects an out-of-range or non-numeric score", () => {
    for (const bad of [101, -1, "high", null]) {
      const { scored: out } = mergeScores(
        [cand()],
        JSON.stringify([{ url: "https://acme.com", score: bad, complianceTier: "commerce-medium" }]),
      );
      expect(out).toHaveLength(0);
    }
  });

  it("drops unknown compliance flags rather than passing them through", () => {
    const { scored: out } = mergeScores(
      [cand()],
      JSON.stringify([
        { url: "https://acme.com", score: 90, complianceTier: "commerce-medium", complianceFlags: ["not-a-flag"] },
      ]),
    );
    expect(out[0].complianceFlags).toBeUndefined();
  });

  it("survives non-JSON from stage B", () => {
    const { scored: out, rejected } = mergeScores([cand()], "I could not score these.");
    expect(out).toHaveLength(0);
    expect(rejected[0]).toMatch(/parseable JSON/);
  });
});

describe("verifyPartner", () => {
  const seen = () => ({ slugs: new Set<string>(), hosts: new Set<string>() });

  it("uses the homepage when it clears the page floor", async () => {
    verifyCandidateMock.mockResolvedValueOnce({ ok: true, verified: { slug: "acme-docs", measuredPages: 200 } });
    const res = await verifyPartner(scored({ docsUrl: "https://docs.acme.com" }) as never, seen());
    expect(res.ok && res.corpusUrl).toBe("https://acme.com");
    expect(verifyCandidateMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the docs root when the homepage is too THIN", async () => {
    // partner-scoring.md refuses to penalise a thin marketing site, so
    // verification must not either — a product company's docs are the corpus.
    verifyCandidateMock
      .mockResolvedValueOnce({ ok: false, reason: "only 11 discoverable page(s) — below the 25 a demo needs" })
      .mockResolvedValueOnce({ ok: true, verified: { slug: "acme-docs", measuredPages: 900 } });
    const res = await verifyPartner(scored({ docsUrl: "https://docs.acme.com" }) as never, seen());
    expect(res.ok && res.corpusUrl).toBe("https://docs.acme.com");
  });

  it("does NOT retry the docs root for an unreachable site", async () => {
    // Pointing at another path on a host that does not answer is not a fix,
    // and a second live request per dead candidate is pure latency.
    verifyCandidateMock.mockResolvedValueOnce({ ok: false, reason: "site unreachable" });
    const res = await verifyPartner(scored({ docsUrl: "https://docs.acme.com" }) as never, seen());
    expect(res.ok).toBe(false);
    expect(verifyCandidateMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry when no docs root was proposed", async () => {
    verifyCandidateMock.mockResolvedValueOnce({ ok: false, reason: "only 3 discoverable page(s) — below the 25" });
    const res = await verifyPartner(scored() as never, seen());
    expect(res.ok).toBe(false);
    expect(verifyCandidateMock).toHaveBeenCalledTimes(1);
  });
});

describe("renderPartnerEntries", () => {
  const row = {
    verified: {
      slug: "acme-docs",
      name: "Acme Docs",
      complianceTier: "commerce-medium",
      complianceNotes: "scope",
      score: 90,
      cluster: "docs-platform",
      measuredPages: 900,
      rationale: "why them",
    },
    corpusUrl: "https://docs.acme.com",
    homepage: "https://acme.com",
    evidence: ["https://acme.com/changelog/ai"],
  } as never;

  it("round-trips through the REAL queue parser", () => {
    // The check that matters. A queue that is valid YAML and invalid to the
    // parser once took intake down for EVERY prospect, not just the new one.
    const yaml = `prospects:\n${renderPartnerEntries([row], "2026-08-24")}\n`;
    const parsed = parseQueue(yaml);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      slug: "acme-docs",
      url: "https://docs.acme.com",
      source: "web-search",
      icp: "partner",
      requestedBy: "discovered",
    });
  });

  it("crawls the CORPUS, and keeps the homepage findable by a human", () => {
    const yaml = `prospects:\n${renderPartnerEntries([row], "2026-08-24")}\n`;
    const p = parseQueue(yaml)[0];
    expect(p.url).toBe("https://docs.acme.com");
    expect(p.notes).toContain("https://acme.com");
  });

  it("warns in the notes that the score is not comparable", () => {
    expect(renderPartnerEntries([row], "2026-08-24")).toMatch(/NOT comparable/);
  });

  it("never claims an Attio record it does not have", () => {
    expect(renderPartnerEntries([row], "2026-08-24")).toMatch(/NO Attio/);
  });
});

describe("writePartners", () => {
  it("drops anything below the score floor without touching the web", async () => {
    const res = await writePartners({
      scored: [scored({ score: 40 }) as never],
      existing: [],
      queuePath: "/nope",
      today: "2026-08-24",
      minScore: 60,
    });
    expect(res.added).toBe(0);
    expect(verifyCandidateMock).not.toHaveBeenCalled();
    expect(res.rejected.join(" ")).toMatch(/below 60/);
  });

  it("writes NOTHING on a dry run, but still reports what it would write", async () => {
    verifyCandidateMock.mockResolvedValue({ ok: true, verified: { slug: "acme-docs", measuredPages: 200, name: "Acme Docs", complianceTier: "commerce-medium", complianceNotes: "n", score: 90, cluster: "c", rationale: "r" } });
    const res = await writePartners({
      scored: [scored() as never],
      existing: [],
      queuePath: "/nope",
      today: "2026-08-24",
      dryRun: true,
    });
    expect(appendProspectsMock).not.toHaveBeenCalled();
    expect(res.added).toBe(0);
    expect(res.entries).toContain("source: web-search");
  });

  it("claims slugs within a batch, so two candidates cannot collide in the queue", async () => {
    // Without this the second passes verification (the queue does not contain
    // it yet) and the parser then rejects the whole append.
    const seenSlugs: string[] = [];
    verifyCandidateMock.mockImplementation((c: { slug: string }, seen: { slugs: Set<string> }) => {
      if (seen.slugs.has(c.slug)) return { ok: false, reason: "slug already queued" };
      seenSlugs.push(c.slug);
      return { ok: true, verified: { ...c, measuredPages: 200 } };
    });
    const res = await writePartners({
      scored: [scored() as never, scored({ url: "https://acme.io" }) as never],
      existing: [],
      queuePath: "/nope",
      today: "2026-08-24",
      dryRun: true,
    });
    expect(res.rejected.join(" ")).toMatch(/already queued/);
    expect(new Set(seenSlugs).size).toBe(seenSlugs.length);
  });
});

describe("partner intake is bounded by SHARE, not by score", () => {
  // The reason: a partner's score comes from a different rubric measuring a
  // different quantity. Sorting a 92-partner against an 85-customer compares
  // reach to content richness on a shared scale that means nothing, and would
  // let one good partner pass every customer in the queue — not because it is
  // worth more, but because its rubric produces bigger numbers.
  const mkRuns = async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "sel-test-"));
    return {
      dir,
      start: (slug: string) => {
        mkdirSync(join(dir, slug, "r1"), { recursive: true });
        // hasRun() keys on manifest.json, not state.json — a run exists from
        // the moment intake writes its manifest, before any step has run.
        writeFileSync(join(dir, slug, "r1", "manifest.json"), "{}");
        writeFileSync(join(dir, slug, "r1", "state.json"), "{}");
      },
    };
  };

  const P = (slug: string, icp: "customer" | "partner", score: number) =>
    ({ slug, name: slug, url: `https://${slug}.com`, anchorCustomer: "a", complianceTier: "commerce-medium", icp, score, requestedBy: "discovered" }) as never;

  it("does not let a high-scoring partner jump every customer", async () => {
    const { selectNextProspect } = await import("./intake.js");
    const { dir, start } = await mkRuns();
    // Four customers already started, share 0.25 → a 5th run may be a partner.
    for (const s of ["c1", "c2", "c3", "c4"]) start(s);
    const queue = [
      P("c1", "customer", 10), P("c2", "customer", 10), P("c3", "customer", 10), P("c4", "customer", 10),
      P("partner-a", "partner", 99), P("c5", "customer", 50),
    ];
    // Allowed at 1/5 = 0.2 <= 0.25
    expect(selectNextProspect(queue, dir, undefined, { partnerShare: 0.25 })?.slug).toBe("partner-a");
    // With the share at zero the partner is invisible however high it scores.
    expect(selectNextProspect(queue, dir, undefined, { partnerShare: 0 })?.slug).toBe("c5");
  });

  it("skips partners once their share of started runs is met", async () => {
    const { selectNextProspect } = await import("./intake.js");
    const { dir, start } = await mkRuns();
    start("partner-a"); // 1 of 1 started is a partner
    const queue = [P("partner-a", "partner", 99), P("partner-b", "partner", 99), P("c1", "customer", 5)];
    expect(selectNextProspect(queue, dir, undefined, { partnerShare: 0.25 })?.slug).toBe("c1");
  });

  it("still returns a customer when partners are the only thing blocked", async () => {
    const { selectNextProspect } = await import("./intake.js");
    const { dir, start } = await mkRuns();
    start("partner-a");
    const queue = [P("partner-a", "partner", 99), P("partner-b", "partner", 99)];
    // Nothing eligible but a blocked partner → returns undefined, not a partner.
    expect(selectNextProspect(queue, dir, undefined, { partnerShare: 0.25 })).toBeUndefined();
  });

  it("treats a prospect with no icp as a customer", async () => {
    const { selectNextProspect } = await import("./intake.js");
    const { dir } = await mkRuns();
    const legacy = { slug: "legacy", name: "l", url: "https://l.com", anchorCustomer: "a", complianceTier: "commerce-medium", requestedBy: "discovered", score: 1 } as never;
    expect(selectNextProspect([legacy], dir, undefined, { partnerShare: 0 })?.slug).toBe("legacy");
  });
});
