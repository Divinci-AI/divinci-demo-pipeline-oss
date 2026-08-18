/**
 * Webhook listener — continues the pipeline when a review board gate task is
 * approved (IN_REVIEW → DONE) instead of requiring a manual re-run.
 *
 * Usage:
 *   npm run listen              # HTTP server on :7901
 *   npm run listen -- --tunnel  # also start `cloudflared tunnel run autoagent-local`
 *
 * Your review board instance is configured with:
 *   REVIEW_BOARD_WEBHOOK_URLS=https://<your-webhook-host>/review-board?token=<WEBHOOK_TOKEN>
 *
 * On task.status_changed → DONE, the listener scans runs/<prospect>/<run>/state.json
 * for a matching gate1TaskId / gate2TaskId and spawns the
 * orchestrator for that run. CANCELED is logged but takes no action (the
 * orchestrator handles rejection interactively).
 *
 * Reliability note: webhooks are fire-and-forget with no retries. If the
 * listener is down when a gate is approved, just re-run the orchestrator
 * manually (or with --watch) — state.json makes continuation idempotent.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// .env loader (same as run.ts — keep in sync)
const orchestratorDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
{
  const envPath = join(orchestratorDir, ".env");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  }
}

const PORT = Number(process.env.LISTEN_PORT ?? 7901);
const TOKEN = process.env.WEBHOOK_TOKEN ?? "";
// Preferred auth: HMAC signature over the raw body (set the same secret on the
// review board sender). Falls back to the legacy query token only when no secret is
// configured. The token-in-query path is deprecated (it leaks into request logs).
const WEBHOOK_SECRET = process.env.REVIEW_BOARD_WEBHOOK_SECRET ?? "";
const REPLAY_WINDOW_MS = 5 * 60 * 1000;
const DEDUP_TTL_MS = 10 * 60 * 1000;
const seenDeliveries = new Map<string, number>(); // dedup key → first-seen ms
const repoRoot = resolve(orchestratorDir, "..");
const runsDir = join(repoRoot, "runs");
const withTunnel = process.argv.includes("--tunnel");

/** Verify HMAC-SHA256(secret, `${ts}.${rawBody}`) constant-time, within window. */
function verifySignature(rawBody: string, ts: string | undefined, sig: string | undefined): boolean {
  if (!WEBHOOK_SECRET || !ts || !sig) return false;
  const age = Math.abs(Date.now() - Number(ts));
  if (!Number.isFinite(age) || age > REPLAY_WINDOW_MS) return false;
  const expected = createHmac("sha256", WEBHOOK_SECRET).update(`${ts}.${rawBody}`).digest("hex");
  const got = Buffer.from(sig.replace(/^sha256=/, ""), "utf8");
  const exp = Buffer.from(expected, "utf8");
  return got.length === exp.length && timingSafeEqual(got, exp);
}

interface WebhookPayload {
  event: string;
  oldStatus: string;
  newStatus: string;
  task: { id: string; title: string; tags?: string[] };
}

/** Find the run whose state.json references this review-board task ID. */
function findRunForTask(taskId: string): { prospect: string; run: string; gate: string } | null {
  if (!existsSync(runsDir)) return null;
  for (const prospect of readdirSync(runsDir)) {
    const pDir = join(runsDir, prospect);
    let runs: string[];
    try {
      runs = readdirSync(pDir);
    } catch {
      continue;
    }
    for (const run of runs) {
      const statePath = join(pDir, run, "state.json");
      if (!existsSync(statePath)) continue;
      try {
        const state = JSON.parse(readFileSync(statePath, "utf8"));
        if (state.gate1TaskId === taskId) return { prospect, run, gate: "gate1" };
        if (state.gate2TaskId === taskId) return { prospect, run, gate: "gate2" };
        if (state.landingTaskId === taskId) return { prospect, run, gate: "landing" };
        if (state.outreachTaskId === taskId) return { prospect, run, gate: "outreach" };
      } catch {
        continue;
      }
    }
  }
  return null;
}

function continueRun(prospect: string, run: string, gate: string): void {
  console.log(`[listen] ${gate} approved → continuing ${prospect}/${run}`);
  const child = spawn("npx", ["tsx", "src/run.ts", "--prospect", prospect, "--run", run], {
    cwd: orchestratorDir,
    stdio: "inherit",
    env: process.env,
  });
  child.on("exit", (code) => {
    console.log(`[listen] ${prospect}/${run} orchestrator exited ${code}`);
  });
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method !== "POST" || url.pathname !== "/review-board") {
    res.writeHead(404);
    res.end();
    return;
  }

  // Read the raw body FIRST (needed to verify the HMAC signature over it), with
  // a hard size cap so a giant body can't exhaust memory.
  let body = "";
  let tooBig = false;
  req.on("data", (c) => {
    body += c;
    if (body.length > 256 * 1024) { tooBig = true; req.destroy(); }
  });
  req.on("end", () => {
    if (tooBig) { res.writeHead(413); res.end(); return; }

    // Auth: prefer HMAC signature; fall back to the legacy query token only if
    // no secret is configured (so existing deployments keep working).
    const sig = req.headers["x-review-board-signature"] as string | undefined;
    const ts = req.headers["x-review-board-timestamp"] as string | undefined;
    const authed = WEBHOOK_SECRET
      ? verifySignature(body, ts, sig)
      : !!TOKEN && url.searchParams.get("token") === TOKEN;
    if (!authed) {
      console.warn(`[listen] rejected webhook (${WEBHOOK_SECRET ? "bad/absent signature" : "bad token"})`);
      res.writeHead(403);
      res.end();
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ received: true }));

    let payload: WebhookPayload;
    try {
      payload = JSON.parse(body);
    } catch {
      console.warn("[listen] non-JSON webhook body ignored");
      return;
    }
    if (payload.event !== "task.status_changed") return;

    // Dedup: a retried/replayed delivery of the same (task, status, time) must
    // not spawn a second pipeline run. Sweep expired keys, then check.
    const now = Date.now();
    for (const [k, t] of seenDeliveries) if (now - t > DEDUP_TTL_MS) seenDeliveries.delete(k);
    const deliveryKey = `${payload.task.id}:${payload.newStatus}:${(payload as { at?: string }).at ?? ts ?? ""}`;
    if (seenDeliveries.has(deliveryKey)) {
      console.log(`[listen] duplicate delivery ignored (${deliveryKey})`);
      return;
    }
    seenDeliveries.set(deliveryKey, now);

    console.log(
      `[listen] ${payload.task.id} "${payload.task.title}" ${payload.oldStatus} → ${payload.newStatus}`
    );

    if (payload.newStatus !== "DONE") return;

    const match = findRunForTask(payload.task.id);
    if (!match) {
      console.log("[listen] no pipeline run references this task — ignoring");
      return;
    }
    continueRun(match.prospect, match.run, match.gate);
  });
});

server.listen(PORT, () => {
  console.log(`[listen] webhook listener on :${PORT} (POST /review-board${TOKEN ? "?token=***" : ""})`);
  if (!TOKEN) console.warn("[listen] WARNING: WEBHOOK_TOKEN unset — accepting unauthenticated posts");
});

if (withTunnel) {
  console.log("[listen] starting cloudflared tunnel autoagent-local…");
  const tunnel = spawn("cloudflared", ["tunnel", "run", "autoagent-local"], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  tunnel.on("exit", (code) => {
    console.error(`[listen] cloudflared exited ${code} — webhooks from the review board will not arrive`);
  });
  process.on("exit", () => tunnel.kill());
}
