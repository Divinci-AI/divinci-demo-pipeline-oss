// On-device embeddings via Ollama.
//
// The model is `embeddinggemma` (768-d) because that is the SAME model
// Cloudflare serves as `@cf/google/embeddinggemma-300m`. Vectors produced here
// therefore live in the same space as vectors produced by the Cloudflare
// target and by the hosted pipeline — so a corpus can be built locally, or on
// the edge, or half each, and retrieval still works.
//
// ⛔ Do not "upgrade" the model without changing every producer at once.
// Vectors from different embedding models are not comparable even at identical
// dimensionality: mixing them inside one vector index does not error, it just
// returns wrong neighbours, quietly and forever.

export const MODEL = "embeddinggemma";
export const DIM = 768;

export class EmbeddingError extends Error {}

const OLLAMA_DEFAULT = "http://127.0.0.1:11434";

/** Is Ollama up, and does it have the model pulled? */
export async function preflight({ host = process.env.OLLAMA_HOST || OLLAMA_DEFAULT, model = MODEL } = {}) {
  let tags;
  try {
    const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    tags = await res.json();
  } catch (e) {
    return {
      ok: false,
      reason: `Ollama unreachable at ${host} (${String(e.message || e)}).\n` +
        `  Start it with:  ollama serve`,
    };
  }
  // Ollama reports "embeddinggemma:latest" for a bare `ollama pull embeddinggemma`.
  const names = (tags.models ?? []).map((m) => String(m.name ?? ""));
  const have = names.some((n) => n === model || n.startsWith(`${model}:`));
  if (!have) {
    return {
      ok: false,
      reason: `Ollama is running but "${model}" is not pulled.\n` +
        `  Pull it with:  ollama pull ${model}\n` +
        `  Present: ${names.length ? names.join(", ") : "(no models)"}`,
    };
  }
  return { ok: true, host, model };
}

/**
 * Embed one batch of texts.
 *
 * Ollama's /api/embed takes an array and returns `embeddings[]` in order.
 * ⚠️ Order is the ONLY thing tying a vector back to its chunk — there is no id
 * in the response — so this must never reorder, dedupe or filter its input.
 */
export async function embedBatch(texts, { host = process.env.OLLAMA_HOST || OLLAMA_DEFAULT, model = MODEL } = {}) {
  if (!texts.length) return [];
  const res = await fetch(`${host}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: texts }),
    // Generous: a cold model load on a laptop can take a while, and a timeout
    // here loses the whole batch's compute.
    signal: AbortSignal.timeout(180_000),
  });
  // ⚠️ /api/embed (batch) was added in Ollama 0.3.x. Older builds have only
  // /api/embeddings (singular), and answer this with a 404 whose body says
  // nothing about versions — which reads as "the model is missing" and sends
  // people to re-pull a model that is already there.
  if (res.status === 404) {
    throw new EmbeddingError(
      "Ollama has no /api/embed — that batch endpoint needs Ollama 0.3 or newer.\n" +
      "  Upgrade Ollama, then re-run.  (`ollama --version`)",
    );
  }
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch { throw new EmbeddingError(`Ollama returned non-JSON (${res.status}): ${text.slice(0, 200)}`); }
  if (!res.ok) throw new EmbeddingError(`Ollama ${res.status}: ${String(json.error ?? text).slice(0, 300)}`);

  const out = json.embeddings;
  if (!Array.isArray(out) || out.length !== texts.length) {
    throw new EmbeddingError(
      `Ollama returned ${Array.isArray(out) ? out.length : "no"} embeddings for ${texts.length} inputs — ` +
      `refusing to guess which vector belongs to which chunk`,
    );
  }
  for (const v of out) {
    if (!Array.isArray(v) || v.length !== DIM) {
      throw new EmbeddingError(
        `expected ${DIM}-d vectors, got ${Array.isArray(v) ? v.length : typeof v} — ` +
        `is "${model}" really embeddinggemma?`,
      );
    }
  }
  return out;
}
