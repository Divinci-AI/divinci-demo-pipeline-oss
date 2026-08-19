// The dedupe authority — which record decides whether a host is already
// published. Getting this wrong does not fail loudly; it builds a second vector
// and a second release for a site that already had one.
//
// This module was changed during extraction. Internally there was exactly one
// directory and its URL was a hardcoded constant, so a fork pointed at its own
// corpus would have consulted SOMEBODY ELSE'S directory and skipped every host
// they had published. These tests pin both modes.
import { fetchPublishedHosts } from "../src/directory.js";

let fail = 0;
const ok = (c, m) => { if (!c) { console.log("  ❌ " + m); fail++; } else console.log("  ✅ " + m); };

const realFetch = globalThis.fetch;
const stub = (impl) => { globalThis.fetch = impl; };
const restore = () => { globalThis.fetch = realFetch; };

// ── OWN-CORPUS mode (DIRECTORY_URL unset) ───────────────────────────────────

{
  let called = false;
  stub(async () => { called = true; return new Response("{}"); });
  const r = await fetchPublishedHosts({});
  restore();
  ok(r.ok === true, "own-corpus mode reports ok — there is no remote record to be unable to reach");
  ok(r.local === true, "…and flags itself local so the caller substitutes the R2 done set");
  ok(r.hosts.size === 0, "…with an empty host set");
  ok(called === false, "…and makes NO network call at all");
}

{
  const r = await fetchPublishedHosts(undefined);
  ok(r.local === true, "a missing env object is own-corpus mode, not a crash");
}

// ── SHARED-DIRECTORY mode (DIRECTORY_URL set) ───────────────────────────────

const ENV = { DIRECTORY_URL: "https://example.test/directory" };

{
  let seen = null;
  stub(async (u) => { seen = String(u); return Response.json({ sites: [{ host: "nasa.gov" }] }); });
  const r = await fetchPublishedHosts(ENV);
  restore();
  ok(seen === "https://example.test/directory", "the configured URL is the one fetched");
  ok(r.ok === true && r.local === false, "a populated directory is authoritative and not local");
  ok(r.count === 1, "the site count is reported");
}

{
  stub(async () => Response.json({ sites: [{ host: "www.nist.gov" }] }));
  const r = await fetchPublishedHosts(ENV);
  restore();
  // www-stripping on BOTH sides, so www.nist.gov and nist.gov cannot dual-publish.
  ok(r.hosts.has("www.nist.gov"), "the listed host matches");
  ok(r.hosts.has("nist.gov"), "…and so does its bare form");
}

{
  stub(async () => Response.json({ sites: [{ host: "nist.gov" }] }));
  const r = await fetchPublishedHosts(ENV);
  restore();
  ok(r.hosts.has("www.nist.gov"), "a bare listing also matches the www form");
}

{
  stub(async () => Response.json({ sites: [{}, { host: null }, { host: "ok.test" }] }));
  const r = await fetchPublishedHosts(ENV);
  restore();
  ok(r.ok === true && r.hosts.has("ok.test"), "malformed entries are skipped, not fatal");
}

// ── SHARED-DIRECTORY mode FAILS CLOSED ──────────────────────────────────────
//
// With no directory every host looks new, so a fail-open republishes the whole
// corpus as duplicates. This exact fetch returned nothing during a network blip
// on 2026-08-13 and the guard correctly refused the pass.

{
  stub(async () => Response.json({ sites: [] }));
  const r = await fetchPublishedHosts(ENV, 1);
  restore();
  ok(r.ok === false, "an EMPTY directory is 'cannot tell', never 'nothing is published'");
  ok(r.local === false, "…and is not mistaken for own-corpus mode");
}

{
  stub(async () => new Response("nope", { status: 500 }));
  const r = await fetchPublishedHosts(ENV, 1);
  restore();
  ok(r.ok === false, "an errored directory fails closed");
}

{
  stub(async () => { throw new Error("ECONNRESET"); });
  const r = await fetchPublishedHosts(ENV, 1);
  restore();
  ok(r.ok === false, "an unreachable directory fails closed rather than throwing");
}

{
  let n = 0;
  stub(async () => { n++; return Response.json({ sites: [] }); });
  await fetchPublishedHosts(ENV, 1);
  restore();
  ok(n === 1, "the attempt count is honoured (the suite does not sit through real backoff)");
}

console.log();
if (fail) { console.log(`❌ ${fail} directory assertion(s) failed`); process.exit(1); }
console.log("✅ directory authority: all assertions passed");
