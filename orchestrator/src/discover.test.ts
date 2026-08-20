import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendProspects,
  buildDiscoveryPrompt,
  hostOf,
  parseCandidates,
  renderQueueEntries,
  shouldDiscover,
  unstartedBacklog,
  verifyCandidate,
  MIN_PAGES_FOR_A_DEMO,
  type Candidate,
  type VerifiedCandidate,
} from "./discover.js";
import { parseQueue } from "./intake.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "discover-"));
  dirs.push(d);
  return d;
}

const CAND: Candidate = {
  slug: "acme-labs",
  name: "Acme Labs",
  url: "https://acmelabs.example",
  complianceTier: "commerce-medium",
  complianceNotes: "Describe published product documentation. Do not quote prices.",
  score: 70,
  cluster: "Devtools",
  rationale: "Large public docs library.",
};

describe("parseCandidates", () => {
  it("accepts a well-formed candidate", () => {
    const { candidates, rejected } = parseCandidates(JSON.stringify([CAND]));
    expect(rejected).toEqual([]);
    expect(candidates[0].slug).toBe("acme-labs");
  });

  it("tolerates a code fence, because models add them", () => {
    const { candidates } = parseCandidates("```json\n" + JSON.stringify([CAND]) + "\n```");
    expect(candidates).toHaveLength(1);
  });

  it("REFUSES an unknown compliance tier rather than defaulting one", () => {
    // The tier drives both the compliance prompt and the QA hazard set. A
    // quietly-defaulted tier produces a demo that scores cleanly against a
    // hazard it was never given rules for.
    const { candidates, rejected } = parseCandidates(
      JSON.stringify([{ ...CAND, complianceTier: "medium-ish" }]),
    );
    expect(candidates).toEqual([]);
    expect(rejected[0]).toMatch(/complianceTier/);
  });

  it("REFUSES an unknown compliance flag", () => {
    const { candidates, rejected } = parseCandidates(
      JSON.stringify([{ ...CAND, complianceFlags: ["sensitive-audiance"] }]),
    );
    expect(candidates).toEqual([]);
    expect(rejected[0]).toMatch(/unknown complianceFlag/);
  });

  it("requires a model-facing scope — it is what binds the assistant", () => {
    const { candidates, rejected } = parseCandidates(JSON.stringify([{ ...CAND, complianceNotes: "" }]));
    expect(candidates).toEqual([]);
    expect(rejected[0]).toMatch(/complianceNotes/);
  });

  it("requires https and a directory-safe slug", () => {
    const { rejected } = parseCandidates(
      JSON.stringify([
        { ...CAND, slug: "Acme Labs" },
        { ...CAND, slug: "ok-slug", url: "acmelabs.example" },
      ]),
    );
    expect(rejected).toHaveLength(2);
  });

  it("keeps the good ones when a sibling is malformed", () => {
    // One bad candidate must not cost the whole batch — the same lesson as the
    // crawler dropping a pass over one seed.
    const { candidates, rejected } = parseCandidates(
      JSON.stringify([{ ...CAND, complianceTier: "nope" }, { ...CAND, slug: "second" }]),
    );
    expect(candidates.map((c) => c.slug)).toEqual(["second"]);
    expect(rejected).toHaveLength(1);
  });

  it("throws on output that is not JSON at all", () => {
    expect(() => parseCandidates("I could not find any prospects.")).toThrow(/did not return JSON/);
  });
});

describe("the discovery prompt", () => {
  it("passes existing prospects as names and hosts ONLY", () => {
    // The queue carries operator research — Attio deal status, adjacency
    // reasoning. Feeding our own sales notes to a model that writes back into
    // that same file is how they come back out as prose.
    const p = buildDiscoveryPrompt({
      rubric: "vertical match 30%",
      existing: [{ name: "Acme Supplements", url: "https://www.acmesupplements.com" }],
      workingClusters: ["Supplements"],
      count: 3,
    });
    expect(p).toContain("Acme Supplements (acmesupplements.com)");
    expect(p).not.toMatch(/attio:/i);
    expect(p).not.toMatch(/adjacency score|deal record/i);
  });

  it("states the page floor, since richness is what the demo is built from", () => {
    const p = buildDiscoveryPrompt({ rubric: "", existing: [], workingClusters: [], count: 1 });
    expect(p).toContain(String(MIN_PAGES_FOR_A_DEMO));
  });
});

describe("verifyCandidate", () => {
  const fresh = () => ({ slugs: new Set<string>(), hosts: new Set<string>() });

  it("drops a slug already queued", async () => {
    const seen = fresh();
    seen.slugs.add("acme-labs");
    const r = await verifyCandidate(CAND, seen);
    expect(r.ok).toBe(false);
  });

  it("drops a host already queued under a different slug", async () => {
    // The same company proposed twice under two names is a duplicate crawl of
    // a real website, which is the failure the queue's no-status design exists
    // to prevent.
    const seen = fresh();
    seen.hosts.add("acmelabs.example");
    const r = await verifyCandidate({ ...CAND, slug: "acme-labs-inc" }, seen);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/already queued/);
  });
});

describe("unstartedBacklog", () => {
  function queueFixture(): { queue: ReturnType<typeof parseQueue>; runsDir: string } {
    const root = tmp();
    mkdirSync(join(root, "runs", "taken"), { recursive: true });
    writeFileSync(join(root, "runs", "taken", "2026-01-01-001", "..", "manifest.json"), "{}");
    mkdirSync(join(root, "runs", "taken", "2026-01-01-001"), { recursive: true });
    writeFileSync(join(root, "runs", "taken", "2026-01-01-001", "manifest.json"), "{}");
    const yaml = [
      "prospects:",
      "  - slug: taken",
      "    name: Taken",
      "    url: https://taken.example",
      "    anchorCustomer: x",
      "    complianceTier: commerce-medium",
      "  - slug: free",
      "    name: Free",
      "    url: https://free.example",
      "    anchorCustomer: x",
      "    complianceTier: commerce-medium",
      "  - slug: held",
      "    name: Held",
      "    url: https://held.example",
      "    anchorCustomer: x",
      "    complianceTier: commerce-medium",
      "    hold: true",
    ].join("\n");
    return { queue: parseQueue(yaml), runsDir: join(root, "runs") };
  }

  it("counts only prospects with no run and no hold", () => {
    const { queue, runsDir } = queueFixture();
    expect(unstartedBacklog(queue, runsDir).map((p) => p.slug)).toEqual(["free"]);
  });

  it("triggers below the floor and not at it", () => {
    expect(shouldDiscover(7, 8)).toBe(true);
    expect(shouldDiscover(8, 8)).toBe(false);
  });
});

describe("renderQueueEntries", () => {
  const v: VerifiedCandidate = { ...CAND, measuredPages: 140 };

  it("never claims an Attio record it does not have", () => {
    // Every hand-written entry carries `attio:...`. A discovered prospect has
    // no deal and must not read like a live thread.
    const out = renderQueueEntries([v], "2026-08-06");
    expect(out).toContain("discovered:2026-08-06");
    expect(out).not.toContain("attio:");
    expect(out).toMatch(/NO Attio record/);
  });

  it("records the MEASURED page count, so the score is auditable", () => {
    expect(renderQueueEntries([v], "2026-08-06")).toContain("Measured 140 sitemap page(s)");
  });

  it("keeps the rationale in operator-facing notes, never in the scope", () => {
    const out = renderQueueEntries([{ ...v, rationale: "Big docs library, ripe for it." }], "2026-08-06");
    const notes = out.split("notes:")[1];
    expect(notes).toContain("Big docs library");
    const scope = out.split("complianceNotes:")[1].split("\n")[0];
    expect(scope).not.toContain("Big docs library");
  });

  it("produces entries the REAL parser accepts", () => {
    const parsed = parseQueue(`prospects:\n${renderQueueEntries([v], "2026-08-06")}`);
    expect(parsed[0].slug).toBe("acme-labs");
    expect(parsed[0].anchorCustomer).toMatch(/discovered:/);
  });

  it("emits complianceFlags only when there are some", () => {
    expect(renderQueueEntries([v], "2026-08-06")).not.toContain("complianceFlags");
    const withFlag = renderQueueEntries([{ ...v, complianceFlags: ["financial-advice"] }], "2026-08-06");
    expect(withFlag).toContain("complianceFlags: [financial-advice]");
    expect(parseQueue(`prospects:\n${withFlag}`)[0].complianceFlags).toEqual(["financial-advice"]);
  });
});

describe("appendProspects", () => {
  function seeded(): string {
    const d = tmp();
    const p = join(d, "queue.yaml");
    writeFileSync(
      p,
      [
        "prospects:",
        "  - slug: existing",
        "    name: Existing",
        "    url: https://existing.example",
        "    anchorCustomer: attio:x",
        "    complianceTier: commerce-medium",
        "",
      ].join("\n"),
    );
    return p;
  }

  it("appends and reports the new total", () => {
    const p = seeded();
    const res = appendProspects(p, renderQueueEntries([{ ...CAND, measuredPages: 90 }], "2026-08-06"));
    expect(res).toEqual({ added: 1, total: 2 });
    expect(parseQueue(readFileSync(p, "utf8"))).toHaveLength(2);
  });

  it("RESTORES the file when the appended entries do not parse", () => {
    // Validating a queue with yaml.safe_load instead of the real parser once
    // shipped a file that was valid YAML and invalid to parseQueue: it threw on
    // prospects[0] and took intake down for every prospect, not just the new
    // one. A half-written queue starves the loop completely.
    const p = seeded();
    const before = readFileSync(p, "utf8");
    expect(() =>
      appendProspects(p, ["  - slug: broken", "    name: Broken", "    url: https://b.example"].join("\n")),
    ).toThrow(/queue restored unchanged/);
    expect(readFileSync(p, "utf8")).toBe(before);
  });
});

describe("hostOf", () => {
  it("normalises www so a host cannot be queued twice", () => {
    expect(hostOf("https://www.acme.example/x")).toBe(hostOf("https://acme.example/"));
  });
});
