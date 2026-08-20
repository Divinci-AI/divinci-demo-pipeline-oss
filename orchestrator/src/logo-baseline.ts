import { execFileSync } from "node:child_process";

/**
 * Where a logo IMAGE's letterforms sit — which is NOT the bottom of its ink.
 *
 * The header and hero lay the lockup out with `items-baseline`, which puts an
 * <img>'s BOTTOM EDGE on the text baseline. That is right for a tightly-cropped
 * wordmark and wrong for the very common case of a wordmark beside a mark: the
 * mark overshoots, so the image's lowest ink belongs to the MARK and the
 * letters float above the "AI" next to them.
 *
 * Measured on Acme Advisors (643x143): the flame occupies rows 3..142 while
 * "ACMEADVISORS" occupies rows 55..129. Thirteen pixels of overshoot — ~5px once
 * the logo is drawn at the hero's 56px, which is exactly the gap visible on the
 * deployed page.
 *
 * Note the existing lockup probe did NOT catch the cause. It compares the AI's
 * BOX centre to the logo's INK centre, mixing two different references, and
 * reported +11.0px for a lockup whose baselines are 0.00px apart. The number
 * was real evidence of a real problem and a bad guide to its size.
 */

/** A column's lowest ink row, or -1 where the column is empty. */
function columnInkBottoms(alpha: Uint8Array, width: number, height: number, threshold = 8): number[] {
  const out = new Array<number>(width).fill(-1);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) if (alpha[row + x] > threshold) out[x] = y;
  }
  return out;
}

/** A baseline must carry at least this share of the inked columns. */
export const MIN_BASELINE_SUPPORT = 0.25;

/**
 * The letterforms' baseline as a fraction of image height (1 = image bottom).
 *
 * Not the mode, and emphatically not the extreme. Take every row that carries
 * at least MIN_BASELINE_SUPPORT of the inked columns, and return the LOWEST of
 * them. Two different logos make that the right rule for two different reasons:
 *
 *   - Acme Advisors: letters on row 129 (~520 columns) and a flame descending to
 *     row 142 (~100 columns). The flame is 16% of the columns, below the
 *     support floor, so it cannot pass for a baseline. The letters win.
 *   - A logo with a TAGLINE under the wordmark has two well-supported rows.
 *     The one that should sit on the "AI" baseline is the lower — the mode
 *     would pick whichever line happens to be wider, which is arbitrary.
 *
 * Returns undefined when the image gives no confident answer — an empty raster,
 * or no row with real support (a pure mark has no letterforms at all).
 * Undefined must mean "change nothing", never "assume zero".
 */
export function letterBaselineFraction(
  alpha: Uint8Array,
  width: number,
  height: number,
): number | undefined {
  if (width <= 0 || height <= 0 || alpha.length < width * height) return undefined;
  const bottoms = columnInkBottoms(alpha, width, height).filter((v) => v >= 0);
  if (bottoms.length < 8) return undefined;

  // Rows within 1px are the same baseline: antialiasing puts a glyph's last
  // row one pixel lower under one stem than another.
  const tally = new Map<number, number>();
  for (const b of bottoms) for (const k of [b - 1, b, b + 1]) tally.set(k, (tally.get(k) ?? 0) + 1);
  const floor = bottoms.length * MIN_BASELINE_SUPPORT;
  const supported = [...tally].filter(([, n]) => n >= floor).map(([row]) => row);
  if (!supported.length) return undefined;
  return (Math.max(...supported) + 1) / height;
}

/**
 * How far DOWN to nudge the logo so its letters share the "AI" baseline,
 * as a fraction of the rendered image height.
 *
 * A fraction, not pixels, because the same logo is drawn at 56px in the hero
 * and 24px in the header — and a CSS translate percentage resolves against the
 * element's own box, so one number is correct at both.
 */
export function baselineDropFraction(
  alpha: Uint8Array,
  width: number,
  height: number,
): number | undefined {
  const frac = letterBaselineFraction(alpha, width, height);
  if (frac === undefined) return undefined;
  const drop = 1 - frac;
  // Sub-pixel at every size we draw: not worth a style attribute, and rounding
  // noise is how a "fix" starts moving correct pages.
  if (drop * 56 < 0.5) return undefined;
  return drop;
}

/**
 * Measure a logo file on disk. Returns undefined for anything unreadable —
 * an SVG (no raster to inspect), a format ffmpeg cannot decode, an image with
 * no alpha channel. Every one of those must leave the lockup exactly as it is.
 *
 * ffmpeg rather than an image library: it is already a hard dependency of the
 * landing stage (the headshot crop path shells out to it), so this adds
 * nothing to install.
 */
export function measureLogoBaselineDrop(logoPath: string): number | undefined {
  if (/\.svg$/i.test(logoPath)) return undefined;
  try {
    const dims = execFileSync("ffprobe",
      ["-v","error","-select_streams","v:0","-show_entries","stream=width,height","-of","csv=p=0", logoPath],
      { timeout: 20_000 }).toString().trim();
    const [w, h] = dims.split(",").map(Number);
    if (!w || !h) return undefined;
    const raw = execFileSync("ffmpeg",
      ["-v","error","-i",logoPath,"-vf","alphaextract","-pix_fmt","gray","-f","rawvideo","-"],
      { timeout: 30_000, maxBuffer: 1 << 28 });
    if (raw.length < w * h) return undefined;
    return baselineDropFraction(new Uint8Array(raw), w, h);
  } catch {
    return undefined;
  }
}
