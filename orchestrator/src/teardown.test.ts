import { describe, it, expect } from "vitest";
import { findSupersededDemos, profileFor, argFlag } from "./teardown.js";

const run = (over: Record<string, unknown> = {}) => ({
  prospect: "acme",
  run: "2026-06-15-001",
  landingUrl: "https://old.example",
  releaseId: "r1",
  ...over,
});

describe("findSupersededDemos", () => {
  it("selects an older deployed run when a newer deployed run exists", () => {
    const got = findSupersededDemos([run(), run({ run: "2026-08-07-001", landingUrl: "https://new.example" })]);
    expect(got.map((r) => r.run)).toEqual(["2026-06-15-001"]);
  });

  it("never strands a prospect: keeps the older demo when the newer one is NOT deployed", () => {
    // The newer run may be parked at gate2 with a release and no page. Tearing
    // down the older one would leave the prospect with no demo at all.
    const got = findSupersededDemos([run(), run({ run: "2026-08-07-001", landingUrl: undefined })]);
    expect(got).toEqual([]);
  });

  it("leaves an APPROVED older run alone — its link may already be in a sent email", () => {
    const got = findSupersededDemos([
      run({ outreachApprovedBy: "review-board" }),
      run({ run: "2026-08-07-001", landingUrl: "https://new.example" }),
    ]);
    expect(got).toEqual([]);
  });

  it("never selects the newest run", () => {
    const got = findSupersededDemos([run(), run({ run: "2026-08-07-001", landingUrl: "https://new.example" })]);
    expect(got.some((r) => r.run === "2026-08-07-001")).toBe(false);
  });

  it("ignores runs already torn down", () => {
    const got = findSupersededDemos([
      run({ demoTornDownAt: "2026-08-01T00:00:00Z" }),
      run({ run: "2026-08-07-001", landingUrl: "https://new.example" }),
    ]);
    expect(got).toEqual([]);
  });

  it("does not treat a torn-down newer run as a valid survivor", () => {
    // Otherwise the older demo is torn down in favour of one that is already
    // dark, and the prospect ends up with nothing.
    const got = findSupersededDemos([
      run(),
      run({ run: "2026-08-07-001", landingUrl: "https://new.example", demoTornDownAt: "2026-08-09T00:00:00Z" }),
    ]);
    expect(got).toEqual([]);
  });

  it("keeps prospects independent", () => {
    const got = findSupersededDemos([
      run({ prospect: "a" }),
      run({ prospect: "b", run: "2026-08-07-001", landingUrl: "https://b.example" }),
    ]);
    expect(got).toEqual([]);
  });

  it("requires a releaseId — there is nothing to deprecate without one", () => {
    const got = findSupersededDemos([
      run({ releaseId: undefined }),
      run({ run: "2026-08-07-001", landingUrl: "https://new.example" }),
    ]);
    expect(got).toEqual([]);
  });

  it("handles three runs, selecting both older ones", () => {
    const got = findSupersededDemos([
      run({ run: "2026-05-01-001" }),
      run({ run: "2026-06-15-001" }),
      run({ run: "2026-08-07-001", landingUrl: "https://new.example" }),
    ]);
    expect(got.map((r) => r.run)).toEqual(["2026-05-01-001", "2026-06-15-001"]);
  });
});

describe("profileFor — never authenticate against the wrong environment", () => {
  it("returns the staging profile for a staging apiUrl", () => {
    expect(profileFor("https://api.stage.divinci.app", { TEARDOWN_PROFILE_STAGE: "stage" })).toBe("stage");
  });

  it("returns undefined for staging when no staging profile is configured", () => {
    // Deliberately NOT falling back to `default`: default points at prod, and
    // quietly using it is how a staging teardown ends up authenticated against
    // production. Undefined makes the CLI fail loudly instead.
    expect(profileFor("https://api.stage.divinci.app", {})).toBeUndefined();
  });

  it("returns undefined for prod, so the default profile is used as before", () => {
    expect(profileFor("https://api.divinci.app", { TEARDOWN_PROFILE_STAGE: "stage" })).toBeUndefined();
  });

  it("does not mistake the prod host for staging", () => {
    // A substring match on "stage" would also fire on hosts that merely
    // contain it; the word boundary is the point.
    expect(profileFor("https://api.divinci.app", { TEARDOWN_PROFILE_STAGE: "stage" })).toBeUndefined();
  });
});

describe("argFlag", () => {
  it("reads a flag value", () => {
    expect(argFlag("--profile", ["x", "--profile", "stage"])).toBe("stage");
  });

  it("ignores a flag with no value", () => {
    expect(argFlag("--profile", ["x", "--profile", "--dry-run"])).toBeUndefined();
  });

  it("returns undefined when absent", () => {
    expect(argFlag("--profile", ["--superseded"])).toBeUndefined();
  });
});
