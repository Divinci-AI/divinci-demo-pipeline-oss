/**
 * Outreach asset drafting.
 *
 * The Gate-3 review-board task used to be three empty markdown checkboxes — expanded
 * research, an email, a Canva deck — for a human or an agent to fill in later.
 * Later mostly did not come: of the first 19 runs, ONE had an email-draft.md.
 * A checklist item that is skipped 18 times out of 19 is not a process, so the
 * two text assets are now drafted by the pipeline and the task reviews real
 * drafts instead of asking someone to start from a blank file.
 *
 * ON CANVA. The deck is NOT generated, and this is a capability limit rather
 * than a decision: the Canva MCP server reports "needs authentication" for both
 * the CLI and the desktop app, so nothing here can reach it. What IS produced is
 * a slide-by-slide spec with the copy already written, so that building the deck
 * is mechanical once someone has an authenticated Canva session. Claiming the
 * deck was automated when the integration cannot connect would be worse than
 * leaving the checkbox: the task would say "done" and no deck would exist.
 *
 * Nothing here sends anything. Drafts land in runs/<prospect>/<run>/outreach/
 * and a human still approves Gate 3.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runClaude } from "./claude-cli.js";
import { untrustedBlock } from "./prompt-safety.js";
import type { Manifest } from "./types.js";

const execFileP = promisify(execFile);

export interface OutreachContext {
  manifest: Manifest;
  /** Titles/URLs of what the corpus actually indexed. */
  corpusBrief: string;
  /** Indexed file count, for the "we built this from N pages" line. */
  indexedCount?: number;
  /** ScoredQA result, when the run has one. */
  qaScore?: number | null;
  qaPassedCount?: number;
  qaTestCount?: number;
}

/**
 * The placeholder injectDemoLink() replaces. Kept as a constant because the two
 * must agree: a drafted email whose placeholder does not match the injector's
 * regex silently ships without a demo link, which is the one thing the email
 * exists to deliver.
 */
/**
 * How long an approved demo stays up, in days.
 *
 * Was 14. Raised to 60 on 2026-08-10: the expiry clock starts at Gate 3
 * APPROVAL, but sending is manual (Attio/Gmail), so a 14-day window was
 * really "14 days minus however long the email sits in the queue" — and with
 * 35 demos approved in one batch, most of that window would have burned
 * before anyone was contacted.
 *
 * Single source of truth. This value appeared in five places (two date
 * computations and three strings), so a change used to leave the prose
 * claiming one window while teardown enforced another — the email is what the
 * prospect reads, and it is the copy most likely to be missed.
 */
export const DEMO_EXPIRY_DAYS = 60;

export const DEMO_LINK_PLACEHOLDER = `[demo link · expires in ${DEMO_EXPIRY_DAYS} days]`;

export function buildResearchPrompt(ctx: OutreachContext): string {
  const { manifest } = ctx;
  return [
    "Write a short outreach research brief on the company below, for a",
    "salesperson about to email them. Markdown. 300-500 words.",
    "",
    "Cover, only where you can support it from the corpus survey provided:",
    "- what the business actually does, and who it serves",
    "- the shape of their public content (how much, what kind, how current)",
    "- what an AI assistant over that content would plausibly be worth to them",
    "- ONE specific, concrete detail worth referencing in a first email",
    "",
    "RULES:",
    "- Invent nothing. No revenue figures, headcounts, funding, or named staff",
    "  unless they appear in the survey below. An outreach email that cites a",
    "  fabricated detail is worse than one that cites none.",
    "- Mark anything uncertain as uncertain.",
    "- Do not speculate about their budget or their current vendors.",
    "",
    `COMPANY: ${manifest.prospectName}`,
    `COMPLIANCE CONTEXT: ${manifest.complianceTier} — ${manifest.complianceNotes || "(none)"}`,
    "",
    untrustedBlock("indexed page titles from the prospect's website", ctx.corpusBrief),
  ].join("\n");
}

export function buildEmailPrompt(ctx: OutreachContext, research: string): string {
  const { manifest } = ctx;
  return [
    "Write a first outreach email. Markdown, with a `Subject:` line first.",
    "",
    "THE OFFER: we built them a working AI assistant over their own public",
    "content, already live at a link. Not a pitch deck — a thing they can use.",
    "",
    "RULES:",
    "- Under 150 words. A long first email does not get read.",
    "- Reference exactly ONE specific detail from the research below, so it is",
    "  obvious a person looked at their site.",
    `- Include the literal placeholder ${DEMO_LINK_PLACEHOLDER} on its own line`,
    "  where the demo link goes. Do not invent a URL — the pipeline injects the",
    "  real one, and a made-up link is a dead link.",
    "- No fabricated metrics, no invented mutual connections, no fake urgency.",
    "- Do not name any other customer of ours.",
    "- Plain, direct, and specific. No 'I hope this finds you well'.",
    ...(manifest.complianceTier === "clinic-high" || manifest.complianceTier === "sensitive-audience"
      ? [
          "- This is a regulated/sensitive audience: do NOT claim the assistant",
          "  gives medical advice, diagnoses, or replaces clinical judgement.",
          "  It answers questions from their published material and hands off.",
        ]
      : []),
    "",
    `COMPANY: ${manifest.prospectName}`,
    ...(ctx.indexedCount ? [`PAGES WE INDEXED: ${ctx.indexedCount}`] : []),
    ...(ctx.qaScore != null
      ? [`QUALITY: scored ${(ctx.qaScore * 100).toFixed(0)}% on ${ctx.qaTestCount ?? "?"} adversarial tests`]
      : []),
    "",
    untrustedBlock("research brief, itself derived from the prospect's website", research, 3500),
  ].join("\n");
}

export function buildDeckPrompt(ctx: OutreachContext, research: string): string {
  return [
    "Write a slide-by-slide spec for a 6-slide follow-up deck. Markdown.",
    "",
    "For EACH slide give: a title, at most 3 bullets (max ~12 words each), and",
    "a one-line note on the visual. This spec is built by hand in Canva, so it",
    "must be complete enough to assemble without further writing.",
    "",
    "Slides:",
    "1. What we built for them (name the company, name their content)",
    "2. How it works — their public content becomes a cited, searchable assistant",
    "3. What it can answer (3 real examples from their material)",
    "4. Quality — how it was measured",
    "5. What it would take to make it theirs",
    "6. Next step — one clear ask",
    "",
    "RULES: invent nothing; no fabricated metrics; no other customer names.",
    "",
    `COMPANY: ${ctx.manifest.prospectName}`,
    ...(ctx.qaScore != null
      ? [`QA: ${(ctx.qaScore * 100).toFixed(0)}% over ${ctx.qaTestCount ?? "?"} adversarial tests`]
      : ["QA: no score for this run — do NOT invent one; omit slide 4's number"]),
    ...(ctx.indexedCount ? [`INDEXED PAGES: ${ctx.indexedCount}`] : []),
    "",
    untrustedBlock("research brief, itself derived from the prospect's website", research, 3000),
  ].join("\n");
}

const claude = (prompt: string): Promise<string> => runClaude(prompt);

/**
 * Reject a draft that would embarrass us. Cheap structural checks only — this
 * cannot judge whether the content is true, which is why a human still approves
 * Gate 3.
 */
/**
 * The demo-link block that goes INTO the email.
 *
 * Carries the preview credentials when there are any. Until 2026-08-06 it did
 * not, and mach33's draft read "It's live now:" above a URL that answers 401 —
 * the password existed in state.json and on the review-board task, one artifact away
 * from the only place it was needed. Copy-paste the email and the prospect gets
 * a browser password prompt and nothing else.
 *
 * Every demo is preview-gated until Gate 3, so this was not an edge case: it
 * was every outreach email the pipeline had ever drafted.
 */
export function demoLinkBlock(opts: {
  link: string;
  expires: string;
  readiness: { ready: boolean; reason?: string };
  auth?: { username: string; password: string };
}): string {
  const lines = [
    "<!-- demo-link:start (auto-injected by the pipeline) -->",
    `**Live demo:** ${opts.link}`,
  ];
  if (opts.auth?.password) {
    // Immediately under the link, not in a footnote. It is a precondition for
    // the link working, not extra detail.
    lines.push(
      "",
      `It's password-protected while it's just for you — username \`${opts.auth.username}\`, ` +
        `password \`${opts.auth.password}\`.`,
    );
  }
  if (!opts.readiness.ready)
    lines.push("", `⚠ NOT send-ready: ${opts.readiness.reason ?? "unknown"}. Resolve before sending.`);
  lines.push("", `*(expires ${opts.expires} — ${DEMO_EXPIRY_DAYS} days)*`, "<!-- demo-link:end -->");
  return lines.join("\n");
}

/**
 * Would this email send a link the recipient cannot open?
 *
 * Separate from `validateEmail` because it runs LATER — after injection, on the
 * final artifact — and because it is about the deployed demo rather than the
 * prose.
 */
export function emailLinkProblems(text: string, auth?: { password?: string }): string[] {
  const problems: string[] = [];
  if (auth?.password && !text.includes(auth.password))
    problems.push(
      "the demo is preview-gated but the email does not carry the password — the recipient would hit a 401",
    );
  // A fenced draft pastes the fence into the email client along with the body.
  if (/^\s*```/.test(text)) problems.push("the draft is wrapped in a code fence — strip it before sending");
  return problems;
}

export function validateEmail(text: string): string[] {
  const problems: string[] = [];
  // Tolerate markdown emphasis around the label: the drafts come back as
  // markdown, and `**Subject:**` is the common shape. Requiring a bare
  // `Subject:` flagged a perfectly good email as broken.
  if (!/^[*_#>\s]*subject[*_\s]*:/im.test(text)) problems.push("no Subject: line");
  if (!text.includes(DEMO_LINK_PLACEHOLDER))
    problems.push(
      `missing the ${DEMO_LINK_PLACEHOLDER} placeholder — the pipeline would have nowhere to inject the demo link`,
    );
    // A model that "helpfully" writes a plausible URL ships a dead link to a
    // real prospect; the pipeline is the only thing that knows the real one.
  if (/https?:\/\/(?!\S*placeholder)\S*(demo|divinci)\S*/i.test(text.replace(DEMO_LINK_PLACEHOLDER, "")))
    problems.push("contains an invented demo URL — only the injected placeholder may carry the link");
  const words = text.split(/\s+/).length;
  if (words > 400) problems.push(`too long (${words} words)`);
  return problems;
}

export interface DraftedAssets {
  researchPath: string;
  emailPath: string;
  deckPath: string;
  regenerated: string[];
}

/**
 * Draft the outreach package into `outreachDir`. Idempotent by design: an
 * existing file is left ALONE, because it may be a human's edit and silently
 * overwriting someone's rewrite is unforgivable in a loop that runs nightly.
 */
export async function draftOutreachAssets(
  ctx: OutreachContext,
  outreachDir: string,
  opts: { force?: boolean } = {},
): Promise<DraftedAssets> {
  const researchPath = join(outreachDir, "research-expanded.md");
  const emailPath = join(outreachDir, "email-draft.md");
  const deckPath = join(outreachDir, "deck-spec.md");
  const regenerated: string[] = [];

  const needs = (p: string) => opts.force || !existsSync(p);

  let research = existsSync(researchPath) ? readFileSync(researchPath, "utf8") : "";
  if (needs(researchPath)) {
    research = await claude(buildResearchPrompt(ctx));
    writeFileSync(researchPath, `${research}\n`);
    regenerated.push("research-expanded.md");
  }

  if (needs(emailPath)) {
    let email = await claude(buildEmailPrompt(ctx, research));
    let problems = validateEmail(email);
    if (problems.length) {
      email = await claude(
        `${buildEmailPrompt(ctx, research)}\n\nYour previous draft was REJECTED: ${problems.join("; ")}\nRewrite it.`,
      );
      problems = validateEmail(email);
    }
    // Write it either way, flagged. A draft a human must fix is more useful
    // than no draft — but it must not look approved.
    const header = problems.length
      ? `> ⚠ AUTO-DRAFT FAILED VALIDATION — fix before sending: ${problems.join("; ")}\n\n`
      : "";
    writeFileSync(emailPath, `${header}${email}\n`);
    regenerated.push(`email-draft.md${problems.length ? " (needs fixing)" : ""}`);
  }

  if (needs(deckPath)) {
    const deck = await claude(buildDeckPrompt(ctx, research));
    writeFileSync(
      deckPath,
      [
        "<!-- Auto-drafted slide spec. The Canva MCP reports 'needs",
        "     authentication', so no design was created — build these six",
        "     slides in Canva once authenticated, then paste the design link",
        "     into the review board outreach task. -->",
        "",
        deck,
        "",
      ].join("\n"),
    );
    regenerated.push("deck-spec.md");
  }

  return { researchPath, emailPath, deckPath, regenerated };
}
