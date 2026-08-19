/**
 * crawl-scoping.ts — should a source URL's path become --include-paths?
 *
 * Pure, because the decision is the part with judgement in it and the I/O
 * (fetching the sitemap) is not. It shipped inline in run.ts's ingest step
 * first, which meant the logic that governs 358 sources across 90 prospects had
 * never executed in a test.
 *
 * CONTEXT. `--sitemap` resolves the sitemap at the HOST ROOT and ignores the
 * source URL's path, so a manifest scoping a source as
 * `https://wandb.ai/wandb_fc/` crawls all of wandb.ai. Deriving the path fixes
 * that — but manifests are often ASPIRATIONAL: acmehealthmd declares /podcast/,
 * /category/, /topic-guide/ and /outlive/, together ~85 of its 1,166 sitemap
 * URLs, because its content is root-level article slugs. Deriving there cuts
 * ~693 pages to ~280, turning a crawl that was accidentally right into one that
 * is correctly wrong.
 */

export interface ScopingInput {
  /** Source URL path, no trailing slash, e.g. "/wandb_fc". */
  urlPath: string;
  /** Every URL in the host-root sitemap. */
  sitemapUrls: readonly string[];
  /** The source's page limit, for the "will this starve the crawl" warning. */
  limit: number;
}

export interface ScopingDecision {
  scope: boolean;
  /** One line for the run log. Always populated — silence is the failure mode. */
  reason: string;
  matched: number;
}

export function decideScoping(input: ScopingInput): ScopingDecision {
  const { urlPath, sitemapUrls, limit } = input;
  const matched = sitemapUrls.filter((u) => {
    try {
      return new URL(u).pathname.startsWith(`${urlPath}/`);
    } catch {
      return false;
    }
  }).length;

  // No sitemap to judge against: do what the manifest says.
  if (!sitemapUrls.length) {
    return { scope: true, matched, reason: `scoping to ${urlPath}/ (no sitemap to check against)` };
  }

  // Matching nothing means an EMPTY crawl, which is strictly worse than the old
  // host-wide behaviour. This is the only case where we override the manifest.
  if (matched === 0) {
    return {
      scope: false,
      matched,
      reason:
        `⚠️ path ${urlPath}/ matches 0 of ${sitemapUrls.length} sitemap URLs — ` +
        `NOT scoping (would crawl nothing). The manifest's path does not exist on this site; re-author it.`,
    };
  }

  // Fewer-but-right vs more-but-wrong is a judgement about a specific site, so
  // it stays the operator's — made with the number in front of them.
  return {
    scope: true,
    matched,
    reason:
      `--sitemap ignores the URL path — scoping to ${urlPath}/ ` +
      `(${matched} of ${sitemapUrls.length} sitemap URLs, limit ${limit})` +
      (matched < limit ? ` ⚠️ fewer than the limit — expect a small crawl` : ""),
  };
}
