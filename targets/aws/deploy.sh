#!/usr/bin/env bash
# Deploy the orchestrator as a scheduled ECS Fargate task.
#
#   ./deploy.sh                 # plan — creates nothing
#   ./deploy.sh --go            # build, push, and deploy the stack
#   ./deploy.sh --go --run-now  # …and run one tick immediately
#
# Everything naming infrastructure is read from the environment with NO default.
# A default here does not fail loudly when it is wrong; it succeeds against
# somebody else's account.
set -euo pipefail
cd "$(dirname "$0")/../.."      # repo root: the Docker build context

: "${AWS_REGION:?set AWS_REGION, e.g. us-east-1}"
: "${DIVINCI_CREDENTIALS_SECRET_ARN:?set DIVINCI_CREDENTIALS_SECRET_ARN to the Secrets Manager ARN holding the WHOLE credentials.json}"

STACK="${STACK_NAME:-divinci-demo-pipeline}"
REPO="${ECR_REPO:-divinci-demo-pipeline}"
SCHEDULE="${SCHEDULE:-rate(1 hour)}"
TAG="${IMAGE_TAG:-latest}"

GO=0; RUN_NOW=0
for a in "$@"; do
  case "$a" in
    --go) GO=1 ;;
    --run-now) RUN_NOW=1 ;;
    *) echo "unknown flag: $a" >&2; exit 2 ;;
  esac
done

command -v aws >/dev/null || { echo "❌ the aws CLI is required" >&2; exit 127; }

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
IMAGE="${ACCOUNT}.dkr.ecr.${AWS_REGION}.amazonaws.com/${REPO}:${TAG}"

# ── Networking: discover, do not invent ─────────────────────────────────────
#
# The template takes a VPC and subnets rather than creating them, so this runs
# in whatever network you already have. Defaults come from the default VPC when
# there is one; override VPC_ID / SUBNET_IDS if not.
if [ -z "${VPC_ID:-}" ]; then
  VPC_ID="$(aws ec2 describe-vpcs --region "$AWS_REGION" \
    --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text 2>/dev/null || echo None)"
fi
[ "$VPC_ID" = "None" ] || [ -z "$VPC_ID" ] && {
  echo "❌ no default VPC in $AWS_REGION — set VPC_ID and SUBNET_IDS explicitly." >&2; exit 2; }

if [ -z "${SUBNET_IDS:-}" ]; then
  # Two subnets in DIFFERENT availability zones: EFS wants a mount target per
  # AZ, and two mount targets in one AZ is an error rather than redundancy.
  SUBNET_IDS="$(aws ec2 describe-subnets --region "$AWS_REGION" \
    --filters "Name=vpc-id,Values=$VPC_ID" "Name=default-for-az,Values=true" \
    --query 'Subnets[:2].SubnetId' --output text | tr '\t' ',')"
fi
[ "$(echo "$SUBNET_IDS" | tr ',' '\n' | grep -c .)" -ge 2 ] || {
  echo "❌ need at least two subnets in different AZs; got: ${SUBNET_IDS:-none}" >&2; exit 2; }

cat <<PLAN
region          $AWS_REGION
account         $ACCOUNT
stack           $STACK
image           $IMAGE
vpc             $VPC_ID
subnets         $SUBNET_IDS
schedule        $SCHEDULE
session secret  $DIVINCI_CREDENTIALS_SECRET_ARN
state           EFS, mounted at /app/runs

PLAN

# Validate offline before touching the account — this is the check that does not
# need credentials and catches the template mistakes that cost a deploy.
python3 targets/aws/test/validate-template.py

if [ "$GO" -ne 1 ]; then
  echo
  echo "(plan only — pass --go to apply)"
  exit 0
fi

run() { echo "+ $*"; "$@"; }

# ── image ───────────────────────────────────────────────────────────────────
aws ecr describe-repositories --repository-names "$REPO" --region "$AWS_REGION" >/dev/null 2>&1 \
  || run aws ecr create-repository --repository-name "$REPO" --region "$AWS_REGION" >/dev/null

aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "${ACCOUNT}.dkr.ecr.${AWS_REGION}.amazonaws.com"

# --platform is not optional on an Apple-silicon laptop: Fargate is amd64, and
# an arm64 image fails at task start with an exec-format error several minutes
# after a build that looked fine.
run docker build --platform linux/amd64 -f targets/container/Dockerfile -t "$IMAGE" .
run docker push "$IMAGE"

# ── stack ───────────────────────────────────────────────────────────────────
run aws cloudformation deploy \
  --region "$AWS_REGION" \
  --stack-name "$STACK" \
  --template-file targets/aws/cloudformation.yml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
      "ImageUri=$IMAGE" \
      "VpcId=$VPC_ID" \
      "SubnetIds=$SUBNET_IDS" \
      "ScheduleExpression=$SCHEDULE" \
      "DivinciCredentialsSecretArn=$DIVINCI_CREDENTIALS_SECRET_ARN" \
      "RunLockMaxAgeMs=${RUN_LOCK_MAX_AGE_MS:-7200000}"

echo
echo "✅ deployed."
aws cloudformation describe-stacks --region "$AWS_REGION" --stack-name "$STACK" \
  --query 'Stacks[0].Outputs' --output table

if [ "$RUN_NOW" -eq 1 ]; then
  TD="$(aws cloudformation describe-stacks --region "$AWS_REGION" --stack-name "$STACK" \
        --query "Stacks[0].Outputs[?OutputKey=='TaskDefinitionArn'].OutputValue" --output text)"
  SG="$(aws cloudformation describe-stack-resource --region "$AWS_REGION" --stack-name "$STACK" \
        --logical-resource-id TaskSecurityGroup --query 'StackResourceDetail.PhysicalResourceId' --output text)"
  run aws ecs run-task --region "$AWS_REGION" --cluster "$STACK" --task-definition "$TD" \
    --launch-type FARGATE \
    --network-configuration "awsvpcConfiguration={subnets=[${SUBNET_IDS}],securityGroups=[${SG}],assignPublicIp=ENABLED}"
  echo "   logs: aws logs tail /ecs/$STACK --follow --region $AWS_REGION"
fi
