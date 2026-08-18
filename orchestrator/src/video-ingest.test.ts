import { describe, it, expect } from "vitest";
import { vttToTranscript, expandVideoUrls } from "./video-ingest.js";

describe("vttToTranscript", () => {
  it("strips WEBVTT chrome + cue tags and emits prose", () => {
    const vtt = [
      "WEBVTT",
      "Kind: captions",
      "Language: en",
      "",
      "00:00:01.000 --> 00:00:04.000",
      "<c>Hello</c> and welcome to the show",
      "",
      "00:00:05.000 --> 00:00:08.000",
      "today we discuss spine care",
    ].join("\n");
    const out = vttToTranscript(vtt);
    expect(out).toContain("Hello and welcome to the show");
    expect(out).toContain("today we discuss spine care");
    expect(out).not.toContain("WEBVTT");
    expect(out).not.toContain("<c>");
  });

  it("dedupes consecutive duplicate lines (auto-caption rolling window)", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:03.000",
      "the same line",
      "",
      "00:00:03.000 --> 00:00:05.000",
      "the same line",
    ].join("\n");
    const out = vttToTranscript(vtt);
    expect(out.match(/the same line/g)?.length).toBe(1);
  });

  it("emits [t=Ns] markers and handles MM:SS (hours optional)", () => {
    const vtt = [
      "WEBVTT",
      "",
      "01:05.000 --> 01:08.000",   // MM:SS form → 65s
      "a later line",
    ].join("\n");
    const out = vttToTranscript(vtt);
    expect(out).toMatch(/\[t=65s\]/);
  });

  it("decodes HTML entities", () => {
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nrock &amp; roll &#39;n stuff";
    expect(vttToTranscript(vtt)).toContain("rock & roll 'n stuff");
  });
});

describe("expandVideoUrls", () => {
  it("treats a watch?v=…&list=… URL as ONE video (does not expand the playlist)", async () => {
    const u = "https://www.youtube.com/watch?v=abc123DEFGH&list=PLxxxx";
    expect(await expandVideoUrls(u)).toEqual([u]);
  });
  it("treats a youtu.be short link as one video", async () => {
    const u = "https://youtu.be/abc123DEFGH";
    expect(await expandVideoUrls(u)).toEqual([u]);
  });
});
