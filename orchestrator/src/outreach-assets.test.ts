import { describe, it, expect } from "vitest";
import {
  buildEmailPrompt,
  buildResearchPrompt,
  buildDeckPrompt,
  validateEmail,
  demoLinkBlock,
  emailLinkProblems,
  DEMO_LINK_PLACEHOLDER,
  type OutreachContext,
} from "./outreach-assets.js";
import type { Manifest } from "./types.js";

const manifest = {
  prospect: "stoneclinic",
  prospectName: "The Stone Clinic",
  complianceTier: "clinic-high",
  complianceNotes: "Operating clinic — education only.",
  anchorCustomer: "attio:deals/x",
  evalQueries: [],
} as unknown as Manifest;

const ctx: OutreachContext = { manifest, corpusBrief: "blog pages", indexedCount: 397 };

describe("validateEmail", () => {
  const good = `Subject: We built you something\n\nHi — one specific thing.\n\n${DEMO_LINK_PLACEHOLDER}\n\nMike`;

  it("accepts a well-formed draft", () => {
    expect(validateEmail(good)).toEqual([]);
  });

  it("rejects a draft with no Subject line", () => {
    expect(validateEmail(good.replace(/Subject:.*\n/, ""))).toContain("no Subject: line");
  });

  it("accepts a markdown-bold Subject label", () => {
    // Real drafts come back as markdown and write `**Subject:**`. Requiring a
    // bare `Subject:` flagged a perfectly good email as failing validation.
    const md = good.replace("Subject:", "**Subject:**");
    expect(validateEmail(md)).toEqual([]);
  });

  it("accepts a Subject inside a heading or quote", () => {
    expect(validateEmail(good.replace("Subject:", "## Subject:"))).toEqual([]);
    expect(validateEmail(good.replace("Subject:", "> Subject:"))).toEqual([]);
  });

  it("REJECTS a missing placeholder — the link would have nowhere to go", () => {
    // injectDemoLink() looks for this exact marker. Without it the email ships
    // with no demo link at all, which defeats the entire outreach.
    const problems = validateEmail(good.replace(DEMO_LINK_PLACEHOLDER, "our demo"));
    expect(problems.join(" ")).toMatch(/placeholder/);
  });

  it("REJECTS an invented demo URL — a made-up link is a dead link", () => {
    const bad = good.replace(DEMO_LINK_PLACEHOLDER, "https://demo-stoneclinic.divinci.app");
    expect(validateEmail(bad).join(" ")).toMatch(/invented demo URL|placeholder/);
  });

  it("rejects a rambling draft", () => {
    const long = `Subject: x\n\n${"word ".repeat(500)}\n${DEMO_LINK_PLACEHOLDER}`;
    expect(validateEmail(long).join(" ")).toMatch(/too long/);
  });
});

describe("buildEmailPrompt", () => {
  it("forbids inventing a URL and pins the exact placeholder", () => {
    const p = buildEmailPrompt(ctx, "research");
    expect(p).toContain(DEMO_LINK_PLACEHOLDER);
    expect(p).toMatch(/Do not invent a URL/);
  });

  it("adds a no-medical-advice rule for clinic-high", () => {
    expect(buildEmailPrompt(ctx, "r")).toMatch(/medical advice|diagnoses/);
  });

  it("adds it for sensitive-audience too", () => {
    const p = buildEmailPrompt(
      { ...ctx, manifest: { ...manifest, complianceTier: "sensitive-audience" } },
      "r",
    );
    expect(p).toMatch(/medical advice|diagnoses/);
  });

  it("omits the clinical rule for a low-risk wellness prospect", () => {
    const p = buildEmailPrompt(
      { ...ctx, manifest: { ...manifest, complianceTier: "wellness-low" } },
      "r",
    );
    expect(p).not.toMatch(/replaces clinical judgement/);
  });

  it("forbids naming another customer", () => {
    expect(buildEmailPrompt(ctx, "r")).toMatch(/not name any other customer/i);
  });

  it("only states a QA score when there is one", () => {
    expect(buildEmailPrompt(ctx, "r")).not.toMatch(/QUALITY: scored/);
    expect(buildEmailPrompt({ ...ctx, qaScore: 0.94, qaTestCount: 10 }, "r")).toMatch(/scored 94%/);
  });
});

describe("buildDeckPrompt", () => {
  it("tells the model NOT to invent a QA number when the run has none", () => {
    expect(buildDeckPrompt(ctx, "r")).toMatch(/do NOT invent one/);
  });

  it("passes a real score through", () => {
    expect(buildDeckPrompt({ ...ctx, qaScore: 0.9, qaTestCount: 10 }, "r")).toMatch(/90%/);
  });
});

describe("buildResearchPrompt", () => {
  it("forbids fabricated firmographics", () => {
    const p = buildResearchPrompt(ctx);
    expect(p).toMatch(/Invent nothing/);
    expect(p).toMatch(/revenue figures|headcounts/);
  });
});

describe("demoLinkBlock", () => {
  const base = { link: "https://demo-x.workers.dev", expires: "2026-08-21", readiness: { ready: true } };

  it("carries the preview password — the link 401s without it", () => {
    // mach33's draft read "It's live now:" above a URL answering 401. The
    // password existed in state.json and on the review-board task, one artifact away
    // from the only place it was needed. Every demo is preview-gated until Gate
    // 3, so this was every outreach email the pipeline had ever drafted.
    const out = demoLinkBlock({ ...base, auth: { username: "preview", password: "mach33-4943" } });
    expect(out).toContain("mach33-4943");
    expect(out).toContain("preview");
  });

  it("puts the password directly under the link, not in a footnote", () => {
    const out = demoLinkBlock({ ...base, auth: { username: "preview", password: "pw" } });
    expect(out.indexOf("password")).toBeLessThan(out.indexOf("expires"));
  });

  it("says nothing about a password when there is no gate", () => {
    expect(demoLinkBlock(base)).not.toMatch(/password/i);
  });

  it("still surfaces a not-send-ready reason", () => {
    const out = demoLinkBlock({ ...base, readiness: { ready: false, reason: "release not public" } });
    expect(out).toContain("NOT send-ready");
    expect(out).toContain("release not public");
  });

  it("keeps the markers injection depends on", () => {
    const out = demoLinkBlock(base);
    expect(out).toContain("<!-- demo-link:start");
    expect(out).toContain("<!-- demo-link:end -->");
  });
});

describe("emailLinkProblems", () => {
  it("catches an email that omits the password for a gated demo", () => {
    const problems = emailLinkProblems("Live demo: https://x.dev", { password: "pw-123" });
    expect(problems[0]).toMatch(/401/);
  });

  it("is silent once the password is present", () => {
    expect(emailLinkProblems("password `pw-123`", { password: "pw-123" })).toEqual([]);
  });

  it("catches a draft still wrapped in a code fence", () => {
    // The fence pastes into the email client along with the body.
    expect(emailLinkProblems("```markdown\nSubject: hi\n```").join()).toMatch(/code fence/);
  });

  it("says nothing about an ungated demo", () => {
    expect(emailLinkProblems("Live demo: https://x.dev")).toEqual([]);
  });
});
