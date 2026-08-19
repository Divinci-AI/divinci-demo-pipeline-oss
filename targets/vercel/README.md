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

The pipeline's `landing` step already generates a static site per prospect and
today deploys it to a Cloudflare Worker backed by KV. That artifact is an
ordinary static build, and Vercel is genuinely good at those:

```
   orchestrator (laptop / GCP / anywhere)
        │  landing step produces runs/<prospect>/<run>/landing/
        ▼
   Vercel deploy hook  ──►  a project per prospect, or one project with
                            a path per prospect
```

| need | service |
|---|---|
| host the generated landing page | Vercel static deployment |
| trigger a deploy when a run finishes | Deploy Hook (a URL the orchestrator POSTs) |
| per-prospect isolation | one project per prospect, or path-based routing |
| the demo chat itself | unchanged — the embed talks to `api.divinci.app` |

This needs no new long-running compute anywhere, because the chat is already a
hosted API call from the visitor's browser.

## What building that would involve

The coupling to replace lives in `orchestrator/src/landing.ts`, which currently
assumes Cloudflare Workers + KV and reads `CF_WORKERS_SUBDOMAIN` and
`LANDING_KV_NAMESPACE_ID`. Making the landing destination pluggable — the same
way `review-board.ts` made the human-gate board pluggable — is the actual piece
of work, and it would benefit every target rather than only this one.

A reasonable seam, mirroring the review-board one:

```ts
interface LandingHost {
  deploy(runDir: string, slug: string): Promise<{ url: string }>;
  destroy(slug: string): Promise<void>;      // demos expire; no zombie hosting
}
```

`destroy` is not optional. Demo workspaces are torn down on expiry to cap
standing spend and create honest urgency, and a landing host with no teardown
leaves a live page pointing at a workspace that no longer exists.

## If you want the whole pipeline serverless anyway

Use [Cloudflare](../cloudflare) for crawl-and-index, and run the orchestrator on
[GCP](../gcp) or locally. That combination has no server to manage either, and
every piece of it is running today.
