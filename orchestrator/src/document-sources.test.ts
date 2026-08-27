/**
 * The document lane: PDFs the prospect publishes, which a crawl can never
 * reach.
 *
 * Found 2026-08-27. `recon` had been finding these files since it was written
 * and reporting them as a COUNT — `- linked documents (PDF/Office): 2` — with
 * the URLs kept out of the prompt entirely, so the manifest author had no way
 * to act on them even in principle. Every demo this pipeline has ever built
 * was text-only by construction.
 *
 * Measured cost on bermanmedicallasers.com: the server's own self-serve scan
 * of the same site ingested NINE eBooks and flipbooks. The demo we built the
 * day before had none of them, and reported success.
 */
import { describe, it, expect } from "vitest";
import {
  assembleManifest,
  buildManifestPrompt,
  MAX_DOCUMENT_SOURCES,
  type QueuedProspect,
  type SiteRecon,
} from "./intake.js";
import { isDocumentSource, validateManifest } from "./types.js";
import { documentFileName, ensureExtension, looksLikeDocument } from "./document-ingest.js";

const prospect: QueuedProspect = {
  slug: "berman",
  name: "Berman Medical Lasers",
  url: "https://bermanmedicallasers.com",
  anchorCustomer: "attio:deals/x",
  complianceTier: "commerce-medium",
  crawlPages: 100,
};

const DOCS = [
  "https://bermanmedicallasers.com/wp-content/uploads/2021/12/045-Laser-buyers-guide.pdf",
  "https://bermanmedicallasers.com/wp-content/uploads/2021/12/048-How-does-a-therapeutic-laser-work.pdf",
];

const recon: SiteRecon = {
  url: prospect.url,
  reachable: true,
  sitemapUrls: ["https://bermanmedicallasers.com/blog/1"],
  topPaths: [{ prefix: "/blog/", count: 1 }],
  likelySpa: false,
  discovery: "sitemap",
  documents: DOCS,
  mediaFiles: [],
  embeds: [],
  note: "2 linked document(s) (PDF/Office)",
};
const input = { prospect, recon, runId: "2026-08-27-001" };

function proposal(sources: unknown[]) {
  return {
    sources,
    evalQueries: ["q1", "q2", "q3"],
    chat: { starters: ["a", "b", "c"], welcomeMessage: "hi" },
  };
}

const crawlSource = {
  id: "site", url: "https://bermanmedicallasers.com/blog", type: "blog",
  rationale: "columns", license: "public web", estPages: 60,
  crawl: { multi: true, sitemap: true, limit: 60 },
};

function docSource(url: string, id = "doc") {
  return { id, url, type: "document", rationale: "buyer's guide", license: "public web", estPages: 1 };
}

describe("buildManifestPrompt — documents", () => {
  it("lists the document URLs, not just how many there are", () => {
    const p = buildManifestPrompt(input);
    for (const url of DOCS) expect(p).toContain(url);
  });

  it("tells the author how to shape a document source", () => {
    const p = buildManifestPrompt(input);
    expect(p).toContain('"type": "document"');
    expect(p).toMatch(/carries NO crawl block/);
  });

  it("says nothing about documents when the site has none", () => {
    const p = buildManifestPrompt({ ...input, recon: { ...recon, documents: [] } });
    expect(p).not.toMatch(/document URLs/);
  });
});

describe("assembleManifest — document sources", () => {
  it("keeps a document source with no crawl block", () => {
    const m = assembleManifest(input, proposal([crawlSource, docSource(DOCS[0])]));
    const doc = m.sources.find(isDocumentSource);
    expect(doc).toBeDefined();
    expect(doc?.crawl).toBeUndefined();
    expect(doc?.estPages).toBe(1);
  });

  it("NEVER lets the page budget clamp a document away", () => {
    // The exact failure the reservation exists for: a crawl that asks for the
    // whole budget used to consume it first, leaving 0 for everything after —
    // and a source clamped to limit 0 is dropped silently.
    const greedy = { ...crawlSource, estPages: 100, crawl: { multi: true, sitemap: true, limit: 100 } };
    const m = assembleManifest(input, proposal([greedy, docSource(DOCS[0], "d1"), docSource(DOCS[1], "d2")]));

    expect(m.sources.filter(isDocumentSource)).toHaveLength(2);
    expect(validateManifest(m)).toEqual([]);
    // The crawl gives way, not the documents.
    expect(m.sources.find((s) => s.id === "site")?.crawl?.limit).toBe(98);
  });

  it("caps the number of documents", () => {
    const many = Array.from({ length: MAX_DOCUMENT_SOURCES + 8 }, (_, i) =>
      docSource(`https://bermanmedicallasers.com/f${i}.pdf`, `d${i}`));
    const m = assembleManifest(input, proposal([crawlSource, ...many]));
    expect(m.sources.filter(isDocumentSource)).toHaveLength(MAX_DOCUMENT_SOURCES);
  });

  it("still refuses an off-domain document — the rule that matters most here", () => {
    // A PDF is exactly the kind of link that wanders off-domain (a vendor
    // datasheet, a journal reprint), and we send this demo to the company we
    // crawled.
    expect(() =>
      assembleManifest(input, proposal([crawlSource, docSource("https://competitor.com/x.pdf")])),
    ).toThrow(/not on the prospect's domain/);
  });
});

describe("looksLikeDocument", () => {
  it("accepts a real PDF", () => {
    expect(looksLikeDocument(Buffer.from("%PDF-1.7"), "application/pdf").ok).toBe(true);
  });

  it("accepts OOXML and legacy Office", () => {
    expect(looksLikeDocument(Buffer.from("PK", "latin1"), null).ok).toBe(true);
    expect(looksLikeDocument(Buffer.from("d0cf11e0a1b11ae1", "hex"), null).ok).toBe(true);
  });

  it("REFUSES an HTML page served for a .pdf URL", () => {
    // A dead .pdf link commonly answers 200 with a themed 404. Ingesting that
    // puts "Page Not Found" into the corpus as a document, where nothing
    // downstream can tell it from content: the upload succeeds and the chunk
    // count goes up.
    const html = Buffer.from("<!DOCTYPE html><html><head><title>Page Not Found</title>");
    const verdict = looksLikeDocument(html, "text/html; charset=utf-8");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/HTML page/);
  });

  it("REFUSES an HTML body even when the server claims it is a PDF", () => {
    const html = Buffer.from("  <html><body>Access denied</body></html>");
    expect(looksLikeDocument(html, "application/pdf").ok).toBe(false);
  });

  it("accepts plain text and CSV, which have no magic bytes", () => {
    expect(looksLikeDocument(Buffer.from("name,price"), "text/csv").ok).toBe(true);
  });

  it("refuses unrecognized binary rather than guessing", () => {
    expect(looksLikeDocument(Buffer.from("00010203", "hex"), null).ok).toBe(false);
  });
});

describe("documentFileName", () => {
  it("takes the filename from the URL path", () => {
    expect(documentFileName(DOCS[0])).toBe("045-Laser-buyers-guide.pdf");
  });

  it("survives query strings, encoding and a pathless URL", () => {
    expect(documentFileName("https://x.com/a/b/My%20Guide.pdf?v=2")).toBe("My-Guide.pdf");
    expect(documentFileName("https://x.com/")).toBe("document");
  });
});

describe("ensureExtension", () => {
  it("leaves a name that already has one alone", () => {
    expect(ensureExtension("guide.pdf", Buffer.from("%PDF"))).toBe("guide.pdf");
  });

  it("takes the extension from the BYTES for a routed URL that has none", () => {
    // "…/download" and "…/view?id=7" are real shapes, and the server picks its
    // chunker by extension — an unnamed blob gets none.
    expect(ensureExtension("download", Buffer.from("%PDF-1.4"))).toBe("download.pdf");
    expect(ensureExtension("download", Buffer.from("PK", "latin1"))).toBe("download.docx");
    expect(ensureExtension("download", Buffer.from("d0cf11e0", "hex"))).toBe("download.doc");
  });
});
