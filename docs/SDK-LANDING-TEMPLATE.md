# Divinci SDK Landing-Page Template — design

A subprocess of the demo factory that turns the **acmenutrition.ai** implementation
into a reusable, open-source foundation, then re-skins it per prospect from
their own brand. The branded landing page becomes the demo artifact we send.

> **Decisions locked (Mike, 2026-06-12):**
> 1. **Fork + parameterize** acmenutrition → `divinci-landing-template` (keep the
>    battle-tested infra; centralize brand into `brand.config.ts`).
> 2. **The branded landing IS the demo link** sent to prospects (wraps the
>    release); extend `injectDemoLink` + `teardown` to cover the landing Worker.
> 3. **Auto-extract brand from the customer site** (Playwright) → draft
>    `brand.config.ts` → **review board `[Landing]` gate** → build.
> Schema contract: `docs/brand.config.schema.ts`.

## How it slots into the pipeline

Today the outreach email links to the bare hosted chat
(`embed.stage.divinci.app/?release=<id>`). This subprocess upgrades that: the
demo link becomes a **branded landing page** that wraps the same release — a
far stronger artifact (the prospect sees *their* brand fronting the AI, not a
generic chat box). New stage sits after `release`, feeding `outreach`:

```
… → release → landing → outreach (demo link now points at the landing) → …
```

## Source analysis (acmenutrition.ai)

Astro + React islands + a Cloudflare Worker (`worker.ts`) + a Durable Object
(`EmailQuotaCoordinator`). The **foundation** (reusable as-is) is the entire
infra layer: email validation/normalization, disposable-email blocking, the
per-email quota Durable Object (unverified = 1 msg, verified = 5/24h),
magic-link email verification, HMAC-signed upstream calls, escrow/session
storage, the 36-locale i18n framework, the React chat island, Basic-Auth
preview gate, admin quota-reset.

The **brand-specific surface** is scattered across ~15 files + every i18n
locale (full inventory in the appendix). Colors are even duplicated between
`src/styles/global.css` and `scripts/build-og.mjs`. The release is wired in
`src/lib/divinci.ts` (client) and `wrangler.toml` (worker) — and notably the
prod env points at the **staging** API, which a real template must fix.

## Step 1 — Foundation extraction (the linchpin: one brand config)

Collapse the scattered brand surface into a single typed config + an asset
folder, and make every component/script read from it.

- **`brand.config.ts`** (typed) — the single source of truth:
  - `identity`: siteName, domain, productName ("DFO AI" → customer's), copyright
  - `palette`: the 8 color tokens (consumed by both `global.css` via CSS-var
    injection AND the OG script — kills the duplication)
  - `fonts`: family + weights
  - `links`: mainSite, signupUrl, loginUrl, bio/credit URL (Divinci legal URLs
    stay shared)
  - `divinci`: releaseId, apiBase, whitelabelId (client); worker reads the same
    via wrangler vars
  - `bios[]`: name, title, blurb-key per person
  - `corpus`: stat lines, "decades of research" framing
  - `chat`: fallback welcome + starters (today hardcoded in divinci.ts)
  - `media`: hero image, corpus video, OG tagline/subtitle, logo + favicon paths
  - `referral`: UTM source
- **`brand/` asset dir** — `logo.svg`, `favicon.svg`, `hero.webp`,
  `corpus.webm`, generated `og.png`.
- **Parameterize**: components/sections, Layout, Header/Footer, Bios,
  divinci.ts, build-og.mjs, astro.config, wrangler.toml all read
  `brand.config.ts`. i18n keeps translatable *prose* but brand nouns come from
  config (so swapping the brand doesn't require touching 36 locale files).
- **Fix**: prod env → prod Divinci API; document the client/worker releaseId
  split.
- Output: a `divinci-landing-template` repo where a new customer = fill
  `brand.config.ts` + drop 4 assets.

## Step 2 — Brand-kit assessment (customer site → draft config)

Generate a `brand.config.ts` draft from the prospect's website, for human review.

- **Extract** via headless render of the customer's homepage (Playwright is
  already a dep): computed CSS custom properties + dominant
  colors (palette), `<link rel=icon>` + logo `<img>`/inline SVG (assets),
  `font-family` stack (fonts), `<title>`/meta/H1 + nav labels (copy + voice
  cues), OG image.
- **Synthesize** the palette into the 8 template tokens (primary/dark/mid/
  accent/cream/soft/bubble/text) — an LLM step maps the extracted colors onto
  the template's semantic roles.
- **Emit** a draft `brand.config.ts` + downloaded assets into
  `runs/<prospect>/<run>/landing/brand/`.
- **Human gate (review board)** — same pattern as Gate 1/2: an `[Landing]` task
  with a screenshot of the prospect site + the proposed palette/logo, approve
  or tweak before building. Reuses the brand assessment we already gather in
  the outreach `research-expanded.md`.

> Alternative considered: Canva brand-kit tooling (we have the Canva MCP). It's
> better for *generating* brand assets than *extracting* an existing brand, so
> it's a complement (deck generation) rather than the extractor here.

## Step 3 — Build per-customer

- Scaffold from the template, drop in the approved `brand.config.ts` + assets,
  `npm run build`, deploy to a per-customer Cloudflare Worker
  (`<prospect>-landing`) on a demo subdomain.
- Wire the published release (from the `release` stage) + the HMAC secret.
- The resulting URL replaces the bare embed link in the outreach email
  (extends `injectDemoLink`) and is subject to the same 14-day teardown
  (extend `teardown.ts` to also delete the landing Worker).

## Step 4 — Open-source + docs

- Publish `divinci-landing-template` as a public repo under `Divinci-AI`
  (strip all acmenutrition specifics; ship a neutral "Acme Expert" example brand
  config so it builds out-of-the-box).
- Add a "Landing-page starter" section to **sdk.divinci.ai** docs: quickstart
  (clone → fill brand.config → deploy), the foundation feature list, the
  config reference.
- This doubles as SDK marketing: the template is a living `@divinci-ai/client`
  example.

## Phasing & cost note

Steps 1 and 4 are platform/OSS work (do once, benefits every demo). Steps 2–3
are the per-prospect automation. Recommend building **Step 1 first** (the
config centralization is the foundation everything else needs), shipping it
open-source (Step 4), then automating extraction (Step 2) and per-customer
build (Step 3). This is multi-session — Step 1 alone is a meaningful chunk.

## Appendix — brand surface inventory (from acmenutrition.ai)

colors `src/styles/global.css` L3–11 (+ dup `scripts/build-og.mjs` L17–22) ·
logo `public/acmenutrition-logo.svg` · favicon `public/favicon.svg` · hero
`HeroSection.astro` L26 (R2 URL) · corpus video `CorpusSection.astro` L34 ·
domain `astro.config.mjs` L17 + `Landing.astro` L38,L65 · nav link
`Header.astro` L18 · bios `BiosSection.astro` L27–29 + i18n · footer
`Footer.astro` L13–16,L24 · chat welcome/starters `src/lib/divinci.ts` L44–49 ·
signup/login `src/lib/divinci.ts` L15–22 · release/API `src/lib/divinci.ts`
L3–5 + `wrangler.toml` vars · OG tagline `scripts/build-og.mjs` L77,L80 ·
worker sender `worker.ts` L114 · UTM `src/lib/links.ts` L17 · all `src/i18n/ui/*.ts`.
