/**
 * The Gate 3 card must carry the EMAIL, not a path to it.
 *
 * Two things write that block: `run.ts` at card time, and
 * `scripts/surface-outreach-drafts.py` back-filling cards filed before this
 * existed. They fence it with a marker so a re-run REPLACES rather than
 * appends.
 *
 * That only holds while both use byte-identical markers. A divergence does not
 * throw and does not fail a run — it silently produces a card containing the
 * same email twice, and a card that repeats itself is one people stop reading.
 * Since the two live in different languages, in different directories, nothing
 * but this test connects them.
 *
 * Background: on 2026-08-15 there were 72 finished drafts on disk, 51 cards
 * waiting, and zero emails ever sent — while 35 cards had been bulk-closed in a
 * single day with no send. The copy was good; it was addressed to a filepath.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const runTs = readFileSync(join(ROOT, "src", "run.ts"), "utf8");
const surfacePy = readFileSync(
  join(ROOT, "scripts", "surface-outreach-drafts.py"),
  "utf8",
);

function tsConst(name: string): string | undefined {
  return new RegExp(`const ${name} = "([^"]+)";`).exec(runTs)?.[1];
}
function pyConst(name: string): string | undefined {
  return new RegExp(`^${name} = "([^"]+)"`, "m").exec(surfacePy)?.[1];
}

describe("outreach draft embedding", () => {
  it("uses the same fence markers in run.ts and the back-fill script", () => {
    expect(tsConst("DRAFT_MARK")).toBeTruthy();
    expect(tsConst("DRAFT_MARK")).toBe(pyConst("BEGIN"));
    expect(tsConst("DRAFT_END")).toBe(pyConst("END"));
  });

  it("replaces the fenced block rather than appending a second copy", () => {
    // The regex form is what makes a re-run idempotent. Without it every run
    // of a resumed pipeline stacks another copy of the email.
    // Asserted in pieces rather than as one literal: the source contains
    // `[\\s\\S]`, which is two characters of escaping away from whatever this
    // file's own string syntax produces — the first version of this assertion
    // compared a single-backslash string against a double-backslash source and
    // failed for a reason that had nothing to do with run.ts.
    expect(runTs).toContain("new RegExp(`${DRAFT_MARK}");
    expect(runTs).toContain("${DRAFT_END}`)");
    expect(runTs).toMatch(/re\.test\(body\) \? body\.replace\(re, fenced\)/);
  });

  it("embeds the draft only AFTER the demo link has been injected", () => {
    // injectDemoLink() replaces the `[demo link · expires …]` placeholder in
    // email-draft.md. Embedding before it would put a draft on the card whose
    // central call to action is still a placeholder — and it would look
    // finished, which is worse than looking broken.
    const inject = runTs.indexOf("await injectDemoLink(");
    const embed = runTs.indexOf("Put the email itself ON the card");
    expect(inject).toBeGreaterThan(-1);
    expect(embed).toBeGreaterThan(inject);
  });

  it("is best-effort — it cannot stall the gate", () => {
    // A card that fails to gain its draft is a card with a file path in it,
    // which is merely where we started. Throwing here would block a run over a
    // presentation concern.
    const block = runTs.slice(runTs.indexOf("Put the email itself ON the card"));
    expect(block.slice(0, 2000)).toContain("could not embed the draft");
  });

  it("says so out loud when there is no draft to embed", () => {
    // Silence here is indistinguishable from success: the card would look
    // complete while carrying nothing to send.
    expect(runTs).toContain("no email-draft.md to embed");
  });

  it("neither writer gains a send capability", () => {
    // The whole point is that a human sends. If either of these ever learns to
    // send mail, that is a decision to make deliberately, not a diff to notice
    // later — cold outreach is exactly where a prompt-injected agent does
    // reputational damage.
    for (const src of [runTs, surfacePy]) {
      expect(src).not.toMatch(/nodemailer|sendgrid|mailgun|smtp\.|users\.messages\.send/i);
    }
  });
});
