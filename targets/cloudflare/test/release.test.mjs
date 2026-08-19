// Unit tests for the release body and the webhook signature.
//
// Both failure modes these cover are SILENT in production:
//   - a wrong `ragIndexes` shape is an OPTIONAL cast, so the release publishes
//     with no corpus attached and answers from nothing
//   - a wrong HMAC is a flat 401 with no indication which side is wrong
//
// Run: node test/release.test.mjs
import { createHmac } from "node:crypto";
import { buildReleaseBody, signPayload } from "../src/release.js";

let fail = 0;
const ok = (c, m) => { if (!c) { console.log("  ❌ " + m); fail++; } else console.log("  ✅ " + m); };

// ── buildReleaseBody ────────────────────────────────────────────────────────
const body = buildReleaseBody({ host: "example.com", slug: "example-com", vectorId: "abc123" });

// castDraftBody throws on any of these being absent. update-draft runs the FULL
// cast, so a body missing one 400s on the update even if the create succeeded.
for (const f of [
  "slug", "title", "description", "allowAnonymousChat",
  "maxAnonymousChatMessages", "assistant", "promptModeration", "ragIndexes",
]) {
  ok(body[f] !== undefined, `required field present: ${f}`);
}

ok(body.slug === "wwwrag-example-com", "slug is wwwrag-<slug>");
ok(body.title === "example.com", "title is the host");

// The silent one. castOptionalArrayOfObjectsWithId accepts nothing else, and
// because it is OPTIONAL a wrong shape produces a release with no corpus.
ok(Array.isArray(body.ragIndexes), "ragIndexes is an array");
ok(body.ragIndexes.length === 1 && body.ragIndexes[0].id === "abc123",
   "ragIndexes is [{id}] — not bare id strings");
ok(body.ragVectorIndexes === undefined,
   "does NOT use ragVectorIndexes (the caster ignores it, silently)");
ok(typeof body.ragIndexes[0] === "object",
   "ragIndexes entries are objects, not strings");

// castPromptModerationConfig throws on undefined; noHarmful ON is the posture
// for a public anonymous endpoint.
ok(body.promptModeration?.noHarmful?.on === true, "promptModeration.noHarmful is ON");
ok(Array.isArray(body.promptModeration?.custom), "promptModeration.custom is an array");

// Anti-abuse ceiling on a public endpoint billed to one shared wallet.
ok(body.allowAnonymousChat === true, "anonymous chat enabled");
ok(body.maxAnonymousChatMessages === 10, "per-visitor message cap set");

// Dropped by create-release-draft (it destructures castDraftBody without this
// field), so it only lands via the unconditional update call.
ok(body.publicResponseCache?.enabled === true, "publicResponseCache requested");

// themeOverride is opt-in.
ok(buildReleaseBody({ host: "h", slug: "s", vectorId: "v" }).themeOverride === undefined,
   "no themeOverride when no theme");
ok(buildReleaseBody({ host: "h", slug: "s", vectorId: "v", theme: { a: 1 } }).themeOverride?.a === 1,
   "themeOverride carried when a theme exists");

// ── signPayload ─────────────────────────────────────────────────────────────
// Pin the Worker's WebCrypto HMAC against the exact Node call the server
// verifies with (verifyWebhookSignature in connector/web-crawl/webhook.ts).
const secret = "test-secret-value";
for (const payload of [
  JSON.stringify({ sites: [{ host: "a.com", vectorId: "v1", releaseId: "r1" }] }),
  "",
  JSON.stringify({ unicode: "café ✓", nested: { deep: [1, 2, 3] } }),
]) {
  const mine = await signPayload(secret, payload);
  const theirs = createHmac("sha256", secret).update(payload, "utf8").digest("hex");
  ok(mine === theirs, `HMAC matches node createHmac (${payload.length} byte payload)`);
}
ok((await signPayload(secret, "x")).length === 64, "signature is 64 hex chars");
ok((await signPayload(secret, "x")) !== (await signPayload("other", "x")),
   "different secret ⇒ different signature");

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
