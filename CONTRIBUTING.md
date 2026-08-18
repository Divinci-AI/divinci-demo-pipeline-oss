# Forking, experimenting, contributing

## Fork it. Change it. It is meant to bend.

This pipeline was extracted from something Divinci runs against its own
prospects, on its own Cloudflare and GCP accounts, under its own crawl policy.
Almost none of that is universal. The parts most likely to be wrong for you are
the parts that are easiest to change:

- **The prospect queue** ships empty on purpose — `research/prospect-queue.yaml`
  is yours, and `prospect-queue.example.yaml` is only the schema.
- **The review board** is a five-function seam
  (`orchestrator/src/review-board.ts`: `createTask`, `getTask`, `updateTask`,
  `findOrCreateProject`, `isAvailable`). That is the entire surface a Jira,
  HubSpot, Attio or plain-Kanban adapter has to implement. Leave
  `REVIEW_BOARD_URL` unset and the human gates still work without any board.
- **The crawl policy** (`policies/crawl-policy.md`) encodes commitments *we*
  made. Fork it to match the commitments **you** can keep — but read it before
  you loosen it, especially rule 6, which is a promise a human has to honour on
  the day someone objects.
- **The pipeline steps** are ordinary TypeScript. Add one, drop one, swap the
  generation model, point it at a different Divinci environment.

You do not need our permission and you do not owe us a pull request. Apache-2.0
means what it says.

Two things worth keeping whatever else you change, because they are the
difference between a demo pipeline and an incident:

1. **The loop never approves a gate.** Everything that spends money or reaches a
   real company stays behind a human decision.
2. **No infrastructure variable gets a default.** A default that names external
   infrastructure does not fail when it is wrong — it succeeds, against somebody
   else's account.

## If you do want to contribute back

Issues and pull requests are welcome, including ones that only report that
something did not work on your machine — a setup step that fails for a stranger
is a real defect here, since "can a stranger run this?" is the test this repo is
built around.

Before you push:

```sh
cd orchestrator && npm ci
npx tsc --noEmit
npm test          # no network
npm run smoke     # whole pipeline, no external calls, no credentials
```

⚠️ It is `npm run smoke`, not `npm run demo -- --prospect __smoke__ --run dry`.
`--run dry` names a run directory; the dry-run switch is `DRY_RUN=1`. Without
it, that command runs the fixture for real against production.

CI runs the same, plus a hygiene job for developer-local paths, account-specific
identifiers, and tracked run data. **Never commit anything under `runs/`** —
`runs/__smoke__/` is the one synthetic exception. The rules that will fail your
build are in [`AGENTS.md`](AGENTS.md).

Changes that help everyone, in rough order of usefulness: a review-board adapter
for a tool we do not support, a scraper that handles a site class the default
one cannot, a crawl-policy clarification, and fixes to anything that assumes our
accounts.

## Contributing to the Open Web Vectors Initiative

The bigger project this pipeline feeds is the
[**Open Web Vectors Initiative**](https://divinci.ai/open-web-vectors/): a
public, per-site retrieval index. Every site gets its own vector database, its
own embeddings, and a chat endpoint grounded in its own words with citations
back to the page. Nothing is trained on, the corpus stays attributable to the
site it came from, and any site owner can claim or remove theirs.

There are two ways this repository contributes to it, and we appreciate both:

**Index sites.** The `wwwrag` pipeline step (opt-in, `WWW_RAG_SUBMIT=1`) submits
the exact page URLs a crawl indexed into the public corpus, so the host becomes
one of its groups. See the README section on it — including the server-version
precondition, which matters. `orchestrator/scripts/feed-wwwrag.mts` does the
same for a run that already finished.

**Improve the crawling.** Coverage of the open web is limited mostly by pages
our scrapers cannot read: JS-rendered apps, bot-protected homepages, PDFs,
documentation systems with unusual routing. A fix for a site class that
currently fails is the highest-leverage contribution here, and it is worth
opening an issue with the URL that broke even if you do not fix it.

Whatever you index, index it under the same standard the crawl policy sets:
*would we be comfortable walking them through exactly how we got this data.*
