import { WorkflowEntrypoint } from "cloudflare:workers";
import { chunkMarkdown } from "./chunk.js";
import { coalesceChunks } from "./coalesce.js";
import { registerVector, divinci } from "./divinci.js";
import { checkAiRights } from "./ai-rights.js";
import { recordPublish, listEvents, pruneEvents, buildSnapshot, reportActivity, writePendingCount, readPendingCount } from "./activity.js";
import { submitHost } from "./submit.js";
import { withdrawHost } from "./withdraw.js";
import { fetchPublishedHosts } from "./directory.js";
import { crawlBudgetVerdict } from "./crawl-budget.js";
import { checkConfig, assertConfigured } from "./require-env.js";
import {
  PENDING, DONE, INFLIGHT, extractHosts, isPlausibleHost, isJunkHost, listKeys, isStale, claimHost,
} from "./frontier.js";
import { writeLinkMap, countOutbound, linkMapKey } from "./linkmap.js";
import {
  buildReleaseBody, createDraft, updateDraft, publishDraft, getRelease,
  fetchTheme, registerSite,
} from "./release.js";
import {
  createDatabase, mintDatabaseToken, destroyDatabase,
  pipeline, SCHEMA, insertChunkSQL, sqlStr,
} from "./turso.js";

const CF_API = "https://api.cloudflare.com/client/v4";
const EMBED_MODEL = "@cf/google/embeddinggemma-300m";
const EMBED_DIM = 768;

// Cost of a browser-second, used only to turn `browserSecondsUsed` into a
// number a human can read. Cloudflare bills $0.09/browser-hour.
const USD_PER_BROWSER_SEC = 0.09 / 3600;

// Batch sizes. Embedding is capped by the AI binding's per-call input list;
// the SQL batch is well under Turso's documented ~1000-statement bulk shape and
// keeps each pipeline body small enough to retry cheaply.
const EMBED_BATCH = 96;
const SQL_BATCH = 128;

const slugify = (host) => host.replace(/^www\./, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase();

/** L2-normalise, matching turso.rs's normalize(v). Cosine distance over
 *  un-normalised vectors is not the metric the retrieval side assumes. */
function normalize(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  if (!n) return v;
  return v.map((x) => x / n);
}


/** Browser Rendering crawl endpoint + auth, shared by the submit/poll/collect steps. */
const crawlBase = (env) => `${CF_API}/accounts/${env.CF_ACCOUNT_ID}/browser-rendering/crawl`;
const crawlHeaders = (env) => ({
  Authorization: `Bearer ${env.CF_BROWSER_TOKEN}`,
  "Content-Type": "application/json",
});

export class SitePipeline extends WorkflowEntrypoint {
  /** Mint a fresh database token for the duration of one step. Cheap (one API
   *  call, stateless JWT) and it keeps the credential out of every persisted
   *  step output. Do NOT hoist this into a step return value. */
  dbToken(dbName) {
    return mintDatabaseToken({
      org: this.env.TURSO_ORG,
      token: this.env.TURSO_PLATFORM_TOKEN,
      name: dbName,
    });
  }

  /**
   * Retire a host from the frontier and release its claim.
   *
   * Called for EVERY terminal outcome, refusals included. A host that says no
   * is as terminal as one we published — leaving it pending means re-asking it
   * on every cron tick forever, which is both wasteful and rude.
   */
  async retire(host, reason, extra = {}) {
    try {
      // ⚠️ `extra` carries the vectorId and releaseId on a PUBLISH, and it is
      // not bookkeeping — it is what makes a takedown possible later.
      //
      // In shared-directory mode the directory can be asked which release a
      // host was published as. In own-corpus mode there is no directory, and
      // nothing else records the pair — `recordPublish` stores only host,
      // pages, chunks and a timestamp. Without this, an own-corpus deployment
      // could crawl a site and then have no way to honour "please remove me",
      // which is not an acceptable property for a crawler to ship with.
      await this.env.BUCKET.put(DONE + host, JSON.stringify({ reason, at: Date.now(), ...extra }));
      await this.env.BUCKET.delete(PENDING + host);
      await this.env.BUCKET.delete(INFLIGHT + host);
    } catch { /* frontier bookkeeping must never fail a real publish */ }
  }

  /**
   * A host we could not process THIS time, but might next time.
   *
   * Transient (429, a flaky DNS) and permanent (403 forever) look identical in
   * a single observation, so the only honest way to tell them apart is to
   * count. Release the claim and leave it pending; tombstone only once it has
   * had MAX_ATTEMPTS goes. Retiring on the first failure loses hosts that were
   * merely rate-limited; never retiring re-crawls a brick wall forever.
   */
  async deferOrRetire(host, reason) {
    const MAX = Number(this.env.MAX_ATTEMPTS ?? 3);
    try {
      const o = await this.env.BUCKET.get(PENDING + host);
      const rec = o ? await o.json().catch(() => ({})) : null;
      if (!rec) { await this.env.BUCKET.delete(INFLIGHT + host); return { deferred: false }; }
      const attempts = Number(rec.attempts ?? 0) + 1;
      if (attempts >= MAX) {
        await this.retire(host, `${reason} (after ${attempts} attempts)`);
        return { deferred: false, attempts };
      }
      await this.env.BUCKET.put(PENDING + host,
        JSON.stringify({ ...rec, attempts, lastReason: reason, lastAt: Date.now() }));
      await this.env.BUCKET.delete(INFLIGHT + host);
      return { deferred: true, attempts };
    } catch {
      return { deferred: false };
    }
  }

  async run(event, step) {
    const { host, limit = 100, maxAge = 0, publish = false, allowRepublish = false } = event.payload;
    const slug = slugify(host);
    // ⛔ NOT `www-rag-<slug>`. That is the laptop pipeline's live namespace, and
    // the provision step below DESTROYS the database before creating it (so a
    // replayed step cannot fail on its own earlier attempt). Sharing the
    // namespace would make a re-run of any already-published host delete that
    // site's production database. The plan requires both pipelines running in
    // parallel until this one is proven, so they must not be able to collide.
    // Rename only at cutover, once the laptop daemon is decommissioned.
    const dbName = `wrp-${slug}`;
    const rawKey = `sites/${slug}/raw.json`;
    const chunkKey = `sites/${slug}/chunks.json`;

    // ── 0a. Already published? ──────────────────────────────────────────────
    // Only when we intend to publish — a staging run may legitimately re-crawl
    // a published host. FAILS CLOSED: an unreachable directory means we cannot
    // tell, and guessing "new" duplicates the entire corpus.
    // `allowRepublish` is PER RUN, deliberately — the env-var form is a fleet-wide
    // switch, and the only way to use it was to flip it on, run four hosts, and
    // remember to flip it back, with the cron firing every two minutes in
    // between. A per-run flag cannot be left on by accident.
    if (publish && !allowRepublish && !this.env.ALLOW_REPUBLISH) {
      const dir = await step.do("directory-check", async () => {
        const { ok, hosts, count, local } = await fetchPublishedHosts(this.env);
        // OWN-CORPUS mode: there is no remote directory, so this worker's own
        // R2 tombstone is the record of what it has published. Without this
        // branch an empty host set would read as "never published" and every
        // re-request of a finished host would build a second vector and a
        // second release for the same site.
        if (local) {
          const already = Boolean(await this.env.BUCKET.head(DONE + host));
          return { ok: true, count: 0, already, local: true };
        }
        return { ok, count, already: ok && hosts.has(host), local: false };
      });
      if (!dir.ok) {
        return { host, slug, status: "directory-unavailable",
          reason: "directory empty or unreachable — refusing to treat this host as new" };
      }
      if (dir.already) {
        await this.retire(host, "already-published");
        return { host, slug, status: "already-published", directorySites: dir.count };
      }
    }

    // ── 0b. AI-rights gate ───────────────────────────────────────────────────
    // Runs BEFORE the crawl deliberately: a host that refuses our use should
    // cost it zero browser-seconds, and asking permission after taking the
    // content is not asking permission.
    const rights = await step.do("ai-rights", async () => {
      const r = await checkAiRights(host, this.env);
      // ── Persist the verdict, always, whatever it says ───────────────────
      // This was computed and then discarded into a step result, which meant
      // the one fact nobody else can reconstruct — what a host told us about
      // AI use, on the date we asked — existed only inside a workflow that
      // ages out. It is the field that makes the public manifest worth
      // publishing, and it is the ONLY basis on which a text-bearing dataset
      // could ever be filtered to hosts that permit training.
      //
      // Written for refusals too: "nytimes.com reserved AI use on 2026-08-18"
      // is exactly as valuable as a permission, and a dataset that records
      // only the yeses is a dataset that cannot prove it asked.
      try {
        await this.env.BUCKET.put(`rights/${host}.json`, JSON.stringify({
          host,
          reserved: r.reserved,
          trainOnly: r.trainOnly,
          verifiable: r.verifiable,
          httpStatus: r.status,
          contentSignal: r.contentSignal ?? "",
          reasons: r.reasons ?? [],
          via: r.via ?? "direct",
          checkedAt: new Date().toISOString(),
        }));
      } catch { /* never fail a crawl over bookkeeping */ }
      return r;
    });
    if (rights.reserved) {
      await this.retire(host, "ai-reserved");
      return { host, slug, status: "ai-reserved", reasons: rights.reasons, rights };
    }
    // ⚠️ "No restriction found" is NOT "no restriction exists" when we never
    // managed to read robots.txt. This loop runs unattended, so it must not
    // claim a permission it could not verify — dspace.mit.edu was published on
    // the strength of a robots.txt that no request of ours ever retrieved.
    // Deferred rather than retired: a 429 clears, a 403 does not, and one
    // observation cannot tell them apart.
    if (!rights.verifiable && !this.env.ALLOW_UNVERIFIED_ROBOTS) {
      const d = await this.deferOrRetire(host, "robots-unverifiable");
      return {
        host, slug, status: "robots-unverifiable",
        reason: rights.unverifiableReason,
        httpStatus: rights.status, ...d,
      };
    }

    // ── 1. Crawl ────────────────────────────────────────────────────────────
    // Returns only counters. The records themselves go to R2: a large host's
    // markdown is far past what a Workflow step result should carry, and step
    // results are persisted on every replay.
    // ── 1. Crawl ────────────────────────────────────────────────────────────
    // ⛔ DO NOT poll inside a single step.do(). A Workflows step is capped at
    // ~5 MINUTES of wall-clock, and exceeding it fails the step with a bare
    // "WorkflowInternalError: Attempt failed due to internal workflows error"
    // that names neither the cap nor the step's own timeout. The previous
    // version polled to a 25-minute deadline inside one step and declared
    // `timeout: "30 minutes"`, which the platform could never honour — so every
    // site whose crawl took over 5 minutes was structurally impossible to
    // ingest, while small sites succeeded and made it look intermittent.
    // Measured 2026-08-17: automattic.com failed twice, each attempt exactly
    // 5m00s.
    //
    // The correct shape is submit → sleep → short poll → repeat. step.sleep()
    // suspends the instance and costs no step duration, so the 25-minute budget
    // is spent sleeping rather than running.
    const job0 = await step.do("crawl-submit", async () => {
      const started = await (await fetch(crawlBase(this.env), {
        method: "POST",
        headers: crawlHeaders(this.env),
        body: JSON.stringify({
          url: `https://${host}/`,
          limit,
          formats: ["markdown"],
          render: true,
          // Honest declaration of intent — we index for search and feed
          // retrieval grounding, we do not train. Cloudflare surfaces this to
          // publishers via Content Signals.
          crawlPurposes: ["search", "ai-input"],
          maxAge,
          options: { includeSubdomains: true },
        }),
      })).json();
      if (!started.success) throw new Error(`submit failed: ${JSON.stringify(started.errors)}`);
      return { jobId: started.result };
    });

    const POLL_MS = Number(this.env.CRAWL_POLL_MS ?? 30_000);
    const MAX_POLLS = Number(this.env.CRAWL_MAX_POLLS ?? 50);
    const DEADLINE_MS = Number(this.env.CRAWL_DEADLINE_MS ?? 25 * 60 * 1000);
    const GRACE_MS = Number(this.env.CRAWL_GRACE_MS ?? 5 * 60 * 1000);

    let final = null;
    let progress = "unknown";
    for (let i = 0; i < MAX_POLLS; i++) {
      await step.sleep(`crawl-wait-${i}`, `${Math.round(POLL_MS / 1000)} seconds`);
      const poll = await step.do(`crawl-poll-${i}`, async () => {
        const r = await (await fetch(`${crawlBase(this.env)}/${job0.jobId}`,
          { headers: crawlHeaders(this.env) })).json();
        if (!r.success) throw new Error(`poll failed: ${JSON.stringify(r.errors)}`);
        const j = r.result;
        return { status: j.status, finished: j.finished ?? 0, total: j.total ?? 0 };
      });
      progress = `${poll.finished}/${poll.total}`;
      if (["completed", "errored", "cancelled"].includes(poll.status)) { final = poll; break; }

      // Give up EARLY on a frontier we cannot finish. Elapsed is derived from
      // the poll count rather than Date.now(): a step result is replayed on
      // resume, so wall-clock inside the workflow body is not trustworthy.
      const verdict = crawlBudgetVerdict({
        elapsedMs: (i + 1) * POLL_MS, done: poll.finished, total: poll.total,
        deadlineMs: DEADLINE_MS, graceMs: GRACE_MS,
      });
      if (verdict.abort) {
        await this.deferOrRetire(host, "crawl-budget");
        throw new Error(verdict.reason);
      }
    }

    if (!final || final.status !== "completed") {
      await this.deferOrRetire(host, "crawl-incomplete");
      // ⚠️ Always report progress. "status=running" alone is undiagnosable —
      // it cannot distinguish a host that rendered 149 of 150 from one that
      // rendered none.
      throw new Error(
        `crawl did not complete (status=${final?.status ?? "timeout"}, progress=${progress})`,
      );
    }

    const crawled = await step.do("crawl-collect", async () => {
      const base = crawlBase(this.env);
      const headers = crawlHeaders(this.env);
      const r0 = await (await fetch(`${base}/${job0.jobId}`, { headers })).json();
      const job = r0.result;

      // ⚠️ Responses over 10 MB paginate. Without following the cursor a large
      // host silently yields only its first page — "succeeded and produced
      // almost nothing", which is the failure shape this pipeline keeps hitting.
      let records = job.records ?? [];
      let cursor = job.cursor;
      while (cursor) {
        const r = await (await fetch(`${base}/${job0.jobId}?cursor=${encodeURIComponent(cursor)}`, { headers })).json();
        if (!r.success) break;
        records = records.concat(r.result.records ?? []);
        cursor = r.result.cursor;
      }

      const good = records.filter(
        (x) => (x.metadata || {}).status === 200 && (x.markdown || "").trim(),
      );
      // Cancellations mean the crawler gave up, which is a real fault. A low
      // yield with ZERO cancellations is just a small or JS-heavy site, and
      // refusing there once protected a 161-byte corpus from being replaced by
      // nothing — so it warns rather than throws.
      const cancelled = records.filter((x) => (x.metadata || {}).status === 0).length;
      if (records.length >= 5 && cancelled / records.length > 0.5) {
        throw new Error(`${host}: ${cancelled}/${records.length} records cancelled — crawler fault`);
      }
      if (!good.length) {
        // ⚠️ Name the HOST and the counts. An unattended fleet surfaces this
        // as a bare workflow error with output:null, so without the host it
        // takes three commands and a cross-reference to learn which site
        // failed — and "no usable records" alone cannot distinguish a site
        // that returned nothing from one that returned 100 non-200s.
        const statuses = {};
        for (const r of records) {
          const c = (r.metadata || {}).status ?? "none";
          statuses[c] = (statuses[c] ?? 0) + 1;
        }
        throw new Error(
          `${host}: no usable records from ${records.length} crawled ` +
          `(statuses ${JSON.stringify(statuses)}) — refusing to write an empty bundle`,
        );
      }

      await this.env.BUCKET.put(rawKey, JSON.stringify(good.map((r) => ({
        url: r.url,
        markdown: r.markdown,
        title: r.metadata?.title || r.url,
      }))));

      const browserSeconds = job.browserSecondsUsed ?? 0;
      return {
        records: records.length,
        usable: good.length,
        cancelled,
        browserSeconds,
        usd: +(browserSeconds * USD_PER_BROWSER_SEC).toFixed(5),
      };
    });

    // ── 2. Chunk + corpus floor ─────────────────────────────────────────────
    const chunked = await step.do("chunk", async () => {
      const pages = JSON.parse(await (await this.env.BUCKET.get(rawKey)).text());
      const rows = [];
      const seen = new Set(); // dedup by text, matching ingest_okf
      for (const p of pages) {
        // Coalesce PER PAGE, never across pages: merging the tail of one page
        // into the head of the next would produce a chunk whose `url` citation
        // is wrong for half its text, and citations are the point.
        for (const text of coalesceChunks(chunkMarkdown(p.markdown))) {
          if (seen.has(text)) continue;
          seen.add(text);
          rows.push({ url: p.url, text, category: "" });
        }
      }
      await this.env.BUCKET.put(chunkKey, JSON.stringify(rows));
      const bytes = rows.reduce((n, r) => n + r.text.length, 0);
      const urls = new Set(rows.map((r) => r.url)).size;
      return { chunks: rows.length, bytes, urls };
    });

    // The publish floor, ported verbatim from auto-publish-new.sh. Conjunctive:
    // a site must clear BOTH, or a single long page passes as a corpus.
    const minBytes = Number(this.env.MIN_CHUNK_BYTES ?? 5000);
    const minUrls = Number(this.env.MIN_PAGES ?? 3);
    if (chunked.bytes < minBytes || chunked.urls < minUrls) {
      await this.deferOrRetire(host, "below-floor");
      return {
        host, slug, status: "below-floor",
        reason: `${chunked.bytes}B / ${chunked.urls} url(s) < ${minBytes}B / ${minUrls}`,
        crawled, chunked,
      };
    }

    // ── DENSITY floor ───────────────────────────────────────────────────────
    // The two absolute floors above are both satisfied by a large number of
    // nearly-empty pages, which is precisely what a JS-rendered app yields when
    // the crawler gets shells instead of content. bsky.app published at 226
    // B/page across 96 pages — clearing 5000B and 3 pages comfortably while
    // containing nothing anyone could retrieve. The directory's healthy median
    // is ~4,662 B/page, and the worst offender in the existing corpus is
    // www.acmeback.com at 7 B/page across 800 pages.
    //
    // Mean density is the cheap discriminator: a real site cannot average a
    // few hundred bytes of prose per page. Deferred rather than retired — a
    // site that was mid-deploy or rate-limited deserves another look.
    const minDensity = Number(this.env.MIN_BYTES_PER_PAGE ?? 500);
    const density = chunked.urls ? chunked.bytes / chunked.urls : 0;
    if (density < minDensity) {
      const d = await this.deferOrRetire(host, "below-density-floor");
      return {
        host, slug, status: "below-density-floor",
        reason: `${Math.round(density)} B/page across ${chunked.urls} pages ` +
          `(< ${minDensity} B/page) — pages rendered but carry no text, ` +
          `typically a JS app the crawler could not read`,
        crawled, chunked, ...d,
      };
    }

    // ── 3. Provision ────────────────────────────────────────────────────────
    const db = await step.do("provision", async () => {
      const org = this.env.TURSO_ORG;
      const token = this.env.TURSO_PLATFORM_TOKEN;
      // Idempotent across replays: a retried step must not fail on a database
      // its own earlier attempt created.
      await destroyDatabase({ org, token, name: dbName });
      const { host: dbHost, url } = await createDatabase({
        org, token, name: dbName, group: this.env.TURSO_GROUP || "default",
      });
      const jwt = await mintDatabaseToken({ org, token, name: dbName });
      await pipeline({ host: dbHost, token: jwt, stmts: SCHEMA });
      // ⛔ The database JWT is NOT returned. A Workflow STEP output is
      // persisted in workflow state and is readable by anyone who can call
      // `wrangler workflows instances describe` or this Worker's /status — so
      // returning it here published the site's write credential in plaintext.
      // Steps below mint their own short-lived token instead (see dbToken()).
      // Keeping it out of the final result is not enough; the step is the leak.
      return { dbHost, url };
    });

    // ── 4. Embed + write ────────────────────────────────────────────────────
    const rows = JSON.parse(await (await this.env.BUCKET.get(chunkKey)).text());
    let written = 0;
    for (let i = 0; i < rows.length; i += SQL_BATCH) {
      const slice = rows.slice(i, i + SQL_BATCH);
      const n = await step.do(`embed+write ${i}`, async () => {
        const vectors = [];
        for (let j = 0; j < slice.length; j += EMBED_BATCH) {
          const texts = slice.slice(j, j + EMBED_BATCH).map((r) => r.text);
          const out = await this.env.AI.run(EMBED_MODEL, { text: texts });
          for (const v of out.data) {
            if (v.length !== EMBED_DIM) {
              throw new Error(`embedding dim ${v.length} != ${EMBED_DIM} — wrong model`);
            }
            vectors.push(normalize(v));
          }
        }
        const stmts = slice.map((r, k) => insertChunkSQL({
          cid: i + k, website: host, url: r.url, text: r.text,
          category: r.category, embedding: vectors[k],
        }));
        await pipeline({ host: db.dbHost, token: await this.dbToken(dbName), stmts });
        return slice.length;
      });
      written += n;
    }

    // `chunks` is a STAGING table. Divinci retrieves from a table named after
    // the vector's _id, so the served table cannot be created until the vector
    // exists. Everything below is that handoff.
    if (!publish) {
      return { host, slug, status: "staged", dbUrl: db.url, crawled, chunked, written };
    }

    // ── 5. Register with Divinci ────────────────────────────────────────────
    const reg = await step.do("register", async () => registerVector(this.env, {
      slug, dbUrl: db.url, authToken: await this.dbToken(dbName), embeddingModel: EMBED_MODEL,
    }));
    const table = `chunks_vector_index_${reg.vectorId}`;
    const index = `${table}_vec`;

    // Divinci creates this table LAZILY, on the first write through its own
    // ingestion path — not when the vector is created. Nothing has written to
    // this vector yet, so we must create it or the INSERTs below hit "no such
    // table". Schema is copied verbatim from findOrCreateVectorIndex in
    // server-resources (turso-libsql/api/store.ts), including storeVersionId
    // and the UNIQUE index on vectorId that its re-upsert dedupe relies on —
    // a near-miss here would work now and corrupt a later server-side write.
    await step.do("create-served-table", async () => {
      await pipeline({
        host: db.dbHost, token: await this.dbToken(dbName),
        stmts: [
          `CREATE TABLE IF NOT EXISTS ${table} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            vectorId TEXT NOT NULL,
            chunk TEXT,
            storeVersionId TEXT,
            originalName TEXT,
            category TEXT,
            e F32_BLOB(${EMBED_DIM})
          )`,
          `CREATE UNIQUE INDEX IF NOT EXISTS ${table}_vectorId ON ${table}(vectorId)`,
        ],
      });
      return true;
    });

    // ── 6. Staging → served table ───────────────────────────────────────────
    // Batched, never one INSERT…SELECT: sqld gives interactive work a ~5s
    // transaction slot, and every host above ~1000 chunks failed
    // deterministically when this was a single statement.
    const BULK_THRESHOLD = Number(this.env.BULK_THRESHOLD ?? 1000);
    const BULK_BATCH = Number(this.env.BULK_BATCH ?? 1000);
    const LIVE_BATCH = Number(this.env.LIVE_BATCH ?? 50);
    const total = written;
    const bulkRows = Math.min(total, BULK_THRESHOLD);
    const move = (from, to) =>
      `INSERT INTO ${table} (vectorId, chunk, originalName, category, e) ` +
      `SELECT 'www-'||cid, text, url, category, e FROM chunks WHERE cid >= ${from} AND cid < ${to}`;

    for (let s = 0; s < bulkRows; s += BULK_BATCH) {
      const e = Math.min(s + BULK_BATCH, bulkRows);
      await step.do(`bulk ${s}`, async () =>
        (await pipeline({ host: db.dbHost, token: await this.dbToken(dbName), stmts: [move(s, e)] }), e - s));
    }

    // Isolated on purpose — DiskANN construction is the slow part and must
    // never share a pipeline call with a data load.
    await step.do("build-index", { timeout: "10 minutes" }, async () => {
      const opts = (this.env.DISKANN_OPTS || "compress_neighbors=float1bit,max_neighbors=16")
        .split(",").map((o) => `'${o}'`).join(", ");
      await pipeline({
        host: db.dbHost, token: await this.dbToken(dbName), attempts: 2,
        stmts: [`CREATE INDEX IF NOT EXISTS ${index} ON ${table}(libsql_vector_idx(e, ${opts}))`],
      });
      return true;
    });

    // Remainder goes in against a LIVE index (~330ms/row), so batches stay
    // small enough to finish under the gateway ceiling.
    for (let s = bulkRows; s < total; s += LIVE_BATCH) {
      const e = Math.min(s + LIVE_BATCH, total);
      await step.do(`live ${s}`, async () =>
        (await pipeline({ host: db.dbHost, token: await this.dbToken(dbName), stmts: [move(s, e)] }), e - s));
    }

    await step.do("drop-staging", async () => {
      await pipeline({
        host: db.dbHost, token: await this.dbToken(dbName),
        stmts: ["DROP TABLE IF EXISTS chunks", "DROP TABLE IF EXISTS site_centroids"],
      });
      return true;
    });

    // ── 7. Verify the SERVED table actually retrieves ───────────────────────
    // A claimed publish that serves nothing is a failure this pipeline has
    // shipped before, so this asserts against what Divinci will read — not
    // against staging, which by now no longer exists.
    const probe = await step.do("verify", async () => {
      const scalar = (r) => Number(r.results?.[0]?.response?.result?.rows?.[0]?.[0]?.value ?? 0);
      const rows = scalar(await pipeline({
        host: db.dbHost, token: await this.dbToken(dbName), stmts: [`SELECT count(*) FROM ${table}`],
      }));
      const hits = scalar(await pipeline({
        host: db.dbHost, token: await this.dbToken(dbName),
        stmts: [`SELECT count(*) FROM vector_top_k('${index}', (SELECT e FROM ${table} LIMIT 1), 5)`],
      }));
      if (rows !== total) throw new Error(`served table has ${rows} rows, expected ${total}`);
      if (hits < 1) throw new Error("index built but returns no neighbours");
      return { rows, hits };
    });

    // ── 8. Release ──────────────────────────────────────────────────────────
    // A vector with no release is a corpus nobody can reach. This is the step
    // that makes the site actually serve.
    const release = await step.do("release", async () => {
      const theme = await fetchTheme(this.env, host);
      const body = buildReleaseBody({ host, slug, vectorId: reg.vectorId, theme });
      const draft = await createDraft(this.env, body);
      const releaseId = draft._id;
      if (!releaseId) throw new Error(`draft created but no _id: ${JSON.stringify(draft).slice(0, 200)}`);

      // ⚠️ UNCONDITIONAL, even with no theme. create-release-draft destructures
      // castDraftBody WITHOUT publicResponseCache, so the field is silently
      // dropped on create and only lands via update. The laptop script makes
      // this call only `if [ -n "$THEME" ]`, so every themeless site it
      // publishes has the response cache OFF despite its body asking for it —
      // first click costs 3-6s instead of ~0.25s, and priming generates answers
      // that are never cached. Resending the same body is idempotent.
      await updateDraft(this.env, releaseId, body);

      await publishDraft(this.env, releaseId);

      // Publishing can fail validation or a free-tier cap and still return 2xx,
      // and a draft linked into the directory would mislead visitors. Assert it
      // actually left draft.
      const after = await getRelease(this.env, releaseId);
      if (!after.status || after.status === "draft") {
        throw new Error(`publish did not stick (status=${after.status ?? "unknown"})`);
      }
      return { releaseId, status: after.status, themed: !!theme };
    });

    // Link releaseId onto the WwwRagSite so the directory can serve it.
    // Non-fatal: the release is live either way, and a missing link is
    // repairable by the laptop's backfill — but it IS reported, because a
    // silently unlinked site looks published and is invisible in the directory.
    // ── Expand the frontier from what we just crawled ───────────────────────
    // The corpus names the sites it considers relevant, which is a far better
    // prior than any hand-written seed list — this is what makes the pipeline
    // self-feeding rather than laptop-fed. Best-effort: discovery must never
    // fail a publish that already succeeded.
    const discovered = await step.do("expand-frontier", async () => {
      try {
        const raw = await this.env.BUCKET.get(rawKey);
        if (!raw) return { added: 0, reason: "no raw bundle" };
        const pages = await raw.json();
        // Per-page cap raised with SEEDS_PER_RUN: the frontier became the
        // bottleneck once concurrency reached 64 — pending drained faster than
        // discovery replaced it, so the fleet would idle against the platform's
        // limits rather than find them.
        const { seen, linkTotals } = countOutbound(pages, host, extractHosts, { perPageMax: 120 });
        // Persist the outbound graph BEFORE seeding the frontier, because the
        // seeding loop truncates to SEEDS_PER_RUN and this must not inherit
        // that cap: the frontier wants a handful of good candidates, the link
        // graph wants everything this site points at.
        //
        // Written to R2 rather than pushed anywhere: the registry is reached
        // through an HMAC fleet webhook, and that webhook is where a privilege
        // escalation lived (a meta-only call could mint a host->release link
        // and then deprecate it). Adding an internet-facing "write arbitrary
        // graph edges" verb to it to serve a visualization is not a trade worth
        // making. A local materializer reads these objects instead, so the
        // crawler needs no new authority at all.
        await writeLinkMap(this.env, slug, host, pages.length, seen, linkTotals);
        const cap = Number(this.env.SEEDS_PER_RUN ?? 25);
        const ranked = [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, cap);
        let added = 0;
        for (const [h] of ranked) {
          // Never resurrect a tombstone. A host we published, or one that
          // refused us, must not re-enter the frontier because some other
          // site links to it.
          if (await this.env.BUCKET.head(DONE + h)) continue;
          if (await this.env.BUCKET.head(PENDING + h)) continue;
          await this.env.BUCKET.put(PENDING + h, JSON.stringify({ from: host, at: Date.now() }));
          added++;
        }
        return { added, candidates: seen.size };
      } catch (e) {
        return { added: 0, error: String(e).slice(0, 160) };
      }
    });

    // The directory's "searchable chunks" headline sums RagVector.chunkCount,
    // and NOTHING else writes that field for a site published from here — the
    // legacy scripts/publish-site-to-divinci.mjs PATCHed it, this Workflow
    // never did. So every site the fleet published counted as ZERO chunks:
    // on 2026-08-19, 1,060 of 1,423 listed sites had chunkCount null and the
    // headline sat frozen at the pre-fleet cohort's 1,098,957 while ~1,000
    // sites were added. Report `probe.rows` — what the SERVED table actually
    // holds — for the same reason the activity feed reports `written`.
    const chunkCountSet = await step.do("set-chunk-count", async () => {
      try {
        await divinci(
          this.env, "PATCH",
          `/white-label/${this.env.WHITELABEL_ID}/rag-vector/${reg.vectorId}/settings`,
          { chunkCount: probe.rows },
        );
        return true;
      } catch {
        // Non-fatal: the site is live and retrievable at this point, and a
        // display counter must never fail a publish that succeeded. Surfaced
        // in the result (like similarityApplied) so a silent drift is visible.
        return false;
      }
    });

    const linked = await step.do("register-site", async () =>
      registerSite(this.env, {
        host, vectorId: reg.vectorId, releaseId: release.releaseId,
        // Distinct URLs crawled, and total corpus bytes — what the directory
        // card displays. Computed in the chunk step; never let them be dropped.
        pageCount: chunked.urls, totalBytes: chunked.bytes,
      }));

    await this.retire(host, "published", { vectorId: reg.vectorId, releaseId: release.releaseId });

    // Feed the public status page. Best-effort by construction (recordPublish
    // swallows its own errors) — the site is already live at this point, and a
    // status feed must never be able to fail a publish that succeeded.
    await recordPublish(this.env.BUCKET, {
      // `written` is rows actually landed in the served table, not
      // `chunked.chunks` (what we intended to write). Report what is
      // retrievable — the directory card counts the same thing.
      host, pages: chunked.urls, chunks: written,
    });

    return {
      host, slug, status: "ok", dbUrl: db.url, discovered,
      vectorId: reg.vectorId,
      minimumSimilarity: reg.minimumSimilarity,
      similarityApplied: reg.similarityApplied,
      release, linked, chunkCountSet,
      crawled, chunked, written, probe,
      // The database auth token is deliberately NOT returned — a Workflow
      // result is readable via the instance-status API, and it is the site's
      // credential.
    };
  }
}


/**
 * One cron tick: top the fleet back up to its concurrency target.
 *
 * Deliberately a TOP-UP, not a batch launch. A tick that fired a fixed number
 * of runs would stack them on top of whatever is already going and the fleet
 * would grow without bound; asking "how many are live, launch the difference"
 * is self-correcting and needs no state beyond the claims themselves.
 */
export async function tick(env) {
  const now = Date.now();
  const MAX = Number(env.MAX_CONCURRENT ?? 4);
  const TTL = Number(env.INFLIGHT_TTL_MS ?? 75 * 60 * 1000);
  const LIMIT = Number(env.CRAWL_LIMIT ?? 100);

  // ── Reap claims that outlived their run ─────────────────────────────────
  // A Workflow has no `finally`, so a run that dies mid-step never releases
  // its claim. Unreaped, those leak the concurrency budget down to zero and
  // the fleet goes quiet while every health check still reads green.
  const inflight = [];
  for (const h of await listKeys(env.BUCKET, INFLIGHT)) {
    const o = await env.BUCKET.get(INFLIGHT + h);
    const rec = o ? await o.json().catch(() => null) : null;

    // ── Ask the instance, do not just watch the clock ───────────────────────
    // A TTL alone means a run that errored or was terminated in its first
    // minute still holds its slot for the full TTL. With a small fleet that is
    // starvation: five dead claims against MAX_CONCURRENT=4 stop the pipeline
    // completely while every health check reads green. The claim records the
    // instance id precisely so we can settle this authoritatively.
    let terminal = null;
    let platformFault = false;
    if (rec?.instanceId) {
      try {
        const st = await (await env.PIPELINE.get(rec.instanceId)).status();
        if (["complete", "errored", "terminated", "unknown"].includes(st.status)) terminal = st.status;
        // ⚠️ Not every failure is the host's fault, and the difference decides
        // whether we permanently drop a legitimate site. "Attempt failed due to
        // internal workflows error" is a Cloudflare platform fault — it says
        // nothing about the host — yet it was consuming the same 3-attempt
        // budget as a genuine refusal. Three unlucky flakes and a perfectly
        // good site is tombstoned forever, unattended, with a reason that
        // blames it.
        const msg = String(st.error?.message ?? "");
        platformFault = /internal workflows error|internal error|exceeded memory|Network connection lost/i.test(msg);
      } catch {
        // An instance we cannot even look up is gone; fall through to the TTL.
      }
    }

    if (!rec || terminal || isStale(rec, now, TTL)) {
      // A reaped claim means a run died without finishing — that is an ATTEMPT,
      // and counting it is what stops a host that crashes the pipeline every
      // time from being retried until the credits run out.
      await env.BUCKET.delete(INFLIGHT + h);
      const po = await env.BUCKET.get(PENDING + h);
      const prec = po ? await po.json().catch(() => null) : null;
      if (prec && platformFault) {
        // Counted separately, against a much larger budget: transient platform
        // errors must not cost the host its retries, but a host that provokes
        // one EVERY time still has to stop eventually or it burns credits
        // forever.
        const pa = Number(prec.platformAttempts ?? 0) + 1;
        if (pa >= Number(env.MAX_PLATFORM_ATTEMPTS ?? 8)) {
          await env.BUCKET.put(DONE + h, JSON.stringify({ reason: `platform-error x${pa}`, at: now }));
          await env.BUCKET.delete(PENDING + h);
        } else {
          await env.BUCKET.put(PENDING + h,
            JSON.stringify({ ...prec, platformAttempts: pa, lastReason: "platform-error", lastAt: now }));
        }
      } else if (prec) {
        const attempts = Number(prec.attempts ?? 0) + 1;
        if (attempts >= Number(env.MAX_ATTEMPTS ?? 3)) {
          await env.BUCKET.put(DONE + h, JSON.stringify({ reason: `run-failed x${attempts} (${terminal ?? "stale"})`, at: now }));
          await env.BUCKET.delete(PENDING + h);
        } else {
          await env.BUCKET.put(PENDING + h, JSON.stringify({ ...prec, attempts, lastReason: terminal ?? "stale-claim", lastAt: now }));
        }
      }
      continue;
    }
    inflight.push(h);
  }

  // ── FAIL CLOSED on the directory ────────────────────────────────────────
  // With no directory every host looks new, and a 24/7 loop would republish
  // the entire corpus as duplicates. Same rule as the manual path; it matters
  // far more here, because nobody is watching this one.
  const { ok, hosts: published } = await fetchPublishedHosts(env);
  if (!ok) return { launched: [], inflight: inflight.length, reason: "directory-unavailable" };

  const done = new Set(await listKeys(env.BUCKET, DONE));
  const claimed = new Set(inflight);
  const pending = await listKeys(env.BUCKET, PENDING);

  // ── Sweep BEFORE the capacity check ─────────────────────────────────────
  // Hosts published elsewhere (the laptop's final passes) or malformed ones sit
  // in `pending` forever otherwise: the launch loop tombstones them, but it is
  // never reached while the fleet is busy — which is most of the time. They can
  // never be launched, so this is not a safety issue, but it silently inflates
  // the one number used to judge how much work is left. A progress metric that
  // counts finished work is a broken progress metric.
  let swept = 0;
  for (const host of pending) {
    const isPublished = published.has(host) || published.has(host.replace(/^www\./, ""));
    const junk = isJunkHost(host);
    if (!isPublished && !junk && isPlausibleHost(host)) continue;
    await env.BUCKET.put(DONE + host, JSON.stringify({
      reason: isPublished ? "already-published" : junk ? "not-a-content-host" : "implausible-host",
      at: now,
    }));
    await env.BUCKET.delete(PENDING + host);
    done.add(host);
    swept++;
  }

  const slots = MAX - inflight.length;
  if (slots <= 0) return { launched: [], swept, inflight: inflight.length, reason: "at capacity" };

  const launched = [];
  let contended = 0;
  for (const host of pending) {
    if (launched.length >= slots) break;
    // The sweep above already tombstoned published/implausible hosts.
    if (claimed.has(host) || done.has(host)) continue;
    // Claim ATOMICALLY, and BEFORE creating the instance. Losing the race here
    // is normal and cheap — it just means another tick got there first.
    if (!(await claimHost(env.BUCKET, host, { at: now }))) { contended++; continue; }
    try {
      const inst = await env.PIPELINE.create({
        params: { host, limit: LIMIT, maxAge: 0, publish: true },
      });
      await env.BUCKET.put(INFLIGHT + host, JSON.stringify({ at: now, instanceId: inst.id }));
      launched.push({ host, id: inst.id });
    } catch (e) {
      // Release the claim or the host is leaked until the TTL expires.
      await env.BUCKET.delete(INFLIGHT + host);
      launched.push({ host, error: String(e).slice(0, 160) });
    }
  }
  return { launched, contended, swept, inflight: inflight.length, pending: pending.length - swept, done: done.size };
}

/**
 * Run a scheduling tick, then tell the public page we are alive.
 *
 * Reporting is deliberately OUTSIDE tick(): tick has two return paths (normal
 * and at-capacity) and a status feed that only fired on one of them would go
 * silent exactly when the fleet is busiest — which reads as "offline" on a
 * public marketing page.
 *
 * The reporter re-lists the frontier rather than reusing tick's return value,
 * so it reports state AFTER the launches, and so it cannot be broken by a
 * future change to tick's result shape.
 */
export async function tickAndReport(env) {
  // ⚠️ REPORT FIRST, then do the slow work. The heartbeat's age is measured
  // from when the POST lands, and the reap+launch pass takes 60-80s (it lists
  // ~4,400 R2 keys and asks the Workflows API about up to 64 instances).
  // Reporting afterwards meant the heartbeat landed ~80s into each invocation,
  // so at a 2-minute cron the observed age reached 202s against a staleness
  // window of roughly 180s — and the public page still flipped to "offline".
  // Emitting up front costs one tick of lag in `inFlight`, which is immaterial
  // for a status feed, and buys ~80s of headroom, which is not.
  const activity = await reportNow(env);
  const result = await tick(env);
  return { ...result, activity };
}

async function reportNow(env) {
  try {
    const now = Date.now();
    const [events, pending, done, inflight] = await Promise.all([
      listEvents(env.BUCKET),
      listKeys(env.BUCKET, PENDING),
      listKeys(env.BUCKET, DONE),
      listKeys(env.BUCKET, INFLIGHT),
    ]);
    const snapshot = buildSnapshot({
      events, pending: pending.length, done: done.length, inflight, now,
    });
    // /submit reads this instead of counting at request time — see submit.js.
    await writePendingCount(env.BUCKET, pending.length);
    const activity = await reportActivity(env, snapshot);
    // Pruning is single-writer here (cron), so it cannot race the 64
    // concurrent publishers that write these events.
    activity.prune = await pruneEvents(env.BUCKET, now);
    return activity;
  } catch (e) {
    // Fail-open: a broken status feed must never stop the crawler.
    return { ok: false, reason: String(e?.message ?? e).slice(0, 200) };
  }
}

export default {
  async scheduled(event, env, ctx) {
    // A cron tick on a half-configured Worker spends browser-seconds crawling
    // and then fails several steps in, unattended, every two minutes. Refuse at
    // the top instead — and log it, because a cron has no caller to return to.
    const cfg = checkConfig(env);
    if (!cfg.ok) {
      console.error(
        `[config] refusing to tick — ${cfg.missing.length} required value(s) missing: ` +
          cfg.missing.join(", ") + ". GET /health for detail.",
      );
      return;
    }
    ctx.waitUntil(tickAndReport(env));
  },

  async fetch(req, env) {
    const url = new URL(req.url);
    // ⚠️ /health must answer even when the Worker is unconfigured — it is the
    // endpoint an operator uses to find out WHY. It reports the missing names
    // (not values, and never a secret's contents), and stays open while /run
    // and /status stay gated.
    if (url.pathname === "/health") {
      const cfg = checkConfig(env);
      return Response.json({ ok: cfg.ok, configured: cfg.ok, missing: cfg.missing });
    }

    if (url.pathname === "/run" && req.method === "POST") {
      const auth = req.headers.get("Authorization");
      if (!env.TRIGGER_TOKEN || auth !== `Bearer ${env.TRIGGER_TOKEN}`) {
        return new Response("unauthorized", { status: 401 });
      }
      // After auth, so an unauthenticated caller learns nothing about the
      // deployment's configuration.
      try { assertConfigured(env); }
      catch (e) { return Response.json({ error: String(e.message) }, { status: 503 }); }
      const body = await req.json();
      const hosts = Array.isArray(body.hosts) ? body.hosts : [body.host];
      const created = [];
      for (const host of hosts.filter(Boolean)) {
        const inst = await env.PIPELINE.create({
          params: {
            host, limit: body.limit ?? 200, maxAge: body.maxAge ?? 0,
            publish: !!body.publish,
            // Re-publishing an EXISTING host is destructive by construction: the
            // provision step destroys `wrp-<slug>` before creating it, and a new
            // vector + release orphan the old ones. Never inferred — only ever
            // what the caller explicitly asked for.
            allowRepublish: !!body.allowRepublish,
          },
        });
        // Claim it on the SAME ledger the cron reads. A manual run that left no
        // claim would be invisible to the scheduler, which could then launch the
        // very same host — two crawls, two vectors, two releases for one site —
        // and would also overshoot MAX_CONCURRENT by however many were started
        // by hand.
        // A republish DESTROYS the site's database before recreating it, and
        // orphans its vector and release. Moving that from an env var to a
        // per-run flag removed the risk of leaving a fleet-wide switch on, but
        // it also means any TRIGGER_TOKEN holder can now do it with one call
        // and no deploy — so it leaves a line in the log. Observability is on;
        // this is the only trace such a call would otherwise have.
        if (body.allowRepublish) {
          console.warn(`⚠️ [republish] destructive re-publish requested for ${host} — database will be destroyed and recreated, old vector + release orphaned`);
        }
        await env.BUCKET.put(INFLIGHT + host, JSON.stringify({ at: Date.now(), instanceId: inst.id, manual: true }));
        created.push({ host, id: inst.id });
      }
      return Response.json({ created });
    }

    if (url.pathname === "/status") {
      // Gated: a workflow result carries the site's database URL, and this
      // Worker is on a public workers.dev hostname.
      if (!env.TRIGGER_TOKEN || req.headers.get("Authorization") !== `Bearer ${env.TRIGGER_TOKEN}`) {
        return new Response("unauthorized", { status: 401 });
      }
      const id = url.searchParams.get("id");
      if (!id) return new Response("need ?id=", { status: 400 });
      const inst = await env.PIPELINE.get(id);
      return Response.json(await inst.status());
    }

    // The AI-rights record for every host we have ever asked — the substrate
    // for the public manifest. Paginated by cursor: this grows to one object
    // per host and must not try to be one response.
    if (url.pathname === "/rights") {
      if (!env.TRIGGER_TOKEN || req.headers.get("Authorization") !== `Bearer ${env.TRIGGER_TOKEN}`) {
        return new Response("unauthorized", { status: 401 });
      }
      const cursor = url.searchParams.get("cursor") || undefined;
      const list = await env.BUCKET.list({ prefix: "rights/", cursor, limit: 200 });
      const rows = [];
      for (const o of list.objects) {
        const obj = await env.BUCKET.get(o.key);
        if (obj) rows.push(await obj.json().catch(() => null));
      }
      return Response.json({
        rows: rows.filter(Boolean),
        cursor: list.truncated ? list.cursor : null,
      });
    }

    // Re-ask hosts we crawled BEFORE the verdict was being persisted.
    //
    // ⚠️ A backfilled row is NOT the same fact as a recorded one: it is what
    // the host says TODAY, not what it said when we crawled it. Marked
    // `backfilled: true` and never silently merged, because a manifest that
    // presents a 2026-08-18 answer as though it were the answer on the crawl
    // date is making a claim it cannot support — and the whole value of this
    // record is that it is evidence.
    if (url.pathname === "/rights/backfill" && req.method === "POST") {
      if (!env.TRIGGER_TOKEN || req.headers.get("Authorization") !== `Bearer ${env.TRIGGER_TOKEN}`) {
        return new Response("unauthorized", { status: 401 });
      }
      const b = await req.json();
      // Bounded per call: each host costs a robots.txt fetch, and a few
      // hundred in one request exhausts the subrequest budget.
      const hosts = (b.hosts || []).filter(isPlausibleHost).slice(0, 30);
      const out = [];
      for (const h of hosts) {
        if (!b.force && await env.BUCKET.head(`rights/${h}.json`)) { out.push({ host: h, skipped: "already recorded" }); continue; }
        const r = await checkAiRights(h, env);
        await env.BUCKET.put(`rights/${h}.json`, JSON.stringify({
          host: h, reserved: r.reserved, trainOnly: r.trainOnly, verifiable: r.verifiable, via: r.via ?? "direct",
          httpStatus: r.status, contentSignal: r.contentSignal ?? "", reasons: r.reasons ?? [],
          checkedAt: new Date().toISOString(), backfilled: true,
        }));
        out.push({ host: h, reserved: r.reserved, verifiable: r.verifiable });
      }
      return Response.json({ processed: out.length, results: out });
    }

    if (url.pathname === "/frontier") {
      if (!env.TRIGGER_TOKEN || req.headers.get("Authorization") !== `Bearer ${env.TRIGGER_TOKEN}`) {
        return new Response("unauthorized", { status: 401 });
      }
      const [pending, done, listed] = await Promise.all([
        listKeys(env.BUCKET, PENDING), listKeys(env.BUCKET, DONE), listKeys(env.BUCKET, INFLIGHT),
      ]);
      // ⚠️ R2 list() is eventually consistent and WILL return keys that have
      // already been deleted. Reporting it raw made this endpoint disagree
      // with the scheduler — it showed 5 claims held while the scheduler saw
      // the deletions and the actual objects were gone. A status page that
      // contradicts the thing it reports on is worse than no status page, so
      // confirm every listed claim with a strongly-consistent get().
      const inflight = [];
      const ghosts = [];
      for (const h of listed) {
        const o = await env.BUCKET.get(INFLIGHT + h);
        (o ? inflight : ghosts).push(h);
      }
      // Verify a sample of pending keys the same way, and report what the
      // scheduler would classify them as. Without this, a host visible in
      // nextUp but untouched by the sweep is undiagnosable from outside.
      const sample = [];
      for (const h of pending.slice(0, 12)) {
        const o = await env.BUCKET.get(PENDING + h);
        sample.push({ h, real: !!o, junk: isJunkHost(h), plausible: isPlausibleHost(h) });
      }
      return Response.json({
        pending: pending.length, done: done.length, inflight, sample,
        // Surfaced rather than hidden: a persistent ghost count means list lag
        // is unusually long, which is worth seeing before it confuses someone.
        ghostClaims: ghosts.length,
        maxConcurrent: Number(env.MAX_CONCURRENT ?? 4),
        nextUp: pending.slice(0, 20),
      });
    }

    // Run one scheduling tick by hand — same code path as the cron, so testing
    // the loop never means testing something adjacent to it.
    // Rebuild link maps for sites crawled BEFORE the crawler started emitting
    // them. The raw bundles are still in R2 for every pipeline-era site, so the
    // whole history is recoverable without re-crawling a single page.
    //
    // Runs IN the Worker rather than from a laptop because R2 reads are local
    // here: pulling ~1,450 bundles of 2-3 MB out over the network would take
    // hours and re-implement the parser at the other end. Cursor-paged with a
    // small default limit because each bundle is a multi-MB JSON parse plus a
    // regex over every page, and the CPU budget per request is finite.
    if (url.pathname === "/links/backfill" && req.method === "POST") {
      if (!env.TRIGGER_TOKEN || req.headers.get("Authorization") !== `Bearer ${env.TRIGGER_TOKEN}`) {
        return new Response("unauthorized", { status: 401 });
      }
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 8), 40);
      const force = url.searchParams.get("force") === "1";
      // Resume point WITHIN a listing page. Without it the budget cut is only
      // survivable because `skippedExisting` happens to skip what was already
      // written — which stops being true under ?force=1, where the same first
      // N bundles would be reprocessed on every call, forever.
      const after = url.searchParams.get("after") || "";
      const cursor = url.searchParams.get("cursor") || undefined;

      // The canonical host comes from the DIRECTORY, never from the page URL.
      // A bundle's first page may read `https://www.agno.com/` while the corpus
      // knows the site as `agno.com`; deriving the host from the URL would emit
      // edges whose source matches nothing and silently produce an empty graph.
      // A slug absent from the directory is a site that was crawled but never
      // published — skipped, because it can never be an edge source on the map.
      let slugToHost;
      try {
        const dir = await fetch(`${env.DIVINCI_API_BASE}/api/v1/www-rag-directory`);
        const body = await dir.json();
        slugToHost = new Map((body.sites || []).map((s) => [slugify(s.host), s.host]));
      } catch (e) {
        return Response.json({ error: `could not read the directory: ${String(e?.message ?? e)}` }, { status: 502 });
      }
      if (!slugToHost.size) {
        // Fail closed: an empty directory would make every slug "unknown" and
        // report a clean run that skipped the entire corpus.
        return Response.json({ error: "directory returned no sites — refusing to backfill against nothing" }, { status: 502 });
      }

      const page = await env.BUCKET.list({ prefix: "sites/", cursor, limit: 1000 });
      const raws = page.objects.filter((o) => o.key.endsWith("/raw.json"));
      const out = { scanned: raws.length, wrote: 0, skippedExisting: 0, notInDirectory: 0, failed: [], truncatedMaps: 0 };
      let budget = limit;
      let stoppedAt = null;
      let lastProcessed = after;
      for (const o of raws) {
        if (after && o.key <= after) continue; // R2 lists lexicographically
        if (budget <= 0) { stoppedAt = o.key; break; }
        lastProcessed = o.key;
        const slug = o.key.slice("sites/".length, -"/raw.json".length);
        const host = slugToHost.get(slug);
        if (!host) { out.notInDirectory++; continue; }
        if (!force && (await env.BUCKET.head(linkMapKey(slug)))) { out.skippedExisting++; continue; }
        budget--;
        try {
          const raw = await env.BUCKET.get(`sites/${slug}/raw.json`);
          if (!raw) { out.failed.push({ slug, reason: "bundle vanished" }); continue; }
          const pages = await raw.json();
          const { seen, linkTotals } = countOutbound(pages, host, extractHosts, { perPageMax: 120 });
          const r = await writeLinkMap(env, slug, host, pages.length, seen, linkTotals);
          if (r.ok) { out.wrote++; if (r.truncated) out.truncatedMaps++; }
          else out.failed.push({ slug, reason: r.reason });
        } catch (e) {
          out.failed.push({ slug, reason: String(e?.message ?? e).slice(0, 160) });
        }
      }
      // Two different "keep going" signals, and conflating them would either
      // stall the backfill or loop it forever: `cursor` advances the R2 listing,
      // `resumeKey` means this page still has unprocessed bundles.
      out.cursor = page.truncated ? page.cursor : null;
      // Pass back as ?after= on the next call with the SAME cursor.
      out.nextAfter = stoppedAt ? lastProcessed : null;
      out.done = !out.cursor && !stoppedAt;
      out.morePagesInThisListing = !!stoppedAt;
      return Response.json(out);
    }

    // Serve the materialized link graph: the R2 link maps, already intersected
    // with the live corpus. The registry lives behind Mongo on the other side
    // of the world from this Worker, and the Worker is the only thing with fast
    // R2 access — so it does the reading and the filtering, and a local script
    // does the writing. Neither side gains an authority it did not have.
    if (url.pathname === "/links/edges") {
      if (!env.TRIGGER_TOKEN || req.headers.get("Authorization") !== `Bearer ${env.TRIGGER_TOKEN}`) {
        return new Response("unauthorized", { status: 401 });
      }
      const cursor = url.searchParams.get("cursor") || undefined;
      const after = url.searchParams.get("after") || "";
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 60), 200);

      let corpus;
      try {
        const dir = await fetch(`${env.DIVINCI_API_BASE}/api/v1/www-rag-directory`);
        const body = await dir.json();
        corpus = new Set((body.sites || []).map((s) => s.host));
      } catch (e) {
        return Response.json({ error: `directory unreadable: ${String(e?.message ?? e)}` }, { status: 502 });
      }
      // Fail closed. With an empty corpus every target is "off-corpus" and this
      // would report a clean run that emitted no edges at all.
      if (!corpus.size) return Response.json({ error: "directory returned no sites" }, { status: 502 });

      const page = await env.BUCKET.list({ prefix: "sites/", cursor, limit: 1000 });
      const maps = page.objects.filter((o) => o.key.endsWith("/links.json"));
      const edges = [];
      const scanned = [];
      let budget = limit, stoppedAt = null, lastProcessed = after;
      for (const o of maps) {
        if (after && o.key <= after) continue;
        if (budget <= 0) { stoppedAt = o.key; break; }
        lastProcessed = o.key;
        budget--;
        try {
          const obj = await env.BUCKET.get(o.key);
          if (!obj) continue;
          const m = await obj.json();
          // A source that has left the directory (withdrawn, unlisted) must not
          // emit edges — its artifacts are deleted on withdrawal, but a listing
          // can still race that deletion.
          if (!corpus.has(m.host)) continue;
          scanned.push([m.host, m.pagesScanned ?? 0]);
          for (const [target, pages, links] of m.outbound || []) {
            if (target === m.host) continue;      // self-edges are not relationships
            if (!corpus.has(target)) continue;    // in-corpus only, per the graph's contract
            edges.push([m.host, target, pages, links]);
          }
        } catch { /* one unreadable map must not fail the page */ }
      }
      return Response.json({
        edges, scanned,
        cursor: page.truncated ? page.cursor : null,
        nextAfter: stoppedAt ? lastProcessed : null,
        morePagesInThisListing: !!stoppedAt,
        done: !(page.truncated ? page.cursor : null) && !stoppedAt,
      });
    }

    if (url.pathname === "/tick" && req.method === "POST") {
      if (!env.TRIGGER_TOKEN || req.headers.get("Authorization") !== `Bearer ${env.TRIGGER_TOKEN}`) {
        return new Response("unauthorized", { status: 401 });
      }
      return Response.json(await tickAndReport(env));
    }

    // Bulk-load the frontier. Idempotent, and it never overwrites a tombstone.
    // ── Add a website to the crawl queue ──────────────────────────────────
    //
    // The machine-facing queue door. Public submissions belong at
    // POST /api/v1/www-rag/submit-url in the monorepo, which owns the user
    // auth, per-user rate limit and shared denylist; it calls this. See
    // src/submit.js for why those guardrails are deliberately NOT duplicated.
    //
    // Least privilege: SUBMIT_TOKEN, not TRIGGER_TOKEN. This token can only
    // enqueue a host; the trigger token can run workflows and read rights.
    if (url.pathname === "/submit" && req.method === "POST") {
      const expected = env.SUBMIT_TOKEN || env.TRIGGER_TOKEN;
      if (!expected || req.headers.get("Authorization") !== `Bearer ${expected}`) {
        return new Response("unauthorized", { status: 401 });
      }
      let b;
      try { b = await req.json(); } catch { return Response.json({ error: "body must be JSON" }, { status: 400 }); }

      // FAIL CLOSED: with no directory every host reads as new, and accepting
      // submissions then would re-queue the whole published corpus.
      const dir = await fetchPublishedHosts(env);
      if (!dir.ok) {
        return Response.json(
          { error: "directory unavailable — refusing to treat hosts as new", retryable: true },
          { status: 503 },
        );
      }

      const items = Array.isArray(b.urls) ? b.urls : [b.url ?? b.host];
      // Bounded per call: each submission costs several R2 reads, and an
      // unbounded array is a cheap way to make one request very expensive.
      const capped = items.slice(0, Number(env.SUBMIT_MAX_PER_REQUEST ?? 20));
      // Read the frontier size ONCE for the whole batch, not once per host.
      const pendingCount = await readPendingCount(env.BUCKET);
      const results = [];
      for (const raw of capped) {
        results.push(await submitHost(env, {
          raw, submittedBy: b.submittedBy, source: b.source,
          publishedHosts: dir.hosts,
          maxPending: Number(env.MAX_PENDING ?? 20000),
          pendingCount,
        }));
      }
      return Response.json({
        submitted: results.length,
        truncated: items.length > capped.length ? items.length - capped.length : 0,
        queued: results.filter((r) => r.status === "queued").length,
        results,
      });
    }

    // ── Withdraw published sites whose owners refuse AI use ───────────────
    //
    // DESTRUCTIVE and irreversible: it destroys each site's Turso database.
    // TRIGGER_TOKEN, not SUBMIT_TOKEN — this is an operator action.
    //
    // Requires an explicit `confirm: true` and an explicit host list. There is
    // deliberately no "withdraw everything that currently refuses" mode: that
    // would let a transient robots.txt change, or one bad rights parse, delete
    // a corpus unattended. Detection can be automatic; deletion is a decision.
    if (url.pathname === "/withdraw" && req.method === "POST") {
      if (!env.TRIGGER_TOKEN || req.headers.get("Authorization") !== `Bearer ${env.TRIGGER_TOKEN}`) {
        return new Response("unauthorized", { status: 401 });
      }
      let b;
      try { b = await req.json(); } catch { return Response.json({ error: "body must be JSON" }, { status: 400 }); }
      if (b.confirm !== true) {
        return Response.json({ error: "refusing without confirm:true — this destroys corpora irreversibly" }, { status: 400 });
      }
      const hosts = (b.hosts || []).filter(isPlausibleHost).slice(0, 25);
      if (!hosts.length) return Response.json({ error: "hosts[] is required" }, { status: 400 });

      // releaseId comes from the directory, so a caller cannot mis-name one and
      // deprecate an unrelated release.
      //
      // Resolve each host to the release it was published as. Never guess: a
      // wrong releaseId deprecates an unrelated release, and this path also
      // destroys a database irreversibly.
      //
      // OWN-CORPUS mode has no directory to ask, so the publish tombstone is
      // the record (see `retire`). That is the only source here — a host with
      // no tombstone is one this deployment never published, and withdrawing
      // it is not this deployment's business.
      const byHost = new Map();
      if (!env.DIRECTORY_URL) {
        for (const h of hosts) {
          const obj = await env.BUCKET.get(DONE + String(h).toLowerCase());
          if (!obj) continue;
          const t = await obj.json().catch(() => ({}));
          if (t.releaseId) byHost.set(String(h).toLowerCase(), { releaseId: t.releaseId, vectorId: t.vectorId });
        }
        const unknown = hosts.filter((h) => !byHost.has(String(h).toLowerCase()));
        if (unknown.length) {
          return Response.json({
            error: "no publish record for these hosts — this deployment did not publish them, " +
                   "or they were published before the tombstone carried a releaseId",
            unknown,
          }, { status: 404 });
        }
      } else {
      const dirRes = await fetch(env.DIRECTORY_URL, {
        signal: AbortSignal.timeout(40_000),
      });
      if (!dirRes.ok) return Response.json({ error: `directory ${dirRes.status}` }, { status: 502 });
      for (const st of ((await dirRes.json())?.sites ?? [])) if (st.host) byHost.set(st.host, st);
      }

      const results = [];
      for (const host of hosts) {
        const rightsObj = await env.BUCKET.get(`rights/${host}.json`);
        results.push(await withdrawHost(env, {
          host,
          releaseId: byHost.get(host)?.releaseId ?? null,
          reason: String(b.reason ?? "owner reserves AI use").slice(0, 200),
          rights: rightsObj ? await rightsObj.json().catch(() => null) : null,
        }));
      }
      return Response.json({
        requested: hosts.length,
        withdrawn: results.filter((r) => r.withdrawn).length,
        partial: results.filter((r) => !r.withdrawn).map((r) => r.host),
        results,
      });
    }

    // ⛔ NO /activity/backfill — considered, built, and deliberately removed.
    //
    // Seeding the event store from the directory would give the public page
    // 24h of history immediately instead of counters that climb from zero.
    // But the directory's chunkCount is missing or zero for 248 of 621 sites
    // (40%), including developer.mozilla.org at 1,500 pages — the same
    // not-dual-source gap that makes statusDetails read 0 for a 284-source
    // vector. Backfilling from it would publish a knowingly understated chunk
    // total, which is the exact class of defect this feed exists to end.
    //
    // So the counters start at zero and reach truth within 24h, and every
    // number shown is a publish the worker actually recorded, with the row
    // count it actually wrote. A low number that is true beats a high one
    // that is not. The headline fix — "Crawler offline" — comes from state,
    // seeds, done and inFlight, which are exact from the first tick.

    if (url.pathname === "/seed" && req.method === "POST") {
      if (!env.TRIGGER_TOKEN || req.headers.get("Authorization") !== `Bearer ${env.TRIGGER_TOKEN}`) {
        return new Response("unauthorized", { status: 401 });
      }
      const b = await req.json();
      const kind = b.done ? DONE : PENDING;
      let added = 0, skipped = 0;
      for (const h of (b.hosts || []).filter(isPlausibleHost)) {
        if (!b.done && await env.BUCKET.head(DONE + h)) { skipped++; continue; }
        await env.BUCKET.put(kind + h, JSON.stringify({ reason: b.reason ?? "seeded", at: Date.now() }));
        added++;
      }
      return Response.json({ added, skipped, kind });
    }

    return new Response("not found", { status: 404 });
  },
};
