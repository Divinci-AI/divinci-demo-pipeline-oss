import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { releaseDemoReadiness } from "./qa.js";

/**
 * releaseDemoReadiness is the last check between a broken demo and a prospect.
 * It was dead code for its entire life (it demanded a DIVINCI_API_KEY the README
 * tells you to leave unset), so every one of its branches is unproven — hence
 * covering all of them here rather than only the happy path.
 */

const RELEASE = "6a305d15f9bfeeca0d8be1e7";
// The pipeline's default environment is PRODUCTION as of 2026-08-05.
const BASE = "https://api.divinci.app";

function mockFetch(impl: (url: string) => Promise<Response> | Response) {
  const spy = vi.fn((input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(impl(String(input))),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  delete process.env.DIVINCI_API_URL;
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.DIVINCI_API_URL;
});

describe("releaseDemoReadiness", () => {
  it("probes the PUBLIC bootstrap path, unauthenticated", async () => {
    const spy = mockFetch(() => json({ _id: RELEASE, status: "available", allowAnonymousChat: true }));
    await releaseDemoReadiness(RELEASE);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toBe(`${BASE}/white-label-release/${RELEASE}`);
    // No Authorization header — needing a credential is what killed the old one.
    const init = spy.mock.calls[0][1] as RequestInit | undefined;
    expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();
  });

  it("is ready when published with anonymous chat on", async () => {
    mockFetch(() => json({ _id: RELEASE, status: "available", allowAnonymousChat: true }));
    expect(await releaseDemoReadiness(RELEASE)).toEqual({ ready: true });
  });

  it("reports 404 as not-served, naming the base it probed", async () => {
    mockFetch(() => json({ status: "error", message: "not found" }, 404));
    const r = await releaseDemoReadiness(RELEASE);
    expect(r.ready).toBe(false);
    // The apbiocode case: available on the admin path, 404 publicly, because the
    // run targeted a different environment. The base must be in the message or
    // the reason reads as "the demo is broken".
    expect(r.reason).toContain(BASE);
    expect(r.reason).toMatch(/404/);
  });

  it("follows DIVINCI_API_URL so a staging run is probed against staging", async () => {
    // run.ts exports the run's own state.apiUrl into this variable, so a
    // legacy staging run is still checked where it actually lives.
    process.env.DIVINCI_API_URL = "https://api.stage.divinci.app";
    const spy = mockFetch(() => json({ _id: RELEASE, status: "available", allowAnonymousChat: true }));
    await releaseDemoReadiness(RELEASE);
    expect(String(spy.mock.calls[0][0])).toBe(`https://api.stage.divinci.app/white-label-release/${RELEASE}`);
  });

  it("refuses when the bootstrap returns a DIFFERENT release", async () => {
    mockFetch(() => json({ _id: "aaaaaaaaaaaaaaaaaaaaaaaa", status: "available" }));
    const r = await releaseDemoReadiness(RELEASE);
    expect(r.ready).toBe(false);
    expect(r.reason).toContain("different release");
  });

  it("refuses an unpublished release", async () => {
    mockFetch(() => json({ _id: RELEASE, status: "draft", allowAnonymousChat: true }));
    const r = await releaseDemoReadiness(RELEASE);
    expect(r.ready).toBe(false);
    expect(r.reason).toContain("draft");
  });

  it("refuses when anonymous chat is off — the link would demand a login", async () => {
    mockFetch(() => json({ _id: RELEASE, status: "available", allowAnonymousChat: false }));
    const r = await releaseDemoReadiness(RELEASE);
    expect(r.ready).toBe(false);
    expect(r.reason).toContain("allowAnonymousChat");
  });

  it("returns not-ready (never throws) when the network fails", async () => {
    mockFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const r = await releaseDemoReadiness(RELEASE);
    expect(r.ready).toBe(false);
    expect(r.reason).toContain("ECONNREFUSED");
  });

  it("treats a non-JSON body as not-ready rather than crashing the run", async () => {
    mockFetch(() => new Response("<html>gateway error</html>", { status: 200 }));
    const r = await releaseDemoReadiness(RELEASE);
    expect(r.ready).toBe(false);
  });
});
