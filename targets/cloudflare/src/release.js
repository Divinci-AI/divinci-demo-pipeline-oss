// Release creation over the PUBLIC v1 API.
//
// ⛔ Not /white-label/:id/release. That mount never opted into API-key auth
// (403 "forbidden"), and widening it would hand a key all 28 routes under it —
// clone-to (another workspace), release-users, toggle-moderation,
// deidentification, and POST /:id/update on the LIVE release. /api/v1/releases
// re-exports exactly the handlers we need under release:write, behind
// requireAPIKey + injectWhitelabel (the workspace comes from the key's own
// binding, so we cannot target another one) + audit log + rate limiting.
//
// Verb differences from the whitelabel mount, both easy to get wrong:
//   update  = PATCH /:id            (not POST /:id)
//   publish = POST  /:id/publish    (not GET  /:id/release)

const ASSISTANT_ID = "gemini-2.5-flash-lite";

async function v1(env, method, path, body) {
  const res = await fetch(`${env.DIVINCI_API_BASE}/api/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.DIVINCI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error(`v1 ${method} ${path} non-JSON (${res.status}): ${text.slice(0, 200)}`); }
  if (!res.ok) throw new Error(`v1 ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return json;
}

/**
 * The full draft body.
 *
 * Every field here is REQUIRED by castDraftBody, and the same body is reused for
 * the update call — update-draft runs the COMPLETE cast, not a partial one, so a
 * themeOverride-only body 400s on the first missing required field.
 *
 * ⚠️ `ragIndexes` is `[{id}]` — not `ragVectorIndexes`, not bare id strings. The
 * cast is OPTIONAL, so the wrong key or shape fails SILENTLY and produces a
 * release with no corpus attached: a site that publishes, serves, and answers
 * from nothing.
 */
export function buildReleaseBody({ host, slug, vectorId, theme }) {
  const body = {
    slug: `wwwrag-${slug}`,
    title: host,
    description: `Chat with the WWW-RAG crawled corpus for ${host}.`,
    allowAnonymousChat: true,
    // Required by castDraftBody, and the anti-abuse ceiling: these are public
    // anonymous LLM endpoints billed to one shared wallet.
    maxAnonymousChatMessages: 10,
    assistant: { id: ASSISTANT_ID, finetune: false },
    // Required — castPromptModerationConfig throws on undefined. noHarmful ON
    // is the right posture for a public anonymous endpoint.
    promptModeration: {
      noHarmful: { title: "Message considered harmful", on: true },
      onTopic: { title: "Message considered off topic", minimumContext: 0, minimumTokens: 0 },
      custom: [],
    },
    ragIndexes: [{ id: vectorId }],
    publicResponseCache: { enabled: true },
  };
  if (theme) body.themeOverride = theme;
  return body;
}

export const createDraft = (env, body) => v1(env, "POST", "/releases", body);
export const getRelease = (env, id) => v1(env, "GET", `/releases/${id}`);
export const updateDraft = (env, id, body) => v1(env, "PATCH", `/releases/${id}`, body);
export const publishDraft = (env, id) => v1(env, "POST", `/releases/${id}/publish`);

/** Best-effort per-host brand theme. Absent for most hosts; never fatal. */
export async function fetchTheme(env, host) {
  try {
    const r = await v1(env, "GET", `/www-rag/theme?host=${encodeURIComponent(host)}`);
    return r?.themed ? r.theme : null;
  } catch {
    return null;
  }
}

/**
 * Link releaseId back onto the WwwRagSite so the directory can serve it.
 *
 * ⚠️ Uses the FLEET webhook, not `_admin/register-sites`. The admin route is
 * `requireAuthedUserForWwwRag + requirePlatformAdmin()` and rejects API-key
 * callers by design — every fleet registration 401'd against it, and the
 * pageCount/totalBytes already computed were discarded (64 of 303 directory
 * cards read "0 pages"). The webhook exists precisely for this caller.
 *
 * HMAC-SHA256 hex over the body, header `x-divinci-signature`.
 *
 * ⚠️ The server verifies over `JSON.stringify(parsedBody)` — the RE-SERIALIZED
 * body, not the bytes you sent. From JS that is free: sign exactly the string
 * you POST and V8's stable key order matches on both ends. From any other
 * language it is a trap. Python's `json.dumps` emits `", "` / `": "` where
 * JSON.stringify emits none, so the server re-serializes to different bytes and
 * returns a bare 401 that looks like a wrong secret. Use
 * `separators=(",", ":")` (verified 2026-08-17: identical payload, 401 → 200).
 */
/** HMAC-SHA256 hex, matching the server's `createHmac("sha256", secret)
 *  .update(rawBody,"utf8").digest("hex")`. Exported so a test can pin this
 *  WebCrypto implementation against Node's — a signature that is merely
 *  plausible fails as a flat 401 with no clue which side is wrong. */
export async function signPayload(secret, payload) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function registerSite(env, { host, vectorId, releaseId, pageCount, totalBytes }) {
  if (!env.WWW_RAG_THEME_WEBHOOK_SECRET) {
    return { linked: false, reason: "WWW_RAG_THEME_WEBHOOK_SECRET not set" };
  }
  // ⚠️ pageCount/totalBytes must be sent HERE. The directory card renders them
  // straight from the WwwRagSite record, and omitting them is not a cosmetic
  // gap — the card reads "0 pages", which is the exact symptom that affected
  // 64 of 303 cards when fleet registrations were failing. We already computed
  // both in the chunk step; discarding them and backfilling later is the
  // mistake that comment records.
  const payload = JSON.stringify({
    sites: [{ host, vectorId, releaseId, pageCount, totalBytes }],
  });
  const hex = await signPayload(env.WWW_RAG_THEME_WEBHOOK_SECRET, payload);

  const res = await fetch(`${env.DIVINCI_API_BASE}/api/v1/www-rag-webhook/register-sites`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-divinci-signature": `sha256=${hex}` },
    body: payload,
  });
  const text = await res.text();
  if (!res.ok) return { linked: false, reason: `${res.status}: ${text.slice(0, 200)}` };
  return { linked: true };
}
