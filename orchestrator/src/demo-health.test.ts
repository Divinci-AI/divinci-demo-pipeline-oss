import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDemo, findDemos, summarize, FAILING_VERDICTS, type Probe } from "./demo-health.js";
import type { RunState } from "./types.js";

const LANDING = "https://demo-x-landing.example-account.workers.dev";
const RELEASE = "6a305d15f9bfeeca0d8be1e7";
const STAGE = "https://api.stage.divinci.app";
const PROD = "https://api.divinci.app";

function state(over: Partial<RunState> = {}): RunState {
  return {
    prospect: "x",
    run: "2026-08-04-001",
    step: "outreach",
    pagesCrawled: 0,
    ingested: [],
    log: [],
    landingUrl: LANDING,
    releaseId: RELEASE,
    landingBasicAuthUser: "preview",
    landingBasicAuthPassword: "secret123",
    ...over,
  };
}

function probe(opts: {
  status?: number;
  servedBy?: string | null;
  /** Defaults to a healthy 1200x630-ish PNG so existing cases are unaffected. */
  card?: { contentType: string; bytes: number } | undefined;
  onAsset?: (url: string, auth?: string) => void;
  /** Per-path overrides, matched on suffix — e.g. { "/brand/corpus.webm": … }. */
  assets?: Record<string, { contentType: string; bytes: number } | undefined>;
}): Probe {
  return {
    head: async () => opts.status,
    bootstrap: async (base, id) => opts.servedBy === base && id === RELEASE,
    asset: async (url, auth) => {
      opts.onAsset?.(url, auth);
      for (const [path, res] of Object.entries(opts.assets ?? {})) if (url.endsWith(path)) return res;
      if (url.endsWith("/og.png")) return "card" in opts ? opts.card : { contentType: "image/png", bytes: 140_000 };
      // Brand media defaults to present, so existing cases are unaffected.
      return { contentType: url.endsWith(".webm") ? "video/webm" : "image/webp", bytes: 90_000 };
    },
  };
}

const demo = (s: RunState) => ({ prospect: "x", run: "2026-08-04-001", state: s });

describe("checkDemo", () => {
  it("treats 401 as HEALTHY — the preview gate is doing its job", () => {
    // The common case. A monitor that reads 401 as an outage would page on all
    // 18 demos every night and be muted within a day.
    return expect(
      checkDemo(demo(state()), probe({ status: 401, servedBy: STAGE })).then((r) => r.verdict),
    ).resolves.toBe("ok");
  });

  it("reports an ungated 200 as OPEN, not failed", async () => {
    // acmebio is deliberately open while it is handed to the customer.
    const r = await checkDemo(demo(state()), probe({ status: 200, servedBy: PROD }));
    expect(r.verdict).toBe("open");
    expect(r.detail).toMatch(/NO auth challenge/);
    expect(FAILING_VERDICTS).not.toContain("open");
  });

  it("does not flag an ungated 200 when no password was ever set", async () => {
    const r = await checkDemo(
      demo(state({ landingBasicAuthPassword: undefined })),
      probe({ status: 200, servedBy: STAGE }),
    );
    expect(r.verdict).toBe("ok");
  });

  it("catches the invisible failure: page loads, release is dark", async () => {
    // The shape a page-level check cannot see — the frame renders and the chat
    // is dead. This is why the release is probed separately.
    const r = await checkDemo(demo(state()), probe({ status: 401, servedBy: null }));
    expect(r.verdict).toBe("dark");
    expect(r.detail).toMatch(/chat is dead/);
  });

  it("finds a release on EITHER environment — runs are not all on one", async () => {
    // acmebio is production, the rest staging, and state.json does not record
    // which. Probing only staging would report production demos as dark.
    const r = await checkDemo(demo(state()), probe({ status: 401, servedBy: PROD }));
    expect(r.verdict).toBe("ok");
    expect(r.releaseServedBy).toBe(PROD);
  });

  it("reports an unreachable landing worker", async () => {
    const r = await checkDemo(demo(state()), probe({ status: undefined, servedBy: STAGE }));
    expect(r.verdict).toBe("unreachable");
  });

  it("treats a 5xx landing worker as unreachable", async () => {
    expect((await checkDemo(demo(state()), probe({ status: 503, servedBy: STAGE }))).verdict).toBe("unreachable");
  });

  it("treats a 404 landing worker as unreachable (the worker was deleted)", async () => {
    expect((await checkDemo(demo(state()), probe({ status: 404, servedBy: STAGE }))).verdict).toBe("unreachable");
  });

  it("SKIPS a torn-down demo — teardown succeeding is not an outage", async () => {
    const r = await checkDemo(
      demo(state({ demoTornDownAt: "2026-07-01T00:00:00.000Z" })),
      probe({ status: 404, servedBy: null }),
    );
    expect(r.verdict).toBe("ok");
    expect(r.detail).toMatch(/torn down/);
  });

  it("checks a release even when there is no landing worker", async () => {
    const r = await checkDemo(demo(state({ landingUrl: undefined })), probe({ status: undefined, servedBy: null }));
    expect(r.verdict).toBe("dark");
  });
});

describe("findDemos", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  function fixture(spec: Record<string, Partial<RunState> | null>): string {
    const root = mkdtempSync(join(tmpdir(), "health-"));
    dirs.push(root);
    for (const [prospect, s] of Object.entries(spec)) {
      const dir = join(root, prospect, "2026-08-04-001");
      mkdirSync(dir, { recursive: true });
      if (s) writeFileSync(join(dir, "state.json"), JSON.stringify(s));
    }
    return root;
  }

  it("includes runs with a landing URL or a release", () => {
    const root = fixture({ a: { landingUrl: LANDING }, b: { releaseId: RELEASE } });
    expect(findDemos(root).map((d) => d.prospect).sort()).toEqual(["a", "b"]);
  });

  it("excludes runs with neither — nothing public to check", () => {
    expect(findDemos(fixture({ a: { step: "gate1" } }))).toHaveLength(0);
  });

  it("excludes the __smoke__ fixture", () => {
    expect(findDemos(fixture({ __smoke__: { landingUrl: LANDING } }))).toHaveLength(0);
  });

  it("survives a corrupt state.json", () => {
    const root = fixture({ a: { landingUrl: LANDING } });
    const bad = join(root, "b", "2026-08-04-001");
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, "state.json"), "{ nope");
    expect(findDemos(root)).toHaveLength(1);
  });
});

describe("summarize", () => {
  it("separates failing from merely open", () => {
    const s = summarize([
      { prospect: "a", run: "r", verdict: "ok", detail: "", tornDown: false },
      { prospect: "b", run: "r", verdict: "open", detail: "", tornDown: false },
      { prospect: "c", run: "r", verdict: "dark", detail: "", tornDown: false },
    ]);
    expect(s.failing.map((f) => f.prospect)).toEqual(["c"]);
    expect(s.open.map((f) => f.prospect)).toEqual(["b"]);
  });
});

describe("checkDemo — the unfurl card", () => {
  it("catches an og.png that the SPA fallback answers with HTML", () => {
    // THE ORIGINAL FAILURE, and why this is checked by content-type rather
    // than status: og:image named /og.png, the file was never built, and the
    // worker's single-page-app fallback served index.html for it with HTTP
    // 200. Every demo this pipeline built shipped that way, and a status-code
    // check would have called all of them healthy.
    return expect(
      checkDemo(demo(state({ landingUrl: LANDING, releaseId: RELEASE, apiUrl: PROD })), probe({
        status: 401,
        servedBy: PROD,
        card: { contentType: "text/html; charset=utf-8", bytes: 42_000 },
      })),
    ).resolves.toMatchObject({ verdict: "no-unfurl", detail: expect.stringContaining("not an image") });
  });

  it("catches a PNG too small to be a real 1200x630 card", () => {
    return expect(
      checkDemo(demo(state({ landingUrl: LANDING, releaseId: RELEASE, apiUrl: PROD })), probe({
        status: 401,
        servedBy: PROD,
        card: { contentType: "image/png", bytes: 300 },
      })),
    ).resolves.toMatchObject({ verdict: "no-unfurl" });
  });

  it("passes a real card", async () => {
    const r = await checkDemo(
      demo(state({ landingUrl: LANDING, releaseId: RELEASE, apiUrl: PROD })),
      probe({ status: 401, servedBy: PROD, card: { contentType: "image/png", bytes: 140_000 } }),
    );
    expect(r.verdict).toBe("ok");
  });

  it("does NOT report a broken card when the request itself failed", async () => {
    // The landing page already answered, so an undefined here is a network
    // blip on one extra request — reporting it as a marketing defect would
    // make the check flaky and train people to ignore it.
    const r = await checkDemo(
      demo(state({ landingUrl: LANDING, releaseId: RELEASE, apiUrl: PROD })),
      probe({ status: 401, servedBy: PROD, card: undefined }),
    );
    expect(r.verdict).toBe("ok");
  });

  it("sends the preview-gate credentials, or every gated demo reads as broken", async () => {
    // 17 of 18 demos sit behind Basic Auth; without credentials the card
    // request 401s and the check would be useless exactly where it is needed.
    let seenAuth: string | undefined;
    await checkDemo(
      demo(state({
        landingUrl: LANDING,
        releaseId: RELEASE,
        apiUrl: PROD,
        landingBasicAuthUser: "preview",
        landingBasicAuthPassword: "pw-123",
      })),
      probe({ status: 401, servedBy: PROD, onAsset: (_u, a) => { seenAuth = a; } }),
    );
    expect(seenAuth).toBe("preview:pw-123");
  });

  it("requests every asset at the landing root without a doubled slash", async () => {
    // Collects ALL probed URLs rather than keeping the last one: when brand
    // media joined og.png, a last-write assertion silently started testing a
    // different request than the one it names.
    const seen: string[] = [];
    await checkDemo(
      demo(state({ landingUrl: LANDING + "/", releaseId: RELEASE, apiUrl: PROD })),
      probe({ status: 401, servedBy: PROD, onAsset: (u) => { seen.push(u); } }),
    );
    expect(seen).toContain(`${LANDING}/og.png`);
    expect(seen.filter((u) => u.includes("//og.png") || u.includes("dev//"))).toEqual([]);
  });
});

describe("checkDemo — an OPEN demo still gets its card checked", () => {
  it("reports the broken card alongside the open-gate verdict", async () => {
    // The open demo is the one being HANDED to a customer, so its share link
    // matters most. An earlier version returned on `open` before the card was
    // ever fetched — skipping the check on exactly the demo that needed it.
    const r = await checkDemo(
      demo(state({
        landingUrl: LANDING,
        releaseId: RELEASE,
        apiUrl: PROD,
        landingBasicAuthPassword: "pw-123",
      })),
      probe({ status: 200, servedBy: PROD, card: { contentType: "text/html", bytes: 42_000 } }),
    );
    expect(r.verdict).toBe("open");
    expect(r.detail).toContain("unfurl blank");
  });
});

describe("checkDemo — brand media behind the SPA fallback", () => {
  const healthy = { status: 401, servedBy: PROD };

  it("catches a corpus video the SPA fallback answers with HTML", async () => {
    // mach33 shipped with /brand/corpus.webm returning `200 text/html` after a
    // transient R2 upload failed. Nothing noticed: the status code is 200, and
    // an empty video well reads as a design choice — the design review scored
    // the page 0 critical / 0 major with a dead video on it.
    const r = await checkDemo(
      demo(state({ landingUrl: LANDING, releaseId: RELEASE, apiUrl: PROD })),
      probe({ ...healthy, assets: { "/brand/corpus.webm": { contentType: "text/html; charset=utf-8", bytes: 52_928 } } }),
    );
    expect(r.verdict).toBe("no-unfurl");
    expect(r.detail).toContain("SPA fallback is hiding it");
  });

  it("catches a missing hero image the same way", async () => {
    const r = await checkDemo(
      demo(state({ landingUrl: LANDING, releaseId: RELEASE, apiUrl: PROD })),
      probe({ ...healthy, assets: { "/brand/hero.webp": { contentType: "text/html", bytes: 52_928 } } }),
    );
    expect(r.detail).toContain("hero image");
  });

  it("ignores media the page never asks for — an absent hero is the CORRECT state", async () => {
    // The template stopped emitting a hero for demos that have no hero image.
    // Probing /brand/hero.webp regardless flagged 31 of 56 healthy demos as
    // `no-unfurl` for a file none of their pages request.
    const r = await checkDemo(
      demo(state({ landingUrl: LANDING, releaseId: RELEASE, apiUrl: PROD })),
      {
        ...probe({ ...healthy, assets: { "/brand/hero.webp": { contentType: "text/html", bytes: 52_928 } } }),
        html: async () => "<html><body><h1>No hero here</h1></body></html>",
      },
    );
    expect(r.verdict).toBe("ok");
  });

  it("still catches missing media the page DOES ask for", async () => {
    const r = await checkDemo(
      demo(state({ landingUrl: LANDING, releaseId: RELEASE, apiUrl: PROD })),
      {
        ...probe({ ...healthy, assets: { "/brand/hero.webp": { contentType: "text/html", bytes: 52_928 } } }),
        html: async () => `<html><body><img src="/brand/hero.webp"></body></html>`,
      },
    );
    expect(r.verdict).toBe("no-unfurl");
    expect(r.detail).toContain("hero image");
  });

  it("probes anyway when the page HTML cannot be read — an unverifiable reference must not silence a defect", async () => {
    const r = await checkDemo(
      demo(state({ landingUrl: LANDING, releaseId: RELEASE, apiUrl: PROD })),
      {
        ...probe({ ...healthy, assets: { "/brand/hero.webp": { contentType: "text/html", bytes: 52_928 } } }),
        html: async () => undefined,
      },
    );
    expect(r.verdict).toBe("no-unfurl");
  });

  it("passes when the media is real", async () => {
    expect((await checkDemo(demo(state({ landingUrl: LANDING, releaseId: RELEASE, apiUrl: PROD })), probe(healthy))).verdict)
      .toBe("ok");
  });

  it("does not report a network blip as missing media", async () => {
    // Same reasoning as the card: the landing page already answered, so an
    // undefined here is one failed extra request, not a defect.
    const r = await checkDemo(
      demo(state({ landingUrl: LANDING, releaseId: RELEASE, apiUrl: PROD })),
      probe({ ...healthy, assets: { "/brand/corpus.webm": undefined } }),
    );
    expect(r.verdict).toBe("ok");
  });

  it("lets the og.png problem win — one detail line, most-shared surface first", async () => {
    const r = await checkDemo(
      demo(state({ landingUrl: LANDING, releaseId: RELEASE, apiUrl: PROD })),
      probe({
        ...healthy,
        card: { contentType: "text/html", bytes: 42_000 },
        assets: { "/brand/corpus.webm": { contentType: "text/html", bytes: 52_928 } },
      }),
    );
    expect(r.detail).toContain("not an image");
  });
});
