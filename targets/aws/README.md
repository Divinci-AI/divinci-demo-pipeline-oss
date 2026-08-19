# Target: AWS — designed, not built

> **Status: DESIGN ONLY.** There is no code in this directory. Everything below
> is a concrete mapping worked out against the constraints the built targets
> exposed, so that whoever builds it starts from those rather than rediscovering
> them. If you build it, a PR replacing this file with something that runs would
> be very welcome.

## The shape

The orchestrator is a Node process that runs for minutes, needs a POSIX
filesystem for state, and shells out to the `divinci` CLI and `git`. On AWS that
is **ECS Fargate + EventBridge Scheduler + EFS**, not Lambda.

```
EventBridge Scheduler ──RunTask──► ECS Fargate task ──► one loop tick
     rate(1 hour)                        │
                                         ├── EFS access point → /app/runs
                                         ├── Secrets Manager → DIVINCI_TOKEN
                                         └── divinci CLI → api.divinci.app
```

| need | service | why this one |
|---|---|---|
| run a container on a schedule | EventBridge Scheduler → ECS `RunTask` | Scheduler targets ECS directly; no Lambda in the path |
| the container | ECS Fargate, 2 vCPU / 4 GB | no capacity to manage; a tick is minutes |
| **run state** | **EFS**, via an access point at `/app/runs` | the only AWS store with real POSIX semantics — see below |
| secrets | Secrets Manager → task definition `secrets` | injected as env, never baked into the image |
| image | ECR | |
| logs | CloudWatch Logs via `awslogs` | |

## Why Lambda is the wrong answer

Every instinct says "scheduled job → Lambda". It does not fit, for four
independent reasons, any one of which is disqualifying:

1. **15-minute hard timeout.** A tick that crawls a site and runs QA exceeds it.
2. **`/tmp` is ephemeral and 512 MB–10 GB.** State would vanish between ticks —
   the same failure the GCP target refuses to boot into.
3. **The orchestrator shells out** to `divinci` and `git`. Possible in a Lambda
   container image, awkward, and buys nothing.
4. **Concurrency is the wrong default.** Lambda wants to scale out; this
   workload must never have two writers.

Fargate has none of these.

## Why EFS rather than S3

S3 is the reflexive choice and it is wrong here. The orchestrator does ordinary
filesystem work — `openSync(path, "wx")` for its lock, in-place `state.json`
rewrites, directory listings — and S3 is an object store with none of those
semantics. Using it would mean either mounting it through something like
Mountpoint for S3 (which does not support random writes or the exclusive-create
the lock depends on) or rewriting the orchestrator's persistence layer.

EFS gives real POSIX semantics **including working `flock` and atomic
`O_EXCL`** — which makes AWS the only one of these targets where the
orchestrator's own run lock is genuinely load-bearing. That is a real advantage
over the GCP target, where single-writer has to be enforced by job
configuration because GCS FUSE cannot guarantee it.

The cost is that EFS needs a VPC with subnets and a security group, so this
target has meaningfully more infrastructure than the others. That is the trade:
more setup, stronger correctness guarantee.

## Single-writer

Belt and braces, since the failure is silent and expensive:

- EventBridge Scheduler with a **`FlexibleTimeWindow` of `OFF`** and one target,
- the ECS service using `RunTask` with `count=1` (not a service with a desired
  count, which would replace a healthy task),
- and the orchestrator's own lock, which on EFS actually works.

Schedule interval must exceed the tick duration; `rate(1 hour)` against
~20-minute ticks is comfortable.

## What still needs deciding

1. **Fargate needs a VPC with egress.** A NAT Gateway is ~$32/month, which is
   more than every other line in this design combined. Public subnets with
   `assignPublicIp=ENABLED` avoid it and are the right call for a job that only
   makes outbound calls.
2. **Token rotation.** Same weak point as GCP: this authenticates as a *user*
   via a captured OAuth session. Secrets Manager has native rotation via Lambda,
   which is a better fit than anything GCP offers — but the rotation function
   would need to perform an OAuth refresh, and that is unbuilt.
3. **CDK, Terraform, or a shell script?** The other targets ship a readable
   `deploy.sh`. AWS's resource count (VPC, subnets, SG, EFS, access point, ECR,
   task definition, role, schedule) is where that stops being readable, and CDK
   is probably right.

## Estimated cost

| | |
|---|---|
| Fargate, 2 vCPU / 4 GB, 20 min/hour | ~$25/month |
| EFS, a few GB, infrequent access | ~$1/month |
| EventBridge Scheduler | free at this volume |
| ECR, CloudWatch | ~$1/month |
| NAT Gateway, **if** you use private subnets | +$32/month — avoid it |

Crawling and model spend dominate all of this and are billed elsewhere.
