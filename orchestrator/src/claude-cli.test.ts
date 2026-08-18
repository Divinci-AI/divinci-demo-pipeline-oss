import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeArgs, DISALLOWED_TOOLS, runClaude } from "./claude-cli.js";

const srcDir = dirname(fileURLToPath(import.meta.url));

describe("claudeArgs", () => {
  it("loads NO MCP servers", () => {
    // Without --strict-mcp-config the subprocess inherits the machine's whole
    // MCP config — here Gmail, Slack, Attio, HubSpot, Brex and Gusto. Prompts
    // in this pipeline contain text scraped from strangers' websites, so that
    // path ends in an agent holding email, CRM and banking tools.
    const args = claudeArgs();
    expect(args).toContain("--strict-mcp-config");
    // ...and no --mcp-config is passed, so "only those" means none.
    expect(args).not.toContain("--mcp-config");
  });

  it("disallows every built-in that can act", () => {
    const args = claudeArgs();
    expect(args).toContain("--disallowedTools");
    for (const tool of ["Bash", "Write", "Edit", "WebFetch", "WebSearch"])
      expect(DISALLOWED_TOOLS).toContain(tool);
  });

  it("puts --disallowedTools LAST, since it is variadic", () => {
    // A trailing prompt argument would be parsed as a tool name — observed as
    // "Permission deny rule 'Reply' matches no known tool". The prompt must go
    // over stdin, which is why nothing follows the tool list.
    const args = claudeArgs();
    expect(args[args.length - DISALLOWED_TOOLS.length - 1]).toBe("--disallowedTools");
    expect(args).not.toContain("-p".repeat(2));
    expect(args[0]).toBe("-p");
  });
});

describe("no generator bypasses the hardened invoker", () => {
  it("has no raw claude invocation outside claude-cli.ts", () => {
    // A new generator that shells out directly would silently regain the full
    // MCP surface. This is the guard against that.
    const offenders: string[] = [];
    for (const file of readdirSync(srcDir)) {
      if (!file.endsWith(".ts") || file === "claude-cli.ts" || file.endsWith(".test.ts")) continue;
      const src = readFileSync(join(srcDir, file), "utf8");
      if (/execFile(Sync)?P?\(\s*"claude"/.test(src)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("every module that generates text imports runClaude", () => {
    for (const file of ["qa-suite-gen.ts", "outreach-assets.ts", "intake.ts", "copy-gen.ts"]) {
      const src = readFileSync(join(srcDir, file), "utf8");
      expect(src, `${file} should use the hardened invoker`).toMatch(/from "\.\/claude-cli\.js"/);
    }
  });
});

describe("runClaude", () => {
  it("rejects with the stderr tail when claude exits non-zero", async () => {
    // Uses a prompt that cannot succeed only if claude is absent; assert the
    // shape of failure handling rather than invoking the real CLI.
    await expect(runClaude("x", { timeoutMs: 1 })).rejects.toThrow(/claude -p failed/);
  }, 20_000);
});
