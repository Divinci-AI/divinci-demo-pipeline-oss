import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readServedReleaseId, findReleaseSplit, describeSplit } from "./served-release.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "svr-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function draft(releaseId: unknown | undefined, write = true) {
  mkdirSync(join(dir, "landing"), { recursive: true });
  if (write)
    writeFileSync(
      join(dir, "landing", "brand-draft.json"),
      JSON.stringify(releaseId === undefined ? {} : { releaseId }),
    );
}

describe("readServedReleaseId", () => {
  it("reads the id the landing bundle was built with", () => {
    draft("6a87ec542e7e6ae8269bd0d1");
    expect(readServedReleaseId(dir)).toBe("6a87ec542e7e6ae8269bd0d1");
  });
  it("is undefined when there is no landing draft at all", () => {
    expect(readServedReleaseId(dir)).toBeUndefined();
  });
  it("is undefined when the draft carries no releaseId", () => {
    draft(undefined);
    expect(readServedReleaseId(dir)).toBeUndefined();
  });
  it("is undefined for a non-string releaseId rather than coercing it", () => {
    draft(12345);
    expect(readServedReleaseId(dir)).toBeUndefined();
  });
  it("is undefined for an empty-string releaseId", () => {
    draft("");
    expect(readServedReleaseId(dir)).toBeUndefined();
  });
  it("does not throw on corrupt JSON", () => {
    mkdirSync(join(dir, "landing"), { recursive: true });
    writeFileSync(join(dir, "landing", "brand-draft.json"), "{not json");
    expect(readServedReleaseId(dir)).toBeUndefined();
  });
});

describe("findReleaseSplit", () => {
  const demo = (releaseId?: string) => ({ prospect: "acmealgos", run: "2026-08-21-001", state: { releaseId } });

  it("REPORTS the real acmealgos split — the case that made this file exist", () => {
    draft("6a87ec542e7e6ae8269bd0d1");
    const s = findReleaseSplit(demo("6a8823f4c3ea21b3d6aecadd"), dir);
    expect(s).not.toBeNull();
    expect(s!.servedReleaseId).toBe("6a87ec542e7e6ae8269bd0d1");
    expect(s!.stateReleaseId).toBe("6a8823f4c3ea21b3d6aecadd");
  });

  it("is null when the two agree — the healthy majority", () => {
    draft("6a87ec542e7e6ae8269bd0d1");
    expect(findReleaseSplit(demo("6a87ec542e7e6ae8269bd0d1"), dir)).toBeNull();
  });

  it("is null when the run has no landing — no visitor path to diverge from", () => {
    expect(findReleaseSplit(demo("6a8823f4c3ea21b3d6aecadd"), dir)).toBeNull();
  });

  it("is null when state has no releaseId — nothing is being written yet", () => {
    draft("6a87ec542e7e6ae8269bd0d1");
    expect(findReleaseSplit(demo(undefined), dir)).toBeNull();
  });

  it("does NOT treat a missing served id as a match (fails open would hide the bug)", () => {
    draft(undefined);
    // No served id at all: silent, not a false "agrees".
    expect(findReleaseSplit(demo("6a8823f4c3ea21b3d6aecadd"), dir)).toBeNull();
    // ...but the moment one exists and differs, it must fire.
    draft("6a87ec542e7e6ae8269bd0d1");
    expect(findReleaseSplit(demo("6a8823f4c3ea21b3d6aecadd"), dir)).not.toBeNull();
  });
});

describe("describeSplit", () => {
  it("names both ids and says what it costs, not merely that they differ", () => {
    const msg = describeSplit({
      prospect: "acmealgos", run: "2026-08-21-001",
      stateReleaseId: "STATE_ID", servedReleaseId: "SERVED_ID",
    });
    expect(msg).toContain("SERVED_ID");
    expect(msg).toContain("STATE_ID");
    // The consequence is the part that gets acted on.
    expect(msg).toMatch(/no visitor can see|reports success/);
  });
});
