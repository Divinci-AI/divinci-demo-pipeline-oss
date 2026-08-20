# Target: GCP — the orchestrator on a schedule, with durable state

Runs the **full pipeline** (the thing `npm run loop` does on a laptop) as a
Cloud Run Job fired by Cloud Scheduler, with run state on GCS so it survives
between ticks.

```
Cloud Scheduler ──POST──► Cloud Run Job ──► one loop tick
   0 * * * *                  │
                              ├── GCS bucket  mounted at /app/runs   ← the state
                              ├── Secret Manager → DIVINCI_TOKEN
                              └── divinci CLI → api.divinci.app
```

This is the target to pick when you want the **whole** pipeline unattended —
intake, gates, crawl, QA, landing, outreach drafts — rather than just the crawl.
For crawl-and-index only, [the Cloudflare target](../cloudflare) is far cheaper.

## The one thing that makes this non-trivial

**All loop state is files under `runs/`** — each run's `state.json`, the attempt
counters, the failure ledger, the discovery cache. A container filesystem is
discarded when the execution ends.

So a job running on the image's own `/app/runs` would start from nothing every
tick: re-run gate 1 on prospects already past it, re-crawl sites already
crawled, and re-spend the budget each time — **reporting success every run**.
Nothing outside would show it.

`entrypoint.sh` therefore refuses to start unless `/app/runs` is a real mount
(`ALLOW_EPHEMERAL_STATE=1` for a deliberate one-shot). That is a hard refusal
rather than a warning because the failure is invisible from the outside.

### ⚠️ Single-writer comes from the TIMEOUT, not from `--parallelism`

Two orchestrator processes on one run directory overwrite each other's
`state.json` — that is how a finished run was once rewritten back to an earlier
step. So exactly one tick may be running at a time.

**`--tasks=1 --parallelism=1` does not achieve that.** Those bound concurrency
*within* one execution. Cloud Run Jobs will happily start a second **execution**
while the first is still running, and Cloud Scheduler fires on the clock without
looking at whether the last tick finished.

What actually prevents the overlap is **`TASK_TIMEOUT` being shorter than the
schedule interval**, so a slow tick is killed before the next one starts. The
defaults are 3000s against an hourly schedule, and `deploy.sh` **refuses to
deploy** if you shorten `SCHEDULE` without shortening `TASK_TIMEOUT` — the
relationship is enforced rather than left as advice.

The image is [`targets/container`](../container), shared with the AWS target.

The orchestrator's own lock is a real backstop, better than first assumed:
`openSync(path, "wx")` becomes a GCS create with `ifGenerationMatch=0`, which is
atomic at the storage layer. But GCS FUSE caches metadata, so a stale negative
lookup can still let two clients through, and `flock` is not supported at all.
Treat the lock as defence in depth and the timeout as the control.

⚠️ **And the lock had to be taught about containers.** It recorded a pid and
asked whether that pid was alive — correct on one laptop, meaningless across
containers, where pids are namespaced. A task killed mid-tick left a lock naming
a pid the next container was quite likely to have too, so the new task read its
own unrelated process as the holder and refused, permanently, while reporting
success every tick. `run-lock.ts` now trusts pid liveness only within one host
and falls back to age across hosts; `targets/container` sets
`RUN_LOCK_MAX_AGE_MS=7200000`. Keep that comfortably above your longest tick.

## Deploy

```sh
export GCP_PROJECT=your-project
export GCS_STATE_BUCKET=your-pipeline-state

# From a machine where you have logged in (`divinci auth login`), store the
# WHOLE credentials file — not just the access token. The refresh token is what
# lets an unattended loop keep working, and the container persists the rotated
# one back onto the bucket.
gcloud secrets create DIVINCI_CREDENTIALS_JSON \
  --data-file="$HOME/.config/divinci/credentials.json" --project "$GCP_PROJECT"

cd targets/gcp
./deploy.sh                 # plan — creates nothing
./deploy.sh --go            # apply
./deploy.sh --go --run-now  # …and run one tick, waiting for it
```

| variable | default |
|---|---|
| `GCP_PROJECT` | **required** |
| `GCS_STATE_BUCKET` | **required** |
| `GCP_REGION` | `us-central1` |
| `JOB_NAME` | `divinci-demo-pipeline` |
| `SCHEDULE` | `0 * * * *` |
| `SECRETS` | `DIVINCI_CREDENTIALS_JSON` |
| `CPU` / `MEMORY` | `2` / `4Gi` |
| `DIVINCI_CLI_VERSION` | build arg, `latest` — **pin it** |

The two required variables have no defaults, for the same reason nothing else in
this repository does: a default naming real infrastructure succeeds against
somebody else's project rather than failing.

Add the orchestrator's own configuration (`CF_WORKERS_SUBDOMAIN`,
`LANDING_KV_NAMESPACE_ID`, `DEMO_ASSETS_R2_BUCKET`, `DEMO_ASSETS_R2_BASE`,
`VERTEX_PROJECT`) with `--set-env-vars`, or extend `SECRETS`. See the root
README's configuration table.

### The prospect queue

`research/prospect-queue.yaml` is gitignored, so the image ships with only the
example. **A freshly deployed job therefore has an empty queue and will do
nothing** — correctly, but silently. Either bake your queue into the image, or
put it on the GCS volume and point `intake` at it.

### `RUNS_DIR` is for the entrypoint, not the orchestrator

`entrypoint.sh` reads it to check the mount. The orchestrator does **not** — it
computes `runs/` from its own location (`/app/orchestrator/src` → `/app/runs`),
which is why the Dockerfile puts the app at `/app` and the volume at
`/app/runs`. Changing the mount path alone would not move the orchestrator's
state; it would only move what the check looks at.

## Watching it

```sh
gcloud run jobs executions list --job divinci-demo-pipeline --region us-central1
gcloud run jobs executions logs read <execution> --region us-central1

# the state itself is just files
gcloud storage ls "gs://$GCS_STATE_BUCKET/**/state.json"
```

**Exit code 30 means the session cannot be renewed** and a human must log in
again and refresh the secret. `entrypoint.sh` calls that out separately because
Cloud Run retries a failed execution, and retrying a revoked refresh token only
burns retries.

## Authentication is the weak point of every hosted target

The pipeline authenticates as a **user** via the CLI's OAuth session, which is
excellent on a laptop — it renews itself indefinitely — and awkward in a job,
because the refresh token has to be captured out of a login that happened
somewhere else, and rotated by hand when it is revoked.

There is no service-account equivalent today: workspace creation is an
account-level operation that only the OAuth session can perform, and
`DIVINCI_API_KEY` is explicitly *not* a substitute (the CLI prefers it over
OAuth, which breaks `divinci workspace create`).

So: this target is honest about running on a captured user session. Budget for
re-minting `DIVINCI_TOKEN` when it expires, and watch for exit code 30.

## Cost

A tick is minutes of 2 vCPU, so the compute is close to free; the spend that
matters is crawling and model calls, which are billed by Divinci and Cloudflare
regardless of where the orchestrator runs. Cloud Scheduler is free at this
volume. GCS holds text files.

The reason to run this on GCP is **durability and unattendedness**, not cost.

## Not included

**No Terraform.** This is `gcloud` calls in a script you can read end to end,
because that is what the rest of the repository is. If you manage
infrastructure as code, `deploy.sh` is a readable specification of the six
resources involved.

**Not verified against a live project.** The script is written against the
documented `gcloud` surface and its plan mode is exercised, but the applied path
has not been run on a real GCP account by the authors. Treat the first
`--go` as the real test, and please report what breaks.

## Verified on a real project (2026-08-20)

Deployed to a live GCP project and executed. What was confirmed end to end:

| | |
|---|---|
| Cloud Build → Artifact Registry | ✅ 1m26s |
| Job created, Scheduler created | ✅ |
| **GCS FUSE mount persists state** | ✅ the container's writes under `/app/state` are in the bucket after the execution ends |
| `HOME` inside the mount | ✅ `home/.config/divinci/` and `home/.npm/` land in the bucket, so a rotated refresh token survives the tick |
| Loop halts cleanly with no credential | ✅ exits 20 with `auth: FAILED — no credential file … run divinci auth login` |

⏱️ **An execution takes 2-3 minutes to START.** Cloud Run reports
`ResourcesAvailable: True`, `ContainerReady: True`, `Started: Unknown`,
`Waiting for execution to start.` for that whole window, and emits **no
container logs at all** — the volume attach happens before your process does.

That is normal. It reads exactly like a hung mount, and during this
verification it was misread as one; the execution completed normally minutes
later. Do not start debugging IAM on the strength of it. Wait for the
`Completed` condition to become `True` or `False` before concluding anything.
