// Turso from a Worker: platform API for provisioning, HTTP pipeline for SQL.
//
// ⚠️ This deliberately does NOT reproduce `turso db create --from-file`. That
// path uploads a local .db via the CLI, which a Worker cannot do. The bulk path
// used here — batched pipeline calls — is the pattern publish-site-to-divinci.mjs
// already uses for its INSERT…SELECT step, and Turso documents batches of up to
// ~1000 statements as the supported bulk shape.

const PLATFORM = "https://api.turso.tech/v1";

/** Rows are inlined as SQL text, not bound args: vector32('[...]') is what the
 *  Rust dump path emits and is known to round-trip. Keep the escaping strict. */
export const sqlStr = (s) => `'${String(s).replace(/'/g, "''")}'`;

export async function createDatabase({ org, token, name, group }) {
  const res = await fetch(`${PLATFORM}/organizations/${org}/databases`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, group }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`turso db create ${name} failed (${res.status}): ${text.slice(0, 300)}`);
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`turso db create returned non-JSON: ${text.slice(0, 200)}`); }
  const host = json?.database?.Hostname || json?.database?.hostname;
  if (!host) throw new Error(`turso db create gave no hostname: ${text.slice(0, 200)}`);
  return { host, url: `libsql://${host}` };
}

export async function mintDatabaseToken({ org, token, name }) {
  const res = await fetch(
    `${PLATFORM}/organizations/${org}/databases/${name}/auth/tokens?authorization=full-access`,
    { method: "POST", headers: { Authorization: `Bearer ${token}` } },
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`turso token mint failed (${res.status}): ${text.slice(0, 300)}`);
  const jwt = JSON.parse(text)?.jwt;
  if (!jwt) throw new Error("turso token mint returned no jwt");
  return jwt;
}

export async function destroyDatabase({ org, token, name }) {
  const res = await fetch(`${PLATFORM}/organizations/${org}/databases/${name}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.ok || res.status === 404;
}

/**
 * Execute statements over the Hrana HTTP pipeline.
 *
 * ⚠️ Retries on 5xx/network: publish-site-to-divinci.mjs measured ~10% of large
 * pipeline calls failing transiently during a 93-host batch. A failed attempt
 * never partially commits (the pipeline is executed as a unit), so a blind
 * retry is safe — do not "optimise" that into a resume-from-N.
 */
export async function pipeline({ host, token, stmts, attempts = 4 }) {
  const body = JSON.stringify({
    requests: [...stmts.map((sql) => ({ type: "execute", stmt: { sql } })), { type: "close" }],
  });
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`https://${host}/v2/pipeline`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`pipeline ${res.status}: ${text.slice(0, 300)}`);
      const json = JSON.parse(text);
      // A 200 can still carry a per-statement error — the HTTP status only
      // reports transport. Surface the first one rather than reporting success.
      const failed = (json.results || []).find((r) => r?.type === "error");
      if (failed) throw new Error(`sql error: ${JSON.stringify(failed.error).slice(0, 300)}`);
      return json;
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
  throw lastErr;
}

export const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS chunks(cid INTEGER PRIMARY KEY, website TEXT, url TEXT, text TEXT, category TEXT, e F32_BLOB(768))",
  "CREATE TABLE IF NOT EXISTS site_centroids(website TEXT PRIMARY KEY, centroid TEXT)",
];

export function insertChunkSQL({ cid, website, url, text, category, embedding }) {
  return `INSERT INTO chunks VALUES(${cid},${sqlStr(website)},${sqlStr(url)},${sqlStr(text)},${sqlStr(category)},vector32('[${embedding.join(",")}]'))`;
}
