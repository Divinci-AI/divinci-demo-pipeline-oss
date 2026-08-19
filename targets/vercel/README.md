# Target: Vercel — designed, and mostly a warning

> **Status: DESIGN ONLY, and the honest recommendation is "not this".** There is
> no code in this directory. This file exists because Vercel is a reasonable
> thing to ask for and deserves a real answer rather than silence — and the real
> answer is that only a small piece of the pipeline fits.

## What does not fit, and why

Vercel Functions are serverless HTTP handlers. The orchestrator is a
long-running stateful process. The mismatch is not stylistic:

| the pipeline needs | Vercel gives |
|---|---|
| ticks lasting **minutes**, sometimes tens of them | max duration **800s** on Pro, 300s on Hobby |
| a **POSIX filesystem** that survives between ticks | ephemeral `/tmp`, per-invocation |
| to **shell out** to the `divinci` CLI and `git` | no arbitrary subprocesses in the standard runtime |
| **exactly one writer** | a platform that scales out by design |
| outbound crawling for minutes | function egress metered against the same wall clock |

Three of those five are hard platform limits with no configuration that lifts
them. Cron Jobs do not change this: a Vercel cron invokes a function, so it
inherits every constraint above.

**Anyone reaching for Vercel here should use [the Cloudflare target](../cloudflare)
instead.** It is the same "no server to run" shape, and it fits because Workflows
are built for durable multi-step work, `waitUntil` outlives the response, and
Browser Rendering does the crawling — none of which has a Vercel equivalent.

## What DOES fit: the demo's front door

There is a real and useful Vercel target, and it is not the pipeline. It is the
**landing page each finished demo produces**.

```
   orchestrator (laptop / GCP / AWS / anywhere)
        │  landing step produces runs/<prospect>/<run>/landing/
        ▼
   Vercel  ──►  a project per prospect, or one project with a path per prospect
```

### ⚠️ It is NOT a static site, and an earlier version of this page said it was

The obvious plan — build the site, push it to Vercel as static assets, done — is
wrong, and worth correcting explicitly because it is the plan anyone would
reach for.

`buildAndDeployLanding` in `orchestrator/src/landing.ts` deploys a **Cloudflare
Worker with secrets**, not a bucket of files:

| secret | what it does |
|---|---|
| `LANDING_PAGE_HMAC_KEY` | the worker **signs** the landing page's anonymous-chat calls |
| `BASIC_AUTH_PASSWORD` / `_USERNAME` | optional preview gate, off by default |

The HMAC key is the load-bearing one. Paired with
`release.requireSignedAnonymousChat = true` — which the landing stage sets — it
is what stops anyone who extracts the public release id from calling the chat
API directly and bypassing the per-email quota. **It is a security control, not
a nicety**, and it needs a secret held server-side at request time.

So a Vercel port needs **Edge Middleware or a Function** holding that key and
signing, exactly as the Worker does. That is a good fit for Vercel — it is what
Edge Middleware is for — but it is a different piece of work from a static
deploy, and it means the seam has to cover secret provisioning.

(The basic-auth gate is optional and defaults to OFF. Read the comment above it
in `landing.ts` before turning it on: it was on by default until 2026-08-14 and
cost a deal — a prospect hit a password prompt during a scheduled call and could
not show the demo to her manager.)

## What building it would involve

The coupling lives in `orchestrator/src/landing.ts`, which assumes Cloudflare
Workers + KV and reads `CF_WORKERS_SUBDOMAIN` and `LANDING_KV_NAMESPACE_ID`.
Making the destination pluggable — the way `review-board.ts` made the human-gate
board pluggable — is the actual work, and it benefits every target rather than
only this one.

The seam, revised for what the landing page really is:

```ts
interface LandingHost {
  /** Build output → a live URL. */
  deploy(siteDir: string, slug: string): Promise<{ url: string }>;

  /**
   * Provision a secret the deployed site reads AT REQUEST TIME.
   * Not optional: LANDING_PAGE_HMAC_KEY is what makes
   * requireSignedAnonymousChat meaningful, and a host that cannot hold a
   * secret cannot serve a signed landing page at all.
   */
  setSecret(slug: string, name: string, value: string): Promise<void>;
  clearSecret(slug: string, name: string): Promise<void>;

  /** Demos expire; no zombie hosting. */
  destroy(slug: string): Promise<void>;
}
```

`destroy` is not optional either. Demo workspaces are torn down on expiry to cap
standing spend and create honest urgency, and a landing host with no teardown
leaves a live page pointing at a workspace that no longer exists.

A Vercel implementation would be: `deploy` → the Vercel REST API or `vercel
deploy --prebuilt`; `setSecret` → project environment variables; `destroy` →
delete the project. The signing logic itself moves into a middleware file in the
landing template, which is the part that has to be written once and shared by
both hosts.

**Nobody has built this.** The interface above is a design, not an extraction —
`landing.ts` is 1,896 lines and `buildAndDeployLanding` is ~250 of them, so
pulling the seam out is a real refactor that should be done together with the
first non-Cloudflare implementation, not speculatively ahead of it.

## If you want the whole pipeline serverless anyway

Use [Cloudflare](../cloudflare) for crawl-and-index, and run the orchestrator on
[GCP](../gcp) or locally. That combination has no server to manage either, and
every piece of it is running today.
