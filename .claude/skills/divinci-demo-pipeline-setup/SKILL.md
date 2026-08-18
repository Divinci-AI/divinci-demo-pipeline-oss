---
name: divinci-demo-pipeline-setup
description: "Take a fresh clone of the Divinci demo pipeline from zero to a verified working install: Divinci CLI auth, the Cloudflare and GCP resources it needs, the required environment, and a no-network dry run that proves it. Use when someone has just cloned this repo, hits a MissingEnvError, or asks how to set the pipeline up."
---

# Setting up the demo pipeline

Get from a fresh clone to a dry run that exercises every pipeline step without
making a single external call. **Verify each step by running the check** — do
not tell the user to run things and assume they worked.

Nothing here spends money or touches anyone's website. That starts in
`divinci-demo-pipeline-run`, which you should not begin until this finishes
clean.

## 1. Toolchain

```sh
node --version                 # must be >= 22
npm --version
```

Node 22 is required — `package.json` targets it and CI pins it.

## 2. The Divinci CLI

```sh
npm i -g @divinci-ai/cli       # binary is `divinci`, package name differs
divinci --version
divinci auth whoami            # exits non-zero when not signed in
```

If `whoami` fails: `divinci auth login` (opens a browser).

⚠️ **`DIVINCI_API_KEY` must be UNSET.** This is counterintuitive and it is the
single most common way to break this pipeline. Workspace creation is an
account-level operation only the OAuth session can perform, and the CLI
*prefers* an API key over OAuth whenever one is in the environment — so a key
present in the shell makes `divinci workspace create` fail with an auth error
that looks like a login problem and is not.

```sh
[ -z "$DIVINCI_API_KEY" ] && echo "ok: unset" || echo "UNSET THIS: DIVINCI_API_KEY"
```

The session refreshes itself. There is no daily re-login.

## 3. Install

```sh
cd orchestrator && npm ci      # NOT the repo root — the package lives here
```

## 4. Cloudflare resources

The pipeline deploys each generated demo as a Worker with a KV binding, and
uploads generated media to R2. Create both, and capture the ids — they become
environment variables in step 6.

```sh
npx wrangler login
npx wrangler whoami                                   # note the account id

npx wrangler kv namespace create EMAIL_QUOTA          # prints the namespace id
npx wrangler r2 bucket create <your-demo-assets>
npx wrangler r2 bucket dev-url enable <your-demo-assets>   # prints https://pub-….r2.dev
```

Your `workers.dev` subdomain is shown in the Cloudflare dashboard under
Workers & Pages → your account (it looks like `yourname.workers.dev`).

## 5. GCP — optional

Only `brand-media.ts` (Imagen/Veo hero images and clips) uses Vertex AI. Skip
it and demos build with placeholder media; every other step is unaffected.

```sh
gcloud auth application-default login
gcloud config get-value project
```

## 6. The environment

Write `orchestrator/.env` (gitignored). **All five have no default, on
purpose** — a default naming external infrastructure does not fail loudly when
it is wrong, it succeeds against somebody else's account. See
`orchestrator/src/require-env.ts`.

```sh
CF_WORKERS_SUBDOMAIN=yourname.workers.dev
LANDING_KV_NAMESPACE_ID=<from step 4>
DEMO_ASSETS_R2_BUCKET=<your-demo-assets>
DEMO_ASSETS_R2_BASE=https://pub-<hash>.r2.dev
VERTEX_PROJECT=<gcp project, or omit if skipping step 5>
```

Do **not** set `DIVINCI_API_URL` / `DIVINCI_WEB_URL` / `DIVINCI_EMBED_URL`
unless targeting a non-production Divinci environment; they default to the
public hosts correctly.

`REVIEW_BOARD_URL` is optional and off by default. It puts each human gate on a
Kanban-style board as a task to approve or reject. Leave it unset and the gates
still work — the decision just happens wherever the operator is looking.

## 7. Prove it

```sh
cd orchestrator
npm test          # 66 files, ~1170 tests, no network
npm run smoke     # the dry fixture — no external calls, no credentials
```

The dry run walks gate1 → done against a synthetic fixture ("Smoke Test
Clinic", example.com) and calls nothing. **If this passes, the install is
good.** If it fails, the install is the problem — do not go on to a real
prospect to find out.

⚠️ **Run `npm run smoke`, and do not "expand" it to
`npm run demo -- --prospect __smoke__ --run dry`.** `--run dry` is a run ID —
a directory name — and the dry-run switch is the environment variable
`DRY_RUN=1`. This skill told you to run the expanded form without it until
2026-08-18, which authenticated against production and performed a REAL run:
a workspace, a crawl, a published release with anonymous chat open, and model
spend, on a fixture whose clinic does not exist. The pipeline now refuses that
invocation outright, so if you meet the refusal, the fix is `npm run smoke`.

## When something fails

| Symptom | Cause |
|---|---|
| `MissingEnvError: … VERTEX_PROJECT` | step 6; the message names the variable and what it is for |
| `divinci workspace create` auth error | `DIVINCI_API_KEY` is set — unset it (step 2) |
| `no prospect queue at …` | expected on a fresh clone; that is `divinci-demo-pipeline-run`, not a fault |
| `npm ci` fails at the repo root | run it in `orchestrator/` |
| tests pass but a real run cannot deploy | `CF_WORKERS_SUBDOMAIN` wrong — tests use a placeholder and never touch Cloudflare |

## What this repo does not ship

A fresh clone has **no prospect queue** — the real one is not published.
`research/prospect-queue.example.yaml` documents the format and is what the
compliance and gate-1 safety tests run against. Run data (`runs/`) is
gitignored wholesale; only the synthetic smoke fixture is tracked.
