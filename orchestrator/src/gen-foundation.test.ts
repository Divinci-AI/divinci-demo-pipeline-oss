import { describe, it, expect } from "vitest";
import { buildFoundationPrompt, type FoundationKit } from "./gen-foundation.js";

const base: FoundationKit = {
  org: "Acme Spine Care", productName: "Acme Spine Care AI",
  tagline: "Every procedure. Every page. Every answer.",
  valueProp: "Trained only on our content.",
  palette: { primary: "#172e47", accent: "#1877f2", mid: "#264c75", cream: "#fff", soft: "#f5f5f5", text: "#111" },
  fontFamily: '"Source Sans Pro", sans-serif', fontLink: "https://fonts.googleapis.com/css2?family=Source+Sans+Pro&display=swap",
  logoUrl: "/brand/logo.png", logoIsLight: true,
  corpusStats: [{ value: "99", label: "pages indexed" }],
  team: [
    { name: "Dr. Alex Rivera", title: "Spine Surgeon", image: "https://x/t0.webp" },
    { name: "Dr. Reem Razeq", title: "Spine Surgeon" },
  ],
  hasLogin: false, mainSite: "https://www.acmespine.com", embedUrl: "/embed/",
};

describe("buildFoundationPrompt", () => {
  it("forbids a login link when hasLogin is false", () => {
    const p = buildFoundationPrompt(base);
    expect(p).toMatch(/do NOT add any .*sign-in link/i);
  });
  it("permits a login link when hasLogin is true", () => {
    expect(buildFoundationPrompt({ ...base, hasLogin: true })).toMatch(/MAY add a single subtle "Log in"/);
  });
  it("mandates a dark header (unconditional) + literal hex (no fake Tailwind names)", () => {
    const p = buildFoundationPrompt(base);
    expect(p).toMatch(/header\/nav bar MUST have a SOLID DEEP background/);
    expect(p).toMatch(/Do NOT invent custom Tailwind color names/);
  });
  it("includes the embed iframe url + photoless member initials", () => {
    const p = buildFoundationPrompt(base);
    expect(p).toContain("/embed/");
    expect(p).toContain('initials "RR"');     // Razeq → no photo → navy circle + RR
    expect(p).toContain("photo: https://x/t0.webp"); // Rivera → photo
  });
  it("injects only provided facts (no-invention guardrail present)", () => {
    expect(buildFoundationPrompt(base)).toMatch(/Do NOT invent stats|use ONLY the facts/i);
  });
});
