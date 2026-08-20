/**
 * The two build-time patches that rewrite the cloned landing template.
 *
 * Both have already failed in production-shaped ways:
 *
 *  - `syncBioBodyArity` was written against `src/i18n/en.ts` when the real file
 *    is `src/i18n/ui/en.ts`. Its own `existsSync` guard turned that typo into a
 *    SILENT no-op, so two consecutive deploys shipped
 *    "Replace this with a team member's published bio" under the real names of
 *    a customer's executives while the build logged success.
 *
 *  - `configureChatGate` (which replaced a five-anchor source patch) throws
 *    when a constant is missing, and that is why it works. The contrast is the
 *    lesson: a guard that returns quietly hides a wrong path indefinitely.
 *    Its predecessor patched the EMAIL gate and never the MESSAGE quota beside
 *    it, so a handoff demo allowed one question against a 500-message worker.
 *
 * These tests use a real temp directory because the bug was about paths.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { syncBioBodyArity, configureChatGate, ensureBrandWordmark, ensureBrandFavicon, brandInitials, wordmarkTextWidth, stripPlaceholderBios, looksLikeOrganisation } from "./landing.js";

let siteDir: string;

/** The neutral en.ts the template ships: exactly two placeholder bodies. */
const NEUTRAL_EN = `export const en = {
  hero: { headline: "x" },
  bios: {
    heading: "The team behind the AI.",
    bodies: [
      "Replace this with the founder's bio — credentials, focus, and the body of work.",
      "Replace this with a second team member's published bio, or remove the entry.",
    ],
    footerPrefix: "For full team information, visit",
  },
};
`;

/* Mirrors the SHAPE of the real template, not a convenient subset. The old
   fixture contained only the `emailRequired` line, so a test asserting the
   file no longer contains "!isValidEmail(email)" passed while the real
   ChatIsland kept its hard gate in handleSend and the shipped demo refused to
   send. A fixture smaller than the thing it stands for cannot fail. */
const CHAT_ISLAND = `  const showStarters = messages.length === 0 && !urlPrompt;
  const handleSend = useCallback(async (rawContent: string) => {
      const content = rawContent.trim();
      if (!content) return;
      if (!isValidEmail(email)) {
        setError(t.errorEmailRequired);
        return;
      }
      // quota gate follows
  }, []);
  useEffect(() => {
    if (pendingExampleSend && isValidEmail(email)) { flush(); }
  }, [pendingExampleSend]);
  const emailRequired = !isValidEmail(email);
  // EVERY user message counts toward the free-message quota
  <ConversationStarters onSelect={(text) => {
              if (isValidEmail(email)) {
                handleSend(text, { starter: true });
              } else {
                setDraft(text);
              }
            }} />
`;

const MESSAGE_INPUT = `export function MessageInput({ emailRequired, email }: MessageInputProps) {
  return (
    <form>
      {/* Email row */}
      <div className="flex flex-col gap-1">
        <label htmlFor="df-email-input">{emailRequired ? t.emailLabel : t.emailLabelValid}</label>
        <input id="df-email-input" type="email" value={email} />
      </div>
    </form>
  );
}
`;

/** The template's brand.config.ts tail — the two constants the gate lives in. */
const BRAND_CONFIG = `export const brand: BrandConfig = { identity: { siteName: "Acme" } };

/** Anonymous-visitor quota before the upgrade gate (foundation default). */
export const FREE_MESSAGE_QUOTA = 1;

export const FREE_MESSAGES_BEFORE_EMAIL = 3;
`;

function seedSite(): string {
  const dir = mkdtempSync(join(tmpdir(), "landing-patch-"));
  mkdirSync(join(dir, "src", "i18n", "ui"), { recursive: true });
  mkdirSync(join(dir, "src", "components", "chat"), { recursive: true });
  writeFileSync(join(dir, "src", "i18n", "ui", "en.ts"), NEUTRAL_EN);
  writeFileSync(join(dir, "src", "components", "chat", "ChatIsland.tsx"), CHAT_ISLAND);
  writeFileSync(join(dir, "src", "components", "chat", "MessageInput.tsx"), MESSAGE_INPUT);
  writeFileSync(join(dir, "src", "brand.config.ts"), BRAND_CONFIG);
  return dir;
}

const enText = () => readFileSync(join(siteDir, "src", "i18n", "ui", "en.ts"), "utf8");
const bodyCount = () => (enText().match(/"/g) ?? []).length; // rough, refined below
const bodiesArray = () => {
  const m = enText().match(/bodies:\s*\[([\s\S]*?)\n\s*\],/);
  return (m?.[1] ?? "").split("\n").map((l) => l.trim()).filter((l) => l.startsWith('"'));
};

beforeEach(() => { siteDir = seedSite(); });
afterEach(() => { rmSync(siteDir, { recursive: true, force: true }); });

describe("syncBioBodyArity", () => {
  it("targets src/i18n/ui/en.ts — the path the earlier version got wrong", () => {
    syncBioBodyArity(siteDir, 5);
    expect(bodiesArray()).toHaveLength(5);
  });

  it("pads 2 → 5 so a 5-bio brand passes equal-length shape validation", () => {
    // validateEnTs → sameShape requires arrays of EQUAL length; a mismatch made
    // the build keep the NEUTRAL copy and ship placeholders.
    expect(bodiesArray()).toHaveLength(2);
    syncBioBodyArity(siteDir, 5);
    expect(bodiesArray()).toHaveLength(5);
  });

  it("trims down as well as up", () => {
    syncBioBodyArity(siteDir, 5);
    syncBioBodyArity(siteDir, 1);
    expect(bodiesArray()).toHaveLength(1);
  });

  it("is a no-op when the arity already matches (idempotent re-deploys)", () => {
    const before = enText();
    syncBioBodyArity(siteDir, 2);
    expect(enText()).toBe(before);
  });

  it("does nothing for a zero/absent bio count rather than emptying the array", () => {
    const before = enText();
    syncBioBodyArity(siteDir, 0);
    expect(enText()).toBe(before);
  });

  it("leaves the rest of the file intact", () => {
    syncBioBodyArity(siteDir, 4);
    const t = enText();
    expect(t).toContain("The team behind the AI.");
    expect(t).toContain("footerPrefix");
    expect(t).toContain("hero:");
  });
});

describe("configureChatGate", () => {
  const cfg = () => readFileSync(join(siteDir, "src", "brand.config.ts"), "utf8");

  it("sets both constants together", () => {
    configureChatGate(siteDir, { freeMessagesBeforeEmail: 3, freeMessageQuota: 1 });
    expect(cfg()).toContain("export const FREE_MESSAGES_BEFORE_EMAIL = 3;");
    expect(cfg()).toContain("export const FREE_MESSAGE_QUOTA = 1;");
  });

  it("gives a direct-handoff demo the WHOLE budget, not one message", () => {
    // THE BUG THIS PINS. The old patch turned off the email gate and left
    // `FREE_MESSAGE_QUOTA = 1` untouched, so acmebio — a demo handed to a
    // customer — allowed exactly one question before the composer was replaced
    // by the sign-up CTA, while its worker was configured for 500. Nothing
    // failed; the client and the worker simply disagreed.
    configureChatGate(siteDir, { freeMessagesBeforeEmail: 500, freeMessageQuota: 0 });
    expect(cfg()).toContain("export const FREE_MESSAGES_BEFORE_EMAIL = 500;");
    expect(cfg()).toContain("export const FREE_MESSAGE_QUOTA = 0;");
    // The client cap is FREE_MESSAGES_BEFORE_EMAIL + FREE_MESSAGE_QUOTA, so
    // this is exactly the worker's budget — not one more, not one fewer.
  });

  it("THROWS when a constant is missing — never leaves the pair half-set", () => {
    // The two only make sense together: a client that stops asking for an
    // address while still capping at one message is not a working demo.
    writeFileSync(join(siteDir, "src", "brand.config.ts"), "export const brand = {};\n");
    expect(() => configureChatGate(siteDir, { freeMessagesBeforeEmail: 3, freeMessageQuota: 1 })).toThrow(
      /FREE_MESSAGES_BEFORE_EMAIL/,
    );
  });

  it("THROWS before writing anything when only the SECOND constant is missing", () => {
    writeFileSync(
      join(siteDir, "src", "brand.config.ts"),
      "export const FREE_MESSAGES_BEFORE_EMAIL = 3;\n",
    );
    expect(() => configureChatGate(siteDir, { freeMessagesBeforeEmail: 9, freeMessageQuota: 0 })).toThrow(
      /FREE_MESSAGE_QUOTA/,
    );
    // Unchanged — the verify pass runs before any write.
    expect(cfg()).toContain("export const FREE_MESSAGES_BEFORE_EMAIL = 3;");
  });
});

describe("ensureBrandWordmark", () => {
  const brandDir = () => join(siteDir, "public", "brand");
  const seedPlaceholder = () => {
    mkdirSync(brandDir(), { recursive: true });
    writeFileSync(join(brandDir(), "logo.svg"), '<svg role="img" aria-label="Acme Expert"><text>Acme Expert</text></svg>');
    writeFileSync(join(brandDir(), "favicon.svg"), '<svg role="img" aria-label="Acme Expert"><text>A</text></svg>');
  };
  const logo = () => readFileSync(join(brandDir(), "logo.svg"), "utf8");
  const favicon = () => readFileSync(join(brandDir(), "favicon.svg"), "utf8");

  it("REPLACES the Acme placeholder — it shipped as a customer's headline", () => {
    // Acme Bio's demo went out with "Acme Expert" in the hero: the page
    // title, copy and chat were all correct, so only the logo was wrong and
    // review missed it.
    seedPlaceholder();
    ensureBrandWordmark(siteDir, { siteName: "Acme Bio" });
    expect(logo()).toContain("Acme Bio");
    expect(logo()).not.toContain("Acme Expert");
  });

  it("no longer writes the favicon — that is ensureBrandFavicon's job", () => {
    // The favicon USED to be written here, after this function's
    // `if (draft.logoFile && ...) return;` early exit — so every demo whose
    // logo scraped successfully returned before reaching it and shipped the
    // Acme placeholder in its browser tab. The two assets are unrelated, and
    // coupling them made one silently depend on the other's failure.
    // See brand-favicon.test.ts.
    seedPlaceholder();
    ensureBrandWordmark(siteDir, { siteName: "Acme Bio" });
    expect(favicon()).toContain("Acme Expert");

    ensureBrandFavicon(siteDir, { siteName: "Acme Bio" });
    expect(favicon()).not.toContain("Acme Expert");
    expect(favicon()).toContain(">AB<");
  });

  it("does NOT touch a real extracted logo", () => {
    mkdirSync(brandDir(), { recursive: true });
    writeFileSync(join(brandDir(), "logo.svg"), "<svg><!-- the customer's real mark --></svg>");
    ensureBrandWordmark(siteDir, { siteName: "Acme Bio", logoFile: "logo.png" });
    expect(logo()).toContain("real mark");
  });

  it("escapes XML — an ampersand would emit invalid SVG and render a blank hero", () => {
    seedPlaceholder();
    ensureBrandWordmark(siteDir, { siteName: "Smith & Wesson <Labs>" });
    expect(logo()).toContain("Smith &amp; Wesson &lt;Labs&gt;");
    expect(logo()).not.toMatch(/<text[^>]*>[^<]*&(?!amp;|lt;|gt;|quot;)/);
  });

  it("is a no-op when there is no brand dir at all", () => {
    expect(() => ensureBrandWordmark(siteDir, { siteName: "X" })).not.toThrow();
  });
});

describe("brandInitials", () => {
  it("takes the first letter of the first two words", () => {
    expect(brandInitials("Acme Bio")).toBe("AB");
    expect(brandInitials("Dr. Morgan Online")).toBe("DM");
  });
  it("falls back to one letter for a single word", () => {
    expect(brandInitials("Divinci")).toBe("D");
  });
  it("survives punctuation and stray separators", () => {
    expect(brandInitials("top-socal — real estate")).toBe("TS");
  });
});

describe("wordmarkTextWidth", () => {
  it("measures the glyphs — the flat 18.6/char guess overshot by ~18%", () => {
    // "Acme Biosciences" at 30px Helvetica Bold is ~251 units of ink. The old
    // flat estimate produced 298, and those 47 units of trailing whitespace
    // inside the <img> are what pushed the hero's blue "AI" mark off to the
    // right.
    //
    // The fixture is a long name on purpose: the gap between a real glyph
    // measurement and a flat per-character guess only shows up over enough
    // characters, so a short name would let the flat estimate back in.
    const NAME = "Acme Biosciences";
    const w = wordmarkTextWidth(NAME, 30);
    expect(w).toBeGreaterThan(240);
    expect(w).toBeLessThan(265);
    expect(w).toBeLessThan(Math.round(NAME.length * 18.6));
  });

  it("scales with font size", () => {
    // letter-spacing is a FIXED -1 per gap, so only the glyph term doubles —
    // compare with tracking removed rather than asserting an exact 2x.
    expect(wordmarkTextWidth("Divinci", 60, 0)).toBeCloseTo(wordmarkTextWidth("Divinci", 30, 0) * 2, -1);
  });

  it("accounts for letter-spacing", () => {
    expect(wordmarkTextWidth("Divinci", 30, 0)).toBeGreaterThan(wordmarkTextWidth("Divinci", 30, -1));
  });

  it("narrow letters produce a narrower box than wide ones", () => {
    // The whole point of a per-character table: "IIII" and "WWWW" are not the
    // same width, and a flat estimate says they are.
    expect(wordmarkTextWidth("IIII", 30)).toBeLessThan(wordmarkTextWidth("WWWW", 30));
  });

  it("never returns zero or negative for odd input", () => {
    for (const s of ["", "  ", "\u00e9\u00e8", "\u53d6"]) {
      expect(wordmarkTextWidth(s, 30)).toBeGreaterThan(0);
    }
  });
});

describe("wordmark is font-independent", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wordmark-"));
    mkdirSync(join(dir, "public", "brand"), { recursive: true });
    writeFileSync(join(dir, "public", "brand", "logo.svg"), '<svg aria-label="Acme Expert"><text>Acme Expert</text></svg>');
    writeFileSync(join(dir, "public", "brand", "favicon.svg"), '<svg aria-label="Acme Expert"><text>A</text></svg>');
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const logo = () => readFileSync(join(dir, "public", "brand", "logo.svg"), "utf8");

  it("pins textLength to the viewBox width so a wider fallback font cannot overflow", () => {
    // The box is measured with Helvetica-Bold metrics but drawn in whatever
    // the viewer has. On a machine with neither Helvetica nor Arial the
    // fallback is wider and the renderer CLIPS — a customer's name truncated
    // mid-word on a machine we never see. Reported from the field.
    ensureBrandWordmark(dir, { siteName: "Acme Bio" });
    const m = logo().match(/viewBox="0 0 (\d+) 42"[\s\S]*?textLength="(\d+)"/);
    expect(m, "logo must declare textLength").toBeTruthy();
    expect(m![2]).toBe(m![1]);
  });

  it("uses spacingAndGlyphs so the fit adjusts letterforms, not just gaps", () => {
    ensureBrandWordmark(dir, { siteName: "Acme Bio" });
    expect(logo()).toContain('lengthAdjust="spacingAndGlyphs"');
  });
});

describe("stripPlaceholderBios", () => {
  const EN_WITH_PLACEHOLDER = `export const en = {
  bios: {
    heading: "The team behind the AI.",
    bodies: [
      "Replace this with the founder's bio — background, coverage focus, and the published research the assistant answers from.",
      "Dr. Ada Rowe has covered orbital economics since 2011 and writes the weekly brief.",
    ],
    footerPrefix: "For full bios, visit",
  },
};
`;

  it("blanks the template's own text when the copy step echoed it back", () => {
    // validateEnTs checks SHAPE — same keys, same array lengths — which a model
    // satisfies perfectly by returning the neutral text unchanged. acmeincubator shipped
    // "Replace this with the founder's bio…" to a page one approval from a
    // prospect, and only a DOM-grounded design review caught it.
    const f = join(siteDir, "en.ts");
    writeFileSync(f, EN_WITH_PLACEHOLDER);
    expect(stripPlaceholderBios(f)).toBe(1);
    const out = readFileSync(f, "utf8");
    expect(out).not.toContain("Replace this with");
    expect(out).toContain('""');
  });

  it("leaves real copy alone", () => {
    const f = join(siteDir, "en.ts");
    writeFileSync(f, EN_WITH_PLACEHOLDER);
    stripPlaceholderBios(f);
    expect(readFileSync(f, "utf8")).toContain("Dr. Ada Rowe has covered orbital economics");
  });

  it("keeps the array ARITY — blanking, not deleting", () => {
    // syncBioBodyArity and validateEnTs both key on the length. The last time bio
    // arity drifted, every demo silently reverted to neutral copy.
    const f = join(siteDir, "en.ts");
    writeFileSync(f, EN_WITH_PLACEHOLDER);
    stripPlaceholderBios(f);
    const bodies = readFileSync(f, "utf8").match(/bodies:\s*\[([\s\S]*?)\n\s*\],/)![1];
    expect(bodies.match(/"/g)!.length / 2).toBe(2);
  });

  it("does nothing to a file that is already clean", () => {
    const f = join(siteDir, "en.ts");
    const clean = EN_WITH_PLACEHOLDER.replace(/"Replace this with[^"]*"/, '"A real bio."');
    writeFileSync(f, clean);
    expect(stripPlaceholderBios(f)).toBe(0);
    expect(readFileSync(f, "utf8")).toBe(clean);
  });

  it("catches the other ways nobody-wrote-this shows up", () => {
    for (const text of ["Lorem ipsum dolor sit amet.", "TODO: write this", "Placeholder bio."]) {
      const f = join(siteDir, "en.ts");
      writeFileSync(f, EN_WITH_PLACEHOLDER.replace(/"Replace this with[^"]*"/, JSON.stringify(text)));
      expect(stripPlaceholderBios(f), text).toBe(1);
    }
  });
});

describe("looksLikeOrganisation", () => {
  it("catches the entity that shipped as a Founder", () => {
    // "Acmeincubator (The Acme Finance Group)" — the parenthetical is read as the
    // lead person, so the bio card rendered "The Acme Finance Group — Founder"
    // on a live demo.
    expect(looksLikeOrganisation("The Acme Finance Group")).toBe(true);
  });

  it("leaves real people alone", () => {
    for (const n of ["Dr. Pat Morgan", "Ken Chang", "Dr. Iris Bello", "Chris Vance, MD"])
      expect(looksLikeOrganisation(n), n).toBe(false);
  });

  it("catches the common corporate shapes", () => {
    for (const n of [
      "Acme Inc",
      "Acme Inc.",
      "Northstar Capital",
      "Rothman Institute",
      "Bay Area Spine Center",
      "Wolfram Research LLC",
    ])
      expect(looksLikeOrganisation(n), n).toBe(true);
  });

  it("only matches at the END, so a person is not caught by a middle word", () => {
    // "Grouper" must not match "group"; "Institute" mid-name is a workplace,
    // not the name's shape.
    expect(looksLikeOrganisation("Dana Grouper")).toBe(false);
    expect(looksLikeOrganisation("Institute Fellow Jane Doe")).toBe(false);
  });
});
