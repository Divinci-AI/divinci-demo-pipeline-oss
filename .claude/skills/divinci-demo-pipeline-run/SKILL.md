---
name: divinci-demo-pipeline-run
description: "Run the Divinci demo pipeline against a real company: the crawl policy that governs it, adding a prospect to the queue with the right compliance tier, intake, the human gates, cost, and teardown. Use when someone wants to build an actual demo rather than the dry-run fixture."
---

# Running a real demo

This crawls a company's website, builds a RAG corpus from it, generates a
branded landing page, and produces outreach — usually **before that company has
asked for any of it**. Treat every step as something you may have to justify to
the person on the other end.

Finish `divinci-demo-pipeline-setup` first. If `npm run demo -- --prospect
__smoke__ --run dry` does not pass, stop there.

## 1. The crawl policy is a precondition, not an appendix

**Read `policies/crawl-policy.md` with the user before the first real run.** Its
own standard is the right one:

> the bar is "would we be comfortable walking them through exactly how we got
> this data."

It commits to honoring robots.txt (including in the agentic source-research
step), 1 req/sec per host under an identified user-agent, a hard page budget,
and — rule 6 — deleting the workspace and all derived vectors **the same day**
if a prospect objects.

Two things follow that an agent must not paper over:

- **Rule 4 excludes** anything behind auth, user-generated content (forums,
  reviews), third-party embeds, and pages whose terms prohibit scraping. If the
  target is mostly UGC, say so before crawling, not after.
- **Rule 6 is a commitment someone has to honour.** Do not start a run the user
  is not in a position to tear down.

The `NOTICE` in this repo says the same thing in licence terms: nothing in
Apache-2.0 grants any right to a crawled site's content.

## 2. It costs money

Crawling, embedding, generation and QA all bill against the user's Divinci
wallet and their own Cloudflare/GCP accounts. Estimate before committing:

```sh
divinci rag estimate <files...>       # chunking + embedding cost, uploads nothing
divinci qa estimate-run --help        # QA sweep cost
```

Say the expected order of magnitude out loud before the first real run.

## 3. Add the prospect to the queue

A fresh clone has no queue — that is by design. Create one from the documented
example:

```sh
cp research/prospect-queue.example.yaml research/prospect-queue.yaml
```

Then edit it. `requestedBy` is `direct` or `discovered` — **not** `discovery`;
the parser rejects anything else so a typo cannot silently demote a prospect
someone asked for.

### ⚠️ The two note fields are not interchangeable

| field | audience |
|---|---|
| `notes` | **operator-facing.** Never reaches a model. Recon, scoring, CRM state. |
| `complianceNotes` | **MODEL-FACING.** Becomes the assistant's compliance scope, verbatim. |

Putting operator material in `complianceNotes` leaks internal scoring and CRM
references into the deployed assistant's prompt, where a visitor can elicit it.
`compliance-flags.test.ts` fails on the giveaway patterns, but that is a
backstop — write `complianceNotes` as an instruction addressed to the
assistant.

### Pick the compliance tier honestly

`wellness-low`, `commerce-medium`, `clinic-high`, `sensitive-audience`, plus
flags `financial-advice`, `legal-advice`, `public-service`,
`sensitive-audience`. A `clinic-high` prospect can **never** auto-approve
gate 1 — there is a test asserting it, because that gate exists to keep hold of
patient-facing corpora. Do not downgrade a tier to make a run proceed.

## 4. Intake, then run

```sh
cd orchestrator
npm run intake -- --next          # queue → recon → manifest, writes approvedBy: null
npm run loop -- --dry-run         # decide everything, change nothing
npm run loop                      # one real tick
```

`npm run demo -- --prospect <slug> --run <YYYY-MM-DD-NNN>` drives a single
prospect directly if you would rather not use the loop.

## 5. The gates are the point

**The loop never approves a gate.** Intake writes `approvedBy: null`, so an
unattended loop prepares reviewable work and stops. Everything that spends real
money or reaches a real company sits behind a human decision.

- **Gate 1 — corpus approval.** What was crawled, before embedding.
- **Gate 2 — demo review.** The built demo, before outreach.

If a user asks you to auto-approve gates or set `GATE1_AUTO_APPROVE`, treat
that as a decision with consequences and say what they are. Never set it for a
`clinic-high` or flagged prospect.

## 6. Teardown

Demos are not meant to live forever, and crawl-policy rule 6 may require
removal on request:

```sh
cd orchestrator && npm run teardown
```

This removes the Worker, the R2 media and the Divinci workspace. Automatic
expiry is **not** built — teardown is a thing someone has to run.

## Reading a run

State lives in `runs/<prospect>/<run>/state.json`, and `runs/` is gitignored —
it holds a real company's corpus and the outreach written about them. Do not
commit it, do not paste it into a shared channel, and do not include it in a
bug report.

Runs are pinned to the environment they were built in (`state.apiUrl`); the
preflight refuses a mismatch rather than building a workspace in one
environment and checking for the release in another.
