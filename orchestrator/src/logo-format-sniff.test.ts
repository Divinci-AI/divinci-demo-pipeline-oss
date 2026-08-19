import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { sniffImageFormat, imageDimensions, logoIsMark } from "./brand-extract.js";

/**
 * Acme Renew's hero rendered their circular clinic icon beside "AI", with the
 * brand name nowhere on the page — the exact failure `logoIsMark` exists to
 * prevent, on a logo that is 1:1 and could not be more obviously a mark.
 *
 * The cause was not the threshold. The logo URL ended `.png`, an
 * image-optimising CDN served **WebP**, the file was written as `logo.png`
 * because the URL said so, and `pngDimensions` then found no IHDR and returned
 * undefined. `logoIsMark` treats undefined as "keep the wordmark assumption",
 * so it fell back to rendering the image.
 *
 * An extension is a claim about a file; the magic bytes are the file.
 */

/** Minimal but REAL headers — byte layouts, not hand-waved buffers. */
function webpVP8X(w: number, h: number): Buffer {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "ascii");
  b.write("WEBP", 8, "ascii");
  b.write("VP8X", 12, "ascii");
  b.writeUIntLE(w - 1, 24, 3);
  b.writeUIntLE(h - 1, 27, 3);
  return b;
}

function png(w: number, h: number): Buffer {
  const b = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

function gif(w: number, h: number): Buffer {
  const b = Buffer.alloc(10);
  b.write("GIF89a", 0, "ascii");
  b.writeUInt16LE(w, 6);
  b.writeUInt16LE(h, 8);
  return b;
}

function jpeg(w: number, h: number): Buffer {
  // SOI, then a SOF0 segment carrying the frame size.
  const b = Buffer.alloc(20);
  b[0] = 0xff; b[1] = 0xd8;
  b[2] = 0xff; b[3] = 0xc0;
  b.writeUInt16BE(11, 4); // segment length
  b[6] = 8;               // sample precision
  b.writeUInt16BE(h, 7);
  b.writeUInt16BE(w, 9);
  return b;
}

describe("sniffImageFormat", () => {
  it("identifies a WebP that is NAMED .png", () => {
    expect(sniffImageFormat(webpVP8X(512, 512))).toBe("webp");
  });

  it("identifies png / gif / jpeg / svg", () => {
    expect(sniffImageFormat(png(100, 40))).toBe("png");
    expect(sniffImageFormat(gif(10, 10))).toBe("gif");
    expect(sniffImageFormat(jpeg(64, 64))).toBe("jpeg");
    expect(sniffImageFormat(Buffer.from('<?xml version="1.0"?><svg viewBox="0 0 300 60"/>'))).toBe("svg");
  });

  it("does not mistake arbitrary bytes for an image", () => {
    expect(sniffImageFormat(Buffer.from("not an image at all"))).toBe("unknown");
    expect(sniffImageFormat(Buffer.alloc(0))).toBe("unknown");
  });
});

describe("imageDimensions", () => {
  it("reads every format we can be served", () => {
    expect(imageDimensions(webpVP8X(512, 512))).toEqual({ w: 512, h: 512 });
    expect(imageDimensions(png(300, 60))).toEqual({ w: 300, h: 60 });
    expect(imageDimensions(gif(48, 48))).toEqual({ w: 48, h: 48 });
    expect(imageDimensions(jpeg(1200, 630))).toEqual({ w: 1200, h: 630 });
    expect(imageDimensions(Buffer.from('<svg viewBox="0 0 300 60"/>'))).toEqual({ w: 300, h: 60 });
  });
});

describe("logoIsMark", () => {
  it("flags a SQUARE logo as a mark — use the styled name instead", () => {
    expect(logoIsMark(webpVP8X(512, 512))).toBe(true);
    expect(logoIsMark(png(200, 200))).toBe(true);
  });

  it("still treats a wide wordmark as a wordmark", () => {
    // Mislabelling a wordmark would print the brand name twice, so this is the
    // direction that must not regress.
    expect(logoIsMark(png(600, 100))).toBe(false);
    expect(logoIsMark(Buffer.from('<svg viewBox="0 0 300 60"/>'))).toBe(false);
  });

  it("returns undefined — not false — when it cannot tell", () => {
    // undefined keeps the caller's existing assumption; false would be a
    // positive claim the bytes do not support.
    expect(logoIsMark(Buffer.from("garbage"))).toBeUndefined();
  });

  it("ignores the extension argument entirely", () => {
    // The old signature trusted it. A WebP labelled "png" must still be read.
    expect(logoIsMark(webpVP8X(512, 512), "png")).toBe(true);
  });
});

describe("the actual Acme Renew asset", () => {
  const REAL = "runs/acmerenew/2026-08-14-001/landing/brand/logo.png";
  it.skipIf(!existsSync(`../${REAL}`))("is a WebP misnamed .png, and is now read correctly", () => {
    const buf = readFileSync(`../${REAL}`);

    // Named .png, is not a PNG. This is the whole bug.
    expect(sniffImageFormat(buf)).toBe("webp");

    // ⚠️ NOT square — 1200x800, i.e. 1.5:1. It *looks* like a circular icon
    // because the mark is centred in a 3:2 frame (an og:image-shaped asset).
    // So "detect square" would have MISSED it; the existing 1.6 aspect
    // threshold catches it and the real defect was that the dimensions could
    // not be read at all.
    const d = imageDimensions(buf)!;
    expect(d).toEqual({ w: 1200, h: 800 });
    expect(d.w / d.h).toBeLessThan(1.6);

    expect(logoIsMark(buf)).toBe(true);
  });
});
