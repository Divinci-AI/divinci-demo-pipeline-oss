/**
 * brand.config.ts — the single source of truth for re-skinning the
 * Divinci SDK landing-page template (see docs/SDK-LANDING-TEMPLATE.md).
 *
 * This is the SCHEMA CONTRACT. In Step 1, every brand-specific value scattered
 * across drfuhrman.ai (global.css, build-og.mjs, divinci.ts, the .astro
 * sections, astro.config, wrangler.toml, i18n nouns) is moved to read from a
 * `BrandConfig` object shaped like this. Re-skinning a customer then = produce
 * one of these (Step 2 auto-extracts a draft) + drop 4 assets in brand/.
 *
 * Two reference configs ship with the template:
 *   examples/acme.brand.config.ts      — neutral, builds out-of-the-box (OSS)
 *   examples/drfuhrman.brand.config.ts — the real values, proves the extraction
 */

export interface BrandConfig {
  identity: {
    /** "MD Spine Care" — used in OG, copyright, og:site_name */
    siteName: string;
    /** canonical site, e.g. "https://acmespine-demo.divinci.app" */
    domain: string;
    /** the AI product name shown in chat, e.g. "DFO AI" → "MD Spine Care AI" */
    productName: string;
    /** copyright holder text; year is always dynamic */
    legalName: string;
  };

  /** 8 semantic color tokens — injected as CSS vars (global.css) AND consumed
   *  by the OG generator (kills the drfuhrman global.css/build-og.mjs dup). */
  palette: {
    primary: string;   // df-navy
    dark: string;      // df-green-dark
    mid: string;       // df-green-mid
    accent: string;    // df-green-leaf
    cream: string;     // df-cream
    soft: string;      // df-cream-soft
    bubble: string;    // df-bubble-user
    text: string;      // df-text
  };

  fonts: {
    /** CSS font-family stack; template self-hosts or links the named family */
    family: string;
    headingWeight: number;
    bodyWeight: number;
  };

  links: {
    mainSite: string;        // prospect's primary website
    signupUrl: string;       // membership/signup CTA target
    loginUrl: string;        // member login target
    bioCreditUrl: string;    // bios "credit" link
    /** Divinci legal URLs are SHARED across customers — defaulted, rarely set */
    terms?: string;
    privacy?: string;
    aiSafety?: string;
  };

  /** Divinci wiring. Client uses releaseId/apiBase; the worker reads the same
   *  via wrangler vars (keep them in sync, or document the multi-turn split). */
  divinci: {
    releaseId: string;
    apiBase: string;         // PROD api for real customers (drfuhrman bug: prod→staging)
    whitelabelId: string;
  };

  /** People featured in the bios section. Prose blurbs stay translatable in
   *  i18n keyed by `blurbKey`; names/titles come from here. */
  bios: Array<{
    name: string;
    title: string;
    blurbKey: string;        // i18n key, e.g. "bios.bodies.0"
  }>;

  corpus: {
    /** framing line, e.g. "Built on four decades of research" */
    framing: string;
    /** stat lines: { value: "2,000+", label: "ACDF procedures" } */
    stats: Array<{ value: string; label: string }>;
  };

  /** Fallback chat content when the release fetch fails (today hardcoded in
   *  divinci.ts L44-49). Live values still come from the Release server-side. */
  chat: {
    fallbackWelcome: string;
    starters: string[];
  };

  media: {
    logo: string;            // brand/logo.svg
    favicon: string;         // brand/favicon.svg
    heroImage: string;       // brand/hero.webp (or CDN URL)
    corpusVideo?: string;    // brand/corpus.webm (optional)
    ogTagline: string;       // OG card headline
    ogSubtitle: string;      // OG card subline
  };

  /** UTM source for outbound link tagging (lib/links.ts REF_SOURCE) */
  referral: { source: string };

  /** Cloudflare deploy identity (wrangler.toml). KV/DO namespaces are created
   *  per-account at deploy time, not stored here. */
  deploy: {
    workerName: string;      // e.g. "acmespine-landing"
    /** the demo subdomain the landing is served on */
    demoHost: string;
  };
}

/* ----------------------------------------------------------------------------
 * Example — the values Step 2's auto-extractor would draft for MD Spine Care,
 * shown filled in so the schema is concrete. (Illustrative; not wired yet.)
 * --------------------------------------------------------------------------*/
export const MDSPINECARE_EXAMPLE: BrandConfig = {
  identity: {
    siteName: "MD Spine Care",
    domain: "https://acmespine-demo.divinci.app",
    productName: "MD Spine Care AI",
    legalName: "MD Spine Care & Orthopaedics",
  },
  palette: {
    // placeholder — Step 2 extracts real values from acmespine.com
    primary: "#1f3a5f", dark: "#13283f", mid: "#2e5a86", accent: "#4a90d9",
    cream: "#f5f7fa", soft: "#e8edf2", bubble: "#dce7f2", text: "#1a1a1a",
  },
  fonts: { family: "'Inter', system-ui, sans-serif", headingWeight: 700, bodyWeight: 400 },
  links: {
    mainSite: "https://www.acmespine.com",
    signupUrl: "https://www.acmespine.com/contact",
    loginUrl: "https://www.acmespine.com/patient-portal",
    bioCreditUrl: "https://www.acmespine.com/about",
  },
  divinci: {
    releaseId: "6a293367c50b252c45c6ca47",
    apiBase: "https://api.stage.divinci.app",
    whitelabelId: "6a293367c50b252c45c6ca44",
  },
  bios: [{ name: "Dr. Frank K. Kuwamura III, MD", title: "Founder & Chief Spine Surgeon", blurbKey: "bios.bodies.0" }],
  corpus: {
    framing: "Built on 19+ years of spine surgery expertise",
    stats: [
      { value: "2,000+", label: "ACDF procedures performed" },
      { value: "5", label: "locations across San Antonio" },
      { value: "19+", label: "years in practice" },
    ],
  },
  chat: {
    fallbackWelcome: "Hi, I'm MD Spine Care's AI assistant. Ask me about spine procedures, recovery, or scheduling a consult.",
    starters: [
      "What is ACDF surgery and what does recovery look like?",
      "What's the difference between XLIF and ALIF?",
      "How do I schedule a consultation with Dr. Kuwamura?",
    ],
  },
  media: {
    logo: "brand/logo.svg",
    favicon: "brand/favicon.svg",
    heroImage: "brand/hero.webp",
    ogTagline: "Spine answers, 24/7.",
    ogSubtitle: "AI-powered patient education from MD Spine Care — chat anytime, in any language.",
  },
  referral: { source: "acmespine-demo" },
  deploy: { workerName: "acmespine-landing", demoHost: "acmespine-demo.divinci.app" },
};
