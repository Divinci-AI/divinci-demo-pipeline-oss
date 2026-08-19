# Target: Cloudflare — the all-edge crawl → publish pipeline

A Worker + Workflow that takes a hostname and produces a retrievable, cited,
per-site corpus. Crawl, chunk, embed, store and register all happen on
Cloudflare's edge; **no laptop is in the loop** and nothing needs to stay awake.

```
  hostname
     │
     ▼  robots.txt + Content-Signal          ai-rights.js   ← refuses here, before spending
  AI-RIGHTS GATE
     │
     ▼  Browser Rendering /crawl             ~$0.0007/host
  CRAWL ──────────────► R2 (raw pages, frontier, link map)
     │
     ▼  chunk.js (~40 lines)
  CHUNK
     │
     ▼  Workers AI  @cf/google/embeddinggemma-300m (768-d)
  EMBED
     │
     ▼  Turso: one database per site, DiskANN index
  STORE
     │
     ▼  Divinci REST: BYOK key → RagVector → release
  PUBLISH
```

Every step is an HTTP call or trivial string work, which is why there is no
container fleet and no queue runner to operate.

## Why you might want this

- **A retrieval index per site, not one blended index.** Each host gets its own
  database, its own embeddings and its own citations. Nothing is trained on.
- **It is cheap.** A crawl is ~$0.0007 of Browser Rendering per host. The
  pipeline this replaced cost ~100× that per site by crawling from a laptop.
- **It runs itself.** The cron is a *top-up*, not a batch: each tick refills the
  fleet to `MAX_CONCURRENT`, so ticks cannot stack and the launch rate is set by
  how fast crawls finish rather than by how often you look.
- **It asks first.** The AI-rights gate reads `robots.txt` and `Content-Signal`
  before anything is spent, and distinguishes a refusal of *training* (not what
  this does) from a refusal of *inference-time retrieval* (exactly what this
  does). See [the gate](#the-ai-rights-gate) below — it is the part worth
  reading before you point this at the open web.

## Two modes

The mode is inferred from `DIRECTORY_URL` rather than being its own flag, so the
two can never disagree.

| | `DIRECTORY_URL` unset — **own corpus** | `DIRECTORY_URL` set — **shared directory** |
|---|---|---|
| Who else writes to the corpus | nobody | other deployments |
| Dedupe authority | this Worker's R2 `seeds/done/` set | the directory, fetched before each publish |
| Network call to dedupe | none | one, and it **fails closed** |
| Sites registered publicly | no | yes, with `WWW_RAG_THEME_WEBHOOK_SECRET` |

**Own corpus** is the default and what you want for your own index. **Shared
directory** is how you contribute to the
[Open Web Vectors Initiative](https://divinci.ai/open-web-vectors/) — a public,
per-site retrieval index where every site has its own vectors and any site owner
can claim theirs.

> ⚠️ Do **not** point a private deployment at somebody else's directory. It will
> skip every host *they* have published, and you will quietly build the wrong
> corpus. The variable is the mode.

## Setup

```sh
cd targets/cloudflare
npm install

cp wrangler.example.jsonc wrangler.jsonc     # gitignored
npx wrangler r2 bucket create <your-bucket>
```

Edit `wrangler.jsonc` — four values are marked `⬅ CHANGE ME`:

| | |
|---|---|
| `name` | becomes `<name>.<your-subdomain>.workers.dev` |
| `r2_buckets[0].bucket_name` | the bucket you just created |
| `vars.TURSO_ORG` | your Turso organisation slug |
| `vars.WHITELABEL_ID` | the Divinci whitelabel that will own the vectors |

Then the secrets:

```sh
for s in CF_ACCOUNT_ID CF_BROWSER_TOKEN TURSO_PLATFORM_TOKEN DIVINCI_API_KEY TRIGGER_TOKEN; do
  npx wrangler secret put "$s"
done
```

**There are no defaults for any of these, deliberately.** A default that is
merely wrong fails on the first call; a default naming a real resource that
belongs to someone else *succeeds*, and you get no signal that your sites landed
in a stranger's account. The Worker refuses to tick without them and says which
are missing:

```sh
npx wrangler deploy
curl https://<worker>.<subdomain>.workers.dev/health
# {"ok":false,"configured":false,"missing":["TURSO_ORG","CF_BROWSER_TOKEN"]}
```

`/health` stays open and answers even when unconfigured — it is the endpoint you
use to find out why. `/run` and `/status` are token-gated (`/status` because a
workflow result carries a site's database URL).

### First run

The cron is **commented out in the example config**. Prove one host by hand
first; a cron on a fresh deployment starts crawling the moment it deploys.

```sh
export PIPELINE_URL=https://<worker>.<subdomain>.workers.dev
export TRIGGER_TOKEN=<the bearer you set>

./run-batch.sh example.com              # dry run — shows what WOULD be sent
./run-batch.sh --go example.com         # send it
curl -H "Authorization: Bearer $TRIGGER_TOKEN" "$PIPELINE_URL/status"
```

Prefer `run-batch.sh` over hand-rolled curl: it carries the in-flight guard. A
host that is *mid-run* is not published yet — registration is the last step — so
any "is it done?" check happily re-offers it, and sending it twice builds two
vectors and two releases for one site. (Found the hard way: `archive.org` showed
up as a fresh candidate while it was still crawling.)

Happy with it? Uncomment `triggers.crons` and redeploy.

### Be reachable

```jsonc
"CRAWLER_CONTACT_URL": "https://yourdomain.example/bot"
```

This goes in the User-Agent presented to every site whose `robots.txt` is read.
It is unset by default and the crawler then says so out loud rather than naming
anyone. Set it: a crawler that cannot be contacted cannot be asked to stop, and
that is the deal [`policies/crawl-policy.md`](../../policies/crawl-policy.md)
makes with site owners.

## The AI-rights gate

The gate that decides whether a host may be indexed at all, in
[`src/ai-rights.js`](src/ai-rights.js). The distinction it turns on:

> This builds a retrieval index over a site's own content and cites it. It does
> not train. A host that refuses **training** has not refused this.

Conflating those is wrong in *both* directions — it declines work sites
permitted, and it buries the refusals that genuinely are about this use.

| robots.txt / Content-Signal | verdict |
|---|---|
| `User-agent: GPTBot` + `Disallow: /` | **allowed** — training crawler, not this use (recorded as a note) |
| `Content-Signal: search=yes, ai-train=no` | **allowed** — this is precisely what was permitted |
| `Content-Signal: ai-input=no` | **refused** — inference-time use, i.e. this |
| `Content-Signal: search=no` | **refused** — declines indexing at all |
| `User-agent: Claude-User` + `Disallow: /` | **refused** — an inference-time agent |
| `User-agent: *` + `Disallow: /` | **refused** — every crawler, this one included |
| robots.txt 403/405/429 | **unverifiable** — the host declined to state its rules |
| robots.txt 404/410 | **allowed** — an absent file is a real answer |

Three outcomes, not two. A host that *refuses to tell you* is not a host with no
restrictions, and treating it as one publishes a false claim about them.
`dspace.mit.edu` 405s every non-browser client and was once published on the
strength of a `robots.txt` nobody ever read.

`POST /withdraw` exists for the other direction: a site whose owner refuses
after the fact is deprecated, delisted and **its database destroyed**. That is
irreversible and needs `TRIGGER_TOKEN` plus an explicit `confirm: true`.

## Cost

The crawl response carries `browserSecondsUsed`, so cost is attributable
per job rather than inferred from an account-wide metric:

```json
{"records":25,"usable":20,"cancelled":0,"browserSeconds":28.47,"usd":0.00071}
```

Embeddings are Workers AI, storage is Turso, the frontier and raw pages are R2.
Set `MAX_CONCURRENT` low (the example ships `8`) until you have watched a few
runs — 64 is a warmed-up fleet, not a starting point.

## Tests

```sh
./test/run-all.sh     # no network, no credentials, no account
```

Two upstream tests were **dropped rather than shipped broken**: both were parity
checks against implementations in a private repository, and parity with
something absent proves nothing. The AI-rights gate — whose only coverage that
was — has real unit tests here instead, and `no-account-defaults.test.mjs`
guards the three values that used to name the originating deployment.

## What this does not do

- **No fine-tuning, no demo generation, no outreach.** That is the orchestrator;
  this target is the crawl-and-index half.
- **No JS-heavy-site special-casing beyond Browser Rendering.** Pages the
  renderer cannot read are the main limit on coverage, and improving that is the
  most useful thing to contribute.
- **No sitemap discovery.** The frontier grows from links found while crawling,
  plus whatever you submit.
