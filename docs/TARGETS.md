# Deployment targets

The pipeline was extracted from something that ran on one laptop under
`launchd`. That still works and is still the shortest path to a demo — but it is
one deployment shape, and it is ours. These targets are the others.

They are not alternatives to each other so much as **different amounts of the
pipeline**. Read the second column first.

| target | what runs there | status |
|---|---|---|
| **laptop** (default) | everything: intake → gates → crawl → QA → landing → outreach | works; see [`docs/LOOP.md`](LOOP.md) |
| [**local**](../targets/local) | crawl + chunk + embed **on your machine**, sync vectors up | **built, tested** |
| [**cloudflare**](../targets/cloudflare) | crawl + chunk + embed + publish, entirely on the edge | **built, tested** |
| [**gcp**](../targets/gcp) | the whole orchestrator, on a schedule, with durable state | **built**, unverified against a live project |
| [**aws**](../targets/aws) | same as GCP, on Fargate + EFS | **built**, unverified against a live account |
| [**vercel**](../targets/vercel) | the demo's landing page, not the pipeline | **design only**, and it explains why |

## Choosing

**Just want to see it work?** Stay on the laptop. `npm run smoke` needs no
credentials at all.

**Want a corpus without paying for embeddings, or without sending the text
anywhere?** → [local](../targets/local). Ollama does the embedding, and only
768-float vectors leave the machine. It cannot render JavaScript.

**Want to index a lot of sites, unattended, cheaply?** →
[cloudflare](../targets/cloudflare). Browser Rendering crawls (~$0.0007/host),
Workers AI embeds, a cron tops the fleet up every two minutes and nothing has to
stay awake. This is also how you contribute to the
[Open Web Vectors Initiative](https://divinci.ai/open-web-vectors/).

**Want the *whole* pipeline unattended — gates, QA, landing, outreach drafts?**
→ [gcp](../targets/gcp). It is the orchestrator you already run, in a Cloud Run
Job, with `runs/` on GCS.

**On AWS?** → [aws](../targets/aws). Fargate + EventBridge + EFS, and EFS gives
the orchestrator's run lock *real* semantics — exclusive create is atomic on
NFSv4 — which is more than the GCS mount can offer. It is the strongest of the
hosted targets on correctness, at the cost of a VPC and a security group.

**On Vercel?** [Read that one before you start.](../targets/vercel) Three of the
platform's hard limits are individually disqualifying for the orchestrator. The
part that *does* fit is hosting each finished demo's landing page.

## The two axes

It helps to see that "deployment target" means two separable things here, and
most of these targets only move one of them.

**Where the loop ticks** — laptop `launchd`, a Cloud Run Job, a Fargate task.
This is a scheduling and state-durability question, and its hard part is that
all loop state is files under `runs/`.

**Where crawl and embed happen** — the hosted Divinci crawl, your own machine
via Ollama, or Cloudflare Browser Rendering + Workers AI. This is a cost,
privacy and JS-rendering question.

The local and Cloudflare targets move only the second axis. GCP and AWS move
only the first. Nothing stops you combining them: run the orchestrator on GCP
and point crawls at a Cloudflare deployment you own.

## What every target shares

- **Nothing that names infrastructure has a default.** A default that is merely
  wrong fails on the first call; a default naming a real resource that belongs
  to somebody else *succeeds*, and you get no signal. See
  [`orchestrator/src/require-env.ts`](../orchestrator/src/require-env.ts) and
  the Worker's [`require-env.js`](../targets/cloudflare/src/require-env.js).
- **One container image.** [`targets/container`](../targets/container) is shared
  by the GCP and AWS targets — one Dockerfile and one entrypoint, so the two
  platforms cannot drift into behaving differently.
- **The same chunker.** `targets/local` imports
  [`chunk.js`](../targets/cloudflare/src/chunk.js) from the Cloudflare target
  rather than copying it, so a corpus built half locally and half on the edge
  has one chunking, not two.
- **The same embedding space, verified.** Ollama's `embeddinggemma` is what
  Cloudflare serves as `@cf/google/embeddinggemma-300m`, 768-d. The same
  sentence through both gives **cosine 0.99998**, both unit-length. That is
  worth measuring rather than assuming: vectors from different embedding models
  are not comparable even at identical dimensionality, and mixing them does not
  error — it returns wrong neighbours, quietly and forever.
- **Tests that need no account.** Every target's suite runs with no network, no
  credentials and no cloud provider.

## Contributing a target

The gap worth closing first is not another cloud. It is the **landing-page
host**: `orchestrator/src/landing.ts` assumes Cloudflare Workers + KV, and
making that pluggable — the way `review-board.ts` made the human gates
pluggable — would unblock Vercel, Netlify, S3, Pages and GitHub Pages at once.
The [Vercel design](../targets/vercel/README.md) sketches the interface.

For a new compute target, three things will bite you, and all three are written
down rather than left to be rediscovered:

1. **State durability.** All loop state is files under `runs/`. A container
   filesystem is discarded, so a target without a real volume restarts from zero
   every tick and re-spends the budget while reporting success.
   ([gcp](../targets/gcp/README.md#the-one-thing-that-makes-this-non-trivial))
2. **Single-writer.** Two processes on one run directory overwrite each other's
   `state.json`. How you enforce it differs per platform — a task timeout under
   the schedule interval on Cloud Run, the run lock itself on EFS.
   ([gcp](../targets/gcp/README.md#-single-writer-comes-from-the-timeout-not-from---parallelism))
3. **A pid is only meaningful on the host that wrote it.** The run lock records
   a pid, and pids are namespaced per container — so a task killed mid-tick
   leaves a lock naming a pid the *next* container may well also have. Read
   naively, the new task sees its own unrelated process as the holder and
   refuses **forever**, reporting success on every tick. `run-lock.ts` therefore
   consults pid liveness only within one host and falls back to age across
   hosts (`RUN_LOCK_MAX_AGE_MS`). Any new container target must set that, and
   [`targets/container`](../targets/container) does it for you.
