// Merge the chunker's output up to a useful size.
//
// ── Why this exists ─────────────────────────────────────────────────────────
//
// `chunkMarkdown` splits on blank lines, which is right for the markdown it was
// written for (okf.rs page dumps: real prose separated by real paragraph
// breaks). HTML-derived text is not that. A nav menu, a footer and a link list
// all become one short "paragraph" per item, so the chunker faithfully emits
// one chunk per menu entry.
//
// Measured on a real homepage: 11,585 characters produced 170 chunks, with
// sizes including 7, 17 and 22 characters. Those are not retrievable units —
// a 7-character chunk embeds to a vector that is nearest-neighbour to noise,
// and 170 of them cost 170 embeddings and 170 rows to say very little.
//
// ⚠️ It still does NOT belong inside `chunk.js` — that module is the raw split,
// and keeping the two separate is what lets a caller choose. But this file used
// to live in the local target only, arguing that the Cloudflare pipeline did
// not need it "whose input really is markdown".
//
// MEASURED 2026-08-20, and that argument was wrong. Browser Rendering's
// markdown of a real site carries the same nav, footer and link lists as any
// other HTML-derived text. On a 98-page crawl the Cloudflare pipeline emitted:
//
//     6,265 chunks   median 126 B   45% under 100 B   26% under 50 B
//
// and the same set through this function gives:
//
//       715 chunks   median 1,978 B          8.8x fewer embeddings
//
// A quarter of that index was fragments too small to carry meaning, each one
// costing an embedding, a row, and a nearest-neighbour slot. The old comment is
// a good example of a confidently-argued assumption that one real run refutes:
// it was written from what the input was *supposed* to be.

import { byteLen, HARD_MAX } from "../../cloudflare/src/chunk.js";

/** Below this a chunk is not worth embedding on its own. */
export const MIN_CHUNK_BYTES = 400;

/** Merged chunks stop growing here — well under the chunker's hard cap. */
export const TARGET_CHUNK_BYTES = 2000;

/**
 * Coalesce adjacent chunks until each reaches MIN_CHUNK_BYTES, without letting
 * any exceed HARD_MAX.
 *
 * Order is preserved and nothing is reordered or deduped: adjacency is the only
 * evidence that two fragments belong together, so shuffling would merge a
 * footer into a heading.
 *
 * A trailing run too small to reach the floor is still emitted if it is the
 * ONLY thing on the page — dropping it would silently discard a genuinely short
 * page — but is dropped when other chunks exist, which is the boilerplate case.
 */
export function coalesceChunks(chunks, {
  min = MIN_CHUNK_BYTES, target = TARGET_CHUNK_BYTES, hardMax = HARD_MAX,
} = {}) {
  const out = [];
  let buf = "";

  const flush = () => { if (buf) { out.push(buf); buf = ""; } };

  for (const c of chunks) {
    const piece = c.trim();
    if (!piece) continue;

    // Already substantial on its own — emit whatever is buffered, then it.
    if (byteLen(piece) >= target) { flush(); out.push(piece); continue; }

    const merged = buf ? `${buf}\n\n${piece}` : piece;
    if (byteLen(merged) > hardMax) { flush(); buf = piece; continue; }

    buf = merged;
    if (byteLen(buf) >= target) flush();
  }
  flush();

  if (out.length <= 1) return out.filter(Boolean);
  return out.filter((c) => byteLen(c) >= min);
}
