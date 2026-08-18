import { describe, it, expect } from "vitest";
import { planFleetRun, summarizeReport } from "./fleet-e2e.js";

const s = (over: Record<string, unknown>) => ({
  dir: "/x",
  state: { prospect: "acme", run: "2026-08-01-001", landingUrl: "https://a.example", ...over },
});

describe("planFleetRun", () => {
  it("skips runs with nothing deployed", () => {
    expect(planFleetRun([s({ landingUrl: undefined })])).toEqual([]);
  });

  it("skips torn-down demos — an unreachable one is teardown WORKING", () => {
    expect(planFleetRun([s({ demoTornDownAt: "2026-08-02T00:00:00Z" })])).toEqual([]);
  });

  it("skips the smoke fixture", () => {
    expect(planFleetRun([s({ prospect: "__smoke__" })])).toEqual([]);
  });

  it("keeps only the newest deployed run per prospect", () => {
    const got = planFleetRun([
      s({ run: "2026-06-15-001", landingUrl: "https://old.example" }),
      s({ run: "2026-08-07-001", landingUrl: "https://new.example" }),
    ]);
    expect(got).toHaveLength(1);
    expect(got[0].url).toBe("https://new.example");
  });

  it("carries basic-auth only when a password exists, defaulting the user", () => {
    const [withAuth] = planFleetRun([s({ landingBasicAuthPassword: "pw" })]);
    expect(withAuth.basicAuthUser).toBe("preview");
    expect(withAuth.basicAuthPass).toBe("pw");
    const [noAuth] = planFleetRun([s({})]);
    expect(noAuth.basicAuthUser).toBeUndefined();
  });

  it("strips a trailing slash so E2E_BASE_URL never doubles up", () => {
    expect(planFleetRun([s({ landingUrl: "https://a.example/" })])[0].url).toBe("https://a.example");
  });
});

describe("summarizeReport", () => {
  const report = {
    suites: [
      {
        specs: [
          { file: "a.spec.ts", title: "ok", tests: [{ status: "expected" }] },
          { file: "b.spec.ts", title: "skipped one", tests: [{ status: "skipped" }] },
          {
            file: "c.spec.ts",
            title: "bad",
            tests: [{ status: "unexpected", results: [{ error: { message: "boom\nstack" } }] }],
          },
        ],
      },
    ],
  };

  it("tallies pass/fail/skip and keeps only the first error line", () => {
    const r = summarizeReport(report);
    expect(r).toMatchObject({ passed: 1, failed: 1, skipped: 1 });
    expect(r.failures[0].message).toBe("boom");
  });

  it("counts a skip as a skip, never as a pass", () => {
    // The whole point of the skip work: optional content that is absent must
    // not be able to masquerade as coverage that ran.
    expect(summarizeReport(report).passed).toBe(1);
  });

  it("recurses into nested suites", () => {
    const nested = { suites: [{ suites: [{ specs: [{ file: "n", title: "t", tests: [{ status: "expected" }] }] }] }] };
    expect(summarizeReport(nested).passed).toBe(1);
  });

  it("returns an empty tally rather than throwing on a malformed report", () => {
    expect(summarizeReport({})).toMatchObject({ passed: 0, failed: 0, skipped: 0 });
  });
});
