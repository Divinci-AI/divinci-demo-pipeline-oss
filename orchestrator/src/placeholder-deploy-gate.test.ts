/**
 * The pre-deploy placeholder gate.
 *
 * A demo went live on 2026-08-28 reading "Acme Expert" in its <title>, og:
 * tags, corpus headline, chat input placeholder and all three conversation
 * starters — under the prospect's own demo host, ready to send.
 *
 * Every existing guard behaved exactly as written and none of them stopped it:
 *
 *  - The copy generator failed, so no `en.draft.ts` was written at all. landing.ts's
 *    loud "generated en.ts REJECTED" only fires when a draft EXISTS and
 *    mismatches — the absent-draft path was silent.
 *  - That prospect's PREVIOUS run had good copy. The rebuild
 *    overwrote a correct live demo with the neutral template.
 *  - `demo-preflight` DID detect it, twice, blocking — but preflight runs at
 *    outreach, which is after the deploy. Nobody was emailed; the placeholder
 *    page was public regardless.
 *
 * So the gate here reads the BUILT pages rather than any input, and runs
 * immediately before the deploy. A gate on SENDING is not a gate on
 * PUBLISHING — that is the whole point, and the reason this is a separate
 * check rather than an earlier call to preflight.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertNoPlaceholderCopy, visibleText } from "./landing.js";

let siteDir: string;
const dist = () => join(siteDir, "dist");
const page = (rel: string, html: string) => {
  const full = join(dist(), rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, html);
};

beforeEach(() => {
  siteDir = mkdtempSync(join(tmpdir(), "gate-"));
  mkdirSync(dist(), { recursive: true });
});
afterEach(() => rmSync(siteDir, { recursive: true, force: true }));

describe("assertNoPlaceholderCopy", () => {
  it("passes a fully branded build", () => {
    page("index.html", "<title>Acme Lasers AI</title><button>What products do you make?</button>");
    expect(() => assertNoPlaceholderCopy(siteDir)).not.toThrow();
  });

  it("blocks the exact page that shipped — placeholder in a conversation starter", () => {
    // The shape that shipped: the starter pills were the last thing anyone
    // looked at, because the H1 was correctly branded from brand.config.ts
    // while en.ts was untouched.
    page(
      "index.html",
      '<h1>Acme Lasers AI</h1>' +
        '<button class="starter-pill">What does Acme Expert specialize in?</button>',
    );
    expect(() => assertNoPlaceholderCopy(siteDir)).toThrow(/DEPLOY BLOCKED/);
  });

  it("names the file and quotes the offending text, so the log is actionable", () => {
    page("fr/index.html", "<title>Acme Expert AI — answers 24/7</title>");
    expect(() => assertNoPlaceholderCopy(siteDir)).toThrow(/fr\/index\.html/);
    expect(() => assertNoPlaceholderCopy(siteDir)).toThrow(/Acme Expert AI/);
  });

  it("scans LOCALE pages too, not just the homepage", () => {
    // Translation happens after the copy is applied, so a failed generation
    // reaches every /<code>/ page. The French build is exactly as public as
    // the English one.
    page("index.html", "<title>Acme Lasers AI</title>");
    page("de/index.html", "<p>Lorem ipsum dolor sit amet</p>");
    expect(() => assertNoPlaceholderCopy(siteDir)).toThrow(/de\/index\.html/);
  });

  it("counts every affected page, not just the first", () => {
    page("index.html", "<p>Acme Expert</p>");
    page("es/index.html", "<p>Acme Expert</p>");
    page("ja/index.html", "<p>Acme Expert</p>");
    expect(() => assertNoPlaceholderCopy(siteDir)).toThrow(/3 of 3 built page\(s\)/);
  });

  it("ignores non-HTML build output", () => {
    // The template's own source comments say "Acme Expert" by design, and a
    // sourcemap or JS chunk can carry them. Only what a visitor reads counts.
    writeFileSync(join(dist(), "bundle.js"), '/* placeholder: Acme Expert */');
    page("index.html", "<title>Acme Lasers AI</title>");
    expect(() => assertNoPlaceholderCopy(siteDir)).not.toThrow();
  });

  it("does not fire on the email field's placeholder= ATTRIBUTE", () => {
    // The first version of this gate matched raw HTML and refused EVERY
    // deploy: /\bplaceholder\b/i hits `placeholder="you@example.com"`, which
    // is on every page the template builds, healthy ones included. A guard
    // that grounds the fleet is worse than the defect it was written for.
    page(
      "index.html",
      '<title>Acme Lasers AI</title>' +
        '<input type="email" placeholder="you@example.com" class="rounded" />' +
        '<button class="starter-pill">What products do you make?</button>',
    );
    expect(() => assertNoPlaceholderCopy(siteDir)).not.toThrow();
  });

  it("ignores placeholder words inside <script> and <style>", () => {
    page(
      "index.html",
      '<title>Acme Lasers AI</title>' +
        '<script>const TODO_placeholder = "Acme Expert";</script>' +
        '<style>/* lorem ipsum */</style>',
    );
    expect(() => assertNoPlaceholderCopy(siteDir)).not.toThrow();
  });

  it("still sees text that only markup separated", () => {
    // The starter pill is one text node inside a button inside a div; the
    // stripper must not fuse words across tags into something unmatchable.
    page("index.html", "<div><button>What does <b>Acme</b> Expert specialize in?</button></div>");
    expect(() => assertNoPlaceholderCopy(siteDir)).toThrow(/DEPLOY BLOCKED/);
  });

  it("does not invent a failure when there is no build to read", () => {
    // A missing dist/ is a build problem and belongs to the build step. A gate
    // that also claimed a copy defect here would send people to the wrong fix
    // — misdirection that costs far more than the missing check.
    rmSync(dist(), { recursive: true, force: true });
    expect(() => assertNoPlaceholderCopy(siteDir)).not.toThrow();
  });
});

/**
 * The gate is only a gate if it is CALLED.
 *
 * Everything above tests the function in isolation, so deleting its one call
 * site would leave all of it green while the demo it exists for ships again.
 * That is the same shape as the defect itself: a check that runs, reports
 * correctly, and sits downstream of the thing it was meant to stop.
 */
const LANDING_TS = readFileSync(new URL("./landing.ts", import.meta.url), "utf8");

describe("the gate is wired into the deploy path", () => {
  it("buildAndDeployLanding calls assertNoPlaceholderCopy", () => {
    expect(LANDING_TS).toMatch(/^\s*assertNoPlaceholderCopy\(siteDir\);/m);
  });

  it("calls it BEFORE the deploy, not after", () => {
    const gate = LANDING_TS.search(/^\s*assertNoPlaceholderCopy\(siteDir\);/m);
    const deploy = LANDING_TS.indexOf("await host.deploy(");
    expect(gate).toBeGreaterThan(-1);
    expect(deploy).toBeGreaterThan(-1);
    // A gate downstream of the deploy is exactly the bug: demo-preflight
    // detected this correctly and still let the page go public, because it
    // ran at outreach.
    expect(gate).toBeLessThan(deploy);
  });

  it("runs after the build, so there is a dist/ to read", () => {
    const build = LANDING_TS.indexOf('["run", "build"]');
    const gate = LANDING_TS.search(/^\s*assertNoPlaceholderCopy\(siteDir\);/m);
    expect(build).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(build);
  });
});
