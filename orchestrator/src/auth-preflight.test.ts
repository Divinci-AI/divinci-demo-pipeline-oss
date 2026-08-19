import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAuth, readCredentials, sameApiBase, minutesUntil } from "./auth-preflight.js";

const dirs: string[] = [];
function credFile(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "divinci-creds-"));
  dirs.push(dir);
  const p = join(dir, "credentials.json");
  writeFileSync(p, JSON.stringify(contents));
  return p;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const PROD = "https://api.divinci.app";
const STAGE = "https://api.stage.divinci.app";

function creds(overrides: Record<string, unknown> = {}) {
  return {
    defaultProfile: "default",
    profiles: {
      default: {
        apiUrl: PROD,
        authType: "oauth",
        refreshToken: "rt",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        email: "mike@divinci.ai",
        ...overrides,
      },
    },
  };
}

describe("sameApiBase", () => {
  it("ignores a trailing slash", () => {
    expect(sameApiBase(`${PROD}/`, PROD)).toBe(true);
  });
  it("does not treat staging and prod as the same", () => {
    expect(sameApiBase(STAGE, PROD)).toBe(false);
  });
  it("treats two empty values as NOT matching — absence is not agreement", () => {
    expect(sameApiBase(undefined, undefined)).toBe(false);
  });
});

describe("minutesUntil", () => {
  it("returns negative minutes for a past expiry", () => {
    expect(minutesUntil(new Date(Date.now() - 600_000).toISOString())!).toBeLessThan(0);
  });
  it("is undefined for an unparseable date", () => {
    expect(minutesUntil("not-a-date")).toBeUndefined();
  });
});

describe("readCredentials", () => {
  it("returns null rather than throwing on corrupt JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "divinci-creds-"));
    dirs.push(dir);
    const p = join(dir, "credentials.json");
    writeFileSync(p, "{ not json");
    expect(readCredentials(p)).toBeNull();
  });
});

describe("checkAuth", () => {
  it("REFUSES a cross-environment run WITHOUT probing", async () => {
    // The acmebio shape: session on prod, run targeting staging. The probe
    // would SUCCEED here, which is exactly why the check must come first — a
    // green probe against the wrong environment is the failure mode.
    let probed = false;
    const v = await checkAuth({
      credentialsPath: credFile(creds({ apiUrl: PROD })),
      expectApiUrl: STAGE,
      probe: async () => {
        probed = true;
      },
    });
    expect(v.ok).toBe(false);
    expect(v.needsHuman).toBe(true);
    expect(probed).toBe(false);
    expect(v.reason).toContain(STAGE);
    expect(v.reason).toContain(PROD);
  });

  it("passes when the probe succeeds and environments agree", async () => {
    const v = await checkAuth({
      credentialsPath: credFile(creds()),
      expectApiUrl: PROD,
      probe: async () => {},
    });
    expect(v.ok).toBe(true);
    expect(v.needsHuman).toBe(false);
    expect(v.email).toBe("mike@divinci.ai");
  });

  it("marks a 401 from the probe as needing a human", async () => {
    const v = await checkAuth({
      credentialsPath: credFile(creds()),
      probe: async () => {
        throw new Error("Session expired. Run `divinci auth login` to re-authenticate.");
      },
    });
    expect(v.ok).toBe(false);
    expect(v.needsHuman).toBe(true);
  });

  it("does NOT demand a human for a transient network failure", async () => {
    // A DNS blip must not page someone to re-run an interactive login — the
    // loop should just retry on the next tick.
    const v = await checkAuth({
      credentialsPath: credFile(creds()),
      probe: async () => {
        throw new Error("getaddrinfo ENOTFOUND api.divinci.app");
      },
    });
    expect(v.ok).toBe(false);
    expect(v.needsHuman).toBe(false);
  });

  it("refuses an oauth profile with no refresh token — it cannot renew unattended", async () => {
    const v = await checkAuth({
      credentialsPath: credFile(creds({ refreshToken: undefined })),
      probe: async () => {},
    });
    expect(v.ok).toBe(false);
    expect(v.needsHuman).toBe(true);
    expect(v.reason).toContain("refresh token");
  });

  it("reports an unknown profile as needing a human", async () => {
    const v = await checkAuth({
      credentialsPath: credFile(creds()),
      profile: "nope",
      probe: async () => {},
    });
    expect(v.ok).toBe(false);
    expect(v.needsHuman).toBe(true);
  });

  it("reports a missing credential file as needing a human", async () => {
    const v = await checkAuth({
      credentialsPath: "/tmp/definitely/not/here/credentials.json",
      probe: async () => {},
    });
    expect(v.ok).toBe(false);
    expect(v.needsHuman).toBe(true);
  });

  it("reports the REFRESHED expiry, not the pre-probe one", async () => {
    // The probe is what triggers ensureValidToken, so the verdict must reflect
    // the file as it stands afterwards — otherwise it reports a stale expiry.
    const path = credFile(creds({ expiresAt: new Date(Date.now() + 60_000).toISOString() }));
    const later = new Date(Date.now() + 86_400_000).toISOString();
    const v = await checkAuth({
      credentialsPath: path,
      probe: async () => {
        writeFileSync(path, JSON.stringify(creds({ expiresAt: later })));
      },
    });
    expect(v.ok).toBe(true);
    expect(v.expiresAt).toBe(later);
    expect(v.minutesRemaining!).toBeGreaterThan(60);
  });
});

describe("credential fixtures (shape the preflight relies on)", () => {
  it("reads profile fields from a written file", () => {
    const p = credFile(creds());
    const c = readCredentials(p);
    expect(c?.profiles?.default.apiUrl).toBe(PROD);
    expect(c?.profiles?.default.refreshToken).toBe("rt");
  });

  it("a profile with no refresh token cannot renew unattended", () => {
    const p = credFile(creds({ refreshToken: undefined }));
    expect(readCredentials(p)?.profiles?.default.refreshToken).toBeUndefined();
  });
});
