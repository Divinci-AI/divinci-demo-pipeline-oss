// The AI-rights gate — the decision about whether we may index a host at all.
//
// In the repository this was extracted from, this gate's only coverage was a
// PARITY test against a Python twin in a private repo. There is no twin here,
// so parity would prove nothing and was dropped; these are unit tests of the
// policy itself, which is what actually needed guarding.
//
// The distinction every test below turns on: we build a retrieval index over a
// site's own content and cite it. We do not train. So a host that refuses
// TRAINING has not refused us, and treating those two as one decision is wrong
// in BOTH directions — it would decline work sites permitted, and it would
// obscure the refusals that are genuinely about us.
import { parseRobots, verdict } from "../src/ai-rights.js";

let fail = 0;
const ok = (c, m) => { if (!c) { console.log("  ❌ " + m); fail++; } else console.log("  ✅ " + m); };

// ── parseRobots ─────────────────────────────────────────────────────────────

ok(parseRobots("").blocked.length === 0, "empty robots.txt blocks nothing");
ok(parseRobots(null).blocked.length === 0, "null body is tolerated, not thrown on");

{
  const r = parseRobots(`User-agent: GPTBot\nDisallow: /`);
  ok(r.blocked.includes("gptbot"), "agent names are matched case-insensitively");
}

{
  // A group ends at a BLANK LINE. Without that, one Disallow leaks onto every
  // agent named earlier in the file and the whole verdict is wrong.
  const r = parseRobots(`User-agent: GPTBot\nDisallow: /\n\nUser-agent: Googlebot\nAllow: /`);
  ok(r.blocked.length === 1 && r.blocked[0] === "gptbot",
     "a blank line ends the group — Disallow does not leak to the next agent");
}

{
  const r = parseRobots(`User-agent: GPTBot   # the training crawler\nDisallow: /`);
  ok(r.blocked.includes("gptbot"), "comments are stripped before parsing");
}

{
  // Disallow: /some/path is a PARTIAL restriction, not a refusal of the host.
  const r = parseRobots(`User-agent: ClaudeBot\nDisallow: /private/`);
  ok(r.blocked.length === 0, "a partial Disallow path is not a whole-host refusal");
}

{
  const r = parseRobots(`User-agent: *\nDisallow: /`);
  ok(r.starAll === true && r.blocked.length === 0,
     "User-agent: * Disallow: / sets starAll, and is not counted as a named AI agent");
}

{
  const r = parseRobots(`User-agent: GPTBot\nUser-agent: CCBot\nDisallow: /`);
  ok(r.blocked.length === 2, "one Disallow applies to every agent stacked in the group");
}

// ── verdict: TRAINING refusals are not about us ─────────────────────────────

{
  const v = verdict("example.com", `User-agent: GPTBot\nDisallow: /`);
  ok(v.reserved === false, "blocking a TRAINING crawler does not reserve the host against us");
  ok(v.trainOnly === true, "…and is recorded as train-only");
}

{
  // The documented example from the module header: this host has permitted
  // precisely what we do, and refusing it would decline work it allowed.
  const v = verdict("example.com", `Content-Signal: search=yes, ai-train=no, use=reference`);
  ok(v.reserved === false, "ai-train=no with search=yes is a permission, not a refusal");
  ok(v.trainOnly === true, "…recorded as declining training only");
}

{
  // ClaudeBot is classed as TRAINING deliberately; Anthropic's retrieval agents
  // are Claude-User and Claude-SearchBot. This pins that classification so a
  // well-meaning "fix" fails here rather than in production.
  const v = verdict("example.com", `User-agent: ClaudeBot\nDisallow: /`);
  ok(v.reserved === false, "ClaudeBot is a TRAINING agent — blocking it does not reserve the host");
}

// ── verdict: INFERENCE refusals ARE about us ────────────────────────────────

{
  const v = verdict("example.com", `User-agent: Claude-User\nDisallow: /`);
  ok(v.reserved === true, "blocking an INFERENCE-time agent reserves the host — that is our use");
  ok(v.trainOnly === false, "…and is not downgraded to a train-only note");
}

{
  const v = verdict("example.com", `Content-Signal: ai-input=no`);
  ok(v.reserved === true, "ai-input=no is inference-time use, i.e. us");
}

{
  const v = verdict("example.com", `Content-Signal: search=no`);
  ok(v.reserved === true, "search=no declines indexing at all");
}

{
  const v = verdict("example.com", `User-agent: *\nDisallow: /`);
  ok(v.reserved === true, "a blanket refusal of every crawler includes ours");
}

{
  // CloudflareBrowserRenderingCrawler is the agent this pipeline's crawl step
  // actually presents. A host blocking it is refusing this exact crawler.
  const v = verdict("example.com", `User-agent: CloudflareBrowserRenderingCrawler\nDisallow: /`);
  ok(v.reserved === true, "blocking the crawler we actually use reserves the host");
}

// ── verdict: mixed signals resolve toward the refusal ───────────────────────

{
  // A host that declines training AND inference is reserved, and the training
  // note must not soften that.
  const v = verdict("example.com", `Content-Signal: ai-train=no, ai-input=no`);
  ok(v.reserved === true, "ai-input=no wins over an ai-train=no note");
  ok(v.trainOnly === false, "…and trainOnly is false whenever anything reserves");
}

{
  const v = verdict("example.com", `User-agent: GPTBot\nDisallow: /\n\nUser-agent: Claude-User\nDisallow: /`);
  ok(v.reserved === true, "one inference refusal reserves even alongside a training refusal");
  ok(v.reasons.length === 1, "…and only the inference refusal is given as a reason");
  ok(v.notes.length === 1, "…while the training block is kept as a note");
}

// ── verdict: the empty case ─────────────────────────────────────────────────

{
  // An ABSENT robots.txt is a real answer ("no restriction stated"), and
  // checkAiRights passes "" for a 404. It must not read as a refusal.
  const v = verdict("example.com", "");
  ok(v.reserved === false, "no robots.txt is not a refusal");
  ok(v.trainOnly === false, "no robots.txt is not a train-only note either");
  ok(v.reasons.length === 0 && v.notes.length === 0, "…and states no reasons at all");
}

// ── the reason text is operator-facing; it must name the cause ──────────────

{
  const v = verdict("example.com", `User-agent: Perplexity-User\nDisallow: /`);
  ok(/perplexity-user/.test(v.reasons.join(" ")),
     "the reason names the agent that caused the refusal, not just a count");
}

console.log();
if (fail) { console.log(`❌ ${fail} AI-rights assertion(s) failed`); process.exit(1); }
console.log("✅ AI-rights gate: all assertions passed");
