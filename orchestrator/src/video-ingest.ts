/**
 * Video → RAG ingestion (v0, YouTube via yt-dlp).
 *
 * Decision tree per video:
 *   1. Captions exist (human or auto)?  → pull them with yt-dlp
 *      (--skip-download, zero media transfer), clean the VTT, and upload a
 *      markdown transcript with full source metadata. Free + instant — this
 *      covers the single-speaker / talking-head case programmatically.
 *   2. No captions?                     → extract audio (yt-dlp -x m4a) and
 *      `divinci rag upload` it — the platform's Whisper stack transcribes
 *      server-side (`--language` hint supported).
 *   3. Multi-speaker (podcast/interview, `speakers: "multi"` on the source)
 *      and no captions? → same audio upload; NOTE: diarization runs through
 *      the platform's audio-transcript data source (pyannote), which `rag
 *      upload` does not trigger yet (platform wiring is incomplete).
 *
 * Every transcript carries YAML front-matter linking back to the original
 * video (url, title, channel, published, duration) and inline [t=XXs]
 * markers every ~60s so chunk citations can deep-link with &t=XXs.
 *
 * CLI:
 *   npm run video -- --url <video-or-playlist> --vector <id> --workspace <id>
 *                    [--speakers multi] [--language en] [--limit 10] [--dry-run]
 *
 * Manifest integration: sources with `type: "video"` route here from the
 * ingest step; `crawl.limit` caps playlist entries against the page budget.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const execFileP = promisify(execFile);

export interface VideoMeta {
  id: string;
  title: string;
  channel: string;
  upload_date?: string; // YYYYMMDD
  duration?: number; // seconds
  webpage_url: string;
}

export interface VideoIngestOpts {
  speakers?: "single" | "multi";
  language?: string;
  /** Max playlist entries to process. */
  limit?: number;
  /** Write the transcript file but skip the divinci upload. */
  dryRun?: boolean;
  workspace?: string;
}

export interface VideoIngestResult {
  url: string;
  videoId: string;
  title: string;
  method: "captions" | "audio-upload" | "skipped";
  file?: string;
  note?: string;
}

async function ytdlp(args: string[], timeoutMs = 120_000): Promise<string> {
  const { stdout } = await execFileP("yt-dlp", args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/** Expand a playlist/channel URL into individual video URLs (or [url] if single). */
export async function expandVideoUrls(url: string, limit = 25): Promise<string[]> {
  // A watch/youtu.be link is ONE video even when it carries a &list= param
  // (URLs copied from a playlist context) — expanding it would pull the whole
  // playlist past what Gate 1 reviewed. Only true playlist/channel URLs expand.
  if (/youtube\.com\/watch\?|youtu\.be\//.test(url)) return [url];
  const out = await ytdlp(["--flat-playlist", "--dump-json", "--playlist-end", String(limit), url]);
  const urls = out
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const j = JSON.parse(line) as { url?: string; id?: string; webpage_url?: string };
      return j.webpage_url ?? j.url ?? (j.id ? `https://www.youtube.com/watch?v=${j.id}` : null);
    })
    .filter((u): u is string => !!u);
  return urls.length ? urls : [url];
}

export async function fetchMeta(url: string): Promise<VideoMeta> {
  const out = await ytdlp(["--dump-json", "--skip-download", "--no-playlist", url]);
  const j = JSON.parse(out) as VideoMeta & Record<string, unknown>;
  return {
    id: j.id,
    title: j.title,
    channel: (j as { channel?: string; uploader?: string }).channel ?? (j as { uploader?: string }).uploader ?? "unknown",
    upload_date: j.upload_date,
    duration: j.duration,
    webpage_url: j.webpage_url ?? url,
  };
}

/**
 * Clean a VTT caption file into prose with [t=XXs] markers.
 * Auto-captions repeat rolling lines — dedupe consecutive duplicates.
 */
export function vttToTranscript(vtt: string, markerEverySec = 60): string {
  const lines = vtt.split("\n");
  const out: string[] = [];
  let lastText = "";
  let lastMarker = -markerEverySec;
  let currentSec = 0;

  for (const line of lines) {
    // WebVTT hours component is OPTIONAL (MM:SS.mmm is valid) — YouTube
    // always emits hours, but don't lose all [t=] markers on files that don't.
    const ts = line.match(/^(?:(\d{2,}):)?(\d{2}):(\d{2})\.\d{3}\s+-->/);
    if (ts) {
      currentSec = Number(ts[1] ?? 0) * 3600 + Number(ts[2]) * 60 + Number(ts[3]);
      continue;
    }
    if (!line.trim() || /^(WEBVTT|Kind:|Language:|NOTE)/.test(line) || /^\d+$/.test(line.trim())) continue;
    const text = line
      .replace(/<[^>]+>/g, "") // strip cue tags
      .replace(/&amp;/g, "&")
      .replace(/&gt;/g, ">")
      .replace(/&lt;/g, "<")
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&nbsp;/g, " ")
      .trim();
    if (!text || text === lastText) continue;
    if (currentSec - lastMarker >= markerEverySec) {
      out.push(`\n[t=${currentSec}s]`);
      lastMarker = currentSec;
    }
    out.push(text);
    lastText = text;
  }
  return out.join(" ").replace(/\s*\n\s*/g, "\n").trim();
}

function frontMatter(meta: VideoMeta, transcriptSource: string): string {
  const published = meta.upload_date
    ? `${meta.upload_date.slice(0, 4)}-${meta.upload_date.slice(4, 6)}-${meta.upload_date.slice(6, 8)}`
    : "unknown";
  return [
    "---",
    `source_url: ${meta.webpage_url}`,
    `video_title: "${meta.title.replace(/"/g, "'")}"`,
    `channel: "${meta.channel.replace(/"/g, "'")}"`,
    `published: ${published}`,
    `duration_seconds: ${meta.duration ?? "unknown"}`,
    `transcript_source: ${transcriptSource}`,
    "---",
    "",
    `# ${meta.title}`,
    "",
    `> Video transcript — ${meta.channel}, ${published}. Source: ${meta.webpage_url}`,
    "",
  ].join("\n");
}

/** Try the captions path; returns the transcript file path or null. */
async function tryCaptions(url: string, meta: VideoMeta, workDir: string, language = "en"): Promise<string | null> {
  await ytdlp([
    "--skip-download",
    "--write-subs",
    "--write-auto-subs",
    "--sub-langs",
    `${language}.*,${language}`,
    "--sub-format",
    "vtt",
    "--no-playlist",
    "-o",
    join(workDir, "%(id)s"),
    url,
  ]).catch(() => "");
  const vttFile = readdirSync(workDir).find((f) => f.startsWith(meta.id) && f.endsWith(".vtt"));
  if (!vttFile) return null;

  const transcript = vttToTranscript(readFileSync(join(workDir, vttFile), "utf8"));
  if (transcript.length < 200) return null; // captions exist but are junk

  const outPath = join(workDir, `${meta.id}.transcript.md`);
  writeFileSync(outPath, frontMatter(meta, "youtube-captions") + transcript + "\n");
  return outPath;
}

async function extractAudio(url: string, meta: VideoMeta, workDir: string): Promise<string> {
  await ytdlp(
    ["-x", "--audio-format", "m4a", "--no-playlist", "-o", join(workDir, "%(id)s.%(ext)s"), url],
    15 * 60 * 1000
  );
  const audio = readdirSync(workDir).find((f) => f.startsWith(meta.id) && f.endsWith(".m4a"));
  if (!audio) throw new Error(`yt-dlp produced no audio for ${url}`);
  return join(workDir, audio);
}

async function ragUpload(file: string, meta: VideoMeta, vectorId: string, opts: VideoIngestOpts): Promise<void> {
  const args = [
    "rag",
    "upload",
    file,
    "--targets",
    vectorId,
    "--title",
    meta.title,
    "--description",
    `YouTube — ${meta.channel} — ${meta.webpage_url}`,
  ];
  if (opts.language) args.push("--language", opts.language);
  if (opts.workspace) args.push("--workspace", opts.workspace);
  await execFileP("divinci", args, { timeout: 10 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 });
}

export async function ingestVideo(url: string, vectorId: string, opts: VideoIngestOpts = {}): Promise<VideoIngestResult> {
  const workDir = join(tmpdir(), "divinci-video-ingest");
  if (!existsSync(workDir)) mkdirSync(workDir, { recursive: true });

  const meta = await fetchMeta(url);

  // Path 1: captions (free, programmatic — the single-speaker fast path)
  const transcriptFile = await tryCaptions(url, meta, workDir, opts.language ?? "en");
  if (transcriptFile) {
    if (!opts.dryRun) {
      await ragUpload(transcriptFile, meta, vectorId, opts);
      cleanup(workDir, meta.id);
    }
    return { url, videoId: meta.id, title: meta.title, method: "captions", file: transcriptFile };
  }

  // Path 2: no captions → audio upload, platform Whisper transcribes.
  // Multi-speaker diarization needs the audio-transcript data source.
  const note =
    opts.speakers === "multi"
      ? "multi-speaker: uploaded as audio; route through the audio-transcript data source for pyannote diarization"
      : undefined;
  const audioFile = await extractAudio(url, meta, workDir);
  if (!opts.dryRun) {
    await ragUpload(audioFile, meta, vectorId, opts);
    cleanup(workDir, meta.id);
  }
  return { url, videoId: meta.id, title: meta.title, method: "audio-upload", file: audioFile, note };
}

/** Remove this video's working files after a successful upload (audio can be 100MB+). */
function cleanup(workDir: string, videoId: string): void {
  for (const f of readdirSync(workDir)) {
    if (f.startsWith(videoId)) {
      try {
        rmSync(join(workDir, f));
      } catch {
        /* best effort */
      }
    }
  }
}

// ---------------------------------------------------------------- CLI entry
const isMain = process.argv[1]?.endsWith("video-ingest.ts");
if (isMain) {
  const args: Record<string, string> = {};
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith("--")) args[a.slice(2)] = process.argv[i + 1]?.startsWith("--") ? "true" : (process.argv[++i] ?? "true");
  }
  const { url, vector, workspace } = args;
  if (!url || (!vector && args["dry-run"] === undefined)) {
    console.error("usage: npm run video -- --url <u> --vector <id> --workspace <id> [--speakers multi] [--language en] [--limit 10] [--dry-run]");
    process.exit(1);
  }
  const opts: VideoIngestOpts = {
    speakers: args.speakers === "multi" ? "multi" : "single",
    language: args.language,
    dryRun: "dry-run" in args,
    workspace,
    limit: args.limit ? Number(args.limit) : 10,
  };
  const main = async () => {
    const urls = await expandVideoUrls(url, opts.limit);
    console.log(`${urls.length} video(s) to ingest`);
    for (const u of urls) {
      try {
        const r = await ingestVideo(u, vector, opts);
        console.log(`✓ [${r.method}] ${r.title}${r.note ? ` — ${r.note}` : ""}${opts.dryRun ? ` → ${r.file}` : ""}`);
      } catch (err) {
        console.error(`✗ ${u}: ${(err as Error).message.split("\n")[0]}`);
      }
    }
  };
  void main();
}
