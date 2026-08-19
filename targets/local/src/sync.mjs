// Push locally-computed chunks + embeddings to a Vectorize RagVector.
//
//   POST /api/v1/local-sync/:whitelabelId/init      { host }          → { vectorId }
//   POST /api/v1/local-sync/:whitelabelId/batch     { vectorId, rows } ≤100 rows
//   POST /api/v1/local-sync/:whitelabelId/finalize  { vectorId, totalChunks }
//
// Every row is keyed by content hash and Vectorize upserts by id, so this is
// idempotent by construction: re-running after a crash re-sends rows that
// already landed and changes nothing, and a re-crawl only materially writes
// what actually changed. There is no session state to resume and none to
// corrupt.

import crypto from "node:crypto";

/** The server caps a batch at 100 rows. */
export const MAX_BATCH = 100;

/** Stable content hash — the upsert key. Must match for identical text. */
export function contentHash(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

export class SyncError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = "SyncError";
    this.status = status;
    this.code = code;
  }
}

async function call(session, path, body) {
  const res = await fetch(`${session.apiUrl}/api/v1/local-sync/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  // Never bare .json() — a 502 from a proxy is an HTML page, and the resulting
  // SyntaxError names nothing useful.
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; }
  catch {
    throw new SyncError(`local-sync/${path} returned non-JSON (${res.status}): ${text.slice(0, 200)}`, res.status);
  }
  if (!res.ok) {
    const e = json?.error ?? {};
    throw new SyncError(
      `local-sync/${path} → ${res.status}${e.code ? ` ${e.code}` : ""}: ${e.message ?? text.slice(0, 200)}`,
      res.status, e.code,
    );
  }
  return json;
}

export const init = (session, whitelabelId, host) =>
  call(session, `${whitelabelId}/init`, { host });

export const sendBatch = (session, whitelabelId, vectorId, rows) =>
  call(session, `${whitelabelId}/batch`, { vectorId, rows });

export const finalize = (session, whitelabelId, vectorId, totalChunks) =>
  call(session, `${whitelabelId}/finalize`, { vectorId, totalChunks });

/** Split into server-legal batches. Exported so the sizing is testable. */
export function batches(rows, size = MAX_BATCH) {
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/**
 * Push every row, reporting progress.
 *
 * ⚠️ Batch failures are retried, then RE-THROWN. A partial push must not be
 * finalized: `finalize` stamps a chunk count that the directory and the UI then
 * render, and stamping a count for a corpus that is missing rows produces a
 * vector that looks complete and retrieves badly — the hardest failure of this
 * kind to notice later.
 */
export async function pushAll(session, whitelabelId, vectorId, rows, { onProgress, attempts = 3 } = {}) {
  const chunks = batches(rows);
  let sent = 0;
  for (const [i, batch] of chunks.entries()) {
    let lastErr;
    for (let a = 0; a < attempts; a++) {
      try {
        await sendBatch(session, whitelabelId, vectorId, batch);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        // A 4xx is a statement about the request and will not become true by
        // being repeated. Only retry transport and 5xx.
        if (e instanceof SyncError && e.status >= 400 && e.status < 500) break;
        if (a < attempts - 1) await new Promise((r) => setTimeout(r, (a + 1) * 2000));
      }
    }
    if (lastErr) throw lastErr;
    sent += batch.length;
    onProgress?.({ batch: i + 1, batches: chunks.length, sent, total: rows.length });
  }
  return { sent, batches: chunks.length };
}
