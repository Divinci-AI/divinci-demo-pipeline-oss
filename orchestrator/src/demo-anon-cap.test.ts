import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { DEMO_ANON_MESSAGE_CAP } from "./landing.js";

/**
 * A demo prospect got ONE message before the release cut them off — the
 * platform default. `maxAnonymousChatMessages` sat in configureDemoRelease's
 * `keep` list, which only PRESERVES a value that is already set, so it was
 * never set at all and every demo shipped at 1.
 */
describe("demo anonymous-message cap", () => {
  it("is high enough for a real evaluation, not the platform default of 1", () => {
    expect(DEMO_ANON_MESSAGE_CAP).toBeGreaterThanOrEqual(20);
  });

  it("is SET on the release body, not merely preserved", () => {
    const src = readFileSync(new URL("./landing.ts", import.meta.url), "utf8");
    // The `keep` list is a preserve-if-present mechanism; a cap that appears
    // ONLY there is the bug this test exists to prevent coming back.
    expect(src).toContain("body.maxAnonymousChatMessages = DEMO_ANON_MESSAGE_CAP");
  });
});
