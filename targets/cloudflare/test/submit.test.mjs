// The crawl-queue submission door.
//
// The refusals are the point. Queueing a host is cheap and reversible; the
// expensive mistakes are (a) crawling a site that told us not to, and (b)
// re-queueing the corpus because we could not tell what was already published.
import { normalizeSubmission, submissionVerdict } from "../src/submit.js";

let fail = 0;
const ok = (c, m) => { if (!c) { console.log("  ❌ " + m); fail++; } else console.log("  ✅ " + m); };

// ── Normalisation ───────────────────────────────────────────────────────────
ok(normalizeSubmission("https://example.com/a/b?token=secret#frag").host === "example.com",
   "reduces a URL to its host, discarding path, query and fragment");
ok(normalizeSubmission("example.com").host === "example.com",
   "accepts a bare hostname");
ok(normalizeSubmission("EXAMPLE.COM.").host === "example.com",
   "lowercases and strips the root-label dot, so one site cannot queue twice");

// A query string is not cosmetic — it carries session tokens and PII, and this
// value lands in R2 and in logs.
ok(!/token/.test(JSON.stringify(normalizeSubmission("https://x.com/p?token=abc123"))),
   "never retains a query string anywhere in the result");

ok(normalizeSubmission("ftp://example.com").error, "rejects a non-http scheme");
ok(normalizeSubmission("javascript:alert(1)").error, "rejects a javascript: URL");
ok(normalizeSubmission("https://user:pw@example.com").error,
   "rejects credentials in the URL rather than replaying someone's secret");
ok(normalizeSubmission("").error, "rejects empty input");
ok(normalizeSubmission(null).error, "rejects a non-string");
ok(normalizeSubmission("not a url at all").error, "rejects unparseable input");

// SSRF surface. The Workers runtime already refuses private ranges; this
// answers immediately and honestly instead of failing opaquely mid-crawl.
for (const h of ["localhost", "http://127.0.0.1", "http://169.254.169.254", "http://10.0.0.5",
                 "svc.internal", "printer.local", "http://[::1]"]) {
  ok(Boolean(normalizeSubmission(h).error), `refuses non-public host: ${h}`);
}

ok(normalizeSubmission("https://bit.ly/xyz").error, "refuses a known shortener (junk list)");

// ── Verdicts ────────────────────────────────────────────────────────────────
const base = {
  host: "example.com", published: false, tombstone: null, rights: null,
  queued: false, inflight: false, frontierFull: false,
};
const v = (over) => submissionVerdict({ ...base, ...over });

ok(v({}).status === "queued", "a clean, unknown host is queued");

// Idempotence: re-submitting must not be an error, or every retrying client
// generates support noise.
ok(v({ queued: true }).status === "already-queued", "an already-queued host reports so, and is not an error");
ok(v({ inflight: true }).status === "already-crawling", "a host being crawled right now reports so");
ok(v({ published: true }).status === "already-published", "an already-published host is not re-queued");

// THE REVOLVING DOOR. A site we withdrew for refusing AI use must not be
// re-queued by anyone — including an honest submitter who does not know.
{
  const r = v({ tombstone: { reason: "ai-reserved" } });
  ok(r.status === "refused" && r.retryable === false, "refuses a host tombstoned as ai-reserved, permanently");
  ok(/reserves AI use/.test(r.reason), "says WHY, in terms a submitter can act on");
}
{
  const r = v({ tombstone: { reason: "withdrawn: rights changed" } });
  ok(r.status === "refused" && r.retryable === false, "refuses a host we previously WITHDREW");
}
{
  const r = v({ rights: { reserved: true } });
  ok(r.status === "refused" && r.retryable === false, "refuses on a cached robots refusal");
}

// An ordinary retirement is refused too, but must not be reported as a rights
// refusal — telling a site owner they blocked us when they did not is worse
// than saying nothing.
{
  const r = v({ tombstone: { reason: "below-density-floor" } });
  ok(r.status === "refused", "refuses a previously-retired host");
  ok(!/reserves AI use/.test(r.reason), "does NOT misreport an ordinary retirement as a rights refusal");
  ok(/below-density-floor/.test(r.reason), "names the actual retirement reason");
}

// Precedence: published/queued must win over the frontier cap, or a caller
// polling a site they already submitted gets a misleading "try again later".
ok(v({ frontierFull: true }).status === "refused", "refuses new work when the frontier is full");
ok(v({ frontierFull: true }).retryable === true, "marks a full frontier as RETRYABLE, unlike a rights refusal");

// Ordering check: a full frontier is evaluated first, so an unknown host is
// never queued past the cap.
ok(v({ frontierFull: true, published: false }).status === "refused",
   "the cap is not bypassed by an unknown host");

// ── Numeric host encodings ──────────────────────────────────────────────────
// These pass for a NON-OBVIOUS reason: `new URL()` normalises 2130706433,
// 0x7f000001 and 127.1 to dotted-quad, so the IPv4 literal check catches them.
// Pinned because a refactor that stops routing through `new URL` — or that
// checks the raw input instead of u.hostname — silently reopens the SSRF path.
for (const raw of ["http://2130706433", "http://0x7f000001", "http://017700000001", "http://127.1"]) {
  ok(Boolean(normalizeSubmission(raw).error), `refuses numeric loopback encoding: ${raw}`);
}

// ── The frontier cap ────────────────────────────────────────────────────────
// It was wrong in BOTH directions before: list() caps at 1000 keys so the page
// is always truncated with ~2,900 pending, making a cap above 1000 unable to
// fire and a cap at or below 1000 fire on every request.
{
  const cap = (pendingCount, maxPending) => submissionVerdict({
    ...base,
    frontierFull: maxPending > 0 && typeof pendingCount === "number" && pendingCount >= maxPending,
  }).status;
  ok(cap(2933, 20000) === "queued", "20,000 cap does not fire at 2,933 pending (the old code could never fire it)");
  ok(cap(20000, 20000) === "refused", "cap fires exactly at the limit");
  ok(cap(25000, 20000) === "refused", "cap fires above the limit");
  ok(cap(2933, 1000) === "refused", "a cap BELOW the current size fires (the old code got this right only by accident)");
  ok(cap(null, 20000) === "queued", "an UNKNOWN count fails OPEN — a missing counter must not stop all submissions");
  ok(cap(99999, 0) === "queued", "maxPending=0 disables the cap");
}

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
