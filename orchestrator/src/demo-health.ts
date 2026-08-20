/**
 * Synthetic health check for every demo this pipeline has built.
 *
 * WHY. Nineteen demo sites are live on the internet and NOTHING watches them.
 * A demo sent to a prospect could be dark for weeks and the first report would
 * come from the prospect. The server monorepo has an elaborate synthetic-monitor
 * story for exactly this failure class; the demo pipeline had none.
 *
 * WHAT IT CHECKS, per run:
 *
 *   1. The landing worker responds. 401 is HEALTHY — it means the Basic-Auth
 *      preview gate is up. 200 means the demo is open to anyone; that is
 *      deliberate for a demo being handed to a customer, so it is reported as
 *      OPEN rather than failed, and only flagged when state.json also records
 *      a password (gate configured but not enforced — the regression shape).
 *
 *   2. The release still bootstraps publicly — the request a prospect's browser
 *      makes. A landing page that loads while its release 404s is the exact
 *      shape that is invisible to a page-level check: the frame renders and the
 *      chat is dead.
 *
 * Runs record the environment they were built against (state.apiUrl), and they
 * are NOT all on the same one — acmebio and everything from 2026-08-05 are
 * production, the 17 earlier runs staging. A run with that field is checked
 * against its own environment; older ones are probed against both. A release
 * served by neither is dark.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { RunState } from "./types.js";

// Production first: it is the default environment now, so the common case
// resolves on the first probe. A run that records state.apiUrl is checked
// against that alone.
export const API_BASES = ["https://api.divinci.app", "https://api.stage.divinci.app"] as const;

export type DemoVerdict =
  | "ok" | "open" | "dark" | "unreachable" | "gate-broken" | "no-unfurl"
  /** The chat endpoint REFUSED a visitor — a ban or a rate limit. */
  | "chat-blocked"
  /** The chat endpoint errored or did not answer. */
  | "chat-error";

/**
 * What the chat path said when asked.
 *
 * ⚠️ WHY THIS EXISTS. Until 2026-08-19 this monitor checked three things —
 * the landing worker answers, the release bootstraps, the unfurl card is an
 * image — and all three are GETs. On 2026-08-18 an abuse-detection defect in
 * the API banned the shared identity that every visitor of a Worker-fronted
 * demo collapses into, and took at least three demos dark for 24 hours. Through
 * all of it the landing worker returned 200, the release bootstrapped, and the
 * card was fine, so this monitor reported `ok` for every dark demo. A human
 * reported the outage.
 *
 * We have learned the same lesson twice: "every synthetic we had was a GET …
 * none of them touch the endpoint that actually serves a chat turn". This
 * closes it here.
 */
export type ChatProbeResult =
  /** Guards passed and the handler rejected the probe body. The healthy answer. */
  | { kind: "ok"; status: number }
  /** The release requires a signed request, or runs the Free-Chat Gate, so this
   *  probe cannot assess it. NOT a failure — the surface answered correctly. */
  | { kind: "unprobeable"; status: number; why: string }
  /** A visitor would be refused right now. */
  | { kind: "blocked"; status: number; retryAfterSeconds?: number }
  | { kind: "error"; status?: number };

export interface DemoHealth {
  prospect: string;
  run: string;
  landingUrl?: string;
  landingStatus?: number;
  releaseId?: string;
  releaseServedBy?: string;
  verdict: DemoVerdict;
  detail: string;
  tornDown: boolean;
}

/** Collect every run that has something publicly reachable worth checking. */
export function findDemos(runsDir: string): Array<{ prospect: string; run: string; state: RunState }> {
  const out: Array<{ prospect: string; run: string; state: RunState }> = [];
  if (!existsSync(runsDir)) return out;
  for (const prospect of readdirSync(runsDir)) {
    if (prospect.startsWith(".") || prospect.startsWith("__")) continue;
    let runIds: string[];
    try {
      runIds = readdirSync(join(runsDir, prospect));
    } catch {
      continue;
    }
    for (const run of runIds) {
      const p = join(runsDir, prospect, run, "state.json");
      if (!existsSync(p)) continue;
      try {
        const state = JSON.parse(readFileSync(p, "utf8")) as RunState;
        if (state.landingUrl || state.releaseId) out.push({ prospect, run, state });
      } catch {
        /* corrupt state is the loop's problem, not the monitor's */
      }
    }
  }
  return out;
}

export interface Probe {
  head(url: string): Promise<number | undefined>;
  bootstrap(base: string, releaseId: string): Promise<boolean>;
  /** Content-type + byte size of a URL. Used for the unfurl-card check. */
  asset(url: string, auth?: string): Promise<{ contentType: string; bytes: number } | undefined>;
  /**
   * The landing page's HTML, used to decide whether a /brand/* asset is
   * actually REFERENCED before probing it. Optional: a probe that omits it
   * falls back to probing unconditionally, which is the older, noisier
   * behaviour but never silently stops checking.
   */
  html?(url: string, auth?: string): Promise<string | undefined>;
  /**
   * Ask the chat endpoint whether it would serve a visitor, WITHOUT generating
   * anything. Optional, like `html` above: a probe that omits it skips the
   * check rather than silently reporting health it did not measure.
   */
  chat?(base: string, releaseId: string): Promise<ChatProbeResult>;
}

/** Real network probe. Injected so the classifier can be tested offline. */
export const liveProbe: Probe = {
  async head(url) {
    try {
      const res = await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(20_000) });
      return res.status;
    } catch {
      return undefined;
    }
  },
  async asset(url, auth) {
    try {
      const headers: Record<string, string> = {};
      if (auth) headers.authorization = `Basic ${Buffer.from(auth).toString("base64")}`;
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) return undefined;
      const buf = await res.arrayBuffer();
      return { contentType: res.headers.get("content-type") ?? "", bytes: buf.byteLength };
    } catch {
      return undefined;
    }
  },
  async html(url, auth) {
    try {
      const headers: Record<string, string> = {};
      if (auth) headers.authorization = `Basic ${Buffer.from(auth).toString("base64")}`;
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) return undefined;
      return await res.text();
    } catch {
      return undefined;
    }
  },
  /**
   * Probes the API DIRECTLY rather than through the landing Worker, for two
   * reasons that both matter.
   *
   * Cost: the body carries `releaseId` and nothing else, so it traverses every
   * guard — release lockdown, ToS, disclaimer, landing-page HMAC, all four rate
   * limiters, the device quota, the abuse detector — and is then refused by the
   * handler's own field validation. No model call, no wallet, no quota slot.
   *
   * Blast radius: going through the Worker would make these requests arrive at
   * the API from the shared Cloudflare egress pool, spending the SAME per-IP
   * budget the demos' real visitors share. Probing directly spends this host's
   * own budget instead, and one request per release against that release's
   * 120/day. See `selectChatProbeSlice` for the arithmetic that keeps this
   * host under its own ceiling.
   *
   * The trade-off, stated plainly: this does not exercise the Worker's own call
   * to the API, so a Worker misconfigured with the wrong release id or a bad
   * HMAC secret still looks healthy here. `head` above catches a Worker that is
   * down; nothing yet catches one that is up and wrong.
   */
  async chat(base, releaseId) {
    let res: Response;
    try {
      res = await fetch(`${base}/ai-chat/anonymous-chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ releaseId }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      return { kind: "error" };
    }
    const status = res.status;
    const text = await res.text().catch(() => "");
    if (status === 400) return { kind: "ok", status };
    if (status === 429) {
      const retry = Number(res.headers.get("retry-after"));
      return {
        kind: "blocked",
        status,
        ...(Number.isFinite(retry) && retry > 0 ? { retryAfterSeconds: retry } : {}),
      };
    }
    if (status === 403) {
      // Two different, legitimate 403s. `gate_required` means the release runs
      // the Free-Chat Gate, so /anonymous-chat is not its path at all;
      // `landing_page_sig_*` means the release requires a signed request, which
      // is hardening working as intended. Neither is a fault, and calling them
      // one would make this monitor fire on correctly-configured demos.
      if (text.includes("gate_required"))
        return { kind: "unprobeable", status, why: "release runs the Free-Chat Gate" };
      if (text.includes("landing_page_sig"))
        return { kind: "unprobeable", status, why: "release requires a signed request" };
      return { kind: "blocked", status };
    }
    if (status >= 500) return { kind: "error", status };
    // Anything else — including a 200, which this body should never earn —
    // means the contract moved. Report it rather than assuming health.
    return { kind: "error", status };
  },
  async bootstrap(base, releaseId) {
    try {
      const res = await fetch(`${base}/white-label-release/${releaseId}`, {
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return false;
      const body = (await res.json().catch(() => ({}))) as { _id?: string };
      return body._id === releaseId;
    } catch {
      return false;
    }
  },
};

/**
 * Classify one demo. Pure given a Probe, so every verdict is unit-testable —
 * a monitor whose own logic is unverified is not much of a monitor.
 */
export async function checkDemo(
  demo: { prospect: string; run: string; state: RunState },
  probe: Probe = liveProbe,
  opts: { chat?: boolean } = {},
): Promise<DemoHealth> {
  const { prospect, run, state } = demo;
  const base: DemoHealth = {
    prospect,
    run,
    landingUrl: state.landingUrl,
    releaseId: state.releaseId,
    verdict: "ok",
    detail: "",
    tornDown: Boolean(state.demoTornDownAt),
  };

  // A torn-down demo SHOULD be unreachable; checking it would report the
  // success of teardown as a failure of the demo.
  if (state.demoTornDownAt)
    return { ...base, verdict: "ok", detail: `torn down ${state.demoTornDownAt.slice(0, 10)}` };

  let landingStatus: number | undefined;
  if (state.landingUrl) {
    landingStatus = await probe.head(state.landingUrl);
    if (landingStatus === undefined)
      return { ...base, landingStatus, verdict: "unreachable", detail: "landing worker did not respond" };
    if (landingStatus >= 500)
      return { ...base, landingStatus, verdict: "unreachable", detail: `landing worker returned ${landingStatus}` };
    if (landingStatus >= 400 && landingStatus !== 401)
      return { ...base, landingStatus, verdict: "unreachable", detail: `landing worker returned ${landingStatus}` };
  }

  let servedBy: string | undefined;
  if (state.releaseId) {
    // A run that records its environment is checked against THAT one only:
    // probing the other would report a false "served" if ids ever collided, and
    // it doubles the request count for every healthy demo.
    const bases = state.apiUrl ? [state.apiUrl] : API_BASES;
    for (const b of bases) {
      if (await probe.bootstrap(b, state.releaseId)) {
        servedBy = b;
        break;
      }
    }
    if (!servedBy)
      return {
        ...base,
        landingStatus,
        verdict: "dark",
        detail: state.apiUrl
          ? `release does not bootstrap at ${state.apiUrl} — the page loads but the chat is dead`
          : "release does not bootstrap on staging OR production — the page loads but the chat is dead",
      };
  }

  // Can a visitor actually chat? Only asked when the caller opts in, because
  // it costs a request against the release's own per-day budget — see
  // selectChatProbeSlice.
  //
  // Deliberately AFTER the bootstrap check: if the release does not serve at
  // all, `dark` is the truer verdict and the chat probe would only restate it.
  if (opts.chat && probe.chat && state.releaseId && (servedBy || state.apiUrl)) {
    const result = await probe.chat(servedBy ?? state.apiUrl!, state.releaseId);
    if (result.kind === "blocked")
      return {
        ...base,
        landingStatus,
        releaseServedBy: servedBy,
        verdict: "chat-blocked",
        detail:
          `chat endpoint refused a visitor (HTTP ${result.status}` +
          (result.retryAfterSeconds ? `, retry-after ${result.retryAfterSeconds}s` : "") +
          ") — the page loads and the release serves, but nobody can send a message" +
          // A refusal measured in hours is a BAN, not a rate limit: every
          // limiter on that route caps its block at an hour. Saying so here is
          // the difference between "wait a bit" and "go clear a Redis key".
          (result.retryAfterSeconds && result.retryAfterSeconds > 3600
            ? ". That is longer than any rate limit on that route lasts, so it is a BAN"
            : ""),
      };
    if (result.kind === "error")
      return {
        ...base,
        landingStatus,
        releaseServedBy: servedBy,
        verdict: "chat-error",
        detail: `chat endpoint ${result.status ? `returned HTTP ${result.status}` : "did not answer"}`,
      };
  }

  // The unfurl card. Checked by CONTENT-TYPE and SIZE, never by status code:
  // the original failure was an og:image naming an /og.png that did not exist,
  // and the worker's single-page-app fallback answered it with index.html and
  // HTTP 200. A status check would have called that healthy for months — which
  // is precisely what happened, on every demo this pipeline has ever built.
  //
  // Computed BEFORE the `open` verdict below, not after. An open demo is the
  // one being handed to a customer, so its share link is the one that matters
  // most — returning early on `open` would skip the card check on exactly the
  // demo we most need it for.
  let cardProblem: string | undefined;
  if (state.landingUrl) {
    const auth = state.landingBasicAuthPassword
      ? `${state.landingBasicAuthUser ?? "preview"}:${state.landingBasicAuthPassword}`
      : undefined;
    const card = await probe.asset(`${state.landingUrl.replace(/\/$/, "")}/og.png`, auth);
    // `undefined` means the request itself failed — a network blip must not be
    // reported as a broken card, since the landing page already answered above.
    if (card && (!card.contentType.startsWith("image/png") || card.bytes < 5_000)) {
      cardProblem = card.contentType.startsWith("image/png")
        ? `og.png is only ${card.bytes}b — shared links will unfurl blank`
        : `og.png serves ${card.contentType || "nothing"}, not an image — shared links will unfurl blank`;
    }

    // The same trap, one directory over.
    //
    // The worker serves `not_found_handling = "single-page-application"`, so a
    // MISSING asset returns 200 with the HTML shell — a broken hero or a dead
    // video well is indistinguishable from a working one by status code alone.
    // acmeincubator shipped with /brand/corpus.webm returning `200 text/html` after a
    // transient R2 upload failure, and the design review did not notice: an
    // empty video reads as a design choice.
    //
    // Only same-origin /brand/* paths are probed. Media hosted on R2 is a
    // different origin with its own real 404s, so a status code there means
    // what it says.
    // …but only for media the page actually REFERENCES.
    //
    // These paths used to be probed unconditionally. That was right while the
    // template hardcoded `heroImage: "/brand/hero.webp"`, so every demo asked
    // for the file whether or not it had one. Since the template stopped
    // emitting a hero it has no image for, an absent hero.webp is the CORRECT
    // state — and probing it flagged 31 of 56 healthy demos as `no-unfurl`,
    // for an image none of their pages request. A monitor that fires on more
    // than half a healthy fleet is one nobody reads.
    //
    // `undefined` html means we could not read the page (a network blip, or a
    // probe that does not implement it). Then we probe anyway: an unverifiable
    // reference must not silence a real defect.
    const pageHtml = await probe.html?.(state.landingUrl, auth);
    for (const [name, path] of [
      ["hero image", "/brand/hero.webp"],
      ["corpus video", "/brand/corpus.webm"],
    ] as const) {
      if (cardProblem) break;
      if (pageHtml !== undefined && !pageHtml.includes(path)) continue;
      const a = await probe.asset(`${state.landingUrl.replace(/\/$/, "")}${path}`, auth);
      if (a && a.contentType.startsWith("text/html"))
        cardProblem = `${path} serves HTML, not media — ${name} is MISSING and the SPA fallback is hiding it`;
    }
  }

  // Gate configured but not enforced: credentials recorded, yet the page serves
  // without a challenge. This is the regression shape worth catching, and it
  // outranks a broken card — so the card is reported in the detail instead of
  // being lost.
  if (landingStatus === 200 && state.landingBasicAuthPassword)
    return {
      ...base,
      landingStatus,
      releaseServedBy: servedBy,
      verdict: "open",
      detail:
        "serves 200 with NO auth challenge although a preview password is recorded" +
        (cardProblem ? `; also: ${cardProblem}` : ""),
    };

  if (cardProblem)
    return { ...base, landingStatus, releaseServedBy: servedBy, verdict: "no-unfurl", detail: cardProblem };

  return {
    ...base,
    landingStatus,
    releaseServedBy: servedBy,
    verdict: "ok",
    detail: `landing ${landingStatus ?? "n/a"}${servedBy ? `, release served by ${servedBy.replace("https://", "")}` : ""}`,
  };
}

/**
 * Verdicts that should fail a scheduled run. `open` is reported, not failed.
 *
 * `no-unfurl` is NOT failing: a blank share preview is a marketing defect, not
 * an outage, and paging on it would dilute the signal that a demo is dark.
 * It is surfaced in the report so it gets fixed on the next build.
 */
export const FAILING_VERDICTS: DemoVerdict[] = [
  "dark", "unreachable", "gate-broken",
  // A demo whose chat is refused is dark to a prospect, however well the page
  // renders. This is the verdict the 2026-08-18 outage needed and nothing had.
  "chat-blocked", "chat-error",
];

/**
 * How many loop ticks it takes to chat-probe the whole fleet.
 *
 * ⚠️ THIS NUMBER IS A BUDGET, not a preference. The API caps anonymous chat at
 * 600 requests per DAY per client address, and every probe from this host
 * spends that same budget — as does every other agent and script on this
 * machine that touches the endpoint. Probing all ~87 demos on an hourly loop
 * would be ~2,088 requests a day: the monitor would trip the limiter it exists
 * to watch, and then report the whole fleet as blocked. That failure would look
 * exactly like a real outage.
 *
 * At 8 ticks the fleet is covered every 8 hours for ~260 requests a day, which
 * leaves most of the ceiling for everything else. Raise it (slower, cheaper) or
 * lower it (faster, dearer) with that ceiling in hand — not by taste.
 */
export const CHAT_PROBE_COVERAGE_TICKS = 8;

/**
 * The slice of the fleet to chat-probe on a given tick. Deterministic and pure,
 * so the rotation is testable rather than something we assume works.
 */
export function selectChatProbeSlice<T>(
  demos: T[],
  tickIndex: number,
  coverageTicks: number = CHAT_PROBE_COVERAGE_TICKS,
): T[] {
  const ticks = Math.max(1, Math.floor(coverageTicks));
  if (demos.length === 0) return [];
  const slot = ((Math.floor(tickIndex) % ticks) + ticks) % ticks;
  // Contiguous slices, sized so every demo lands in exactly one slot and the
  // last slot absorbs the remainder — no demo is skipped and none is probed
  // twice per cycle.
  const size = Math.ceil(demos.length / ticks);
  return demos.slice(slot * size, (slot + 1) * size);
}

export function summarize(results: DemoHealth[]): { failing: DemoHealth[]; open: DemoHealth[] } {
  return {
    failing: results.filter((r) => FAILING_VERDICTS.includes(r.verdict)),
    open: results.filter((r) => r.verdict === "open"),
  };
}
