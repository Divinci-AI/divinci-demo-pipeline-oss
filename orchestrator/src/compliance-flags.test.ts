import { describe, it, expect } from "vitest";
import {
  complianceSystemPrompt,
  SENSITIVE_AUDIENCE_RULES,
  LEGAL_ADVICE_RULES,
  FLAG_RULES,
  STRICT_TIERS,
} from "./compliance-prompt.js";
import { hazardsFor, TIER_HAZARDS, FLAG_HAZARDS } from "./qa-suite-gen.js";
import { parseQueue, FLAGS, TIERS } from "./intake.js";

/**
 * `complianceFlags` exists because Acme Supplements could not be described by one
 * tier: its legal exposure is commercial (139 priced products, FTC claim
 * substantiation) while its readers are people self-treating chronic
 * conditions. Choosing a tier meant choosing which hazard to leave undefended.
 */
const has = (rules: string[], re: RegExp) => rules.some((r) => re.test(r));

describe("sensitive-audience rules exist at all", () => {
  it("the TIER now carries rules of its own", () => {
    // Until 2026-08-05 `sensitive-audience` had ZERO rules unique to it — it
    // fell through to the shared strict set and never mentioned crisis,
    // distress or vulnerability, while its QA hazard targeted exactly that.
    const sa = complianceSystemPrompt("Acme", "sensitive-audience");
    const ch = complianceSystemPrompt("Acme", "clinic-high");
    expect(sa.filter((r) => !ch.includes(r)).length).toBeGreaterThan(0);
    expect(has(sa, /CRISIS/)).toBe(true);
  });

  it("names the specific behaviours, not just 'be careful'", () => {
    const sa = complianceSystemPrompt("Acme", "sensitive-audience");
    expect(has(sa, /self-harm|suicidal/i)).toBe(true);
    expect(has(sa, /pregnan/i)).toBe(true);
    expect(has(sa, /interaction/i)).toBe(true);
    expect(has(sa, /genetic|lab values/i)).toBe(true);
  });
});

describe("the flag layers onto a commerce-medium tier", () => {
  const plain = complianceSystemPrompt("Acme", "commerce-medium");
  const flagged = complianceSystemPrompt("Acme", "commerce-medium", "", ["sensitive-audience"]);

  it("plain commerce-medium stays permissive — the flag is what changes it", () => {
    // 3, not 2, since 2026-08-14: the base now carries the universal
    // third-party-details rule. The POINT of this test is that a plain
    // commerce-medium prompt gains none of the STRICT or flag rules, so assert
    // that directly rather than a line count that any base change breaks.
    expect(plain.length).toBe(3);
    expect(has(plain, /CRISIS/)).toBe(false);
    expect(has(plain, /NEVER recommend, select, or suggest/)).toBe(false);
    expect(has(plain, /helpfully and factually/)).toBe(true);
  });

  it("carries the third-party rule even at the most permissive tier", () => {
    // A coworking space is handed "my colleague Sarah needs a desk, here is her
    // email" exactly as readily as a clinic is handed a relative's symptoms.
    expect(has(plain, /THIRD PARTY'S PERSONAL DETAILS/)).toBe(true);
  });

  it("adds every sensitive-audience rule", () => {
    for (const rule of SENSITIVE_AUDIENCE_RULES) expect(flagged).toContain(rule);
  });

  it("PROMOTES the tier to the strict base, not just appends", () => {
    // Otherwise the permissive "answer helpfully, route specifics to contact"
    // line stays as the last word on everything the flag does not name.
    expect(has(flagged, /NEVER recommend, select, or suggest a product/)).toBe(true);
    expect(has(flagged, /Answer questions about Acme's products, services and published resources helpfully/)).toBe(false);
  });

  it("puts the flag rules LAST, where the floor's stated authority is", () => {
    // The opening line says the rules below override anything above, so
    // position and stated authority must agree — Acme Clinic showed a later
    // instruction beating an earlier one purely on recency.
    const firstFlagIdx = flagged.indexOf(SENSITIVE_AUDIENCE_RULES[0]);
    const lastStrictIdx = flagged.lastIndexOf(
      flagged.filter((r) => !SENSITIVE_AUDIENCE_RULES.includes(r)).slice(-1)[0],
    );
    expect(firstFlagIdx).toBeGreaterThan(lastStrictIdx);
  });

  it("does not duplicate when the tier IS sensitive-audience", () => {
    const both = complianceSystemPrompt("Acme", "sensitive-audience", "", ["sensitive-audience"]);
    for (const rule of SENSITIVE_AUDIENCE_RULES) {
      expect(both.filter((r) => r === rule)).toHaveLength(1);
    }
  });

  it("layers onto clinic-high too, keeping the clinic rules", () => {
    const ch = complianceSystemPrompt("Acme", "clinic-high", "", ["sensitive-audience"]);
    expect(has(ch, /SOMEONE ELSE'S CLINICIAN OUTRANKS/)).toBe(true);
    for (const rule of SENSITIVE_AUDIENCE_RULES) expect(ch).toContain(rule);
  });

  it("an unknown flag changes nothing rather than throwing mid-run", () => {
    // Validation belongs at intake (tested below); by the time run.ts builds a
    // prompt, refusing would take down a build over a typo.
    const odd = complianceSystemPrompt("Acme", "clinic-high", "", ["not-a-flag"]);
    expect(odd).toEqual(complianceSystemPrompt("Acme", "clinic-high", "", []).concat());
  });
});

describe("the flag moves the QA hazards too", () => {
  it("appends the flag hazard to the tier's", () => {
    const h = hazardsFor("commerce-medium", ["sensitive-audience"]);
    expect(h).toContain(TIER_HAZARDS["commerce-medium"]);
    expect(h).toContain(FLAG_HAZARDS["sensitive-audience"]);
  });

  it("targets what the rules defend — protocol, interactions, results, crisis", () => {
    // A flag that moves only the prompt reports a clean score for a hazard
    // nothing tested; one that moves only the hazards tests a defence that
    // does not exist. Both halves or it is decorative.
    const h = hazardsFor("commerce-medium", ["sensitive-audience"]);
    expect(h).toMatch(/protocol or dose/i);
    expect(h).toMatch(/interaction/i);
    expect(h).toMatch(/genetic|lab/i);
    expect(h).toMatch(/crisis|distress/i);
  });

  it("adds no FLAG hazard when no flags are set", () => {
    // Was `toBe(TIER_HAZARDS[...])`. hazardsFor now always appends the
    // universal third-party hazard, so equality no longer expresses the
    // intent — which is that flags, and only flags, add flag hazards.
    const h = hazardsFor("commerce-medium");
    expect(h).toContain(TIER_HAZARDS["commerce-medium"]);
    for (const flagHazard of Object.values(FLAG_HAZARDS)) expect(h).not.toContain(flagHazard);
  });

  it("ALWAYS probes the third-party hazard, whatever the tier", () => {
    // Including an unknown tier, which yields no tier hazard at all — the
    // failure mode that let an invented `government-high` produce a clean
    // score for hazards nothing tested.
    for (const tier of ["commerce-medium", "clinic-high", "wellness-low", "not-a-real-tier"]) {
      expect(hazardsFor(tier), tier).toMatch(/third party's personal details/i);
    }
  });

  it("does not duplicate for a sensitive-audience TIER carrying the flag", () => {
    const h = hazardsFor("sensitive-audience", ["sensitive-audience"]);
    expect(h.split(FLAG_HAZARDS["sensitive-audience"]).length - 1).toBe(1);
  });
});

describe("intake validates flags as strictly as tiers", () => {
  const q = (extra: string) => `prospects:
  - slug: x
    name: X
    url: https://x.example
    anchorCustomer: "attio:deals/abc"
    complianceTier: commerce-medium
${extra}`;

  it("accepts a known flag", () => {
    expect(parseQueue(q("    complianceFlags: [sensitive-audience]"))[0].complianceFlags).toEqual([
      "sensitive-audience",
    ]);
  });

  it("REFUSES an unknown flag rather than silently ignoring it", () => {
    // A misspelled flag matches nothing in the rules OR the hazards, so the run
    // would score cleanly on a hazard that was never defended and never tested.
    expect(() => parseQueue(q("    complianceFlags: [sensitve-audience]"))).toThrow(/unknown complianceFlag/);
  });

  it("refuses a non-list", () => {
    expect(() => parseQueue(q("    complianceFlags: sensitive-audience"))).toThrow(/must be a list/);
  });

  it("leaves flags undefined when absent", () => {
    expect(parseQueue(q("    score: 50"))[0].complianceFlags).toBeUndefined();
  });
});

describe("the example queue", () => {
  it("parses, and the flagged example carries its flag", () => {
    const ps = parseQueue(
      require("node:fs").readFileSync(
        require("node:path").join(__dirname, "../../research/prospect-queue.example.yaml"),
        "utf8",
      ),
    );
    const sh = ps.find((p) => p.slug === "examplesupplements");
    expect(sh?.complianceTier).toBe("commerce-medium");
    expect(sh?.complianceFlags).toEqual(["sensitive-audience"]);
  });

  it("STRICT_TIERS still names the tiers that are strict on their own", () => {
    expect(STRICT_TIERS.has("clinic-high")).toBe(true);
    expect(STRICT_TIERS.has("commerce-medium")).toBe(false);
  });
});

describe("financial-advice flag", () => {
  const flagged = complianceSystemPrompt("Mach33", "commerce-medium", "", ["financial-advice"]);

  it("forbids the recommendation itself, not just personalisation", () => {
    // The hazard is an assistant that reads as INVESTMENT ADVICE over market
    // analysis. commerce-medium governs prices and terms for what a business
    // SELLS — a different thing from an opinion about what a reader should BUY.
    expect(has(flagged, /buy, sell, hold/i)).toBe(true);
    expect(has(flagged, /good investment|undervalued/i)).toBe(true);
    expect(has(flagged, /licensed professional/i)).toBe(true);
  });

  it("blocks suitability profiling, INCLUDING asking for the inputs", () => {
    // Collecting risk tolerance and horizon is the first step of the advice,
    // so refusing only at the final answer is too late.
    const rule = flagged.find((r) => /SUITABILITY/i.test(r))!;
    expect(rule).toMatch(/risk tolerance/i);
    expect(rule).toMatch(/do not ask/i);
  });

  it("allows attributed published analysis — the corpus IS research", () => {
    // A flag that forbade discussing the firm's own analysis would make the
    // demo useless; the line is attribution and dating, not silence.
    expect(has(flagged, /only where a retrieved source states it/i)).toBe(true);
    expect(has(flagged, /attributed .* and dated|Attribute it and say when/i)).toBe(true);
  });

  it("stops invented numbers, which is how research becomes a claim", () => {
    expect(has(flagged, /Never round, convert, annualize or combine/i)).toBe(true);
  });

  it("promotes commerce-medium to the strict base", () => {
    expect(has(flagged, /NEVER recommend, select, or suggest a product/)).toBe(true);
  });

  it("moves the QA hazards too", () => {
    const h = hazardsFor("commerce-medium", ["financial-advice"]);
    expect(h).toContain(TIER_HAZARDS["commerce-medium"]);
    expect(h).toMatch(/price target|valuation|forecast/i);
    expect(h).toMatch(/portfolio|risk tolerance/i);
  });

  it("does NOT pull in sensitive-audience rules", () => {
    // The flags are independent; a finance corpus should not inherit crisis
    // and pregnancy rules it has no use for.
    expect(has(flagged, /self-harm|pregnan/i)).toBe(false);
  });
});

describe("flags compose", () => {
  it("two flags both apply, in a deterministic order", () => {
    const a = complianceSystemPrompt("X", "commerce-medium", "", ["financial-advice", "sensitive-audience"]);
    const b = complianceSystemPrompt("X", "commerce-medium", "", ["sensitive-audience", "financial-advice"]);
    // Queue order must not change the prompt, or two identical prospects get
    // different bytes and any prompt-diffing review becomes noise.
    expect(a).toEqual(b);
    expect(has(a, /CRISIS/)).toBe(true);
    expect(has(a, /buy, sell, hold/i)).toBe(true);
  });

  it("an unknown flag alone does not promote a permissive tier", () => {
    // Keyed on RECOGNIZED flags: a typo must not silently change posture while
    // contributing no rules. (intake refuses it first; this is defence in depth.)
    const odd = complianceSystemPrompt("X", "commerce-medium", "", ["nonsense"]);
    expect(odd).toEqual(complianceSystemPrompt("X", "commerce-medium"));
  });
});

describe("a financial-advice prospect carries its flag", () => {
  it("parses the flag off a commerce-tier entry", () => {
    const ps = parseQueue(
      require("node:fs").readFileSync(
        require("node:path").join(__dirname, "../../research/prospect-queue.example.yaml"),
        "utf8",
      ),
    );
    const m = ps.find((p) => p.slug === "examplecapital");
    expect(m?.complianceFlags).toEqual(["financial-advice"]);
  });
});

describe("operator notes never reach the model", () => {
  /**
   * `complianceNotes` is read by the assistant as "Compliance scope for this
   * assistant: …". It used to be `prospect.notes ?? ""` — the operator-facing
   * research field — so internal scoring, Attio deal status, crawl-budget
   * reasoning and instructions addressed to a human reviewer ("⚠️ TIER GAP —
   * read before Gate 1") were all inside the system prompt of an assistant
   * handed to the prospect, recoverable by anyone who talked it into repeating
   * its instructions.
   */
  const q = (extra: string) => `prospects:
  - slug: x
    name: X
    url: https://x.example
    anchorCustomer: "attio:deals/abc"
    complianceTier: commerce-medium
${extra}`;

  it("does NOT fall back to `notes`", () => {
    const p = parseQueue(q('    notes: "Scored 60. No Attio deal yet. Read before Gate 1."'))[0];
    expect(p.complianceNotes).toBeUndefined();
  });

  it("uses complianceNotes when present", () => {
    const p = parseQueue(q('    complianceNotes: "Answer from published research, attributed."'))[0];
    expect(p.complianceNotes).toBe("Answer from published research, attributed.");
  });

  it("an absent scope emits no scope line at all — safe, not silent", () => {
    // The tier and flag rules still bind; only the free-text line disappears.
    const rules = complianceSystemPrompt("X", "commerce-medium", "", ["financial-advice"]);
    expect(rules.some((r) => /Compliance scope for this assistant/.test(r))).toBe(false);
    expect(rules.some((r) => /buy, sell, hold/i.test(r))).toBe(true);
  });

  it("no queued prospect's model-facing scope reads like operator notes", () => {
    const ps = parseQueue(
      require("node:fs").readFileSync(
        require("node:path").join(__dirname, "../../research/prospect-queue.example.yaml"),
        "utf8",
      ),
    );
    const leaks = ps
      .filter((p) => /Gate 1|Scored \d|attio:|TIER GAP|MEASURED|NURTURE|build-now/i.test(p.complianceNotes ?? ""))
      .map((p) => p.slug);
    expect(leaks, "these scopes contain operator-facing material").toEqual([]);
  });
});

describe("every flag is wired in ALL THREE places", () => {
  it("FLAGS, FLAG_RULES and FLAG_HAZARDS name the same set", () => {
    // "Each flag adds prompt rules AND matching QA hazards, and adding one
    // without the other is how a hazard ends up scored but undefended." That
    // warning was written into the queue file and then relied on a human to
    // honour it. Three hand-maintained lists in three modules drift; this is
    // the only thing that would notice.
    const fromRules = Object.keys(FLAG_RULES).sort();
    const fromHazards = Object.keys(FLAG_HAZARDS).sort();
    expect(fromRules).toEqual([...FLAGS].sort());
    expect(fromHazards).toEqual([...FLAGS].sort());
  });

  it("legal-advice carries the two rules with no analogue elsewhere", () => {
    const rules = LEGAL_ADVICE_RULES.join(" ");
    // A prospective client typing case facts into a chat box on the firm's own
    // site can reasonably believe they are talking to the firm in confidence.
    expect(rules).toMatch(/not confidential or privileged/i);
    // A missed limitation period cannot be undone, and "roughly how long do I
    // have?" is the most natural question to ask a law firm's website.
    expect(rules).toMatch(/deadline|limitation period/i);
  });

  it("promotes a permissive tier to the strict base, like the other flags", () => {
    const plain = complianceSystemPrompt("X", "wellness-low", "", []);
    const withFlag = complianceSystemPrompt("X", "wellness-low", "", ["legal-advice"]);
    expect(withFlag.length).toBeGreaterThan(plain.length + LEGAL_ADVICE_RULES.length - 1);
  });
});

/**
 * `public-service` (added 2026-08-13 for the County of San Diego).
 *
 * A county is not described by any tier — the four tiers classify what an
 * organization SELLS, and a county sells nothing. The first draft of that queue
 * entry invented a `government-high` TIER, which would have failed validation
 * and, worse, produced NO tier hazards in qa-suite-gen: an unknown key yields
 * undefined, `.filter(Boolean)` drops it, and the run reports a clean score for
 * hazards nothing tested. A flag is the design-consistent answer, and it is the
 * same resolution `financial-advice` got for Mach33.
 */
describe("public-service", () => {
  const prompt = () =>
    complianceSystemPrompt("County of X", "commerce-medium", "", ["public-service"]);

  it("promotes commerce-medium to the strict base", () => {
    // This is the mechanism the County entry depends on: its tier is
    // commerce-medium, whose unflagged posture ends with "answer helpfully".
    // If the flag stopped promoting, that permissive line would be the last
    // word on everything the flag does not name.
    const plain = complianceSystemPrompt("County of X", "commerce-medium", "", []);
    expect(plain.join(" ")).toMatch(/helpfully and factually/i);
    expect(prompt().join(" ")).not.toMatch(/helpfully and factually/i);
  });

  it("refuses to decide eligibility — the worst failure for a benefits portal", () => {
    // "Do I qualify for CalFresh?" is the most natural question a county site
    // receives and the one where a confident answer does real harm.
    expect(has([...FLAG_RULES["public-service"]], /eligibilit/i)).toBe(true);
    expect(FLAG_HAZARDS["public-service"]).toMatch(/qualif/i);
  });

  it("treats crawled emergency content as a snapshot, never as live status", () => {
    // Stale evacuation information is the one failure here that can get
    // somebody hurt, and a crawl cannot know it is stale.
    const rules = FLAG_RULES["public-service"].join(" ");
    expect(rules).toMatch(/evacuat/i);
    expect(rules).toMatch(/snapshot|out of date|not a live source/i);
    expect(FLAG_HAZARDS["public-service"]).toMatch(/evacuat|emergency/i);
  });

  it("pins elections to a named published page", () => {
    expect(FLAG_RULES["public-service"].join(" ")).toMatch(/election/i);
    expect(FLAG_HAZARDS["public-service"]).toMatch(/election/i);
  });

  it("still tells the assistant to be useful", () => {
    // Every rule here is a prohibition except one. A wayfinding assistant that
    // refuses wayfinding questions has failed differently but just as
    // completely — the same balance the strict base strikes with "refusing an
    // ordinary question is also a failure".
    expect(has([...FLAG_RULES["public-service"]], /genuinely useful|do it fully/i)).toBe(true);
  });

  it("composes with legal-advice without repeating it", () => {
    // The County carries both. Overlap is expected (permits, deadlines); a
    // repeated instruction is not stronger, it just crowds the context.
    const both = complianceSystemPrompt("County of X", "commerce-medium", "", [
      "public-service",
      "legal-advice",
    ]);
    expect(new Set(both).size).toBe(both.length);
  });
});

describe("the example queue covers the whole vocabulary", () => {
  /**
   * Several safety properties in this file and in gate1-auto.test.ts are
   * quantified over EVERY prospect in the queue — "no clinic-high prospect
   * auto-approves", "no model-facing scope reads like operator notes". Since
   * the real queue is not published, they run against
   * research/prospect-queue.example.yaml.
   *
   * That makes the example load-bearing in a way an example usually is not: a
   * tier or flag with no entry there is a tier or flag those safety tests
   * silently stop covering. Nothing fails, the suite stays green, and the
   * coverage quietly narrows to whatever happens to be in the file.
   *
   * So the vocabulary is read from the CODE (`TIERS`, `FLAG_RULES`) rather
   * than restated here — adding a tier without adding an example fails this,
   * which is the whole point.
   */
  const queue = parseQueue(
    require("node:fs").readFileSync(
      require("node:path").join(__dirname, "../../research/prospect-queue.example.yaml"),
      "utf8",
    ),
  );

  it("exercises every compliance tier", () => {
    const used = new Set(queue.map((p) => p.complianceTier));
    const missing = TIERS.filter((t) => !used.has(t));
    expect(missing, "tiers with no example — safety tests no longer cover them").toEqual([]);
  });

  it("exercises every compliance flag", () => {
    const used = new Set(queue.flatMap((p) => p.complianceFlags ?? []));
    const missing = (Object.keys(FLAG_RULES) as string[]).filter((f) => !used.has(f as never));
    expect(missing, "flags with no example — safety tests no longer cover them").toEqual([]);
  });

  it("keeps at least one clinic-high entry — the gate that must never auto-approve", () => {
    expect(queue.filter((p) => p.complianceTier === "clinic-high").length).toBeGreaterThan(0);
  });

  it("agrees with the flag list intake validates against", () => {
    expect([...FLAGS].sort()).toEqual(Object.keys(FLAG_RULES).sort());
  });
});
