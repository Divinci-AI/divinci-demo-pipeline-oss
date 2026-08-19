# Target: Local — your machine does the work, only vectors leave

Crawl, chunk and embed **on this computer**, then push the finished vectors to
your Divinci workspace. Nothing but the vectors goes over the network, the
embedding is free, and it works offline right up to the sync.

```
  your laptop                                   │  Divinci
                                                │
  crawl ──► chunk ──► embed (Ollama)  ──────────┼──► Vectorize RagVector
   fetch     shared     embeddinggemma          │     (upsert by content hash)
             chunker    768-d, on-device        │
                                                │
  ⟵────────── the page text never leaves ───────┤
```

This is the same shape as the PixelRAG desktop path: ingest and embed locally
against Ollama, then sync precomputed vectors up.

## Why you might want this

- **Embedding costs nothing.** No per-token spend, no rate limits, no quota.
- **The text stays put.** Only 768-float vectors and their source URLs are
  uploaded. For a corpus you cannot send to a third party, that is the whole
  argument.
- **It is genuinely the same vector space.** Ollama's `embeddinggemma` is the
  model Cloudflare serves as `@cf/google/embeddinggemma-300m`, and the chunker
  is imported from [the Cloudflare target](../cloudflare/src/chunk.js) rather
  than copied. A corpus can be built locally, on the edge, or half each, and
  retrieval still works.
- **Re-running is free and safe.** Every row is keyed by content hash and
  Vectorize upserts by id, so a re-crawl writes only what actually changed and
  a crashed run is resumed by running it again. There is no session state.

## Setup

```sh
ollama serve                      # if it is not already running
ollama pull embeddinggemma        # ~600 MB, once

divinci auth login                # the CLI session this reuses

cd targets/local
npm run check
```

`check` verifies both halves and prints what to do about either:

```
✅ Ollama: embeddinggemma (768-d) at http://127.0.0.1:11434
✅ Divinci session: profile:default (you@example.com) → https://api.divinci.app

Ready.
```

**No new credential is introduced.** This reads the `divinci` CLI's own OAuth
session, which renews itself — so an unattended run keeps working until the
refresh token is revoked. `DIVINCI_TOKEN` overrides it for CI.

## Run it

```sh
# Everything except the upload — crawl, chunk, embed, report. Costs nothing.
node src/cli.mjs run https://example.com --limit 50 --dry-run

# For real
node src/cli.mjs run https://example.com --whitelabel <whitelabelId> --limit 50
```

```
── crawl example.com (limit 50) ──
   12 pages kept of 96 discovered (0 disallowed, 2 failed, 1 too thin)

── chunk ──
   58 unique chunks (coalesced from 1204 fragments)

── embed (embeddinggemma, on this machine) ──
   58 vectors, 768-d — cost: nothing, and none of the text left this machine

── sync → https://api.divinci.app ──
   vector 6a1c…
✅ example.com: 58 chunks synced to vector 6a1c…
```

| flag | |
|---|---|
| `--whitelabel <id>` | required for a real run; the workspace the vector is created in |
| `--limit N` | page cap (default 100) — always enforced |
| `--delay MS` | pause between requests (default 500) |
| `--dry-run` | do everything except upload |
| `--profile P` | which `divinci` CLI profile to use |

There is **no default whitelabel**, deliberately. A default there would sync
your corpus into somebody else's workspace and succeed while doing it.

## Two things this does not do

**It does not render JavaScript.** This is plain `fetch`, because the point is
that it runs with nothing installed but Node and Ollama. A JS-rendered site
yields little or nothing here — use [the Cloudflare target](../cloudflare),
which crawls through Browser Rendering. The run tells you when this happens
rather than silently indexing an empty shell.

**It answers the access question, not the AI-rights question.** `robots.txt`
`Disallow` rules are honoured. Whether a site has *reserved its content against
AI use* — `Content-Signal`, `ai-input=no`, inference-time agent blocks — is a
separate and stricter question, and it is the Cloudflare target's
[`ai-rights.js`](../cloudflare/src/ai-rights.js) that answers it. If you are
crawling sites you do not own, read that gate first.

## Coalescing, and why the chunker is not changed

`chunkMarkdown` splits on blank lines, which is correct for the markdown it was
written for. HTML-derived text is not that: a nav menu, a footer and a link list
each become one short "paragraph" per item, so the chunker faithfully emits one
chunk per menu entry. Measured on a real homepage, 11,585 characters produced
**170 chunks with sizes down to 7 bytes** — units that embed to noise and cost
an embedding and a row each.

[`coalesce.mjs`](src/coalesce.mjs) merges adjacent fragments up to a useful size
before embedding. On that same page: **170 chunks → 6**, median 26 bytes → 2,033.

It lives here rather than in the shared chunker on purpose. That module is used
verbatim by the Cloudflare target, whose input really is markdown, and changing
it would silently re-chunk that corpus into a different shape from every corpus
already published from it.

## Tests

```sh
./test/run-all.sh     # no network, no Ollama, no credentials
```

Two bugs in the first draft of the crawler are pinned there, because both
reported success while producing nothing usable:

- **Unquoted attribute values.** Minified HTML emits `href=/blog/post/` with no
  quotes. A pattern requiring `["']` found **zero links in 124 anchors**, so the
  crawler indexed exactly one page of every minified site and called it done.
- **`<a` inside minified JavaScript.** `for(var b=0;b<a.length;b++)` matches an
  anchor pattern. Scripts are now stripped before scanning.
