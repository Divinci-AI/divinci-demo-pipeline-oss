/**
 * ScoredQA integration for the demo pipeline.
 *
 * QA runs go through `divinci qa multi-release-run` (OAuth admin path) —
 * this is the SAME engine the web UI's "Run Suite" button uses, so results
 * land in the suite's run history and quality report pages.
 *
 * Do NOT use the consumer `POST /api/v1/qa/suites/{id}/run` endpoint for
 * pipeline runs: it executes and scores, but stores results under a
 * "post-ft" iteration namespace that the run history / report pages don't
 * read (discovered 2026-06-12 — results were invisible in the web UI).
 *
 * Other platform quirks (2026-06-12):
 * - The release MUST have its RAG vector linked (release.ragIndexes) or every
 *   test errors with "Cannot read properties of undefined (reading 'content')".
 *   ensureReleaseRagLinked() checks via the consumer API (needs DIVINCI_API_KEY).
 * - Web client host is chat.divinci.app (prod) / chat.stage.divinci.app (staging);
 *   bare stage.divinci.app has no DNS.
 */

import { dv } from "./divinci.js";

const API_BASE = () => process.env.DIVINCI_API_URL ?? "https://api.divinci.app";
const WEB_BASE = () => process.env.DIVINCI_WEB_URL ?? "https://chat.divinci.app";

export interface QARunReport {
  runResultId?: string;
  perRelease: Array<{
    releaseId: string;
    title?: string;
    testCount: number;
    passedCount: number;
    errorCount: number;
    overallScore: number | null;
    scoreAverages?: Record<string, number>;
  }>;
  perTest: Array<{
    testId: string;
    prompt: string;
    scoresByRelease?: Record<string, number | null>;
  }>;
}

/** Parse the multi-release-run CLI output (json + the stderr "Run ID:" line). */
export function parseMultiReleaseRun(raw: string, json: unknown): QARunReport {
  const j = (json ?? {}) as Record<string, unknown>;
  const report: QARunReport = {
    runResultId: raw.match(/Run ID:\s*([0-9a-f]{24})/)?.[1],
    perRelease: (j.perRelease as QARunReport["perRelease"]) ?? [],
    perTest: (j.perTest as QARunReport["perTest"]) ?? [],
  };
  if (!report.perRelease.length) {
    throw new Error(`multi-release-run output missing perRelease:\n${raw.slice(0, 800)}`);
  }
  return report;
}

/**
 * Verify the release has the RAG vector in release.ragIndexes.
 *
 * Goes through the `divinci` CLI (OAuth) rather than the consumer API, so it
 * needs NO `DIVINCI_API_KEY`. That matters: the README instructs leaving that
 * variable unset (the CLI prefers it over OAuth and then cannot create
 * workspaces), so the old key-authenticated version could only ever throw —
 * which is why QA silently never ran for 17 of 19 runs.
 */
export async function ensureReleaseRagLinked(
  releaseId: string,
  vectorId: string,
  opts: { workspace?: string; profile?: string } = {},
): Promise<boolean> {
  const res = await dv(["release", "get", releaseId], {
    workspace: opts.workspace,
    profile: opts.profile,
  });
  const release = (res.json ?? {}) as { ragIndexes?: Array<{ id: string } | string> };
  if (!Array.isArray(release.ragIndexes)) {
    throw new Error(
      `release get ${releaseId}: could not read ragIndexes from CLI output:\n${res.raw.slice(0, 400)}`,
    );
  }
  // ragIndexes entries are objects ({id}) on the admin path but have been seen
  // as bare id strings — accept both rather than silently reporting "not linked".
  return release.ragIndexes.some((r) => (typeof r === "string" ? r : r?.id) === vectorId);
}

// NOTE: the web route is /scored-qa/suites/runs/:runResultId — NO suiteId
// segment. (The CLI's "View in browser" line prints a suiteId-qualified URL
// that 404s — a CLI bug.)
export function qaRunUrl(workspaceId: string, runResultId: string): string {
  return `${WEB_BASE()}/white-label/${workspaceId}/scored-qa/suites/runs/${runResultId}`;
}

/** The workspace's home in the web client — what a Gate 2 reviewer opens. */
export function workspaceUrl(workspaceId: string): string {
  return `${WEB_BASE()}/white-label/${workspaceId}`;
}

/** The workspace's RAG vector list. */
export function workspaceVectorsUrl(workspaceId: string): string {
  return `${WEB_BASE()}/white-label/${workspaceId}/vector-list`;
}

export function qaSuiteUrl(workspaceId: string, suiteId: string): string {
  return `${WEB_BASE()}/white-label/${workspaceId}/scored-qa/suites/${suiteId}`;
}

export function qaSuiteReportUrl(workspaceId: string, suiteId: string): string {
  return `${WEB_BASE()}/white-label/${workspaceId}/scored-qa/suites/${suiteId}/report`;
}

// ---------------------------------------------------------------- demo link

const EMBED_BASE = () => process.env.DIVINCI_EMBED_URL ?? "https://embed.divinci.app";

/**
 * The public, anonymous-chat demo link to send a prospect. The embed client
 * reads the `release` query param (embed-client incoming-config.ts) and renders
 * the full-page hosted chat. Requires the release to be published AND have
 * allowAnonymousChat=true (verified by the caller).
 */
export function demoLink(releaseId: string): string {
  return `${EMBED_BASE()}/?release=${releaseId}`;
}

/**
 * Confirm the release is publicly demoable: published (status "available")
 * and anonymous chat enabled. Returns a reason string when it is NOT.
 *
 * Probes the PUBLIC release-bootstrap endpoint unauthenticated — the exact
 * request a prospect's browser makes when the demo link is opened. That is
 * strictly better than asking the admin API whether it *ought* to work:
 *
 *  - it needs no credential, so it cannot be skipped for want of one (the old
 *    key-authenticated version was dead code on every run — see the note on
 *    ensureReleaseRagLinked);
 *  - a release can read `status: "available"` on the admin path and still 404
 *    here, and 404-here is what the prospect would actually experience.
 *
 * `DIVINCI_API_URL` must name the environment the run targeted. A staging URL
 * against a production release reports a false "not published" — which is what
 * a probe of the wrong environment SHOULD say, but it is not send-blocking
 * information, so the caller surfaces the base it used.
 */
export async function releaseDemoReadiness(
  releaseId: string,
): Promise<{ ready: boolean; reason?: string }> {
  const url = `${API_BASE()}/white-label-release/${releaseId}`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    return { ready: false, reason: `bootstrap probe failed (${(err as Error).message}) at ${API_BASE()}` };
  }
  if (res.status === 404)
    return {
      ready: false,
      reason: `public bootstrap 404 at ${API_BASE()} — release is not publicly served there (unpublished, or the run targeted a different environment)`,
    };
  if (!res.ok) return { ready: false, reason: `public bootstrap ${res.status} at ${API_BASE()}` };

  const body = (await res.json().catch(() => ({}))) as {
    _id?: string;
    status?: string;
    allowAnonymousChat?: boolean;
  };
  if (body._id !== releaseId)
    return { ready: false, reason: `bootstrap returned a different release (${body._id ?? "no _id"})` };
  if (body.status !== "available")
    return { ready: false, reason: `release not published (status: ${body.status})` };
  if (body.allowAnonymousChat === false)
    return { ready: false, reason: "allowAnonymousChat is false — demo link would require login" };
  return { ready: true };
}
