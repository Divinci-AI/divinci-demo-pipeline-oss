#!/usr/bin/env bash
# Deploy the orchestrator as a Cloud Run Job on a schedule.
#
#   ./deploy.sh                 # show the plan, change nothing
#   ./deploy.sh --go            # create/update everything
#   ./deploy.sh --go --run-now  # …and trigger one execution
#
# Everything is read from the environment with NO default for anything that
# names infrastructure. A default here does not fail loudly when it is wrong —
# it succeeds against somebody else's project.
set -euo pipefail
cd "$(dirname "$0")/../.."      # repo root: the Docker build context

: "${GCP_PROJECT:?set GCP_PROJECT to your Google Cloud project id}"
: "${GCS_STATE_BUCKET:?set GCS_STATE_BUCKET to the bucket that will hold runs/ state}"

REGION="${GCP_REGION:-us-central1}"
JOB="${JOB_NAME:-divinci-demo-pipeline}"
REPO="${AR_REPO:-divinci-demo-pipeline}"
IMAGE="${REGION}-docker.pkg.dev/${GCP_PROJECT}/${REPO}/orchestrator:${IMAGE_TAG:-latest}"
SCHEDULE="${SCHEDULE:-0 * * * *}"
SA="${SERVICE_ACCOUNT:-${JOB}@${GCP_PROJECT}.iam.gserviceaccount.com}"

# Secrets the job reads from Secret Manager. Each must already exist.
# `${VAR-default}`, NOT `${VAR:-default}`: the colon form substitutes the default
# when the variable is EMPTY as well as unset, so `SECRETS=""` — the obvious way
# to say "no secrets, I am smoke-testing the infrastructure" — silently became
# DIVINCI_CREDENTIALS_JSON and the deploy died on a 404 for a secret the caller
# had just said they did not want. Found by doing exactly that.
SECRETS="${SECRETS-DIVINCI_CREDENTIALS_JSON}"

# ── the one relationship that must hold ─────────────────────────────────────
#
# A tick must not still be running when the next one starts: two orchestrator
# processes on one run directory overwrite each other's state.json, which is how
# a finished run was once rewritten back to an earlier step. Cloud Run does not
# enforce this for us (see the note by the job creation below), so the timeout
# has to be shorter than the interval.
TASK_TIMEOUT="${TASK_TIMEOUT:-3000s}"
timeout_secs="${TASK_TIMEOUT%s}"
# Only simple `M H * * *`-style intervals are checked; anything else is left to
# the operator rather than half-parsed.
interval_secs=""
case "$SCHEDULE" in
  "0 * * * *"|"*/60 * * * *") interval_secs=3600 ;;
  "*/"[0-9]*" * * * *") m="${SCHEDULE#*/}"; m="${m%% *}"; interval_secs=$(( m * 60 )) ;;
esac
if [ -n "$interval_secs" ] && [ "$timeout_secs" -ge "$interval_secs" ]; then
  echo "❌ TASK_TIMEOUT (${timeout_secs}s) must be LESS than the schedule interval (${interval_secs}s)." >&2
  echo "   Otherwise a slow tick is still running when the next fires, and two" >&2
  echo "   orchestrator processes on one run directory overwrite each other." >&2
  exit 2
fi

GO=0; RUN_NOW=0
for a in "$@"; do
  case "$a" in
    --go) GO=1 ;;
    --run-now) RUN_NOW=1 ;;
    *) echo "unknown flag: $a" >&2; exit 2 ;;
  esac
done

cat <<PLAN
project        $GCP_PROJECT
region         $REGION
job            $JOB
image          $IMAGE
state bucket   gs://$GCS_STATE_BUCKET  → mounted at /app/state
schedule       $SCHEDULE
task timeout   $TASK_TIMEOUT  (must be < the interval — see the note in this script)
service acct   $SA
secrets        $SECRETS

PLAN

if [ "$GO" -ne 1 ]; then
  echo "(plan only — pass --go to apply)"
  exit 0
fi

run() { echo "+ $*"; "$@"; }

# ── prerequisites ───────────────────────────────────────────────────────────
run gcloud services enable \
  run.googleapis.com cloudscheduler.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com cloudbuild.googleapis.com \
  --project "$GCP_PROJECT"

gcloud artifacts repositories describe "$REPO" --location "$REGION" --project "$GCP_PROJECT" >/dev/null 2>&1 \
  || run gcloud artifacts repositories create "$REPO" \
       --repository-format=docker --location "$REGION" --project "$GCP_PROJECT"

gcloud storage buckets describe "gs://$GCS_STATE_BUCKET" --project "$GCP_PROJECT" >/dev/null 2>&1 \
  || run gcloud storage buckets create "gs://$GCS_STATE_BUCKET" \
       --location "$REGION" --project "$GCP_PROJECT" --uniform-bucket-level-access

gcloud iam service-accounts describe "$SA" --project "$GCP_PROJECT" >/dev/null 2>&1 \
  || run gcloud iam service-accounts create "${JOB}" \
       --display-name "Divinci demo pipeline" --project "$GCP_PROJECT"

# The job needs to read/write its own state bucket and read its secrets. Grant
# on the BUCKET, not the project: a project-wide storage role would let this job
# read every bucket you own, which is not what running a demo pipeline requires.
run gcloud storage buckets add-iam-policy-binding "gs://$GCS_STATE_BUCKET" \
  --member "serviceAccount:$SA" --role roles/storage.objectAdmin --project "$GCP_PROJECT"

for s in $SECRETS; do
  run gcloud secrets add-iam-policy-binding "$s" \
    --member "serviceAccount:$SA" --role roles/secretmanager.secretAccessor --project "$GCP_PROJECT"
done

# ── build ───────────────────────────────────────────────────────────────────
# No --gcs-source-staging-dir: the Cloud Build service account would need write
# access to the state bucket, which is a second permission to grant for no gain,
# and it mixes build tarballs into the directory holding run state.
# The image definition is shared with targets/aws — see targets/container.
run gcloud builds submit --project "$GCP_PROJECT" \
  --config targets/container/cloudbuild.yaml \
  --substitutions "_IMAGE=$IMAGE" .

# ── the job ─────────────────────────────────────────────────────────────────
#
# --tasks=1 --parallelism=1 bounds concurrency WITHIN one execution.
#
# ⚠️ It does NOT stop two EXECUTIONS overlapping — Cloud Run Jobs will happily
# run a second execution while the first is still going, and Cloud Scheduler
# fires on the clock regardless of whether the last tick finished. So the thing
# that actually prevents two writers is TASK_TIMEOUT being shorter than the
# schedule interval: a tick is killed before the next one starts.
#
# The default pair below is 50 minutes against an hourly schedule. If you
# shorten SCHEDULE, shorten TASK_TIMEOUT with it — the check below enforces the
# relationship rather than trusting you to remember.
# `${a[@]+"${a[@]}"}` at the use site, not a bare `"${a[@]}"`: under `set -u`,
# bash 3.2 — which is what macOS ships, and what most contributors will run this
# with — treats an EMPTY array expansion as an unbound variable and aborts. With
# no secrets configured that killed the deploy AFTER a successful two-minute
# image build. bash 4.4+ does not reproduce it, so this survives any test run on
# a Linux CI box.
SECRET_ARGS=()
for s in $SECRETS; do SECRET_ARGS+=(--set-secrets "$s=$s:latest"); done

VERB=create
gcloud run jobs describe "$JOB" --region "$REGION" --project "$GCP_PROJECT" >/dev/null 2>&1 && VERB=update

run gcloud run jobs "$VERB" "$JOB" \
  --image "$IMAGE" \
  --region "$REGION" --project "$GCP_PROJECT" \
  --service-account "$SA" \
  --tasks 1 --parallelism 1 \
  --max-retries "${MAX_RETRIES:-0}" \
  --task-timeout "${TASK_TIMEOUT:-3000s}" \
  --cpu "${CPU:-2}" --memory "${MEMORY:-4Gi}" \
  --add-volume "name=state,type=cloud-storage,bucket=$GCS_STATE_BUCKET" \
  --add-volume-mount "volume=state,mount-path=/app/state" \
  --set-env-vars "STATE_DIR=/app/state,RUN_LOCK_MAX_AGE_MS=${RUN_LOCK_MAX_AGE_MS:-7200000}" \
  ${SECRET_ARGS[@]+"${SECRET_ARGS[@]}"}

# ── the schedule ────────────────────────────────────────────────────────────
#
# ⚠️ The scheduler authenticates AS $SA, so $SA must be allowed to invoke the
# job. Without this the schedule is created successfully, fires on time, and
# every fire 403s — a pipeline that looks deployed and never runs, with the
# failure visible only in the scheduler's own logs.
run gcloud run jobs add-iam-policy-binding "$JOB" \
  --member "serviceAccount:$SA" --role roles/run.invoker \
  --region "$REGION" --project "$GCP_PROJECT"

JOB_URI="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${GCP_PROJECT}/jobs/${JOB}:run"
SVERB=create
gcloud scheduler jobs describe "${JOB}-tick" --location "$REGION" --project "$GCP_PROJECT" >/dev/null 2>&1 && SVERB=update

run gcloud scheduler jobs "$SVERB" http "${JOB}-tick" \
  --location "$REGION" --project "$GCP_PROJECT" \
  --schedule "$SCHEDULE" \
  --uri "$JOB_URI" --http-method POST \
  --oauth-service-account-email "$SA"

echo
echo "✅ deployed."
echo "   logs:  gcloud run jobs executions list --job $JOB --region $REGION --project $GCP_PROJECT"

if [ "$RUN_NOW" -eq 1 ]; then
  run gcloud run jobs execute "$JOB" --region "$REGION" --project "$GCP_PROJECT" --wait
fi
