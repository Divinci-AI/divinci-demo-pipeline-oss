/**
 * Headshot finder — sources a real team/clinician headshot from the prospect's
 * own website so bio cards show a face instead of an initials placeholder.
 *
 *   crawl team/about/providers pages (Playwright)
 *        │  collect <img> candidates (src, alt, size, nearby text)
 *        ▼
 *   heuristic score (portrait, sized, name-matched, not logo/nav)
 *        │  top candidates
 *        ▼
 *   Vertex Gemini vision: pick the best professional headshot of the person
 *        │
 *        ▼
 *   download winner  →  caller uploads to R2 / sets bio.image
 *
 * Returns null (caller falls back to the initials avatar) if nothing suitable
 * is found or gcloud/vision is unavailable — never throws into the pipeline.
 */
import { chromium } from "playwright";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { lazyEnv } from "./require-env.js";

const execFileP = promisify(execFile);
const VERTEX_PROJECT = lazyEnv("VERTEX_PROJECT()", "the GCP project Vertex AI generation is billed to");
const VERTEX_LOCATION = process.env.VERTEX_LOCATION ?? "us-central1";
const VISION_MODEL = process.env.VERTEX_VISION_MODEL ?? "gemini-2.5-flash";

export interface TeamMember { name: string; title: string; imageUrl?: string; imagePath?: string; blurb?: string }

/**
 * Credentials that make "Dr." factually correct. A PA, NP, RN or MSN is a
 * credential but NOT a doctorate, and captioning that person "Dr." misstates
 * who they are — the same category of error as calling an EVP a physician.
 */
// ND — Doctor of Naturopathic Medicine — earns the "Dr." prefix, and the pages
// that use it say so themselves ("Dr. Cara Morgan specializes in…").
const DOCTORATE = /\b(m\.?d\.?|d\.?o\.?|n\.?d\.?|ph\.?d\.?|dds|dmd|dpm|dvm|dc)\b/i;

/** Non-clinical letters after a name. Not credentials in the medical sense,
 *  but equally not a job title — "MBA" is not what someone does. */
const POST_NOMINAL = /^(mba|ms|m\.s\.|msc|ma|ba|bs|b\.s\.|bsc|jd|llm|cpa|cfa|pe|pmp|faia|esq)\.?$/i;

const CREDENTIAL = /\b(m\.?d\.?|d\.?o\.?|n\.?d\.?|pa-?c?|np|rn|dpt|dc|facs|ph\.?d\.?|msn|aprn|cnp)\b/i;
const NOT_NAME = new Set(["biography", "education", "research", "publications", "board certification", "professional societies", "military experience", "licensure", "undergraduate", "contact", "overview", "our team", "meet our team", "about us", "our providers", "our physicians", "our surgeons", "patient resources"]);
// Words that mark a heading as an institution/place, not a person — these slip
// past name shape because state abbrevs (PA, MD, DC) match credential patterns.
const INSTITUTION = new Set(["university", "hospital", "college", "school", "institute", "general", "regional", "memorial", "naval", "division", "command", "center", "centre", "medicine", "health", "clinic", "department", "fellowship", "residency", "academy", "national", "international"]);

/**
 * Parse raw {portraits, headings} scraped from a team page into team members.
 * A heading is a person if it's 2–4 capitalized words (sans trailing credential),
 * carries a medical credential or "Dr." (high precision for clinics), and isn't
 * an org name or a section header. Each member's photo = the nearest portrait by
 * vertical position. Pure + unit-tested (no browser).
 */
/**
 * A person's role, taken from the page rather than assumed.
 *
 * The heading is typically "Sam Torres, Ph.D., MBA Acme Incubator Executive
 * Advisor" — name, then credentials, then the actual job. We want the job. Bare
 * credentials ("Ph.D.", "MD, FACS") are NOT a role; they describe schooling, and
 * rendering them as a job title reads as a mistake.
 */
/**
 * Fallback role for a site whose pages state none, inferred from how many of
 * its people carry a CLINICAL credential.
 *
 * Two things this exists to avoid, both found the hard way:
 *
 *   - `/\b(MD|DO|...)\b/i` — the `i` flag makes `DO` match the ordinary word
 *     "do", so essentially every page on the web reads as clinical. That was my
 *     own first attempt at fixing this.
 *   - A single clinician on a page of thirty. acmeincubator.org/people/ lists one
 *     "John 'Rick' LeMoine, MD" among venture partners and executives; any
 *     any-match rule captions all of them "Physician".
 *
 * So: case-SENSITIVE credential letters, and a share of the named people rather
 * than a single hit.
 */
export function inferFallbackRole(headings: string[]): string {
  const people = headings.filter((t) => /^[A-Z][a-zA-Z.'-]+(\s+[A-Z][a-zA-Z.'"“”'-]+){1,3}\b/.test(t.trim()));
  if (!people.length) return "Team";
  const clinical = people.filter((t) => /,\s*(M\.?D\.?|D\.?O\.?|DPM|DDS|DMD)\b/.test(t)).length;
  if (clinical / people.length < 0.4) return "Team";
  return headings.some((t) => /surgeon/i.test(t)) ? "Spine Surgeon" : "Physician";
}

/**
 * The job title, taken from the card text by subtracting the person's name.
 *
 * The heading alone is usually just "Sam Torres, Ph.D., MBA" — the title
 * lives in a sibling container the collector never read, which is why every
 * non-clinical team fell back to an invented role. The card text reads
 * "Sam Torres, Ph.D., MBA Acme Incubator Executive Advisor, Former Sr. Director…",
 * so removing the heading leaves the job.
 */
export function roleFromCard(card: string | undefined, heading: string): string | undefined {
  if (!card || !heading) return undefined;
  const i = card.indexOf(heading);
  if (i < 0) return undefined;
  let rest = card.slice(i + heading.length).trim();
  rest = rest.replace(/^[,\s|·—–-]+/, "");
  // Credentials that trailed the NAME, not the title.
  for (;;) {
    const m = rest.match(/^([A-Za-z.]+)[,\s]+/);
    if (!m || !(CREDENTIAL.test(m[1]) || POST_NOMINAL.test(m[1]))) break;
    rest = rest.slice(m[0].length).trim();
  }
  // One clause, not a biography: card text often runs on into prose.
  //
  // Sentence-splitting on any ". " truncates the title itself — "Former Sr.
  // Director of Business Development" ends at "Former Sr." An abbreviation's
  // period is not a sentence boundary, so mask the common ones first.
  // A wide gap SEPARATES two fields — but only between two complete clauses.
  // Straight after a separator it is just a typo inside one title, and the
  // split then leaves a dangling connector: acmelongevity.com writes
  // "Co-Founder ·  Women's Health Specialist" with two spaces, and the card
  // came back as the meaningless "Co-Founder ·".
  rest = rest.replace(/([·•|—–-])\s{2,}/g, "$1 ");
  const ABBREV = /\b(sr|jr|dr|mr|mrs|ms|st|inc|ltd|co|corp|univ|dept|vs|ph|d|m|b|a)\./gi;
  const masked = rest.replace(ABBREV, (m) => m.replace(".", "\u0000"));
  rest = masked
    .split(/(?<=[.;])\s|\s{2,}/)[0]
    .replace(/\u0000/g, ".")
    .replace(/[.,;\s]+$/, "")
    .trim();
  if (rest.length < 3 || rest.length > 90) return undefined;
  if (/,\s*[A-Z]{2}\.?$/.test(rest) || /^[A-Z]{2}$/.test(rest)) return undefined;
  const head = rest.split(/[\s,]/)[0] || "";
  if (CREDENTIAL.test(head) || POST_NOMINAL.test(head)) return undefined;
  return rest;
}

export function roleFromHeading(heading: string): string | undefined {
  if (!heading.includes(",")) return undefined;
  let rest = heading.slice(heading.indexOf(",") + 1).trim();
  // Strip leading credential tokens ("Ph.D., MBA " / "MD, FACS "). Note this
  // must cover NON-clinical letters too — the first version stopped at "MBA"
  // and returned "MBA Acme Incubator Executive Advisor" as the job title.
  for (;;) {
    const m = rest.match(/^([A-Za-z.]+)[,\s]+/);
    if (!m || !(CREDENTIAL.test(m[1]) || POST_NOMINAL.test(m[1]))) break;
    rest = rest.slice(m[0].length).trim();
  }
  rest = rest.replace(/^[,\s]+/, "").split(/\s{2,}|\n/)[0].trim();
  // A role should read like a job, not a location or a fragment.
  if (rest.length < 3 || rest.length > 80) return undefined;
  // "Pittsburgh, PA" — a place, not a job. Checked on the WHOLE string, not
  // just the first token, or a city name smuggles the state code through.
  if (/,\s*[A-Z]{2}\.?$/.test(rest) || /^[A-Z]{2}$/.test(rest)) return undefined;
  if (CREDENTIAL.test(rest.split(/[\s,]/)[0] || "") || POST_NOMINAL.test(rest.split(/[\s,]/)[0] || "")) return undefined;
  return rest;
}

/**
 * @param defaultRole used ONLY when the page gives no role of its own.
 *
 * ⚠️ It is deliberately NOT medical. This read
 * `/surgeon/i.test(...) ? "Spine Surgeon" : "Physician"` — two options, both
 * clinical, because the module was written for clinics and never generalised.
 * Acme Incubator is a startup incubator; its demo shipped eight venture and
 * technology executives, real named people, each captioned "Physician". Their
 * actual titles ("Corporate EVP, LG Technology Ventures") were on the page and
 * were discarded. Prefer the page's own words; when there are none, say
 * something true and generic.
 */
export function parseTeam(
  raw: { portraits: { src: string; top: number; left?: number; w: number; h: number }[]; headings: { text: string; top: number; left?: number; blurb: string; card?: string }[] },
  defaultRole = "Team",
): TeamMember[] {
  // Collect candidates, then dedup by SURNAME keeping the most complete name
  // (so "Dr. Rivera" merges into "Dr. Alex Rivera").
  const bySurname = new Map<string, TeamMember & { words: number; top: number; left: number }>();
  for (const h of raw.headings) {
    const s = (h.text || "").trim();
    if (NOT_NAME.has(s.toLowerCase())) continue;
    const nameWords = s.split(",")[0].replace(/^dr\.?\s+/i, "").trim().split(/\s+/);
    if (nameWords.length < 2 || nameWords.length > 4) continue;
    if (!nameWords.every((w) => /^[A-Z][a-zA-Z.'-]*$/.test(w))) continue;
    if (nameWords.some((w) => ORG_STOP.has(w.toLowerCase()) || INSTITUTION.has(w.toLowerCase()))) continue;
    const isDr = /^dr\.?\b/i.test(s);
    // Credential must sit in TITLE position (first token after the name's comma),
    // so "…, Pittsburgh, PA" (a location) doesn't read as a "PA" credential.
    const afterComma = s.includes(",") ? s.slice(s.indexOf(",") + 1).trim() : "";
    const credInTitle = CREDENTIAL.test(afterComma.split(/[\s,]/)[0] || "");
    // …or as the LAST WORD OF THE NAME, with no comma and no "Dr." prefix:
    // "Pat Morgan MD", "Jennifer Cornell ND". A very common convention, and
    // the gate above rejected every one of it — acmelongevity.com/doctors/
    // returned ZERO members off a page carrying three names in <h3> and three
    // 300x300 portraits, all correctly collected and then all discarded here.
    //
    // Requiring TWO name words to remain after stripping the credential is what
    // keeps the comma rule's protection: "Bethesda MD" and "Raleigh NC" leave
    // one word and stay rejected, so a place still cannot become a person.
    const trailing = nameWords[nameWords.length - 1];
    const credTrailing = nameWords.length >= 3 && CREDENTIAL.test(trailing);
    if (credTrailing) nameWords.pop();
    if (!credInTitle && !credTrailing && !isDr) continue;
    const surname = nameWords[nameWords.length - 1].toLowerCase();
    // Only call someone "Dr." if the PAGE did. This used to prefix every name
    // unconditionally, so a venture partner became "Dr. Casey Brook".
    const member: TeamMember & { words: number; top: number; left: number } = {
      name: `${isDr || DOCTORATE.test(afterComma.split(/[\s,]/)[0] || "") || (credTrailing && DOCTORATE.test(trailing)) ? "Dr. " : ""}${nameWords.join(" ")}`,
      // Card text first — it is where the real title lives. The heading form
      // covers sites that put "Name, Title" in a single element.
      title: roleFromCard(h.card, s) ?? roleFromHeading(s) ?? defaultRole,
      imageUrl: undefined, // assigned below, globally
      words: nameWords.length,
      top: h.top,
      left: h.left ?? 0,
    };
    // Keyed on FIRST + LAST, not surname alone. Surname-only dedup silently
    // deletes a colleague who shares a family name — LongevityRx is co-founded
    // by Pat Morgan and Cara Morgan, and only one of them would survive. It
    // still merges the case the dedup exists for, "Alex Rivera" vs
    // "Alex Rivera", since those agree on both ends.
    const key = `${nameWords[0].toLowerCase()} ${surname}`;
    const existing = bySurname.get(key);
    if (!existing || member.words > existing.words) bySurname.set(key, member);
  }

  const members = [...bySurname.values()].slice(0, 8);

  // ONE PORTRAIT PER PERSON.
  //
  // Each member used to pick its own nearest portrait with no record of what
  // anyone else had taken, so a page with few detected portraits gave the same
  // face to everybody. Acme Incubator shipped eight cards carrying two distinct
  // photographs — six real, named people wearing a colleague's face.
  //
  // Matched globally, closest pair first, each portrait claimed at most once. A
  // member left unmatched gets NO photo, which renders as an initials avatar:
  // no picture is a small blemish, the wrong person's picture is a real one.
  const pairs: Array<{ mi: number; pi: number; d: number }> = [];
  members.forEach((m, mi) =>
    raw.portraits.forEach((p, pi) => {
      const dy = Math.abs(p.top - m.top);
      if (dy >= 700) return; // different section entirely
      // HORIZONTAL distance matters as much as vertical. A team grid puts three
      // people on ONE row, so they share an identical `top` and vertical
      // distance cannot tell them apart at all — acmeincubator.org/people/ returns
      // three headings at top=1290, three at 1832, three at 2374. Matching on
      // `top` alone assigned faces essentially at random within each row.
      const dx = Math.abs((p.left ?? 0) - m.left);
      pairs.push({ mi, pi, d: Math.hypot(dx, dy) });
    }),
  );
  pairs.sort((a, b) => a.d - b.d);
  const takenM = new Set<number>(), takenP = new Set<number>();
  for (const { mi, pi } of pairs) {
    if (takenM.has(mi) || takenP.has(pi)) continue;
    takenM.add(mi); takenP.add(pi);
    members[mi].imageUrl = raw.portraits[pi].src;
  }

  return members.map(({ words: _w, top: _t, left: _l, ...m }) => m);
}

const TEAM_PATH_RE = /team|about|provider|physician|doctor|surgeon|staff|meet|our-|people|leadership|founder/i;
// "/people" was missing, and acmeincubator.org keeps its entire team there — so
// both the headshot finder and the claims check looked everywhere except the
// page that had the people on it. TEAM_PATH_RE already matched "people"; this
// list, which supplies the guessed paths when no link is found, did not.
export const COMMON_PATHS = ["/about", "/team", "/our-team", "/people", "/our-people", "/providers", "/physicians", "/doctors", "/meet-the-team", "/about-us", "/staff", "/our-providers", "/leadership"];

interface Candidate { src: string; alt: string; w: number; h: number; near: string; score: number; matched: boolean }

/** Org words that must NOT be treated as a person's surname (else they false-match
 *  generic clinic images). */
const ORG_STOP = new Set(["care", "clinic", "center", "centre", "spine", "health", "medical", "group", "associates", "institute", "orthopaedic", "orthopedic", "surgery", "surgical", "dental", "wellness", "the", "and", "for", "llc", "inc", "pllc", "pc"]);

/**
 * Extract a person's likely surnames from a bio/name string for image matching.
 * Prefers the parenthetical person when the name is "Org (Dr. Person)", strips
 * titles + punctuation, and drops org words so we match the human, not the brand.
 */
export function personSurnames(name?: string): string[] {
  if (!name) return [];
  const inParens = name.match(/\(([^)]+)\)/)?.[1];
  return (inParens ?? name)
    .replace(/\b(dr|md|do|iii|ii|jr|sr|facs|phd|mba|rn|np|pa)\b/gi, " ")
    .replace(/[^a-z\s]/gi, " ")
    .split(/\s+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length >= 3 && !ORG_STOP.has(s));
}

// Runs in the page (passed as a STRING — tsx/esbuild keepNames injects an
// undefined __name into function-valued evaluate args).
const COLLECT = `(() => {
  const abs = (u) => { try { return new URL(u, location.href).href; } catch { return ''; } };
  const bad = (el) => !!el.closest('header,nav,footer');
  const out = [];
  for (const img of Array.from(document.images)) {
    const r = img.getBoundingClientRect();
    const w = img.naturalWidth || Math.round(r.width);
    const h = img.naturalHeight || Math.round(r.height);
    const src = abs(img.currentSrc || img.src);
    if (!src || src.startsWith('data:')) continue;
    // nearby text: alt + closest figure/article/li/parent text + nearest heading
    let near = img.alt || '';
    const fig = img.closest('figure,article,li,div');
    if (fig) near += ' ' + (fig.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160);
    out.push({ src, alt: img.alt || '', w, h, near: near.trim(), inChrome: bad(img) });
  }
  return out;
})()`;

export function scoreCandidate(c: { src: string; alt: string; w: number; h: number; near: string; inChrome: boolean }, surnames: string[]): number {
  if (c.inChrome) return -1;
  const url = c.src.toLowerCase();
  if (/\.svg($|\?)|logo|icon|sprite|favicon|placeholder|banner|hero|bg-|background/.test(url)) return -1;
  const w = c.w, h = c.h;
  if (w && h) {
    if (w < 120 || h < 120) return -1;               // too small to be a headshot
    const ar = h / w;
    if (ar < 0.7 || ar > 2.2) return -1;             // banners / thin strips out
  }
  let s = 0;
  const ar = h && w ? h / w : 1;
  if (ar >= 0.9 && ar <= 1.6) s += 3;                // portrait/square = headshot-ish
  if (w >= 200 && h >= 200) s += 1;
  const hay = (c.alt + " " + c.near + " " + url).toLowerCase();
  if (/\b(dr|md|do|facs|surgeon|physician|founder|provider)\b/.test(hay)) s += 2;
  if (/headshot|portrait|profile|team|staff|provider/.test(url)) s += 2;
  for (const sn of surnames) if (sn.length >= 3 && hay.includes(sn)) s += 5; // name match is strong
  return s;
}

async function vertexToken(): Promise<string> {
  const { stdout } = await execFileP("gcloud", ["auth", "print-access-token"], { timeout: 30_000 });
  const t = stdout.trim();
  if (!t) throw new Error("empty gcloud token");
  return t;
}

async function visionPick(token: string, imgs: { b64: string; mime: string }[], personName?: string): Promise<{ index: number; reason: string }> {
  const prompt = `You are shown ${imgs.length} candidate images scraped from a medical clinic's website, in order (index 0..${imgs.length - 1}). Pick the ONE that is a genuine professional HEADSHOT / portrait photo of a real person${personName ? ` — ideally ${personName}` : " (a clinician/doctor/founder)"}. It must be an actual photograph of a human face, not a logo, icon, illustration, building, product, or group/banner shot. Return ONLY JSON {"index": <0-based index or -1 if none qualify>, "reason": "<short>"}.`;
  const parts: any[] = [{ text: prompt }];
  imgs.forEach((im, i) => { parts.push({ text: `Index ${i}:` }, { inlineData: { mimeType: im.mime, data: im.b64 } }); });
  const res = await fetch(
    `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT()}/locations/${VERTEX_LOCATION}/publishers/google/models/${VISION_MODEL}:generateContent`,
    { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: { temperature: 0, responseMimeType: "application/json" } }) },
  );
  if (!res.ok) throw new Error(`vision HTTP ${res.status}`);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("") ?? "{}";
  try { return JSON.parse(text); } catch { return { index: -1, reason: "unparseable" }; }
}

/**
 * Find a headshot on `siteUrl` (optionally of `personName`), download it to
 * `outPath`. Returns the source URL on success, or null.
 */
export async function findHeadshot(
  siteUrl: string,
  opts: { personName?: string; outPath: string; maxPages?: number; maxVisionCandidates?: number } = { outPath: "" },
): Promise<{ sourceUrl: string } | null> {
  const surnames = personSurnames(opts.personName);
  const maxPages = opts.maxPages ?? 5;
  const maxVision = opts.maxVisionCandidates ?? 6;

  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ userAgent: "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/124 Safari/537.36" });
    const page = await ctx.newPage();
    const origin = new URL(siteUrl).origin;

    // Discover candidate team/about pages: homepage links + common paths.
    await page.goto(siteUrl, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
    const links: string[] = await page.evaluate(`(() => Array.from(document.querySelectorAll('a[href]')).map(a => ({href: a.href, text: (a.textContent||'').trim()}))
      .filter(l => l.href).map(l => l.href + '\\n' + l.text))()`).then((rows: any) =>
        (rows as string[]).filter((r) => TEAM_PATH_RE.test(r)).map((r) => r.split("\n")[0])
      ).catch(() => []);
    const pages = Array.from(new Set([
      ...links.filter((h) => h.startsWith(origin)),
      ...COMMON_PATHS.map((p) => origin + p),
    ])).slice(0, maxPages);

    // Collect image candidates across those pages.
    const all: { src: string; alt: string; w: number; h: number; near: string; inChrome: boolean }[] = [];
    for (const url of pages) {
      try {
        await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
        const found = (await page.evaluate(COLLECT)) as any[];
        all.push(...found);
      } catch { /* skip unreachable page */ }
    }
    // Dedupe + score + rank.
    const seen = new Set<string>();
    const ranked: Candidate[] = [];
    for (const c of all) {
      if (seen.has(c.src)) continue;
      seen.add(c.src);
      const matched = surnames.some((sn) => `${c.alt} ${c.near} ${c.src}`.toLowerCase().includes(sn));
      const score = scoreCandidate(c, surnames);
      if (score > 0) ranked.push({ ...c, score, matched });
    }
    ranked.sort((a, b) => b.score - a.score);
    if (!ranked.length) { console.log("[headshot] no candidate images found"); return null; }

    // Precision guard: if the person's name matches any candidate (filename /
    // alt / caption), restrict the vision shortlist to those — this stops a
    // multi-provider site from putting the WRONG doctor's face under the bio.
    // Only fall back to name-agnostic portraits when there's no name signal.
    const matched = ranked.filter((c) => c.matched);
    const shortlist = matched.length ? matched : ranked;
    if (matched.length) console.log(`[headshot] ${matched.length} name-matched candidate(s) — restricting vision to those`);
    const top = shortlist.slice(0, maxVision);
    const fetched: { b64: string; mime: string; src: string }[] = [];
    for (const c of top) {
      try {
        const r = await ctx.request.get(c.src, { timeout: 20_000 });
        if (!r.ok()) continue;
        const mime = r.headers()["content-type"]?.split(";")[0] ?? "image/jpeg";
        if (!mime.startsWith("image/")) continue;
        const buf = await r.body();
        if (buf.length < 2000) continue; // tiny = icon
        fetched.push({ b64: buf.toString("base64"), mime, src: c.src });
      } catch { /* skip */ }
    }
    if (!fetched.length) return null;

    const token = await vertexToken();
    const pick = await visionPick(token, fetched, opts.personName);
    if (pick.index < 0 || pick.index >= fetched.length) { console.log(`[headshot] vision found no headshot (${pick.reason})`); return null; }

    const chosen = fetched[pick.index];
    const r = await ctx.request.get(chosen.src, { timeout: 20_000 });
    writeFileSync(opts.outPath, await r.body());
    console.log(`[headshot] selected ${chosen.src} (${pick.reason})`);
    return { sourceUrl: chosen.src };
  } catch (err) {
    console.warn(`[headshot] skipped — ${(err as Error).message.split("\n")[0]}`);
    return null;
  } finally {
    await browser.close();
  }
}

// Team-page scraper script (passed as a STRING — IIFE; double-escape regex
// backslashes so they survive the template literal before reaching the browser).
const TEAM_COLLECT = `(() => {
  function boxOf(el){ var r = el.getBoundingClientRect();
    return { top: Math.round(r.top + (window.scrollY||0)), left: Math.round(r.left + (window.scrollX||0)) }; }
  var portraits = [];
  var imgs = document.images;
  for (var i=0;i<imgs.length;i++){
    var im = imgs[i]; var src = im.currentSrc||im.src||'';
    if (!src || src.indexOf('data:')===0) continue;
    var w = im.naturalWidth, h = im.naturalHeight;
    if (w<120||h<120) continue; var ar = h/w; if (ar<0.7||ar>2.2) continue;
    var pb = boxOf(im); portraits.push({ src: src, w: w, h: h, top: pb.top, left: pb.left });
  }
  var headings = [];
  var hs = document.querySelectorAll('h1,h2,h3,h4,h5,h6,strong,b');
  for (var j=0;j<hs.length;j++){
    var el = hs[j];
    var text = (el.textContent||'').replace(/\\s+/g,' ').trim();
    if (!text || text.length>60) continue;
    var blurb = '';
    var cur = el.closest('h1,h2,h3,h4,h5,h6') || el;
    var sib = cur.nextElementSibling; var guard=0;
    while (sib && guard<6){
      if (sib.matches && sib.matches('h1,h2,h3,h4,h5,h6')) break;
      var tx = (sib.textContent||'').replace(/\\s+/g,' ').trim();
      if (tx) blurb += (blurb?' ':'') + tx;
      if (blurb.length>300) break;
      sib = sib.nextElementSibling; guard++;
    }
    // The job title is almost never a sibling of the name. Page builders wrap
    // each field in its own container (Elementor on acmeincubator.org puts the name
    // alone in a DIV, with the title two hops up inside the card's <a>), so walk
    // up to the nearest ancestor holding MORE than the name and let parseTeam
    // subtract the name from it.
    var card = '', up = el;
    for (var k = 0; k < 4 && up.parentElement; k++) {
      up = up.parentElement;
      var ct = (up.textContent||'').replace(/\\s+/g,' ').trim();
      if (ct.length > text.length + 10) { card = ct.slice(0, 300); break; }
    }
    var hb = boxOf(el); headings.push({ text: text, top: hb.top, left: hb.left, blurb: blurb.slice(0,300), card: card });
  }
  return { portraits: portraits, headings: headings };
})()`;

/**
 * Find the full team (multiple members) from the prospect's team/about pages,
 * downloading each member's photo into outDir. Best-effort — returns [] on any
 * failure so the caller can fall back to a single bio.
 */
export async function findTeam(
  siteUrl: string,
  opts: { outDir: string; maxPages?: number },
): Promise<TeamMember[]> {
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ userAgent: "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/124 Safari/537.36" });
    const page = await ctx.newPage();
    const origin = new URL(siteUrl).origin;
    await page.goto(siteUrl, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
    const links: string[] = await page.evaluate(`(() => Array.from(document.querySelectorAll('a[href]')).map(a => a.href + '\\n' + (a.textContent||'').trim()))()`)
      .then((rows: unknown) => (rows as string[]).filter((r) => TEAM_PATH_RE.test(r)).map((r) => r.split("\n")[0]).filter((h) => h.startsWith(origin)))
      .catch(() => []);
    const pages = Array.from(new Set([...links, ...COMMON_PATHS.map((p) => origin + p)])).slice(0, opts.maxPages ?? 5);

    const all: TeamMember[] = [];
    const seen = new Set<string>();
    for (const url of pages) {
      try {
        await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
        const raw = (await page.evaluate(TEAM_COLLECT)) as { portraits: { src: string; top: number; left?: number; w: number; h: number }[]; headings: { text: string; top: number; left?: number; blurb: string; card?: string }[] };
        // Fallback role, used only where the page states none. Inferred from
        // what the page actually says rather than assumed clinical — the old
        // form was `/surgeon/i ? "Spine Surgeon" : "Physician"`, whose ELSE
        // branch captioned every venture executive on acmeincubator.org "Physician".
        const role = inferFallbackRole(raw.headings.map((h) => h.text));
        for (const m of parseTeam(raw, role)) {
          const key = m.name.toLowerCase().replace(/[^a-z]/g, "");
          if (seen.has(key)) continue;
          seen.add(key);
          all.push(m);
        }
      } catch { /* skip unreachable page */ }
    }

    // Download each member's photo.
    let idx = 0;
    for (const m of all) {
      if (m.imageUrl) {
        try {
          const r = await ctx.request.get(m.imageUrl, { timeout: 20_000 });
          if (r.ok() && (r.headers()["content-type"] ?? "").startsWith("image/")) {
            const fp = join(opts.outDir, `team-${idx}.img`);
            writeFileSync(fp, await r.body());
            m.imagePath = fp;
          }
        } catch { /* best-effort */ }
      }
      idx++;
    }
    console.log(`[team] found ${all.length} member(s): ${all.map((m) => m.name).join(", ")}`);
    return all;
  } catch (err) {
    console.warn(`[team] skipped — ${(err as Error).message.split("\n")[0]}`);
    return [];
  } finally {
    await browser.close();
  }
}
