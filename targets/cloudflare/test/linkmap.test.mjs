// The outbound link map captured at crawl time.
//
// The invariant that carries the weight: a capped map must SAY it was capped.
// The layer this replaces reported "0 edges" for 1,458 sites that had simply
// never been scanned, and the UI rendered that identically to "links nowhere".
// Repeating that mistake one level down — silently dropping the tail of a big
// site's outbound list — would put the same ambiguity back into the data.
import { buildLinkMap, writeLinkMap, linkMapKey, LINK_MAP_VERSION } from "../src/linkmap.js";

let fail = 0;
const ok = (c, m) => { if (!c) { console.log("  ❌ " + m); fail++; } else console.log("  ✅ " + m); };

const seen = new Map([["github.com", 300], ["arxiv.org", 3], ["huggingface.co", 3]]);
const tot  = new Map([["github.com", 1204], ["arxiv.org", 3], ["huggingface.co", 9]]);

{
  const m = buildLinkMap("agno.com", 300, seen, tot, { now: 1000 });
  ok(m.v === LINK_MAP_VERSION, "carries a version so a reader can refuse a shape it cannot parse");
  ok(m.host === "agno.com" && m.pagesScanned === 300, "records the source host and how many pages were scanned");
  ok(m.outbound[0][0] === "github.com", "ranks by pages-linking, the more robust weight");
  ok(m.outbound[0][1] === 300 && m.outbound[0][2] === 1204, "keeps BOTH pagesLinking and raw link count");
  ok(m.truncated === false && m.targets === 3, "an uncapped map says so");
}

{
  // A page repeating one link in a nav block must not outrank many pages that
  // each mention a host once — that is why pagesLinking leads the sort.
  const s = new Map([["nav.example", 1], ["real.example", 40]]);
  const t = new Map([["nav.example", 999], ["real.example", 40]]);
  const m = buildLinkMap("x.com", 40, s, t, { now: 1 });
  ok(m.outbound[0][0] === "real.example", "40 pages beat one page linking 999 times");
}

{
  const big = new Map(), bt = new Map();
  for (let i = 0; i < 1500; i++) { big.set(`h${i}.com`, 1500 - i); bt.set(`h${i}.com`, 1); }
  const m = buildLinkMap("x.com", 10, big, bt, { maxTargets: 1000, now: 1 });
  ok(m.outbound.length === 1000, "caps the recorded targets");
  ok(m.truncated === true, "and SAYS it capped — a silent cap turns a measurement into a guess");
  ok(m.targets === 1500, "reports the true target count even when the list is capped");
}

{
  // Ordering must be total, or two runs over the same crawl produce different
  // objects and every diff is noise.
  const s = new Map([["b.com", 5], ["a.com", 5]]);
  const t = new Map([["b.com", 5], ["a.com", 5]]);
  const one = JSON.stringify(buildLinkMap("x.com", 1, s, t, { now: 1 }).outbound);
  const two = JSON.stringify(buildLinkMap("x.com", 1, new Map([...s.entries()].reverse()), t, { now: 1 }).outbound);
  ok(one === two, "ties break deterministically, so identical input yields an identical object");
}

{
  const puts = [];
  const env = { BUCKET: { put: async (k, v) => puts.push([k, v]) } };
  const r = await writeLinkMap(env, "agno-com", "agno.com", 300, seen, tot, { now: 1 });
  ok(r.ok === true && puts[0][0] === linkMapKey("agno-com"), "writes beside raw.json so withdrawal reaps it");
  ok(linkMapKey("agno-com") === "sites/agno-com/links.json", "key sits under the site's own prefix");
}

{
  // The step runs AFTER a successful publish. A throw here would fail — and
  // retry — a step whose real work is already done.
  const env = { BUCKET: { put: async () => { throw new Error("R2 down"); } } };
  const r = await writeLinkMap(env, "s", "s.com", 1, seen, tot);
  ok(r.ok === false && /R2 down/.test(r.reason), "an R2 failure is reported, never thrown at the publish");
}

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
