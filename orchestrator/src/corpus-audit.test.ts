import { describe, it, expect } from "vitest";
import { isFurnitureChunk, summariseCorpus, needsRecrawl, RECRAWL_THRESHOLD } from "./corpus-audit.js";

/**
 * Pins the measurement that found 16 demo corpora worth re-crawling — led by
 * acmelaw at 100% and acmesecurity at 63% — after the live Acme Security assistant said it
 * had "no specific details on the types of spaces available" about a page that
 * describes them in 743 words.
 */
const REAL_FURNITURE = `**Type**: WebPage
**@graph > name**: About - Acme Security Cowork
**@graph > datePublished**: 2022-07-19T14:27:06+00:00
**@graph > dateModified**: 2026-05-27T03:48:07+00:00
**@graph > inLanguage**: en-US
**Type**: BreadcrumbList
**Type**: ListItem
**@graph > itemListElement > position**: 1`;

const REAL_PROSE = `Our coworking space is an open work area, and offers a variety of amenities,
including a kitchenette with water, coffee and tea, standing desks, flexible and
dedicated desks, as well as a private phone area. Our vision is to provide our
members with a great work space where they can take action and get work done.`;

describe("isFurnitureChunk", () => {
  it("flags a real Yoast furniture chunk", () => {
    expect(isFurnitureChunk(REAL_FURNITURE)).toBe(true);
  });

  it("does NOT flag real prose", () => {
    // A false positive here sends us re-crawling a corpus that is fine, which
    // costs a full ingest plus a WWW-RAG submit per demo.
    expect(isFurnitureChunk(REAL_PROSE)).toBe(false);
  });

  it("does not flag prose that merely mentions a colon-led label", () => {
    expect(isFurnitureChunk("**Hours**: we are open 9-5 and the space is quiet in the mornings.")).toBe(false);
  });

  it("needs an explicit furniture TYPE for a short chunk", () => {
    // Two or three structured lines say very little on their own; requiring the
    // type stops a short Product or LocalBusiness block being called furniture.
    expect(isFurnitureChunk("**Type**: Product\n**name**: Dedicated Desk")).toBe(false);
    expect(isFurnitureChunk("**Type**: BreadcrumbList\n**@graph > position**: 1")).toBe(true);
  });

  it("treats an empty chunk as not-furniture rather than throwing", () => {
    expect(isFurnitureChunk("")).toBe(false);
  });
});

describe("summariseCorpus", () => {
  it("reports chunk share AND text share separately", () => {
    // Furniture chunks are often LONGER than prose ones, so the share of
    // corpus TEXT wasted can exceed the share of chunks — Acme Security was 82% of
    // chunks but 84% of text. Reporting only one hides that.
    const s = summariseCorpus("x", [REAL_FURNITURE, REAL_PROSE]);
    expect(s.chunks).toBe(2);
    expect(s.furniture).toBe(1);
    expect(s.furnitureRate).toBeCloseTo(0.5);
    expect(s.textRate).toBeGreaterThan(0);
    expect(s.textRate).toBeLessThan(1);
  });

  it("returns zeroes, not NaN, for an empty corpus", () => {
    // A torn-down demo's vector 404s and yields no chunks. NaN would render as
    // a blank cell and read as "clean".
    const s = summariseCorpus("gone", []);
    expect(s.furnitureRate).toBe(0);
    expect(s.textRate).toBe(0);
  });
});

describe("needsRecrawl", () => {
  it("does not flag a corpus with only incidental structured data", () => {
    // Every site emits some. 25% is deliberately not 0 — below it the
    // retrieval-time filter copes and a re-crawl is not worth the cost.
    expect(RECRAWL_THRESHOLD).toBe(0.25);
    expect(needsRecrawl({ prospect: "a", chunks: 100, furniture: 20, furnitureRate: 0.2, textRate: 0.18 })).toBe(false);
  });

  it("flags the measured offenders", () => {
    for (const [p, rate] of [["acmelaw", 1.0], ["acmesecurity", 0.63], ["acmebio", 0.51]] as const) {
      expect(needsRecrawl({ prospect: p, chunks: 120, furniture: Math.round(120 * rate), furnitureRate: rate, textRate: rate }), p).toBe(true);
    }
  });

  it("never flags an EMPTY corpus for re-crawl", () => {
    // 17 vectors 404 because their demos were torn down. Re-crawling those
    // would rebuild corpora nobody is going to look at.
    expect(needsRecrawl({ prospect: "gone", chunks: 0, furniture: 0, furnitureRate: 0, textRate: 0 })).toBe(false);
  });
});
