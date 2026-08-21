import { describe, it, expect } from "vitest";
import { findSupersededDemos, profileFor, argFlag, findDeletableWorkers, workerNameFor, isSafeWorkerName, isWorkerAlreadyGone } from "./teardown.js";

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

describe("findDeletableWorkers — never re-issue a delete for a worker already collected", () => {
  const w = (over: Record<string, unknown> = {}) => ({
    prospect: "acme",
    run: "2026-06-15-001",
    landingWorkerName: "demo-acme-landing",
    demoExpiresAt: "2026-01-01",
    ...over,
  });
  const TODAY = "2026-08-21";

  it("excludes a worker every referencing run records as deleted", () => {
    // Without this the sweep re-runs `wrangler delete` for every worker it has
    // ever collected, on every run, for ever — each one a ~3s process that
    // exits 1 with code 10090 and prints a red FAILED line. Across a whole fleet
    // that is minutes of doomed work per run and a wall of errors that trains
    // whoever reads the cron output to ignore it.
    expect(findDeletableWorkers([w({ landingWorkerDeletedAt: "2026-08-21T00:00:00Z" })], TODAY)).toEqual([]);
  });

  it("still collects when only SOME referencing runs are stamped", () => {
    // A partially-stamped set means a write failed midway. Retrying is correct:
    // the delete is idempotent, and 10090 is treated as success.
    const got = findDeletableWorkers([w({ landingWorkerDeletedAt: "2026-08-21T00:00:00Z" }), w({ run: "2026-07-01-001" })], TODAY);
    expect(got).toEqual(["demo-acme-landing"]);
  });

  // ⛔ THE MUTATION THAT MATTERS FOR THE STAMP. Excluding on "ANY run stamped"
  // instead of "ALL runs stamped" leaks: a prospect re-run after collection
  // recreates the SAME worker name, and the old stamped run would exclude that
  // brand-new worker from collection permanently.
  it("collects a worker RECREATED by a later run, despite the old run's stamp", () => {
    const got = findDeletableWorkers(
      [
        w({ landingWorkerDeletedAt: "2026-07-01T00:00:00Z" }),      // collected earlier
        w({ run: "2026-08-01-001", demoExpiresAt: "2026-08-10" }),  // re-run, now expired
      ],
      TODAY,
    );
    expect(got).toEqual(["demo-acme-landing"]);
  });

  it("does not collect a recreated worker while the new run is still serving", () => {
    const got = findDeletableWorkers(
      [w({ landingWorkerDeletedAt: "2026-07-01T00:00:00Z" }), w({ run: "2026-08-01-001", demoExpiresAt: "2026-12-01" })],
      TODAY,
    );
    expect(got).toEqual([]);
  });

  it("matches runs to one worker across both name sources", () => {
    // Older runs carry only landingUrl; newer ones carry landingWorkerName.
    // If these did not resolve to the same key, a shared worker would look
    // like two singletons and the live-run protection would not apply.
    const got = findDeletableWorkers(
      [
        { demoExpiresAt: "2026-01-01", landingUrl: "https://demo-acme-landing.example-org.workers.dev" },
        { demoExpiresAt: "2026-12-01", landingWorkerName: "demo-acme-landing" },
      ],
      TODAY,
    );
    expect(got).toEqual([]);
  });
});

describe("isSafeWorkerName — an allowlist in front of a destructive command", () => {
  it("accepts a real worker name", () => {
    expect(isSafeWorkerName("demo-acme-landing")).toBe(true);
  });

  it("rejects a name wrangler would read as a FLAG", () => {
    // execFile takes no shell, so this is not injection — but argv starting
    // with `-` is parsed as an option and would steer the delete.
    expect(isSafeWorkerName("--force")).toBe(false);
    expect(isSafeWorkerName("-c")).toBe(false);
  });

  it("rejects separators, whitespace and traversal", () => {
    for (const bad of ["demo acme", "demo/acme", "demo;acme", "../other", "demo_acme", ""]) {
      expect(isSafeWorkerName(bad)).toBe(false);
    }
  });

  it("rejects uppercase, which is not a valid Worker name", () => {
    expect(isSafeWorkerName("Demo-Acme")).toBe(false);
  });
});

describe("isWorkerAlreadyGone — the delete is idempotent by intent", () => {
  it("recognises Cloudflare's missing-Worker error", () => {
    expect(isWorkerAlreadyGone("This Worker does not exist on this account. [code: 10090]")).toBe(true);
  });

  it("recognises the bare code", () => {
    expect(isWorkerAlreadyGone("workers.api.error [code: 10090]")).toBe(true);
  });

  it("does NOT swallow an authentication or permission failure", () => {
    // Treating these as "already gone" would stamp the run as collected while
    // the worker is still live and serving — a silent leak that looks clean.
    expect(isWorkerAlreadyGone("Authentication error [code: 10000]")).toBe(false);
    expect(isWorkerAlreadyGone("A request to the Cloudflare API failed [code: 10007]")).toBe(false);
    expect(isWorkerAlreadyGone("connect ETIMEDOUT")).toBe(false);
  });
});
