/**
 * rag-stack.ts — recover WHAT a run's retrieval stack was, from its vectorId.
 *
 * WHY THIS EXISTS
 * ===============
 * Every run records `vectorId` and `releaseId` in state.json and nothing else
 * about retrieval. So ~106 runs of QA history exist with no record of the index
 * tool, embedding model, dimensionality or architecture that produced them, and
 * the dataset cannot answer the one question the whole experiment programme
 * asks: *did that stack score better?*
 *
 * That is why the 2026-08-15 BioRenew A/B had to be assembled by hand, and it
 * is the precondition for an arena: arms you cannot LABEL cannot be compared,
 * and a ledger of unlabelled scores is just noise with timestamps.
 *
 * The stack is recoverable rather than lost — `vectorId` points at a document
 * that still holds every field — so this preserves metrics.ts's rule that the
 * dataset must describe the PAST and not merely the future. One backfill pass
 * labels the entire back-catalogue.
 *
 * SHAPE
 * =====
 * `deriveStack` and `stackKey` are pure and take an already-fetched document,
 * so the interesting logic is testable without a network. `resolveStack` does
 * the I/O and caches, because 106 runs is 106 API calls exactly once.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dv } from "./divinci.js";

/**
 * Which retrieval architecture is actually serving this vector.
 *
 * ⚠️ NOT mutually exclusive in the data — a vector can carry both a RAPTOR
 * tree and a LightRAG graph. `deriveStack` therefore reports a PRIMARY plus
 * everything present, rather than collapsing to one and quietly mislabelling a
 * hybrid as whichever the code checked first.
 */
export type RagArchitecture = "vector" | "raptor" | "pageindex" | "lightrag" | "neo4j-hybrid";

export interface RagStackDescriptor {
  vectorId: string | null;
  /** e.g. "cloudflare-v2", "qdrant-cosine". The index itself. */
  indexTool: string | null;
  embeddingModel: string | null;
  embeddingDimension: number | null;
  similarityMetric: string | null;
  /** Primary architecture, by the precedence in ARCHITECTURE_ORDER. */
  architecture: RagArchitecture;
  /** Every architecture with data present. Length > 1 means a hybrid. */
  architecturesPresent: RagArchitecture[];
  /** raptorConfig.retrievalMode / lightragConfig.retrievalMode / neo4jRetrievalStrategy. */
  retrievalMode: string | null;
  /** Query-time routing to a learned-best architecture per question type. */
  learnedRouting: boolean;
  compressionStrategy: string | null;
  /** Retrieval knobs that change answers without changing the stack. */
  contextPerMessage: number | null;
  minimumSimilarity: number | null;
}

/**
 * Precedence when several are present.
 *
 * Ordered by how much each OVERRIDES plain vector search at query time: a
 * PageIndex tree search does not consult the vector index at all, RAPTOR may
 * collapse to it, LightRAG augments it, Neo4j hybrid blends it. Getting this
 * order wrong mislabels hybrids, which is worse than useless in an arena —
 * it attributes a score to the wrong arm.
 */
const ARCHITECTURE_ORDER: RagArchitecture[] = ["pageindex", "raptor", "lightrag", "neo4j-hybrid"];

/** The subset of the RagVector document this module reads. */
export interface RagVectorLike {
  _id?: string;
  vectorIndexTool?: string;
  embeddingModel?: string;
  embeddingDimension?: number;
  similarityMetric?: string;
  contextPerMessage?: number;
  minimumSimilarity?: number;
  compressionStrategy?: string;
  useLearnedRouting?: boolean;
  pageindexTreeIndexKey?: string;
  pageindexDocId?: string;
  raptorTreeKey?: string;
  raptorConfig?: { retrievalMode?: string; underlyingVectorTool?: string };
  lightragConfig?: { retrievalMode?: string; graphBuildStatus?: string };
  neo4jRetrievalStrategy?: string;
  neo4jGraphBuildStatus?: string;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * An architecture counts as PRESENT only when its build actually completed.
 *
 * A `graphBuildStatus: "failed"` vector is serving plain vector search, and
 * labelling it `lightrag` would credit or blame LightRAG for a score it had no
 * part in. This is the same class of mistake as arm B1 in the BioRenew A/B,
 * which never produced a usable index and would have scored as "that stack is
 * worse" had anyone read its number.
 */
export function architecturesPresent(doc: RagVectorLike): RagArchitecture[] {
  const out: RagArchitecture[] = [];
  if (str(doc.pageindexTreeIndexKey) || str(doc.pageindexDocId)) out.push("pageindex");
  if (str(doc.raptorTreeKey)) out.push("raptor");
  if (doc.lightragConfig && doc.lightragConfig.graphBuildStatus === "complete") out.push("lightrag");
  if (doc.neo4jGraphBuildStatus === "complete" && str(doc.neo4jRetrievalStrategy))
    out.push("neo4j-hybrid");
  return out;
}

export function deriveStack(doc: RagVectorLike): RagStackDescriptor {
  const present = architecturesPresent(doc);
  const architecture = ARCHITECTURE_ORDER.find((a) => present.includes(a)) ?? "vector";

  const retrievalMode =
    architecture === "raptor"
      ? str(doc.raptorConfig?.retrievalMode)
      : architecture === "lightrag"
        ? str(doc.lightragConfig?.retrievalMode)
        : architecture === "neo4j-hybrid"
          ? str(doc.neo4jRetrievalStrategy)
          : null;

  // The stored embeddingModel often ALREADY carries its dimension, e.g.
  // "gemini-embedding-2-preview@1536" (observed on the real BioRenew vector).
  // Split it so the descriptor has one meaning per field, and so a vector that
  // records the dimension only in the model string still gets a numeric one.
  const rawModel = str(doc.embeddingModel);
  const at = rawModel ? rawModel.lastIndexOf("@") : -1;
  const suffixDim = at > 0 ? Number(rawModel!.slice(at + 1)) : NaN;
  const modelHasDim = Number.isFinite(suffixDim) && suffixDim > 0;

  return {
    vectorId: str(doc._id),
    indexTool: str(doc.vectorIndexTool),
    embeddingModel: modelHasDim ? rawModel!.slice(0, at) : rawModel,
    embeddingDimension: num(doc.embeddingDimension) ?? (modelHasDim ? suffixDim : null),
    similarityMetric: str(doc.similarityMetric),
    architecture,
    architecturesPresent: present,
    retrievalMode,
    learnedRouting: doc.useLearnedRouting === true,
    compressionStrategy: str(doc.compressionStrategy),
    contextPerMessage: num(doc.contextPerMessage),
    minimumSimilarity: num(doc.minimumSimilarity),
  };
}

/**
 * A stable, sortable arm label.
 *
 * Every component that changes retrieval BEHAVIOUR appears; nothing that only
 * changes identity does. Two runs sharing a key are replicates of one arm and
 * may be pooled into a noise band — which is exactly what qa-triage.ts needs
 * and what nothing could compute before this module existed.
 *
 * ⚠️ Unknown parts render as `?` rather than being omitted. A key that silently
 * drops a missing embedding model would pool a 1536-dim arm with a 3072-dim
 * one and call the difference noise.
 */
export function stackKey(d: RagStackDescriptor): string {
  const dim = d.embeddingDimension ? `@${d.embeddingDimension}` : "";
  const parts = [
    d.architecture,
    d.indexTool ?? "?",
    `${d.embeddingModel ?? "?"}${dim}`,
  ];
  if (d.retrievalMode) parts.push(d.retrievalMode);
  if (d.compressionStrategy && d.compressionStrategy !== "none") parts.push(`cmp:${d.compressionStrategy}`);
  if (d.learnedRouting) parts.push("routed");
  if (d.architecturesPresent.length > 1) parts.push(`hybrid:${d.architecturesPresent.join("+")}`);
  return parts.join("/");
}

/** True when the descriptor is too incomplete to compare against another arm. */
export function isUnlabelled(d: RagStackDescriptor): boolean {
  return !d.indexTool || !d.embeddingModel;
}

// ────────────────────────────────────────────────────────────── resolution

interface CacheFile {
  /** vectorId -> descriptor. */
  [vectorId: string]: RagStackDescriptor & { _fetchedAt: string };
}

function readCache(path: string): CacheFile {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CacheFile;
  } catch {
    return {};
  }
}

export interface ResolveOpts {
  workspaceId: string;
  profile?: string;
  cachePath: string;
  /** Re-fetch even when cached. */
  refresh?: boolean;
}

/**
 * Fetch and describe one vector, memoised on disk.
 *
 * Returns null when the vector cannot be read — deleted workspace, expired
 * demo, revoked key. That is common for old runs and is NOT an error: an
 * unlabelled historical run is simply one that cannot join an arm, and saying
 * so is better than inventing a label for it.
 */
export async function resolveStack(
  vectorId: string,
  opts: ResolveOpts,
): Promise<RagStackDescriptor | null> {
  const cache = readCache(opts.cachePath);
  if (!opts.refresh && cache[vectorId]) {
    const { _fetchedAt, ...d } = cache[vectorId];
    void _fetchedAt;
    return d;
  }

  const res = await dv(
    ["api", "GET", `/white-label/${opts.workspaceId}/rag-vector/${vectorId}`, "--no-color"],
    { workspace: opts.workspaceId, profile: opts.profile },
  );
  const doc = (res.json ?? null) as RagVectorLike | null;
  if (!doc || typeof doc !== "object") return null;

  const d = deriveStack({ ...doc, _id: doc._id ?? vectorId });
  cache[vectorId] = { ...d, _fetchedAt: new Date().toISOString() };
  mkdirSync(dirname(opts.cachePath), { recursive: true });
  writeFileSync(opts.cachePath, JSON.stringify(cache, null, 2));
  return d;
}

/** Default cache location, beside the runs it describes. */
export function defaultCachePath(repoRoot: string): string {
  return join(repoRoot, "runs", ".rag-stack-cache.json");
}

/** Cached descriptor without any I/O — for metrics extraction over history. */
export function cachedStack(vectorId: string, cachePath: string): RagStackDescriptor | null {
  if (!existsSync(cachePath)) return null;
  const hit = readCache(cachePath)[vectorId];
  if (!hit) return null;
  const { _fetchedAt, ...d } = hit;
  void _fetchedAt;
  return d;
}
