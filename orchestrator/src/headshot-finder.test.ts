import { describe, it, expect } from "vitest";
import { personSurnames, scoreCandidate, parseTeam, roleFromHeading, inferFallbackRole, roleFromCard } from "./headshot-finder.js";

describe("parseTeam", () => {
  const portraits = [
    { src: "https://x/kuwamura.jpg", top: 200, w: 300, h: 400 },
    { src: "https://x/raj.jpg", top: 900, w: 300, h: 400 },
  ];
  it("extracts credentialed people, matches the nearest photo, dedups by surname", () => {
    const team = parseTeam({
      portraits,
      headings: [
        { text: "Frank Kuwamura, M.D.", top: 210, blurb: "" },
        { text: "Dr. Kuwamura", top: 600, blurb: "" }, // partial dup → merges
        { text: "Raj Nangunoori, M.D.", top: 910, blurb: "" },
      ],
    }, "Spine Surgeon");
    expect(team.map((m) => m.name)).toEqual(["Dr. Frank Kuwamura", "Dr. Raj Nangunoori"]);
    expect(team[0].imageUrl).toContain("kuwamura");
    expect(team[1].imageUrl).toContain("raj");
    expect(team[0].title).toBe("Spine Surgeon");
  });
  it("rejects institutions/locations that fake a credential via state abbrevs", () => {
    const team = parseTeam({
      portraits,
      headings: [
        { text: "Allegheny General Hospital, Pittsburgh, PA", top: 210, blurb: "" },
        { text: "Drexel University, Philadelphia, PA", top: 250, blurb: "" },
        { text: "Education", top: 300, blurb: "" },
        { text: "MD Spine Care", top: 350, blurb: "" },
      ],
    });
    expect(team).toEqual([]);
  });
});

describe("personSurnames", () => {
  it("extracts the person from an 'Org (Dr. Person)' bio name, dropping org words", () => {
    expect(personSurnames("MD Spine Care (Dr. Frank Kuwamura)")).toEqual(["frank", "kuwamura"]);
  });
  it("strips titles + punctuation from a plain name", () => {
    expect(personSurnames("Dr. Jane A. Smith, M.D.")).toEqual(["jane", "smith"]);
  });
  it("drops org/clinic stopwords so they don't false-match generic images", () => {
    expect(personSurnames("Acme Health Clinic")).toEqual(["acme"]);
  });
  it("handles empty / undefined", () => {
    expect(personSurnames(undefined)).toEqual([]);
    expect(personSurnames("")).toEqual([]);
  });
});

describe("scoreCandidate", () => {
  const base = { src: "https://x/p.jpg", alt: "", w: 400, h: 500, near: "", inChrome: false };
  it("rejects logos, svgs, icons, and nav/footer images", () => {
    expect(scoreCandidate({ ...base, src: "https://x/logo.svg" }, [])).toBe(-1);
    expect(scoreCandidate({ ...base, src: "https://x/icon-team.png" }, [])).toBe(-1);
    expect(scoreCandidate({ ...base, inChrome: true }, [])).toBe(-1);
  });
  it("rejects tiny images and wide banners", () => {
    expect(scoreCandidate({ ...base, w: 80, h: 80 }, [])).toBe(-1);     // too small
    expect(scoreCandidate({ ...base, w: 1600, h: 400 }, [])).toBe(-1);  // banner (ar 0.25)
  });
  it("rewards portrait + clinician signals", () => {
    const plain = scoreCandidate(base, []);
    const doc = scoreCandidate({ ...base, alt: "Dr. Smith, spine surgeon" }, []);
    expect(doc).toBeGreaterThan(plain);
  });
  it("strongly boosts a surname match (the wrong-person guard)", () => {
    const noName = scoreCandidate({ ...base, src: "https://x/team-1.jpg" }, ["kuwamura"]);
    const named = scoreCandidate({ ...base, src: "https://x/frank-kuwamura-md.jpg" }, ["kuwamura"]);
    expect(named).toBeGreaterThanOrEqual(noName + 5);
  });
});

// Found 2026-08-09 on the EvoNexus demo, at Gate 3, ready to send. EvoNexus is
// a startup incubator; the page shipped eight real, named venture and
// technology executives captioned "Physician", six of them wearing a
// colleague's face. The people and the source page were correct — everything
// the pipeline added on top was wrong.
describe("parseTeam — non-clinical sites", () => {
  // Shape taken from evonexus.org/people/.
  const evonexus = {
    portraits: [
      { src: "https://x/dantsker.jpg", top: 200, w: 300, h: 300 },
      { src: "https://x/kim.jpg", top: 800, w: 300, h: 300 },
    ],
    headings: [
      { text: "Gene Dantsker, Ph.D., MBA EvoNexus Executive Advisor", top: 210, blurb: "" },
      { text: "Dong-Su Kim, Ph.D., Corporate EVP, LG Technology Ventures", top: 810, blurb: "" },
      { text: "Kelly Ko, PhD, VP Technology Ventures & Innovation", top: 1600, blurb: "" },
    ],
  };

  it("never captions a non-clinical site's people 'Physician'", () => {
    const team = parseTeam(evonexus);
    expect(team.map((m) => m.title)).not.toContain("Physician");
    expect(team.map((m) => m.title)).not.toContain("Spine Surgeon");
  });

  it("uses the role the page states, not an invented one", () => {
    const team = parseTeam(evonexus);
    expect(team[0].title).toBe("EvoNexus Executive Advisor");
    expect(team[1].title).toBe("Corporate EVP, LG Technology Ventures");
  });

  it("gives no two people the same photograph", () => {
    const team = parseTeam(evonexus);
    const used = team.map((m) => m.imageUrl).filter(Boolean);
    expect(new Set(used).size).toBe(used.length);
  });

  it("leaves the third person without a photo rather than reusing one", () => {
    // Two portraits, three people. The unmatched one renders an initials
    // avatar; wearing a colleague's face is the failure being prevented.
    const team = parseTeam(evonexus);
    expect(team.filter((m) => m.imageUrl)).toHaveLength(2);
    expect(team[2].imageUrl).toBeUndefined();
  });

  it("matches each portrait to its OWN card, closest first", () => {
    const team = parseTeam(evonexus);
    expect(team[0].imageUrl).toContain("dantsker");
    expect(team[1].imageUrl).toContain("kim");
  });

  it("does not invent 'Dr.' for a non-doctoral credential", () => {
    const team = parseTeam({
      portraits: [],
      headings: [{ text: "Jane Smith, PA-C, Clinic Manager", top: 100, blurb: "" }],
    });
    expect(team[0].name).toBe("Jane Smith");
  });

  it("still says Dr. where the page does, or where a doctorate says so", () => {
    const team = parseTeam({
      portraits: [],
      headings: [
        { text: "Frank Kuwamura, M.D.", top: 100, blurb: "" },
        { text: "Gene Dantsker, Ph.D., MBA Executive Advisor", top: 900, blurb: "" },
      ],
    });
    expect(team.map((m) => m.name)).toEqual(["Dr. Frank Kuwamura", "Dr. Gene Dantsker"]);
  });
});

describe("roleFromHeading", () => {
  it("skips the credentials and returns the job", () => {
    expect(roleFromHeading("Gene Dantsker, Ph.D., MBA EvoNexus Executive Advisor")).toBe("EvoNexus Executive Advisor");
  });

  it("returns nothing when there is only a credential", () => {
    expect(roleFromHeading("Frank Kuwamura, M.D.")).toBeUndefined();
    expect(roleFromHeading("Raj Nangunoori, MD, FACS")).toBeUndefined();
  });

  it("returns nothing for a bare name, or a location", () => {
    expect(roleFromHeading("Rory Moore")).toBeUndefined();
    expect(roleFromHeading("Allegheny General Hospital, Pittsburgh, PA")).toBeUndefined();
  });
});

// Ground truth from evonexus.org/people/ (scraped 2026-08-09). Three people per
// grid row share ONE `top` value, which is why vertical-only matching gave real
// people each other's faces — distance could not tell them apart at all.
describe("parseTeam — grid layouts", () => {
  const row = (top: number) => [
    { text: "Gene Dantsker, Ph.D., MBA", top, left: 100, blurb: "" },
    { text: "Dr. Michael Hill", top, left: 500, blurb: "" },
    { text: "John LeMoine, MD", top, left: 900, blurb: "" },
  ];
  const portraits = [
    { src: "https://x/dantsker.jpg", top: 1290, left: 100, w: 300, h: 300 },
    { src: "https://x/hill.jpg", top: 1290, left: 500, w: 300, h: 300 },
    { src: "https://x/lemoine.jpg", top: 1290, left: 900, w: 300, h: 300 },
  ];

  it("matches each person to the portrait in their OWN column", () => {
    const team = parseTeam({ portraits, headings: row(1290) });
    const by = Object.fromEntries(team.map((m) => [m.name, m.imageUrl]));
    expect(by["Dr. Gene Dantsker"]).toContain("dantsker");
    expect(by["Dr. Michael Hill"]).toContain("hill");
    expect(by["Dr. John LeMoine"]).toContain("lemoine");
  });

  it("still gives no two people the same face when a row is short of portraits", () => {
    const team = parseTeam({ portraits: portraits.slice(0, 2), headings: row(1290) });
    const used = team.map((m) => m.imageUrl).filter(Boolean);
    expect(new Set(used).size).toBe(used.length);
    expect(used).toHaveLength(2);
  });
});

describe("inferFallbackRole", () => {
  it("does NOT read the ordinary word 'do' as the credential DO", () => {
    // /\b(MD|DO)\b/i matches "What we do" — my own first attempt at this fix,
    // which made effectively every page on the web look clinical.
    expect(inferFallbackRole(["What we do", "Rory Moore", "Bridget Kimball"])).toBe("Team");
  });

  it("is not swayed by ONE clinician among many executives", () => {
    // evonexus.org/people/ verbatim shape: one MD, the rest venture partners.
    expect(
      inferFallbackRole([
        "Rory Moore", "Gene Dantsker, Ph.D., MBA", "Bob Genthert, CPA",
        "Rich Stewart", "Ron Melanson", "Bridget Kimball",
        "John LeMoine, MD",
      ]),
    ).toBe("Team");
  });

  it("still recognises an actual clinic", () => {
    expect(
      inferFallbackRole(["Frank Kuwamura, M.D.", "Raj Nangunoori, MD", "Ana Ruiz, DO", "Jane Poole, MD"]),
    ).toBe("Physician");
  });

  it("prefers the more specific role when the page says surgeon", () => {
    expect(inferFallbackRole(["Frank Kuwamura, M.D., Spine Surgeon", "Raj Nangunoori, MD"])).toBe("Spine Surgeon");
  });

  it("says Team when there are no people at all", () => {
    expect(inferFallbackRole([])).toBe("Team");
    expect(inferFallbackRole(["People", "Contact"])).toBe("Team");
  });
});

// Item 4, 2026-08-09. The collector never captured a job title — headings are
// name-only and the blurb is empty — so every non-clinical team fell back to an
// invented role. Fixture text is the LIVE card text from evonexus.org/people/.
describe("roleFromCard", () => {
  it("subtracts the name and returns the real title", () => {
    expect(
      roleFromCard(
        "Gene Dantsker, Ph.D., MBA EvoNexus Executive Advisor, Former Sr. Director of Business Development & Licensing,",
        "Gene Dantsker, Ph.D., MBA",
      ),
    ).toBe("EvoNexus Executive Advisor, Former Sr. Director of Business Development & Licensing");
  });

  it("handles a title that follows credentials on the card", () => {
    expect(roleFromCard("Dong-Su Kim, Ph.D. Corporate EVP, LG Technology Ventures", "Dong-Su Kim, Ph.D."))
      .toBe("Corporate EVP, LG Technology Ventures");
  });

  it("returns nothing when the card holds only the name", () => {
    expect(roleFromCard("Rory Moore", "Rory Moore")).toBeUndefined();
  });

  it("returns nothing when the name is not in the card text", () => {
    // Mispaired inputs must produce no title rather than someone else's.
    expect(roleFromCard("Kelly Ko, PhD VP Technology Ventures", "Gene Dantsker")).toBeUndefined();
  });

  it("returns nothing for a card, or a heading, we do not have", () => {
    expect(roleFromCard(undefined, "Gene Dantsker")).toBeUndefined();
    expect(roleFromCard("Gene Dantsker Advisor", "")).toBeUndefined();
  });

  it("does not return a location as a job", () => {
    expect(roleFromCard("Frank Kuwamura, M.D. Pittsburgh, PA", "Frank Kuwamura, M.D.")).toBeUndefined();
  });

  it("does not return a bare credential as a job", () => {
    expect(roleFromCard("Raj Nangunoori, MD FACS", "Raj Nangunoori, MD")).toBeUndefined();
  });

  it("takes one clause, not a whole biography", () => {
    const out = roleFromCard(
      "Jane Poole, MD Chief of Surgery. She joined in 2004 after a fellowship in Boston and now leads the department.",
      "Jane Poole, MD",
    );
    expect(out).toBe("Chief of Surgery");
  });
});

describe("parseTeam — real titles beat the fallback", () => {
  it("prefers the card's title over the default role", () => {
    const team = parseTeam({
      portraits: [],
      headings: [
        {
          text: "Gene Dantsker, Ph.D., MBA",
          top: 100,
          left: 0,
          blurb: "",
          card: "Gene Dantsker, Ph.D., MBA EvoNexus Executive Advisor",
        },
        { text: "Dong-Su Kim, Ph.D.", top: 900, left: 0, blurb: "", card: "Dong-Su Kim, Ph.D. Corporate EVP, LG Technology Ventures" },
      ],
    });
    expect(team.map((m) => m.title)).toEqual([
      "EvoNexus Executive Advisor",
      "Corporate EVP, LG Technology Ventures",
    ]);
  });

  it("falls back to the default only where the card offers nothing", () => {
    const team = parseTeam({
      portraits: [],
      headings: [
        { text: "Gene Dantsker, Ph.D.", top: 100, left: 0, blurb: "", card: "Gene Dantsker, Ph.D. Executive Advisor" },
        { text: "Rory Moore, Ph.D.", top: 900, left: 0, blurb: "", card: "Rory Moore, Ph.D." },
      ],
    });
    expect(team[0].title).toBe("Executive Advisor");
    expect(team[1].title).toBe("Team");
  });
});

// drlongevityrx.com/doctors/ returned ZERO members off a page that carries
// three names in <h3> and three 300x300 portraits — every one of them
// collected correctly and then discarded by parseTeam. Measured 2026-08-16.
describe("a credential trailing the NAME, with no comma and no Dr. prefix", () => {
  const REAL_LONGEVITYRX = {
    portraits: [
      { src: "https://lh3.googleusercontent.com/joel=w300", top: 1016, left: 125, w: 300, h: 300 },
      { src: "https://lh3.googleusercontent.com/cara=w300", top: 1016, left: 490, w: 300, h: 300 },
      { src: "https://lh3.googleusercontent.com/jen=w300", top: 1016, left: 855, w: 300, h: 300 },
    ],
    headings: [
      { text: "Joel Fuhrman MD", top: 1375, left: 117, blurb: "",
        card: "MD · Board-Certified Family PhysicianJoel Fuhrman MDCo-Founder · Nutritional Medicine Pioneer" },
      // NOTE the double space after "·" — a typo on the real page.
      { text: "Cara Fuhrman ND", top: 1375, left: 482, blurb: "",
        card: "ND · Licensed Naturopathic DoctorCara Fuhrman NDCo-Founder ·  Women's Health Specialist" },
      { text: "Jennifer Cornell ND", top: 1377, left: 847, blurb: "",
        card: "ND · Licensed Naturopathic DoctorJennifer Cornell NDGut & Immune Health Specialist" },
    ],
  };

  it("finds all three doctors", () => {
    expect(parseTeam(REAL_LONGEVITYRX, "Team").map((m) => m.name)).toEqual([
      "Dr. Joel Fuhrman", "Dr. Cara Fuhrman", "Dr. Jennifer Cornell",
    ]);
  });

  it("does NOT drop a colleague who shares a surname", () => {
    // Dedup was keyed on surname alone, so of the two Fuhrmans — who
    // co-founded the clinic together — exactly one would have survived.
    const names = parseTeam(REAL_LONGEVITYRX, "Team").map((m) => m.name);
    expect(names).toContain("Dr. Joel Fuhrman");
    expect(names).toContain("Dr. Cara Fuhrman");
  });

  it("still merges the same person written two ways", () => {
    // The case surname-dedup existed for. First+last agree, so it still merges.
    const raw = { portraits: [], headings: [
      { text: "Frank Kuwamura, MD", top: 10, left: 0, blurb: "", card: "" },
      { text: "Frank J. Kuwamura, MD", top: 900, left: 0, blurb: "", card: "" },
    ] };
    expect(parseTeam(raw, "Team")).toHaveLength(1);
  });

  it("gives each doctor their OWN portrait", () => {
    const t = parseTeam(REAL_LONGEVITYRX, "Team");
    expect(new Set(t.map((m) => m.imageUrl)).size).toBe(3);
    expect(t[0].imageUrl).toContain("joel");
    expect(t[1].imageUrl).toContain("cara");
    expect(t[2].imageUrl).toContain("jen");
  });

  it("keeps the whole title across a double-space typo", () => {
    // `\s{2,}` marks a field boundary, but straight after a separator it is a
    // typo inside one title — the split left the meaningless "Co-Founder ·".
    expect(parseTeam(REAL_LONGEVITYRX, "Team")[1].title).toBe("Co-Founder · Women's Health Specialist");
  });

  it("still refuses a PLACE whose last token looks like a credential", () => {
    // This is what the comma rule protected, and why the trailing form demands
    // two name words to REMAIN after the credential is stripped.
    const raw = { portraits: [], headings: [
      { text: "Bethesda MD", top: 10, left: 0, blurb: "", card: "" },
      { text: "Raleigh NC", top: 20, left: 0, blurb: "", card: "" },
    ] };
    expect(parseTeam(raw, "Team")).toEqual([]);
  });
});
