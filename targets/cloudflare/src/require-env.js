/**
 * Required-environment guard for the Worker.
 *
 * The Worker equivalent of `orchestrator/src/require-env.ts`, and it exists for
 * the same reason: a value that names external infrastructure must have no
 * default, because a wrong default does not fail loudly — it succeeds against
 * somebody else's account.
 *
 * That failure is worse here than in the orchestrator. `TURSO_ORG` unset does
 * not stop anything; it builds a URL against an organisation that is not yours
 * and surfaces as an opaque Turso API error several steps into a workflow that
 * has already spent browser-seconds crawling. And this Worker runs on a cron,
 * so nobody is watching when it does.
 *
 * ⚠️ CHECK AT THE EDGE, NOT AT MODULE SCOPE. A throw during module evaluation
 * takes the whole Worker down, including `/health` — so the one endpoint an
 * operator would use to find out what is wrong is the one that stops
 * answering. Every entry point calls `assertConfigured` and returns the list.
 */

/** Names YOUR infrastructure. No default is safe. */
export const REQUIRED_VARS = [
  ["TURSO_ORG", "the Turso organisation each site's database is created in"],
  ["WHITELABEL_ID", "the Divinci whitelabel that owns the RAG vectors this creates"],
];

/** Secrets, set with `wrangler secret put`. Absent means the pipeline cannot run. */
export const REQUIRED_SECRETS = [
  ["CF_ACCOUNT_ID", "the Cloudflare account Browser Rendering is billed to"],
  ["CF_BROWSER_TOKEN", "an API token with Browser Rendering write"],
  ["TURSO_PLATFORM_TOKEN", "a Turso platform token that can create databases"],
  ["DIVINCI_API_KEY", "a Divinci API key with rag-vector and release write"],
  ["TRIGGER_TOKEN", "the bearer that gates /run and /status"],
];

/**
 * @returns {{ok: boolean, missing: string[], detail: string[]}}
 */
export function checkConfig(env) {
  const missing = [];
  const detail = [];
  for (const [name, purpose] of [...REQUIRED_VARS, ...REQUIRED_SECRETS]) {
    const v = env?.[name];
    // An empty string is treated as unset. `FOO=""` in a config file is a far
    // more common way to "unset" something than deleting the line, and an empty
    // organisation name or token is never meaningful.
    if (typeof v !== "string" || v.trim() === "") {
      missing.push(name);
      detail.push(`${name} — ${purpose}`);
    }
  }
  // The R2 bucket is a binding rather than a string, so it is absent in a
  // different way: `env.BUCKET` is undefined when wrangler.jsonc has no
  // r2_buckets entry. Without this the first put() throws
  // "Cannot read properties of undefined", which names nothing.
  if (!env?.BUCKET) {
    missing.push("BUCKET");
    detail.push("BUCKET — the R2 bucket binding holding the frontier and raw pages");
  }
  if (!env?.AI) {
    missing.push("AI");
    detail.push("AI — the Workers AI binding used for embeddings");
  }
  return { ok: missing.length === 0, missing, detail };
}

/**
 * Throw unless every required value is present.
 * The message lists EVERY missing variable, not just the first — configuring
 * one at a time across five deploys is how this check comes to be resented.
 */
export function assertConfigured(env) {
  const { ok, missing, detail } = checkConfig(env);
  if (ok) return;
  throw new Error(
    `Worker is not configured — ${missing.length} required value(s) missing:\n` +
      detail.map((d) => `  • ${d}`).join("\n") +
      `\n\nSee targets/cloudflare/README.md. Variables go in wrangler.jsonc; ` +
      `secrets go in \`wrangler secret put <NAME>\`.`,
  );
}
