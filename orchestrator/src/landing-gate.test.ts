import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The preview gate cost a deal on 2026-08-13.
 *
 * Acme Bio's contact opened her demo during a scheduled call, hit a
 * password prompt, and could not show it to her manager. The project slipped.
 * A scan the next day found 61 of 70 deployed demos were behind a password —
 * not an accident on one run, the default state of the entire fleet.
 *
 * The mechanism: credentials were minted on every run and persisted in
 * state.json, and EVERY landing deploy re-applied them. Unlocking by hand never
 * stuck, because the next deploy put the secret straight back. The gate
 * defended against a stranger guessing an unguessable URL — a hypothetical —
 * and was paid for with repeated customer-facing outages.
 *
 * These tests read source text, so they prove the shape of the code and not its
 * behaviour. That is worth having anyway: every regression here would be a
 * one-line default flip, which is exactly what text can catch.
 */
const landing = readFileSync(new URL("./landing.ts", import.meta.url), "utf8");
const run = readFileSync(new URL("./run.ts", import.meta.url), "utf8");
const host = readFileSync(new URL("./landing-host.ts", import.meta.url), "utf8");

describe("the preview gate is OFF by default", () => {
  it("gates on an explicit opt-in, never on the absence of an opt-out", () => {
    // The old shape was `const publicDemo = env.LANDING_PUBLIC === "1"` with the
    // gate applied whenever that was false — i.e. always, by default.
    expect(landing).toMatch(/LANDING_GATE === "1"/);
    expect(landing).not.toMatch(/const publicDemo = process\.env\.LANDING_PUBLIC === "1"/);
  });

  it("clears a stale gate on EVERY deploy that is not deploying one", () => {
    // This is the half that actually fixes the incident. Previously the secrets
    // were deleted only when LANDING_PUBLIC=1 was passed, so a demo unlocked
    // once and redeployed later came back locked.
    const idx = landing.indexOf("if (!wantsGate)");
    expect(idx, "the clear must be conditioned on !wantsGate, not on LANDING_PUBLIC").toBeGreaterThan(0);
    const block = landing.slice(idx, idx + 700);
    expect(block).toMatch(/BASIC_AUTH_PASSWORD/);
    expect(block).toMatch(/BASIC_AUTH_USERNAME/);

    // The deletion itself moved behind the LandingHost seam, so landing.ts now
    // states the INTENT and the host supplies the mechanism. Assert both ends:
    // an intent with no implementation would clear nothing, and this test
    // exists because "nothing was cleared" is invisible until a customer hits a
    // password prompt on a demo that was already unlocked.
    expect(block, "the clear must go through the host, not a hardcoded CLI")
      .toMatch(/host\.clearSecret/);
  });

  it("every LandingHost actually removes the secret in clearSecret", () => {
    // The other end of the seam. A host whose clearSecret is a no-op would
    // re-lock a demo exactly as the original bug did, and landing.ts could not
    // tell.
    const cf = host.slice(host.indexOf("class CloudflareLandingHost"), host.indexOf("class VercelLandingHost"));
    const vc = host.slice(host.indexOf("class VercelLandingHost"));
    // ⚠️ Find the METHOD, not the first mention. `setSecret` calls
    // `this.clearSecret` first (Vercel's `env add` fails on an existing name
    // rather than replacing it), so indexOf("clearSecret") lands on that call
    // and slices the wrong body — which is how the first version of this test
    // failed against correct code.
    const bodyOf = (src: string) => {
      const i = src.indexOf("async clearSecret(");
      expect(i, "clearSecret must be declared").toBeGreaterThan(-1);
      return src.slice(i, i + 700);
    };
    expect(bodyOf(cf)).toMatch(/secret", "delete"/);
    expect(bodyOf(vc)).toMatch(/"env", "rm"/);

    // Both must swallow "was not set" — it is indistinguishable from a failed
    // delete, and throwing there would fail a deploy that is doing the right
    // thing on a demo that never had a gate.
    for (const [name, src] of [["cloudflare", cf], ["vercel", vc]] as const) {
      expect(bodyOf(src), `${name} clearSecret must tolerate a secret that was never set`)
        .toMatch(/catch/);
    }
  });

  it("does not mint or persist credentials unless a gate was asked for", () => {
    // Persisted credentials are what made the silent re-lock possible: they
    // outlive the run that created them and get re-exported on every deploy.
    const idx = run.indexOf("state.landingBasicAuthUser ??=");
    expect(idx).toBeGreaterThan(0);
    const before = run.slice(Math.max(0, idx - 400), idx);
    expect(before, "minting must sit behind an explicit LANDING_GATE check")
      .toMatch(/LANDING_GATE === "1"/);
  });

  it("actively deletes credentials a pre-fix run persisted", () => {
    // 81 runs already carry landingBasicAuthPassword in state.json. Without
    // this, redeploying any one of them resurrects its gate.
    expect(run).toMatch(/delete state\.landingBasicAuthPassword/);
    expect(run).toMatch(/delete state\.landingBasicAuthUser/);
  });

  it("still honours LANDING_PUBLIC=1 so existing scripts keep working", () => {
    expect(landing).toMatch(/LANDING_PUBLIC/);
  });

  it("carries a warning against reinstating a default-on gate", () => {
    // The next person to add "just a little protection" needs to find the
    // incident before they find the config.
    expect(landing).toMatch(/DO NOT REINSTATE A DEFAULT-ON GATE/i);
  });
});
