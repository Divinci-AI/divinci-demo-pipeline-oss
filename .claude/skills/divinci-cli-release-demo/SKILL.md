---
name: divinci-cli-release-demo
description: "Build a Divinci release demo by hand with the divinci CLI — workspace, RAG vector, crawl, release, publish — without the orchestrator. Use when someone wants one chat demo over a site's content, is exploring what the CLI does, or is debugging a step the automated pipeline performs."
---

# A release demo with just the CLI

The orchestrator in this repo automates a pipeline around these commands. This
is the same path by hand: useful for one demo, for learning what the pipeline
is doing, and for debugging a step that failed inside it.

```
workspace  →  RAG vector  →  crawl into it  →  release  →  publish
```

## Install and authenticate

```sh
npm i -g @divinci-ai/cli     # package name and binary name differ
divinci auth login           # opens a browser
divinci auth whoami
```

⚠️ **Leave `DIVINCI_API_KEY` unset.** The CLI prefers an API key over the OAuth
session whenever one is in the environment, and account-level operations —
`workspace create` above all — only work on OAuth. A key in the shell produces
an auth failure that reads like a login problem and is not. Unset it and
re-run before debugging anything else.

## 1. Workspace

```sh
divinci workspace create --help
divinci workspace list
divinci workspace use <workspaceId>     # sets the default for later commands
```

`workspace use` is worth doing early — most later commands take an implicit
workspace and the errors when it is unset are not obvious.

## 2. A RAG vector to hold the content

```sh
divinci rag targets create --help
divinci rag targets list
```

The vector's embedding model is fixed **at creation**. Mixing embedding models
inside one vector breaks similarity search — vectors from different models are
not comparable even at the same dimensionality — so pick deliberately rather
than changing it later.

## 3. Crawl a site into it

```sh
divinci rag estimate <files...>          # cost first; uploads nothing

divinci rag crawl https://example.com \
  --vector <collectionId> \
  --multi --sitemap --limit 50 \
  --exclude-paths /blog,/events

divinci rag crawl-status example.com     # no polling, no new crawl
divinci rag files                        # what actually landed
```

Useful flags: `--include-paths` / `--exclude-paths` to scope, `--limit` as a
hard page budget, `--ignore-saved` to skip pages already stored for that host.

⚠️ **Crawling someone else's site is governed by more than this CLI.** Read
`policies/crawl-policy.md` in this repo — robots.txt, 1 req/sec, an identified
user-agent, a page budget, and no auth-walled or user-generated content. The
`divinci-demo-pipeline-run` skill covers the rest.

If the site is JS-rendered or bot-protected, the default fetch scraper returns
little; pass a browser-rendering `--scraper`.

## 4. Verify retrieval before building anything on it

The step people skip, and the one that catches an empty corpus:

```sh
divinci rag files                 # is anything indexed at all?
divinci rag search "<a question the site should answer>"
```

A vector that indexed pages but returns nothing is the common failure. Find it
here, not in a demo you have already sent someone.

## 5. Release

```sh
divinci release create --name "Example demo" --assistant-id @cf/deepseek-ai/deepseek-v4-flash-0731
divinci release list
divinci release get <releaseId>
divinci release update <releaseId> --help      # attach the RAG vector
divinci release publish <releaseId>            # DRAFT -> live
```

The recommended demo assistant is `@cf/deepseek-ai/deepseek-v4-flash-0731`
(Cloudflare Workers AI DeepSeek V4 Flash) — it is the platform's current
default for new demo releases, is not subject to the AI Studio spend cap that
has bitten Gemini-backed releases, and answers from the attached RAG vector
without a fine-tune. Any registered id works; pass `--fallback-assistants`
on `release update` to add an ordered fallback chain (e.g. Gemma 4, then a
Gemini model) so a single provider outage does not take the demo down.

A release is a **draft** until published. `publish` is the step that makes it
reachable, so treat it as the moment the demo becomes public.

## 6. Optional: check it before it goes out

```sh
divinci qa suites --help                 # build a QA suite
divinci qa estimate-run --help           # what a sweep will cost
divinci qa run <suiteId> --help
divinci trust --help                     # signed, verifiable evaluation runs
```

A QA sweep before publishing is worth the cost on anything customer-facing —
`estimate-run` tells you that cost before you commit to it. `trust` produces a
TrustBench manifest: the same run, cryptographically signed, so the result can
be verified later by someone who did not run it.

## Teardown

```sh
divinci release delete <releaseId>
divinci workspace delete
```

Deleting the workspace removes its derived vectors. If you crawled someone
else's site and they object, crawl-policy rule 6 asks for this **the same day**.

## Beyond the demo path

`divinci --help` lists the full surface. Others worth knowing: `trust`
(TrustBench signed evaluation runs), `docs` (add an Ask-Divinci assistant to a
docs site), `training-data` / `fine-tune`, `audio` (transcripts), `hermes`
(hosted agents), `arena-preset` + `qa arena-run` (compare release variants).
