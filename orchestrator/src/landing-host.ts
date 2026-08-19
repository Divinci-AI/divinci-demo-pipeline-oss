/**
 * Where a finished demo's landing page is hosted.
 *
 * ── Why this is an interface ────────────────────────────────────────────────
 *
 * `buildAndDeployLanding` does two quite different jobs in one function: it
 * turns a run into a built site (clone the template, splice the brand, generate
 * the copy, fix the bios, build), and then it ships that site to Cloudflare
 * Workers. The first job is the pipeline; the second is one deployment choice
 * out of several, and it was welded in at seven points.
 *
 * This is the seam, in the same spirit as `review-board.ts`: the orchestrator
 * calls six functions, and that is the entire surface a new host implements.
 *
 * ── ⚠️ A landing page is NOT a static site ──────────────────────────────────
 *
 * This is the thing that makes the interface bigger than `deploy()` and it is
 * worth stating plainly, because "it's just a built site, push it to a CDN" is
 * the obvious wrong answer:
 *
 *   `LANDING_PAGE_HMAC_KEY` is a secret the deployed site reads AT REQUEST
 *   TIME, to sign its anonymous-chat calls. Paired with
 *   `release.requireSignedAnonymousChat = true` — which the landing stage sets
 *   — it is what stops anyone who extracts the public release id from calling
 *   the chat API directly and bypassing the per-email quota.
 *
 * It is a security control, not a nicety. A host that cannot hold a secret and
 * run code on each request cannot serve a landing page at all, which is why
 * `setSecret` is part of this interface rather than an optimisation.
 *
 * `destroy` is not optional either. Demo workspaces are torn down on expiry to
 * cap standing spend and create honest urgency, and a host with no teardown
 * leaves a live page pointing at a workspace that no longer exists.
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { lazyEnv } from "./require-env.js";

const execFileP = promisify(execFile);

/** Just the parts of the chat gate a host needs to write into its config. */
export interface LandingChatGate {
  noEmailGate: boolean;
  demoQuota: number;
  freeBeforeEmail: number;
}

export interface LandingConfig {
  /** The per-demo name: the Worker name, the Vercel project, the subdomain. */
  slug: string;
  apiBase: string;
  releaseId: string;
  chatGate: LandingChatGate;
  /** Cloudflare-only; hosts that do not use KV ignore it. */
  kvNamespaceId?: string;
}

export interface LandingHost {
  /** Shown in logs and in the run's state, so an operator can tell where a demo went. */
  readonly name: string;

  /**
   * The public URL this slug WILL have, before it is deployed.
   *
   * ⚠️ Needed up front, not after: the page bakes its own `og:url` and social
   * meta at build time, so a host that cannot predict its own URL would ship
   * cards pointing somewhere else.
   */
  urlFor(slug: string): string;

  /** Write whatever configuration file this host reads, into the built site. */
  configure(siteDir: string, cfg: LandingConfig): void;

  /** Ship it. */
  deploy(siteDir: string, cfg: LandingConfig): Promise<{ url: string }>;

  /** Provision a secret the deployed site reads at REQUEST time. */
  setSecret(siteDir: string, slug: string, name: string, value: string): Promise<void>;

  /**
   * Remove a secret. Must treat "was not set" as success — it is
   * indistinguishable from a failed delete on most hosts, and the caller
   * clears the preview gate on EVERY deploy precisely so a demo unlocked once
   * cannot come back locked.
   */
  clearSecret(siteDir: string, slug: string, name: string): Promise<void>;

  /** Demos expire; no zombie hosting. */
  destroy(siteDir: string, slug: string): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cloudflare Workers — the original, extracted unchanged
// ─────────────────────────────────────────────────────────────────────────────

export const WORKERS_SUBDOMAIN = lazyEnv(
  "CF_WORKERS_SUBDOMAIN",
  "your account's workers.dev subdomain, e.g. acme.workers.dev",
);

/**
 * Strip the CF API token so wrangler uses the OAuth session, which has the
 * permissions a token typically lacks. Keep this — a token in the environment
 * silently overrides the browser login and the deploy fails on permissions.
 */
function cfEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CLOUDFLARE_API_TOKEN;
  delete env.CLOUDFLARE_EMAIL;
  delete env.CLOUDFLARE_ACCOUNT_ID;
  return env;
}

export class CloudflareLandingHost implements LandingHost {
  readonly name = "cloudflare";

  urlFor(slug: string): string {
    return `https://${slug}.${WORKERS_SUBDOMAIN()}`;
  }

  configure(siteDir: string, cfg: LandingConfig): void {
    const wranglerPath = join(siteDir, "wrangler.toml");
    let wrangler = readFileSync(wranglerPath, "utf8");
    wrangler = wrangler
      .replace(/^name = ".*"/m, `name = "${cfg.slug}"`)
      .replace(/id = "REPLACE_WITH_KV_NAMESPACE_ID"/, `id = "${cfg.kvNamespaceId ?? ""}"`)
      .replace(/DIVINCI_API_BASE = ".*"/, `DIVINCI_API_BASE = "${cfg.apiBase}"`)
      .replace(/DIVINCI_RELEASE_ID = ".*"/, `DIVINCI_RELEASE_ID = "${cfg.releaseId}"`);

    // The no-email-gate demo needs its WORKER told too, not just its UI.
    //
    // The client edit only changes what the UI asks for; the worker validates
    // the address independently AND keys its free-message quota on it. With the
    // field gone the quota falls back to the visitor's IP — so the budget is a
    // company-wide one, not per-person: a customer reviewing the demo from one
    // office NAT shares a counter that never resets.
    //
    // These were once added by hand on the first such demo, which meant a
    // rebuild silently dropped them and the worker started refusing every
    // message again.
    const { noEmailGate, demoQuota, freeBeforeEmail } = cfg.chatGate;
    if (noEmailGate) {
      wrangler = /^NO_EMAIL_GATE = /m.test(wrangler)
        ? wrangler
            .replace(/^NO_EMAIL_GATE = ".*"/m, `NO_EMAIL_GATE = "1"`)
            .replace(/^DEMO_QUOTA_LIMIT = ".*"/m, `DEMO_QUOTA_LIMIT = "${demoQuota}"`)
        : wrangler.replace(
            /^(DIVINCI_RELEASE_ID = ".*")$/m,
            `$1\nNO_EMAIL_GATE = "1"\nDEMO_QUOTA_LIMIT = "${demoQuota}"`,
          );
      console.log(`[landing] worker gate OFF, per-visitor budget ${demoQuota}`);
    }

    // Keep the WORKER's grace window and the CLIENT's constant in agreement.
    // They are enforced independently — the worker bounds the endpoint, the
    // client decides when to ask — so a drift is either a UI that asks too
    // early, or one that asks too late and sends into a refusal.
    //
    // Written as 0 for a no-email-gate demo: the worker short-circuits on
    // NO_EMAIL_GATE and never consults the grace window, so any other value
    // would sit in the config looking authoritative while being inert.
    wrangler = /^FREE_MESSAGES_BEFORE_EMAIL = /m.test(wrangler)
      ? wrangler.replace(
          /^FREE_MESSAGES_BEFORE_EMAIL = ".*"/m,
          `FREE_MESSAGES_BEFORE_EMAIL = "${freeBeforeEmail}"`,
        )
      : wrangler.replace(
          /^(DIVINCI_RELEASE_ID = ".*")$/m,
          `$1\nFREE_MESSAGES_BEFORE_EMAIL = "${freeBeforeEmail}"`,
        );
    writeFileSync(wranglerPath, wrangler);
  }

  async deploy(siteDir: string, cfg: LandingConfig): Promise<{ url: string }> {
    await execFileP("npx", ["wrangler", "deploy"], {
      cwd: siteDir, env: cfEnv(), timeout: 10 * 60 * 1000, maxBuffer: 32 * 1024 * 1024,
    });
    return { url: this.urlFor(cfg.slug) };
  }

  async setSecret(siteDir: string, _slug: string, name: string, value: string): Promise<void> {
    // `wrangler secret put` reads the value from stdin, which keeps it out of
    // argv and the shell history. execFileSync supports `input`; execFile does
    // not — do not "modernise" this to the promisified form.
    execFileSync("npx", ["wrangler", "secret", "put", name], {
      cwd: siteDir, env: cfEnv(), input: value,
      timeout: 2 * 60 * 1000, stdio: ["pipe", "ignore", "inherit"],
    });
  }

  async clearSecret(siteDir: string, _slug: string, name: string): Promise<void> {
    try {
      execFileSync("npx", ["wrangler", "secret", "delete", name], {
        cwd: siteDir, env: cfEnv(), input: "y\n",
        timeout: 2 * 60 * 1000, stdio: ["pipe", "ignore", "ignore"],
      });
    } catch {
      // "Not set" is the normal case and is indistinguishable from a failed
      // delete here, because wrangler's output is discarded. The caller
      // verifies the result over HTTP rather than trusting this.
    }
  }

  async destroy(siteDir: string, slug: string): Promise<void> {
    await execFileP("npx", ["wrangler", "delete", "--name", slug, "--force"], {
      cwd: siteDir, env: cfEnv(), timeout: 5 * 60 * 1000,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Vercel
// ─────────────────────────────────────────────────────────────────────────────

export const VERCEL_TOKEN = lazyEnv("VERCEL_TOKEN", "a Vercel access token with project write");

/** Optional: deploy into a team rather than a personal account. */
export function vercelScopeArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  return env.VERCEL_ORG_ID ? ["--scope", env.VERCEL_ORG_ID] : [];
}

/**
 * The landing template must be able to sign chat calls wherever it runs.
 *
 * On Cloudflare that is the Worker itself. On Vercel it has to be Edge
 * Middleware or a Function, and the template — a separate repository, cloned at
 * run time — currently ships only the Worker.
 *
 * So this checks for it and REFUSES rather than deploying a page whose signed
 * chat will fail on every request. That failure would otherwise be invisible at
 * deploy time and total at use time: the page loads, looks perfect, and every
 * message is rejected by the API.
 */
export function vercelSigningReadiness(siteDir: string): { ready: boolean; reason?: string } {
  const candidates = [
    "middleware.ts", "middleware.js",
    join("src", "middleware.ts"), join("src", "middleware.js"),
    join("api", "chat.ts"), join("api", "chat.js"),
  ];
  const found = candidates.map((c) => join(siteDir, c)).find((p) => existsSync(p));
  if (found) {
    // ⚠️ The file existing is not the thing that matters — it has to actually
    // hold the signing key. An empty `middleware.ts`, or one added for
    // redirects or analytics, would satisfy a mere existence check and deploy a
    // page whose every chat message is refused, which is the exact failure this
    // guard exists to prevent.
    //
    // Naming the variable is the cheapest honest proxy: a middleware that signs
    // must read LANDING_PAGE_HMAC_KEY, and one that does not cannot.
    const body = readFileSync(found, "utf8");
    if (!body.includes("LANDING_PAGE_HMAC_KEY")) {
      return {
        ready: false,
        reason:
          `${found.replace(siteDir + "/", "")} exists but never reads ` +
          "LANDING_PAGE_HMAC_KEY, so it cannot be signing anything.\n" +
          "  A middleware added for redirects or analytics satisfies a file check " +
          "and still deploys a page whose every chat message is refused.\n" +
          "  See VERCEL.md in divinci-landing-template.",
      };
    }
    return { ready: true };
  }
  return {
    ready: false,
    reason:
      "the landing template has no Vercel middleware or function, so it cannot hold " +
      "LANDING_PAGE_HMAC_KEY or sign anonymous-chat calls at request time.\n" +
      "  The page would deploy and look correct, and every chat message would be " +
      "refused by the API because release.requireSignedAnonymousChat is set.\n" +
      "  Add middleware.ts to divinci-landing-template that signs the same way its " +
      "Worker does, then re-run. Set LANDING_ALLOW_UNSIGNED=1 to deploy anyway — " +
      "only meaningful for a demo whose release does NOT require signed chat.",
  };
}

export class VercelLandingHost implements LandingHost {
  readonly name = "vercel";

  urlFor(slug: string): string {
    // Vercel's stable per-project domain. Not the per-deployment URL, which
    // changes on every push and would break a link already sent to a customer.
    return `https://${slug}.vercel.app`;
  }

  configure(siteDir: string, cfg: LandingConfig): void {
    // Build-time values go in the build; request-time values are secrets and
    // go through setSecret. Written as `vercel.json` env rather than a config
    // file the template reads, so the same built output works on either host.
    const path = join(siteDir, "vercel.json");
    const existing = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
    const { noEmailGate, demoQuota, freeBeforeEmail } = cfg.chatGate;
    writeFileSync(path, JSON.stringify({
      ...existing,
      env: {
        ...(existing.env ?? {}),
        DIVINCI_API_BASE: cfg.apiBase,
        DIVINCI_RELEASE_ID: cfg.releaseId,
        FREE_MESSAGES_BEFORE_EMAIL: String(freeBeforeEmail),
        ...(noEmailGate ? { NO_EMAIL_GATE: "1", DEMO_QUOTA_LIMIT: String(demoQuota) } : {}),
      },
    }, null, 2) + "\n");
  }

  async deploy(siteDir: string, cfg: LandingConfig): Promise<{ url: string }> {
    if (process.env.LANDING_ALLOW_UNSIGNED !== "1") {
      const readiness = vercelSigningReadiness(siteDir);
      if (!readiness.ready) throw new Error(`[landing:vercel] ${readiness.reason}`);
    }
    await execFileP("npx", [
      "vercel", "deploy", "--prod", "--yes",
      "--token", VERCEL_TOKEN(), "--name", cfg.slug, ...vercelScopeArgs(),
    ], { cwd: siteDir, timeout: 10 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 });
    return { url: this.urlFor(cfg.slug) };
  }

  async setSecret(siteDir: string, slug: string, name: string, value: string): Promise<void> {
    // Remove first: `vercel env add` fails on an existing name rather than
    // replacing it, so a redeploy would leave the OLD value in place while
    // reporting an error the caller might reasonably ignore.
    await this.clearSecret(siteDir, slug, name);
    // The value goes over stdin, never argv — several agents share this
    // machine and argv is world-readable via `ps`.
    execFileSync("npx", [
      "vercel", "env", "add", name, "production",
      "--token", VERCEL_TOKEN(), ...vercelScopeArgs(),
    ], { cwd: siteDir, input: value, timeout: 2 * 60 * 1000, stdio: ["pipe", "ignore", "inherit"] });
  }

  async clearSecret(siteDir: string, _slug: string, name: string): Promise<void> {
    try {
      execFileSync("npx", [
        "vercel", "env", "rm", name, "production", "--yes",
        "--token", VERCEL_TOKEN(), ...vercelScopeArgs(),
      ], { cwd: siteDir, timeout: 2 * 60 * 1000, stdio: ["pipe", "ignore", "ignore"] });
    } catch {
      // Not set is the normal case, as on Cloudflare.
    }
  }

  async destroy(siteDir: string, slug: string): Promise<void> {
    await execFileP("npx", [
      "vercel", "remove", slug, "--yes", "--token", VERCEL_TOKEN(), ...vercelScopeArgs(),
    ], { cwd: siteDir, timeout: 5 * 60 * 1000 });
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export const LANDING_HOSTS = ["cloudflare", "vercel"] as const;
export type LandingHostName = (typeof LANDING_HOSTS)[number];

/**
 * Pick the host for this run.
 *
 * Defaults to Cloudflare because that is what every existing demo was deployed
 * to, and a run's landing URL is already recorded in its state — silently
 * moving hosts would strand demos whose links are out with customers.
 */
export function resolveLandingHost(env: NodeJS.ProcessEnv = process.env): LandingHost {
  const name = (env.LANDING_HOST ?? "cloudflare").toLowerCase();
  switch (name) {
    case "cloudflare": return new CloudflareLandingHost();
    case "vercel": return new VercelLandingHost();
    default:
      throw new Error(
        `LANDING_HOST="${name}" is not a host. Known: ${LANDING_HOSTS.join(", ")}.`,
      );
  }
}
