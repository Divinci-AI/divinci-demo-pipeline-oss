/**
 * Review-board REST client — the optional human-approval surface for gates.
 *
 * Gate 1 (corpus) and Gate 2 (demo) need a human decision. This module puts
 * each one on a Kanban-style board as a task in IN_REVIEW, then polls for the
 * verdict: DONE = approved, CANCELED = rejected. One project per prospect,
 * reused across runs; each run's state.json carries the project id.
 *
 * ⚠️ ENTIRELY OPTIONAL, AND OFF BY DEFAULT. Every caller gates on
 * `isAvailable()`, so with REVIEW_BOARD_URL unset the gates still work — they
 * simply have no board behind them and the decision is made wherever the
 * operator is looking. There is deliberately NO default URL: an unset variable
 * means disabled, never somebody else's board.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS SPEAKS, AND WHAT IT WOULD TAKE TO POINT IT SOMEWHERE ELSE
 * ─────────────────────────────────────────────────────────────────────────────
 * Be honest about the shape: this is not a generic adapter. It expects a
 * specific REST surface —
 *
 *     GET/POST  /api/projects        { id, name, status, taskCount }
 *     GET/POST  /api/tasks           { id, title, description, status }
 *     PATCH     /api/tasks/:id       status: IN_REVIEW | DONE | CANCELED
 *
 * — so pointing it at a different tracker is a real implementation, not a URL
 * change. The seam is narrow though: the orchestrator only ever calls
 * `createTask`, `getTask`, `updateTask`, `findOrCreateProject` and
 * `isAvailable`. Anything exposing those five against its own API works.
 *
 * Natural targets, none of them written yet: Jira (issues + transitions),
 * HubSpot (tasks on a deal), Attio (tasks on a record — which also puts the
 * approval next to the CRM object the outreach is about), or a Kanban board
 * the team already runs.
 *
 * AUTH. Three ways in, tried in order: a Cloudflare Access service token
 * (CF_ACCESS_CLIENT_ID + CF_ACCESS_CLIENT_SECRET), a browser-session token
 * (CF_ACCESS_TOKEN), or nothing at all for a board not behind Access.
 *
 * ⚠️ If your board resolves an IDENTITY rather than just accepting a token, a
 * CF Access *service* token may be rejected — it has no user attached. And if
 * the board sits behind Access with device authentication, that device posture
 * becomes a hard dependency of every gate: when it is down, Access returns a
 * login redirect, isAvailable() reports false, and a tick advances nothing.
 */

// Read lazily — run.ts loads orchestrator/.env AFTER module imports are
// evaluated, so a top-level const would capture the pre-.env value.
//
// ⚠️ NO DEFAULT, and specifically not the host this pipeline was first built
// against. The board integration is genuinely optional — every caller gates on
// `isAvailable()` and the gates work without a board — so an unset variable
// must mean DISABLED. It previously meant "point at the original operator's
// internal review board", which is not a thing anyone else's run should reach for:
// their gate traffic would leave their machine addressed to somebody else's
// infrastructure, and the only reason it failed was an access control on the
// far end rather than anything in this code.
//
// Same rule as require-env.ts, arrived at the same way: a default that names
// external infrastructure does not fail loudly when it is wrong.
function base(): string | undefined {
  const url = process.env.REVIEW_BOARD_URL?.trim();
  return url ? url : undefined;
}

/** True when a review board is configured at all. */
export function isConfigured(): boolean {
  return base() !== undefined;
}

// ---------------------------------------------------------------- auth

function authHeaders(): Record<string, string> {
  // Service token: set CF_ACCESS_CLIENT_ID + CF_ACCESS_CLIENT_SECRET in env
  const id = process.env.CF_ACCESS_CLIENT_ID;
  const secret = process.env.CF_ACCESS_CLIENT_SECRET;
  if (id && secret) {
    return {
      "CF-Access-Client-Id": id,
      "CF-Access-Client-Secret": secret,
    };
  }
  // Browser-session token: fetched via cloudflared (interactive runs)
  const token = process.env.CF_ACCESS_TOKEN;
  if (token) return { "cf-access-token": token };
  return {};
}

// ---------------------------------------------------------------- types

export interface BoardTask {
  id: string;
  title: string;
  status: "TO_DO" | "IN_PROGRESS" | "IN_REVIEW" | "DONE" | "CANCELED";
  description?: string | null;
  projectId?: string | null;
}

export interface BoardProject {
  id: string;
  name: string;
  description?: string | null;
  status: "active" | "archived";
  taskCount: number;
}

export interface CreateTaskOpts {
  title: string;
  description?: string;
  projectId?: string;
  priority?: "high" | "medium" | "low";
  tags?: string[];
  status?: BoardTask["status"];
}

export interface CreateProjectOpts {
  name: string;
  description?: string;
}

// ---------------------------------------------------------------- HTTP

/**
 * The board is unreachable or refusing us — a transport/auth problem, not a bad
 * request. Distinguished from an ordinary error because the caller must exit
 * with the infra code rather than a generic failure.
 *
 * Why this matters: a run that has ALREADY created its gate task skips the
 * isAvailable() branch and goes straight to polling, so before this existed a
 * A board outage surfaced as a plain exit 1. That reads to the loop as "this
 * one run failed" — so it does NOT stop the tick, and alerts once per run per
 * tick. With WARP down overnight that is dozens of identical tasks describing
 * the wrong problem. Measured, not theorised: an outage simulation produced
 * exactly that.
 */
export class BoardUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoardUnavailableError";
  }
}

/** Statuses that mean "we cannot talk to review board", not "this request was bad". */
function isUnavailableStatus(status: number): boolean {
  // 401/403 → Cloudflare Access is refusing us (WARP down is the usual cause).
  // 3xx    → Access is redirecting to its login page.
  // 5xx    → review board itself is unhealthy.
  return status >= 500 || status === 401 || status === 403 || (status >= 300 && status < 400);
}

async function api<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const root = base();
  if (!root) {
    // Callers gate on isAvailable(), so reaching here is a wiring bug, not a
    // configuration one — say so rather than fetching "undefined/api/...".
    throw new Error(
      `review board ${method} ${path} attempted with no REVIEW_BOARD_URL set. ` +
        `review board is optional; guard the call with isAvailable().`,
    );
  }
  let res: Response;
  try {
    res = await fetch(`${root}${path}`, {
      method,
      headers: {
        ...authHeaders(),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "manual",
    });
  } catch (err) {
    throw new BoardUnavailableError(
      `review board ${method} ${path} — cannot reach ${root}: ${(err as Error).message}. ` +
        `If this host is behind Cloudflare Access, check WARP is connected.`,
    );
  }
  if (isUnavailableStatus(res.status)) {
    throw new BoardUnavailableError(
      `review board ${method} ${path} → ${res.status} from ${root} — Access/health problem, not a bad request. ` +
        `If this host is behind Cloudflare Access, check WARP is connected.`,
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`review board ${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------- tasks

export async function createTask(opts: CreateTaskOpts): Promise<BoardTask> {
  return api<BoardTask>("POST", "/api/tasks", {
    title: opts.title,
    description: opts.description ?? null,
    status: opts.status ?? "IN_REVIEW",
    priority: opts.priority ?? "high",
    projectId: opts.projectId ?? null,
    tags: opts.tags ?? [],
  });
}

export async function getTask(id: string): Promise<BoardTask> {
  return api<BoardTask>("GET", `/api/tasks/${id}`);
}

export async function updateTask(
  id: string,
  // `status` is included so a task can be CLOSED from here. Gate 1
  // auto-approval opens a task and immediately marks it DONE, so the board
  // records what was approved and on what evidence — a run reaching Gate 2
  // with no Gate 1 task at all reads as a step that was skipped.
  patch: Partial<Pick<BoardTask, "title" | "description" | "projectId" | "status">>,
): Promise<BoardTask> {
  return api<BoardTask>("PATCH", `/api/tasks/${id}`, patch);
}

// ---------------------------------------------------------------- projects

export async function listProjects(): Promise<BoardProject[]> {
  return api<BoardProject[]>("GET", "/api/projects");
}

export async function createProject(
  opts: CreateProjectOpts,
): Promise<BoardProject> {
  return api<BoardProject>("POST", "/api/projects", {
    name: opts.name,
    description: opts.description ?? null,
  });
}

/**
 * Resolve a project name against a list, without creating anything.
 *
 * Exact match first. Failing that, a UNIQUE prefix match: the board's projects
 * were named by hand and carry qualifiers the pipeline does not generate —
 * "Demo — The Acme Clinic (Dr. Kevin R. Stone)" versus the "Demo — The Stone
 * Clinic" built from the queue. Exact-only matching created a second Stone
 * Clinic project on the first production tick, and in a nightly loop that
 * quietly forks the board: half a prospect's history under one project, half
 * under another.
 *
 * The match must be UNIQUE. A bare prefix rule would let "Demo — Dr. Will"
 * silently adopt "Demo — Dr. Rowan Pike"; when a prefix is ambiguous this
 * returns undefined and the caller creates an unambiguous project instead.
 */
export function resolveProjectByName(
  projects: BoardProject[],
  name: string,
): BoardProject | undefined {
  const exact = projects.find((p) => p.name === name);
  if (exact) return exact;

  const prefixed = projects.filter((p) => p.name.startsWith(`${name} `) || p.name === name);
  return prefixed.length === 1 ? prefixed[0] : undefined;
}

/**
 * Find an existing project by name (see resolveProjectByName), or create it.
 * Returns the project ID. `preferId` short-circuits both — pin a project in the
 * prospect queue when its board name cannot be derived from the prospect name.
 */
export async function findOrCreateProject(
  opts: CreateProjectOpts & { preferId?: string },
): Promise<string> {
  const projects = await listProjects();
  if (opts.preferId) {
    const pinned = projects.find((p) => p.id === opts.preferId);
    if (pinned) return pinned.id;
    console.warn(`review-board: pinned project ${opts.preferId} not found — falling back to name matching`);
  }
  const existing = resolveProjectByName(projects, opts.name);
  if (existing) return existing.id;
  const created = await createProject(opts);
  return created.id;
}

// ---------------------------------------------------------------- health

export async function isAvailable(): Promise<boolean> {
  const root = base();
  if (!root) return false; // not configured: disabled, and no request is made
  try {
    const res = await fetch(`${root}/api/projects`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(4000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
