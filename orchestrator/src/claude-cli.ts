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

export function runClaude(prompt: string, opts: ClaudeOpts = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "claude",
      claudeArgs(),
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
