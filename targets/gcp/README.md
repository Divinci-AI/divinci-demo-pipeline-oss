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

### ⚠️ Single-writer is enforced by the JOB, not by the lock

The orchestrator's run lock is an `O_EXCL` file create, which is atomic on a
local filesystem. **GCS FUSE does not guarantee that**, so two concurrent
executions could both believe they hold it — and two processes on one run
directory overwrite each other's `state.json`, which is how a finished run was
once rewritten back to an earlier step.

`deploy.sh` therefore sets `--tasks=1 --parallelism=1` and `--max-retries=0`.
Those are correctness settings, not performance tuning. If you raise them, you
have removed the only thing enforcing single-writer.

Keep the schedule comfortably longer than a tick takes. An hourly schedule
against ticks that run 20 minutes is fine; a 5-minute schedule is not.

## Deploy

```sh
export GCP_PROJECT=your-project
export GCS_STATE_BUCKET=your-pipeline-state

# mint a token from a machine where you have logged in:
#   divinci auth login
#   … then copy the accessToken out of ~/.config/divinci/credentials.json
gcloud secrets create DIVINCI_TOKEN --data-file=- --project "$GCP_PROJECT"

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
| `SECRETS` | `DIVINCI_TOKEN` |
| `CPU` / `MEMORY` | `2` / `4Gi` |
| `DIVINCI_CLI_VERSION` | build arg, `latest` — **pin it** |

The two required variables have no defaults, for the same reason nothing else in
this repository does: a default naming real infrastructure succeeds against
somebody else's project rather than failing.

Add the orchestrator's own configuration (`CF_WORKERS_SUBDOMAIN`,
`LANDING_KV_NAMESPACE_ID`, `DEMO_ASSETS_R2_BUCKET`, `DEMO_ASSETS_R2_BASE`,
`VERTEX_PROJECT`) with `--set-env-vars`, or extend `SECRETS`. See the root
README's configuration table.

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
