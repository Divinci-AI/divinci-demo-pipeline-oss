/**
 * Auth preflight for unattended runs.
 *
 * WHAT WE FOUND. The README says the OAuth session "lasts ~a day; re-run when
 * it expires", which implied a nightly loop could not survive. It is outdated:
 * the CLI's `ensureValidToken` (sdk/packages/cli/src/config/config-manager.ts)
 * refreshes the access token whenever under 5 minutes remain, persists the
 * result, and carries forward a rotated refresh token. So an unattended loop
 * CAN run indefinitely — until the refresh token itself is revoked or expires,
 * which is the one case a human must fix.
 *
 * Two things therefore need checking before a run spends anything:
 *
 *  1. Can we still authenticate? Probed by making a real authenticated call,
 *     which is what forces the refresh. Checking `expiresAt` in the credential
 *     file alone proves nothing — it is the refresh that can fail, and it fails
 *     at call time.
 *
 *  2. Does the session point at the environment this run targets? The stored
 *     `default` profile points at PRODUCTION while the pipeline's own default
 *     API base is staging. A run in that state creates the workspace on prod
 *     and then probes staging for the release — which is exactly how one demo
 *     came to read "available" on the admin path and 404 on the public one.
 *     Silent cross-environment drift is worse than a refusal to start.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const execFileP = promisify(execFile);

/** Mirrors the CLI's own path (cli/src/config/credentials.ts). */
export const CREDENTIALS_PATH = join(homedir(), ".config", "divinci", "credentials.json");

export interface StoredProfile {
  apiUrl?: string;
  authType?: string;
  expiresAt?: string;
  email?: string;
  refreshToken?: string;
}

export interface AuthVerdict {
  ok: boolean;
  /** True when no automated retry can help — a human must run `divinci auth login`. */
  needsHuman: boolean;
  reason?: string;
  profile: string;
  apiUrl?: string;
  email?: string;
  expiresAt?: string;
  minutesRemaining?: number;
}

/** Read the credential file without mutating it. Returns null when absent. */
export function readCredentials(path = CREDENTIALS_PATH): {
  defaultProfile?: string;
  profiles?: Record<string, StoredProfile>;
} | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as {
      defaultProfile?: string;
      profiles?: Record<string, StoredProfile>;
    };
  } catch {
    return null;
  }
}

/** Compare API bases ignoring a trailing slash. */
export function sameApiBase(a?: string, b?: string): boolean {
  const norm = (u?: string) => (u ?? "").trim().replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b) && norm(a) !== "";
}

export function minutesUntil(iso?: string, now = Date.now()): number | undefined {
  if (!iso) return undefined;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? undefined : Math.round((t - now) / 60_000);
}

/**
 * Verify the pipeline can authenticate, and that it is pointed where the run
 * expects. `expectApiUrl` should be the same base the run's other checks use
 * (DIVINCI_API_URL) — pass it and a cross-environment run cannot start.
 */
export async function checkAuth(
  opts: {
    profile?: string;
    expectApiUrl?: string;
    probe?: () => Promise<void>;
    /** Override for tests; defaults to the CLI's real credential file. */
    credentialsPath?: string;
  } = {},
): Promise<AuthVerdict> {
  const credentialsPath = opts.credentialsPath ?? CREDENTIALS_PATH;
  const creds = readCredentials(credentialsPath);
  if (!creds) {
    return {
      ok: false,
      needsHuman: true,
      profile: opts.profile ?? "default",
      reason: `no credential file at ${credentialsPath} — run \`divinci auth login\``,
    };
  }

  const profileName = opts.profile ?? creds.defaultProfile ?? "default";
  const profile = creds.profiles?.[profileName];
  if (!profile) {
    return {
      ok: false,
      needsHuman: true,
      profile: profileName,
      reason: `profile "${profileName}" is not in ${credentialsPath}`,
    };
  }

  const base = {
    profile: profileName,
    apiUrl: profile.apiUrl,
    email: profile.email,
    expiresAt: profile.expiresAt,
    minutesRemaining: minutesUntil(profile.expiresAt),
  };

  // Environment agreement is checked BEFORE the live probe: a probe against the
  // wrong environment succeeds, which is the whole danger.
  if (opts.expectApiUrl && !sameApiBase(profile.apiUrl, opts.expectApiUrl)) {
    return {
      ...base,
      ok: false,
      needsHuman: true,
      reason:
        `profile "${profileName}" is authenticated against ${profile.apiUrl} but this run targets ` +
        `${opts.expectApiUrl}. Point them at the same environment (set DIVINCI_API_URL, or use ` +
        `--profile / \`divinci auth login --api-url\`) — a cross-environment run builds the demo in ` +
        `one place and checks for it in another.`,
    };
  }

  if (profile.authType === "oauth" && !profile.refreshToken) {
    return {
      ...base,
      ok: false,
      needsHuman: true,
      reason: `profile "${profileName}" has no refresh token — the session cannot renew itself unattended`,
    };
  }

  // The live probe. This is the step that actually exercises the refresh, so a
  // stale-but-refreshable session is repaired here rather than failing mid-run
  // after the pipeline has already spent money.
  try {
    if (opts.probe) await opts.probe();
    else
      await execFileP("divinci", ["workspace", "list", "--no-color", "--json"], {
        timeout: 90_000,
        maxBuffer: 32 * 1024 * 1024,
      });
  } catch (err) {
    const msg = (err as Error).message ?? "";
    const expired = /session expired|auth login|401|unauthor/i.test(msg);
    return {
      ...base,
      ok: false,
      needsHuman: expired,
      reason: expired
        ? `session cannot be renewed (\`divinci auth login\` required): ${msg.split("\n")[0]}`
        : `auth probe failed: ${msg.split("\n")[0]}`,
    };
  }

  // Re-read: a refresh during the probe rewrites expiresAt.
  const after = readCredentials(credentialsPath)?.profiles?.[profileName];
  return {
    ...base,
    expiresAt: after?.expiresAt ?? profile.expiresAt,
    minutesRemaining: minutesUntil(after?.expiresAt ?? profile.expiresAt),
    ok: true,
    needsHuman: false,
  };
}

export function formatVerdict(v: AuthVerdict): string {
  if (v.ok)
    return `auth: ok — profile "${v.profile}" (${v.email ?? "?"}) → ${v.apiUrl ?? "?"}, valid ${v.minutesRemaining ?? "?"} min`;
  return `auth: FAILED — ${v.reason}`;
}
