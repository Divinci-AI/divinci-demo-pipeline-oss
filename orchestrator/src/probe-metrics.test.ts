/**
 * Fixtures are real probe lines from runs on 2026-08-10 / 08-07.
 */
import { describe, expect, it } from "vitest";
import {
  WEAK_TOP,
  parseProbeLine,
  parseProbes,
  retrievalLooksHealthy,
  summariseProbes,
} from "./probe-metrics.js";

const ZILLIZ = [
  { msg: 'probe "What is Milvus and how does it relate to Zilliz Cloud?": top=0.855 chunks=5 | Among the growing ecosystem' },
  { msg: 'probe "How does Bring Your Own Cloud deployment work?": top=0.788 chunks=5 | ### Deploy Zilliz Cloud' },
  { msg: 'probe "What pricing options does Zilliz Cloud offer?": top=0.880 chunks=5 | # Zilliz Cloud Pricing' },
  { msg: 'probe "What is Attu used for?": top=0.716 chunks=5 | ## The Best GUI for Milvus' },
  { msg: "ingest: 400 pages" },
];

describe("parseProbeLine", () => {
  it("reads a real line", () => {
    const r = parseProbeLine(ZILLIZ[0].msg)!;
    expect(r.question).toBe("What is Milvus and how does it relate to Zilliz Cloud?");
    expect(r.top).toBeCloseTo(0.855, 3);
    expect(r.chunks).toBe(5);
    expect(r.preview).toContain("Among the growing");
  });

  it("reads a line with no preview", () => {
    const r = parseProbeLine('probe "x": top=0.5 chunks=0')!;
    expect(r.chunks).toBe(0);
    expect(r.preview).toBe("");
  });

  it("ignores non-probe log lines", () => {
    expect(parseProbeLine("ingest: 400 pages")).toBeNull();
    // The malformed shape that once made every probe line read `probe "…": {`.
    expect(parseProbeLine('probe "x": {')).toBeNull();
  });
});

describe("summariseProbes", () => {
  it("summarises a healthy run", () => {
    const m = summariseProbes(parseProbes(ZILLIZ))!;
    expect(m.n).toBe(4);
    expect(m.meanTop).toBeCloseTo(0.81, 2);
    expect(m.emptyCount).toBe(0);
    expect(m.weakCount).toBe(0);
  });

  it("counts an empty probe that a mean would hide", () => {
    // Nine good probes and one dark one still average well. The count is the
    // signal; the mean is not.
    const withDark = [...ZILLIZ, { msg: 'probe "obscure": top=0.9 chunks=0' }];
    const m = summariseProbes(parseProbes(withDark))!;
    expect(m.emptyCount).toBe(1);
    expect(m.meanTop).toBeGreaterThan(WEAK_TOP);
  });

  it("returns null when a run has no probes", () => {
    expect(summariseProbes([])).toBeNull();
  });
});

describe("retrievalLooksHealthy", () => {
  it("says healthy for the three runs we read by hand", () => {
    // zilliz 0.716-0.880, and acmeparts/pinecone sat in the same range. All were
    // investigated as RAG failures; none was one.
    expect(retrievalLooksHealthy(summariseProbes(parseProbes(ZILLIZ)))).toBe(true);
  });

  it("refuses to call it healthy when anything came back empty", () => {
    const m = summariseProbes(parseProbes([...ZILLIZ, { msg: 'probe "q": top=0.95 chunks=0' }]));
    expect(retrievalLooksHealthy(m)).toBe(false);
  });

  it("refuses on a weak match even if nothing is empty", () => {
    const m = summariseProbes(parseProbes([...ZILLIZ, { msg: 'probe "q": top=0.31 chunks=5' }]));
    expect(retrievalLooksHealthy(m)).toBe(false);
  });

  it("will not vouch for retrieval from too few probes", () => {
    // "Healthy" here licenses ruling OUT a whole class of experiment, so it
    // needs more than one or two datapoints to say so.
    const m = summariseProbes(parseProbes(ZILLIZ.slice(0, 2)));
    expect(retrievalLooksHealthy(m)).toBe(false);
  });
});
