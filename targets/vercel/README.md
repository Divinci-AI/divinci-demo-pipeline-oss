# Target: Vercel — the demo's landing page

> **Status: BUILT on both sides.** The orchestrator deploys a finished demo's
> landing page to Vercel, provisions its secrets and tears it down
> ([`landing-host.ts`](../../orchestrator/src/landing-host.ts)), and the landing
> template ships the Edge Middleware that signs chat calls at request time
> ([`middleware.ts`](https://github.com/Divinci-AI/divinci-landing-template/blob/main/middleware.ts)
> + [`VERCEL.md`](https://github.com/Divinci-AI/divinci-landing-template/blob/main/VERCEL.md)).
>
> The pipeline itself does **not** run on Vercel and should not; that half of
> this page is unchanged.

```sh
LANDING_HOST=vercel VERCEL_TOKEN=... npm run demo -- --prospect acme --run 2026-08-19-001
```

| variable | |
|---|---|
| `LANDING_HOST` | `cloudflare` (default) or `vercel` |
| `VERCEL_TOKEN` | required for the Vercel host |
| `VERCEL_ORG_ID` | optional — deploy into a team rather than a personal account |
| `LANDING_ALLOW_UNSIGNED` | deploy without signing. Read the next section first. |

The Vercel project also needs **Vercel KV** and the landing variables — see
`VERCEL.md` in the template. The middleware fails closed without either, rather
than serving a page that looks right and refuses every message.

## ⚠️ Why it refuses

`LANDING_PAGE_HMAC_KEY` is a secret the deployed site reads **at request time**
to sign its anonymous-chat calls. Paired with
`release.requireSignedAnonymousChat = true` — which the landing stage sets — it
is what stops anyone who extracts the public release id from calling the chat
API directly and bypassing the per-email quota. It is a security control.

On Cloudflare the Worker does that signing. On Vercel it is Edge Middleware,
and
[`divinci-landing-template`](https://github.com/Divinci-AI/divinci-landing-template)
now ships one — it **delegates to the same handlers** the Worker uses rather
than reimplementing them, so the two hosts cannot drift. Its signature is pinned
against a golden vector produced by the *server's own signer*, not by the
template's code.

So `VercelLandingHost.deploy` checks for `middleware.ts` (or `src/middleware.ts`,
or an `api/` route) **and that it actually reads `LANDING_PAGE_HMAC_KEY`** — a
middleware added for redirects or analytics would satisfy a file check and still
deploy a page whose every chat message is refused. The alternative is worse than
an error: the page would look perfect and fail totally, with nothing at deploy
time to indicate it.

`LANDING_ALLOW_UNSIGNED=1` overrides the check. It is only meaningful for a demo
whose release does **not** require signed chat.

**What remains** is operational, not structural: neither side has been run
against a real Vercel project or Upstash instance. The KV layer is exercised
against an in-memory Redis with the exact `SET…NX` / `INCR` semantics it depends
on, and the signature against the server's own signer — so the first real deploy
is the test of the plumbing, not of the logic.

## The seam

`LandingHost` is six functions, and that is the entire surface a new host
implements:

```ts
interface LandingHost {
  readonly name: string;
  urlFor(slug): string;                          // BEFORE deploy — og:url is baked in
  configure(siteDir, cfg): void;                 // write the host's config file
  deploy(siteDir, cfg): Promise<{ url: string }>;
  setSecret(siteDir, slug, name, value): Promise<void>;
  clearSecret(siteDir, slug, name): Promise<void>;
  destroy(siteDir, slug): Promise<void>;         // demos expire; no zombie hosting
}
```

Three of those are less obvious than they look:

- **`urlFor` comes first.** The page bakes its own `og:url` and social cards at
  build time, so a host that cannot predict its own URL ships cards pointing
  somewhere else. Vercel therefore uses the stable `<project>.vercel.app`
  domain, never the per-deployment URL — that one changes on every push and
  would break a link already sent to a customer.
- **`setSecret` is not optional**, per the section above.
- **`clearSecret` must treat "was not set" as success.** It is indistinguishable
  from a failed delete on every host, and the caller clears the preview gate on
  *every* deploy precisely so a demo unlocked once cannot come back locked.

Adding Netlify, S3+CloudFront or GitHub Pages is now implementing that interface
— though the first three of those cannot hold a request-time secret either, so
they hit exactly the same wall.

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

## If you want the whole pipeline serverless anyway

Use [Cloudflare](../cloudflare) for crawl-and-index, and run the orchestrator on
[GCP](../gcp) or locally. That combination has no server to manage either, and
every piece of it is running today.
