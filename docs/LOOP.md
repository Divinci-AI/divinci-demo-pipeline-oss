# Running the demo pipeline as a loop

Status: **scheduled and running.** Both LaunchAgents are loaded (loop hourly,
teardown daily 09:15) and a full tick has been verified end-to-end through
launchd, exit code 0.

## What the loop actually does

One tick, hourly:

```
lock → auth preflight → teardown expired demos → advance in-flight runs
     → intake ONE new prospect → write runs/.loop-status.json
```

```sh
cd orchestrator
npm run loop -- --dry-run   # decide everything, change nothing
npm run loop                # one real tick
```

### The property that makes it safe to leave running

**The loop never approves a gate.** Intake writes `approvedBy: null`, so a
newly-intaken prospect walks to Gate 1 and parks having spent nothing. Every
step that costs money — workspace creation, crawling, embedding, QA judging,
the landing-page build — sits behind a human decision the loop can only wait
for.

So what it does at 3am is *prepare work and stop*. The overnight output is a
queue of reviewable manifests and a status file, not a spend.

### Caps

| Knob | Default | What it bounds |
|---|---|---|
| `LOOP_MAX_NEW_RUNS_PER_DAY` | 50 | New prospects taken per day |
| `LOOP_MAX_INTAKE_PER_TICK` | 8 | Intakes in one tick |
| `LOOP_MAX_ACTIVE_RUNS` | 12 | Runs mid-pipeline (concurrency) |
| `LOOP_MAX_PENDING_REVIEW` | 40 | Corpus plans awaiting **Gate 1** — these cost nothing |
| `LOOP_MAX_LIVE_PARKED` | 12 | **Live demo sites** awaiting review — these carry a brand |
| `LOOP_MAX_RUNS_PER_TICK` | 6 | Runs advanced per tick |
| `LOOP_RUN_TIMEOUT_MS` | 45 min | Ceiling on one run inside a tick |

`MAX_ACTIVE_RUNS` and the parked caps are counted separately on purpose. A run
waiting at a gate is a *person's* queue, not the loop's. When they were counted
together, 18 runs awaiting review pinned the loop at its cap and intake would
never have fired again — a silent deadlock that looks exactly like a working
loop.

#### Why the review backlog is two numbers

It used to be one, `LOOP_MAX_PARKED_RUNS=12`, justified by "parked runs are live
demo sites". That is true of a run at gate2 / landing / outreach and **false of
a run at gate1**: intake does recon plus one model call, and the crawl, the
embeddings, the workspace and the deployed site are all on the far side of that
gate. Forty runs parked at Gate 1 are forty text files.

So one cap of 12 was throttling the cheap backlog to protect the expensive one,
and it — not the daily cap — was what made a high intake rate impossible while
looking like a spend control.

#### Raising the rate (2026-08-06: 2 → 50/day)

Raising `LOOP_MAX_NEW_RUNS_PER_DAY` alone would have achieved almost nothing.
Three other limits, none of which names itself as a rate limit, would have
capped it far lower:

- `MAX_PARKED_RUNS=12` — stops intake after ~7 more runs, as above.
- **one intake per tick** — the loop ticks hourly, so this is a hard 24/day
  ceiling that no cap mentions and that silently overrides any daily number.
- **discovery every 12h at a floor of 8** — feeds ~12 prospects/day, so the
  queue empties and intake idles against a queue-empty message while every cap
  reports room.

All four moved together. The discovery floor is now *derived* from the daily cap
(`max(8, MAX_NEW_RUNS_PER_DAY)`) so raising one cannot silently outrun the other.

### Gate 1 auto-approval (enabled 2026-08-06)

Gate 1 now clears itself for prospects meeting objective criteria; everything
else still waits for a person. Disable with `GATE1_AUTO_APPROVE=0`.

**What it decides is narrower than it sounds.** Gate 1 approves a CORPUS PLAN —
which of a company's own pages get crawled, and how many. It ships nothing. The
run still stops at **Gate 2** with a live demo and an adversarial QA score, and
at **Gate 3** before a word is sent, and `LOOP_MAX_LIVE_PARKED` bounds how many
live demos accumulate. The blast radius of a wrong yes is a crawl we should not
have run, not a demo somebody receives.

Every criterion is a **measured fact, never a judgement**:

| Check | Default |
|---|---|
| queue score | `GATE1_AUTO_MIN_SCORE=70` |
| planned pages | `GATE1_AUTO_MAX_PAGES=400` |
| compliance tier | `clinic-high` **never** auto-approves |
| operator note | any of ⚠️ / "read before Gate 1" / "tier gap" / "needs review" / "do not auto" blocks |
| sources | ≥1, all on the prospect's own registrable domain |
| scope | `complianceNotes` non-empty |
| robots.txt | a blanket `Disallow: /` under `User-agent: *` blocks |

`clinic-high` is excluded because what belongs in an operating clinic's
patient-facing corpus is a judgement about medical context, not a measurement.
The operator-note check matters just as much: `notes` is the one channel a human
has for recording a doubt, and ignoring it would make that channel decorative
from the day this shipped.

robots.txt is read **narrowly on purpose** — only a blanket refusal blocks.
Per-path rules are the crawler's job; evaluating them here would be a judgement
wearing a measurement's clothes. An unreachable robots.txt does not block, since
most sites have none and treating absence as refusal would block nearly
everything while looking principled.

A review-board task is still created and immediately closed as DONE, carrying the
evidence. A run arriving at Gate 2 with no Gate 1 task at all would read as a
step that was skipped, and "why was this approved?" has to be answerable months
later by someone who never saw the plan.

First live auto-approval, 2026-08-07T01:52Z:

```
gate1 AUTO-APPROVED — score 76 ≥ 70; tier wellness-low; 394 planned page(s) ≤ 400;
all 4 source(s) on www.acmeprecision.com; no robots.txt
```

Note that a `complianceFlags` entry does **not** block. A flag adds prompt rules
*and* matching QA hazards and promotes the tier to the strict base — it is the
mechanism that handles the hazard, and Gate 2 tests whether it worked. Add flags
to the block list if you would rather they escalate.

⚠️ **What 50/day actually buys is 50 Gate 1 tasks a day**, which is more than
anyone will read. The spend still waits for a human, so this is safe — but Gate
1 throughput, not this number, is now the real limit on how many demos exist. If
that becomes the bottleneck, the options are to raise `MAX_PENDING_REVIEW` and
accept a queue nobody reads, or to auto-approve Gate 1 for prospects meeting
objective criteria (score, measured pages, tier, robots.txt) and leave the rest
for a person. The second is a real change in posture and should be a decision,
not a default.

## Exit codes

The loop's only channel for telling outcomes apart. Everything used to exit 0,
so "parked awaiting a human", "review board was down so nothing happened", and
"completed" were indistinguishable — which overnight reads as *all good* while
the pipeline quietly accomplishes nothing.

| Code | Meaning | Loop's response |
|---|---|---|
| 0 | Advanced | continue |
| 10 | Parked at a gate | continue — expected, does **not** alert |
| 20 | A dependency is down (review board) | stop the tick, alert |
| 30 | Session needs `divinci auth login` | stop the tick, alert |
| 1 | That run failed | alert, keep going with the others |

Alerts become review-board tasks in the **Demo Loop — operations** project. Parking
deliberately does not alert: it is the expected outcome of most ticks, and
alerting on it would make the loop's notifications worthless within a night.

## Auth

The README's "token lasts ~a day; re-run when it expires" is **outdated**. The
CLI's `ensureValidToken` refreshes the access token when under 5 minutes remain,
persists it, and carries a rotated refresh token forward — so the loop runs
indefinitely until the *refresh* token is revoked, which is the only case
needing a human (exit 30).

The preflight checks two things before any step:

1. **A live authenticated call**, because that is what exercises the refresh.
   Reading `expiresAt` from the credential file proves nothing — the refresh is
   what fails, and it fails at call time, mid-run, after spending.

2. **Environment agreement.** The session and the run must name the same
   environment, or a run builds its workspace in one place and checks for the
   release in the other. The preflight refuses a mismatch *before* probing —
   because a green probe against the wrong environment is the failure mode, not
   a reassurance. Since the 2026-08-05 switch the profile and the pipeline
   default are both production, so this passes with no configuration; it earns
   its keep when someone points a staging session at a production run.

## Environment: PRODUCTION

As of 2026-08-05 the pipeline defaults to **production** — `api.divinci.app`,
`chat.divinci.app`, `embed.divinci.app` — which is also what the stored `divinci`
profile authenticates against, so the auth preflight passes with no
configuration. New demos are built in the production account and spend real
money; Gate 1 is what stands between the loop and that spend.

**Runs are pinned to one environment.** `state.apiUrl` is stamped the first time
a run is touched and never changes, because a run's workspace, vector and
release exist in exactly one place — advancing it against another looks for a
workspace that is not there. run.ts exports that value so every helper (QA
bases, readiness probe, landing) sees the run's OWN environment rather than the
ambient default, and refuses outright if `DIVINCI_API_URL` disagrees with it.

The 17 demos built before the switch are staging and were backfilled from ground
truth (where each release actually bootstraps). The loop **skips** them with a
message rather than failing:

```
[loop] skipping 17 run(s) built against another environment
       (session is https://api.divinci.app): https://api.stage.divinci.app
```

To work on them deliberately, log into staging and point the loop there:

```sh
divinci auth login --api-url https://api.stage.divinci.app
DIVINCI_API_URL=https://api.stage.divinci.app npm run loop
```

## The review board

Gates optionally post to a Kanban-style board: each one becomes a task to
approve or reject. Set `REVIEW_BOARD_URL` to your own instance; leave it unset
and the gates run without a board — the decision just happens wherever the
operator is looking. There is no default, and deliberately so: an unset
variable means disabled, never somebody else's board.

`orchestrator/src/review-board.ts` documents the REST shape it expects and the
five functions any other tracker — Jira, HubSpot, Attio, a Kanban board you
already run — would need to implement.

**Auth.** Three ways in, tried in order: a Cloudflare Access service token
(`CF_ACCESS_CLIENT_ID` + `CF_ACCESS_CLIENT_SECRET`), a browser-session token
(`CF_ACCESS_TOKEN`), or nothing for a board not behind Access.

⚠️ **Whatever your board depends on becomes a dependency of every gate.** If it
sits behind Access with device authentication and that device posture drops,
Access returns a login redirect, `isAvailable()` reports false, and each tick
exits 20 having advanced nothing. Note also that a CF Access *service token*
carries no user identity — a board whose own auth resolves a user will reject
one.

⚠️ **Project names must match, or the board forks.** Projects are matched by
exact name, then by a *unique* prefix. The first production tick created a
second "Demo — The Acme Clinic" alongside the hand-named "Demo — The Stone
Clinic (Dr. Kevin R. Stone)" — half a prospect's history under each. Prefix
matching now reuses the qualified one, and refuses when a prefix is ambiguous
("Demo — Dr. William" must not adopt "Demo — Dr. Rowan Pike"). If a board name
cannot be derived from the prospect name, pin it explicitly rather than letting
a near-miss create a twin.

## ⚠️ The `ks` spend guard is NOT installed

`guardCheck()` runs before every spending step and the README advertises "hard
spend caps via Kill Switch Agent Guard". On this machine `ks` is **not on the
PATH at all** — not in an interactive shell and not on the agents' PATH. The
check catches ENOENT, logs

```
guard: WARNING — could not verify ks guard status (spawn ks ENOENT); proceeding
```

and proceeds. So the spend guard has never gated anything here, and the loop is
now running unattended against PRODUCTION.

That fail-open is arguably the right default for a check that is advisory — but
it should be a decision, not a discovery. Either install `ks` and put it on the
agents' PATH (the plists set PATH explicitly, so it must be listed there), or
drop the claim from the README. The caps that ARE real today are
`LOOP_MAX_NEW_RUNS_PER_DAY` (now 50, i.e. deliberately loose), the per-manifest
`budgets.crawlPages`, and Gate 1 — which after the 2026-08-06 raise is doing
almost all of the work.

## Demo health monitoring

```sh
npm run health          # check every live demo; exit 1 if any is dark
npm run health -- --json
```

Also runs on every tick, before advancing work: a demo already live and dark is
a prospect looking at a broken page right now, which outranks building the next
one.

| Verdict | Meaning |
|---|---|
| `ok` | Landing responds (**401 is healthy** — the preview gate is up) and the release bootstraps publicly |
| `open` | Serves 200 with no challenge *although a password is recorded* — gate configured but not enforced |
| `dark` | Page loads, release does not bootstrap on either environment — **the frame renders and the chat is dead** |
| `unreachable` | Landing worker 5xx/404/no response |

A torn-down demo is reported `ok`: teardown succeeding is not an outage.
Baseline at 2026-08-05: **18 checked, 17 ok, 1 open** (acmebio, deliberately).

Alerts are de-duplicated per demo and persisted, so a demo that stays dark opens
one review-board task rather than 24 a day, and becomes alertable again on recovery.

## Turning it on

```sh
./launchd/install.sh preflight   # validate plists, paths, PATH, TCC
./launchd/install.sh install     # load both agents (neither runs at load)
./launchd/install.sh test        # force one tick, tail the log
./launchd/install.sh status      # loaded? last exit code? last tick?
./launchd/install.sh uninstall
```

Two agents: `ai.divinci.demo-loop` (hourly) and `ai.divinci.demo-teardown`
(daily 09:15). Teardown is also run inside every tick; the standalone agent
exists so that "expires in 14 days" stays true even when the loop is stopped —
a promise made to a real company should not depend on a feature flag.

### TCC: Full Disk Access is NOT required (measured)

This repo is under `~/Documents`, and a launchd-spawned process is not covered
by the Terminal's own consent — so the obvious-looking fix is to give
`/usr/local/bin/node` Full Disk Access. **Don't.**

Measured on 2026-08-05 with a throwaway LaunchAgent, a launchd-spawned
`/usr/local/bin/node`:

| Path | Result |
|---|---|
| this repo, under `~/Documents` | **READABLE** |
| `~/Library/Safari/Bookmarks.plist` (FDA-only) | DENIED (EPERM) |
| `~/Library/.../com.apple.TCC/TCC.db` (FDA-only) | DENIED (ENOENT) |

It has no Full Disk Access and does not need it — either `~/Documents` is not
protected against it here, or node already holds the *narrow* Documents-folder
grant. A full loop tick then ran under launchd and exited 0.

Granting FDA would give **every** Node process on the machine read access to
every protected file, to solve a problem this machine does not have. Reach for
it only if a real tick fails with `ENOENT`/`EPERM` on files that plainly exist,
and try the narrow Files-and-Folders → Documents grant first.

`./launchd/install.sh test` runs a real tick through launchd and is the
authority on this — not `test -r`, which returns true while the privacy layer
denies the subsequent `open()`.

## Discovery — where prospects come from

The queue used to be hand-written, so the loop consumed it and then idled. On
2026-08-06 it held 11 unstarted prospects — about five days of runway at two new
runs a day — and nothing in the system would have noticed when that ran out.

Discovery runs as step 4 of each tick, **before** intake's caps and not subject
to them. The two limit different things: intake's caps are about spend and
review capacity, since every new run crawls a real company's website and puts a
demo in front of a person, whereas discovery spends one model call and a handful
of HEAD requests. Placed after the caps it would never run on a busy day, which
is exactly when the queue drains fastest.

It fires when the unstarted backlog drops below `DISCOVER_BACKLOG_FLOOR` (8) and
at most every `LOOP_DISCOVER_MIN_HOURS` (12).

```sh
npm run discover -- --dry-run --count 6   # model call + live verification, writes nothing
npm run discover -- --count 6             # append the survivors to the queue
```

**It approves nothing.** A discovered prospect enters the queue and stops at
Gate 1 with `approvedBy: null`, exactly like a hand-written one. Nobody's
website is crawled because a language model thought of it.

**It does not trust the model's output as fact.** A plausible company that does
not exist is the characteristic failure, and it is worse than an empty queue
because it looks like research. Every candidate is fetched and checked: the site
must resolve, most of its discoverable pages must be on its own registrable
domain (a redirect to an acquirer is a different company), and it must expose at
least `DISCOVER_MIN_PAGES` (25) pages — public-data richness is 30% of the
rubric and a brochure site retrieves nothing. Every drop is named in the log,
because a pass that queues 1 of 6 looks identical to a bad night otherwise.

Two things are deliberate in what gets written:

- `anchorCustomer` says `discovered:<date> — … NO Attio record`. Every
  hand-written entry carries an `attio:` reference; a cold lead must not read
  like a live thread.
- The existing queue is passed to the model as **names and hosts only**. That
  file carries operator research — deal status, adjacency reasoning — and
  candidates come back out of the prompt into the same file. Feed a model our
  own sales notes and some of them come back as prose.

⚠️ **Tier taxonomy gap.** The four tiers are health-shaped, so a non-health
prospect has no honest home and discovery reaches for `wellness-low`, which
claims "general wellness content". For Acme Space Fdn that label is simply
false. Behaviour is still right — a `financial-advice` flag promotes the tier to
the strict base — but the label lies, and a fifth tier is worth adding before
this taxonomy is used to justify anything.

## Intake

`research/prospect-queue.yaml` is the only input. A prospect is "taken" once
`runs/<slug>/` holds a manifest — there is no `status:` field to drift out of
sync, and the drift would have shown up as a duplicate crawl of a real
company's website.

```sh
npm run intake -- --next --dry-run    # recon + show the prompt, write nothing
npm run intake -- --next              # take the top of the queue
npm run intake -- --prospect acmeclinic
```

Recon is content-free: `robots.txt` → sitemaps → a path-shape summary, plus an
SPA heuristic that predicts whether the default scraper would return blank
pages (if so, the manifest gets `@cloudflare/browser-rendering`).

The manifest is **assembled by code**, not trusted from the model. The model
proposes the corpus plan and the chat copy; compliance tier, budget, `tier: T1`,
`destination: rag` and above all `approvedBy: null` are set by the orchestrator.
A model that returns `"approvedBy": "Mike"` cannot open Gate 1. **Off-domain
sources are refused outright** — we send this demo back to the company we
crawled, so a competitor's page in their corpus is the worst thing this
pipeline could ship.

`complianceTier` has no safe default and intake refuses a missing one: it
selects both the assistant's compliance prompt and the QA hazard set.

## Pre-outreach preflight

Every failure on 2026-08-06 had one shape: the pipeline verified that a STEP
RAN, not that it PRODUCED something. A step that "succeeded" and left nothing
behind is invisible.

| what happened | how it looked |
|---|---|
| og.png was never built | SPA fallback served `200 text/html` |
| corpus.webm's upload blipped | same |
| copy step echoed the template back | "Replace this with the founder's bio" on a live page |
| no person could be identified | "The Acme Finance Group — Founder" |
| nav is `hidden md:flex` | no navigation at all below 768px, on every demo ever sent |
| a template copy key was added | every demo silently reverted to "Acme Expert AI" branding |

`demo-preflight.ts` measures the deployed page in a browser at 1440 and 390,
at **Gate 3** — the last moment before a human is asked whether to send it, and
the artifact as a prospect will receive it. The result goes at the TOP of the
review task.

It checks: same-origin assets by **content-type** (a 404 arrives as a 200
carrying HTML), rendered text against placeholder patterns, images that never
decoded, videos with no frames, sideways scroll, reachable navigation.

⛔ **There is no model in this path and there must not be one.** The design
review is a vision model asked for taste, and on a clean page it produced one
CRITICAL and two specific false claims — an OCR misread reported as a typo, a
placeholder URL that appeared nowhere, and a missing CTA present in the markup.
It is useful for judgement and unreliable for fact. If a check cannot be
expressed as a measurement, it belongs in the review, not here.

**It never fails the run.** A stranded finished demo helps nobody and Gate 3 is
a human's call. What it guarantees is that the call is not made against a page
nobody looked at.

Three traps already paid for, all of which made it cry wolf before it ever ran
unattended — a check that cries wolf is the thing this exists to remove:

- `page.evaluate` died on `ReferenceError: __name is not defined`. tsx compiles
  with esbuild's keepNames, which wraps named inner functions in a helper that
  does not exist in the browser. **Keep the evaluate bodies free of named inner
  functions.**
- Lazy images below the fold have `naturalWidth === 0` — indistinguishable from
  broken. It reported six of acmeincubator's team photos as broken on MOBILE only,
  where the taller layout pushes them down; all six served 200 with real bytes.
  It now scrolls the page first, as a visitor would.
- Cloudflare takes a moment to serve a new build everywhere, so a preflight run
  seconds after `wrangler deploy` can measure the PREVIOUS one. `measureUntilStable`
  re-measures once when the first look is blocking and reports the second
  result — a real defect survives a retry, a stale cache does not.

## Quality gate

Every run now carries QA evidence:

- No hand-authored `qa-suite.yaml`? One is **generated** — adversarial and
  shaped by the compliance tier's hazards, plus two regression guards (a suite
  made only of refusal tests is aced by an assistant that refuses everything).
  A hand-authored suite is still better; `runs/acmebio/.../qa-suite.yaml` is
  the standard to beat.
- Suites are validated before import, because the importer **silently
  discards** tests whose `purpose` is outside its enum — a suite that imports
  as 3 of 10 tests still shows Gate 2 a score, and that score means nothing.
- **Gate 2 refuses to pass a run with no QA score**, checked before the legacy
  approved-by bypass (that bypass is precisely the path that must not skip the
  evidence). Override deliberately with `ALLOW_UNSCORED_GATE2=1`.

## Outreach assets

Drafted by the pipeline into `runs/<prospect>/<run>/outreach/`:
`research-expanded.md`, `email-draft.md`, `deck-spec.md`. Existing files are
never overwritten — they may be a human's edit.

**The Canva deck is not automated.** The Canva MCP server reports *"needs
authentication"*, so nothing in the pipeline can reach it. `deck-spec.md`
carries the finished slide-by-slide copy so building it is mechanical once
someone has an authenticated Canva session. Authenticating Canva is what closes
this gap.

**Nothing is ever sent.** Gate 3 is a human decision.

## Is it alive?

```sh
cat runs/.loop-status.json     # last tick: what advanced, what was intaken, errors
tail -f ~/Library/Logs/divinci-demo-loop.log
./launchd/install.sh status
```

`runs/.loop.lock` holds a pid; a tick that dies without releasing is recovered
automatically on the next tick (nobody is watching at 4am to clear it).
