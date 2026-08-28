import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  senderLegalName,
  stripOneQuoteLayer,
  NEVER_SUPPRESS_WHOLE_DOMAIN,
  senderPostalAddress,
  optOutAddress,
  normaliseAddress,
  domainOf,
  loadSuppressionList,
  isSuppressed,
  addSuppression,
  suppressionPath,
  complianceFooter,
  ensureComplianceFooter,
  complianceProblems,
  assertNotSuppressed,
} from "./outreach-compliance.js";

const ADDR = "1 Example Way, Suite 2, Somewhere, CA 90210";
const SENDER = "Example Demos, Inc.";
const OPTOUT = "stop@example.invalid";
const env = (over: Record<string, string | undefined> = {}) =>
  ({
    OUTREACH_POSTAL_ADDRESS: ADDR,
    OUTREACH_SENDER_LEGAL_NAME: SENDER,
    OUTREACH_OPTOUT_ADDRESS: OPTOUT,
    ...over,
  }) as NodeJS.ProcessEnv;

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "outreach-compliance-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("postal address", () => {
  /**
   * The single most dangerous thing this module could do is ship a plausible
   * fake address to thousands of recipients.
   */
  it("has NO default — absence is null, never a placeholder", () => {
    expect(senderPostalAddress({} as NodeJS.ProcessEnv)).toBeNull();
    expect(senderPostalAddress({ OUTREACH_POSTAL_ADDRESS: "  " } as NodeJS.ProcessEnv)).toBeNull();
  });

  it("never emits a bracketed/TODO placeholder for a missing address", () => {
    const problems = complianceProblems("body", {} as NodeJS.ProcessEnv);
    expect(problems.join(" ")).not.toMatch(/\[.*address.*\]|TODO|XXX|placeholder/i);
    expect(problems.some((p: string) => /OUTREACH_POSTAL_ADDRESS is not set/.test(p))).toBe(true);
  });

  it("building a footer without one THROWS rather than omitting it", () => {
    expect(() => complianceFooter({} as NodeJS.ProcessEnv)).toThrow(/OUTREACH_POSTAL_ADDRESS/);
  });

  it("collapses a multi-line address onto one line", () => {
    const multi = "Divinci AI, Inc.\n1 Example Way\nSomewhere, CA 90210";
    expect(senderPostalAddress({ OUTREACH_POSTAL_ADDRESS: multi } as NodeJS.ProcessEnv))
      .toBe("Divinci AI, Inc., 1 Example Way, Somewhere, CA 90210");
  });
});

describe("opt-out address", () => {
  it("is read from the environment", () => {
    expect(optOutAddress({ OUTREACH_OPTOUT_ADDRESS: OPTOUT } as NodeJS.ProcessEnv)).toBe(OPTOUT);
  });

  /**
   * ⚠️ There is deliberately NO fallback. It used to default to a real
   * person's mailbox, which a fork would then advertise as its unsubscribe
   * route — offering an opt-out that reaches someone with no ability to honour
   * it for that fork. Offering a route that silently drops the request is
   * worse than offering none, because it also makes a compliance claim.
   */
  it("has no default — an unhonourable opt-out route must block the footer", () => {
    expect(optOutAddress({} as NodeJS.ProcessEnv)).toBeNull();
    expect(() => complianceFooter(env({ OUTREACH_OPTOUT_ADDRESS: undefined })))
      .toThrow(/OUTREACH_OPTOUT_ADDRESS/);
  });
});

describe("sender legal name", () => {
  it("is read from the environment", () => {
    expect(senderLegalName({ OUTREACH_SENDER_LEGAL_NAME: SENDER } as NodeJS.ProcessEnv)).toBe(SENDER);
  });

  /**
   * The same argument the postal address makes. A default would be the name of
   * whoever this repository was extracted from, so a fork's outreach would
   * identify a company that did not send it — false, and structurally valid.
   */
  it("has no default — a fork must not send as somebody else", () => {
    expect(senderLegalName({} as NodeJS.ProcessEnv)).toBeNull();
    expect(() => complianceFooter(env({ OUTREACH_SENDER_LEGAL_NAME: undefined })))
      .toThrow(/OUTREACH_SENDER_LEGAL_NAME/);
  });

  it("absorbs the quotes an operator naturally types in .env", () => {
    expect(senderLegalName({ OUTREACH_SENDER_LEGAL_NAME: `"${SENDER}"` } as NodeJS.ProcessEnv)).toBe(SENDER);
  });
});

describe("stripOneQuoteLayer", () => {
  it("strips one matched layer only", () => {
    expect(stripOneQuoteLayer('"a b"')).toBe("a b");
    expect(stripOneQuoteLayer("'a b'")).toBe("a b");
  });
  it("leaves an interior quote alone", () => {
    expect(stripOneQuoteLayer('Suite 2 "The Annex"')).toBe('Suite 2 "The Annex"');
  });
  it("reads a value that is nothing but quotes as absent", () => {
    expect(stripOneQuoteLayer('""')).toBe("");
  });
});

describe("address normalisation", () => {
  it("lower-cases and trims", () => {
    expect(normaliseAddress("  Foo@Bar.COM ")).toBe("foo@bar.com");
  });
  it("strips sub-addressing so an opt-out cannot be dodged by a +tag", () => {
    expect(normaliseAddress("foo+news@bar.com")).toBe("foo@bar.com");
    expect(normaliseAddress("foo+a+b@bar.com")).toBe("foo@bar.com");
  });
  it("survives an address with an @ in the local part", () => {
    expect(domainOf('"weird@thing"@bar.com')).toBe("bar.com");
  });
});

describe("suppression list", () => {
  it("an absent list is empty (nobody has opted out yet)", () => {
    expect(loadSuppressionList(root)).toEqual([]);
  });

  /**
   * The asymmetry that matters: empty means "send to everyone". A corrupt
   * file silently read as empty would convert every honoured opt-out back
   * into permission.
   */
  it("a CORRUPT list throws rather than reading as empty", () => {
    mkdirSync(join(root, "outreach"), { recursive: true });
    writeFileSync(suppressionPath(root), "{ not json", "utf8");
    expect(() => loadSuppressionList(root)).toThrow(/refusing to treat it as empty/);
  });

  it("matches the exact address, including through a +tag and case", () => {
    addSuppression("Foo@Bar.com", { root, source: "reply" });
    const list = loadSuppressionList(root);
    expect(isSuppressed("foo@bar.com", list)).toBe(true);
    expect(isSuppressed("FOO+news@bar.com", list)).toBe(true);
    expect(isSuppressed("other@bar.com", list)).toBe(false);
  });

  it("a bare-domain entry suppresses the whole company", () => {
    addSuppression("acme.com", { root });
    const list = loadSuppressionList(root);
    expect(isSuppressed("anyone@acme.com", list)).toBe(true);
    expect(isSuppressed("anyone@notacme.com", list)).toBe(false);
  });

  it("REFUSES to suppress a consumer mailbox provider wholesale", () => {
    for (const d of ["gmail.com", "outlook.com", "proton.me"]) {
      expect(NEVER_SUPPRESS_WHOLE_DOMAIN.has(d)).toBe(true);
      expect(() => addSuppression(d, { root })).toThrow(/consumer mailbox/);
    }
    // ...but the specific address is fine.
    expect(() => addSuppression("someone@gmail.com", { root })).not.toThrow();
  });

  it("is idempotent and records an audit trail", () => {
    addSuppression("foo@bar.com", { root, requestedAt: "2026-08-01T00:00:00.000Z", source: "reply" });
    addSuppression("FOO@bar.com", { root });
    const list = loadSuppressionList(root);
    expect(list).toHaveLength(1);
    expect(list[0].requestedAt).toBe("2026-08-01T00:00:00.000Z");
    expect(list[0].honouredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(list[0].source).toBe("reply");
  });

  it("writes valid JSON that round-trips", () => {
    addSuppression("foo@bar.com", { root });
    expect(() => JSON.parse(readFileSync(suppressionPath(root), "utf8"))).not.toThrow();
  });

  it("refuses an empty entry", () => {
    expect(() => addSuppression("   ", { root })).toThrow(/empty entry/);
  });
});

describe("assertNotSuppressed", () => {
  it("throws for someone who opted out — a re-draft is the same violation", () => {
    addSuppression("stop@acme.com", { root });
    expect(() => assertNotSuppressed("stop@acme.com", root)).toThrow(/asked us to stop/);
  });
  it("passes for everyone else", () => {
    expect(() => assertNotSuppressed("hello@acme.com", root)).not.toThrow();
  });
});

describe("footer injection", () => {
  it("carries the opt-out, the legal name and the postal address", () => {
    const f = complianceFooter(env());
    expect(f).toMatch(/unsubscribe/i);
    expect(f).toContain(ADDR);
    expect(f).toContain(SENDER);
    expect(f).toContain(OPTOUT);
  });

  it("is idempotent — re-running never stacks footers", () => {
    const once = ensureComplianceFooter("Body.", env());
    const twice = ensureComplianceFooter(once, env());
    expect(twice).toBe(once);
    expect(twice.match(/compliance:start/g) ?? []).toHaveLength(1);
  });

  it("refreshes a stale footer in place when the address changes", () => {
    const old = ensureComplianceFooter("Body.", env());
    const updated = ensureComplianceFooter(old, env({ OUTREACH_POSTAL_ADDRESS: "New Address, CA 90211" }));
    expect(updated).toContain("New Address, CA 90211");
    expect(updated).not.toContain(ADDR);
    expect(updated.match(/compliance:start/g) ?? []).toHaveLength(1);
  });

  it("keeps the body above the footer", () => {
    const out = ensureComplianceFooter("Hello there.", env());
    expect(out.indexOf("Hello there.")).toBeLessThan(out.indexOf("compliance:start"));
  });
});

describe("complianceProblems", () => {
  it("passes a properly injected draft", () => {
    expect(complianceProblems(ensureComplianceFooter("Body.", env()), env())).toEqual([]);
  });

  it("flags a draft with no footer at all", () => {
    const p = complianceProblems("Body with no footer.", env());
    expect(p.length).toBeGreaterThan(0);
    expect(p.join(" ")).toMatch(/postal address/);
    expect(p.join(" ")).toMatch(/opt-out/);
  });

  it("flags a footer whose address was hand-edited away", () => {
    const tampered = ensureComplianceFooter("Body.", env()).replace(ADDR, "");
    expect(complianceProblems(tampered, env()).join(" ")).toMatch(/postal address/);
  });

  it("flags a draft where the unsubscribe wording was removed", () => {
    const tampered = ensureComplianceFooter("Body.", env()).replace(/unsubscribe/gi, "");
    expect(complianceProblems(tampered, env()).join(" ")).toMatch(/no opt-out/);
  });
});

/**
 * The module is only worth anything if the pipeline actually calls it. These
 * read run.ts as SOURCE rather than mocking it: the failure being guarded
 * against is someone deleting the two call sites, and a mock cannot see that.
 */
describe("pipeline wiring", () => {
  const src = readFileSync(join(__dirname, "run.ts"), "utf8");

  it("injects the footer and checks it on the final artifact", () => {
    expect(src).toMatch(/ensureComplianceFooter\(email\)/);
    expect(src).toMatch(/complianceProblems\(email\)/);
  });

  /**
   * Adapted from the originating repo, which injects a signature block and
   * strips markdown around this point and asserts the footer sits between
   * them. This repo's outreach path has neither, so the invariant that
   * survives is the one that matters: the footer goes in BEFORE the draft is
   * written to disk, and is checked AFTER it goes in.
   */
  it("injects the footer before the draft is written to disk", () => {
    const footer = src.indexOf("ensureComplianceFooter(email)");
    const write = src.indexOf("writeFileSync(emailPath, email)");
    expect(footer).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(footer);
  });

  it("checks compliance on the injected artifact, not before injection", () => {
    expect(src.indexOf("complianceProblems(email)")).toBeGreaterThan(
      src.indexOf("ensureComplianceFooter(email)"),
    );
  });
});

describe("the .env quoting footgun", () => {
  /**
   * orchestrator/.env is parsed by /^([A-Z0-9_]+)=(.*)$/ — verbatim, no quote
   * stripping, unlike every other dotenv. Quoting a value with spaces is the
   * natural habit and would put literal quote marks into every email footer.
   */
  it("strips matched surrounding quotes rather than shipping them", () => {
    const real = "312 Arizona Ave, Santa Monica, California 90401";
    for (const v of [`"${real}"`, `'${real}'`]) {
      expect(senderPostalAddress({ OUTREACH_POSTAL_ADDRESS: v } as NodeJS.ProcessEnv)).toBe(real);
    }
  });

  it("leaves an unquoted value alone, and does not eat interior quotes", () => {
    const v = 'Suite 2 "The Annex", Santa Monica, CA';
    expect(senderPostalAddress({ OUTREACH_POSTAL_ADDRESS: v } as NodeJS.ProcessEnv)).toBe(v);
  });

  it("treats a value that is only quotes as absent", () => {
    expect(senderPostalAddress({ OUTREACH_POSTAL_ADDRESS: '""' } as NodeJS.ProcessEnv)).toBeNull();
  });
});
