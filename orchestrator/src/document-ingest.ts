/**
 * document-ingest.ts — put a prospect's own published PDFs/Office files into
 * the demo corpus.
 *
 * WHY THIS EXISTS. A crawl walks HTML links; it never opens the PDF behind
 * one. So until 2026-08-27 every demo built by this pipeline was text-only by
 * construction, no matter what the site published. The recon HAD been finding
 * the files all along and reporting them as a count nobody could act on
 * (`- linked documents (PDF/Office): 2`).
 *
 * The cost of that, measured on bermanmedicallasers.com: the server's own
 * self-serve scan of the same site ingested nine eBooks and flipbooks — the
 * best material the company publishes — while this pipeline's demo, built the
 * day before, held web pages only. Two assistants for one site, and the one
 * we sent was the weaker.
 *
 * Upload, not crawl: `divinci rag upload` hands the file to the server's
 * document chunker, which is what understands a PDF.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const execFileP = promisify(execFile);

/** Hard ceiling on one download. A 60 MB PDF is a scanned archive, not knowledge. */
export const MAX_DOCUMENT_BYTES = 60 * 1024 * 1024;

const FETCH_TIMEOUT_MS = 60_000;
const UPLOAD_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * A real browser UA.
 *
 * Same reason `agent_http` sets one in the monorepo: a default Node UA is
 * refused outright by a lot of WAFs, and the refusal arrives as an HTML page
 * with a 200 — i.e. as a "document" we would happily ingest.
 */
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36 DivinciDemoFactory/1.0";

export interface DocumentIngestOpts {
  workspace?: string;
  profile?: string;
  dryRun?: boolean;
  /** Title for the RAG file; defaults to the filename. */
  title?: string;
}

export interface DocumentIngestResult {
  url: string;
  file: string;
  title: string;
  bytes: number;
}

/** Filename from a URL, sanitized for the filesystem and for a title. */
export function documentFileName(url: string): string {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    /* fall through — treat the whole string as a path */
  }
  const base = decodeURIComponent(path.split("/").filter(Boolean).pop() ?? "document");
  const safe = base.replace(/[^\w.\-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe.length >= 3 ? safe.slice(0, 120) : "document";
}

/**
 * Give a name an extension, taken from the BYTES.
 *
 * The server picks a chunker by file extension, so a name with none ("…/download",
 * "…/view?id=7") reaches it as an unknown blob. The magic bytes have already
 * been verified by `looksLikeDocument` at this point, so the type is known for
 * real — which is strictly better than trusting the URL, since the URLs that
 * lack an extension are exactly the ones that are routed rather than static.
 */
export function ensureExtension(name: string, head: Buffer): string {
  if (/\.[a-z0-9]{2,5}$/i.test(name)) return name;
  const magic = head.subarray(0, 8);
  if (magic.subarray(0, 4).toString("latin1") === "%PDF") return `${name}.pdf`;
  // OOXML is a zip; without unzipping we cannot tell docx from xlsx/pptx, and
  // docx is what a published document overwhelmingly is.
  if (magic.subarray(0, 2).toString("latin1") === "PK") return `${name}.docx`;
  if (magic.subarray(0, 4).toString("hex") === "d0cf11e0") return `${name}.doc`;
  if (magic.subarray(0, 5).toString("latin1") === "{\\rtf") return `${name}.rtf`;
  return `${name}.txt`;
}

/**
 * Is this actually the document it claimed to be?
 *
 * THE FAILURE THIS EXISTS FOR: a dead `.pdf` link commonly answers **200 with
 * an HTML page** — a themed 404, a login wall, a bot interstitial. Uploading
 * that puts "Page Not Found — Berman Medical Lasers" into the corpus as a
 * document, where it is indistinguishable from content and answers questions
 * with nothing. Nothing downstream would ever flag it: the ingest succeeds,
 * the chunk count goes up, and coverage improves.
 *
 * So the bytes are checked, not the extension and not the content-type header
 * (a misconfigured server sends `application/octet-stream` for everything, and
 * a WAF sends `text/html` for a file that is fine behind it).
 */
export function looksLikeDocument(head: Buffer, contentType: string | null): { ok: true } | { ok: false; reason: string } {
  const magic = head.subarray(0, 8);
  if (magic.subarray(0, 4).toString("latin1") === "%PDF") return { ok: true };
  // OOXML (docx/xlsx/pptx) is a zip; legacy Office is OLE2.
  if (magic.subarray(0, 2).toString("latin1") === "PK") return { ok: true };
  if (magic.subarray(0, 4).toString("hex") === "d0cf11e0") return { ok: true };
  if (magic.subarray(0, 5).toString("latin1") === "{\\rtf") return { ok: true };

  const sniff = head.subarray(0, 512).toString("latin1").trimStart().toLowerCase();
  if (sniff.startsWith("<!doctype html") || sniff.startsWith("<html") || sniff.includes("<head"))
    return { ok: false, reason: "served an HTML page, not a document (dead link, login wall or bot interstitial)" };

  const type = (contentType ?? "").toLowerCase();
  if (type.includes("text/html"))
    return { ok: false, reason: `content-type is ${contentType}` };
  // Plain text and CSV are legitimately ingestible and have no magic bytes.
  if (type.startsWith("text/") || type.includes("json") || type.includes("csv")) return { ok: true };

  return { ok: false, reason: `unrecognized content (content-type: ${contentType ?? "none"})` };
}

/**
 * Download one document and upload it into a RAG vector.
 *
 * Throws on anything that would put junk in the corpus — a refused download, a
 * too-large file, an HTML page wearing a `.pdf` extension. The caller decides
 * whether one bad document should stop the run (it should not; see run.ts).
 */
export async function ingestDocument(
  url: string,
  vectorId: string,
  opts: DocumentIngestOpts = {},
): Promise<DocumentIngestResult> {
  const workDir = join(tmpdir(), "divinci-document-ingest");
  if (!existsSync(workDir)) mkdirSync(workDir, { recursive: true });

  const name = documentFileName(url);
  const title = opts.title ?? name;

  const resp = await fetch(url, {
    redirect: "follow",
    headers: { "user-agent": UA, accept: "*/*" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`download failed: HTTP ${resp.status}`);

  // Trust the header only as an EARLY out. The body is checked below either
  // way — a server that lies about the length also lies about the type.
  const declared = Number(resp.headers.get("content-length") ?? 0);
  if (declared > MAX_DOCUMENT_BYTES)
    throw new Error(`document is ${Math.round(declared / 1024 / 1024)}MB — over the ${MAX_DOCUMENT_BYTES / 1024 / 1024}MB cap`);

  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.byteLength === 0) throw new Error("download was empty");
  if (buf.byteLength > MAX_DOCUMENT_BYTES)
    throw new Error(`document is ${Math.round(buf.byteLength / 1024 / 1024)}MB — over the ${MAX_DOCUMENT_BYTES / 1024 / 1024}MB cap`);

  const verdict = looksLikeDocument(buf, resp.headers.get("content-type"));
  if (!verdict.ok) throw new Error(verdict.reason);

  if (opts.dryRun) return { url, file: `${workDir}/${name}`, title, bytes: buf.byteLength };

  const file = join(workDir, `${Date.now()}-${ensureExtension(name, buf)}`);
  writeFileSync(file, buf);
  try {
    const args = [
      "rag", "upload", file,
      "--targets", vectorId,
      "--title", title,
      // The backlink is the whole reason a reader can check a cited claim.
      "--description", `Published by the prospect — ${url}`,
      "--wait", "--poll-interval", "10",
    ];
    if (opts.workspace) args.push("--workspace", opts.workspace);
    if (opts.profile) args.push("--profile", opts.profile);
    await execFileP("divinci", args, { timeout: UPLOAD_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 });
  } finally {
    // Never leave a 60MB PDF in tmp — the video lane learned this the same way.
    rmSync(file, { force: true });
  }

  return { url, file, title, bytes: buf.byteLength };
}
