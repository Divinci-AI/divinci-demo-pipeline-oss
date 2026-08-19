import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseQueue,
  selectNextProspect,
  hasRun,
  assembleManifest,
  buildManifestPrompt,
  stripJsonFences,
  summarizePaths,
  extractSitemapUrls,
  looksLikeSpa,
  isSitemapUrl,
  decodeXmlEntities,
  nextRunId,
  type QueuedProspect,
  type SiteRecon, compareProspects } from "./intake.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "intake-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const QUEUE = `
prospects:
  - slug: acmeclinic
    name: The Stone Clinic
    url: https://acmeclinic.com
    anchorCustomer: "attio:deals/x"
    complianceTier: clinic-high
    score: 86
  - slug: acmemd
    name: Dr. William Li
    url: https://acmemd.com
    anchorCustomer: "attio:deals/y"
    complianceTier: wellness-low
    score: 95
    hold: true
`;

describe("parseQueue", () => {
  it("parses a well-formed queue", () => {
    const q = parseQueue(QUEUE);
    expect(q).toHaveLength(2);
    expect(q[0].slug).toBe("acmeclinic");
    expect(q[1].hold).toBe(true);
  });

  it("REFUSES a missing complianceTier — it picks the QA hazards and the prompt", () => {
    const bad = `
prospects:
  - slug: x
    name: X
    url: https://x.com
    anchorCustomer: "attio:deals/x"
`;
    expect(() => parseQueue(bad)).toThrow(/complianceTier/);
  });

  it("refuses an unknown complianceTier rather than defaulting", () => {
    const bad = QUEUE.replace("clinic-high", "sort-of-medical");
    expect(() => parseQueue(bad)).toThrow(/complianceTier/);
  });

  it("refuses a slug that is not a safe directory name", () => {
    const bad = QUEUE.replace("slug: acmeclinic", "slug: ../../etc");
    expect(() => parseQueue(bad)).toThrow(/kebab-case/);
  });

  it("refuses a relative url", () => {
    const bad = QUEUE.replace("https://acmeclinic.com", "acmeclinic.com");
    expect(() => parseQueue(bad)).toThrow(/absolute/);
  });

  it("refuses a file with no prospects list", () => {
    expect(() => parseQueue("something: else")).toThrow(/prospects/);
  });
});

describe("selectNextProspect", () => {
  const queue = parseQueue(QUEUE);

  it("skips held prospects even when they score highest", () => {
    // acmemd scores 95 but is held; taking it would crawl a site a human
    // deliberately parked.
    const next = selectNextProspect(queue, tmp());
    expect(next?.slug).toBe("acmeclinic");
  });

  it("skips a prospect that already has a run — no duplicate crawls", () => {
    const runs = tmp();
    mkdirSync(join(runs, "acmeclinic", "2026-08-04-001"), { recursive: true });
    writeFileSync(join(runs, "acmeclinic", "2026-08-04-001", "manifest.json"), "{}");
    expect(selectNextProspect(queue, runs)).toBeUndefined();
  });

  it("ignores a run directory with no manifest (an aborted intake)", () => {
    const runs = tmp();
    mkdirSync(join(runs, "acmeclinic", "2026-08-04-001"), { recursive: true });
    expect(selectNextProspect(queue, runs)?.slug).toBe("acmeclinic");
  });

  it("honours an explicit priority ahead of score", () => {
    // "Do this one next" is an instruction score cannot express. Before this,
    // the only way to express it was to hold everything ranked above — which
    // parks prospects for a reason unrelated to their merit.
    const q: QueuedProspect[] = [
      { slug: "high", name: "H", url: "https://h.com", anchorCustomer: "x", complianceTier: "wellness-low", score: 97 },
      { slug: "wanted", name: "W", url: "https://w.com", anchorCustomer: "x", complianceTier: "wellness-low", score: 60, priority: 100 },
    ];
    expect(selectNextProspect(q, tmp())?.slug).toBe("wanted");
  });

  it("still falls back to score when priorities tie", () => {
    const q: QueuedProspect[] = [
      { slug: "a", name: "A", url: "https://a.com", anchorCustomer: "x", complianceTier: "wellness-low", score: 10, priority: 5 },
      { slug: "b", name: "B", url: "https://b.com", anchorCustomer: "x", complianceTier: "wellness-low", score: 90, priority: 5 },
    ];
    expect(selectNextProspect(q, tmp())?.slug).toBe("b");
  });

  it("a held prospect is not rescued by a high priority", () => {
    const q: QueuedProspect[] = [
      { slug: "held", name: "H", url: "https://h.com", anchorCustomer: "x", complianceTier: "wellness-low", score: 10, priority: 999, hold: true },
      { slug: "ok", name: "O", url: "https://o.com", anchorCustomer: "x", complianceTier: "wellness-low", score: 10 },
    ];
    expect(selectNextProspect(q, tmp())?.slug).toBe("ok");
  });

  it("sorts by score, then by queue order", () => {
    const q: QueuedProspect[] = [
      { slug: "a", name: "A", url: "https://a.com", anchorCustomer: "x", complianceTier: "wellness-low", score: 10 },
      { slug: "b", name: "B", url: "https://b.com", anchorCustomer: "x", complianceTier: "wellness-low", score: 90 },
    ];
    expect(selectNextProspect(q, tmp())?.slug).toBe("b");
  });
});

describe("hasRun", () => {
  const PROD = "https://api.divinci.app";
  const STAGE = "https://api.stage.divinci.app";

  function runWith(state?: Record<string, unknown>): string {
    const runs = tmp();
    const dir = join(runs, "acme", "2026-06-01-001");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), "{}");
    if (state) writeFileSync(join(dir, "state.json"), JSON.stringify(state));
    return runs;
  }

  it("is false for an unknown slug", () => {
    expect(hasRun(tmp(), "nobody")).toBe(false);
  });

  it("counts any run when no environment is named", () => {
    expect(hasRun(runWith({ apiUrl: STAGE }), "acme")).toBe(true);
  });

  it("does NOT block a production rebuild of a staging demo", () => {
    // The whole point: a demo built on staging lives in a different account
    // behind a different release. It is not a demo you can send from
    // production, so it must not make the prospect look taken there.
    expect(hasRun(runWith({ apiUrl: STAGE }), "acme", PROD)).toBe(false);
  });

  it("DOES block a second run in the SAME environment", () => {
    expect(hasRun(runWith({ apiUrl: PROD }), "acme", PROD)).toBe(true);
  });

  it("treats a fresh intake with no state.json as taken everywhere", () => {
    // Between intake and the first advance nothing has stamped apiUrl. Treating
    // that as free would let the next tick intake the same prospect again and
    // crawl a real company's site twice.
    expect(hasRun(runWith(), "acme", PROD)).toBe(true);
    expect(hasRun(runWith(), "acme", STAGE)).toBe(true);
  });

  it("treats an un-stamped legacy run as belonging to whoever asks", () => {
    // Pre-dates apiUrl. Rebuilding over it silently would be worse than
    // reporting it as taken and making a human look.
    expect(hasRun(runWith({ step: "outreach" }), "acme", PROD)).toBe(true);
  });

  it("does not rebuild over a run whose state is unreadable", () => {
    const runs = tmp();
    const dir = join(runs, "acme", "2026-06-01-001");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), "{}");
    writeFileSync(join(dir, "state.json"), "{ corrupt");
    expect(hasRun(runs, "acme", PROD)).toBe(true);
  });
});

describe("selectNextProspect — environment scoping", () => {
  it("offers a staging-built prospect for a production rebuild", () => {
    const runs = tmp();
    const dir = join(runs, "acmeclinic", "2026-06-01-001");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), "{}");
    writeFileSync(join(dir, "state.json"), JSON.stringify({ apiUrl: "https://api.stage.divinci.app" }));

    const queue = parseQueue(QUEUE);
    expect(selectNextProspect(queue, runs)).toBeUndefined(); // unscoped: taken
    expect(selectNextProspect(queue, runs, "https://api.divinci.app")?.slug).toBe("acmeclinic");
  });
});

describe("recon helpers", () => {
  it("extracts sitemap locs", () => {
    const xml = "<urlset><url><loc>https://x.com/a</loc></url><url><loc>https://x.com/b</loc></url></urlset>";
    expect(extractSitemapUrls(xml)).toEqual(["https://x.com/a", "https://x.com/b"]);
  });

  it("DECODES XML entities in <loc> — an escaped & would corrupt the query", () => {
    // Shopify emits sitemap_products_1.xml?from=1&amp;to=2. Fetching the raw
    // string sends a literal "&amp;" as part of the parameter name.
    const xml = "<urlset><url><loc>https://x.com/s.xml?from=1&amp;to=2</loc></url></urlset>";
    expect(extractSitemapUrls(xml)).toEqual(["https://x.com/s.xml?from=1&to=2"]);
  });

  it("decodes &amp; last so a double-escaped entity is not decoded twice", () => {
    expect(decodeXmlEntities("&amp;lt;")).toBe("&lt;");
  });

  describe("isSitemapUrl", () => {
    it("recognises a nested sitemap that carries a QUERY STRING", () => {
      // The real bug: /\.xml$/ against the full URL fails here, so Shopify's
      // product/page/collection indexes were treated as content pages and never
      // followed. newagedrinks.com reported 45 pages; the real inventory sits
      // behind exactly these.
      expect(isSitemapUrl("https://x.com/sitemap_products_1.xml?from=1&to=2")).toBe(true);
    });

    it("recognises plain and gzipped sitemaps", () => {
      expect(isSitemapUrl("https://x.com/sitemap.xml")).toBe(true);
      expect(isSitemapUrl("https://x.com/sitemap.xml.gz")).toBe(true);
    });

    it("does not mistake a content page for a sitemap", () => {
      expect(isSitemapUrl("https://x.com/blogs/how-we-make-xml")).toBe(false);
      // A page whose QUERY mentions .xml is still a page.
      expect(isSitemapUrl("https://x.com/search?q=sitemap.xml")).toBe(false);
    });
  });

  it("summarizes busiest path prefixes", () => {
    const paths = summarizePaths([
      "https://x.com/blog/1",
      "https://x.com/blog/2",
      "https://x.com/about",
      "https://x.com/",
    ]);
    expect(paths[0]).toEqual({ prefix: "/blog/", count: 2 });
  });

  it("flags a script-heavy, text-empty page as SPA — it would crawl as blank", () => {
    const spa = `<html><body><div id="root"></div>${"<script src=x></script>".repeat(5)}</body></html>`;
    expect(looksLikeSpa(spa)).toBe(true);
  });

  it("does not flag a content-rich server-rendered page", () => {
    const html = `<html><body><p>${"clinical content ".repeat(200)}</p><script src=a></script></body></html>`;
    expect(looksLikeSpa(html)).toBe(false);
  });

  // Regression, 2026-08-08. The heuristic stripped <script> but not <style>, so
  // it counted CSS as prose. Measured on plugandplaytechcenter.com: 22,514 of
  // 24,622 bytes were inside three <style> blocks; it scored 664 "words" and
  // returned false for a page with THREE real words. All five of that
  // prospect's sources were planned as plain fetch crawls and came back empty.
  it("does not count inlined CSS as page content", () => {
    const css = "body{margin:0;padding:0;font-family:system-ui,sans-serif;color:#111} ".repeat(60);
    const shell = `<html><head><style>${css}</style></head><body><div id="app"></div><script src=a></script></body></html>`;
    expect(looksLikeSpa(shell)).toBe(true);
  });

  it("is not fooled by a stylesheet large enough to clear the word threshold", () => {
    // The real shape: enough CSS that the OLD heuristic saw >200 words.
    const css = "--tw-ring-offset-shadow:0 0 #0000;--tw-ring-shadow:0 0 #0000; ".repeat(200);
    const shell = `<html><head><style>${css}</style></head><body><div id="root"></div><script type=module src=/a.js></script></body></html>`;
    const oldWords = shell.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ")
      .split(/\s+/).filter((w) => w.length > 2).length;
    expect(oldWords).toBeGreaterThan(200); // the old check would have passed it
    expect(looksLikeSpa(shell)).toBe(true); // the new one does not
  });

  it("flags a bundled SPA that ships a SINGLE module script", () => {
    // The old threshold was `scripts >= 3`, which missed the tidiest builds.
    const shell = `<html><body><div id="root"></div><script type=module src=/assets/index.js></script></body></html>`;
    expect(looksLikeSpa(shell)).toBe(true);
  });

  it("still passes a text-light page that is genuinely server-rendered", () => {
    // 200+ real words with a script present must NOT be flagged, or every
    // small brochure site gets an unnecessarily slow browser-rendered crawl.
    const html = `<html><head><style>.a{color:red}</style></head><body><p>${"real prose here ".repeat(120)}</p><script src=a></script></body></html>`;
    expect(looksLikeSpa(html)).toBe(false);
  });
});

// ---------------------------------------------------------------- assembly

const prospect: QueuedProspect = {
  slug: "acmeclinic",
  name: "The Stone Clinic",
  url: "https://acmeclinic.com",
  anchorCustomer: "attio:deals/x",
  complianceTier: "clinic-high",
  crawlPages: 100,
};
const recon: SiteRecon = {
  url: prospect.url,
  reachable: true,
  sitemapUrls: ["https://acmeclinic.com/blog/1"],
  topPaths: [{ prefix: "/blog/", count: 1 }],
  likelySpa: false,
  discovery: "sitemap",
  documents: [],
  mediaFiles: [],
  embeds: [],
};
const input = { prospect, recon, runId: "2026-08-04-001" };

function proposal(over: Record<string, unknown> = {}) {
  return {
    sources: [
      {
        id: "site",
        url: "https://acmeclinic.com/blog",
        type: "blog",
        rationale: "columns",
        license: "public web",
        estPages: 60,
        crawl: { multi: true, sitemap: true, limit: 60 },
      },
    ],
    evalQueries: ["q1", "q2", "q3"],
    chat: { starters: ["a", "b", "c"], welcomeMessage: "hi" },
    ...over,
  };
}

describe("assembleManifest", () => {
  it("produces a manifest that passes validateManifest", () => {
    const m = assembleManifest(input, proposal());
    expect(m.prospect).toBe("acmeclinic");
    expect(m.sources).toHaveLength(1);
  });

  it("ALWAYS leaves Gate 1 shut, even if the model tries to approve itself", () => {
    const m = assembleManifest(input, proposal({ approvedBy: "Mike", approvedAt: "2026-08-04" }));
    expect(m.approvedBy).toBeNull();
    expect(m.approvedAt).toBeNull();
  });

  it("REFUSES an off-domain source — a competitor's page in their corpus", () => {
    const off = proposal({
      sources: [
        {
          id: "rival",
          url: "https://competitor.com/pricing",
          estPages: 10,
          crawl: { limit: 10 },
        },
      ],
    });
    expect(() => assembleManifest(input, off)).toThrow(/not on the prospect's domain/);
  });

  it("accepts a subdomain of the prospect", () => {
    const sub = proposal({
      sources: [{ id: "docs", url: "https://blog.acmeclinic.com/x", estPages: 5, crawl: { limit: 5 } }],
    });
    expect(assembleManifest(input, sub).sources[0].url).toContain("blog.acmeclinic.com");
  });

  it("forces tier T1 and destination rag regardless of what the model said", () => {
    const sneaky = proposal({
      sources: [
        {
          id: "s",
          url: "https://acmeclinic.com/x",
          tier: "T3",
          destination: "fine-tune",
          estPages: 5,
          crawl: { limit: 5 },
        },
      ],
    });
    const m = assembleManifest(input, sneaky);
    expect(m.sources[0].tier).toBe("T1");
    expect(m.sources[0].destination).toBe("rag");
  });

  it("clamps an over-budget plan instead of failing the run", () => {
    const over = proposal({
      sources: [
        { id: "a", url: "https://acmeclinic.com/a", estPages: 80, crawl: { limit: 80 } },
        { id: "b", url: "https://acmeclinic.com/b", estPages: 80, crawl: { limit: 80 } },
      ],
    });
    const m = assembleManifest(input, over);
    const total = m.sources.reduce((n, s) => n + (s.crawl?.limit ?? 0), 0);
    expect(total).toBeLessThanOrEqual(100);
    // …and the surviving sources are still coherent, not zero-page stubs.
    expect(m.sources.every((s) => (s.crawl?.limit ?? 0) > 0)).toBe(true);
  });

  it("rejects a proposal with too few eval queries", () => {
    expect(() => assembleManifest(input, proposal({ evalQueries: ["only-one"] }))).toThrow(/evalQueries/);
  });

  it("rejects a proposal with no sources", () => {
    expect(() => assembleManifest(input, proposal({ sources: [] }))).toThrow(/no sources/);
  });

  it("caps starters at 3 — the server caps them anyway", () => {
    const m = assembleManifest(input, proposal({ chat: { starters: ["a", "b", "c", "d", "e"] } }));
    expect(m.chat?.starters).toHaveLength(3);
  });

  it("sets the browser-rendering scraper when recon saw an SPA", () => {
    const m = assembleManifest({ ...input, recon: { ...recon, likelySpa: true } }, proposal());
    expect(m.sources[0].crawl?.scraper).toBe("@cloudflare/browser-rendering");
  });
});

describe("buildManifestPrompt", () => {
  it("forbids off-domain sources and T3 explicitly", () => {
    const p = buildManifestPrompt(input);
    expect(p).toMatch(/own domain/);
    expect(p).toMatch(/T3/);
  });

  it("tells the model to use browser rendering for an SPA", () => {
    const p = buildManifestPrompt({ ...input, recon: { ...recon, likelySpa: true } });
    expect(p).toContain("@cloudflare/browser-rendering");
  });

  it("carries the crawl budget into the prompt", () => {
    expect(buildManifestPrompt(input)).toContain("100");
  });
});

describe("stripJsonFences", () => {
  it("unwraps a fenced block", () => {
    expect(stripJsonFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it("trims prose around a bare object", () => {
    expect(stripJsonFences('Here you go: {"a":1} — enjoy')).toBe('{"a":1}');
  });
});

describe("nextRunId", () => {
  it("starts at -001", () => {
    expect(nextRunId(tmp(), "x", "2026-08-04")).toBe("2026-08-04-001");
  });

  it("does not collide with an existing run on the same day", () => {
    const runs = tmp();
    mkdirSync(join(runs, "x", "2026-08-04-001"), { recursive: true });
    expect(nextRunId(runs, "x", "2026-08-04")).toBe("2026-08-04-002");
  });
});

// Standing instruction from Michael, 2026-08-09: a site he hands over directly
// runs before anything discovery found, and the direct list runs in the order
// he asked for them.
describe("compareProspects — direct requests outrank discovery", () => {
  const direct = (slug: string, directSeq: number, score = 0) =>
    ({ slug, requestedBy: "direct", directSeq, score } as never);
  const found = (slug: string, score: number, priority = 0) =>
    ({ slug, requestedBy: "discovered", score, priority } as never);

  it("puts a direct request ahead of a discovered one that scores far higher", () => {
    // buildandback scores 51 against discovered prospects in the 80s. The band
    // is absolute — that is the whole point of the rule.
    expect(compareProspects(direct("buildandback", 5, 51), found("mach33", 88))).toBeLessThan(0);
  });

  it("is not defeated by a high priority on the discovered side", () => {
    // A priority number could otherwise silently reorder what Michael asked for.
    expect(compareProspects(direct("buildandback", 5, 51), found("x", 99, 9999))).toBeLessThan(0);
  });

  it("runs the direct list in the order it was requested, ignoring score", () => {
    expect(compareProspects(direct("seekinghealth", 1, 82), direct("greystone", 2, 64))).toBeLessThan(0);
    // Later request, higher score — still later.
    expect(compareProspects(direct("anyaiyouwant", 6, 68), direct("buildandback", 5, 51))).toBeGreaterThan(0);
  });

  it("ranks discovered prospects among themselves by priority then score", () => {
    expect(compareProspects(found("a", 50, 90), found("b", 99, 10))).toBeLessThan(0);
    expect(compareProspects(found("a", 99), found("b", 50))).toBeLessThan(0);
  });

  it("treats an unmarked prospect as discovered — the default must not jump the queue", () => {
    const legacy = { slug: "old", score: 99 } as never;
    expect(compareProspects(direct("buildandback", 5, 51), legacy)).toBeLessThan(0);
  });

  it("sorts a direct entry with no directSeq AFTER sequenced ones, not first", () => {
    // A missing field must never promote something above what Michael ordered.
    const unsequenced = { slug: "oops", requestedBy: "direct" } as never;
    expect(compareProspects(unsequenced, direct("anyaiyouwant", 6))).toBeGreaterThan(0);
  });
});

describe("parseQueue — requestedBy validation", () => {
  const base = (extra: string) => `prospects:
  - slug: x
    name: X
    url: https://x.example
    anchorCustomer: "test"
    complianceTier: wellness-low
${extra}`;

  it("refuses a misspelled requestedBy rather than silently demoting it", () => {
    expect(() => parseQueue(base("    requestedBy: dirrect\n"))).toThrow(/requestedBy/);
  });

  it("refuses a direct prospect with no directSeq — the list would have no order", () => {
    expect(() => parseQueue(base("    requestedBy: direct\n"))).toThrow(/directSeq/);
  });

  it("accepts a properly ordered direct entry", () => {
    const q = parseQueue(base("    requestedBy: direct\n    directSeq: 7\n"));
    expect(q[0].requestedBy).toBe("direct");
    expect(q[0].directSeq).toBe(7);
  });

  it("leaves an unmarked prospect undefined rather than guessing", () => {
    expect(parseQueue(base(""))[0].requestedBy).toBeUndefined();
  });
});
