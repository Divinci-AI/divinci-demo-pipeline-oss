# Target: AWS — the orchestrator on Fargate, state on EFS

Runs the **full pipeline** as a scheduled ECS Fargate task, with `runs/` on EFS.
The AWS counterpart of [the GCP target](../gcp), and the better of the two on
the point that matters most.

```
EventBridge Scheduler ──RunTask──► Fargate task ──► one loop tick
     rate(1 hour)                       │
                                        ├── EFS access point → /app/runs   ← the state
                                        ├── Secrets Manager → DIVINCI_TOKEN
                                        └── divinci CLI → api.divinci.app
```

| need | service |
|---|---|
| run a container on a schedule | EventBridge Scheduler → ECS `RunTask` |
| the container | ECS Fargate, 2 vCPU / 4 GB |
| **run state** | **EFS**, via an access point at `/app/runs` |
| secrets | Secrets Manager, injected as env |
| image | ECR |
| logs | CloudWatch Logs |

The container image is [`targets/container`](../container), shared with the GCP
target — one image definition rather than two that drift.

## Why EFS, and why that makes this the strongest target

The orchestrator does ordinary filesystem work: `openSync(path, "wx")` for its
run lock, in-place `state.json` rewrites, directory listings. S3 is an object
store with none of those semantics, and mounting it does not supply them.

EFS is NFSv4, so **exclusive create is atomic** and the orchestrator's own run
lock genuinely works here. The GCS-mount target cannot say that — there,
single-writer has to be enforced by keeping the task timeout under the schedule
interval, because gcsfuse metadata caching can defeat the lock.

The cost is a VPC, subnets and a security group, so this target has more
infrastructure than the others. That is the trade: more setup, stronger
guarantee.

### ⚠️ Fargate has no task timeout

Unlike Cloud Run Jobs, ECS has nothing that kills a task at N seconds. So the
GCP target's "timeout < interval" control does not exist here, and the run lock
is doing the real work — which is fine, because on EFS it actually can.

Two things follow:

- **A wedged tick must be stopped by hand.** `aws ecs list-tasks --cluster
  divinci-demo-pipeline` then `stop-task`.
- **`RUN_LOCK_MAX_AGE_MS` is the backstop** (default 2h, set by the container).
  A lock written by a *different* container is assumed abandoned after that.
  Keep it comfortably above your longest tick — too short recreates the
  two-writer corruption the lock exists to prevent.

That cross-host rule is not incidental. A pid is only meaningful on the machine
that wrote it, and pids are namespaced per container: a task killed mid-tick
leaves a lock naming a pid the *next* task is quite likely to have too, so a
naive reader sees its own unrelated process as the lock holder and refuses
forever, reporting success on every tick. The orchestrator therefore consults
pid liveness only for locks written by the same host.

## Deploy

```sh
export AWS_REGION=us-east-1

# From a machine where you have logged in (`divinci auth login`), store the
# WHOLE credentials file — not just the access token. The refresh token is what
# lets an unattended loop keep working, and the container persists the rotated
# one back onto EFS.
aws secretsmanager create-secret --name divinci-credentials \
  --secret-string "file://$HOME/.config/divinci/credentials.json"
export DIVINCI_CREDENTIALS_SECRET_ARN=arn:aws:secretsmanager:...

cd targets/aws
./deploy.sh                 # plan + offline template validation, creates nothing
./deploy.sh --go            # build, push, deploy the stack
./deploy.sh --go --run-now  # …and run one tick
```

| variable | default |
|---|---|
| `AWS_REGION` | **required** |
| `DIVINCI_CREDENTIALS_SECRET_ARN` | **required** |
| `VPC_ID` / `SUBNET_IDS` | discovered from the default VPC |
| `STACK_NAME` | `divinci-demo-pipeline` |
| `SCHEDULE` | `rate(1 hour)` |
| `RUN_LOCK_MAX_AGE_MS` | `7200000` (2h) |

Networking is **discovered, not created**: the template takes a VPC and two
subnets so this runs in the network you already have. It uses **public subnets
with a public IP** rather than private subnets behind NAT — the task only makes
outbound calls, and a NAT Gateway (~$32/month) would cost more than everything
else here combined.

Two subnets in **different availability zones**, because EFS wants one mount
target per AZ and two in the same AZ is an error rather than redundancy.

## Tests

```sh
python3 test/validate-template.py     # no network, no credentials, no account
```

This is **not** a substitute for `aws cloudformation validate-template`, which
needs credentials. It is the half that can be checked offline, aimed at the
mistakes a template makes *silently*: a `!Ref` naming nothing, an IAM policy
widened to `"*"`, the task and the mount targets landing in different subnets,
and above all **the scheduler lacking `iam:PassRole`** — the classic AWS failure
where the schedule is created successfully and every single fire is denied while
the console shows a healthy schedule.

`deploy.sh` runs it before touching the account.

## Cost

| | |
|---|---|
| Fargate, 2 vCPU / 4 GB, ~20 min/hour | ~$25/month |
| EFS, a few GB with IA transition | ~$1/month |
| EventBridge Scheduler | free at this volume |
| ECR, CloudWatch Logs | ~$1/month |
| NAT Gateway | **$0 — not used, deliberately** |

Crawling and model spend dominate all of this and are billed elsewhere.

## Authentication is the weak point of every hosted target

The pipeline authenticates as a **user** via the CLI's OAuth session, captured
into Secrets Manager. There is no service-account equivalent: workspace creation
only the OAuth session can perform, and `DIVINCI_API_KEY` is explicitly not a
substitute.

AWS is the best-placed of the hosted targets to fix this — Secrets Manager has
native rotation via a Lambda — but the rotation function would have to perform
an OAuth refresh, and that is unbuilt. For now, budget for re-minting the secret
and watch for **exit code 30**, which means only an interactive login can help.

## Not verified against a live account

The template passes offline validation and `deploy.sh`'s plan path is exercised,
but no stack has been created on a real AWS account by the authors — there was
no AWS CLI or credentials on the machine this was written on. Treat the first
`--go` as the real test, and please report what breaks.
