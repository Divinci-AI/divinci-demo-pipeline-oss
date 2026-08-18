/**
 * Every test here is named after a way this function can fail SILENTLY —
 * producing a release that looks configured and isn't, or quietly destroying
 * configuration it was never asked to touch.
 *
 * The `divinci` CLI is stubbed at the module boundary so the whole
 * GET-merge-POST shape is exercised without a network or a workspace.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ calls: [] as Array<{ args: string[] }>, responses: new Map<string, unknown>() }));

vi.mock("node:child_process", () => ({
  execFile: (cmd: string, args: string[], _opts: unknown, cb: Function) => {
    h.calls.push({ args });
    const method = args[1];
    const path = args[2];
    const key = `${method} ${path}`;
    const body = h.responses.get(key) ?? h.responses.get(path) ?? { _id: "created000000000000000a" };
    cb(null, { stdout: JSON.stringify(body), stderr: "" });
  },
}));

import { ensureReleaseChatResources } from "./release-chat-resources.js";

const WS = "ws1";
const REL = "rel1";
const relPath = `/white-label/${WS}/release/${REL}`;

/** The POST body sent to /update, parsed back out of the recorded argv. */
function updateBody(): Record<string, unknown> | undefined {
  const call = h.calls.find((c) => c.args[2]?.endsWith("/update"));
  if (!call) return undefined;
  const i = call.args.indexOf("--body");
  return i < 0 ? undefined : JSON.parse(call.args[i + 1]);
}

function seedRelease(extra: Record<string, unknown> = {}) {
  h.responses.set(`GET ${relPath}`, {
    _id: REL, __v: 3, target: "t", whitelabel: WS, status: "available", version: 2,
    slug: "demo", createdAt: 1, updatedAt: 2,
    title: "Demo", description: "d", assistant: { id: "m", finetune: false },
    ragIndexes: [{ id: "vec1", extraJunk: true }],
    ...extra,
  });
}

beforeEach(() => {
  h.calls.length = 0;
  h.responses.clear();
  seedRelease();
});

describe("ensureReleaseChatResources", () => {
  it("sets active:true on the welcome message — false renders NOTHING", async () => {
    // The server defaults `active` to false and an inactive welcome silently
    // does not render, which is indistinguishable from never creating one.
    await ensureReleaseChatResources(WS, REL, { welcomeMessage: "Hi there" });
    const create = h.calls.find((c) => c.args[2]?.endsWith("/chat-welcome-message"));
    expect(create, "welcome message was never created").toBeTruthy();
    const body = JSON.parse(create!.args[create!.args.indexOf("--body") + 1]);
    expect(body).toMatchObject({ message: "Hi there", active: true });
  });

  it("caps starters at 3 — the server rejects more outright", async () => {
    await ensureReleaseChatResources(WS, REL, { starters: ["a", "b", "c", "d", "e"] });
    const create = h.calls.find((c) => c.args[2]?.endsWith("/conversation-starter"));
    const body = JSON.parse(create!.args[create!.args.indexOf("--body") + 1]);
    expect(body.starters).toHaveLength(3);
  });

  it("drops blank starters rather than sending an empty string", async () => {
    await ensureReleaseChatResources(WS, REL, { starters: ["real", "   ", ""] });
    const create = h.calls.find((c) => c.args[2]?.endsWith("/conversation-starter"));
    const body = JSON.parse(create!.args[create!.args.indexOf("--body") + 1]);
    expect(body.starters).toEqual(["real"]);
  });

  it("sends thread prefix as an ARRAY and message prefix as a STRING", async () => {
    // One shared WhitelabelPrefix model, discriminated by `kind`, with a schema
    // hook enforcing kind↔shape. Swapping them is rejected by the release
    // validator — the two endpoints are not interchangeable.
    await ensureReleaseChatResources(WS, REL, { threadPrefix: ["rule one", "rule two"], msgPrefix: "stay on topic" });
    const t = h.calls.find((c) => c.args[2]?.endsWith("/thread-prefix"))!;
    const m = h.calls.find((c) => c.args[2]?.endsWith("/message-prefix"))!;
    expect(JSON.parse(t.args[t.args.indexOf("--body") + 1]).prefix).toEqual(["rule one", "rule two"]);
    expect(JSON.parse(m.args[m.args.indexOf("--body") + 1]).prefix).toBe("stay on topic");
  });

  it("leaves an existing reference alone — a human may have tuned it", async () => {
    seedRelease({ conversationStarter: { id: "human-set-starter" } });
    const res = await ensureReleaseChatResources(WS, REL, { starters: ["new"] });
    expect(h.calls.some((c) => c.args[2]?.endsWith("/conversation-starter"))).toBe(false);
    expect(res.starterId).toBe("human-set-starter");
    expect(res.notes.join(" ")).toContain("left alone");
  });

  it("overwrites when force is set", async () => {
    seedRelease({ conversationStarter: { id: "human-set-starter" } });
    await ensureReleaseChatResources(WS, REL, { starters: ["new"] }, { force: true });
    expect(h.calls.some((c) => c.args[2]?.endsWith("/conversation-starter"))).toBe(true);
  });

  it("PRESERVES unconditionally-assigned release fields it was not asked to change", async () => {
    // `POST /release/:id/update` assigns some fields unconditionally from the
    // request body, so omitting one sets it to undefined. An earlier version of
    // this function used a hand-copied allow-list of 34 fields against an
    // 80-field schema and would have wiped chatCTA / sttToolOverride /
    // voiceTransport / showRagContextTags. The server's own handler carries a
    // comment about this class of omission wiping a release's RAG vectors once.
    seedRelease({
      chatCTA: { id: "cta1" },
      sttToolOverride: "whisper",
      voiceTransport: "webrtc",
      showRagContextTags: true,
      memory: { id: "mem1" },
      spendCapCentsPerDay: 500,
    });
    await ensureReleaseChatResources(WS, REL, { starters: ["s"] });
    const body = updateBody()!;
    for (const k of ["chatCTA", "sttToolOverride", "voiceTransport", "showRagContextTags", "memory", "spendCapCentsPerDay"]) {
      expect(body[k], `${k} must survive the round-trip`).toBeDefined();
    }
  });

  it("KEEPS slug — castDraftBody requires it and rejects the update without it", async () => {
    // Live 400 from a published release: `bad form data — Json at "slug" does
    // not exist`, which reads like a malformed slug rather than a missing one.
    // slug was briefly deny-listed as "server-managed"; it is required input.
    await ensureReleaseChatResources(WS, REL, { starters: ["s"] });
    expect(updateBody()!.slug).toBe("demo");
  });

  it("strips server-managed keys from the echoed body", async () => {
    await ensureReleaseChatResources(WS, REL, { starters: ["s"] });
    const body = updateBody()!;
    for (const k of ["_id", "__v", "target", "whitelabel", "status", "version", "createdAt", "updatedAt"]) {
      expect(body[k], `${k} must not be echoed back`).toBeUndefined();
    }
  });

  it("normalises ragIndexes to {id} — extra keys break the update", async () => {
    await ensureReleaseChatResources(WS, REL, { starters: ["s"] });
    expect(updateBody()!.ragIndexes).toEqual([{ id: "vec1" }]);
  });

  it("does not touch the release at all when nothing changes", async () => {
    seedRelease({ conversationStarter: { id: "x" }, chatWelcomeMessage: { id: "y" } });
    const res = await ensureReleaseChatResources(WS, REL, { starters: ["s"], welcomeMessage: "w" });
    expect(updateBody(), "no update should be sent").toBeUndefined();
    expect(res.notes.join(" ")).toContain("no reference change needed");
  });

  it("skips cleanly when given nothing", async () => {
    const res = await ensureReleaseChatResources(WS, REL, {});
    expect(res.notes.join(" ")).toContain("skipped");
    expect(updateBody()).toBeUndefined();
  });
});
