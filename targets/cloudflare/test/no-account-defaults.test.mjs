// The extraction guard.
//
// Three values in this Worker used to default to the infrastructure of the
// deployment it was extracted from: the status-feed URL, the withdrawal
// directory, and the User-Agent the crawler presents to every site it reads.
//
// None of them is a credential, which is exactly what made them dangerous. A
// default that is merely WRONG fails on the first call. A default naming a
// real, live endpoint belonging to somebody else SUCCEEDS — an unconfigured
// fork reports its crawl state to a stranger's status page, and identifies
// itself to every crawled site as an operator who has nothing to do with it.
//
// These are the regression tests for that class. They are deliberately
// behavioural rather than a grep: a grep over source text is satisfied by
// moving the literal, and this repo has already been bitten by a sweep that
// only looked at one language.
import { reportActivity } from "../src/activity.js";
import { robotsUserAgent } from "../src/ai-rights.js";

let fail = 0;
const ok = (c, m) => { if (!c) { console.log("  ❌ " + m); fail++; } else console.log("  ✅ " + m); };

// ── 1. the status feed ──────────────────────────────────────────────────────

{
  let called = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { called = true; return new Response("{}"); };
  const r = await reportActivity(
    { WWW_RAG_ACTIVITY_TOKEN: "tok" },   // token present, URL absent
    { sites: [] },
  );
  globalThis.fetch = realFetch;
  ok(called === false, "no WWW_RAG_ACTIVITY_URL ⇒ NO request is made to anyone");
  ok(r.skipped === true, "…and it reports itself skipped rather than failed");
}

// ── 2. the crawler's identity ───────────────────────────────────────────────

{
  const ua = robotsUserAgent({});
  ok(!/divinci/i.test(ua), "an unconfigured crawler does not claim to be the original operator");
  ok(!/https?:\/\//.test(ua), "…and names no contact URL it cannot honour");
  ok(/not configured/i.test(ua), "…and says so, so the omission is visible in a site's own logs");
}
{
  const ua = robotsUserAgent({ CRAWLER_CONTACT_URL: "https://acme.example/bot" });
  ok(ua.includes("https://acme.example/bot"), "a configured contact URL is the one presented");
  ok(!/divinci/i.test(ua), "…and nothing else is");
}

// ── 3. no source file may name a specific deployment as a fallback ──────────
//
// A narrow, behaviour-adjacent check: `?? "https://…"` and `|| "https://…"`
// are the two shapes every one of these bugs took. This does not replace the
// behavioural tests above; it catches a NEW one being added.
{
  const fs = await import("node:fs");
  const path = await import("node:path");
  const dir = new URL("../src/", import.meta.url).pathname;
  const offenders = [];
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".js"))) {
    const body = fs.readFileSync(path.join(dir, f), "utf8");
    for (const line of body.split("\n")) {
      // Only assignments/fallbacks, so documentation and comments are exempt.
      if (/^\s*(\/\/|\*)/.test(line)) continue;
      if (/(\?\?|\|\|)\s*["'`]https?:\/\//.test(line)) offenders.push(`${f}: ${line.trim().slice(0, 90)}`);
    }
  }
  ok(offenders.length === 0,
     "no source file falls back to a hardcoded URL" + (offenders.length ? `\n     ${offenders.join("\n     ")}` : ""));
}

console.log();
if (fail) { console.log(`❌ ${fail} extraction assertion(s) failed`); process.exit(1); }
console.log("✅ no account-specific defaults: all assertions passed");
