/**
 * Brand-media generation — produces on-brand hero + corpus visuals for a
 * prospect's landing page and uploads them to R2.
 *
 *   Imagen 3 (still)  ─┬─> hero.webp           (cwebp)        ─┐
 *                      └─> corpus still ─> Veo 3.1 Fast (mp4) ─┼─> R2 (public)
 *                                          └─> corpus.webm (ffmpeg vp9)        │
 *                                          └─> corpus-poster.jpg (ffmpeg)      │
 *                                                                              ▼
 *                                              media.{heroImage,corpusVideo} URLs
 *
 * All of Google's gen runs through Vertex AI (gcloud auth) on the configured
 * project — the standalone Gemini API key is expired. Every step is wrapped so
 * a failure (no gcloud token, quota, model error) degrades to "no generated
 * media" and the landing falls back to its placeholder; a demo build NEVER
 * breaks because image gen hiccuped.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lazyEnv } from "./require-env.js";

const execFileP = promisify(execFile);

const VERTEX_PROJECT = lazyEnv("VERTEX_PROJECT()", "the GCP project Vertex AI generation is billed to");
const VERTEX_LOCATION = process.env.VERTEX_LOCATION ?? "us-central1";
const IMAGE_MODEL = process.env.VERTEX_IMAGE_MODEL ?? "imagen-3.0-generate-002";
const VEO_MODEL = process.env.VERTEX_VEO_MODEL ?? "veo-3.1-fast-generate-001";
/** R2 bucket generated demo media is uploaded to. Required — see require-env.ts
 *  for why nothing naming external infrastructure carries a default. */
const R2_BUCKET = lazyEnv(
  "DEMO_ASSETS_R2_BUCKET",
  "the R2 bucket generated demo media is uploaded to",
);
/** Public r2.dev base for DEMO_ASSETS_R2_BUCKET — enable the bucket's dev URL
 *  in the Cloudflare dashboard and set this to the `https://pub-….r2.dev` it
 *  gives you. Required: this base is baked into every generated landing page,
 *  so a wrong value ships broken media to a client-facing demo. */
const R2_PUBLIC_BASE = lazyEnv(
  "DEMO_ASSETS_R2_BASE",
  "the public r2.dev base URL for DEMO_ASSETS_R2_BUCKET",
);

// Strip CF token vars so wrangler uses the OAuth session (see CLAUDE.md).
const CF_ENV = { ...process.env };
delete CF_ENV.CLOUDFLARE_API_TOKEN;
delete CF_ENV.CLOUDFLARE_EMAIL;
delete CF_ENV.CLOUDFLARE_ACCOUNT_ID;

export interface VideoAsset { videoUrl: string; posterUrl: string }

export interface GeneratedBrandMedia {
  heroImageUrl?: string;
  corpusVideoUrl?: string;
  /** Local path to a poster frame to stage into landing/brand/corpus-poster.jpg. */
  corpusPosterPath?: string;
  /** Feature-section videos (generated-mode demo, drfuhrman-style): a native
   *  mobile app w/ photo recognition (multimodal) + an on-device/offline clip. */
  mobileAppVideo?: VideoAsset;
  offlineVideo?: VideoAsset;
}

/**
 * Imagen still → Veo clip → webm+mp4+poster → R2. Returns the public mp4 +
 * poster URLs (mp4 = universal playback incl. Safari; webm stored alongside).
 */
async function genVideoAsset(
  token: string, workDir: string, prospect: string, key: string,
  stillPrompt: string, motionPrompt: string,
): Promise<VideoAsset> {
  const png = join(workDir, `_${key}.png`);
  const mp4 = join(workDir, `_${key}.mp4`);
  const webm = join(workDir, `_${key}.webm`);
  const posterPng = join(workDir, `_${key}-poster.png`);
  const posterWebp = join(workDir, `_${key}-poster.webp`);
  await imagen(token, stillPrompt, "16:9", png);
  await veoFromImage(token, png, motionPrompt, mp4);
  execFileSync("ffmpeg", ["-y", "-i", mp4, "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "34", "-an", "-row-mt", "1", "-pix_fmt", "yuv420p", webm], { stdio: "ignore" });
  execFileSync("ffmpeg", ["-y", "-i", mp4, "-frames:v", "1", "-q:v", "3", posterPng], { stdio: "ignore" });
  execFileSync("cwebp", ["-q", "82", posterPng, "-o", posterWebp], { stdio: "ignore" });
  r2Put(mp4, `${prospect}/${key}.mp4`, "video/mp4");
  r2Put(webm, `${prospect}/${key}.webm`, "video/webm");
  r2Put(posterWebp, `${prospect}/${key}-poster.webp`, "image/webp");
  return { videoUrl: `${R2_PUBLIC_BASE()}/${prospect}/${key}.mp4`, posterUrl: `${R2_PUBLIC_BASE()}/${prospect}/${key}-poster.webp` };
}

/**
 * Human color NAME for a hex (e.g. "#155388" → "deep blue"). Imagen ignores raw
 * hex codes — it needs the color word to steer palette — so prompts pass both.
 */
export function colorName(hex: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return "brand";
  const r = parseInt(m[1], 16) / 255, g = parseInt(m[2], 16) / 255, b = parseInt(m[3], 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (s < 0.12) return l < 0.2 ? "near-black" : l > 0.85 ? "off-white" : "grey";
  let h = 0;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  const hue =
    h < 15 || h >= 345 ? "red" : h < 45 ? "orange" : h < 65 ? "amber" : h < 150 ? "green" :
    h < 195 ? "teal" : h < 255 ? "blue" : h < 290 ? "indigo" : h < 320 ? "purple" : "magenta";
  const tone = l < 0.35 ? "deep " : l > 0.7 ? "light " : "";
  return `${tone}${hue}`;
}

/**
 * Gemini API key path (generativelanguage.googleapis.com).
 *
 * The Vertex path needs a gcloud OAuth token AND the model enabled in the
 * project — `imagen-3.0-generate-002:predict` answers HTTP 404 there, which
 * reads like an auth failure and is not one. The Gemini API serves
 * imagen-4.0 / veo-3.1 against a plain API key, so when GEMINI_API_KEY (or
 * GOOGLE_API_KEY) is present we use it and skip gcloud entirely.
 */
const GEMINI_KEY = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "";
const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL ?? "imagen-4.0-generate-001";
const GEMINI_VIDEO_MODEL = process.env.GEMINI_VIDEO_MODEL ?? "veo-3.1-generate-preview";
export const usingGeminiApi = (): boolean => GEMINI_KEY.length > 0;

async function geminiPost(model: string, verb: string, body: unknown): Promise<any> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:${verb}?key=${GEMINI_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Gemini ${model}:${verb} → HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

async function geminiGet(path: string): Promise<any> {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/${path}${sep}key=${GEMINI_KEY}`);
  if (!res.ok) throw new Error(`Gemini GET ${path} → HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function vertexToken(): Promise<string> {
  const { stdout } = await execFileP("gcloud", ["auth", "print-access-token"], { timeout: 30_000 });
  const t = stdout.trim();
  if (!t) throw new Error("empty gcloud access token");
  return t;
}

async function vertexPost(token: string, model: string, verb: string, body: unknown): Promise<any> {
  const url = `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT()}/locations/${VERTEX_LOCATION}/publishers/google/models/${model}:${verb}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Vertex ${model}:${verb} → HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

/** Depth-first search for a video file URI in a Veo response. */
function findFileUri(o: any): string | undefined {
  if (!o || typeof o !== "object") return undefined;
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === "string" && /^https?:\/\//.test(v) && (k === "uri" || k === "fileUri" || k === "videoUri")) return v;
    if (typeof v === "object") { const r = findFileUri(v); if (r) return r; }
  }
  return undefined;
}

/** Imagen 3 → PNG file. */
async function imagen(token: string, prompt: string, aspect: string, outPng: string): Promise<void> {
  if (usingGeminiApi()) {
    const r = await geminiPost(GEMINI_IMAGE_MODEL, "predict", {
      instances: [{ prompt }],
      // The Gemini API takes a SUBSET of Vertex's parameters — passing Vertex's
      // addWatermark/safetySetting here is a 400.
      parameters: { sampleCount: 1, aspectRatio: aspect, personGeneration: "allow_adult" },
    });
    const b64 = r?.predictions?.[0]?.bytesBase64Encoded;
    if (!b64) throw new Error("Imagen (Gemini API) returned no image");
    writeFileSync(outPng, Buffer.from(b64, "base64"));
    return;
  }
  const r = await vertexPost(token, IMAGE_MODEL, "predict", {
    instances: [{ prompt }],
    parameters: { sampleCount: 1, aspectRatio: aspect, personGeneration: "allow_adult", addWatermark: false, safetySetting: "block_few" },
  });
  const b64 = r?.predictions?.[0]?.bytesBase64Encoded;
  if (!b64) throw new Error("Imagen returned no image");
  writeFileSync(outPng, Buffer.from(b64, "base64"));
}

/** Veo 3.1 image-to-video → MP4 file (polls fetchPredictOperation). */
async function veoFromImage(token: string, pngPath: string, motion: string, outMp4: string): Promise<void> {
  const img = readFileSync(pngPath).toString("base64");
  if (usingGeminiApi()) {
    // Gemini API differs from Vertex in three ways that each fail loudly:
    // the op is polled via GET /{operation.name}, the result carries a FILE
    // URI rather than inline bytes, and downloading that file needs the key.
    // Only aspectRatio is verified-accepted here. Vertex's `generateAudio` is
    // rejected outright by this model ("`generateAudio` isn't supported by this
    // model"), and that 400 is what made the whole media step fail — so keep
    // this parameter set minimal rather than mirroring the Vertex call.
    const op = await geminiPost(GEMINI_VIDEO_MODEL, "predictLongRunning", {
      instances: [{ prompt: motion, image: { bytesBase64Encoded: img, mimeType: "image/png" } }],
      parameters: { aspectRatio: "16:9" },
    });
    const name = op?.name;
    if (!name) throw new Error("Veo (Gemini API) did not return an operation name");
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 15_000));
      const d = await geminiGet(name);
      if (!d?.done) continue;
      if (d.error) throw new Error(`Veo error: ${JSON.stringify(d.error).slice(0, 300)}`);
      const inline = findB64(d.response ?? d);
      if (inline) { writeFileSync(outMp4, Buffer.from(inline, "base64")); return; }
      const uri = findFileUri(d.response ?? d);
      if (!uri) throw new Error("Veo done but no video payload");
      const res = await fetch(`${uri}${uri.includes("?") ? "&" : "?"}key=${GEMINI_KEY}`);
      if (!res.ok) throw new Error(`Veo file download → HTTP ${res.status}`);
      writeFileSync(outMp4, Buffer.from(await res.arrayBuffer()));
      return;
    }
    throw new Error("Veo (Gemini API) timed out");
  }
  const op = await vertexPost(token, VEO_MODEL, "predictLongRunning", {
    instances: [{ prompt: motion, image: { bytesBase64Encoded: img, mimeType: "image/png" } }],
    parameters: { aspectRatio: "16:9", sampleCount: 1, durationSeconds: 6, generateAudio: false },
  });
  const name = op?.name;
  if (!name) throw new Error("Veo did not return an operation name");
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 15_000));
    const d = await vertexPost(token, VEO_MODEL, "fetchPredictOperation", { operationName: name });
    if (d?.done) {
      if (d.error) throw new Error(`Veo error: ${JSON.stringify(d.error).slice(0, 300)}`);
      const b64 = findB64(d.response ?? d);
      if (!b64) throw new Error("Veo done but no inline video");
      writeFileSync(outMp4, Buffer.from(b64, "base64"));
      return;
    }
  }
  throw new Error("Veo timed out");
}

function findB64(o: any): string | null {
  if (o && typeof o === "object") {
    for (const k of ["bytesBase64Encoded", "videoBytes"]) if (typeof o[k] === "string") return o[k];
    for (const v of Object.values(o)) { const r = findB64(v); if (r) return r; }
  }
  return null;
}

function r2Put(localPath: string, key: string, contentType: string): void {
  execFileSync("npx", ["wrangler", "r2", "object", "put", `${R2_BUCKET()}/${key}`, "--file", localPath, "--content-type", contentType, "--remote"],
    { env: CF_ENV, timeout: 5 * 60 * 1000, stdio: ["ignore", "ignore", "inherit"] });
}

/** Upload a local file to the public demo-assets bucket; returns its public URL.
 *  Shared by brand-media and the headshot finder. */
export function uploadDemoAsset(localPath: string, key: string, contentType: string): string {
  r2Put(localPath, key, contentType);
  return `${R2_PUBLIC_BASE()}/${key}`;
}

/**
 * Generate the two drfuhrman-style feature videos (native mobile app w/ photo
 * recognition + on-device/offline) → R2. Best-effort per video. Reuses a passed
 * Vertex token or mints its own (so it can run standalone).
 */
export async function generateFeatureVideos(
  workDir: string, prospect: string,
  opts: { primaryHex?: string; subject?: string },
  token?: string,
): Promise<{ mobileAppVideo?: VideoAsset; offlineVideo?: VideoAsset }> {
  const navy = opts.primaryHex ?? "#172e47";
  const subject = opts.subject ?? "the organization's field of expertise";
  let tok: string;
  try { tok = token ?? (await vertexToken()); } catch (e) { console.warn(`[brand-media] feature videos skipped — ${(e as Error).message.split("\n")[0]}`); return {}; }
  let mobileAppVideo: VideoAsset | undefined, offlineVideo: VideoAsset | undefined;
  try {
    mobileAppVideo = await genVideoAsset(tok, workDir, prospect, "mobile-app",
      `Premium editorial product photo, 16:9: a person holding a smartphone over a printed document/report related to ${subject}, the phone screen showing an AI assistant analysis overlay with a soft glowing ${navy} analysis ring framing the subject, shallow depth of field, clean modern, deep ${navy} and calm blue accents, warm light. Trustworthy, professional. No readable text, no logos, no watermark.`,
      "Very slow, gentle, looping motion: the analysis ring softly pulses and rotates on the phone screen, faint scan shimmer, minimal hand movement, calm premium. No text appearing.");
  } catch (e) { console.warn(`[brand-media] mobile-app video skipped — ${(e as Error).message.split("\n")[0]}`); }
  try {
    offlineVideo = await genVideoAsset(tok, workDir, prospect, "offline",
      `Premium editorial product photo, 16:9: a smartphone on a clean minimal surface showing a chat-assistant interface for ${subject}, a subtle on-device / offline glow (no connectivity), deep ${navy} and blue accents, soft studio light, calm and trustworthy, modern clinical/professional. No readable text, no logos, no watermark.`,
      "Very slow, gentle, looping motion: soft ambient light shift, a faint pulse on the phone screen, minimal camera drift. Calm, premium. No text appearing, no people.");
  } catch (e) { console.warn(`[brand-media] offline video skipped — ${(e as Error).message.split("\n")[0]}`); }
  return { mobileAppVideo, offlineVideo };
}

/**
 * Generate + upload on-brand hero (still) and corpus (looping video) media.
 * `primaryHex` steers the palette; `subject`/`domain` keep prompts on-topic
 * without hardcoding any one customer. Returns the R2 URLs (and a local poster
 * to stage) — or an empty object if anything fails (caller falls back).
 */
export async function generateBrandMedia(
  workDir: string,
  prospect: string,
  opts: { primaryHex?: string; accentHex?: string; subject?: string; productName?: string },
): Promise<GeneratedBrandMedia> {
  const navy = opts.primaryHex ?? "#172e47";
  const accent = opts.accentHex ?? navy;
  const subject = opts.subject ?? "the organization's field of expertise";
  const heroPng = join(workDir, "_gen-hero.png");
  const corpusPng = join(workDir, "_gen-corpus.png");
  const corpusMp4 = join(workDir, "_gen-corpus.mp4");
  const heroWebp = join(workDir, "_gen-hero.webp");
  const corpusWebm = join(workDir, "_gen-corpus.webm");
  const corpusPoster = join(workDir, "corpus-poster.jpg"); // staged into landing/brand/

  try {
    // The Gemini API path authenticates per-request with the key, so don't
    // shell out to gcloud (which would fail on a machine with no gcloud).
    const token = usingGeminiApi() ? "" : await vertexToken();

    // IMPORTANT: the hero renders as a faint object-contain BACKGROUND behind a
    // glass chat panel on a CREAM section — so the image MUST be light/high-key
    // with a near-white background, never a dark slab (a dark bg becomes a heavy
    // block that kills the chat's contrast). Brand color lives in the subject's
    // linework/forms, not the background.
    // The hero art is used as a heavily-blurred, low-opacity full-bleed AMBIENT
    // background — so we want soft abstract edge-to-edge texture (gentle gradient
    // washes, flowing organic forms) in the brand color, NOT a centered literal
    // subject (which crops awkwardly and reads as "random AI art" behind a card).
    // Hero = a RECOGNIZABLE, lightly-faded line-art illustration (drfuhrman style),
    // shown with little/no blur and an open center — NOT a heavy abstract blur. The
    // motifs evoke the business; brand colors only; near-white so it sits behind text.
    const heroPrompt = `Elegant, detailed line-art illustration in a refined vintage engraving / botanical-plate style for ${opts.productName ?? "a premium brand"}, arranged as a graceful ARCH or WREATH of motifs that frame a LARGE OPEN, EMPTY central space (negative space for headline text). The motifs must clearly and recognizably evoke ${subject} — fine line drawings of that field's signature subjects, tools, and activities. Delicate thin strokes drawn ONLY in the brand colors ${colorName(navy)} (${navy}) and ${colorName(accent)} (${accent}) on a NEAR-WHITE background — clearly tinted in those two colors, NOT pink, NOT warm, NOT grey. Light, airy, premium; a tasteful faded illustration that frames the page while the CENTER stays open and light. No solid fills, no heavy shading, no human faces, no text, no words, no logos, no watermark, light background.`;
    const corpusPrompt = `A premium abstract concept image for a knowledge base about ${subject}, 16:9. Softly glowing translucent document cards and clean pages floating in shallow 3D, connected by thin elegant light lines suggesting an AI knowledge graph, deep brand color ${navy} background with calm accents and warm highlights, depth and negative space, modern editorial aesthetic, trustworthy and calm. No readable text, no logos, no watermark.`;
    const motion = "Very slow, gentle, looping motion: the translucent cards softly drift and breathe in shallow 3D parallax, thin light lines subtly pulse and travel, faint particles float. Calm, premium, professional, minimal camera drift. No text appearing, no people.";

    // The HERO is the load-bearing asset: without it the page falls back to
    // the template's stock hero, which literally renders the words "Acme
    // Expert AI" over a prospect's branded page. The corpus VIDEO is a nicety.
    // They used to share one try-block, so a video failure (e.g. Veo rejecting
    // an unsupported parameter) threw away a perfectly good hero and shipped
    // the Acme placeholder. Generate the hero first and commit it on its own.
    await imagen(token, heroPrompt, "16:9", heroPng);
    execFileSync("cwebp", ["-q", "82", heroPng, "-o", heroWebp], { stdio: "ignore" });
    r2Put(heroWebp, `${prospect}/hero.webp`, "image/webp");
    const heroImageUrl = `${R2_PUBLIC_BASE()}/${prospect}/hero.webp`;

    let corpusVideoUrl: string | undefined;
    let corpusPosterOut: string | undefined;
    try {
      await imagen(token, corpusPrompt, "16:9", corpusPng);
      await veoFromImage(token, corpusPng, motion, corpusMp4);
      execFileSync("ffmpeg", ["-y", "-i", corpusMp4, "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "34", "-an", "-row-mt", "1", "-pix_fmt", "yuv420p", corpusWebm], { stdio: "ignore" });
      execFileSync("ffmpeg", ["-y", "-i", corpusMp4, "-frames:v", "1", "-q:v", "3", corpusPoster], { stdio: "ignore" });
      r2Put(corpusMp4, `${prospect}/corpus.mp4`, "video/mp4");
      r2Put(corpusWebm, `${prospect}/corpus.webm`, "video/webm");
      corpusVideoUrl = `${R2_PUBLIC_BASE()}/${prospect}/corpus.mp4`;
      corpusPosterOut = corpusPoster;
    } catch (e) {
      console.warn(`[brand-media] corpus video skipped (hero KEPT) — ${(e as Error).message.split("\n")[0]}`);
    }

    // Feature-section videos (drfuhrman-style): native mobile app w/ photo
    // recognition (multimodal) + an on-device/offline clip.
    const { mobileAppVideo, offlineVideo } = await generateFeatureVideos(workDir, prospect, { primaryHex: navy, subject }, token);

    return {
      heroImageUrl,
      corpusVideoUrl,
      corpusPosterPath: corpusPosterOut,
      mobileAppVideo,
      offlineVideo,
    };
  } catch (err) {
    console.warn(`[brand-media] generation skipped — ${(err as Error).message.split("\n")[0]}`);
    return {};
  }
}
