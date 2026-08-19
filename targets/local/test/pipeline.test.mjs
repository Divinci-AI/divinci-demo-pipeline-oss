// Chunk coalescing, the sync contract, and session resolution.
import { coalesceChunks, MIN_CHUNK_BYTES } from "../src/coalesce.mjs";
import { batches, contentHash, MAX_BATCH, pushAll, SyncError } from "../src/sync.mjs";
import { resolveSession, NotAuthenticatedError } from "../src/session.mjs";
import { byteLen, HARD_MAX } from "../../cloudflare/src/chunk.js";

let fail = 0;
const ok = (c, m) => { if (!c) { console.log("  ❌ " + m); fail++; } else console.log("  ✅ " + m); };
const big = (n) => "x".repeat(n);

// ── coalescing ──────────────────────────────────────────────────────────────
// A real homepage produced 170 chunks with sizes down to 7 bytes. A 7-byte
// chunk costs an embedding and a row to be nearest-neighbour to noise.
{
  const merged = coalesceChunks(Array(50).fill("short nav item"));
  ok(merged.length < 5, "many tiny fragments collapse into a few real chunks");
  ok(merged.every((c) => byteLen(c) >= MIN_CHUNK_BYTES), "…and every survivor clears the floor");
}
{
  const merged = coalesceChunks([big(3000), big(3000)]);
  ok(merged.length === 2, "chunks already substantial are not merged together");
}
{
  const merged = coalesceChunks([big(5000), big(5000)]);
  ok(merged.every((c) => byteLen(c) <= HARD_MAX), "merging never exceeds the chunker's hard cap");
}
{
  // A genuinely short page must not vanish — dropping it would silently discard
  // the whole page rather than some boilerplate.
  ok(coalesceChunks(["tiny"]).length === 1, "a lone short chunk is kept, not dropped");
}
{
  ok(coalesceChunks([]).length === 0, "no chunks in, no chunks out");
  ok(coalesceChunks(["", "   "]).length === 0, "blank fragments are discarded");
}
{
  const merged = coalesceChunks(["alpha ".repeat(40), "beta ".repeat(40)]);
  ok(merged.join("").includes("alpha") && merged.join("").includes("beta"), "no text is lost in merging");
  const i = merged.join("\n").indexOf("alpha"), j = merged.join("\n").indexOf("beta");
  ok(i < j, "order is preserved — adjacency is the only evidence fragments belong together");
}

// ── content hashing ─────────────────────────────────────────────────────────
ok(contentHash("a") === contentHash("a"), "the same text hashes the same — upserts are idempotent");
ok(contentHash("a") !== contentHash("b"), "different text hashes differently");
ok(/^[a-f0-9]{64}$/.test(contentHash("a")), "the hash is hex, as the server's validator requires");

// ── batching ────────────────────────────────────────────────────────────────
{
  const b = batches(Array.from({ length: 250 }, (_, i) => i));
  ok(b.length === 3, "250 rows split into 3 batches");
  ok(b.every((x) => x.length <= MAX_BATCH), "no batch exceeds the server's 100-row cap");
  ok(b.flat().length === 250, "no rows are lost");
}
ok(batches([]).length === 0, "no rows means no requests");

// ── pushAll: a partial push must never be finalized ─────────────────────────
{
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response("nope", { status: 500 }); };
  let threw = null;
  try {
    await pushAll({ apiUrl: "https://x.test", token: "t" }, "wl", "v", [{ contentHash: "a" }], { attempts: 2 });
  } catch (e) { threw = e; }
  globalThis.fetch = realFetch;
  ok(threw instanceof SyncError, "a failed batch RE-THROWS rather than reporting partial success");
  ok(calls === 2, "…after exhausting its retries");
}
{
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ error: { code: "BAD_HASH" } }, { status: 400 }); };
  try { await pushAll({ apiUrl: "https://x.test", token: "t" }, "wl", "v", [{}], { attempts: 3 }); } catch {}
  globalThis.fetch = realFetch;
  ok(calls === 1, "a 4xx is not retried — repeating a rejected request cannot make it valid");
}

// ── session ─────────────────────────────────────────────────────────────────
{
  const s = resolveSession({ env: { DIVINCI_TOKEN: "t", DIVINCI_API_URL: "https://x.test" } });
  ok(s.token === "t" && s.apiUrl === "https://x.test", "DIVINCI_TOKEN overrides the CLI store");
}
{
  let threw = null;
  try { resolveSession({ env: {}, credentialsPath: "/nonexistent/credentials.json" }); } catch (e) { threw = e; }
  ok(threw instanceof NotAuthenticatedError, "a missing session file is a typed, actionable error");
  ok(/divinci auth login/.test(threw.message), "…that says exactly how to fix it");
}
{
  // An EXPIRED session must be named as expired. Without this it surfaces as a
  // 401 from local-sync partway through a push, which reads as a permissions
  // problem with the whitelabel rather than a login that needs renewing.
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  const f = path.join(os.tmpdir(), `sess-${process.pid}.json`);
  fs.writeFileSync(f, JSON.stringify({ defaultProfile: "d", profiles: { d: {
    accessToken: "SHOULD-NEVER-BE-PRINTED", apiUrl: "https://x.test",
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  } } }));
  let threw = null;
  try { resolveSession({ env: {}, credentialsPath: f }); } catch (e) { threw = e; }
  ok(/expired/i.test(threw?.message ?? ""), "an expired session says so, rather than 401ing mid-push");
  ok(!/SHOULD-NEVER-BE-PRINTED/.test(threw?.message ?? ""), "…and the error never carries the token value");

  fs.writeFileSync(f, JSON.stringify({ defaultProfile: "d", profiles: { d: {
    accessToken: "tok", apiUrl: "https://x.test",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(), email: "a@b.test",
  } } }));
  const s2 = resolveSession({ env: {}, credentialsPath: f });
  ok(s2.token === "tok" && s2.apiUrl === "https://x.test", "a valid session resolves from the store");
  ok(s2.source === "profile:d", "…and names which profile it came from");
  fs.unlinkSync(f);
}

console.log();
if (fail) { console.log(`❌ ${fail} pipeline assertion(s) failed`); process.exit(1); }
console.log("✅ chunking + sync + session: all assertions passed");
