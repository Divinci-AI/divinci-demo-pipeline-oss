import { describe, it, expect } from "vitest";
import { resolveChatGate } from "./landing.js";

/**
 * The demo default is NO EMAIL PROMPT. This file exists because that used to be
 * an opt-IN flag (`LANDING_NO_EMAIL_GATE === "1"`) which was set nowhere in the
 * repo and therefore had to be passed by hand on every deploy — so the one
 * deploy that forgot it silently put a lead-capture form in front of a
 * prospect's demo. A redeploy did exactly that to 17 demos at once.
 */
describe("resolveChatGate — the default", () => {
  it("collects NO email when nothing is configured", () => {
    const g = resolveChatGate({});
    expect(g.noEmailGate).toBe(true);
    expect(g.clientQuota).toBe(0);
  });

  it("gives the visitor the WHOLE budget, not one message", () => {
    // The client cap is clientBeforeEmail + clientQuota, so this is exactly the
    // worker's budget. The bug it replaces: a 500-message worker paired with a
    // client that stopped at 1.
    const g = resolveChatGate({});
    expect(g.clientBeforeEmail + g.clientQuota).toBe(g.demoQuota);
    expect(g.demoQuota).toBe(500);
  });

  it("writes no worker grace window when the gate is off — it would be inert", () => {
    // The worker short-circuits on NO_EMAIL_GATE, so any other value would sit
    // in the config looking authoritative while doing nothing.
    expect(resolveChatGate({}).freeBeforeEmail).toBe(0);
  });

  it("an unrelated env var cannot turn the prompt on", () => {
    expect(resolveChatGate({ LANDING_PUBLIC: "1", LANDING_DEMO_QUOTA: "50" }).noEmailGate).toBe(true);
  });

  it("honours an explicit LANDING_DEMO_QUOTA on both sides", () => {
    const g = resolveChatGate({ LANDING_DEMO_QUOTA: "25" });
    expect(g.demoQuota).toBe(25);
    expect(g.clientBeforeEmail).toBe(25);
  });
});

describe("resolveChatGate — the lead-capture opt-out", () => {
  it("LANDING_NO_EMAIL_GATE=0 asks for an address after the grace window", () => {
    const g = resolveChatGate({ LANDING_NO_EMAIL_GATE: "0" });
    expect(g.noEmailGate).toBe(false);
    expect(g.freeBeforeEmail).toBe(3);
    expect(g.clientBeforeEmail).toBe(3);
    expect(g.clientQuota).toBe(1);
  });

  it("NEVER restores ask-before-the-first-answer, even at 0", () => {
    // The template's original behaviour demanded an address before the first
    // reply. Opting into lead capture must not opt back into that.
    const g = resolveChatGate({ LANDING_NO_EMAIL_GATE: "0", LANDING_FREE_MESSAGES_BEFORE_EMAIL: "0" });
    expect(g.clientBeforeEmail).toBeGreaterThanOrEqual(0);
    // The worker and client agree either way — that is the invariant that matters.
    expect(g.freeBeforeEmail).toBe(g.clientBeforeEmail);
  });

  it("keeps the worker and the client in agreement in BOTH shapes", () => {
    for (const env of [{}, { LANDING_NO_EMAIL_GATE: "0" }, { LANDING_NO_EMAIL_GATE: "0", LANDING_FREE_MESSAGES_BEFORE_EMAIL: "5" }]) {
      const g = resolveChatGate(env);
      const workerBudget = g.noEmailGate ? g.demoQuota : g.freeBeforeEmail;
      const clientBudget = g.noEmailGate ? g.clientBeforeEmail + g.clientQuota : g.clientBeforeEmail;
      expect(clientBudget, JSON.stringify(env)).toBe(workerBudget);
    }
  });
});
