/**
 * Gate 1 auto-approval — objective criteria only.
 *
 * Enabled 2026-08-06 at Michael's direction, once intake was raised to 50/day
 * and Gate 1 became the thing the loop waited on.
 *
 * WHAT THIS ACTUALLY DECIDES, which is narrower than it sounds. Gate 1 approves
 * a CORPUS PLAN: which of a company's own pages get crawled, and how many. It
 * does not ship anything. The run still stops at Gate 2 with a live demo and an
 * adversarial QA score in front of a human, and at Gate 3 before a word is sent
 * to the prospect — and `LOOP_MAX_LIVE_PARKED` bounds how many live demos can
 * pile up unreviewed. So the blast radius of a wrong yes here is a crawl we
 * should not have run, not a demo somebody receives.
 *
 * That is still a real cost — it is someone's website and our bandwidth — so
 * every criterion below is a MEASURED fact, never a judgement. Nothing here
 * asks whether a prospect is a good idea; a model already proposed it and a
 * human wrote the rubric. These checks ask whether the plan is one we would
 * have approved without thinking about it, and hand over anything else.
 *
 * The bar is deliberately set so that a run needing a *reason* to be approved
 * does not qualify. If you find yourself wanting to add a criterion that
 * encodes a judgement call, that is the signal to leave the case to a person.
 */
import { readFileSync } from "node:fs";
import { parseQueue, type QueuedProspect } from "./intake.js";
import { isSameSite, safeGet } from "./net-guard.js";
import type { Manifest } from "./types.js";

/** Off with `GATE1_AUTO_APPROVE=0`. */
export function autoApproveEnabled(): boolean {
  return (process.env.GATE1_AUTO_APPROVE ?? "1") !== "0";
}

export const MIN_SCORE = Number(process.env.GATE1_AUTO_MIN_SCORE ?? 70);
export const MAX_PAGES = Number(process.env.GATE1_AUTO_MAX_PAGES ?? 400);

/**
 * Tiers a machine may not clear.
 *
 * `clinic-high` means an operating clinic: the corpus is patient-facing
 * material about people's bodies, and what belongs in it is a judgement about
 * medical context rather than a measurement. Acmeemerge is the live example —
 * discovery scored it 74 and it is exactly the kind of prospect that should
 * have a person read the plan.
 */
export const TIERS_NEEDING_A_HUMAN = new Set(["clinic-high"]);

/**
 * Markers an operator uses to say "stop here".
 *
 * The queue's `notes` field is where a human records a doubt — "⚠️ TIER GAP —
 * read before Gate 1" sat on acmeincubator for exactly this reason. Auto-approval must
 * honour that, or the one channel we have for flagging a prospect becomes
 * decorative the day this ships.
 */
export const REVIEW_MARKERS = [/⚠️/u, /read before gate\s*1/i, /tier gap/i, /needs? review/i, /do not auto/i];

export interface AutoVerdict {
  approve: boolean;
  /** Why not, in the order checked. Empty when approved. */
  blockers: string[];
  /** The measured facts that justified a yes. Recorded on the review-board task. */
  evidence: string[];
}

/**
 * Decide from the manifest and the queue entry alone.
 *
 * Pure and synchronous so it is fully testable; the one live check
 * (robots.txt) is separate and layered on top by `autoApproveGate1`.
 */
export function evaluateGate1(
  manifest: Manifest,
  prospect: QueuedProspect | undefined,
): AutoVerdict {
  const blockers: string[] = [];
  const evidence: string[] = [];

  if (!prospect) {
    // A run whose prospect has left the queue cannot be checked against a score
    // or an operator note, so it cannot be checked at all.
    return { approve: false, blockers: ["prospect is no longer in the queue — cannot verify"], evidence };
  }
  if (prospect.hold) blockers.push("prospect is on hold");

  if (typeof prospect.score !== "number") blockers.push("prospect has no score");
  else if (prospect.score < MIN_SCORE) blockers.push(`score ${prospect.score} < ${MIN_SCORE}`);
  else evidence.push(`score ${prospect.score} ≥ ${MIN_SCORE}`);

  if (TIERS_NEEDING_A_HUMAN.has(manifest.complianceTier))
    blockers.push(`complianceTier ${manifest.complianceTier} always needs a human`);
  else evidence.push(`tier ${manifest.complianceTier}`);

  const marker = REVIEW_MARKERS.find((re) => re.test(prospect.notes ?? ""));
  if (marker) blockers.push(`operator note asks for review (matched ${marker})`);

  if (!manifest.complianceNotes?.trim()) blockers.push("manifest has no compliance scope");

  const rag = (manifest.sources ?? []).filter((s) => s.destination === "rag");
  if (!rag.length) blockers.push("manifest plans no rag sources");

  const planned = rag.reduce((n, s) => n + (s.crawl?.limit ?? s.estPages), 0);
  if (planned > MAX_PAGES) blockers.push(`plans ${planned} pages > ${MAX_PAGES}`);
  else if (rag.length) evidence.push(`${planned} planned page(s) ≤ ${MAX_PAGES}`);

  // Defence in depth: intake already refuses off-domain sources, and we send
  // this demo back to the company we crawled, so a competitor's page in their
  // corpus is the worst thing this pipeline could ship. Re-checked here because
  // a machine is doing the approving.
  const offSite = rag.filter((s) => !sameSiteAsProspect(s.url, prospect.url));
  if (offSite.length) blockers.push(`${offSite.length} source(s) are off-domain: ${offSite[0].url}`);
  else if (rag.length) evidence.push(`all ${rag.length} source(s) on ${hostOf(prospect.url)}`);

  return { approve: blockers.length === 0, blockers, evidence };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function sameSiteAsProspect(sourceUrl: string, prospectUrl: string): boolean {
  try {
    return isSameSite(new URL(sourceUrl).host, new URL(prospectUrl).host);
  } catch {
    return false;
  }
}

/**
 * Does robots.txt forbid us outright?
 *
 * Deliberately narrow: this reads only a blanket `Disallow: /` under a `*`
 * user-agent, which is a site saying "no crawlers" in the least ambiguous way
 * available. Per-path rules are the crawler's job to honour, not this gate's —
 * pretending to evaluate them here would be a judgement wearing a measurement's
 * clothes.
 *
 * Unreachable robots.txt is NOT a blocker. Most sites have none, and treating
 * absence as refusal would block nearly everything while looking principled.
 */
export function robotsForbidsEveryone(robotsTxt: string): boolean {
  let inStar = false;
  for (const raw of robotsTxt.split("\n")) {
    const line = raw.split("#")[0].trim();
    const ua = line.match(/^user-agent:\s*(.+)$/i);
    if (ua) {
      inStar = ua[1].trim() === "*";
      continue;
    }
    if (!inStar) continue;
    const dis = line.match(/^disallow:\s*(.*)$/i);
    if (dis && dis[1].trim() === "/") return true;
  }
  return false;
}

/** The full decision, including the one live check. */
export async function autoApproveGate1(
  manifest: Manifest,
  opts: { queuePath: string },
): Promise<AutoVerdict> {
  if (!autoApproveEnabled())
    return { approve: false, blockers: ["auto-approval disabled (GATE1_AUTO_APPROVE=0)"], evidence: [] };

  let prospect: QueuedProspect | undefined;
  try {
    prospect = parseQueue(readFileSync(opts.queuePath, "utf8")).find((p) => p.slug === manifest.prospect);
  } catch (err) {
    return {
      approve: false,
      blockers: [`queue unreadable: ${(err as Error).message.split("\n")[0]}`],
      evidence: [],
    };
  }

  const verdict = evaluateGate1(manifest, prospect);
  if (!verdict.approve || !prospect) return verdict;

  try {
    const { origin, hostname } = new URL(prospect.url);
    // `sameSiteAs` is a HOSTNAME, not a URL. Passing the full URL made every
    // fetch fail the guard — "www.acmesupply.com is not https://www.acmesupply.com" —
    // so the check returned "no robots.txt" for sites it had never reached, and
    // reported that as evidence. A check that reports a clean result it never
    // performed is the exact failure this codebase keeps producing.
    const res = await safeGet(`${origin}/robots.txt`, { sameSiteAs: hostname });
    const robots = res?.body;
    if (robots && robotsForbidsEveryone(robots)) {
      return {
        approve: false,
        blockers: [`${hostOf(prospect.url)}/robots.txt disallows all crawlers`],
        evidence: verdict.evidence,
      };
    }
    verdict.evidence.push(robots ? "robots.txt permits crawling" : "no robots.txt");
  } catch {
    // A fetch failure says nothing about the site's wishes either way, and
    // failing closed here would make every transient network blip look like a
    // refusal. The crawler re-reads robots.txt when it actually runs.
    verdict.evidence.push("robots.txt unreachable (crawler re-checks at crawl time)");
  }
  return verdict;
}
