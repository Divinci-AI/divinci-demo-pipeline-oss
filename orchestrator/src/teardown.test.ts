import { describe, it, expect } from "vitest";
import { findSupersededDemos, profileFor, argFlag, findDeletableWorkers, workerNameFor } from "./teardown.js";

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

describe("findDeletableWorkers — the worker must outlive every run that still serves", () => {
  const w = (over: Record<string, unknown> = {}) => ({
    prospect: "acme",
    run: "2026-06-15-001",
    landingWorkerName: "demo-acme-landing",
    demoExpiresAt: "2026-01-01",
    ...over,
  });
  const TODAY = "2026-08-21";

  it("collects a worker whose only run is expired", () => {
    expect(findDeletableWorkers([w()], TODAY)).toEqual(["demo-acme-landing"]);
  });

  it("collects a worker whose only run was torn down", () => {
    const got = findDeletableWorkers([w({ demoExpiresAt: "2026-12-01", demoTornDownAt: "2026-08-10T00:00:00Z" })], TODAY);
    expect(got).toEqual(["demo-acme-landing"]);
  });

  // ⛔ THE MUTATION THAT MATTERS. The worker is named per PROSPECT, so an older
  // superseded run and the live run replacing it share one script. Collecting
  // per-run — i.e. dropping the `.every()` and acting on the expired run alone
  // — takes the live demo dark. Any re-run prospect is in exactly this state.
  it("does NOT collect a shared worker while a newer run is still serving", () => {
    const got = findDeletableWorkers(
      [w(), w({ run: "2026-08-07-001", demoExpiresAt: "2026-10-16" })],
      TODAY,
    );
    expect(got).toEqual([]);
  });

  it("collects the shared worker once BOTH runs are finished", () => {
    const got = findDeletableWorkers(
      [w(), w({ run: "2026-08-07-001", demoExpiresAt: "2026-08-20" })],
      TODAY,
    );
    expect(got).toEqual(["demo-acme-landing"]);
  });

  it("treats a run with no expiry date as still serving", () => {
    // Fail-safe: we cannot show it is finished, so we must not delete its page.
    expect(findDeletableWorkers([w({ demoExpiresAt: undefined })], TODAY)).toEqual([]);
  });

  it("collects a worker expiring exactly today, matching the deprecation pass", () => {
    // findDueDemos() deprecates on `demoExpiresAt <= today`, so a demo expiring
    // today has its release taken out of service on this same run. The worker
    // must use the identical boundary or the page outlives its own chat by a
    // day — deliberately pinned, because the two selectors are the kind of pair
    // that drifts.
    expect(findDeletableWorkers([w({ demoExpiresAt: TODAY })], TODAY)).toEqual(["demo-acme-landing"]);
  });

  it("never invents a worker no run references", () => {
    // Hand-built demos deployed outside the pipeline have no state file.
    // Absence of evidence is not evidence — a human reports them, not this.
    expect(findDeletableWorkers([{ demoExpiresAt: "2026-01-01" }], TODAY)).toEqual([]);
  });

  it("keeps prospects independent", () => {
    const got = findDeletableWorkers(
      [w(), w({ prospect: "beta", landingWorkerName: "demo-beta-landing", demoExpiresAt: "2026-12-01" })],
      TODAY,
    );
    expect(got).toEqual(["demo-acme-landing"]);
  });
});

describe("workerNameFor", () => {
  it("prefers the recorded worker name", () => {
    expect(workerNameFor({ landingWorkerName: "demo-acme-landing", landingUrl: "https://other.example" }))
      .toBe("demo-acme-landing");
  });

  it("falls back to parsing the URL for runs written before the field existed", () => {
    // Any workers.dev subdomain — the account subdomain is not hard-coded.
    expect(workerNameFor({ landingUrl: "https://demo-acme-landing.example-org.workers.dev" }))
      .toBe("demo-acme-landing");
  });

  it("returns undefined for a custom-domain URL it cannot attribute", () => {
    expect(workerNameFor({ landingUrl: "https://demo.acme.com" })).toBeUndefined();
  });

  it("returns undefined when there is no landing page at all", () => {
    expect(workerNameFor({})).toBeUndefined();
  });
});
