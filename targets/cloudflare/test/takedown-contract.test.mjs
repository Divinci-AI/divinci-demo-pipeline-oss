// A crawler must be able to honour "please remove me". This pins the two
// halves that make that possible in OWN-CORPUS mode.
//
// ── Why this test is STRUCTURAL rather than behavioural ─────────────────────
//
// `src/index.js` imports `cloudflare:workers`, which does not resolve outside
// the Workers runtime, so it cannot be loaded by `node` at all — which is why
// no other test in this directory imports it. Asserting on source text is the
// weakest useful form of this check and it is used only because the strong
// form is unavailable here. It catches the regression it is aimed at (someone
// dropping the identifiers from the publish tombstone) and it would NOT catch
// a logic error elsewhere in the path. Treat a pass as "the wiring is still
// there", not as "takedown works".
//
// ── The contract ────────────────────────────────────────────────────────────
//
// Shared-directory mode can ask the directory which release a host was
// published as. Own-corpus mode has no directory, and `recordPublish` stores
// only host/pages/chunks/at — so unless the publish TOMBSTONE carries the
// vectorId and releaseId, an own-corpus deployment can crawl a site and then
// have no way to unpublish it.
import { readFileSync } from "node:fs";

let fail = 0;
const ok = (c, m) => { if (!c) { console.log("  ❌ " + m); fail++; } else console.log("  ✅ " + m); };

const src = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");

// 1. The publish path records both identifiers on the tombstone.
ok(/retire\(host,\s*"published",\s*\{[^}]*vectorId[^}]*releaseId[^}]*\}/.test(src),
   "the publish tombstone carries vectorId AND releaseId");

// 2. `retire` actually persists the extra fields rather than dropping them.
ok(/DONE \+ host,\s*JSON\.stringify\(\{ reason, at: Date\.now\(\), \.\.\.extra \}\)/.test(src),
   "retire spreads the extra fields into the stored tombstone");

// 3. Withdrawal has an own-corpus path that reads the tombstone.
ok(/if \(!env\.DIRECTORY_URL\) \{[\s\S]{0,600}?BUCKET\.get\(DONE \+/.test(src),
   "withdrawal without a directory resolves the release from the tombstone");

// 4. It refuses rather than guessing when there is no record.
ok(/no publish record for these hosts/.test(src),
   "a host this deployment never published is refused, not guessed at");

// 5. It must not have silently reverted to a blanket 501.
ok(!/withdrawal needs DIRECTORY_URL/.test(src),
   "own-corpus withdrawal is not disabled outright");

// 6. The irreversible step still runs last (guarded properly in withdraw.test.mjs;
//    this only checks the ordering comment has not been removed along with it).
ok(/destroys a database irreversibly|IRREVERSIBLE/.test(src),
   "the destructive nature of withdrawal is still called out at the call site");

console.log();
if (fail) { console.log(`❌ ${fail} takedown assertion(s) failed`); process.exit(1); }
console.log("✅ takedown contract: all assertions passed");
