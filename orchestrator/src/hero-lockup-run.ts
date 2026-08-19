/**
 * hero-lockup-run.ts — drive the deterministic lockup probe against a URL.
 *
 * Split from hero-lockup-check.ts so the grading logic stays importable and
 * testable without launching a browser.
 *
 *   npx tsx src/hero-lockup-run.ts https://demo-x-landing.example-account.workers.dev
 */
import { HERO_PROBE, gradeLockup, type HeroLockupMeasurement, type LockupFinding } from "./hero-lockup-check.js";

export interface LockupResult {
  url: string;
  viewport: "desktop" | "mobile";
  scope: "hero" | "header";
  measurement: HeroLockupMeasurement;
  findings: LockupFinding[];
}

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
} as const;

/**
 * Cache-bust the probed URL.
 *
 * ⚠️ This check runs SECONDS after `wrangler deploy`, and Cloudflare's edge
 * can still be serving the previous revision. On 2026-08-14 it reported
 * `AI offset -3.5px ❌` for a page whose deployed HTML already carried the
 * corrected `translate-y-[3.50px]` and measured 0.54px in a real browser —
 * the numbers were byte-identical to the PREVIOUS run's, which is the tell.
 *
 * A checker that reads a stale page is worse than no checker: it fails a
 * correct fix, and it would equally pass a fresh regression.
 *
 * The buster must be unique per RUN, not per process start, so two deploys a
 * minute apart cannot share an edge cache entry.
 */
export function bustCache(url: string, token: string): string {
  const u = new URL(url);
  u.searchParams.set("__lockup", token);
  return u.toString();
}

export async function checkHeroLockup(
  url: string,
  which: (keyof typeof VIEWPORTS)[] = ["desktop", "mobile"],
  cacheToken: string = String(Date.now()),
): Promise<LockupResult[]> {
  const probeUrl = bustCache(url, cacheToken);
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const out: LockupResult[] = [];
  try {
    for (const v of which) {
      const page = await browser.newPage({ viewport: VIEWPORTS[v] });
      try {
        await page.goto(probeUrl, { waitUntil: "networkidle", timeout: 60_000 });
        // Belt and braces: a hard reload past any in-page cache too.
        await page.reload({ waitUntil: "networkidle" });
        // The hero animates in; measuring mid-transition reads a position the
        // visitor never sees.
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(600);
        // Invoke it. A bare arrow-function STRING evaluates to the function itself,
        // so page.evaluate(HERO_PROBE) returned a function handle and every field
        // read undefined.
        for (const scope of ["hero", "header"] as const) {
          const measurement = (await page.evaluate(`(${HERO_PROBE})(${JSON.stringify(scope)})`)) as HeroLockupMeasurement;
          out.push({ url, viewport: v, scope, measurement, findings: gradeLockup(measurement) });
        }
      } catch (err) {
        // A probe that cannot run reports an ERROR, never an empty finding
        // list — "we could not look" must not read as "it is fine".
        out.push({
          url, viewport: v, scope: "hero",
          measurement: { contrast: null, logoInk: null, background: null, deltaPx: null, logoSrc: null,
            error: (err as Error).message.split("\n")[0] },
          findings: [],
        });
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
  return out;
}

/** One-line summary per viewport, for the run log. */
export function summarise(results: LockupResult[]): string[] {
  return results.map((r) => {
    const m = r.measurement;
    if (m.error) return `lockup [${r.scope}/${r.viewport}]: NOT MEASURED — ${m.error}`;
    const bits = [
      m.contrast !== null ? `contrast ${m.contrast.toFixed(2)}:1` : "contrast n/a",
      m.deltaPx !== null ? `AI offset ${m.deltaPx > 0 ? "+" : ""}${m.deltaPx.toFixed(1)}px` : "AI offset n/a",
    ];
    // Report MINOR findings too. Filtering the summary to critical/major
    // printed "✅ ok" for a 2.0px offset that had already breached the 1px
    // threshold — a summary that contradicts its own findings list is worse
    // than no summary.
    const bad = r.findings.filter((f) => f.severity === "critical" || f.severity === "major");
    const minor = r.findings.filter((f) => f.severity === "minor");
    const verdict = bad.length
      ? `❌ ${bad.map((f) => f.message).join("; ")}`
      : minor.length
        ? `⚠️  ${minor.map((f) => f.message).join("; ")}`
        : "✅ ok";
    return `lockup [${r.scope}/${r.viewport}]: ${bits.join(", ")} — ${verdict}`;
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.argv[2];
  if (!url) { console.error("usage: tsx src/hero-lockup-run.ts <url>"); process.exit(2); }
  const res = await checkHeroLockup(url);
  for (const line of summarise(res)) console.log(line);
  const critical = res.flatMap((r) => r.findings).filter((f) => f.severity === "critical").length;
  // A viewport that could not be MEASURED also exits non-zero. Exiting 0 on
  // "no findings" when the probe never ran is the same silent-success shape
  // the summary line is already careful about — and this code had it.
  const unmeasured = res.filter((r) => r.measurement.error).length;
  process.exit(critical || unmeasured ? 1 : 0);
}
