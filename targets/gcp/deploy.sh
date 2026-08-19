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
SECRETS="${SECRETS:-DIVINCI_TOKEN}"

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
state bucket   gs://$GCS_STATE_BUCKET  → mounted at /app/runs
schedule       $SCHEDULE
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
run gcloud builds submit --tag "$IMAGE" --project "$GCP_PROJECT" \
  --gcs-source-staging-dir "gs://$GCS_STATE_BUCKET/_build" .

# ── the job ─────────────────────────────────────────────────────────────────
#
# --parallelism=1 --tasks=1 is not a performance setting. The orchestrator's run
# lock is an O_EXCL file, and GCS FUSE does not guarantee that create is atomic
# across concurrent clients — so single-writer must be enforced HERE, by the job
# never running two tasks, rather than by the lock. See README.md.
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
  --task-timeout "${TASK_TIMEOUT:-3600s}" \
  --cpu "${CPU:-2}" --memory "${MEMORY:-4Gi}" \
  --add-volume "name=runs,type=cloud-storage,bucket=$GCS_STATE_BUCKET" \
  --add-volume-mount "volume=runs,mount-path=/app/runs" \
  --set-env-vars "RUNS_DIR=/app/runs" \
  "${SECRET_ARGS[@]}"

# ── the schedule ────────────────────────────────────────────────────────────
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
