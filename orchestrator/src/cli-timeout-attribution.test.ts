import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * Guards a real misdiagnosis.
 *
 * Three ingest runs failed with exit 143 and were reported as `spawn ks
 * ENOENT` — read as a missing binary hard-blocking demo generation. It was the
 * CLI's own 10-minute timeout. Node's message for a `timeout` kill never
 * mentions the timeout, and the loop logs a failure as
 * `→ failed (exit N) — <last stderr line>`, so the cause was replaced by
 * whatever the CLI printed last. The ks advisory fires before every spend step,
 * so it was almost always the thing standing there.
 */

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: execFileMock }));
vi.mock("node:util", async (orig) => {
  const actual = await orig<typeof import("node:util")>();
  return { ...actual, promisify: () => execFileMock };
});

describe("a timeout kill names itself", () => {
  beforeEach(() => {
    vi.resetModules();
    execFileMock.mockReset();
    delete process.env.DRY_RUN;
  });
  afterEach(() => {
    delete process.env.DIVINCI_CLI_TIMEOUT_MS;
  });

  it("says TIMED OUT, not whatever the CLI printed last", async () => {
    const err = Object.assign(new Error("Command failed: divinci rag files"), {
      killed: true,
      signal: "SIGTERM" as const,
      // The exact stderr that got the blame in the real incident.
      stderr: "guard: WARNING — could not verify ks guard status (spawn ks ENOENT); proceeding",
      stdout: "",
    });
    execFileMock.mockRejectedValue(err);

    const { dv } = await import("./divinci.js");
    await expect(dv(["rag", "files"])).rejects.toThrow(/TIMED OUT after \d+s \(SIGTERM, exit 143\)/);
  });

  it("does not claim a timeout for an ordinary failure", async () => {
    execFileMock.mockRejectedValue(
      Object.assign(new Error("Command failed: divinci rag files"), {
        killed: false,
        signal: null,
        stderr: "some real error",
        stdout: "",
      }),
    );
    const { dv } = await import("./divinci.js");
    await expect(dv(["rag", "files"])).rejects.toThrow(/some real error|Command failed/);
    await expect(dv(["rag", "files"])).rejects.not.toThrow(/TIMED OUT/);
  });
});

describe("the default CLI timeout", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    delete process.env.DIVINCI_CLI_TIMEOUT_MS;
  });

  it("is 30 minutes, not the 10 that killed a 245-page crawl", async () => {
    const { DEFAULT_CLI_TIMEOUT_MS } = await import("./divinci.js");
    expect(DEFAULT_CLI_TIMEOUT_MS).toBe(30 * 60 * 1000);
  });

  it("is overridable", async () => {
    process.env.DIVINCI_CLI_TIMEOUT_MS = "600000";
    const { DEFAULT_CLI_TIMEOUT_MS } = await import("./divinci.js");
    expect(DEFAULT_CLI_TIMEOUT_MS).toBe(600000);
  });

  it("ignores junk rather than setting a zero/NaN timeout", async () => {
    process.env.DIVINCI_CLI_TIMEOUT_MS = "not-a-number";
    const { DEFAULT_CLI_TIMEOUT_MS } = await import("./divinci.js");
    expect(DEFAULT_CLI_TIMEOUT_MS).toBe(30 * 60 * 1000);
  });
});

describe("the ks guard advisory", () => {
  beforeEach(() => {
    vi.resetModules();
    execFileMock.mockReset();
    delete process.env.DRY_RUN;
  });

  const enoent = () => Object.assign(new Error("spawn ks ENOENT"), { code: "ENOENT" });

  it("reports a missing ks ONCE per process, not per spend step", async () => {
    execFileMock.mockRejectedValue(enoent());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { guardCheck } = await import("./divinci.js");

    await guardCheck();
    await guardCheck();
    await guardCheck();

    // Once per process. Before this it printed on every spend step, and because
    // it is the LAST thing on stderr it got attached to unrelated failures.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/`ks` is not installed/);
    // It must NOT read as a failed check — that is what invited the
    // "ks ENOENT is a hard block" diagnosis.
    expect(warn.mock.calls[0][0]).not.toMatch(/WARNING/);
    warn.mockRestore();
  });

  it("still warns EVERY time for a real error — that one is an event", async () => {
    execFileMock.mockRejectedValue(new Error("ks: database is locked"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { guardCheck } = await import("./divinci.js");

    await guardCheck();
    await guardCheck();

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toMatch(/WARNING/);
    warn.mockRestore();
  });

  it("still refuses spend when the guard says stop", async () => {
    execFileMock.mockResolvedValue({
      stdout: JSON.stringify({ verdict: "block", reasons: ["over budget"] }),
      stderr: "",
    });
    const { guardCheck } = await import("./divinci.js");
    // The advisory got quieter; the actual spend control must not have.
    await expect(guardCheck()).rejects.toThrow(/refuses spend/);
  });
});
