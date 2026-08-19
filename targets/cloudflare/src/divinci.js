export async function divinci(env, method, path, body) {
  const res = await fetch(`${env.DIVINCI_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.DIVINCI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error(`Divinci ${method} ${path} non-JSON (${res.status}): ${text.slice(0, 200)}`); }
  if (!res.ok) throw new Error(`Divinci ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return json;
}

/**
 * Store the site's BYO Turso credential and create its RagVector.
 *
 * ⚠️ minimumSimilarity must be PATCHed separately: the rag-vector CREATE
 * endpoint ignores it and defaults to 0.62. Web-crawl chunks (nav pages, terse
 * fragments) score ~0.40-0.46 cosine, so 0.62 filters out every legitimate hit
 * at retrieval time — the vector would exist, be indexed, and return nothing.
 */
export async function registerVector(env, { slug, dbUrl, authToken, embeddingModel }) {
  const wl = env.WHITELABEL_ID;
  const key = await divinci(env, "POST", `/white-label/${wl}/tools/byok/keys`, {
    name: `turso-${slug}`,
    providerId: "TURSO_LIBSQL",
    auth: { databaseUrl: dbUrl, authToken },
  });

  const minimumSimilarity = Number(env.MIN_SIMILARITY ?? 0.4);
  const vec = await divinci(env, "POST", `/white-label/${wl}/rag-vector`, {
    title: `WWW-RAG ${slug}`,
    description: `website-segmented index for ${slug}`,
    vectorIndexTool: "turso-libsql",
    embeddingModel,
    authKey: key._id,
    minimumSimilarity,
  });

  let similarityApplied = true;
  if (Math.abs((vec.minimumSimilarity ?? 0.62) - minimumSimilarity) > 1e-9) {
    try {
      await divinci(env, "PATCH", `/white-label/${wl}/rag-vector/${vec._id}/settings`, { minimumSimilarity });
    } catch {
      similarityApplied = false;
    }
  }
  return { vectorId: vec._id, keyId: key._id, minimumSimilarity, similarityApplied };
}
