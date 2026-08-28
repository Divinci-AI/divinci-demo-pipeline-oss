/**
 * Stage 1 intake — prospect queue → an approved-shape corpus manifest.
 *
 * This is the component the loop was missing. `run.ts` starts at Gate 1 and
 * fail()s without a hand-authored `runs/<prospect>/<run>/manifest.json`, and
 * every manifest to date was written by a human. So "around the clock" had
 * nothing to feed it.
 *
 * DESIGN NOTE — the queue is the ONLY input; run state lives on disk.
 * There is deliberately no `status:` field to keep in sync. A prospect is
 * "taken" when `runs/<slug>/` exists, which is the same fact the orchestrator
 * already relies on. A second source of truth would drift the first time a run
 * was started by hand, and the drift would show up as a duplicate crawl of
 * someone's website.
 *
 * What intake does NOT do: approve anything. It writes the manifest with
 * `approvedBy: null`, which is what holds Gate 1 shut. The loop can fill the
 * queue and build the corpus plan; a human still decides what gets ingested.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { safeGet, isSameSite } from "./net-guard.js";
import { runClaude } from "./claude-cli.js";
import { untrustedBlock } from "./prompt-safety.js";
import { validateManifest, isDocumentSource, type Manifest, type ManifestSource, type ComplianceFlag, type ComplianceTier } from "./types.js";
import { isSource, SOURCES, type Source } from "./provenance.js";

const execFileP = promisify(execFile);

/** Which rubric a prospect was scored against — see QueuedProspect.icp. */
export type Icp = "customer" | "partner";

/** Default share of STARTED runs that may be partners. See selectNextProspect. */
export const DEFAULT_PARTNER_SHARE = Number(process.env.PARTNER_INTAKE_SHARE ?? 0.25);

export interface QueuedProspect {
  slug: string;
  name: string;
  url: string;
  anchorCustomer: string;
  /**
   * Who put this prospect in the queue.
   *
   * `direct` — Michael handed over the URL himself. These ALWAYS outrank
   * everything discovery found, and among themselves they run in the order he
   * asked for them: the one requested first goes first. `directSeq` carries
   * that order; it is a request sequence, not a score, and it is never
   * re-numbered when a new one arrives.
   *
   * `discovered` (the default) — sourced by the loop's own discovery pass.
   * These fill the queue behind the direct list, ranked by priority then score.
   *
   * Encoded as a FIELD rather than as a large `priority` number because a
   * number invites a later "just bump it above" that silently reorders the
   * thing Michael actually asked for. A discovered prospect cannot outrank a
   * direct one at any priority.
   */
  requestedBy?: "direct" | "discovered";
  /**
   * WHICH mechanism produced this prospect — see provenance.ts.
   *
   * Separate from `requestedBy`, which is a priority band. Origin drives yield
   * accounting only, so registering a new source can never reorder the queue.
   * Absent on entries written before provenance existed; `sourceOf()` infers
   * those and marks them as inferred rather than guessing silently.
   */
  source?: Source;
  /**
   * Which question this prospect was scored against.
   *
   * `customer` (the default) — would they buy a retrieval assistant for their
   * own content? Weights content richness heavily, because the demo is built
   * FROM their site.
   *
   * `partner` — would they put the assistant in front of THEIR customers?
   * Weights reach and integration surface, and deliberately does not penalise
   * a thin marketing site (see research/partner-scoring.md).
   *
   * ⚠️ `score` IS ONLY COMPARABLE WITHIN AN ICP. A partner on 92 and a customer
   * on 85 are not ranked; they are measuring different quantities on a shared
   * 0-100 scale. compareProspects therefore never puts them in competition —
   * partner intake is bounded by a SHARE of capacity instead. If you find
   * yourself sorting the two together, that is the bug.
   */
  icp?: Icp;
  /** Position within the direct list — lower runs first. Assign monotonically. */
  directSeq?: number;
  complianceTier: ComplianceTier;
  /**
   * Additive hazard layers, orthogonal to the tier — e.g. a commerce-medium
   * catalogue whose readers are self-treating chronic conditions carries
   * `[sensitive-audience]`. Each flag adds BOTH compliance-prompt rules and QA
   * hazards; adding one without the other is how a hazard ends up scored but
   * undefended.
   */
  complianceFlags?: ComplianceFlag[];
  /**
   * MODEL-FACING scope, written onto the manifest and read by the assistant as
   * "Compliance scope for this assistant: …".
   *
   * Deliberately separate from `notes`, which is operator-facing research and
   * used to be sent to the model verbatim. That put internal scoring, Attio
   * deal status, crawl-budget reasoning and instructions addressed to a human
   * ("read before Gate 1", "repoint it when a real deal exists") into the
   * system prompt of an assistant we hand to the prospect — recoverable by
   * anyone who talks it into repeating its instructions.
   */
  complianceNotes?: string;
  /** Adjacency score — how close this prospect is to an existing customer.
   *  Higher goes first within the discovered band. */
  score?: number;
  /**
   * Explicit ordering override, ahead of score. Default 0.
   *
   * Exists because "do this one next" is a real and frequent instruction that
   * score cannot express: a prospect can be genuinely mid-ranked and still be
   * the one someone needs on Tuesday. The alternative in use before this was
   * to `hold` everything that outranked it, which parks prospects for a reason
   * that has nothing to do with their merit and is easy to forget to undo.
   */
  priority?: number;
  cluster?: string;
  notes?: string;
  /** Set true to hold a prospect in the queue without taking it. */
  hold?: boolean;
  /** Page budget override for this prospect. */
  crawlPages?: number;
}

export const TIERS: ComplianceTier[] = [
  "wellness-low",
  "commerce-medium",
  "clinic-high",
  "sensitive-audience",
];

/**
 * Additive hazard layers. Validated as strictly as the tier: a misspelled flag
 * would parse fine and then match nothing in either the prompt rules or the QA
 * hazards, so the run would report a clean score for a hazard that was never
 * defended and never tested. Silence is the failure mode to avoid here.
 */
export const FLAGS: ComplianceFlag[] = [
  "sensitive-audience",
  "financial-advice",
  "legal-advice",
  "public-service",
];

/** Parse + validate the queue file, refusing anything the pipeline cannot run. */
export function parseQueue(text: string): QueuedProspect[] {
  const doc = parseYaml(text) as { prospects?: unknown };
  if (!doc || !Array.isArray(doc.prospects))
    throw new Error("queue file must have a top-level `prospects:` list");

  return doc.prospects.map((raw, i) => {
    const p = (raw ?? {}) as Record<string, unknown>;
    const where = `prospects[${i}]${p.slug ? ` (${String(p.slug)})` : ""}`;
    for (const field of ["slug", "name", "url", "anchorCustomer"] as const) {
      if (typeof p[field] !== "string" || !String(p[field]).trim())
        throw new Error(`${where}: ${field} is required`);
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(String(p.slug)))
      throw new Error(`${where}: slug must be lowercase kebab-case (it becomes a directory name)`);
    if (!/^https?:\/\//.test(String(p.url))) throw new Error(`${where}: url must be absolute`);
    if (!TIERS.includes(p.complianceTier as ComplianceTier))
      throw new Error(
        `${where}: complianceTier must be one of ${TIERS.join("|")} — it selects the QA hazard set ` +
          `and the assistant's compliance prompt, so there is no safe default`,
      );
    let complianceFlags: ComplianceFlag[] | undefined;
    if (p.complianceFlags !== undefined) {
      if (!Array.isArray(p.complianceFlags))
        throw new Error(`${where}: complianceFlags must be a list, e.g. [sensitive-audience]`);
      for (const f of p.complianceFlags) {
        if (!FLAGS.includes(f as ComplianceFlag))
          throw new Error(
            `${where}: unknown complianceFlag ${JSON.stringify(f)} — must be one of ${FLAGS.join("|")}. ` +
              `A flag adds BOTH prompt rules and QA hazards, so an unrecognized one silently adds neither`,
          );
      }
      complianceFlags = p.complianceFlags as ComplianceFlag[];
    }
    if (p.requestedBy !== undefined && p.requestedBy !== "direct" && p.requestedBy !== "discovered")
      throw new Error(
        `${where}: requestedBy must be "direct" or "discovered" — a typo would silently demote a ` +
          `prospect Michael asked for into the discovered band`,
      );
    if (p.icp !== undefined && p.icp !== "customer" && p.icp !== "partner")
      throw new Error(
        `${where}: icp must be "customer" or "partner" — it selects which rubric the score came ` +
          `from, and an unrecognized value would let a partner score be ranked against a customer one`,
      );
    if (p.source !== undefined && !isSource(p.source))
      throw new Error(
        `${where}: unknown source ${JSON.stringify(p.source)} — must be one of ${SOURCES.join("|")}. ` +
          `Free text was rejected deliberately: a typo silently creates a second bucket and splits ` +
          `one source's yield in half, so it reads as two mediocre sources instead of one good one. ` +
          `Register a real new source in provenance.ts.`,
      );
    if (p.requestedBy === "direct" && typeof p.directSeq !== "number")
      throw new Error(
        `${where}: a direct prospect needs directSeq (the order it was asked for). ` +
          `Without it the direct list has no defined order and new entries jump ahead of older ones`,
      );
    return {
      slug: String(p.slug),
      name: String(p.name),
      url: String(p.url),
      anchorCustomer: String(p.anchorCustomer),
      ...(isSource(p.source) ? { source: p.source } : {}),
      ...(p.icp === "customer" || p.icp === "partner" ? { icp: p.icp as Icp } : {}),
      requestedBy: p.requestedBy as "direct" | "discovered" | undefined,
      directSeq: typeof p.directSeq === "number" ? p.directSeq : undefined,
      complianceTier: p.complianceTier as ComplianceTier,
      complianceFlags,
      complianceNotes:
        typeof p.complianceNotes === "string" ? p.complianceNotes.trim() : undefined,
      score: typeof p.score === "number" ? p.score : undefined,
      cluster: typeof p.cluster === "string" ? p.cluster : undefined,
      notes: typeof p.notes === "string" ? p.notes : undefined,
      hold: p.hold === true,
      priority: typeof p.priority === "number" ? p.priority : undefined,
      crawlPages: typeof p.crawlPages === "number" ? p.crawlPages : undefined,
    };
  });
}

/**
 * Does this prospect already have a run **in this environment**?
 *
 * Runs are pinned to the environment they were built against, and a demo built
 * on staging is not a demo you can send from production — it lives in a
 * different account, behind a different release, with its own workspace. So
 * "already taken" has to be environment-scoped, or the 17 staging demos would
 * block their own production rebuild forever and a rebuild would need a special
 * flag that then has to be remembered and cleared.
 *
 * A run whose manifest exists but which has no state.json yet is counted as
 * taken in EVERY environment: it was just intaken and has not been advanced
 * (which is what stamps apiUrl), so treating it as free would let the next tick
 * intake the same prospect twice and crawl a real company's site twice.
 */
export function hasRun(runsDir: string, slug: string, apiUrl?: string): boolean {
  const dir = join(runsDir, slug);
  if (!existsSync(dir)) return false;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  return entries.some((entry) => {
    if (!existsSync(join(dir, entry, "manifest.json"))) return false;
    if (!apiUrl) return true; // no environment named — any run counts

    const statePath = join(dir, entry, "state.json");
    if (!existsSync(statePath)) return true; // fresh intake, not yet stamped
    try {
      const state = JSON.parse(readFileSync(statePath, "utf8")) as { apiUrl?: string };
      // An un-stamped legacy run predates apiUrl; treat it as belonging to
      // whatever environment is asking, rather than silently rebuilding it.
      return state.apiUrl === undefined || state.apiUrl === apiUrl;
    } catch {
      return true; // unreadable state — do not rebuild over something unknown
    }
  });
}

/**
 * The next prospect to build: highest score first, skipping held prospects and
 * anything that already has a run. Ties break on queue order so the file stays
 * the tiebreaker a human can control.
 */
export function selectNextProspect(
  queue: QueuedProspect[],
  runsDir: string,
  apiUrl?: string,
  opts: { partnerShare?: number } = {},
): QueuedProspect | undefined {
  const eligible = queue
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => !p.hold && !hasRun(runsDir, p.slug, apiUrl));

  // Partner intake is capped by SHARE, not by score.
  //
  // A partner's score comes from a different rubric measuring a different
  // quantity, so ranking a 92-partner against an 85-customer is comparing
  // reach to content richness on a shared scale that means nothing. Sorting
  // them together would let one good partner pass every customer in the
  // queue — not because it is more valuable, but because its rubric happens to
  // produce bigger numbers.
  //
  // A share also keeps the partner ICP an experiment with a bounded cost while
  // it has no yield history, which is the honest state of it today. Raise
  // PARTNER_INTAKE_SHARE once `npm run yield` says something.
  const share = opts.partnerShare ?? DEFAULT_PARTNER_SHARE;
  const started = queue.filter((p) => hasRun(runsDir, p.slug, apiUrl));
  const startedPartners = started.filter((p) => p.icp === "partner").length;
  // `+ 1` asks about the run we are ABOUT to start, so the very first pick can
  // be a partner rather than requiring a customer to go first forever.
  const partnersAllowed = started.length === 0 ? share > 0 : (startedPartners + 1) / (started.length + 1) <= share;

  const pool = partnersAllowed ? eligible : eligible.filter(({ p }) => p.icp !== "partner");
  return (pool.length ? pool : eligible.filter(({ p }) => p.icp !== "partner"))
    .sort((a, b) => compareProspects(a.p, b.p) || a.i - b.i)
    .map(({ p }) => p)[0];
}

/**
 * Queue order. Negative means `a` runs first.
 *
 * Two bands, and the band boundary is absolute: everything Michael handed over
 * directly runs before anything discovery found, whatever their priorities or
 * scores say. Within the direct band, request order wins — the site he asked
 * for first is built first. Within the discovered band, priority then score.
 */
export function compareProspects(a: QueuedProspect, b: QueuedProspect): number {
  const band = (p: QueuedProspect) => (p.requestedBy === "direct" ? 0 : 1);
  if (band(a) !== band(b)) return band(a) - band(b);
  if (band(a) === 0) {
    // Unsequenced direct entries sort after sequenced ones rather than jumping
    // to the front on a missing field.
    return (a.directSeq ?? Number.MAX_SAFE_INTEGER) - (b.directSeq ?? Number.MAX_SAFE_INTEGER);
  }
  return (b.priority ?? 0) - (a.priority ?? 0) || (b.score ?? 0) - (a.score ?? 0);
}

// ---------------------------------------------------------------- recon

export interface SiteRecon {
  url: string;
  reachable: boolean;
  /** Page URLs discovered, from the sitemap or (failing that) a shallow crawl. */
  sitemapUrls: string[];
  /** Distinct path prefixes, most populous first — the shape of the site. */
  topPaths: Array<{ prefix: string; count: number }>;
  /** Heuristic: the homepage renders little without JS. */
  likelySpa: boolean;
  /** How the page list was obtained. "none" means the manifest is being planned blind. */
  discovery: "sitemap" | "shallow-crawl" | "none";
  /** Linked PDFs/Office docs on the site's own domain. */
  documents: string[];
  /** Linked audio/video files on the site's own domain. */
  mediaFiles: string[];
  /** YouTube/Vimeo/Wistia embeds found on the site's pages. */
  embeds: string[];
  note?: string;
}

/**
 * Media classification, mirroring the server's onboarding recon
 * (server-resources/.../onboarding/media.ts) so the demo pipeline buckets a
 * site the same way the platform's agentic recon does: html / document /
 * audio-video. Without this the manifest only ever proposes a text crawl, and
 * a media-heavy site (acmefg.com carries 28 video references and zero PDFs)
 * yields a demo that has never seen most of its own content.
 */
export const DOCUMENT_EXTENSIONS = [".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx"];
export const AV_EXTENSIONS = [".mp3", ".m4a", ".wav", ".ogg", ".flac", ".mp4", ".mov", ".webm"];

export type MediaKind = "document" | "audio-video" | null;

export function classifyMediaLink(raw: string): MediaKind {
  let ext: string;
  try {
    const pathname = new URL(raw).pathname.toLowerCase();
    const dot = pathname.lastIndexOf(".");
    ext = dot === -1 ? "" : pathname.slice(dot);
  } catch {
    return null;
  }
  if (DOCUMENT_EXTENSIONS.includes(ext)) return "document";
  if (AV_EXTENSIONS.includes(ext)) return "audio-video";
  return null;
}

const EMBED_HOSTS = /(?:youtube\.com\/(?:watch|embed)|youtu\.be\/|player\.vimeo\.com|vimeo\.com\/\d|fast\.wistia)/i;

/** Extract hrefs/srcs from HTML, resolved against the page URL. */
export function extractLinks(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/gi)) {
    try {
      const u = new URL(decodeXmlEntities(m[1]), baseUrl);
      u.hash = "";
      if (u.protocol === "http:" || u.protocol === "https:") out.push(u.toString());
    } catch {
      /* not a usable URL */
    }
  }
  return [...new Set(out)];
}

/** Platform-embed URLs. Deliberately NOT same-domain filtered: the trust
 *  boundary is "embedded ON the customer's own page", and an embed is on the
 *  platform's domain by nature. */
export function extractEmbeds(html: string, baseUrl: string): string[] {
  return extractLinks(html, baseUrl).filter((u) => EMBED_HOSTS.test(u));
}

const UA = "DivinciDemoPipeline/1.0 (+https://divinci.ai; demo recon)";

/**
 * All recon fetches go through safeGet, which validates every redirect hop.
 *
 * `sameSiteAs` is not optional politeness: robots.txt's `Sitemap:` directive
 * and nested sitemap <loc> entries are supplied by the site being crawled, so
 * without it a third party chooses what this machine sends GETs to — including
 * localhost:7777 (review board) and 169.254.169.254 (cloud metadata). See
 * net-guard.ts for the full threat model and the residual risk.
 */
async function get(url: string, sameSiteAs: string, timeoutMs = 20_000): Promise<string | undefined> {
  const res = await safeGet(url, { sameSiteAs, timeoutMs, userAgent: UA });
  return res?.body;
}

/** Decode the XML entities a <loc> body is escaped with. */
export function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    // &amp; LAST, or "&amp;lt;" would decode twice.
    .replace(/&amp;/g, "&");
}

export function extractSitemapUrls(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => decodeXmlEntities(m[1]));
}

/**
 * Is this <loc> another sitemap rather than a page?
 *
 * Tests the PATHNAME, not the whole URL. Shopify sitemap indexes look like
 * `sitemap_products_1.xml?from=123&to=456`, so a `/\.xml$/` test against the
 * full string fails and the index is mistaken for a content page — its contents
 * are then never followed. newagedrinks.com reported 45 pages that way; the real
 * inventory is behind exactly those nested sitemaps, so the demo would have been
 * built from a fraction of the site.
 */
export function isSitemapUrl(url: string): boolean {
  try {
    return /\.xml(\.gz)?$/i.test(new URL(url).pathname);
  } catch {
    return /\.xml(\.gz)?($|\?)/i.test(url);
  }
}

/** Group URLs by their first path segment, most populous first. */
export function summarizePaths(urls: string[], limit = 12): Array<{ prefix: string; count: number }> {
  const counts = new Map<string, number>();
  for (const u of urls) {
    let prefix = "/";
    try {
      const seg = new URL(u).pathname.split("/").filter(Boolean)[0];
      prefix = seg ? `/${seg}/` : "/";
    } catch {
      continue;
    }
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([prefix, count]) => ({ prefix, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

/**
 * Heuristic SPA detection: a page whose body carries almost no text but plenty
 * of script tags will crawl as empty with the default fetch-scraper, which is
 * the difference between a real corpus and 40 blank pages.
 */
/**
 * Is the SITE JS-rendered — judged from a CONTENT page, not just the homepage?
 *
 * `likelySpa` tells the manifest author to put
 * `"scraper": "@cloudflare/browser-rendering"` on EVERY source, which is
 * slower and, in practice, flakier ("Crawl service temporarily unavailable"
 * during the Acme Renew rescrape). Deciding that from the homepage alone gets it
 * wrong in both directions, and the false POSITIVE is the common one: a
 * marketing landing page is exactly where a site puts its animation, hero
 * canvas or terminal effect, while its actual content renders server-side.
 *
 * acmecyber.com is the case in point — an animated terminal homepage
 * with 98 static words, and CMMC pages carrying 763-1142.
 *
 * So: sample a content page too, and only call the SITE an SPA when BOTH look
 * thin. If no content page can be sampled, fall back to the homepage verdict
 * rather than guessing the cheaper answer — a wrongly-plain crawl of a real
 * SPA returns empty pages, which is the worse failure.
 */
export async function likelySpaFromSample(
  home: string,
  sitemapUrls: string[],
  fetchPage: (url: string) => Promise<string | undefined>,
): Promise<boolean> {
  if (!looksLikeSpa(home)) return false;
  const candidate = pickContentSample(sitemapUrls);
  if (!candidate) return true;
  const page = await fetchPage(candidate).catch(() => undefined);
  if (page === undefined) return true;
  return looksLikeSpa(page);
}

/** Boilerplate pages are thin on every site, so they cannot answer the question. */
const NON_CONTENT = /\/(privacy|terms|legal|cookies?|sitemap|contact|search|login|sign-?in|sign-?up|cart|checkout|404)(\/|$|\.)/i;

export function pickContentSample(sitemapUrls: string[]): string | undefined {
  for (const u of sitemapUrls) {
    let path: string;
    try {
      path = new URL(u).pathname;
    } catch {
      continue;
    }
    if (path === "/" || path === "") continue;   // the homepage is the thing we are checking against
    if (NON_CONTENT.test(path)) continue;
    return u;
  }
  return undefined;
}

export function looksLikeSpa(html: string): boolean {
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    // <style> MUST be stripped too. Without it the CSS is counted as prose, and
    // inlined critical CSS is standard practice in every modern framework — so
    // the check reads "content-rich" precisely on the pages it exists to catch.
    // Measured on plugandplaytechcenter.com 2026-08-08: 22,514 of its 24,622
    // bytes sit inside three <style> blocks. The heuristic scored it 664 words
    // and returned false; the page has THREE real words. Its five sources were
    // planned as plain fetch crawls and every one came back empty.
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  const words = body.split(/\s+/).filter((w) => w.length > 2).length;
  const scripts = (html.match(/<script/gi) ?? []).length;
  // `scripts >= 1`, not 3: a bundled SPA commonly ships ONE module script, so
  // the old threshold missed the tidiest builds. The asymmetry justifies it —
  // a false positive costs a slower browser-rendered crawl, a false negative
  // costs the entire corpus and is only discovered after a 30-minute timeout.
  return words < 200 && scripts >= 1;
}

/**
 * Pages fetched purely to find linked documents when a sitemap already told us
 * the page list. Twelve is enough to reach a /resources or /downloads index
 * and its first page of children; recon must stay a survey.
 */
const DOC_SWEEP_MAX_FETCHES = 12;

/**
 * Ceiling on document sources in one manifest.
 *
 * Documents are ingested one upload at a time and each is a whole file rather
 * than a page, so an unbounded list is the one way this lane could quietly
 * outspend the crawl it sits beside. Twenty-five covers every site measured so
 * far (the largest, bermanmedicallasers.com, publishes nine).
 */
export const MAX_DOCUMENT_SOURCES = 25;

/** Paths that tend to hold a company's PDFs, swept first. */
const DOC_SURFACE_PATH_RE =
  /\/(resource|resources|download|downloads|ebook|ebooks|guide|guides|library|whitepaper|white-paper|paper|papers|brochure|brochures|catalog|catalogue|publication|publications|report|reports|flipbook|flipbooks|literature|documentation|docs|media|press|manual|manuals|datasheet|spec|specs)(\/|$)/i;

/** Fast, content-free survey of a prospect's site. Never throws. */
export async function reconSite(url: string): Promise<SiteRecon> {
  const origin = (() => {
    try {
      return new URL(url).origin;
    } catch {
      return url.replace(/\/+$/, "");
    }
  })();

  const site = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  })();

  const home = await get(url, site);
  if (home === undefined)
    return {
      url,
      reachable: false,
      sitemapUrls: [],
      topPaths: [],
      likelySpa: false,
      discovery: "none",
      documents: [],
      mediaFiles: [],
      embeds: [],
      note: "homepage did not respond — the site may be bot-protected; a crawl will likely need @cloudflare/browser-rendering",
    };

  // robots.txt often names sitemaps that are not at the conventional path.
  const robots = (await get(`${origin}/robots.txt`, site)) ?? "";
  const declared = [...robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]);
  const candidates = [...new Set([...declared, `${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`])];

  const seen = new Set<string>();
  for (const candidate of candidates.slice(0, 4)) {
    const xml = await get(candidate, site);
    if (!xml) continue;
    const locs = extractSitemapUrls(xml);
    // A sitemap index points at more sitemaps; follow a bounded number.
    const nested = locs.filter(isSitemapUrl);
    const pages = locs.filter((l) => !isSitemapUrl(l));
    pages.forEach((p) => seen.add(p));
    for (const child of nested.slice(0, 8)) {
      const childXml = await get(child, site);
      if (childXml) extractSitemapUrls(childXml).forEach((p) => seen.add(p));
    }
    if (seen.size > 0) break;
  }

  let sitemapUrls = [...seen];
  let discovery: SiteRecon["discovery"] = sitemapUrls.length > 0 ? "sitemap" : "none";
  const documents = new Set<string>();
  const mediaFiles = new Set<string>();
  const embeds = new Set<string>();

  // Media + link harvest from the homepage, always.
  const harvest = (html: string, pageUrl: string) => {
    for (const link of extractLinks(html, pageUrl)) {
      let sameSite = false;
      try {
        sameSite = isSameSite(new URL(link).hostname, site);
      } catch {
        continue;
      }
      // Media is same-domain only: a blog linking cnn.com/report.pdf must not
      // pull third-party content into the prospect's knowledge base.
      if (!sameSite) continue;
      const kind = classifyMediaLink(link);
      if (kind === "document") documents.add(link);
      else if (kind === "audio-video") mediaFiles.add(link);
    }
    for (const e of extractEmbeds(html, pageUrl)) embeds.add(e);
  };
  harvest(home, url);

  /**
   * SHALLOW CRAWL FALLBACK.
   *
   * Without this, a site with no sitemap reports ZERO pages and the manifest is
   * generated blind — the generator gets an empty survey and guesses. Both of
   * 2026-08-05's targets are in exactly that state (acmemarket.co and acmefg.com
   * publish no sitemap), and acmemarket's original 35-page corpus was planned
   * that way. Mirrors the server's onboarding recon caps (depth 2, ~30 fetches)
   * rather than inventing new ones.
   */
  if (sitemapUrls.length === 0) {
    const SHALLOW_DEPTH = 2;
    const MAX_FETCHES = 30;
    const pages = new Set<string>([url]);
    let frontier = [url];
    let fetches = 0;

    for (let depth = 0; depth < SHALLOW_DEPTH && fetches < MAX_FETCHES; depth++) {
      const next: string[] = [];
      for (const pageUrl of frontier) {
        if (fetches >= MAX_FETCHES) break;
        const html = pageUrl === url ? home : await get(pageUrl, site);
        if (pageUrl !== url) fetches++;
        if (!html) continue;
        harvest(html, pageUrl);
        for (const link of extractLinks(html, pageUrl)) {
          let u: URL;
          try {
            u = new URL(link);
          } catch {
            continue;
          }
          if (!isSameSite(u.hostname, site)) continue;
          if (classifyMediaLink(link)) continue; // media, not a page
          // Skip build assets: a Next.js homepage is mostly /_next/static/*.
          if (/\.(js|css|woff2?|png|jpe?g|gif|svg|ico|webp|avif|map)$/i.test(u.pathname)) continue;
          const clean = `${u.origin}${u.pathname}`;
          if (!pages.has(clean)) {
            pages.add(clean);
            next.push(clean);
          }
        }
      }
      frontier = next.slice(0, MAX_FETCHES - fetches);
    }
    sitemapUrls = [...pages];
    discovery = sitemapUrls.length > 1 ? "shallow-crawl" : "none";
  } else {
    /**
     * DOCUMENT SURFACE SWEEP (sitemap mode).
     *
     * `harvest` above runs on the HOMEPAGE ONLY, so a site whose PDFs live
     * behind /resources/ reports zero documents and the manifest is authored
     * as though the company published nothing but web pages.
     *
     * Live case, 2026-08-24: this recon found 2 linked PDFs on
     * bermanmedicallasers.com (both homepage-linked). The server's own
     * onboarding recon, which fetches beyond the homepage, found NINE — the
     * eBooks and flipbooks that are the best material the company publishes.
     * The demo shipped without them and the run reported success.
     *
     * Bounded, resource-shaped paths first: this is a survey, not the crawl.
     */
    const seenPage = new Set([url]);
    const candidates = [
      ...sitemapUrls.filter((u) => DOC_SURFACE_PATH_RE.test(u)),
      ...sitemapUrls.filter((u) => !DOC_SURFACE_PATH_RE.test(u)),
    ].filter((u) => !seenPage.has(u) && (seenPage.add(u), true));

    for (const pageUrl of candidates.slice(0, DOC_SWEEP_MAX_FETCHES)) {
      const html = await get(pageUrl, site);
      if (html) harvest(html, pageUrl);
    }
  }

  const notes: string[] = [];
  if (discovery === "shallow-crawl")
    notes.push(`no sitemap — ${sitemapUrls.length} page(s) found by a shallow crawl (depth 2); the real site is likely larger`);
  if (discovery === "none") notes.push("no sitemap and no links followed — the crawl must discover pages itself");
  if (documents.size) notes.push(`${documents.size} linked document(s) (PDF/Office)`);
  if (mediaFiles.size) notes.push(`${mediaFiles.size} linked audio/video file(s)`);
  if (embeds.size) notes.push(`${embeds.size} platform embed(s) (YouTube/Vimeo/Wistia)`);

  return {
    url,
    reachable: true,
    sitemapUrls,
    topPaths: summarizePaths(sitemapUrls),
    likelySpa: await likelySpaFromSample(home, sitemapUrls, (u) => get(u, site)),
    discovery,
    documents: [...documents],
    mediaFiles: [...mediaFiles],
    embeds: [...embeds],
    note: notes.length ? notes.join("; ") : undefined,
  };
}

// ---------------------------------------------------------------- manifest

export interface ManifestGenInput {
  prospect: QueuedProspect;
  recon: SiteRecon;
  runId: string;
  defaultCrawlPages?: number;
}

export function buildManifestPrompt(input: ManifestGenInput): string {
  const { prospect, recon } = input;
  const budget = prospect.crawlPages ?? input.defaultCrawlPages ?? 300;

  return [
    "Author a corpus manifest for a demo AI assistant built from ONE company's",
    "public website. Output ONLY JSON — no prose, no markdown fences.",
    "",
    "SHAPE:",
    "{",
    '  "sources": [ { "id": "kebab-id", "url": "https://…", "tier": "T1",',
    '      "type": "website|docs-site|blog|catalog|press", "destination": "rag",',
    '      "rationale": "why this belongs in the corpus",',
    '      "license": "public web, robots-allowed", "estPages": 120,',
    '      "crawl": { "multi": true, "sitemap": true, "limit": 120 } },',
    '    { "id": "kebab-id", "url": "https://…/guide.pdf", "tier": "T1",',
    '      "type": "document", "destination": "rag",',
    '      "rationale": "why this document belongs in the corpus",',
    '      "license": "public web, robots-allowed", "estPages": 1 } ],',
    '  "evalQueries": ["…"],',
    '  "chat": { "starters": ["…","…","…"], "welcomeMessage": "…",',
    '            "threadPrefix": ["…"], "msgPrefix": "…" }',
    "}",
    "",
    "RULES:",
    `- Every source MUST be on the prospect's own domain. Never include a`,
    "  competitor's site, a third-party directory, or social media.",
    '- tier is "T1" for the company\'s own public pages. Never emit "T3".',
    '- destination is "rag" for everything you propose.',
    `- The SUM of crawl.limit across sources must not exceed ${budget}.`,
    "- Prefer 2-5 sources that carve the site into meaningful sections (using the",
    "  path shapes below) over one undifferentiated whole-site crawl.",
    '- A "document" source is ONE file (PDF/Office), url = the file itself, and',
    "  carries NO crawl block. Crawling cannot reach these: a text crawl walks",
    "  HTML links and never opens the PDF behind one.",
    `- Propose a document source for each listed document worth answering from,`,
    `  up to ${MAX_DOCUMENT_SOURCES}. Skip the ones that are not knowledge — order forms, blank`,
    "  templates, price lists that duplicate a page you already crawl.",
    recon.likelySpa
      ? '- The homepage appears to be JS-rendered: set "scraper": "@cloudflare/browser-rendering" on each source.'
      : "- The site renders server-side; leave the scraper unset (the default is faster).",
    ...(recon.discovery === "shallow-crawl"
      ? [
          "- The page list below came from a SHALLOW crawl, not a sitemap, so it",
          "  UNDERSTATES the site. Size crawl.limit for the site you infer, not for",
          "  the number of sample URLs shown.",
        ]
      : []),
    ...(recon.documents.length || recon.mediaFiles.length || recon.embeds.length
      ? [
          "- This site carries NON-TEXT content (counts above). Text-only crawls of",
          "  media-heavy sites produce demos that have never seen most of the",
          "  company's own material. Note the media in each source's rationale so",
          "  the Gate 1 reviewer can decide whether to add a media ingest lane.",
        ]
      : []),
    "- evalQueries: 6-10 questions a real visitor would ask, answerable from",
    "  this corpus. These are diagnostic retrieval probes.",
    "- chat.starters: EXACTLY 3, in the visitor's voice, short enough to fit a",
    "  button. These are not the eval queries — a starter is the first sentence a",
    "  prospect reads, an eval query is a probe tuned to stress retrieval.",
    "- chat.welcomeMessage: one or two sentences, in the company's voice, that",
    "  does not promise advice the compliance tier forbids.",
    "- Invent nothing. Every claim must be supported by the site survey below.",
    "",
    `COMPANY: ${prospect.name}`,
    `SITE: ${prospect.url}`,
    `COMPLIANCE TIER: ${prospect.complianceTier}`,
    ...(prospect.notes ? [`RESEARCH NOTE: ${prospect.notes}`] : []),
    "",
    "SITE SURVEY:",
    `- reachable: ${recon.reachable}`,
    `- pages discovered: ${recon.sitemapUrls.length} (via ${recon.discovery})`,
    `- JS-rendered: ${recon.likelySpa}`,
    `- linked documents (PDF/Office): ${recon.documents.length}`,
    /**
     * The URLs, not just the tally. Until 2026-08-27 this prompt showed the
     * COUNT and nothing else, so the only honest thing the model could do with
     * "linked documents: 2" was mention it in a rationale — there was no way to
     * author a source for a file whose address it had never been told. Every
     * PDF on every prospect site was invisible to this pipeline by
     * construction.
     */
    ...(recon.documents.length
      ? [
        "- document URLs (author \"document\" sources from these):",
        ...recon.documents.slice(0, MAX_DOCUMENT_SOURCES).map((u) => `    ${u}`),
      ]
      : []),
    `- linked audio/video files: ${recon.mediaFiles.length}`,
    `- platform embeds (YouTube/Vimeo): ${recon.embeds.length}`,
    ...(recon.note ? [`- note: ${recon.note}`] : []),
    untrustedBlock(
      "path shapes and sample URLs taken from the prospect's own sitemap",
      [
        "busiest path prefixes:",
        ...recon.topPaths.map((p) => `    ${p.prefix} — ${p.count} pages`),
        "sample URLs:",
        ...recon.sitemapUrls.slice(0, 40).map((u) => `    ${u}`),
      ].join("\n"),
    ),
  ].join("\n");
}

/** Strip fences the model may add despite instructions. */
export function stripJsonFences(out: string): string {
  const fence = out.trim().match(/```(?:json)?\s*\n([\s\S]*?)```/);
  const text = (fence ? fence[1] : out).trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

/**
 * Assemble the full manifest from the model's proposal. The generated part is
 * only the corpus plan and copy; everything that governs SAFETY — compliance
 * tier, budget, and above all `approvedBy: null` — is set here, not by the
 * model. A model that returned `"approvedBy": "someone"` must not be able to
 * open Gate 1.
 */
export function assembleManifest(input: ManifestGenInput, proposal: unknown): Manifest {
  const { prospect, recon, runId } = input;
  const p = (proposal ?? {}) as Record<string, unknown>;
  const budget = prospect.crawlPages ?? input.defaultCrawlPages ?? 300;

  const sources = Array.isArray(p.sources) ? (p.sources as Record<string, unknown>[]) : [];
  if (sources.length === 0) throw new Error("generated manifest proposed no sources");

  let host: string;
  try {
    host = new URL(prospect.url).hostname.replace(/^www\./, "");
  } catch {
    throw new Error(`prospect url is not parseable: ${prospect.url}`);
  }

  const cleaned: ManifestSource[] = sources.map((s, i): ManifestSource => {
    const url = String(s.url ?? "");
    let sourceHost: string;
    try {
      sourceHost = new URL(url).hostname.replace(/^www\./, "");
    } catch {
      throw new Error(`sources[${i}]: url is not parseable: ${url}`);
    }
    // Off-domain sources are refused rather than trimmed. We send this demo back
    // to the company we crawled; a competitor's page in their corpus is the
    // single worst thing this pipeline could ship.
    if (sourceHost !== host && !sourceHost.endsWith(`.${host}`))
      throw new Error(
        `sources[${i}]: ${sourceHost} is not on the prospect's domain (${host}) — refusing off-domain source`,
      );
    const type = String(s.type ?? "website");

    /**
     * A document source is ONE file, and must NOT be given a crawl spec.
     *
     * The clamp below walks `crawl.limit` and drops any source left at zero —
     * so a document that inherited a crawl block would be silently deleted the
     * moment the page budget ran out, which is the failure this whole lane
     * exists to end. It counts 1 against the budget via `estPages`, which is
     * also what validateManifest sums.
     */
    if (type === "document") {
      return {
        id: String(s.id ?? `doc-${i + 1}`),
        url,
        tier: "T1" as const,
        type,
        destination: "rag" as const,
        rationale: String(s.rationale ?? "document published by the prospect"),
        license: String(s.license ?? "public web, robots-allowed"),
        estPages: 1,
      };
    }

    return {
      id: String(s.id ?? `src-${i + 1}`),
      url,
      tier: "T1" as const,
      type,
      destination: "rag" as const,
      rationale: String(s.rationale ?? "prospect's own public pages"),
      license: String(s.license ?? "public web, robots-allowed"),
      estPages: Number(s.estPages ?? 0) || 1,
      crawl: {
        multi: (s.crawl as Record<string, unknown> | undefined)?.multi !== false,
        sitemap: (s.crawl as Record<string, unknown> | undefined)?.sitemap !== false,
        limit: Number((s.crawl as Record<string, unknown> | undefined)?.limit ?? s.estPages ?? 50) || 50,
        ...(recon.likelySpa ? { scraper: "@cloudflare/browser-rendering" } : {}),
      },
    };
  });

  // Clamp to budget rather than failing: the model routinely proposes a plan a
  // few pages over, and validateManifest would reject the whole run for it.
  //
  // Documents are reserved FIRST, capped, and never clamped. They are the
  // scarce half of a corpus — a company publishes a handful of PDFs and
  // thousands of pages — so letting a generous crawl limit consume the budget
  // ahead of them gets the trade exactly backwards.
  const documents = cleaned.filter(isDocumentSource).slice(0, MAX_DOCUMENT_SOURCES);
  const crawls = cleaned.filter((s) => !isDocumentSource(s));

  let remaining = Math.max(0, budget - documents.length);
  for (const s of crawls) {
    if (!s.crawl) continue;
    s.crawl.limit = Math.max(0, Math.min(s.crawl.limit ?? 0, remaining));
    remaining -= s.crawl.limit;
  }
  const kept = [...crawls.filter((s) => (s.crawl?.limit ?? 0) > 0), ...documents];
  if (kept.length === 0) throw new Error(`crawl budget ${budget} left no room for any source`);

  const chat = (p.chat ?? {}) as Record<string, unknown>;
  const evalQueries = (Array.isArray(p.evalQueries) ? p.evalQueries : []).map(String).filter(Boolean);
  if (evalQueries.length < 3)
    throw new Error(`generated manifest has ${evalQueries.length} evalQueries — need at least 3`);

  const manifest: Manifest = {
    prospect: prospect.slug,
    prospectName: prospect.name,
    anchorCustomer: prospect.anchorCustomer,
    run: runId,
    created: new Date().toISOString().slice(0, 10),
    complianceTier: prospect.complianceTier,
    complianceFlags: prospect.complianceFlags,
    complianceNotes: prospect.complianceNotes ?? "",
    budgets: { crawlPages: budget, embeddingTokens: 2_000_000 },
    evalQueries,
    chat: {
      starters: (Array.isArray(chat.starters) ? chat.starters : []).map(String).slice(0, 3),
      welcomeMessage: typeof chat.welcomeMessage === "string" ? chat.welcomeMessage : undefined,
      threadPrefix: (Array.isArray(chat.threadPrefix) ? chat.threadPrefix : []).map(String),
      msgPrefix: typeof chat.msgPrefix === "string" ? chat.msgPrefix : undefined,
    },
    sources: kept,
    // Gate 1 stays shut. Intake proposes; a human approves.
    approvedBy: null,
    approvedAt: null,
  };

  const errors = validateManifest(manifest);
  if (errors.length) throw new Error(`assembled manifest is invalid:\n  - ${errors.join("\n  - ")}`);
  return manifest;
}

/** Generate a manifest via the local `claude` CLI, retrying once on rejection. */
export async function generateManifest(input: ManifestGenInput): Promise<Manifest> {
  let prompt = buildManifestPrompt(input);
  let lastErr = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const stdout = await runClaude(prompt);
    try {
      return assembleManifest(input, JSON.parse(stripJsonFences(stdout)));
    } catch (err) {
      lastErr = (err as Error).message;
      prompt = `${buildManifestPrompt(input)}\n\nYour previous attempt was REJECTED: ${lastErr}\nOutput only corrected JSON.`;
    }
  }
  throw new Error(`manifest generation failed twice — last reason: ${lastErr}`);
}

/** Today's run id for a prospect, avoiding collision with an existing one. */
export function nextRunId(runsDir: string, slug: string, today: string): string {
  const dir = join(runsDir, slug);
  const existing = existsSync(dir) ? readdirSync(dir) : [];
  for (let n = 1; n < 100; n++) {
    const id = `${today}-${String(n).padStart(3, "0")}`;
    if (!existing.includes(id)) return id;
  }
  throw new Error(`more than 99 runs for ${slug} on ${today}`);
}

export interface IntakeResult {
  prospect: QueuedProspect;
  runId: string;
  runDir: string;
  manifestPath: string;
  sourceCount: number;
  plannedPages: number;
}

/** Full intake for one prospect: recon → generate → write the run directory. */
export async function intakeProspect(opts: {
  prospect: QueuedProspect;
  runsDir: string;
  today?: string;
  defaultCrawlPages?: number;
}): Promise<IntakeResult> {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const runId = nextRunId(opts.runsDir, opts.prospect.slug, today);
  const recon = await reconSite(opts.prospect.url);

  const manifest = await generateManifest({
    prospect: opts.prospect,
    recon,
    runId,
    defaultCrawlPages: opts.defaultCrawlPages,
  });

  const runDir = join(opts.runsDir, opts.prospect.slug, runId);
  mkdirSync(runDir, { recursive: true });
  const manifestPath = join(runDir, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  // Keep the survey next to the manifest — it is the evidence for the plan, and
  // the first thing a Gate 1 reviewer wants when a source list looks odd.
  writeFileSync(join(runDir, "recon.json"), `${JSON.stringify(recon, null, 2)}\n`);

  return {
    prospect: opts.prospect,
    runId,
    runDir,
    manifestPath,
    sourceCount: manifest.sources.length,
    plannedPages: manifest.sources.reduce((n, s) => n + (s.crawl?.limit ?? s.estPages), 0),
  };
}

/** Read + parse the queue file. */
export function loadQueue(path: string): QueuedProspect[] {
  if (!existsSync(path))
    throw new Error(
      `no prospect queue at ${path}\n` +
        `  A fresh clone ships without one — the queue is yours to fill.\n` +
        `  Copy research/prospect-queue.example.yaml to that path to start.`,
    );
  return parseQueue(readFileSync(path, "utf8"));
}
