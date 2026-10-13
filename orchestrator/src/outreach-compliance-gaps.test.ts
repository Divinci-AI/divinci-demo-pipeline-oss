import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addSuppression,
  complianceFooter,
  complianceProblems,
  ensureComplianceFooter,
  isSuppressed,
  loadSuppressionList,
} from "./outreach-compliance.js";

/**
 * Three behaviours of outreach-compliance.ts that outreach-compliance.test.ts
 * does not pin, found by planting small changes in the source and seeing which
 * ones the existing tests missed. Each test below fails when its change is made.
 */

const ADDR = "1 Example Way, Suite 2, Somewhere, CA 90210";
const SENDER = "Example Demos, Inc.";
const env = () =>
  ({
    OUTREACH_POSTAL_ADDRESS: ADDR,
    OUTREACH_SENDER_LEGAL_NAME: SENDER,
    OUTREACH_OPTOUT_ADDRESS: "stop@example.invalid",
  }) as NodeJS.ProcessEnv;

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "outreach-compliance-gaps-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("complianceProblems", () => {
  it("accepts the unsubscribe wording in any letter case", () => {
    const footer = ensureComplianceFooter("Body.", env());
    for (const word of ["Unsubscribe", "UNSUBSCRIBE"]) {
      expect(complianceProblems(footer.replace(/unsubscribe/gi, word), env())).toEqual([]);
    }
  });
});

describe("isSuppressed", () => {
  it("does not report a blank or whitespace-only recipient as opted out", () => {
    addSuppression("acme.com", { root });
    addSuppression("foo@bar.com", { root });
    const list = loadSuppressionList(root);
    // Positive control: the list loaded and does suppress real recipients, so the two `false` answers below are about the blank input.
    expect(list).toHaveLength(2);
    expect(isSuppressed("anyone@acme.com", list)).toBe(true);
    expect(isSuppressed("foo@bar.com", list)).toBe(true);
    expect(isSuppressed("", list)).toBe(false);
    expect(isSuppressed("   ", list)).toBe(false);
  });
});

describe("complianceFooter", () => {
  it("puts the legal name before the postal address, on one line", () => {
    expect(complianceFooter(env()).split("\n")).toContain(`${SENDER} · ${ADDR}`);
  });
});
