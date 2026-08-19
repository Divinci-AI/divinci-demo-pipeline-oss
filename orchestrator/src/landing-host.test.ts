import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CloudflareLandingHost, VercelLandingHost, resolveLandingHost,
  vercelSigningReadiness, vercelScopeArgs, LANDING_HOSTS,
} from "./landing-host.js";

const dirs: string[] = [];
function siteDir(): string {
  const d = mkdtempSync(join(tmpdir(), "landing-host-"));
  dirs.push(d);
  return d;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const CFG = {
  slug: "demo-acme-landing",
  apiBase: "https://api.divinci.app",
  releaseId: "rel-123",
  kvNamespaceId: "kv-abc",
  chatGate: { noEmailGate: false, demoQuota: 25, freeBeforeEmail: 3 },
};

const TEMPLATE_WRANGLER = `name = "REPLACE"
[[kv_namespaces]]
binding = "LEADS"
id = "REPLACE_WITH_KV_NAMESPACE_ID"

[vars]
DIVINCI_API_BASE = "https://example.invalid"
DIVINCI_RELEASE_ID = "REPLACE"
`;

describe("resolveLandingHost", () => {
  it("defaults to Cloudflare", () => {
    // Every existing demo was deployed there and its URL is recorded in state.
    // Silently changing hosts would strand links already sent to customers.
    expect(resolveLandingHost({}).name).toBe("cloudflare");
  });

  it("selects a host by name", () => {
    expect(resolveLandingHost({ LANDING_HOST: "vercel" }).name).toBe("vercel");
    expect(resolveLandingHost({ LANDING_HOST: "VERCEL" }).name).toBe("vercel");
  });

  it("refuses an unknown host rather than falling back", () => {
    // A typo silently deploying to the default is how a demo lands somewhere
    // nobody looks for it.
    expect(() => resolveLandingHost({ LANDING_HOST: "netlify" })).toThrow(/not a host/);
    expect(() => resolveLandingHost({ LANDING_HOST: "netlify" })).toThrow(/cloudflare, vercel/);
  });

  it("every declared host can be constructed", () => {
    for (const name of LANDING_HOSTS) {
      expect(resolveLandingHost({ LANDING_HOST: name }).name).toBe(name);
    }
  });
});

describe("CloudflareLandingHost.configure", () => {
  const host = new CloudflareLandingHost();

  it("writes the name, KV id, api base and release id", () => {
    const d = siteDir();
    writeFileSync(join(d, "wrangler.toml"), TEMPLATE_WRANGLER);
    host.configure(d, CFG);
    const out = readFileSync(join(d, "wrangler.toml"), "utf8");
    expect(out).toContain('name = "demo-acme-landing"');
    expect(out).toContain('id = "kv-abc"');
    expect(out).toContain('DIVINCI_API_BASE = "https://api.divinci.app"');
    expect(out).toContain('DIVINCI_RELEASE_ID = "rel-123"');
    expect(out).not.toContain("REPLACE_WITH_KV_NAMESPACE_ID");
  });

  it("keeps the worker's grace window in step with the client's", () => {
    // They are enforced independently — the worker bounds the endpoint, the
    // client decides when to ask — so a drift is either a UI that asks too
    // early or one that asks too late and sends into a refusal.
    const d = siteDir();
    writeFileSync(join(d, "wrangler.toml"), TEMPLATE_WRANGLER);
    host.configure(d, CFG);
    expect(readFileSync(join(d, "wrangler.toml"), "utf8"))
      .toContain('FREE_MESSAGES_BEFORE_EMAIL = "3"');
  });

  it("tells the WORKER about a no-email-gate demo, not just the UI", () => {
    // The client edit only changes what the UI asks for. The worker validates
    // the address independently and keys its quota on it, so without this the
    // quota falls back to the visitor's IP — one office NAT sharing a counter
    // that never resets. These were once added by hand, so a rebuild silently
    // dropped them and the worker refused every message again.
    const d = siteDir();
    writeFileSync(join(d, "wrangler.toml"), TEMPLATE_WRANGLER);
    host.configure(d, { ...CFG, chatGate: { noEmailGate: true, demoQuota: 40, freeBeforeEmail: 0 } });
    const out = readFileSync(join(d, "wrangler.toml"), "utf8");
    expect(out).toContain('NO_EMAIL_GATE = "1"');
    expect(out).toContain('DEMO_QUOTA_LIMIT = "40"');
    expect(out).toContain('FREE_MESSAGES_BEFORE_EMAIL = "0"');
  });

  it("does not add gate vars for an ordinary demo", () => {
    const d = siteDir();
    writeFileSync(join(d, "wrangler.toml"), TEMPLATE_WRANGLER);
    host.configure(d, CFG);
    expect(readFileSync(join(d, "wrangler.toml"), "utf8")).not.toContain("NO_EMAIL_GATE");
  });

  it("is idempotent — a rebuild must not duplicate the vars", () => {
    // configure() runs on EVERY deploy against a clone that is git-reset first,
    // but a retry can hit an already-configured tree.
    const d = siteDir();
    writeFileSync(join(d, "wrangler.toml"), TEMPLATE_WRANGLER);
    const gated = { ...CFG, chatGate: { noEmailGate: true, demoQuota: 40, freeBeforeEmail: 0 } };
    host.configure(d, gated);
    host.configure(d, gated);
    const out = readFileSync(join(d, "wrangler.toml"), "utf8");
    expect(out.match(/NO_EMAIL_GATE = /g)).toHaveLength(1);
    expect(out.match(/FREE_MESSAGES_BEFORE_EMAIL = /g)).toHaveLength(1);
  });

  it("predicts its URL before the deploy", () => {
    // og:url is baked at build time, so a host that cannot say where it will
    // be would ship social cards pointing somewhere else.
    //
    // The subdomain comes from CF_WORKERS_SUBDOMAIN, which the suite supplies
    // as a deliberately-implausible placeholder — asserting on the SHAPE keeps
    // this from becoming a test of the placeholder.
    const url = host.urlFor("demo-x");
    expect(url).toMatch(/^https:\/\/demo-x\.[^/]+$/);
    expect(url).toContain(process.env.CF_WORKERS_SUBDOMAIN ?? "workers.dev");
  });
});

describe("VercelLandingHost", () => {
  const host = new VercelLandingHost();

  it("uses the stable project domain, not the per-deployment URL", () => {
    // A per-deployment URL changes on every push and would break a link
    // already sent to a customer.
    expect(host.urlFor("demo-x")).toBe("https://demo-x.vercel.app");
  });

  it("writes build-time config without clobbering an existing vercel.json", () => {
    const d = siteDir();
    writeFileSync(join(d, "vercel.json"), JSON.stringify({ framework: "vite", env: { KEEP: "1" } }));
    host.configure(d, CFG);
    const out = JSON.parse(readFileSync(join(d, "vercel.json"), "utf8"));
    expect(out.framework).toBe("vite");
    expect(out.env.KEEP).toBe("1");
    expect(out.env.DIVINCI_RELEASE_ID).toBe("rel-123");
    expect(out.env.FREE_MESSAGES_BEFORE_EMAIL).toBe("3");
  });

  it("carries the no-email-gate settings too", () => {
    const d = siteDir();
    host.configure(d, { ...CFG, chatGate: { noEmailGate: true, demoQuota: 40, freeBeforeEmail: 0 } });
    const out = JSON.parse(readFileSync(join(d, "vercel.json"), "utf8"));
    expect(out.env.NO_EMAIL_GATE).toBe("1");
    expect(out.env.DEMO_QUOTA_LIMIT).toBe("40");
  });

  it("scopes to a team only when one is configured", () => {
    expect(vercelScopeArgs({})).toEqual([]);
    expect(vercelScopeArgs({ VERCEL_ORG_ID: "team_x" })).toEqual(["--scope", "team_x"]);
  });
});

describe("a landing page is not a static site", () => {
  // LANDING_PAGE_HMAC_KEY is read at REQUEST time to sign anonymous-chat calls.
  // Paired with release.requireSignedAnonymousChat it is what stops anyone who
  // extracts the public release id from bypassing the per-email quota.
  //
  // A host that cannot run code per request therefore cannot serve a landing
  // page — and the failure is invisible at deploy time and total at use time:
  // the page loads, looks perfect, and every message is refused.
  it("refuses to deploy to Vercel when the template cannot sign", async () => {
    const d = siteDir();
    const r = vercelSigningReadiness(d);
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/LANDING_PAGE_HMAC_KEY/);
    expect(r.reason).toMatch(/requireSignedAnonymousChat/);
    expect(r.reason, "must say what to do, not just what is wrong")
      .toMatch(/middleware\.ts/);

    await expect(new VercelLandingHost().deploy(d, CFG)).rejects.toThrow(/cannot hold/);
  });

  it("accepts a template whose middleware reads the signing key", () => {
    const d = siteDir();
    writeFileSync(join(d, "middleware.ts"), "const k = process.env.LANDING_PAGE_HMAC_KEY;");
    expect(vercelSigningReadiness(d).ready).toBe(true);
  });

  it("accepts middleware under src/ or an api route", () => {
    const a = siteDir();
    mkdirSync(join(a, "src"));
    writeFileSync(join(a, "src", "middleware.ts"), "LANDING_PAGE_HMAC_KEY");
    expect(vercelSigningReadiness(a).ready).toBe(true);

    const b = siteDir();
    mkdirSync(join(b, "api"));
    writeFileSync(join(b, "api", "chat.ts"), "LANDING_PAGE_HMAC_KEY");
    expect(vercelSigningReadiness(b).ready).toBe(true);
  });

  it("REFUSES a middleware that exists but does not sign", () => {
    // A file check alone is satisfied by a middleware added for redirects or
    // analytics — and that would deploy a page whose every chat message is
    // refused, which is the exact failure this guard exists to prevent.
    const d = siteDir();
    writeFileSync(join(d, "middleware.ts"), "export default () => Response.redirect('/');");
    const r = vercelSigningReadiness(d);
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/never reads LANDING_PAGE_HMAC_KEY/);
    expect(r.reason, "must point at the fix").toMatch(/VERCEL\.md/);
  });

  it("the override exists and is named for what it means", () => {
    // Only meaningful for a demo whose release does NOT require signed chat.
    const r = vercelSigningReadiness(siteDir());
    expect(r.reason).toMatch(/LANDING_ALLOW_UNSIGNED=1/);
  });
});
