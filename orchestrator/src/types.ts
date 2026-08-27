export type Tier = "T1" | "T2";

export type ComplianceTier =
  | "wellness-low"
  | "commerce-medium"
  | "clinic-high"
  | "sensitive-audience";

/**
 * Additive hazard layers, orthogonal to the tier. Keep in step with
 * `ComplianceFlag` in compliance-prompt.ts, which owns the rules, and with
 * `FLAG_HAZARDS` in qa-suite-gen.ts, which owns what the QA suite attacks — a
 * flag present in one and absent from another is worse than no flag, because
 * the run reports a clean score for a hazard nothing tested.
 */
export type ComplianceFlag =
  | "sensitive-audience"
  | "financial-advice"
  | "legal-advice"
  | "public-service";

export interface CrawlSpec {
  /** Multi-page crawl (follow links) vs single-page scrape. */
  multi?: boolean;
  /** Discover pages via the site's sitemap (multi mode). */
  sitemap?: boolean;
  /** Max pages for this source; clamped to the manifest's remaining crawl budget. */
  limit?: number;
  includePaths?: string[];
  excludePaths?: string[];
  /** Scraper tool id. Default `@divinci-ai/fetch-scraper` (fast, no JS). Set to
   *  `@cloudflare/browser-rendering` for JS/SPA-rendered sites. (`@divinci-ai/firecrawl`
   *  is NOT configured on staging — don't use.) */
  scraper?: string;
}

export interface ManifestSource {
  id: string;
  url: string;
  tier: Tier;
  type: string;
  destination: "rag" | "fine-tune" | "reject";
  rationale: string;
  license: string;
  estPages: number;
  crawl?: CrawlSpec;
}

/**
 * A `document` source is ONE published file (PDF/Office), ingested by upload.
 *
 * It is not crawlable: a text crawl walks HTML links and never opens the PDF
 * behind one. It therefore carries no `crawl` block, is never clamped by the
 * page budget, and counts 1 via `estPages`.
 */
export function isDocumentSource(s: Pick<ManifestSource, "type">): boolean {
  return s.type === "document";
}

export interface Manifest {
  prospect: string;
  prospectName: string;
  /** Attio deal reference, e.g. "attio:deals/2843bf90-..." */
  anchorCustomer: string;
  run: string;
  created: string;
  complianceTier: ComplianceTier;
  /**
   * Additive hazard layers, independent of the tier. A prospect whose legal
   * exposure is commercial but whose readers are vulnerable carries
   * `["sensitive-audience"]` alongside `commerce-medium` — before this existed,
   * picking one tier meant picking which hazard to leave undefended.
   */
  complianceFlags?: ComplianceFlag[];
  complianceNotes: string;
  budgets: {
    /** Enforced by the orchestrator (planned pages validated, running total capped). */
    crawlPages: number;
    /** Advisory in v0 — embedding consumption is server-side; enforcement TODO. */
    embeddingTokens: number;
  };
  /** Queries used for rag test-retrieval probes after ingest. */
  evalQueries: string[];
  /**
   * Prospect-facing chat copy written onto the RELEASE (not the landing page).
   * Optional — falls back to the first three evalQueries and a generic
   * greeting. Prefer authoring it: eval queries are diagnostic probes tuned to
   * stress retrieval, whereas a starter is the first sentence a prospect reads.
   * `starters` is capped at 3 by the server.
   */
  chat?: {
    starters?: string[];
    welcomeMessage?: string;
    /** Thread-title prefixes — string ARRAY (schema `kind: "thread"`). */
    threadPrefix?: string[];
    /** Message prefix — single STRING (schema `kind: "message"`). */
    msgPrefix?: string;
  };
  sources: ManifestSource[];
  /** Gate 1 — nothing is created or ingested while this is null. */
  approvedBy: string | null;
  approvedAt: string | null;
}

export interface RunState {
  prospect: string;
  run: string;
  step: string;
  /**
   * The Divinci API base this run was built against, stamped on first use and
   * never changed afterwards. Runs are NOT all on the same environment (the
   * first 18 are staging; everything from 2026-08-05 is production), and a run
   * advanced against the wrong one looks for a workspace that does not exist
   * there. Before this field existed the environment was implicit in whatever
   * the operator's shell happened to hold.
   */
  apiUrl?: string;
  /**
   * Which pipeline commit produced each step's output.
   *
   * Three times on 2026-08-09 a fix was judged against an artifact built BEFORE
   * that fix existed — once by four minutes — and each time the conclusion was
   * "the fix does not work". Recovering the truth meant comparing a commit
   * timestamp against a file mtime by hand.
   *
   * With this, "is this artifact from the fixed code?" is a lookup rather than
   * archaeology: `stepSha.landing` is the SHA that wrote the current landing
   * output. Same idea as the locale archive's `.translated-from.sha256`, which
   * is what closed the last bios defect.
   */
  stepSha?: Record<string, string>;
  workspaceId?: string;
  vectorId?: string;
  activeVector?: string;
  vectorIdHistory?: Record<string, string>;
  pagesCrawled: number;
  ingested: string[];
  /** YouTube video IDs already uploaded — per-video idempotency so a resumed
   *  playlist ingest never re-uploads (duplicate files in the vector). */
  ingestedVideos?: string[];
  /** Page URLs already submitted to the global WWW RAG corpus
   *  (POST /api/v1/www-rag/submit-url) — idempotency for the `wwwrag` step so a
   *  resumed run never re-submits. */
  wwwRagSubmitted?: string[];
  /** Release the demo chat runs against (RAG vector must be linked to it). */
  releaseId?: string;
  /** ScoredQA suite imported from runs/<prospect>/<run>/qa-suite.yaml. */
  qaSuiteId?: string;
  /** Latest ScoredQA run ID (consumer API iterationResultId). */
  qaRunId?: string;
  /** Latest ScoredQA overall score (0-1) and pass counts. */
  qaScore?: number | null;
  /**
   * Per-scorer averages (correctness / relevance / completeness).
   *
   * The OVERALL score blends these, and relevance runs 98-100% on almost
   * everything — an answer that fabricates a post-op rehab protocol is still
   * perfectly on-topic. So the overall figure flatters a demo whose
   * CORRECTNESS is the thing at issue, and correctness is what any
   * prospect-facing claim must be keyed to.
   */
  qaScoreAverages?: Record<string, number>;
  /** Lowest single-test score in the run — a mean hides one catastrophic test. */
  qaMinTestScore?: number | null;
  qaPassedCount?: number;
  qaTestCount?: number;

  /**
   * Corpus COMPLETENESS — set arithmetic between the site's sitemap and the
   * URLs actually in the vector. Free (no model call). Added 2026-08-15 after
   * acmerenew.com shipped with 8 of its 29 pages and nothing noticed:
   * `pagesCrawled` counts pages VISITED, not distinct URLs that landed.
   */
  coverageRatio?: number | null;
  /** Distinct URLs the site's sitemap advertises. Denominator for coverage. */
  /** Every replicate score for THIS release, same suite and stack. The noise band. */
  qaReplicates?: number[] | null;
  /** Population sd across qaReplicates. null when only one replicate succeeded. */
  qaScoreSd?: number | null;
  coverageSitemapCount?: number | null;
  /** Verdict of the automatic triage when a run scores below the publish gate. */
  qaTriage?: { verdict: string; arms: string[]; at: string } | null;
  coverageVerdict?: "ok" | "under-crawled" | "no-sitemap";
  /** Sitemap URLs that never reached the vector — the list that explains a bad answer. */
  coverageMissing?: string[];
  /** URLs ingested more than once, worst first. */
  coverageDuplicates?: Array<{ url: string, count: number }>;
  /** ScoredQA run of the coverage suite. Distinct from qaScore, which is the HAZARD suite. */
  coverageSuiteId?: string;
  coverageRunId?: string;
  coverageScore?: number | null;
  /** Set when a sub-threshold coverage halt was waived, so a waived demo is
   *  distinguishable from one that passed. */
  coverageOverriddenBy?: string;
  /** review-board project ID for this prospect (created once, reused across runs). */
  boardProjectId?: string;
  /** Gate 1 — review-board task ID for corpus manifest review (if created). */
  gate1TaskId?: string;
  /** Gate 2 — demo reviewed by a human before release/outreach. */
  demoApprovedBy?: string;
  /** Gate 2 — review-board task ID for demo review (if created). */
  gate2TaskId?: string;
  /** Outreach — review-board task ID for asset drafting + send approval (Gate 3). */
  outreachTaskId?: string;
  /** Outreach — set when the outreach task is marked DONE (approved to send). */
  outreachApprovedBy?: string;
  /** Landing — branded landing worker URL (the demo link sent to prospects). */
  landingUrl?: string;
  landingWorkerName?: string;
  /** Landing — Basic-Auth preview-gate credentials (sent with the demo link). */
  landingBasicAuthUser?: string;
  landingBasicAuthPassword?: string;
  /** True once the demo has been deliberately opened to the public (handed to
   *  the customer). Sticky, because the gate cannot be removed any other way:
   *  the credentials are regenerated with `??=` on every deploy, and deleting
   *  the Cloudflare secret by hand is undone by the next one. Without this, a
   *  routine rebuild silently re-gates a link already shared with a customer. */
  landingPublic?: boolean;
  /** Landing — review-board task ID for brand review before build/deploy. */
  landingTaskId?: string;
  /** Outreach — the public demo link injected into the email (landingUrl, or
   *  the bare embed release link as fallback). */
  demoLink?: string;
  /** Outreach — ISO date the demo expires. Provisional (draft + 14d) at
   *  injection; re-stamped authoritatively to (approval + 14d) when the
   *  outreach gate is approved. The teardown job enforces THIS date. */
  demoExpiresAt?: string;
  /** Outreach — set once the teardown job has deprecated the demo release. */
  demoTornDownAt?: string;
  /** Set once teardown has deleted the landing Worker, so it is not retried. */
  landingWorkerDeletedAt?: string;
  log: { at: string; msg: string }[];
}

export function validateManifest(m: Manifest): string[] {
  const errors: string[] = [];
  if (!m.prospect) errors.push("prospect is required");
  if (!m.run) errors.push("run is required");
  if (!m.budgets || m.budgets.crawlPages <= 0)
    errors.push("budgets.crawlPages must be > 0");
  if (!m.sources?.length) errors.push("at least one source is required");
  for (const s of m.sources ?? []) {
    if (!s.url) errors.push(`source ${s.id}: url is required`);
    if (s.tier !== "T1" && s.tier !== "T2")
      errors.push(
        `source ${s.id}: tier must be T1 or T2 — T3 (customer data) is never allowed in demos`
      );
    if (!s.license) errors.push(`source ${s.id}: license is required`);
  }
  const planned = m.sources
    .filter((s) => s.destination === "rag")
    .reduce((n, s) => n + (s.crawl?.limit ?? s.estPages), 0);
  if (planned > m.budgets.crawlPages)
    errors.push(
      `planned pages (${planned}) exceed budgets.crawlPages (${m.budgets.crawlPages})`
    );
  return errors;
}
