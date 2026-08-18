import { describe, it, expect, afterEach } from "vitest";
import { resolveProjectByName, isConfigured, isAvailable, type BoardProject } from "./review-board.js";

const p = (id: string, name: string): BoardProject => ({
  id,
  name,
  status: "active",
  taskCount: 0,
});

const BOARD = [
  p("stone-qualified", "Demo — The Stone Clinic (Dr. Kevin R. Stone)"),
  p("mdspine", "Demo — MD Spine Care (Dr. Frank Kuwamura)"),
  p("apbio", "Demo — Applied BioCode (apbiocode.com)"),
  p("deploys", "🚀 Deploys"),
];

describe("resolveProjectByName", () => {
  it("prefers an exact match", () => {
    const board = [...BOARD, p("stone-exact", "Demo — The Stone Clinic")];
    expect(resolveProjectByName(board, "Demo — The Stone Clinic")?.id).toBe("stone-exact");
  });

  it("REUSES a hand-qualified project rather than forking the board", () => {
    // The real regression: the first production tick created a second
    // "Demo — The Stone Clinic" alongside the existing
    // "Demo — The Stone Clinic (Dr. Kevin R. Stone)", so a prospect's history
    // would end up split across two projects.
    expect(resolveProjectByName(BOARD, "Demo — The Stone Clinic")?.id).toBe("stone-qualified");
  });

  it("refuses an AMBIGUOUS prefix instead of guessing", () => {
    // "Demo — Dr. Will" must not silently adopt "Demo — Dr. William Li".
    const board = [
      p("a", "Demo — Dr. William Li (nutrition)"),
      p("b", "Demo — Dr. William Osler (history)"),
    ];
    expect(resolveProjectByName(board, "Demo — Dr. William")).toBeUndefined();
  });

  it("does not match a longer name against a shorter project", () => {
    expect(resolveProjectByName(BOARD, "Demo — The Stone Clinic Group Holdings")).toBeUndefined();
  });

  it("requires a word boundary — no mid-word prefix adoption", () => {
    // "Demo — Applied Bio" must not adopt "Demo — Applied BioCode (…)":
    // they are different companies as far as this function can tell.
    expect(resolveProjectByName(BOARD, "Demo — Applied Bio")).toBeUndefined();
  });

  it("returns undefined for an unknown prospect so a project is created", () => {
    expect(resolveProjectByName(BOARD, "Demo — Nobody At All")).toBeUndefined();
  });

  it("is unaffected by unrelated projects on the board", () => {
    expect(resolveProjectByName(BOARD, "Demo — MD Spine Care")?.id).toBe("mdspine");
  });
});

describe("review board is optional, and unset means DISABLED", () => {
  afterEach(() => {
    delete process.env.REVIEW_BOARD_URL;
  });

  /**
   * This regressed once and shipped. `base()` defaulted to the hosted instance
   * the pipeline was first built against, so an unset variable did not mean
   * "no board" — it meant "somebody else's board". Every operator running this
   * without their own review board would have addressed their gate traffic at that
   * host, and the only thing stopping it was an access control on the far end.
   *
   * The repo's README and setup skill both promised the opposite behaviour,
   * which is how it was eventually caught: the documentation was right and the
   * code was wrong.
   */
  it("is not configured when REVIEW_BOARD_URL is unset", () => {
    delete process.env.REVIEW_BOARD_URL;
    expect(isConfigured()).toBe(false);
  });

  it("treats an empty REVIEW_BOARD_URL as unset", () => {
    process.env.REVIEW_BOARD_URL = "   ";
    expect(isConfigured()).toBe(false);
  });

  it("is configured when a URL is given", () => {
    process.env.REVIEW_BOARD_URL = "https://review-board.example.com";
    expect(isConfigured()).toBe(true);
  });

  /**
   * And it must reach that conclusion WITHOUT a network call — an unconfigured
   * install should not emit a request to anywhere at all, least of all to a
   * host it inherited from someone else's deployment.
   */
  it("reports unavailable without making a request when unconfigured", async () => {
    delete process.env.REVIEW_BOARD_URL;
    const fetchSpy = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      throw new Error("no request should be made when review board is unconfigured");
    }) as typeof fetch;
    try {
      await expect(isAvailable()).resolves.toBe(false);
      expect(called, "isAvailable() made a network call while unconfigured").toBe(false);
    } finally {
      globalThis.fetch = fetchSpy;
    }
  });
});
