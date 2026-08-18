/**
 * Stage 0 discovery — keep the intake queue fed without a human writing YAML.
 *
 * intake.ts turns a queued prospect into a corpus manifest; this is the step
 * before it, which decides WHO to queue. Without it the loop consumes a
 * hand-authored list and then idles: on 2026-08-06 the queue held 11 unstarted
 * prospects, about five days of runway at two new runs a day, and nothing in
 * the system was going to notice when that ran out.
 *
 * TWO THINGS THIS DELIBERATELY DOES NOT DO.
 *
 * It does not approve anything. A discovered prospect lands in the queue and
 * still stops at Gate 1 with `approvedBy: null`, exactly like a hand-written
 * one — so nobody's website gets crawled because a language model thought of
 * it. Discovery decides what a human is asked about, not what happens.
 *
 * It does not trust the model's output as fact. A plausible company that does
 * not exist is the characteristic failure here, and it is worse than an empty
 * queue: it looks like research. Every candidate is checked against the live
 * web with the same recon intake uses, and anything that fails — unreachable,
 * a redirect off-site, too thin to build a demo from, already queued — is
 * dropped with a reason rather than queued hopefully.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  FLAGS,
  TIERS,
  hasRun,
  parseQueue,
  reconSite,
  type QueuedProspect,
} from "./intake.js";
import { runClaude } from "./claude-cli.js";
import { isSameSite } from "./net-guard.js";
import type { ComplianceFlag, ComplianceTier } from "./types.js";

/** A candidate as proposed by the model, before any live verification. */
export interface Candidate {
  slug: string;
  name: string;
  url: string;
  complianceTier: ComplianceTier;
  complianceFlags?: ComplianceFlag[];
  complianceNotes: string;
  score: number;
  cluster: string;
  /** Why this company, in the model's words. Operator-facing only. */
  rationale: string;
}

/**
 * Below this many measured pages a site cannot carry a demo.
 *
 * Public-data richness is 30% of the adjacency rubric, and a demo built on a
 * six-page brochure site retrieves nothing and reads as broken. Recon measures
 * this, so it does not have to be guessed.
 */
export const MIN_PAGES_FOR_A_DEMO = Number(process.env.DISCOVER_MIN_PAGES ?? 25);

/** Backlog below which the loop should go looking for more prospects. */
export const DISCOVER_WHEN_BACKLOG_BELOW = Number(process.env.DISCOVER_BACKLOG_FLOOR ?? 8);

/** How many candidates to ask for in one pass. */
export const DISCOVER_BATCH = Number(process.env.DISCOVER_BATCH ?? 8);

/**
 * Queued prospects that have not been started in THIS environment.
 *
 * Environment-scoped for the same reason `hasRun` is: the 17 staging demos
 * would otherwise read as runway that production cannot actually use.
 */
export function unstartedBacklog(
  queue: QueuedProspect[],
  runsDir: string,
  apiUrl?: string,
): QueuedProspect[] {
  return queue.filter((p) => !p.hold && !hasRun(runsDir, p.slug, apiUrl));
}

export function shouldDiscover(backlog: number, floor = DISCOVER_WHEN_BACKLOG_BELOW): boolean {
  return backlog < floor;
}

/**
 * The discovery prompt.
 *
 * The existing queue goes in as NAMES AND HOSTS ONLY. It is tempting to pass
 * the whole file for context, but that file carries operator research — Attio
 * deal status, adjacency reasoning, "no deal record, re-engagement" — and
 * candidates come back out of this prompt into a YAML file we read later. Feed
 * a model our own sales notes and some of them come back as prose.
 */
export function buildDiscoveryPrompt(opts: {
  rubric: string;
  existing: Array<{ name: string; url: string }>;
  workingClusters: string[];
  count: number;
}): string {
  const taken = opts.existing.map((e) => `- ${e.name} (${hostOf(e.url)})`).join("\n");
  return [
    "You are sourcing B2B prospects for a demo-generation pipeline. We build a",
    "retrieval assistant from a company's own published website and send it to",
    "them as a working demo of what we could build.",
    "",
    "A GOOD prospect has:",
    `  - a large public content library (>= ${MIN_PAGES_FOR_A_DEMO} substantive pages: articles,`,
    "    guides, research, product documentation) — this is what the demo is built FROM,",
    "    so a brochure site cannot work no matter how good the fit",
    "  - a reason to want an assistant on that library (they answer the same",
    "    questions repeatedly, or the library is hard to navigate)",
    "  - enough size to buy, and not so much that procurement takes a year",
    "",
    "SCORING RUBRIC (score each candidate 0-100 against it):",
    opts.rubric.trim(),
    "",
    "Clusters that have worked for us so far:",
    opts.workingClusters.map((c) => `  - ${c}`).join("\n"),
    "",
    "ALREADY QUEUED OR BUILT — do not propose these or other properties of the",
    "same organisation:",
    taken || "  (none)",
    "",
    `Propose ${opts.count} NEW candidates. Rules:`,
    "  - Real companies with real websites you are confident exist. If you are",
    "    unsure a site exists, leave it out. Every URL is fetched and checked,",
    "    and an invented one is worse than a short list.",
    "  - `url` must be the canonical public homepage, absolute, https.",
    "  - `slug` lowercase kebab-case, unique, derived from the company name.",
    `  - complianceTier is one of: ${TIERS.join(" | ")}. It selects the assistant's`,
    "    compliance prompt AND the adversarial QA hazard set, so choose it from",
    "    the business's real legal exposure, not from how the site feels.",
    `  - complianceFlags is an optional list from: ${FLAGS.join(" | ")}. Add one only`,
    "    when the tier alone cannot describe the hazard: `sensitive-audience` when",
    "    readers may be acting on the answer about their own body or mind,",
    "    `financial-advice` when analysis could read as a recommendation to trade.",
    "  - complianceNotes is read BY THE ASSISTANT as its scope. Write it to the",
    "    assistant, in plain language, about what it may and may not say. It must",
    "    contain no sales reasoning, no scores, and nothing addressed to us.",
    "  - rationale is for US, not the assistant: why this company, one or two",
    "    sentences, including what their content library actually is.",
    "",
    "Return ONLY a JSON array, no prose, no code fence:",
    '[{"slug":"","name":"","url":"","complianceTier":"","complianceFlags":[],',
    '  "complianceNotes":"","score":0,"cluster":"","rationale":""}]',
  ].join("\n");
}

/**
 * Strip a code fence and isolate the JSON ARRAY.
 *
 * intake's `stripJsonFences` slices between the first `{` and the last `}`,
 * which is right for the manifest (an object) and silently destroys an array —
 * it returns `{…},{…}` with the brackets removed, so every batch failed to
 * parse as "not JSON". Kept local rather than generalising that helper, since
 * changing what manifest generation accepts to fix discovery would be trading
 * a bug here for a risk there.
 */
export function stripJsonArrayFence(out: string): string {
  const fence = out.trim().match(/```(?:json)?\s*\n([\s\S]*?)```/);
  const text = (fence ? fence[1] : out).trim();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Parse and validate the model's proposal.
 *
 * Refuses rather than repairs. A candidate with an unrecognised tier or flag is
 * dropped, not defaulted: both fields drive the compliance prompt and the QA
 * hazard set together, so a quietly-defaulted one produces a demo that scores
 * cleanly against a hazard it was never given rules for.
 */
export function parseCandidates(raw: string): { candidates: Candidate[]; rejected: string[] } {
  const rejected: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonArrayFence(raw));
  } catch (err) {
    throw new Error(`discovery: model did not return JSON — ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) throw new Error("discovery: expected a JSON array of candidates");

  const candidates: Candidate[] = [];
  for (const [i, item] of parsed.entries()) {
    const c = (item ?? {}) as Record<string, unknown>;
    const where = c.slug ? String(c.slug) : `candidate[${i}]`;
    const str = (k: string): string => (typeof c[k] === "string" ? String(c[k]).trim() : "");
    const slug = str("slug");
    const url = str("url");

    if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
      rejected.push(`${where}: slug must be lowercase kebab-case (it becomes a directory name)`);
      continue;
    }
    if (!str("name")) {
      rejected.push(`${where}: name is required`);
      continue;
    }
    if (!/^https:\/\//.test(url)) {
      rejected.push(`${where}: url must be absolute https`);
      continue;
    }
    if (!TIERS.includes(c.complianceTier as ComplianceTier)) {
      rejected.push(`${where}: complianceTier ${JSON.stringify(c.complianceTier)} is not one of ${TIERS.join("|")}`);
      continue;
    }
    let flags: ComplianceFlag[] | undefined;
    if (c.complianceFlags !== undefined && c.complianceFlags !== null) {
      if (!Array.isArray(c.complianceFlags)) {
        rejected.push(`${where}: complianceFlags must be a list`);
        continue;
      }
      const bad = c.complianceFlags.find((f) => !FLAGS.includes(f as ComplianceFlag));
      if (bad !== undefined) {
        rejected.push(`${where}: unknown complianceFlag ${JSON.stringify(bad)}`);
        continue;
      }
      flags = c.complianceFlags.length ? (c.complianceFlags as ComplianceFlag[]) : undefined;
    }
    if (!str("complianceNotes")) {
      rejected.push(`${where}: complianceNotes is required — it is the assistant's scope`);
      continue;
    }
    candidates.push({
      slug,
      name: str("name"),
      url,
      complianceTier: c.complianceTier as ComplianceTier,
      complianceFlags: flags,
      complianceNotes: str("complianceNotes"),
      score: typeof c.score === "number" ? c.score : 0,
      cluster: str("cluster") || "unclustered",
      rationale: str("rationale"),
    });
  }
  return { candidates, rejected };
}

export interface VerifiedCandidate extends Candidate {
  /** Pages recon could actually see. Recorded so the score is auditable. */
  measuredPages: number;
}

/**
 * Check a candidate against the live web.
 *
 * The model's confidence is not evidence. This is the step that separates a
 * real company from a plausible one, so a failure here is a drop, never a
 * warning-and-continue.
 */
export async function verifyCandidate(
  c: Candidate,
  seen: { slugs: Set<string>; hosts: Set<string> },
): Promise<{ ok: true; verified: VerifiedCandidate } | { ok: false; reason: string }> {
  if (seen.slugs.has(c.slug)) return { ok: false, reason: "slug already queued" };
  if (seen.hosts.has(hostOf(c.url))) return { ok: false, reason: `host ${hostOf(c.url)} already queued` };

  let recon: Awaited<ReturnType<typeof reconSite>>;
  try {
    recon = await reconSite(c.url);
  } catch (err) {
    return { ok: false, reason: `recon failed: ${(err as Error).message.split("\n")[0]}` };
  }
  if (!recon.reachable) return { ok: false, reason: "site unreachable" };

  // Pages on another registrable domain mean this is not the company we think
  // it is — an acquisition, a parked name, a rebrand that now serves someone
  // else's sitemap. Building here would put a stranger's content under this
  // candidate's name. Judged on the discovered PAGES rather than a redirect
  // hop, because that is what would actually get crawled.
  const offSite = (recon.sitemapUrls ?? []).filter((u) => !isSameSite(hostOf(u), hostOf(c.url)));
  if (recon.sitemapUrls?.length && offSite.length > recon.sitemapUrls.length / 2)
    return { ok: false, reason: `most discovered pages are on ${hostOf(offSite[0])}, not ${hostOf(c.url)}` };

  const pages = (recon.sitemapUrls ?? []).length - offSite.length;
  if (pages < MIN_PAGES_FOR_A_DEMO)
    return { ok: false, reason: `only ${pages} discoverable page(s) — below the ${MIN_PAGES_FOR_A_DEMO} a demo needs` };

  return { ok: true, verified: { ...c, measuredPages: pages } };
}

/**
 * Render queue entries.
 *
 * `anchorCustomer` is required by the queue parser and every existing entry
 * carries an Attio reference. A discovered prospect has no deal and must not
 * pretend to: the string says plainly where it came from, so nobody reads a
 * cold lead as a live thread. `notes` is operator-facing and never reaches the
 * assistant — see the field split in intake.ts.
 */
export function renderQueueEntries(cands: VerifiedCandidate[], today: string): string {
  const y = (s: string): string => JSON.stringify(s);
  return cands
    .map((c) =>
      [
        `  - slug: ${c.slug}`,
        `    name: ${y(c.name)}`,
        `    url: ${c.url}`,
        `    anchorCustomer: ${y(
          `discovered:${today} — cold prospect proposed by loop discovery. NO Attio record; ` +
            `create one before outreach, and repoint this field at it.`,
        )}`,
        // Stamped explicitly. Discovery output must never be able to outrank a
        // site Michael handed over directly, and an omitted field would leave
        // that to whatever `priority` the model happened to propose.
        `    requestedBy: discovered`,
        `    complianceTier: ${c.complianceTier}`,
        ...(c.complianceFlags?.length ? [`    complianceFlags: [${c.complianceFlags.join(", ")}]`] : []),
        `    complianceNotes: ${y(c.complianceNotes)}`,
        `    score: ${c.score}`,
        `    cluster: ${y(c.cluster)}`,
        `    crawlPages: ${Math.min(400, Math.max(40, c.measuredPages))}`,
        `    notes: ${y(
          `Discovered ${today}. Measured ${c.measuredPages} sitemap page(s) at verification. ${c.rationale}`,
        )}`,
      ].join("\n"),
    )
    .join("\n");
}

/**
 * Append to the queue, then re-parse the WHOLE file with the real parser.
 *
 * Not with a YAML load — with `parseQueue`. A file that is valid YAML and
 * invalid to the parser is exactly the failure this guards: a queue written
 * without the required `anchorCustomer` once passed a `yaml.safe_load` check
 * and then threw on `prospects[0]` in production, taking intake down for every
 * prospect rather than the new one. On any failure the original text is
 * restored, because a half-written queue starves the loop completely.
 */
export function appendProspects(queuePath: string, entries: string): { added: number; total: number } {
  const before = readFileSync(queuePath, "utf8");
  const beforeCount = parseQueue(before).length;
  const next = `${before.replace(/\s*$/, "")}\n${entries}\n`;
  writeFileSync(queuePath, next);
  try {
    const total = parseQueue(readFileSync(queuePath, "utf8")).length;
    return { added: total - beforeCount, total };
  } catch (err) {
    writeFileSync(queuePath, before);
    throw new Error(
      `discovery: appended entries did not parse — queue restored unchanged. ${(err as Error).message}`,
    );
  }
}

/** Full discovery pass. Returns a human-readable summary of what it did. */
export async function discoverProspects(opts: {
  queuePath: string;
  runsDir: string;
  rubricPath: string;
  apiUrl?: string;
  count?: number;
  today: string;
  dryRun?: boolean;
}): Promise<{ added: number; rejected: string[]; considered: number; verified: VerifiedCandidate[] }> {
  const queue = parseQueue(readFileSync(opts.queuePath, "utf8"));
  const rubric = existsSync(opts.rubricPath) ? readFileSync(opts.rubricPath, "utf8") : "";
  const clusters = [...new Set(queue.map((p) => p.cluster).filter((c): c is string => !!c))];

  const prompt = buildDiscoveryPrompt({
    rubric,
    existing: queue.map((p) => ({ name: p.name, url: p.url })),
    workingClusters: clusters,
    count: opts.count ?? DISCOVER_BATCH,
  });

  const raw = await runClaude(prompt, { timeoutMs: 5 * 60 * 1000 });
  const { candidates, rejected } = parseCandidates(raw);

  const seen = {
    slugs: new Set(queue.map((p) => p.slug)),
    hosts: new Set(queue.map((p) => hostOf(p.url))),
  };
  const verified: VerifiedCandidate[] = [];
  for (const c of candidates) {
    const v = await verifyCandidate(c, seen);
    if (!v.ok) {
      rejected.push(`${c.slug} (${hostOf(c.url)}): ${v.reason}`);
      continue;
    }
    verified.push(v.verified);
    // Claim it immediately so two candidates in one batch cannot both take the
    // same host under different slugs.
    seen.slugs.add(c.slug);
    seen.hosts.add(hostOf(c.url));
  }

  // The verified list comes back either way, so a --dry-run rehearsal can show
  // exactly what WOULD be queued. A dry run that only reports counts cannot
  // answer the question anyone actually has, which is "who did it pick?".
  if (!verified.length || opts.dryRun) return { added: 0, rejected, considered: candidates.length, verified };
  const { added } = appendProspects(opts.queuePath, renderQueueEntries(verified, opts.today));
  return { added, rejected, considered: candidates.length, verified };
}
