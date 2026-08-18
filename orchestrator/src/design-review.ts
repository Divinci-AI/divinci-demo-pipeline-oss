/**
 * Automated visual design-review — the "second layer" that double-checks a
 * deployed landing page for polish before it goes to a prospect.
 *
 *   Playwright screenshots (desktop + mobile, full page)
 *        │
 *        ▼
 *   Vertex Gemini vision critique against a polish rubric
 *        │
 *        ▼
 *   structured punch-list  →  markdown report (+ optional review board gate comment)
 *
 * It REPORTS issues (it doesn't auto-edit) — a human/agent acts on the list,
 * then you re-run to confirm. Designed to run a couple rounds until clean.
 *
 * Auth: Vertex via gcloud (same as brand-media). No Gemini API key.
 */
import { chromium } from "playwright";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync } from "node:fs";
import { lazyEnv } from "./require-env.js";

const execFileP = promisify(execFile);

const VERTEX_PROJECT = lazyEnv("VERTEX_PROJECT()", "the GCP project Vertex AI generation is billed to");
const VERTEX_LOCATION = process.env.VERTEX_LOCATION ?? "us-central1";
const VISION_MODEL = process.env.VERTEX_VISION_MODEL ?? "gemini-2.5-flash";

export interface DesignFinding {
  severity: "critical" | "major" | "minor";
  area: string;
  issue: string;
  fix: string;
}

const RUBRIC = `You are a senior product designer doing a final polish review of a customer-facing
AI demo landing page before it is sent to a real prospect. You are shown full-page
screenshots at desktop and mobile widths. Be exacting but practical.

Flag concrete visual defects only — things you can SEE:
- empty / broken / blank media areas (blank boxes, missing images or video frames)
- LOGO/ICON CONTRAST: a logo, wordmark, or text that is washed out / barely
  visible against its background (e.g. a white logo on a light background, or
  dark text on a dark panel). Check the header logo specifically.
- poor contrast or unreadable text over busy/dark backgrounds
- LOW-QUALITY OR AWKWARD IMAGERY: a generated/background image that looks random,
  arbitrarily cropped, distorted, off-topic, or "AI-generated" in a bad way
  (a recognizable object awkwardly placed rather than tasteful ambient texture).
- misalignment, awkward spacing, cramped or colliding elements, overlap
- text overflow, truncation, or awkward wrapping
- broken-looking layout at mobile width; horizontal scroll; cut-off content
- inconsistent or off-brand color/typography; placeholder text still showing
- anything that looks unfinished, low-effort, or untrustworthy for a clinic/medical buyer

You are ALSO given the page's rendered text content, extracted from the DOM.
That text is GROUND TRUTH and the screenshots are not: small type, letter-spaced
labels and low-contrast captions are easy to misread from pixels.

Before reporting any finding about WORDING or a MISSING ELEMENT, check it
against that text:
- Do not report a typo unless the misspelling appears in the extracted text.
  (A real review once reported "ADVERBIAL QA" as a typo; the page said
  "adversarial QA".)
- Do not report placeholder or wrong URLs/copy unless the string appears there.
  (The same review reported a placeholder "research.org/mach33-ai" that existed
  nowhere on the page.)
- Do not report a missing button, link or CTA if its label appears in the text.
  (The same review called a CTA missing while the page carried one.)
Visual defects — contrast, spacing, blank media, cropping — remain yours to
judge from the screenshots, because the DOM cannot show them.

Two facts about THIS template that the screenshots cannot tell you. Both have
produced confident false findings, one of them graded CRITICAL:

1. The site header is STICKY and deliberately hidden at the top of the page.
   It slides in only once the visitor scrolls. A full-page screenshot starts at
   scroll-top, so the header's navigation is ABSENT BY DESIGN in the image you
   are given. Never report header nav links as missing, hidden or not visible —
   that is the design working. (Reported on two separate demos, once as
   critical, while every link was present in the extracted text.)

2. The example conversation is LIVE DOM — real elements, real text — not a
   screenshot or an embedded image. There is no raster there to be blurry,
   pixelated or low-resolution, so never describe it that way. If its TEXT is
   hard to read, report contrast or size instead, which are real and fixable.
   (Reported as a critical "blurry and pixelated screenshot" on two demos.)

Do NOT invent issues. If the page looks clean, say so with an empty findings list.
Return ONLY valid JSON: {"findings":[{"severity":"critical|major|minor","area":"<section>","issue":"<what you see>","fix":"<concrete suggestion>"}],"overall":"<one-sentence verdict>"}`;

async function vertexToken(): Promise<string> {
  const { stdout } = await execFileP("gcloud", ["auth", "print-access-token"], { timeout: 30_000 });
  const t = stdout.trim();
  if (!t) throw new Error("empty gcloud token — run `gcloud auth login`");
  return t;
}

async function shot(
  url: string,
  width: number,
  label: string,
  auth?: { username: string; password: string },
): Promise<string> {
  const browser = await chromium.launch();
  try {
    // A demo is preview-gated with HTTP basic auth until Gate 3 approves it, so
    // a reviewer without the credentials photographs the 401 challenge and
    // reports, with total confidence, that the page is "completely
    // inaccessible". mach33 scored 2 critical findings that way on a landing
    // page serving 200s on /, /og.png and /embed/.
    //
    // A review that cannot see the artifact must not grade it, and the fix is
    // to let it see: httpCredentials is the same thing demo-health already
    // reads out of state.json for the same reason.
    const page = await browser.newPage({
      viewport: { width, height: 900 },
      deviceScaleFactor: 1,
      httpCredentials: auth,
    });
    // Cache-bust. The review runs SECONDS after `wrangler deploy`, and the edge
    // can still be serving the previous build — so the reviewer grades a page
    // that no longer exists and reports defects that were fixed in the very
    // build being reviewed. That happened on 2026-08-11: it "confirmed" a CTA
    // contrast bug the deploy had just corrected, and a manual fetch reproduced
    // the stale copy until the asset propagated. A unique query string skips
    // the cached object; the extra settle covers propagation itself.
    const bust = `${url}${url.includes("?") ? "&" : "?"}_dr=${Date.now()}`;
    await page.goto(bust, { waitUntil: "networkidle", timeout: 60_000 }).catch(() => {});
    await page.waitForTimeout(4000); // fonts/images settle + edge propagation
    const buf = await page.screenshot({ fullPage: true, type: "png" });
    console.log(`[design-review] captured ${label} (${width}px, ${Math.round(buf.length / 1024)}KB)`);
    return buf.toString("base64");
  } finally {
    await browser.close();
  }
}

/**
 * The page's rendered text, for grounding.
 *
 * A vision model grading screenshots reads pixels, and on a clean mach33 page it
 * produced one CRITICAL and two specific, confident, WRONG findings: a typo that
 * was an OCR misread, a placeholder URL that appeared nowhere, and a missing CTA
 * that was present in the markup. Three of five findings were fiction.
 *
 * Screenshots stay — contrast, spacing and blank media are invisible in the DOM.
 * But claims about WORDS now have something to check against.
 */
async function pageText(url: string, auth?: { username: string; password: string }): Promise<string> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ httpCredentials: auth });
    await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 }).catch(() => {});
    const text = await page.evaluate(() => document.body?.innerText ?? "");
    // Links carry the claims a screenshot cannot settle — a placeholder href is
    // invisible on screen, and a CTA is a link before it is a rectangle.
    const links = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a"))
        .map((a) => `${(a.textContent ?? "").trim().slice(0, 60)} -> ${a.getAttribute("href") ?? ""}`)
        .filter((s) => s.length > 4)
        .slice(0, 60),
    );
    return `${text.slice(0, 12_000)}\n\n--- LINKS ---\n${links.join("\n")}`;
  } catch {
    return "";
  } finally {
    await browser.close();
  }
}

/** Run one review pass. Returns findings + writes a markdown report if outPath given. */
export async function reviewLanding(
  url: string,
  opts: { round?: number; outPath?: string; auth?: { username: string; password: string } } = {},
): Promise<{ findings: DesignFinding[]; overall: string }> {
  const token = await vertexToken();
  const cb = url.includes("?") ? "&" : "?"; // bust caches so we review the latest deploy
  const bust = `${cb}dr=${opts.round ?? 1}`;
  const [desktop, mobile, domText] = await Promise.all([
    shot(url + bust, 1440, "desktop", opts.auth),
    shot(url + bust, 390, "mobile", opts.auth),
    pageText(url + bust, opts.auth),
  ]);

  const body = {
    contents: [{
      role: "user",
      parts: [
        {
          text:
            `${RUBRIC}\n\nFirst image: DESKTOP (1440px). Second image: MOBILE (390px).` +
            (domText ? `\n\n--- RENDERED PAGE TEXT (ground truth) ---\n${domText}` : ""),
        },
        { inlineData: { mimeType: "image/png", data: desktop } },
        { inlineData: { mimeType: "image/png", data: mobile } },
      ],
    }],
    generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
  };
  const res = await fetch(
    `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT()}/locations/${VERTEX_LOCATION}/publishers/google/models/${VISION_MODEL}:generateContent`,
    { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
  if (!res.ok) throw new Error(`Vertex vision → HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("") ?? "{}";
  let parsed: { findings?: DesignFinding[]; overall?: string };
  try { parsed = JSON.parse(text); } catch { parsed = { findings: [], overall: "(could not parse model output)" }; }
  const findings = parsed.findings ?? [];
  const overall = parsed.overall ?? "";

  if (opts.outPath) {
    const order = { critical: 0, major: 1, minor: 2 } as const;
    const sorted = [...findings].sort((a, b) => order[a.severity] - order[b.severity]);
    const md = [
      `# Design review — round ${opts.round ?? 1}`,
      `**URL:** ${url}`,
      `**Verdict:** ${overall}`,
      ``,
      sorted.length ? `## Findings (${sorted.length})` : `## ✅ No issues found`,
      ...sorted.map((f) => `- ${f.severity === "critical" ? "🔴" : f.severity === "major" ? "🟠" : "🟡"} **${f.area}** — ${f.issue}\n  - _Fix:_ ${f.fix}`),
    ].join("\n");
    writeFileSync(opts.outPath, md + "\n");
    console.log(`[design-review] report → ${opts.outPath}`);
  }
  return { findings, overall };
}
