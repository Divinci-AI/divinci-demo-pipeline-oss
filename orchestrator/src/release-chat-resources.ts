/**
 * The referenced chat resources on a demo release: conversation starters, chat
 * welcome message, thread prefix, message prefix.
 *
 * These are NOT literal text on the release. The release schema stores
 * `conversationStarter: { id }`, `chatWelcomeMessage: { id }`,
 * `threadPrefix: { id }` and `msgPrefix: { id }` — references to separate
 * workspace-level RESOURCES that must be created first, each via its own
 * endpoint (`POST /white-label/:wl/conversation-starter`,
 * `.../chat-welcome-message`, `.../thread-prefix`, `.../message-prefix`).
 *
 * The pipeline never created them. `configureDemoRelease` and
 * `hardenDemoRelease` list all four keys in their `keep` arrays, which only
 * PRESERVES whatever is already on the release — so for a demo built from
 * scratch the answer was always "nothing". The landing page's own
 * `chat.fallbackWelcome` / `chat.starters` are worker-bundle copy and never
 * touch the release, so the greeting appeared on the landing page and nowhere
 * else: open the same assistant from the workspace, an embed, or the release
 * link and you got a bare chat.
 *
 * Server-side constraints, from the create handlers:
 *   - starters: 1–3 items, each a non-empty string (>3 is rejected outright)
 *   - welcome message: `{ message, active }`; `active` defaults to false, and
 *     an inactive message does not render — so it must be set true explicitly.
 *   - prefixes: both slots resolve against ONE shared WhitelabelPrefix model
 *     discriminated by `kind`, and a schema hook enforces kind↔shape —
 *     thread takes a string ARRAY, message takes a single STRING. The release
 *     validator re-checks `kind`, so a thread slot pointed at a message prefix
 *     is rejected rather than silently misbehaving.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** Release admin endpoints need the CLI's OAuth session, not an API key. */
function oauthEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.DIVINCI_API_KEY;
  return env;
}

async function api<T = Record<string, unknown>>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const args = ["api", method, path, "--no-color"];
  if (body !== undefined) args.push("--body", JSON.stringify(body));
  const { stdout } = await execFileP("divinci", args, {
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
    env: oauthEnv(),
  });
  const start = stdout.indexOf("{");
  if (start < 0) throw new Error(`divinci api ${method} ${path}: no JSON in response`);
  return JSON.parse(stdout.slice(start)) as T;
}

export interface ChatResourceInput {
  /** 1–3 prospect-facing openers. Extras are dropped (server rejects >3). */
  starters?: string[];
  /** The greeting shown before the visitor types anything. */
  welcomeMessage?: string;
  /**
   * Thread-title prefixes — `kind: "thread"`, and the payload is a string
   * ARRAY. Both prefix slots resolve against the one shared WhitelabelPrefix
   * model, and a schema hook enforces kind↔shape (thread → string[],
   * message → string), so the two are not interchangeable despite looking it.
   */
  threadPrefix?: string[];
  /** Message prefix — `kind: "message"`, payload is a single STRING. */
  msgPrefix?: string;
}

export interface ChatResourceResult {
  starterId?: string;
  welcomeMessageId?: string;
  threadPrefixId?: string;
  msgPrefixId?: string;
  /** Human-readable notes for the run log — what was created vs left alone. */
  notes: string[];
}

/**
 * Create the starter + welcome resources for a workspace and point the release
 * at them.
 *
 * NON-DESTRUCTIVE: if the release already references a resource, that reference
 * is left exactly as it is. A demo release is a thing a human may have hand-
 * tuned before sending it to a prospect, and silently replacing their greeting
 * on a re-run would be worse than doing nothing. Pass `force` to override.
 */
export async function ensureReleaseChatResources(
  workspaceId: string,
  releaseId: string,
  input: ChatResourceInput,
  opts: { force?: boolean } = {},
): Promise<ChatResourceResult> {
  const notes: string[] = [];
  const result: ChatResourceResult = { notes };

  const release = await api("GET", `/white-label/${workspaceId}/release/${releaseId}`);
  const existingStarter = (release.conversationStarter as { id?: string } | undefined)?.id;
  const existingWelcome = (release.chatWelcomeMessage as { id?: string } | undefined)?.id;

  const starters = (input.starters ?? []).map((s) => s.trim()).filter(Boolean).slice(0, 3);
  const welcome = input.welcomeMessage?.trim();

  // ---- conversation starters -------------------------------------------
  if (starters.length === 0) {
    notes.push("starters: none supplied — skipped");
  } else if (existingStarter && !opts.force) {
    notes.push(`starters: release already references ${existingStarter} — left alone`);
    result.starterId = existingStarter;
  } else {
    const created = await api("POST", `/white-label/${workspaceId}/conversation-starter`, { starters });
    const id = String(created._id ?? created.id ?? "");
    if (!id) throw new Error("conversation-starter create returned no id");
    result.starterId = id;
    notes.push(`starters: created ${id} (${starters.length})`);
  }

  // ---- welcome message --------------------------------------------------
  if (!welcome) {
    notes.push("welcome: none supplied — skipped");
  } else if (existingWelcome && !opts.force) {
    notes.push(`welcome: release already references ${existingWelcome} — left alone`);
    result.welcomeMessageId = existingWelcome;
  } else {
    // `active: true` is REQUIRED: the field defaults to false and an inactive
    // message silently does not render, which looks identical to never having
    // created one.
    const created = await api("POST", `/white-label/${workspaceId}/chat-welcome-message`, {
      message: welcome,
      active: true,
    });
    const id = String(created._id ?? created.id ?? "");
    if (!id) throw new Error("chat-welcome-message create returned no id");
    result.welcomeMessageId = id;
    notes.push(`welcome: created ${id}`);
  }

  // ---- thread + message prefixes ---------------------------------------
  // Separate endpoints, one shared model. The release validator checks the
  // referenced doc's `kind`, so a thread slot pointed at a message prefix is
  // rejected outright rather than silently misbehaving.
  const existingThread = (release.threadPrefix as { id?: string } | undefined)?.id;
  const existingMsg = (release.msgPrefix as { id?: string } | undefined)?.id;

  const threadPrefix = (input.threadPrefix ?? []).map((s) => s.trim()).filter(Boolean);
  if (threadPrefix.length === 0) {
    notes.push("threadPrefix: none supplied — skipped");
  } else if (existingThread && !opts.force) {
    notes.push(`threadPrefix: release already references ${existingThread} — left alone`);
    result.threadPrefixId = existingThread;
  } else {
    const created = await api("POST", `/white-label/${workspaceId}/thread-prefix`, { prefix: threadPrefix });
    const id = String(created._id ?? created.id ?? "");
    if (!id) throw new Error("thread-prefix create returned no id");
    result.threadPrefixId = id;
    notes.push(`threadPrefix: created ${id} (${threadPrefix.length})`);
  }

  const msgPrefix = input.msgPrefix?.trim();
  if (!msgPrefix) {
    notes.push("msgPrefix: none supplied — skipped");
  } else if (existingMsg && !opts.force) {
    notes.push(`msgPrefix: release already references ${existingMsg} — left alone`);
    result.msgPrefixId = existingMsg;
  } else {
    const created = await api("POST", `/white-label/${workspaceId}/message-prefix`, {
      prefix: msgPrefix,
      isActive: true,
    });
    const id = String(created._id ?? created.id ?? "");
    if (!id) throw new Error("message-prefix create returned no id");
    result.msgPrefixId = id;
    notes.push(`msgPrefix: created ${id}`);
  }

  // ---- point the release at them ---------------------------------------
  const needsLink =
    (result.starterId && result.starterId !== existingStarter) ||
    (result.welcomeMessageId && result.welcomeMessageId !== existingWelcome) ||
    (result.threadPrefixId && result.threadPrefixId !== existingThread) ||
    (result.msgPrefixId && result.msgPrefixId !== existingMsg);
  if (!needsLink) {
    notes.push("release: no reference change needed");
    return result;
  }

  // Echo the WHOLE release back, minus server-managed keys.
  //
  // `POST /release/:id/update` is a HYBRID: some fields are presence-guarded
  // (`if (x !== undefined)` — safe to omit) while others are assigned
  // UNCONDITIONALLY from the destructured body, so omitting one sets it to
  // undefined. `chatCTA`, `sttToolOverride`, `voiceTransport` and
  // `showRagContextTags` are in the unconditional group; the handler itself
  // carries a comment about this class of omission wiping a release's RAG
  // vectors once (the DFO "indexes=0 / no citations" regression).
  //
  // An allow-list of content fields therefore has to track an 80-field schema
  // and silently drops whatever it misses — including fields added after this
  // file was written. A DENY-list of server-managed keys is small, stable, and
  // fails in the safe direction: a new schema field is preserved by default.
  const SERVER_MANAGED = new Set([
    "_id", "__v", "id", "target", "whitelabel", "status", "version", "minorVersion",
    "whitelabelSlugVersion", "createdAt", "updatedAt", "releaseDate",
    "activeConfigHash", "activeSnapshotId", "previousSnapshotId", "autoSyncGenerated",
  ]);
  // `slug` is NOT server-managed for this purpose: castDraftBody REQUIRES it,
  // and omitting it fails the whole update with the misleading
  //   API error (400): bad form data — Json at "slug" does not exist
  // which reads like a malformed slug rather than a missing one. Caught on a
  // live release; the mocked-CLI unit tests could not have caught it, so
  // `slug` is asserted explicitly below.
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(release)) {
    if (SERVER_MANAGED.has(k) || v === undefined) continue;
    body[k] = v;
  }
  body.description = release.description ?? "";
  // ragIndexes is presence-guarded server-side but must round-trip as {id}[].
  if (Array.isArray(release.ragIndexes)) {
    body.ragIndexes = (release.ragIndexes as Array<{ id: string }>).map((r) => ({ id: r.id }));
  }
  if (result.starterId) body.conversationStarter = { id: result.starterId };
  if (result.welcomeMessageId) body.chatWelcomeMessage = { id: result.welcomeMessageId };
  if (result.threadPrefixId) body.threadPrefix = { id: result.threadPrefixId };
  if (result.msgPrefixId) body.msgPrefix = { id: result.msgPrefixId };

  await api("POST", `/white-label/${workspaceId}/release/${releaseId}/update`, body);
  notes.push("release: references updated");
  return result;
}
