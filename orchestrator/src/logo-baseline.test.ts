import { describe, it, expect } from "vitest";
import {
  MIN_BASELINE_SUPPORT,
  letterBaselineFraction,
  baselineDropFraction,
} from "./logo-baseline.js";

/**
 * Build an alpha buffer where column x is fully inked from row 0 down to
 * bottoms[x] (inclusive). A bottom of -1 leaves the column empty.
 */
function buildAlpha(height: number, bottoms: number[], value = 255): Uint8Array {
  const width = bottoms.length;
  const alpha = new Uint8Array(width * height);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y <= bottoms[x]; y++) alpha[y * width + x] = value;
  }
  return alpha;
}

const repeat = (n: number, v: number): number[] => new Array<number>(n).fill(v);

describe("MIN_BASELINE_SUPPORT", () => {
  it("is a quarter of the inked columns", () => {
    expect(MIN_BASELINE_SUPPORT).toBe(0.25);
  });
});

describe("invalid input", () => {
  const buf = new Uint8Array(100).fill(255);

  it("returns undefined for zero width", () => {
    expect(letterBaselineFraction(buf, 0, 10)).toBeUndefined();
    expect(baselineDropFraction(buf, 0, 10)).toBeUndefined();
  });

  it("returns undefined for zero height", () => {
    expect(letterBaselineFraction(buf, 10, 0)).toBeUndefined();
    expect(baselineDropFraction(buf, 10, 0)).toBeUndefined();
  });

  it("returns undefined for negative width or height", () => {
    expect(letterBaselineFraction(buf, -10, 10)).toBeUndefined();
    expect(letterBaselineFraction(buf, 10, -10)).toBeUndefined();
    expect(baselineDropFraction(buf, -10, 10)).toBeUndefined();
    expect(baselineDropFraction(buf, 10, -10)).toBeUndefined();
  });

  it("returns undefined when the buffer is shorter than width*height", () => {
    const short = new Uint8Array(99).fill(255);
    expect(letterBaselineFraction(short, 10, 10)).toBeUndefined();
    expect(baselineDropFraction(short, 10, 10)).toBeUndefined();
  });

  it("accepts a buffer of exactly width*height", () => {
    expect(letterBaselineFraction(buf, 10, 10)).toBeDefined();
  });
});

describe("empty and sparse images", () => {
  it("handles an all-transparent buffer without throwing", () => {
    const empty = new Uint8Array(20 * 20);
    expect(() => letterBaselineFraction(empty, 20, 20)).not.toThrow();
    expect(() => baselineDropFraction(empty, 20, 20)).not.toThrow();
    expect(letterBaselineFraction(empty, 20, 20)).toBeUndefined();
    expect(baselineDropFraction(empty, 20, 20)).toBeUndefined();
  });

  it("gives no answer with fewer than 8 inked columns", () => {
    const alpha = buildAlpha(20, [...repeat(7, 14), -1, -1, -1]);
    expect(letterBaselineFraction(alpha, 10, 20)).toBeUndefined();
    expect(baselineDropFraction(alpha, 10, 20)).toBeUndefined();
  });

  it("gives an answer with exactly 8 inked columns", () => {
    const alpha = buildAlpha(20, [...repeat(8, 14), -1, -1]);
    expect(letterBaselineFraction(alpha, 10, 20)).toBeCloseTo(16 / 20, 10);
  });

  it("treats alpha at or below the threshold (8) as empty", () => {
    const faint = buildAlpha(20, repeat(10, 14), 8);
    expect(letterBaselineFraction(faint, 10, 20)).toBeUndefined();
    const inked = buildAlpha(20, repeat(10, 14), 9);
    expect(letterBaselineFraction(inked, 10, 20)).toBeCloseTo(16 / 20, 10);
  });
});

describe("letterBaselineFraction", () => {
  it("puts a flat baseline at the shared ink-bottom row", () => {
    // All columns end on row 14 of 20. The code returns (14 + 1 + 1) / 20:
    // the 1px antialias tolerance widens the supported rows to 13..15 and
    // the result is the lowest supported row plus one.
    // NOTE: code disagrees with its comment: the doc says the lowest row with
    // support is returned (as a fraction where 1 is the image bottom), but
    // the result is two rows below the ink bottom, not one.
    const alpha = buildAlpha(20, repeat(10, 14));
    expect(letterBaselineFraction(alpha, 10, 20)).toBeCloseTo(0.8, 10);
  });

  it("ignores a lone column that drops below the rest", () => {
    // 9 columns end at row 10, one at row 18. The stray column has support
    // 1 < floor 2.5, so it does not move the baseline.
    const alpha = buildAlpha(20, [...repeat(9, 10), 18]);
    expect(letterBaselineFraction(alpha, 10, 20)).toBeCloseTo(12 / 20, 10);
  });

  it("counts a lower group once it reaches 25% of inked columns", () => {
    // 3 of 10 columns (30%) end at row 18, so rows 17..19 are supported and
    // the baseline moves down to (19 + 1) / 20 = 1.
    const alpha = buildAlpha(20, [...repeat(7, 10), ...repeat(3, 18)]);
    expect(letterBaselineFraction(alpha, 10, 20)).toBeCloseTo(1, 10);
  });

  it("treats support exactly at the floor as supported", () => {
    // 8 inked columns, floor = 8 * 0.25 = 2. Two columns at row 18 is enough.
    const alpha = buildAlpha(20, [...repeat(6, 10), ...repeat(2, 18)]);
    expect(letterBaselineFraction(alpha, 8, 20)).toBeCloseTo(1, 10);
  });

  it("merges ink bottoms that are 1px apart into one baseline", () => {
    // Five columns end at row 10, five at row 11. Row 12 gets support from the
    // row-11 columns' +1 tolerance, so the lowest supported row is 12.
    const alpha = buildAlpha(20, [...repeat(5, 10), ...repeat(5, 11)]);
    expect(letterBaselineFraction(alpha, 10, 20)).toBeCloseTo(13 / 20, 10);
  });

  it("ignores empty columns when counting support", () => {
    // 8 inked columns plus 4 empty ones: support is judged against 8, not 12.
    const alpha = buildAlpha(20, [...repeat(8, 14), -1, -1, -1, -1]);
    expect(letterBaselineFraction(alpha, 12, 20)).toBeCloseTo(16 / 20, 10);
  });

  it("can exceed 1 when ink reaches the last row", () => {
    // NOTE: code disagrees with its comment: the doc says 1 = image bottom,
    // but ink ending on row 19 of 20 gives (20 + 1) / 20 = 1.05.
    const alpha = buildAlpha(20, repeat(10, 19));
    expect(letterBaselineFraction(alpha, 10, 20)).toBeCloseTo(1.05, 10);
  });
});

describe("baselineDropFraction", () => {
  it("returns 1 minus the baseline fraction for a flat baseline", () => {
    const alpha = buildAlpha(20, repeat(10, 14));
    const drop = baselineDropFraction(alpha, 10, 20);
    expect(drop).toBeDefined();
    expect(drop as number).toBeCloseTo(0.2, 10);
  });

  it("is larger when the letters sit higher in the image", () => {
    const flatLow = baselineDropFraction(buildAlpha(20, repeat(10, 14)), 10, 20);
    // Same shape, but the lowest ink is higher; one stray column drops below
    // the rest without gaining support.
    const withStray = baselineDropFraction(buildAlpha(20, [...repeat(9, 10), 18]), 10, 20);
    expect(flatLow).toBeDefined();
    expect(withStray).toBeDefined();
    expect(withStray as number).toBeGreaterThan(flatLow as number);
    expect(withStray as number).toBeCloseTo(0.4, 10);
  });

  it("returns undefined when ink ends on the last row (nothing to drop)", () => {
    // Baseline fraction is 1.05, so the drop is negative and under half a pixel.
    const alpha = buildAlpha(20, repeat(10, 19));
    expect(baselineDropFraction(alpha, 10, 20)).toBeUndefined();
  });

  it("returns undefined when a supported lower group puts the baseline at 1", () => {
    const alpha = buildAlpha(20, [...repeat(7, 10), ...repeat(3, 18)]);
    expect(baselineDropFraction(alpha, 10, 20)).toBeUndefined();
  });

  it("returns undefined for a sub-pixel drop at the 56px render size", () => {
    // Height 200, ink bottom row 197: fraction 199/200, drop 0.005, and
    // 0.005 * 56 = 0.28 < 0.5.
    const alpha = buildAlpha(200, repeat(10, 197));
    expect(letterBaselineFraction(alpha, 10, 200)).toBeCloseTo(0.995, 10);
    expect(baselineDropFraction(alpha, 10, 200)).toBeUndefined();
  });

  it("returns the drop once it reaches half a pixel at 56px", () => {
    // Ink bottom row 195: fraction 197/200, drop 0.015, and 0.015 * 56 = 0.84.
    const alpha = buildAlpha(200, repeat(10, 195));
    const drop = baselineDropFraction(alpha, 10, 200);
    expect(drop).toBeDefined();
    expect(drop as number).toBeCloseTo(0.015, 10);
  });

  it("returns undefined whenever the baseline itself is unknown", () => {
    expect(baselineDropFraction(new Uint8Array(400), 20, 20)).toBeUndefined();
  });
});
