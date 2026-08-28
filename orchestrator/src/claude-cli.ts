/**
 * Locked-down `claude -p` invocation.
 *
 * WHY. Every generator in this pipeline builds a prompt containing text scraped
 * from a stranger's website and hands it to `claude -p`. By default that
 * subprocess inherits the machine's ENTIRE MCP configuration — on this laptop
 * that is Gmail, Slack, Attio, HubSpot, Google Drive, Zoom, Buffer, Brex and
 * Gusto. So the untrusted-input path terminated in an agent holding tools for
 * email, CRM, banking and payroll.
 *
 * Exploiting that from a crawled page is not trivial — headless mode cannot
 * answer a permission prompt — but the mitigation costs nothing and the
 * exposure needs no argument: these calls are pure text transformations. They
 * need no MCP server, no filesystem, and no network.
 *
 *   --strict-mcp-config   load ONLY servers passed via --mcp-config. We pass
 *                         none, so: zero MCP servers.
 *   --disallowedTools     belt and braces on the built-ins that could act.
 *
 * The prompt goes over STDIN rather than argv. --disallowedTools is variadic,
 * so a trailing prompt argument gets parsed as a tool name (observed: "Permission
 * deny rule 'Reply' matches no known tool"), and stdin also sidesteps ARG_MAX
 * for the larger prompts.
 */
import { execFile, execFileSync } from "node:child_process";

/** Built-ins with side effects. The generators need none of them. */
export const DISALLOWED_TOOLS = [
  "Bash",
  "Write",
  "Edit",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Task",
];

export function claudeArgs(): string[] {
  return ["-p", "--strict-mcp-config", "--disallowedTools", ...DISALLOWED_TOOLS];
}

/**
 * Tools withheld even from the web-enabled call. Everything above except the
 * two read-only web tools — so a page cannot get the model to write a file,
 * run a command, or reach an MCP server.
 */
export const DISALLOWED_TOOLS_WEB = DISALLOWED_TOOLS.filter(
  (t) => t !== "WebSearch" && t !== "WebFetch",
);

/**
 * `claude -p` WITH read-only web access. Use this for DISCOVERY ONLY.
 *
 * The lockdown above exists because every *generator* builds a prompt out of
 * text scraped from a stranger's website, so the untrusted-input path must not
 * terminate in an agent holding tools. Discovery is the one caller that is not
 * on that path: its prompt is our rubric, our own queue (names and hosts only)
 * and our clusters. Nothing a stranger wrote goes in.
 *
 * What changes is that untrusted text now comes OUT of the web tools and into
 * the model's context, so the exposure is prompt injection from a page. Three
 * things bound it:
 *
 *   1. `--strict-mcp-config` still loads ZERO MCP servers. Gmail, Slack, Attio,
 *      HubSpot, Drive, Zoom, Buffer, Brex and Gusto remain unreachable. This is
 *      the control that actually matters and it is unchanged.
 *   2. Bash / Write / Edit / NotebookEdit / Task remain denied, so the call can
 *      read the web and produce text, and can do nothing else.
 *   3. The caller must not let this call make a decision that matters. The
 *      compliance tier drives the assistant's guardrails AND its QA hazard set,
 *      so it is assigned by a separate TOOLLESS call from our own rubric. See
 *      discover-web.ts — the split is the point, not an implementation detail.
 *
 * `--allowedTools` is required, not optional: headless mode cannot answer a
 * permission prompt, so without it WebSearch is silently refused and the model
 * answers from memory while sounding confident ("unverified — grant WebSearch
 * access if you want me to confirm"). That failure mode returns plausible
 * results with no web access at all, which is worse than an error.
 */
export function claudeWebArgs(): string[] {
  return [
    "-p",
    "--strict-mcp-config",
    "--allowedTools",
    "WebSearch",
    "WebFetch",
    "--disallowedTools",
    ...DISALLOWED_TOOLS_WEB,
  ];
}

export interface ClaudeOpts {
  timeoutMs?: number;
  maxBuffer?: number;
}

/**
 * Run a prompt through `claude -p` with no tools and no MCP servers.
 * Returns trimmed stdout; rejects on a non-zero exit.
 */
/** Synchronous variant, for callers that are themselves synchronous. */
export function runClaudeSync(prompt: string, opts: ClaudeOpts = {}): string {
  return String(
    execFileSync("claude", claudeArgs(), {
      input: prompt,
      encoding: "utf8",
      timeout: opts.timeoutMs ?? 5 * 60 * 1000,
      maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
      stdio: ["pipe", "pipe", "ignore"],
    }),
  ).trim();
}

export function runClaudeWithWeb(prompt: string, opts: ClaudeOpts = {}): Promise<string> {
  return runClaudeArgv(claudeWebArgs(), prompt, opts);
}

export function runClaude(prompt: string, opts: ClaudeOpts = {}): Promise<string> {
  return runClaudeArgv(claudeArgs(), prompt, opts);
}

function runClaudeArgv(argv: string[], prompt: string, opts: ClaudeOpts = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "claude",
      argv,
      { timeout: opts.timeoutMs ?? 6 * 60 * 1000, maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`claude -p failed: ${err.message}\n${String(stderr).slice(0, 500)}`));
          return;
        }
        resolve(String(stdout).trim());
      },
    );
    child.stdin?.end(prompt);
  });
}
