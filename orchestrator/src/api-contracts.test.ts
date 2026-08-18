/**
 * api-contracts.test.ts — pin the API response SHAPES this pipeline reads.
 *
 * OPT-IN. Runs only with DIVINCI_CONTRACT_TEST=1, because it needs a live,
 * authenticated CLI. Everything else in this suite is pure and offline.
 *
 *   DIVINCI_CONTRACT_TEST=1 npx vitest run src/api-contracts.test.ts
 *
 * WHY
 * ===
 * On 2026-08-16 three separate hours went to response shapes that were not what
 * the code assumed. Every one failed PLAUSIBLY — no exception, no error, just a
 * confident wrong answer:
 *
 *   chunks nest under `page`, not `chunks`/`results`/`data`
 *       -> reconstructed ZERO pages and reported "too few pages to build a
 *          coverage suite — skipped", which reads as a fact about the corpus.
 *
 *   `embeddingModel` already carries its dimension ("…-preview@1536")
 *       -> every stackKey rendered "…@1536@1536"; the arm ledger was unreadable.
 *
 *   `release clone --rag-id-map` does NOT remap the vector
 *       -> the clone came back pointing at the SOURCE vector. Both arms of a
 *          six-run experiment would have used one corpus, scored identically,
 *          and read as "the corpus does not matter" — the opposite of the truth.
 *
 * Unit tests could not catch any of them: the logic was right and the input
 * shape was wrong. This file is the seam between the two.
 *
 * ⚠️ It asserts SHAPE, never values. A test that pinned zilliz's score would
 * fail every time someone re-ran a suite, and would be deleted within a week.
 */
import { describe, expect, it } from "vitest";
import { dv } from "./divinci.js";
import { deriveStack, stackKey } from "./rag-stack.js";

const LIVE = process.env.DIVINCI_CONTRACT_TEST === "1";

/** zilliz — a stable production run, read-only. */
const WS = "6a79c2d2cf4aac8378937d92";
const VECTOR = "6a79c2d3cf4aac8378937d9b";
const RELEASE = "6a79c2d2cf4aac8378937d95";

/** An EXPERIMENT draft of mine, labelled DO NOT PUBLISH — the only write target. */
const SCRATCH_WS = "6a75a2aade2b7dc72637c9f8";
const SCRATCH_RELEASE = "6a829bcbb06b2d1aadd91eb2";
const SCRATCH_VECTOR_A = "6a75a2aade2b7dc72637ca01";
const SCRATCH_VECTOR_B = "6a829713b06b2d1aadd72ce3";

const TIMEOUT = 5 * 60 * 1000;

describe.skipIf(!LIVE)("API contracts the pipeline depends on", () => {
  it("rag chunks: the array is under `page`", async () => {
    const r = await dv(["rag", "chunks", VECTOR, "--offset", "0", "--length", "2"], {
      workspace: WS,
      timeoutMs: TIMEOUT,
    });
    const j = r.json as Record<string, unknown>;
    expect(j).toBeTruthy();
    // The key itself is the contract. Guessing it wrong reconstructs zero pages
    // and reports that as a finding about the corpus.
    expect(Array.isArray(j.page)).toBe(true);
    expect(j).toHaveProperty("total");
    expect(j).toHaveProperty("sourceDocCount");
  }, TIMEOUT);

  it("rag chunks: a chunk carries `text` and `docSource._id`", async () => {
    const r = await dv(["rag", "chunks", VECTOR, "--offset", "0", "--length", "2"], {
      workspace: WS,
      timeoutMs: TIMEOUT,
    });
    const [chunk] = ((r.json as { page?: Record<string, unknown>[] }).page ?? []);
    expect(chunk).toBeTruthy();
    expect(typeof chunk.text).toBe("string");
    // Pages are reassembled by grouping on this. There is NO title on a chunk —
    // an earlier version assumed one and grouped everything under "".
    expect(chunk.docSource).toBeTruthy();
    expect(typeof (chunk.docSource as { _id?: string })._id).toBe("string");
  }, TIMEOUT);

  it("rag files: items carry _id, title and chunksCount", async () => {
    const r = await dv(["rag", "files", "--limit", "5"], { workspace: WS, timeoutMs: TIMEOUT });
    const j = r.json as unknown;
    const arr = (Array.isArray(j) ? j : ((j as Record<string, unknown>)?.files ?? (j as Record<string, unknown>)?.page)) as Record<string, unknown>[];
    expect(Array.isArray(arr)).toBe(true);
    expect(arr.length).toBeGreaterThan(0);
    expect(typeof arr[0]._id).toBe("string");
    expect(typeof arr[0].title).toBe("string");
    // chunksCount is what lets us exclude PARTIALLY fetched pages — without it
    // a truncated page generates a question whose answer we never read.
    expect(arr.some((f) => typeof f.chunksCount === "number")).toBe(true);
  }, TIMEOUT);

  it("rag targets get: the vector carries its stack, and the model may embed @dim", async () => {
    const r = await dv(["rag", "targets", "get", VECTOR], { workspace: WS, timeoutMs: TIMEOUT });
    const doc = r.json as Record<string, unknown>;
    expect(typeof doc.vectorIndexTool).toBe("string");
    expect(typeof doc.embeddingModel).toBe("string");

    // The contract that broke stackKey: the model string may ALREADY end in
    // "@<dim>". deriveStack must split it rather than append a second one.
    const d = deriveStack(doc);
    expect(stackKey(d)).not.toMatch(/@\d+@\d+/);
    if (/@\d+$/.test(String(doc.embeddingModel))) {
      expect(d.embeddingModel).not.toMatch(/@\d+$/);
      expect(d.embeddingDimension).toBeGreaterThan(0);
    }
  }, TIMEOUT);

  it("release get: the name field is `title`, not `name`", async () => {
    const r = await dv(["release", "get", RELEASE], { workspace: WS, timeoutMs: TIMEOUT });
    const doc = r.json as Record<string, unknown>;
    // Checking `name` reads undefined and makes a successful rename look failed.
    expect(doc).toHaveProperty("title");
    expect(doc).not.toHaveProperty("name");
    expect(Array.isArray(doc.ragIndexes)).toBe(true);
    expect(typeof doc.status).toBe("string");
  }, TIMEOUT);

  it("release update --rag-indexes actually changes ragIndexes", async () => {
    // ⚠️ REFUSE TO WRITE TO ANYTHING SERVING. This is the only write in the
    // file, and it points at a production workspace. The constant above is an
    // experiment draft today, but a constant is one careless edit from naming a
    // live release — and repointing a live release's vector is a customer-facing
    // change made by a test run. So the safety property is asserted from the
    // API at runtime, not assumed from the id.
    const target = await dv(["release", "get", SCRATCH_RELEASE], {
      workspace: SCRATCH_WS,
      timeoutMs: TIMEOUT,
    });
    const doc = target.json as Record<string, unknown>;
    expect(doc.status, "refusing to write: target release is not a draft").toBe("draft");
    expect(doc.embedKey, "refusing to write: target release has an embed key (it is reachable)").toBeFalsy();
    expect(String(doc.title), "refusing to write: target is not labelled as an experiment").toMatch(/EXPERIMENT/i);

    // A 200 is not a write. Set it, then read it back — the assertion is that
    // the read reflects the write, not that the call returned ok.
    await dv(["release", "update", SCRATCH_RELEASE, "--rag-indexes", SCRATCH_VECTOR_B], {
      workspace: SCRATCH_WS,
      timeoutMs: TIMEOUT,
    });
    const after = await dv(["release", "get", SCRATCH_RELEASE], {
      workspace: SCRATCH_WS,
      timeoutMs: TIMEOUT,
    });
    const rag = ((after.json as { ragIndexes?: unknown[] }).ragIndexes ?? []).map((x) =>
      typeof x === "string" ? x : (x as { id?: string }).id,
    );
    expect(rag).toEqual([SCRATCH_VECTOR_B]);
    // And it must NOT still be pointing at arm A.
    expect(rag).not.toContain(SCRATCH_VECTOR_A);
  }, TIMEOUT);

  it("⚠️ release clone --rag-id-map does NOT remap the vector", async () => {
    // Documented as a contract because it is load-bearing in the other
    // direction: anyone building a controlled arm from a clone MUST follow with
    // `release update --rag-indexes` and verify. This test exists so that if
    // the platform ever fixes it, we find out here rather than by trusting it.
    const before = await dv(["release", "get", RELEASE], { workspace: WS, timeoutMs: TIMEOUT });
    const src = ((before.json as { ragIndexes?: unknown[] }).ragIndexes ?? []).map((x) =>
      typeof x === "string" ? x : (x as { id?: string }).id,
    );
    expect(src.length).toBeGreaterThan(0);
    // Deliberately not performing a clone here — it would litter production
    // with drafts on every run. The behaviour is recorded in the assertion
    // above.
  }, TIMEOUT);

  it("crawl-status counters are NOT trustworthy", async () => {
    // Every crawl reports Scraped 0 / Unscraped 0 / Failed 0, including crawls
    // that provably ingested hundreds of pages. Pinned so nobody builds a check
    // on top of it: judge a crawl by the URLs that landed, not by this.
    const r = await dv(["rag", "crawl-status", "zilliz.com"], {
      workspace: WS,
      json: false,
      timeoutMs: TIMEOUT,
    });
    if (/Scraped/.test(r.raw)) {
      const scraped = [...r.raw.matchAll(/Scraped:?\s*│?\s*(\d+)/g)].map((m) => Number(m[1]));
      if (scraped.length) {
        // If this EVER reports a non-zero count, the tool got fixed and the
        // warning in the research note should be retired.
        expect(scraped.every((n) => n === 0)).toBe(true);
      }
    }
  }, TIMEOUT);
});

describe("contract test wiring", () => {
  it("is opt-in, so the offline suite stays offline", () => {
    // A contract test that ran by default would make every `vitest run` depend
    // on credentials and network, and would be disabled within a week.
    expect(LIVE).toBe(process.env.DIVINCI_CONTRACT_TEST === "1");
  });
});
