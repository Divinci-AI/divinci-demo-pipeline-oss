// The Cloudflare pipeline must coalesce, and must not coalesce across pages.
//
// Regression for a measured defect: until 2026-08-20 the pipeline called
// `chunkMarkdown` raw, on the argument that its input "really is markdown" and
// therefore had real paragraph breaks. A 98-page crawl produced 6,265 chunks at
// median 126 B, 26% of them under 50 B — nav items and button labels, each
// costing an embedding, a Turso row and a nearest-neighbour slot.
import { coalesceChunks } from "../src/coalesce.js";
import { chunkMarkdown } from "../src/chunk.js";
import assert from "node:assert";
import { readFileSync } from "node:fs";

let failures = 0;
const it = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`); }
  catch (e) { failures++; console.log(`  ❌ ${name}\n     ${e.message}`); }
};

console.log("coalesce");

it("collapses the one-fragment-per-menu-item shape", () => {
  // What HTML-derived markdown actually looks like: a nav list.
  const nav = ["Home", "About", "Pricing", "Docs", "Blog", "Contact"].join("\n\n");
  const body = "\n\n" + "Real prose. ".repeat(60);
  const raw = chunkMarkdown(nav + body);
  const out = coalesceChunks(raw);
  assert.ok(raw.length > out.length,
    `expected coalescing to reduce ${raw.length} fragments, got ${out.length}`);
  assert.ok(out.every((t) => t.length >= 40 || out.length === 1),
    "a coalesced chunk should not still be a single menu word");
});

it("never merges text from two different pages", () => {
  // The pipeline coalesces INSIDE the per-page loop. If that ever moves
  // outside it, a chunk carries one page's url and another page's text, and
  // the citation is silently wrong for half of it.
  const src = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  const loop = src.slice(src.indexOf("for (const p of pages)"));
  const coalesceAt = loop.indexOf("coalesceChunks");
  const loopEnd = loop.indexOf("BUCKET.put(chunkKey");
  assert.ok(coalesceAt !== -1 && coalesceAt < loopEnd,
    "coalesceChunks must be called inside the per-page loop, before the write");
});

it("is a no-op on text that is already well-formed prose", () => {
  const prose = Array.from({ length: 4 }, (_, i) =>
    `Paragraph ${i}. ` + "x".repeat(2000)).join("\n\n");
  const raw = chunkMarkdown(prose);
  const out = coalesceChunks(raw);
  assert.equal(out.length, raw.length,
    "already-large chunks should pass through untouched");
});

if (failures) { console.log(`\n❌ ${failures} failure(s)`); process.exit(1); }
console.log("  all passed");
