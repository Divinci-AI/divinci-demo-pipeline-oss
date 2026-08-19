import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface CliResult {
  raw: string;
  json?: unknown;
}

export interface CliOpts {
  workspace?: string;
  profile?: string;
  json?: boolean;
  timeoutMs?: number;
}

/**
 * Run a divinci CLI command. Output parsing is defensive: spinner/progress
 * lines may precede the payload, and some commands' --json output is
 * unreliable (e.g. `workspace list` currently prints "undefined"), so we
 * return the raw text alongside any JSON we managed to parse.
 */
/** Dry-run: stub every divinci CLI call with a canned result so the pipeline
 *  can be exercised end-to-end offline (no spend, no real workspace/release). */
export const DRY_RUN = process.env.DRY_RUN === "1";

let dryCounter = 0;
function dryResult(args: string[]): CliResult {
  // Hand back a fake 24-hex ObjectId so id-extracting steps (workspace/vector
  // create) proceed; carry the command in raw for log visibility.
  const fakeId = (dryCounter++).toString(16).padStart(24, "a");
  return { raw: `[dry-run] divinci ${args.join(" ")}`, json: { _id: fakeId, id: fakeId, status: "ok" } };
}

export async function dv(args: string[], opts: CliOpts = {}): Promise<CliResult> {
  if (DRY_RUN) {
    console.log(`[dry-run] divinci ${args.slice(0, 3).join(" ")}…`);
    return dryResult(args);
  }
  // NEVER pass --quiet with --json: the CLI's formatter returns early in
  // quiet mode and swallows the JSON payload entirely (formatter.ts:
  // `if (quietMode) return`). Discovered on the maiden run.
  const full = [...args, "--no-color"];
  if (opts.json !== false) full.push("--json");
  if (opts.workspace) full.push("--workspace", opts.workspace);
  if (opts.profile) full.push("--profile", opts.profile);

  const { stdout, stderr } = await execFileP("divinci", full, {
    timeout: opts.timeoutMs ?? 10 * 60 * 1000,
    maxBuffer: 32 * 1024 * 1024,
  }).catch((err: Error & { stdout?: string; stderr?: string }) => {
    throw new Error(
      `divinci ${args.join(" ")} failed: ${err.message}\n${err.stderr ?? ""}\n${err.stdout ?? ""}`
    );
  });

  const raw = `${stdout}\n${stderr}`.trim();
  return { raw, json: tryParseJson(stdout) };
}

function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  for (const candidate of [trimmed, ...jsonLooking(trimmed)]) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed !== null && typeof parsed === "object") return parsed;
    } catch {
      /* keep trying */
    }
  }
  return undefined;
}

function* jsonLooking(text: string): Generator<string> {
  for (const open of ["{", "["]) {
    const start = text.indexOf(open);
    if (start >= 0) yield text.slice(start);
  }
}

/** Pull a Mongo ObjectId out of CLI output when JSON parsing fails. */
/**
 * Best-effort count of indexed files in a workspace's RAG (0 on any failure).
 * Used to detect partial-success crawls: a multi-page crawl often indexes most
 * pages before a failed seed/JS page makes the CLI exit non-zero.
 */
/**
 * Parse a JSON array out of a CLI result.
 *
 * Prefers `res.json`, which tryParseJson() derived from STDOUT ALONE. Slicing
 * `res.raw` is the trap: raw is `stdout + "\n" + stderr`, so any spinner line
 * or warning on stderr lands AFTER the closing bracket and JSON.parse dies with
 * "Unexpected non-whitespace character after JSON at position …". That is not
 * hypothetical — it is why Acme Incubator generated its QA suite with no corpus brief,
 * and (much worse) why ragFileCount reported 0.
 */
export function parseJsonArray(res: CliResult): unknown[] | undefined {
  if (Array.isArray(res.json)) return res.json;
  const start = res.raw.indexOf("[");
  if (start < 0) return undefined;
  // Walk back from the last ']' so a stderr tail cannot break the parse.
  const end = res.raw.lastIndexOf("]");
  if (end > start) {
    try {
      const arr = JSON.parse(res.raw.slice(start, end + 1));
      if (Array.isArray(arr)) return arr;
    } catch {
      /* fall through */
    }
  }
  try {
    const arr = JSON.parse(res.raw.slice(start));
    return Array.isArray(arr) ? arr : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Count indexed files in a workspace's RAG.
 *
 * Returns `undefined` when the count could not be determined — deliberately NOT
 * 0. The old version swallowed every failure into 0, which made "the corpus is
 * empty" and "I could not read the response" indistinguishable. Callers use
 * this to decide whether a timed-out crawl still produced a usable corpus, so
 * that conflation turned an unreadable response into "nothing was indexed" and
 * threw away a perfectly good crawl.
 */
export async function ragFileCount(workspaceId: string, profile?: string): Promise<number | undefined> {
  try {
    const res = await dv(["rag", "files"], { workspace: workspaceId, profile });
    return parseJsonArray(res)?.length;
  } catch {
    return undefined;
  }
}

export function extractObjectId(raw: string): string | undefined {
  return raw.match(/\b[0-9a-f]{24}\b/)?.[0];
}

/**
 * Kill Switch Agent Guard check — called before every spend step.
 * Hard-fails when the guard is paused or its verdict escalates past "warn";
 * warns when `ks` is unavailable rather than silently skipping the check.
 *
 * Observed `ks guard status --json` shape (2026-06-10):
 *   { budget: {...}, dailyUSD, verdict: "ok"|"warn"|..., reasons: [],
 *     paused: bool, pauseUntil, sessions: [...] }
 */
export async function guardCheck(): Promise<void> {
  if (DRY_RUN) return; // no spend in dry-run → nothing to gate
  let status: { verdict?: string; paused?: boolean; reasons?: string[]; dailyUSD?: number };
  try {
    const { stdout } = await execFileP("ks", ["guard", "status", "--json"], {
      timeout: 30_000,
    });
    status = JSON.parse(stdout);
  } catch (err) {
    console.warn(
      `guard: WARNING — could not verify ks guard status (${(err as Error).message?.split("\n")[0]}); proceeding`
    );
    return;
  }
  const verdict = status.verdict ?? "unknown";
  if (status.paused === true || /block|halt|stop|hard/i.test(verdict)) {
    throw new Error(
      `ks guard refuses spend (verdict: ${verdict}${status.paused ? ", paused" : ""}): ` +
        `${(status.reasons ?? []).join("; ") || "no reason given"} — resolve via \`ks guard status\` / \`ks guard resume\``
    );
  }
  const daily = status.dailyUSD !== undefined ? ` (daily $${status.dailyUSD.toFixed(2)})` : "";
  if (verdict === "warn") console.warn(`guard: warn${daily} — ${(status.reasons ?? []).join("; ")}`);
  else console.log(`guard: ${verdict}${daily}`);
}
