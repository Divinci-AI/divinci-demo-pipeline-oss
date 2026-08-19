// Reuse the `divinci` CLI's OAuth session rather than introducing a credential.
//
// The pipeline already authenticates by running `divinci auth login` once, and
// the CLI's session RENEWS ITSELF — so reading its store means this target
// inherits a working, self-refreshing credential and adds no new secret to
// manage, rotate or leak.
//
// ⚠️ Never print a token. Not the value, not a prefix, not a length in a
// context where the value is nearby. Agent transcripts are a credential store
// nobody audits, and this repository has already had to rotate keys that
// reached one.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CREDENTIALS_PATH = path.join(os.homedir(), ".config", "divinci", "credentials.json");

export class NotAuthenticatedError extends Error {
  constructor(message) {
    super(`${message}\n\nRun:  divinci auth login`);
    this.name = "NotAuthenticatedError";
  }
}

/**
 * Resolve the API base and bearer for a profile.
 *
 * `DIVINCI_TOKEN` overrides the store — for CI, or for a token minted some
 * other way. It carries no apiUrl, so `DIVINCI_API_URL` must accompany it or
 * the platform default applies.
 */
// `credentialsPath` is injectable so the tests exercise the real branches
// instead of whatever happens to be in the developer's home directory — a
// test that silently skips on the machine it runs on proves nothing.
export function resolveSession({ profile, env = process.env, credentialsPath = CREDENTIALS_PATH } = {}) {
  if (env.DIVINCI_TOKEN) {
    return {
      apiUrl: env.DIVINCI_API_URL || "https://api.divinci.app",
      token: env.DIVINCI_TOKEN,
      source: "DIVINCI_TOKEN",
      email: null,
    };
  }

  let file;
  try {
    file = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
  } catch {
    throw new NotAuthenticatedError(`No CLI session at ${credentialsPath}.`);
  }

  const name = profile || env.DIVINCI_PROFILE || file.defaultProfile || "default";
  const p = file.profiles?.[name];
  if (!p?.accessToken) {
    const available = Object.keys(file.profiles ?? {});
    throw new NotAuthenticatedError(
      `Profile "${name}" has no access token.` +
        (available.length ? ` Available profiles: ${available.join(", ")}.` : ""),
    );
  }

  // Expiry is checked here so the failure names the cause. Without it, an
  // expired session surfaces as a 401 from local-sync partway through a push,
  // which reads as a permissions problem with the whitelabel.
  if (p.expiresAt && Date.parse(p.expiresAt) <= Date.now()) {
    throw new NotAuthenticatedError(
      `Session for profile "${name}" expired at ${p.expiresAt}.`,
    );
  }

  return {
    apiUrl: env.DIVINCI_API_URL || p.apiUrl || "https://api.divinci.app",
    token: p.accessToken,
    source: `profile:${name}`,
    email: p.email ?? null,
  };
}

/** A one-line description safe to print. Never includes the token. */
export function describeSession(s) {
  return `${s.source}${s.email ? ` (${s.email})` : ""} → ${s.apiUrl}`;
}
