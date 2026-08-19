/**
 * Does the demo tell the truth about the prospect?
 *
 * This pipeline manufactures CLAIMS ABOUT A THIRD PARTY and then sends them to
 * that third party. Every other gate measures the artifact's mechanics — QA
 * tests what the assistant says, preflight tests what the page renders, design
 * review tests how it looks. None of them has any concept of an assertion about
 * the customer, and that is precisely where every serious defect has landed:
 *
 *   published                            truth
 *   "Dr. Sam Torres — Physician"      Acme Incubator Executive Advisor
 *   six bio photographs                  one colleague's photo, repeated
 *   Casey Brook's biography               under Sam Torres's name
 *   a 24x24 "plus" icon as the logo      a decorative UI glyph
 *   "We indexed 740 pages"               never checked against anything
 *
 * None of those is a rendering fault. Every one would pass a page that loads
 * perfectly, and every one did.
 *
 * The checks here are deliberately MECHANICAL — string and set comparisons
 * against the prospect's own site and our own index. No model judges anything:
 * a model asked "is this true?" is one more confident answer of the kind that
 * caused the problem. Where a check cannot be made cheaply and exactly, it is
 * left out rather than approximated.
 */

export interface DemoClaims {
  /** Bio cards as published: name, role, and the image URL actually rendered. */
  bios: Array<{ name: string; role?: string; image?: string }>;
  /** Page-count assertions made in outreach copy, e.g. "We indexed 740 pages". */
  claimedPages?: number;
  /** Files actually indexed for this run's workspace. */
  indexedPages?: number;
}

export interface ClaimDefect {
  /** `blocking` = a false statement about a real person or a real number. */
  severity: "blocking" | "warning";
  what: string;
}

/**
 * Extract page-count claims from outreach copy.
 *
 * Matches the phrasings the generator actually produces ("We indexed 740
 * pages", "740 pages indexed", "indexed 1,030 public pages"). Returns the
 * LARGEST, because the risk being managed is overstatement.
 */
export function claimedPageCount(text: string): number | undefined {
  const nums = [...text.matchAll(/\b(?:indexed|indexing)\s+(?:[a-z]+\s+){0,2}?([\d,]{2,})\s*(?:public\s+)?pages?\b/gi)]
    .concat([...text.matchAll(/\b([\d,]{2,})\s*(?:public\s+)?pages?\s+indexed\b/gi)])
    .map((m) => Number(m[1].replace(/,/g, "")))
    .filter((n) => Number.isFinite(n) && n > 0);
  return nums.length ? Math.max(...nums) : undefined;
}

/** Surnames worth matching a page against — mirrors headshot-finder's rules. */
function surnames(name: string): string[] {
  return name
    .replace(/\b(dr|md|do|iii|ii|jr|sr|facs|phd|mba|rn|np|pa)\b/gi, " ")
    .replace(/[^a-z\s]/gi, " ")
    .split(/\s+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length >= 3);
}

/**
 * @param siteText  the prospect's own site copy, lowercased, as a haystack.
 *                  Pass "" when it could not be fetched — every name-based check
 *                  is then SKIPPED rather than reported as a failure, because
 *                  "I could not look" and "it is not there" are different facts
 *                  and conflating them is the exact bug this file exists to
 *                  catch elsewhere.
 */
export function checkClaims(claims: DemoClaims, siteText: string): ClaimDefect[] {
  const out: ClaimDefect[] = [];
  const hay = siteText.toLowerCase();

  // 1. Every published person must exist on the prospect's own site.
  if (hay.length > 500) {
    for (const b of claims.bios) {
      const parts = surnames(b.name);
      if (parts.length && !parts.some((p) => hay.includes(p))) {
        out.push({
          severity: "blocking",
          what: `bio card names "${b.name}", who does not appear anywhere on the prospect's own site`,
        });
      }
    }
  }

  // 2. No two people may share a photograph.
  //
  // Compares the rendered image URLs. That is weaker than comparing the images
  // themselves — acmeincubator once served EIGHT distinct URLs holding TWO distinct
  // pictures — but the upload path now derives one key per card, so identical
  // URLs are the failure mode that remains reachable from here. Byte-level
  // comparison belongs in the uploader, where the bytes are in hand.
  const withImage = claims.bios.filter((b) => b.image);
  const seen = new Map<string, string>();
  for (const b of withImage) {
    const prior = seen.get(b.image!);
    if (prior) {
      out.push({
        severity: "blocking",
        what: `"${b.name}" and "${prior}" are shown the SAME photograph — one of them is wearing the other's face`,
      });
    } else seen.set(b.image!, b.name);
  }

  // 3. A page-count claim must not exceed what we actually indexed.
  //
  // Understating is fine and is what the generator does today (740 claimed
  // against 843 indexed). Overstating is a false number in an email.
  if (claims.claimedPages !== undefined && claims.indexedPages !== undefined) {
    if (claims.claimedPages > claims.indexedPages) {
      out.push({
        severity: "blocking",
        what:
          `outreach claims ${claims.claimedPages.toLocaleString()} pages indexed, but the workspace holds ` +
          `${claims.indexedPages.toLocaleString()} — do not send a number we cannot stand behind`,
      });
    }
  }

  // 4. A role that is a bare placeholder tells the reader nothing.
  const generic = claims.bios.filter((b) => b.role && /^(team|about|staff|member)$/i.test(b.role.trim()));
  if (generic.length && generic.length === claims.bios.length && claims.bios.length > 1) {
    out.push({
      severity: "warning",
      what:
        `all ${claims.bios.length} bio cards show the same placeholder role ("${generic[0].role}") — ` +
        `the real titles are on the prospect's site and were not captured`,
    });
  }

  return out;
}
