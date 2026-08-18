/**
 * Required-environment accessor.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * Before this repo was extracted for public release, three account-specific
 * identifiers were baked in as `?? "<literal>"` fallbacks: a Cloudflare KV
 * namespace id, an R2 bucket name, and that bucket's public `r2.dev` base.
 *
 * None of them is a credential, which is exactly what made them dangerous. A
 * fallback that is merely *wrong* fails loudly on the first call. A fallback
 * that points at a real, live resource belonging to somebody else succeeds —
 * the run completes, the writes land, and the operator has no signal at all
 * that their demo assets went into a stranger's bucket.
 *
 * So: no defaults for anything that names external infrastructure. An unset
 * variable stops the run at the point of first use, naming the variable and
 * what it is for.
 *
 * Defaults remain correct and are still used freely for things that are purely
 * behavioural — model names, thresholds, feature flags, timeouts. The rule is
 * about *identity of external resources*, not about configuration in general.
 */

export class MissingEnvError extends Error {
  constructor(name: string, purpose?: string) {
    super(
      purpose
        ? `Missing required environment variable ${name} — ${purpose}`
        : `Missing required environment variable ${name}`,
    );
    this.name = "MissingEnvError";
  }
}

/**
 * Read an environment variable that has no safe default.
 *
 * @param name    the variable to read
 * @param purpose short description used in the error, e.g.
 *                "the Cloudflare KV namespace backing the landing worker"
 */
export function requireEnv(name: string, purpose?: string): string {
  const value = process.env[name];
  // An empty string is treated as unset. `FOO=` in a .env file is a far more
  // common way to "unset" something than deleting the line, and an empty
  // bucket name or namespace id is never meaningful.
  if (value === undefined || value.trim() === "") {
    throw new MissingEnvError(name, purpose);
  }
  return value;
}

/**
 * Deferred `requireEnv` — returns a getter that reads on FIRST CALL, not at
 * module-evaluation time.
 *
 * ⚠️ Always use this for a module-level binding. Two independent reasons, both
 * of which were hit converting this repo's `?? "<literal>"` defaults:
 *
 * 1. **`.env` is loaded after imports.** `run.ts` loads `orchestrator/.env`
 *    once the module graph is already evaluated, so a top-level
 *    `const X = requireEnv("X")` reads the environment as it was BEFORE the
 *    file it is configured by was read. `review-board.ts` documents the same
 *    hazard for its own base URL.
 * 2. **It turns a config error into a collection error.** A module-level throw
 *    fires on `import`, so every test that so much as imports the module dies
 *    before a single assertion runs — 16 test files at once, with a failure
 *    that names the env var rather than the test. The value is only genuinely
 *    needed when the code that uses it runs.
 *
 * The result is memoized, so the error surfaces once, at the first real use.
 */
export function lazyEnv(name: string, purpose?: string): () => string {
  let cached: string | undefined;
  return () => (cached ??= requireEnv(name, purpose));
}
