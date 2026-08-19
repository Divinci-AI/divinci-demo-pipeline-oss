// Port of okf.rs's page parser + crawl.rs's split_oversized.
//
// ⚠️ The 6000 cap is a BYTE cap in Rust (`str::len()` is bytes). JS strings are
// UTF-16, so `.length` would let a page of multi-byte text through at ~2x the
// intended size and break embedding at ingest. Every size check here goes
// through byteLen().

const ENC = new TextEncoder();
const DEC = new TextDecoder();
export const byteLen = (s) => ENC.encode(s).length;

export const HARD_MAX = 6000;

/**
 * Split a block that exceeds `max` BYTES at the latest natural boundary
 * (newline, then sentence, then word) that still leaves a piece >= max/2, so
 * we never emit tiny fragments. Mirrors crawl.rs:1385.
 */
export function splitOversized(text, max = HARD_MAX) {
  const bytes = ENC.encode(text);
  if (bytes.length <= max) return [text];

  // ⚠️ Byte-native, deliberately. The obvious port — walking characters and
  // calling byteLen(slice(0,i)) to find the cap — is O(n²) and BLEW THE WORKER
  // CPU LIMIT on the first real page (one 6000-byte window costs ~18M byte
  // ops). One encode up front plus linear scans is O(n). UTF-8 is
  // self-synchronising, so a char boundary is just "not a 0b10xxxxxx
  // continuation byte", and the cut characters (\n, '. ', ' ') are all ASCII
  // and so cannot appear inside a multi-byte sequence.
  const out = [];
  let start = 0;
  while (bytes.length - start > max) {
    let hi = start + max;
    while (hi > start && (bytes[hi] & 0xc0) === 0x80) hi--; // back off to a boundary
    if (hi === start) break; // pathological: one char wider than max
    const lo = start + Math.floor((hi - start) / 2);

    let cut = -1;
    for (let i = hi - 1; i >= lo; i--) if (bytes[i] === 0x0a) { cut = i + 1; break; }       // \n
    if (cut === -1)
      for (let i = hi - 2; i >= lo; i--) if (bytes[i] === 0x2e && bytes[i + 1] === 0x20) { cut = i + 2; break; } // ". "
    if (cut === -1)
      for (let i = hi - 1; i >= lo; i--) if (bytes[i] === 0x20) { cut = i + 1; break; }     // " "
    if (cut === -1) cut = hi;

    out.push(DEC.decode(bytes.subarray(start, cut)).trim());
    start = cut;
  }
  const tail = DEC.decode(bytes.subarray(start)).trim();
  if (tail) out.push(tail);
  return out.filter(Boolean);
}

/**
 * Turn one crawled markdown page into its chunks. Mirrors okf.rs:95 —
 * cut the `## Related` / `## Source` trailers, drop headings, split on blanks,
 * then hard-cap.
 */
export function chunkMarkdown(body, max = HARD_MAX) {
  const rel = body.indexOf("\n## Related");
  const src = body.indexOf("\n## Source");
  const cuts = [rel, src].filter((i) => i !== -1);
  const content = cuts.length ? body.slice(0, Math.min(...cuts)) : body;

  return content
    .split("\n\n")
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("# ") && !s.startsWith("## "))
    .flatMap((s) => splitOversized(s, max));
}
