/**
 * Implausible stand-ins for the infrastructure variables, for runs that contact
 * nothing.
 *
 * Anything naming external infrastructure is read through `requireEnv`/`lazyEnv`
 * and has NO default in source, so a misconfigured run stops instead of quietly
 * writing into somebody else's Cloudflare namespace, R2 bucket or GCP project.
 * That rule is load-bearing and these values do not weaken it: they are supplied
 * only where nothing is contacted — the test suite, and the DRY_RUN smoke run.
 *
 * ⚠️ **Keep them implausible.** A placeholder that looks like a real bucket name
 * is one copy-paste away from becoming a default again, which is the exact
 * failure the indirection exists to remove. Every value here is deliberately
 * unusable: `.invalid` is a reserved TLD that cannot resolve.
 *
 * ⚠️ **One declaration, two consumers.** `vitest.config.ts` and
 * `scripts/smoke.mts` both read this module. They used to be one list in the
 * vitest config and nothing for the smoke run — so `npm test` passed with no
 * configuration while the documented smoke command died on the FIRST variable,
 * at the landing step, after every earlier step had succeeded. Do not re-declare
 * these anywhere; a second copy is how the two paths drift apart again.
 */
export const DRY_RUN_PLACEHOLDERS: Readonly<Record<string, string>> = Object.freeze({
  CF_WORKERS_SUBDOMAIN: "example-invalid.workers.dev",
  LANDING_KV_NAMESPACE_ID: "kv-namespace-not-set-in-tests",
  DEMO_ASSETS_R2_BUCKET: "example-invalid-demo-assets",
  DEMO_ASSETS_R2_BASE: "https://r2-base-not-set-in-tests.example.invalid",
  VERTEX_PROJECT: "example-invalid-project",
});
