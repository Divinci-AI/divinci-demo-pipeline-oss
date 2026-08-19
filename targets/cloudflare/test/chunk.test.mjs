import { chunkMarkdown, splitOversized, byteLen } from "../src/chunk.js";
let fail = 0;
const ok = (c, m) => { if (!c) { console.log("  ❌ " + m); fail++; } else console.log("  ✅ " + m); };

// trailer cut
ok(chunkMarkdown("# T\n\nalpha\n\n## Related\n\nbeta").join("|") === "alpha", "cuts ## Related trailer");
ok(chunkMarkdown("# T\n\nalpha\n\n## Source\n\nbeta").join("|") === "alpha", "cuts ## Source trailer");
// headings dropped
ok(chunkMarkdown("# Title\n\n## Sub\n\nbody").join("|") === "body", "drops headings");
// blank split
ok(chunkMarkdown("a\n\nb\n\nc").length === 3, "splits on blank lines");
// hard cap, bytes not UTF-16 units
const big = "café ".repeat(3000);          // 6 bytes per 5 chars
const parts = splitOversized(big, 500);
ok(parts.length > 1, "splits oversized");
ok(parts.every(p => byteLen(p) <= 500), `every piece <= 500 BYTES (max ${Math.max(...parts.map(byteLen))})`);
// no tiny fragments except the tail
const mid = parts.slice(0, -1);
ok(mid.every(p => byteLen(p) >= 250), "no fragment below max/2");
// lossless-ish: no content dropped
ok(parts.join(" ").replace(/\s+/g,"") === big.replace(/\s+/g,""), "no content lost in split");
// a block with no break points still terminates
const nobreak = "x".repeat(20000);
ok(splitOversized(nobreak, 6000).length === 4, "hard-splits a block with no whitespace");
console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
