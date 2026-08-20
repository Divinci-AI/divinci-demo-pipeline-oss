/**
 * Pre-outreach preflight — measure the demo, do not judge it.
 *
 * Every defect this catches shipped at least once on 2026-08-06, and none was
 * caught by the checks that already existed. The pattern behind all of them is
 * the same: the pipeline verified that a STEP RAN, not that it PRODUCED
 * something. A step that "succeeded" and left nothing behind is invisible.
 *
 *   og.png was never built            → SPA fallback served 200 text/html
 *   corpus.webm upload blipped        → SPA fallback served 200 text/html
 *   copy step echoed the template     → "Replace this with the founder's bio"
 *   no person could be identified     → "The Acme Finance Group — Founder"
 *   nav is `hidden md:flex`           → no navigation at all below 768px
 *
 * WHY THIS IS SEPARATE FROM THE DESIGN REVIEW. That is a vision model asked for
 * taste, and on a clean page it produced one CRITICAL and two specific, false
 * claims — an OCR misread reported as a typo, a placeholder URL that appeared
 * nowhere, and a missing CTA that was present in the markup. It is useful for
 * judgement and unreliable for fact.
 *
 * So this asserts only things a browser can MEASURE — a number, a status, a
 * computed style. There is no model in this path and there must not be one. If
 * a check here cannot be expressed as a measurement, it belongs in the review.
 *
 * It does not block. Gate 3 is a human decision and the loop never approves a
 * gate; what this guarantees is that the decision is not made against a page
 * nobody looked at.
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export interface AssetCheck {
  url: string;
  /** Same-origin only — see `sameOriginOnly` in `measureDemo`. */
  contentType: string;
  status: number;
}

export interface Viewport {
  label: string;
  width: number;
  /** Rendered innerText. Placeholder detection runs against this, not the HTML. */
  text: string;
  brokenImages: string[];
  deadVideos: string[];
  horizontalScroll: boolean;
  /** A visible nav link, or a visible control that reveals one. */
  navigationReachable: boolean;
  failedRequests: string[];
}

export interface Measurements {
  url: string;
  reachable: boolean;
  viewports: Viewport[];
  assets: AssetCheck[];
  ogImage?: string;
  error?: string;
  /**
   * Bio-card roles as rendered on the default page and on one translated page.
   *
   * Preflight otherwise only asks whether things RENDER, never whether they are
   * right. `brand.config` is not localized while the i18n `bios.roles` array is,
   * and the two are joined by index — so a card past the end of the dictionary
   * used to print English into a translated page, and every existing check
   * called that healthy.
   */
  bioRoles?: { default: string[]; localized: string[]; lang: string };
  /**
   * Full-page screenshots, written to disk when `screenshotDir` is given.
   *
   * Exists because every automated gate in this pipeline measures MECHANICS —
   * does it load, does it render, does the assistant answer — and none of them
   * measures whether the page is any good. Michael found eight venture
   * executives captioned "Physician", six of them wearing a colleague's face,
   * in seconds, by looking at it. Every gate had called that page clean.
   *
   * So the point is not to check the image; it is to put the artifact in front
   * of the human at the moment they are asked to approve it.
   */
  screenshots?: Array<{ label: string; path: string }>;
}

export interface Defect {
  /** `blocking` = do not send this to a prospect. `warning` = look before sending. */
  severity: "blocking" | "warning";
  what: string;
}

/**
 * Strings that mean nobody wrote this.
 *
 * Anchored on instructional phrasing, because real copy does not address the
 * reader about itself. Kept in sync with landing.ts's PLACEHOLDER_COPY by
 * intent rather than by import: that one edits a source file, this one reads a
 * rendered page, and a shared regex would tie two different jobs together.
 */
export const PLACEHOLDER_TEXT = [
  /\breplace this with\b/i,
  /\blorem ipsum\b/i,
  /\byour (?:bio|text|copy|content) here\b/i,
  /\bplaceholder\b/i,
  /\bTODO\b/,
  /\bacme (?:expert|corp)\b/i,
];

/**
 * Turn measurements into defects. Pure — this is the part worth testing.
 */
/**
 * Does the translated page carry every bio role the default page does?
 *
 * The one preflight check that asks whether content is RIGHT rather than
 * whether it rendered. `brand.config` is not localized while `bios.roles` is,
 * and the renderer joins them by index — so any card past the end of the
 * dictionary has no translated role. It used to print the English one; it now
 * prints nothing. Either way the translation is incomplete, and every other
 * check in this file calls the page healthy.
 *
 * A WARNING, not blocking: the page is coherent and sendable, and the missing
 * text is a role beside a name and a photograph. Blocking here would park demos
 * for a cosmetic gap and teach people to skip the gate.
 */
export function incompleteTranslationDefects(
  roles: Measurements["bioRoles"],
): Defect[] {
  if (!roles) return [];
  const missing: number[] = [];
  for (let i = 0; i < roles.default.length; i++) {
    if (roles.default[i]?.trim() && !roles.localized[i]?.trim()) missing.push(i);
  }
  if (!missing.length) return [];
  return [
    {
      severity: "warning",
      what:
        `${missing.length} of ${roles.default.length} bio card(s) show a role in English but none in ` +
        `/${roles.lang}/ — the localized bios dictionary is shorter than the team list, ` +
        `so cards ${missing.join(", ")} are untranslated in all 34 non-default languages`,
    },
  ];
}

export function evaluatePreflight(m: Measurements): Defect[] {
  const defects: Defect[] = [];
  if (!m.reachable) {
    return [{ severity: "blocking", what: `the demo did not load: ${m.error ?? "unknown error"}` }];
  }

  // An asset answered with HTML is a MISSING asset. The worker serves
  // `not_found_handling = "single-page-application"`, so a 404 arrives as a
  // 200 carrying index.html — a broken hero and a working one are the same
  // status code, which is why this is checked by content-type.
  for (const a of m.assets) {
    if (a.contentType.startsWith("text/html"))
      defects.push({
        severity: "blocking",
        what: `${path(a.url)} serves HTML, not media — the file is MISSING and the SPA fallback is hiding it`,
      });
    else if (a.status >= 400)
      defects.push({ severity: "blocking", what: `${path(a.url)} returns HTTP ${a.status}` });
  }

  defects.push(...incompleteTranslationDefects(m.bioRoles));

  if (!m.ogImage) {
    defects.push({ severity: "warning", what: "no og:image — shared links will unfurl blank" });
  } else if (!/^https?:\/\//.test(m.ogImage)) {
    // X and LinkedIn will not resolve a relative og:image.
    defects.push({ severity: "blocking", what: `og:image is relative (${m.ogImage}) — it must be absolute` });
  }

  for (const v of m.viewports) {
    const found = PLACEHOLDER_TEXT.filter((re) => re.test(v.text)).map(String);
    if (found.length)
      defects.push({
        severity: "blocking",
        what: `${v.label}: placeholder copy is visible on the page (${found.join(", ")})`,
      });

    for (const src of v.brokenImages)
      defects.push({ severity: "blocking", what: `${v.label}: image never loaded — ${path(src)}` });
    for (const src of v.deadVideos)
      defects.push({ severity: "blocking", what: `${v.label}: video has no frames — ${path(src)}` });

    if (v.horizontalScroll)
      defects.push({ severity: "blocking", what: `${v.label}: the page scrolls sideways` });

    if (!v.navigationReachable)
      defects.push({
        severity: "warning",
        what: `${v.label}: no reachable navigation — links present but no way to open them`,
      });

    for (const r of v.failedRequests)
      defects.push({ severity: "warning", what: `${v.label}: request failed — ${r}` });
  }
  return defects;
}

function path(u: string): string {
  try {
    return new URL(u).pathname;
  } catch {
    return u;
  }
}

/** Drive a real browser at both widths. */
export async function measureDemo(
  url: string,
  auth?: { username: string; password: string },
): Promise<Measurements> {
  const browser = await chromium.launch();
  const out: Measurements = { url, reachable: false, viewports: [], assets: [] };
  let defaultBioRoles: string[] = [];
  try {
    const origin = new URL(url).origin;
    for (const [label, width] of [
      ["desktop", 1440],
      ["mobile", 390],
    ] as const) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, httpCredentials: auth });
      const failed: string[] = [];
      page.on("response", (r) => {
        if (r.status() >= 400) failed.push(`${r.status()} ${r.url().slice(0, 80)}`);
      });
      // Cache-bust: a review of the previous deploy is worse than no review,
      // and one round of this exact confusion happened on 2026-08-06.
      const res = await page
        .goto(`${url}${url.includes("?") ? "&" : "?"}pf=${Date.now()}`, {
          waitUntil: "networkidle",
          timeout: 60_000,
        })
        .catch((e: Error) => {
          out.error = e.message.split("\n")[0];
          return null;
        });
      if (!res) {
        await page.close();
        continue;
      }
      out.reachable = true;

      // Scroll the whole page before measuring anything.
      //
      // Images below the fold are `loading="lazy"`, so their naturalWidth is 0
      // until they enter the viewport — indistinguishable from broken. The
      // first real run of this check reported six of acmeincubator's team photos as
      // "never loaded" on MOBILE only, where the taller layout pushes them
      // further down; every one of them served 200 with real bytes from R2.
      //
      // A visitor scrolls, so the measurement should too. Doing this rather
      // than skipping lazy images keeps the check able to catch a lazy image
      // that IS broken.
      await page.evaluate(async () => {
        const step = window.innerHeight;
        for (let y = 0; y < document.body.scrollHeight; y += step) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 120));
        }
        window.scrollTo(0, 0);
      });
      // Media decodes after networkidle; without this a healthy video reads as dead.
      await page.waitForTimeout(2500);

      // NOTE: no named inner functions in here. tsx compiles with esbuild's
      // keepNames, which wraps any named function in a `__name(...)` helper —
      // and `page.evaluate` ships the function SOURCE to the browser, where
      // that helper does not exist. The first real Gate 3 would have died on
      // `ReferenceError: __name is not defined`. Keep this body to expressions.
      const v = await page.evaluate(() => {
        const nav = Array.from(document.querySelectorAll("header a, header button, nav a"));
        return {
          text: document.body?.innerText ?? "",
          brokenImages: Array.from(document.querySelectorAll("img"))
            .filter((i) => i.naturalWidth === 0)
            .map((i) => i.currentSrc || i.src),
          deadVideos: Array.from(document.querySelectorAll("video"))
            .filter((x) => x.videoWidth === 0)
            .map((x) => x.currentSrc || x.getAttribute("src") || "(no src)"),
          horizontalScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          // A visible link, or a visible control that could reveal one. The
          // mobile header had neither: nav in the DOM at `display: none`, and
          // no button anywhere in the header.
          navigationReachable: nav.some((el) => (el as HTMLElement).offsetParent !== null),
          mediaUrls: [
            ...Array.from(document.querySelectorAll("img")).map((i) => i.currentSrc || i.src),
            ...Array.from(document.querySelectorAll("video")).map((x) => x.currentSrc || (x.getAttribute("src") ?? "")),
            ...Array.from(document.querySelectorAll("source")).map((x) => x.getAttribute("src") ?? ""),
          ].filter(Boolean),
          ogImage: document.querySelector('meta[property="og:image"]')?.getAttribute("content") ?? undefined,
          bioRoles: Array.from(document.querySelectorAll("#bios article")).map((c) => {
            const el = c.querySelector("[data-bio-role]") ?? c.querySelector("h3 + p");
            return (el?.textContent ?? "").trim().slice(0, 60);
          }),
        };
      });

      out.ogImage ??= v.ogImage;
      if (label === "desktop") defaultBioRoles = v.bioRoles ?? [];

      out.viewports.push({
        label,
        width,
        text: v.text,
        brokenImages: v.brokenImages,
        deadVideos: v.deadVideos,
        horizontalScroll: v.horizontalScroll,
        navigationReachable: v.navigationReachable,
        failedRequests: failed,
      });

      // Same-origin only. Media on R2 is a different origin serving real 404s,
      // where a status code already means what it says; the SPA fallback trap
      // exists only on the worker itself.
      if (!out.assets.length) {
        const candidates = [...new Set([...v.mediaUrls, v.ogImage].filter(Boolean) as string[])]
          .filter((u) => u.startsWith(origin))
          .slice(0, 25);
        for (const u of candidates) {
          const r = await page.request.get(u).catch(() => null);
          if (!r) continue;
          out.assets.push({
            url: u,
            status: r.status(),
            contentType: (r.headers()["content-type"] ?? "").toLowerCase(),
          });
        }
      }
      await page.close();
    }

    // One translated page, to check the translation is COMPLETE rather than
    // merely present. French stands in for all 34 non-default locales: the
    // failure is structural — the localized dictionary is shorter than the card
    // list — so it appears identically in every one of them.
    if (out.reachable) {
      try {
        const lp = await browser.newPage({ viewport: { width: 1440, height: 900 }, httpCredentials: auth });
        await lp.goto(`${url.replace(/\/$/, "")}/fr/?pf=${Date.now()}`, { waitUntil: "networkidle", timeout: 45_000 });
        const roles = (await lp.evaluate(
          // [data-bio-role] is the template's contract hook; "h3 + p" keeps this
          // working on demos deployed before it. NOT a bare p/span/div — that
          // matches the card WRAPPER, which holds the name too, so a card with
          // no role at all still reads as non-empty and the check passes on a
          // page that is visibly wrong. That was the first version.
          `(() => Array.from(document.querySelectorAll("#bios article")).map(function(c){ var e = c.querySelector("[data-bio-role]") || c.querySelector("h3 + p"); return ((e && e.textContent) || "").trim().slice(0,60); }))()`,
        )) as string[];
        out.bioRoles = { default: defaultBioRoles, localized: roles, lang: "fr" };
        await lp.close();
      } catch {
        /* a demo with no /fr/ is not a defect — leave bioRoles undefined */
      }
    }
    return out;
  } finally {
    await browser.close();
  }
}

/**
 * Measure, and re-measure once if it looks broken.
 *
 * The preflight runs seconds after `wrangler deploy`, and Cloudflare takes a
 * little while to serve the new build everywhere. Measuring the PREVIOUS deploy
 * and reporting its defects against the new one is a false alarm of exactly the
 * kind this module exists to eliminate — it happened three times while this was
 * being written, twice convincingly enough to send me looking for a bug that
 * had already been fixed.
 *
 * Only pays the delay when something looks wrong, and reports the SECOND
 * result: a real defect survives a retry, a stale cache does not. It cannot
 * mask a genuine problem, because a genuine problem is still there 20 seconds
 * later.
 */
/**
 * Full-page screenshots for the Gate 3 task, in a browser of their own.
 *
 * Deliberately NOT part of measureDemo. Taken inline on the measuring page they
 * killed the whole measurement: a full-page capture of a long landing page is a
 * large buffer, and after extractBrand and findTeam have already driven Chromium
 * in the same process it was enough to take the browser down — turning
 * "preflight clean" into "preflight failed: browser has been closed" on a page
 * that was fine. The gate lost its measurement to a convenience feature.
 *
 * So: separate browser, after measurement, and every failure swallowed. A
 * missing screenshot is a worse review; a missing measurement is an unverified
 * demo, and those must not share a failure mode.
 */
export async function captureScreenshots(
  url: string,
  dir: string,
  auth?: { username: string; password: string },
): Promise<Array<{ label: string; path: string }>> {
  const out: Array<{ label: string; path: string }> = [];
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    mkdirSync(dir, { recursive: true });
    browser = await chromium.launch();
    const shots: Array<{ label: string; width: number; path: string }> = [
      { label: "desktop", width: 1440, path: `${url.replace(/\/$/, "")}/` },
      { label: "mobile", width: 390, path: `${url.replace(/\/$/, "")}/` },
      { label: "français", width: 1440, path: `${url.replace(/\/$/, "")}/fr/` },
    ];
    for (const s of shots) {
      try {
        const page = await browser.newPage({
          viewport: { width: s.width, height: 900 },
          httpCredentials: auth,
          // Half-resolution: the reviewer is looking for "is this obviously
          // wrong", not pixel fidelity, and it quarters the buffer.
          deviceScaleFactor: 0.5,
        });
        await page.goto(`${s.path}?shot=${Date.now()}`, { waitUntil: "networkidle", timeout: 45_000 });
        const file = join(dir, `preflight-${s.label}.png`);
        await page.screenshot({ path: file, fullPage: true });
        out.push({ label: s.label, path: file });
        await page.close();
      } catch {
        /* one missing view must not cost the others */
      }
    }
  } catch {
    /* no screenshots at all is acceptable; a failed gate is not */
  } finally {
    await browser?.close().catch(() => {});
  }
  return out;
}

export async function measureUntilStable(
  url: string,
  auth?: { username: string; password: string },
  opts: {
    retryDelayMs?: number;
    measure?: typeof measureDemo;
    sleep?: (ms: number) => Promise<void>;
    /** Where to write full-page screenshots for the Gate 3 task. */
    screenshotDir?: string;
  } = {},
): Promise<{ measurements: Measurements; defects: Defect[]; retried: boolean }> {
  const measure = opts.measure ?? measureDemo;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let measurements = await measure(url, auth);
  let defects = evaluatePreflight(measurements);
  if (!defects.some((d) => d.severity === "blocking")) {
    if (opts.screenshotDir) measurements.screenshots = await captureScreenshots(url, opts.screenshotDir, auth);
    return { measurements, defects, retried: false };
  }
  await sleep(opts.retryDelayMs ?? 20_000);
  // Re-measure OVERWRITES the screenshots, deliberately: the reviewer must see
  // the page as it finally stands, not a stale first pass.
  measurements = await measure(url, auth);
  defects = evaluatePreflight(measurements);
  // Captured from the FINAL state, so the reviewer sees the page as it stands.
  if (opts.screenshotDir) measurements.screenshots = await captureScreenshots(url, opts.screenshotDir, auth);
  return { measurements, defects, retried: true };
}

/** One-line-per-defect block for a review-board task or a log. */
export function formatDefects(defects: Defect[]): string {
  if (!defects.length) return "✅ Preflight: no measured defects (assets, copy, layout, navigation).";
  const blocking = defects.filter((d) => d.severity === "blocking");
  const warnings = defects.filter((d) => d.severity === "warning");
  return [
    blocking.length
      ? `⛔ **${blocking.length} BLOCKING defect(s) — do not send this demo:**\n${blocking.map((d) => `- ${d.what}`).join("\n")}`
      : "✅ No blocking defects.",
    warnings.length ? `\n⚠️ ${warnings.length} warning(s):\n${warnings.map((d) => `- ${d.what}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
