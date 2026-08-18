# Notes for coding agents

Guidance for any AI coding agent working in this repository. Claude Code also
reads the task-specific skills in `.claude/skills/`:

| skill | for |
|---|---|
| `divinci-demo-pipeline-setup` | fresh clone → verified install |
| `divinci-demo-pipeline-run` | running against a real company |
| `divinci-cli-release-demo` | one demo by hand, with just the CLI |

Agents without skill support: read those three files directly, in that order.

Those three are scoped to this pipeline. For the Divinci platform generally —
the CLI's whole command surface, the client/server/MCP SDKs, the REST API —
install the platform-wide `divinci` skill next to them:

```sh
curl -sL https://sdk.divinci.ai/divinci-skill.zip -o /tmp/divinci-skill.zip
unzip -q /tmp/divinci-skill.zip -d .claude/skills/
```

(Unrelated to `divinci user-skills` in the CLI, which manages per-user platform
skill instances.)

This repo is meant to be forked and adapted — see
[`CONTRIBUTING.md`](CONTRIBUTING.md). If the user is changing the pipeline for
their own use rather than contributing back, say so plainly and do not steer
them toward keeping a divergence they never asked for.

## Orient

```sh
cd orchestrator && npm ci
npm test                                          # 64 files, ~1150 tests, no network
npm run demo -- --prospect __smoke__ --run dry    # whole pipeline, no external calls
```

The package lives in `orchestrator/`, not the repo root. The dry run is the
fastest proof an install works, and it is the first thing to run after any
change to the pipeline's control flow.

## Rules that are load-bearing

**Never commit anything under `runs/`.** It holds real companies' crawled
corpora, generated landing pages, and outreach drafts written about them. The
predecessor repository committed 4,868 such files across 104 companies, which
is the single reason this one had to be created from scratch rather than made
public in place. `.gitignore` blocks it and CI fails on it; do not add
exceptions. The synthetic `runs/__smoke__/` fixture is the one deliberate
exception and already tracked.

**Never give an infrastructure variable a default.** `CF_WORKERS_SUBDOMAIN`,
`LANDING_KV_NAMESPACE_ID`, `DEMO_ASSETS_R2_BUCKET`, `DEMO_ASSETS_R2_BASE` and
`VERTEX_PROJECT` are read through `requireEnv`/`lazyEnv` and have none, on
purpose. A default naming external infrastructure does not fail loudly when it
is wrong — it *succeeds*, against somebody else's Cloudflare namespace or R2
bucket or GCP project, and the operator gets no signal at all. Adding `?? "…"`
to one of these will fail `require-env.test.ts` and the CI hygiene job.

Behavioural defaults — model names, thresholds, timeouts — are fine and are
deliberately not covered by that rule. So are the public Divinci endpoints
(`DIVINCI_API_URL` and friends), which are the same for everyone.

**Use `lazyEnv`, not `requireEnv`, for a module-level binding.** An eager
module-level read throws at *import*, which breaks test collection wholesale
and reads the environment before `run.ts` loads `.env`.

**`notes` is operator-facing; `complianceNotes` is MODEL-facing.** The second
becomes a deployed assistant's compliance scope verbatim. Operator material in
that field is elicitable by a visitor.

**The loop never approves a gate.** Intake writes `approvedBy: null`.
Everything that spends money or reaches a real company is behind a human
decision. Do not add an auto-approval path, and never set `GATE1_AUTO_APPROVE`
for a `clinic-high` or flagged prospect — there is a test asserting the first
of those cannot auto-approve.

**No developer-local absolute paths.** Derive from the repo root
(`fileURLToPath(import.meta.url)`) or take an env var. CI greps for `/Users/…`.

## Before you push

CI runs typecheck, the test suite, and a hygiene job covering the three
mistakes that forced the re-extraction: local paths, account-specific
identifiers, and tracked run data. Run the equivalent locally:

```sh
cd orchestrator && npx tsc --noEmit && npm test
git grep -nE '/Users/[a-z]+' -- . ':!*.test.ts' ':!.github/**'   # expect no hits
git ls-files runs/ | grep -v '^runs/__smoke__/'                  # expect nothing
```

## Crawling is not a neutral act

The pipeline crawls companies that have not asked for it. `policies/crawl-policy.md`
governs that and commits to robots.txt, 1 req/sec under an identified
user-agent, a page budget, exclusion of auth-walled and user-generated content,
and same-day deletion on objection. Read it before helping anyone start a real
run, and do not treat it as boilerplate — rule 6 is a promise a human has to be
able to keep.

Nothing in this repository's Apache-2.0 licence grants any right to a crawled
site's content. See `NOTICE`.
