// One-off: generate a faded, content-inspired ambient BACKGROUND image (Vertex
// Imagen) for a template-mode demo hero, convert to webp, upload to R2.
// Usage: tsx scripts/_genbg.mts <prospect> <key> "<prompt>"
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { uploadDemoAsset } from "../src/brand-media.js";
import { lazyEnv } from "../src/require-env.js";

const VERTEX_PROJECT = lazyEnv("VERTEX_PROJECT()", "the GCP project Vertex AI generation is billed to");
const VERTEX_LOCATION = process.env.VERTEX_LOCATION ?? "us-central1";
const IMAGE_MODEL = process.env.VERTEX_IMAGE_MODEL ?? "imagen-3.0-generate-002";

const [prospect, key, prompt] = process.argv.slice(2);
if (!prospect || !key || !prompt) throw new Error('usage: _genbg.mts <prospect> <key> "<prompt>"');

const token = execFileSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8" }).trim();
const url = `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT()}/locations/${VERTEX_LOCATION}/publishers/google/models/${IMAGE_MODEL}:predict`;
const res = await fetch(url, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    instances: [{ prompt }],
    parameters: { sampleCount: 1, aspectRatio: "16:9", personGeneration: "dont_allow", addWatermark: false, safetySetting: "block_few" },
  }),
});
if (!res.ok) throw new Error(`imagen ${res.status}: ${(await res.text()).slice(0, 300)}`);
const j = (await res.json()) as { predictions?: Array<{ bytesBase64Encoded?: string }> };
const b64 = j.predictions?.[0]?.bytesBase64Encoded;
if (!b64) throw new Error(`imagen returned no image: ${JSON.stringify(j).slice(0, 300)}`);

const png = join(tmpdir(), `${prospect}-${key}.png`);
const webp = join(tmpdir(), `${prospect}-${key}.webp`);
writeFileSync(png, Buffer.from(b64, "base64"));
execFileSync("cwebp", ["-q", "88", png, "-o", webp], { stdio: "ignore" });
const publicUrl = uploadDemoAsset(webp, `${prospect}/${key}.webp`, "image/webp");
console.log("UPLOADED:", publicUrl);
