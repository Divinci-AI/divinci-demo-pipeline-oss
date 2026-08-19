/**
 * Should we abandon a crawl before its deadline?
 *
 * Pure so it can be tested.
 *
 * ⚠️ CORRECTED 2026-08-18. This guard was written for archive.org, on the
 * belief that it had "sat at running for the full 25-minute budget" with a
 * frontier too large to finish. That diagnosis was wrong, and the evidence for
 * it was an artifact: the crawl step was capped at 5 minutes by the Workflows
 * per-step limit, so NO crawl was ever observed past 5 minutes and every slow
 * host looked unfinishable. With the step cap fixed, archive.org completes in
 * well under budget and publishes 100 pages at 5,523 B/page — comfortably above
 * the directory median.
 *
 * The guard is kept because a genuinely unfinishable frontier is still
 * possible and cheap to refuse. But it has never actually fired on a real host,
 * so treat its thresholds as untested against production and do NOT lower a
 * crawl limit on the strength of this comment.
 *
 * Returns { abort: false } or { abort: true, reason }.
 */
export function crawlBudgetVerdict({ elapsedMs, done, total, deadlineMs, graceMs }) {
  // Never judge before the grace period — discovery and the first renders are
  // legitimately slow, and an early verdict would kill healthy crawls.
  if (elapsedMs <= graceMs) return { abort: false };

  if (done === 0) {
    return {
      abort: true,
      reason:
        `crawl rendered NOTHING in ${Math.round(elapsedMs / 1000)}s ` +
        `(frontier ${total}) — host is not crawlable at this configuration`,
    };
  }

  const msPerPage = elapsedMs / done;
  // max(total, done) guards a missing/zero `total`: projecting from `done`
  // alone can never exceed the deadline, so an absent field cannot cause a
  // false abort. A guard that kills healthy crawls because a field was missing
  // is worse than the problem it solves.
  const projected = msPerPage * Math.max(total, done);
  if (projected > deadlineMs) {
    return {
      abort: true,
      reason:
        `crawl cannot finish in budget — ${done}/${total} pages in ` +
        `${Math.round(elapsedMs / 1000)}s (${(msPerPage / 1000).toFixed(1)}s/page, ` +
        `projected ${Math.round(projected / 60000)}min vs ` +
        `${Math.round(deadlineMs / 60000)}min budget). Retry this host with a lower limit.`,
    };
  }
  return { abort: false };
}
