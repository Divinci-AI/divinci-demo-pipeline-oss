/**
 * The write path: turn scored web candidates into queue entries.
 *
 * Deliberately separate from discover-web.ts, which only ever reads. This is
 * the file that spends money — every entry it appends becomes a crawl,
 * embeddings and a release — so the checks it performs are the last thing
 * between a model's confidence and a real bill.
 *
 * Three properties it exists to hold:
 *
 *   1. The model's score is not evidence that the company exists. Every
 *      candidate is verified against the live web (the same `verifyCandidate`
 *      discovery already uses) and a failure is a DROP with a named reason,
 *      never a warning-and-continue.
 *   2. A partner's corpus is usually its DOCS. partner-scoring.md refuses to
 *      penalise a thin marketing site, so verification must not either: when
 *      the homepage is below the page floor we re-verify the documentation root
 *      and, if that clears, write the docs URL as the crawl target. Writing the
 *      homepage anyway would queue a 12-page brochure for a 400-page crawl.
 *   3. Everything written carries its provenance — `source: web-search`,
 *      `icp: partner` — so `npm run yield` can grade this source later. An
 *      unstamped entry is a prospect whose origin is lost the moment it lands.
 */

import { hostOf, verifyCandidate, type Candidate, type VerifiedCandidate } from "./discover.js";
import { appendProspects } from "./discover.js";
import { FLAGS, TIERS, type QueuedProspect } from "./intake.js";
import { sanitizeField, type WebCandidate } from "./discover-web.js";
import type { ComplianceFlag, ComplianceTier } from "./types.js";

export interface ScoredWebCandidate extends WebCandidate {
  score: number;
  complianceTier: ComplianceTier;
  complianceFlags?: ComplianceFlag[];
  complianceNotes: string;
  cluster: string;
  rationale: string;
}

/** Below this we do not queue: a gate review cannot rescue a bad fit. */
export const MIN_PARTNER_SCORE = Number(process.env.PARTNER_MIN_SCORE ?? 60);

const slugify = (name: string, url: string): string => {
  const fromName = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (/^[a-z0-9][a-z0-9-]*$/.test(fromName)) return fromName;
  return hostOf(url)
    .replace(/^www\./, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
};

/**
 * Merge stage B's scoring onto stage A's candidates, by URL.
 *
 * Joined on URL rather than array position because stage B is asked to return
 * "same order" and a model that drops one row would otherwise shift every
 * subsequent score onto the wrong company — silently, and in a way that looks
 * entirely plausible in the output.
 */
export function mergeScores(
  candidates: WebCandidate[],
  rawScoring: string,
): { scored: ScoredWebCandidate[]; rejected: string[] } {
  const rejected: string[] = [];
  let parsed: unknown;
  const start = rawScoring.indexOf("[");
  const end = rawScoring.lastIndexOf("]");
  try {
    parsed = JSON.parse(start >= 0 && end > start ? rawScoring.slice(start, end + 1) : rawScoring);
  } catch {
    return { scored: [], rejected: ["stage B did not return parseable JSON"] };
  }
  if (!Array.isArray(parsed)) return { scored: [], rejected: ["stage B did not return an array"] };

  const byUrl = new Map(candidates.map((c) => [c.url, c]));
  const scored: ScoredWebCandidate[] = [];
  for (const row of parsed) {
    const o = (row ?? {}) as Record<string, unknown>;
    const url = sanitizeField(o.url, 300);
    const cand = byUrl.get(url);
    if (!cand) {
      rejected.push(`scoring row for ${JSON.stringify(url).slice(0, 60)} matches no candidate`);
      continue;
    }
    // typeof, not Number(): `Number(null)` is 0, which is finite and in range,
    // so a MISSING score would be coerced into a valid one and queued as a
    // legitimate zero. A model that omits the field must be treated as having
    // said nothing, not as having said "worthless".
    const score = o.score;
    if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 100) {
      rejected.push(`dropped ${cand.name}: score ${JSON.stringify(o.score)} is not 0-100`);
      continue;
    }
    const tier = sanitizeField(o.complianceTier, 40);
    if (!(TIERS as readonly string[]).includes(tier)) {
      // Not defaulted. The tier selects the assistant's compliance prompt AND
      // its adversarial QA hazard set, so guessing one is how an assistant
      // ships with the wrong guardrails and a QA suite that never probes them.
      rejected.push(`dropped ${cand.name}: complianceTier ${JSON.stringify(tier)} is not one of ${TIERS.join("|")}`);
      continue;
    }
    const flags = (Array.isArray(o.complianceFlags) ? o.complianceFlags : [])
      .map((f) => sanitizeField(f, 40))
      .filter((f): f is ComplianceFlag => (FLAGS as readonly string[]).includes(f));
    scored.push({
      ...cand,
      score,
      complianceTier: tier as ComplianceTier,
      ...(flags.length ? { complianceFlags: flags } : {}),
      complianceNotes: sanitizeField(o.complianceNotes, 600),
      cluster: sanitizeField(o.cluster, 60) || "partner",
      rationale: sanitizeField(o.rationale, 1200),
    });
  }
  return { scored, rejected };
}

/**
 * Verify against the live web, preferring the docs root when the homepage is
 * too thin to build from.
 */
export async function verifyPartner(
  c: ScoredWebCandidate,
  seen: { slugs: Set<string>; hosts: Set<string> },
): Promise<{ ok: true; verified: VerifiedCandidate; corpusUrl: string } | { ok: false; reason: string }> {
  const slug = slugify(c.name, c.url);
  const base: Candidate = {
    slug,
    name: c.name,
    url: c.url,
    complianceTier: c.complianceTier,
    complianceFlags: c.complianceFlags,
    complianceNotes: c.complianceNotes,
    score: c.score,
    cluster: c.cluster,
    rationale: c.rationale,
  } as Candidate;

  const home = await verifyCandidate(base, seen);
  if (home.ok) return { ok: true, verified: home.verified, corpusUrl: c.url };

  // Only the page floor is worth a second look. An unreachable host, an
  // off-site sitemap or an already-queued slug are not fixed by pointing at a
  // different path on the same company.
  const thin = /discoverable page/.test(home.reason);
  if (!thin || !c.docsUrl) return { ok: false, reason: home.reason };

  const docs = await verifyCandidate({ ...base, url: c.docsUrl }, seen);
  if (!docs.ok) return { ok: false, reason: `${home.reason}; docs ${c.docsUrl}: ${docs.reason}` };
  return { ok: true, verified: docs.verified, corpusUrl: c.docsUrl };
}

/**
 * Render queue entries for verified partners.
 *
 * `url` is the CORPUS — what actually gets crawled — which for a partner is
 * often the docs root rather than the homepage. The homepage is recorded in
 * `notes` so the company is still identifiable by a human reading the queue.
 */
export function renderPartnerEntries(
  rows: Array<{ verified: VerifiedCandidate; corpusUrl: string; homepage: string; evidence: string[] }>,
  today: string,
): string {
  const y = (s: string): string => JSON.stringify(s);
  return rows
    .map(({ verified: c, corpusUrl, homepage, evidence }) =>
      [
        `  - slug: ${c.slug}`,
        `    name: ${y(c.name)}`,
        `    url: ${corpusUrl}`,
        `    anchorCustomer: ${y(
          `web-discovered:${today} — cold CHANNEL-PARTNER candidate from web search. NO Attio ` +
            `record; create one before outreach, and repoint this field at it.`,
        )}`,
        `    requestedBy: discovered`,
        // Provenance, stamped at creation. Without these two the entry is
        // indistinguishable from a model-recall find the moment it lands, and
        // this source can never be graded.
        `    source: web-search`,
        `    icp: partner`,
        `    complianceTier: ${c.complianceTier}`,
        ...(c.complianceFlags?.length ? [`    complianceFlags: [${c.complianceFlags.join(", ")}]`] : []),
        `    complianceNotes: ${y(c.complianceNotes)}`,
        `    score: ${c.score}`,
        `    cluster: ${y(c.cluster)}`,
        `    crawlPages: ${Math.min(400, Math.max(40, c.measuredPages))}`,
        `    notes: ${y(
          `Web-discovered ${today} as a channel partner (partner-scoring.md; score is NOT ` +
            `comparable with customer scores). Homepage ${homepage}. Corpus ${corpusUrl}, ` +
            `${c.measuredPages} page(s) at verification. Evidence: ${evidence.join(" ")}. ${c.rationale}`,
        )}`,
      ].join("\n"),
    )
    .join("\n");
}

export async function writePartners(opts: {
  scored: ScoredWebCandidate[];
  existing: QueuedProspect[];
  queuePath: string;
  today: string;
  minScore?: number;
  dryRun?: boolean;
}): Promise<{ added: number; rejected: string[]; entries: string }> {
  const min = opts.minScore ?? MIN_PARTNER_SCORE;
  const rejected: string[] = [];
  const seen = {
    slugs: new Set(opts.existing.map((p) => p.slug)),
    hosts: new Set(opts.existing.map((p) => hostOf(p.url))),
  };

  const rows: Array<{ verified: VerifiedCandidate; corpusUrl: string; homepage: string; evidence: string[] }> = [];
  for (const c of opts.scored) {
    if (c.score < min) {
      rejected.push(`dropped ${c.name}: score ${c.score} below ${min}`);
      continue;
    }
    const res = await verifyPartner(c, seen);
    if (!res.ok) {
      rejected.push(`dropped ${c.name}: ${res.reason}`);
      continue;
    }
    // Claim the slug/host immediately so two candidates in the same batch
    // cannot both pass and then collide inside the queue parser.
    seen.slugs.add(res.verified.slug);
    seen.hosts.add(hostOf(res.corpusUrl));
    rows.push({ verified: res.verified, corpusUrl: res.corpusUrl, homepage: c.url, evidence: c.evidence });
  }

  const entries = rows.length ? renderPartnerEntries(rows, opts.today) : "";
  if (!rows.length || opts.dryRun) return { added: 0, rejected, entries };
  const { added } = appendProspects(opts.queuePath, entries);
  return { added, rejected, entries };
}
