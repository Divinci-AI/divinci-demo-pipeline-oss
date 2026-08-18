import { describe, it, expect } from "vitest";
import { checkClaims, claimedPageCount } from "./claims-check.js";

// Fixtures are the REAL failures this pipeline shipped, not invented ones.
// NOTE the parentheses: `.repeat(4)` binds to the last literal alone without
// them, which made this fixture 454 chars — under checkClaims's 500-char
// "did we actually fetch the site?" floor — so the name check SKIPPED and the
// test read as a failure of the code. It was a failure of the fixture.
const EVONEXUS_SITE = (
  "People Mentors & Selection Committee Rory Moore EvoNexus CEO & Co-Founder " +
  "Gene Dantsker, Ph.D., MBA EvoNexus Executive Advisor Dong-Su Kim, Ph.D. " +
  "Corporate EVP, LG Technology Ventures Kelly Ko, PhD VP Technology Ventures " +
  "& Innovation, Banner Health Jacob Woodruff, Ph.D. Head of Technology " +
  "Scouting & Partnerships, EMD Electronics Dr. Michael Hill EvoNexus Team "
).repeat(4);

describe("checkClaims — people must be real", () => {
  it("flags a name that appears nowhere on the prospect's own site", () => {
    const d = checkClaims(
      { bios: [{ name: "Dr. Someone Invented" }, { name: "Dr. Gene Dantsker" }] },
      EVONEXUS_SITE,
    );
    expect(d).toHaveLength(1);
    expect(d[0].severity).toBe("blocking");
    expect(d[0].what).toContain("Someone Invented");
  });

  it("accepts the real EvoNexus people", () => {
    const d = checkClaims(
      { bios: [{ name: "Dr. Gene Dantsker" }, { name: "Dr. Dong-Su Kim" }, { name: "Dr. Kelly Ko" }] },
      EVONEXUS_SITE,
    );
    expect(d).toEqual([]);
  });

  it("SKIPS the name check when the site could not be fetched", () => {
    // "I could not look" and "it is not there" are different facts. Conflating
    // them is the exact bug this file exists to catch elsewhere — a check that
    // reports a confident failure about something it never saw.
    expect(checkClaims({ bios: [{ name: "Dr. Anybody At All" }] }, "")).toEqual([]);
  });

  it("matches on surname, so honorifics and credentials do not defeat it", () => {
    expect(checkClaims({ bios: [{ name: "Dantsker, Ph.D." }] }, EVONEXUS_SITE)).toEqual([]);
  });
});

describe("checkClaims — nobody wears somebody else's face", () => {
  it("flags two cards sharing one photograph", () => {
    const d = checkClaims({
      bios: [
        { name: "Dr. Gene Dantsker", image: "https://r2/evonexus/team-0.webp" },
        { name: "Dr. Michael Hill", image: "https://r2/evonexus/team-0.webp" },
      ],
    }, EVONEXUS_SITE);
    expect(d.some((x) => x.severity === "blocking" && /SAME photograph/.test(x.what))).toBe(true);
  });

  it("accepts distinct photographs", () => {
    const d = checkClaims({
      bios: [
        { name: "Dr. Gene Dantsker", image: "https://r2/evonexus/team-0.webp" },
        { name: "Dr. Michael Hill", image: "https://r2/evonexus/team-1.webp" },
      ],
    }, EVONEXUS_SITE);
    expect(d).toEqual([]);
  });

  it("does not treat two cards with NO photo as sharing one", () => {
    // Missing photos render initials avatars — that is the designed fallback.
    const d = checkClaims(
      { bios: [{ name: "Dr. Gene Dantsker" }, { name: "Dr. Kelly Ko" }] },
      EVONEXUS_SITE,
    );
    expect(d).toEqual([]);
  });
});

describe("checkClaims — numbers we can stand behind", () => {
  it("flags a page count larger than what was actually indexed", () => {
    const d = checkClaims({ bios: [], claimedPages: 2000, indexedPages: 843 }, "");
    expect(d[0].severity).toBe("blocking");
    expect(d[0].what).toContain("2,000");
    expect(d[0].what).toContain("843");
  });

  it("allows understating — orthocarolina claimed 740 against 843 indexed", () => {
    expect(checkClaims({ bios: [], claimedPages: 740, indexedPages: 843 }, "")).toEqual([]);
  });

  it("allows an exact match", () => {
    expect(checkClaims({ bios: [], claimedPages: 843, indexedPages: 843 }, "")).toEqual([]);
  });

  it("says nothing when either number is unknown", () => {
    expect(checkClaims({ bios: [], claimedPages: 900 }, "")).toEqual([]);
    expect(checkClaims({ bios: [], indexedPages: 10 }, "")).toEqual([]);
  });
});

describe("checkClaims — placeholder roles", () => {
  it("warns when every card carries the same placeholder role", () => {
    // The state evonexus is in right now: correct, and uninformative.
    const bios = ["Dantsker", "Kim", "Ko"].map((n) => ({ name: n, role: "Team" }));
    const d = checkClaims({ bios }, EVONEXUS_SITE);
    expect(d).toHaveLength(1);
    expect(d[0].severity).toBe("warning");
  });

  it("does not warn when the roles are real", () => {
    const d = checkClaims({
      bios: [
        { name: "Dantsker", role: "EvoNexus Executive Advisor" },
        { name: "Kim", role: "Corporate EVP, LG Technology Ventures" },
      ],
    }, EVONEXUS_SITE);
    expect(d).toEqual([]);
  });

  it("does not warn about a SINGLE card whose role is generic", () => {
    // One "About" card is the normal shape for most of the fleet.
    expect(checkClaims({ bios: [{ name: "Dantsker", role: "About" }] }, EVONEXUS_SITE)).toEqual([]);
  });
});

describe("claimedPageCount", () => {
  it("reads the real orthocarolina sentence", () => {
    expect(claimedPageCount("We indexed 740 pages. It scored 96% on 10 adversarial tests.")).toBe(740);
  });

  it("reads the HSS phrasing", () => {
    expect(claimedPageCount("We indexed 400 public pages from hss.edu and stood up an assistant.")).toBe(400);
  });

  it("reads the trailing form and thousands separators", () => {
    expect(claimedPageCount("an AI assistant on top of it — 1,030 pages indexed.")).toBe(1030);
  });

  it("takes the LARGEST when several appear — overstatement is the risk", () => {
    expect(claimedPageCount("We indexed 400 pages, then indexed 900 pages more.")).toBe(900);
  });

  it("finds nothing in copy that makes no page claim", () => {
    expect(claimedPageCount("It answers from your published pages only, and cites each one.")).toBeUndefined();
    expect(claimedPageCount("")).toBeUndefined();
  });

  it("does not read a QA score or a percentage as a page count", () => {
    expect(claimedPageCount("It scored 96% on 10 adversarial tests we wrote.")).toBeUndefined();
  });
});
