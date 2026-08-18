import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wwwRagEnabled, resolveWwwRagToken } from "./www-rag.js";

/**
 * WWW-RAG contribution is a FIRST-CLASS pipeline step, not an opt-in.
 *
 * It shipped behind `WWW_RAG_SUBMIT=1`, and that variable was set nowhere. All
 * 58 runs logged the skip line and contributed nothing, leaving 51 of 83
 * crawled hosts absent from divinci.ai/www-rag. Both halves of that failure are
 * pinned here: the flag defaulting off, and the token being a hand-set env var
 * that would have skipped the step again even once the flag was flipped.
 */

const envKeys = ["WWW_RAG_SUBMIT", "WWW_RAG_TOKEN", "HOME"] as const;
let saved: Record<string, string | undefined>;
let home: string;

beforeEach(() => {
  saved = Object.fromEntries(envKeys.map((k) => [k, process.env[k]])) as Record<string, string | undefined>;
  home = mkdtempSync(join(tmpdir(), "wwwrag-"));
  process.env.HOME = home;
  delete process.env.WWW_RAG_TOKEN;
  delete process.env.WWW_RAG_SUBMIT;
});
afterEach(() => {
  for (const k of envKeys) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
  rmSync(home, { recursive: true, force: true });
});

function writeCreds(profiles: Record<string, unknown>): void {
  const dir = join(home, ".config", "divinci");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "credentials.json"), JSON.stringify({ profiles }));
}

const future = new Date(Date.now() + 86_400_000).toISOString();
const past = new Date(Date.now() - 86_400_000).toISOString();

describe("wwwRagEnabled", () => {
  it("is ON when nothing is set — the whole point of the change", () => {
    expect(wwwRagEnabled()).toBe(true);
  });

  it("stays on for any value except an explicit off", () => {
    for (const v of ["1", "true", "yes", ""]) {
      process.env.WWW_RAG_SUBMIT = v;
      expect(wwwRagEnabled(), `WWW_RAG_SUBMIT=${JSON.stringify(v)}`).toBe(true);
    }
  });

  it("honours an explicit off", () => {
    for (const v of ["0", "false"]) {
      process.env.WWW_RAG_SUBMIT = v;
      expect(wwwRagEnabled(), v).toBe(false);
    }
  });
});

describe("resolveWwwRagToken", () => {
  it("prefers WWW_RAG_TOKEN, so CI and a different identity still win", () => {
    writeCreds({ default: { accessToken: "from-cli", apiUrl: "https://api.divinci.app", expiresAt: future } });
    process.env.WWW_RAG_TOKEN = "from-env";
    expect(resolveWwwRagToken()).toBe("from-env");
  });

  it("falls back to the CLI's prod profile — no second credential to provision", () => {
    writeCreds({ default: { accessToken: "from-cli", apiUrl: "https://api.divinci.app", expiresAt: future } });
    expect(resolveWwwRagToken()).toBe("from-cli");
  });

  it("REFUSES a staging profile — the WWW-RAG corpus is production", () => {
    writeCreds({ default: { accessToken: "stage-tok", apiUrl: "https://api.stage.divinci.app", expiresAt: future } });
    expect(resolveWwwRagToken()).toBeUndefined();
  });

  it("REFUSES an expired token — otherwise every URL 401s and reads as a corpus refusal", () => {
    writeCreds({ default: { accessToken: "stale", apiUrl: "https://api.divinci.app", expiresAt: past } });
    expect(resolveWwwRagToken()).toBeUndefined();
  });

  it("falls through default → prod rather than stopping at an unusable default", () => {
    writeCreds({
      default: { accessToken: "stage-tok", apiUrl: "https://api.stage.divinci.app", expiresAt: future },
      prod: { accessToken: "prod-tok", apiUrl: "https://api.divinci.app", expiresAt: future },
    });
    expect(resolveWwwRagToken()).toBe("prod-tok");
  });

  it("returns undefined rather than throwing when credentials are missing or corrupt", () => {
    // The step is best-effort: a broken credentials file must skip the submit,
    // never fail the demo run around it.
    expect(resolveWwwRagToken()).toBeUndefined();
    const dir = join(home, ".config", "divinci");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "credentials.json"), "{not json");
    expect(resolveWwwRagToken()).toBeUndefined();
  });
});

/**
 * 423 handling (added 2026-08-14).
 *
 * A 423 means another crawl holds the lock. It was treated as a hard failure,
 * which cost 190 of 679 submissions (28%) across all runs — the URL was dropped
 * and only `wwwrag:backfill` recovered it, so the global corpus was complete
 * only when someone remembered to run the backfill.
 */
describe("423 is transient, not fatal", () => {
  it("is classified as a retryable outcome, not lumped into the error path", () => {
    // The distinction that matters: postSubmit must RETURN a locked status
    // rather than throw. A throw lands in the catch and is unretryable, which
    // is exactly the old behaviour.
    const src = readFileSync(new URL("./www-rag.ts", import.meta.url), "utf8");
    expect(src).toMatch(/res\.status === 423/);
    expect(src).toMatch(/status: "locked"/);
  });

  it("backs off LONGER than the pacing interval", () => {
    // MIN_INTERVAL_MS is paced against the rate LIMIT (10/min). The evidence
    // says the lock outlives it, so retrying at the same cadence would just
    // collide again.
    const src = readFileSync(new URL("./www-rag.ts", import.meta.url), "utf8");
    const backoff = /LOCK_BACKOFF_MS = \[([0-9_,\s]+)\]/.exec(src);
    expect(backoff, "LOCK_BACKOFF_MS must exist").toBeTruthy();
    const waits = backoff![1]!.split(",").map((s) => Number(s.trim().replace(/_/g, "")));
    expect(waits.length).toBeGreaterThanOrEqual(2);
    for (const w of waits) expect(w).toBeGreaterThan(7_000);
  });

  it("still records an exhausted retry as FAILED so the tally stays honest", () => {
    // Counting a still-locked URL as submitted would make the corpus look
    // complete when it is not — the same silent-success shape the backfill
    // summary already had once.
    const src = readFileSync(new URL("./www-rag.ts", import.meta.url), "utf8");
    expect(src).toMatch(/STILL LOCKED after/);
    expect(src).toMatch(/document is locked \(after retries\)/);
  });
});
