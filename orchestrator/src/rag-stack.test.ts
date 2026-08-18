/**
 * The fixtures are the two arms of the 2026-08-15 BioRenew A/B, which is the
 * comparison this module exists to make expressible:
 *
 *   A  cloudflare-v2 + gemini-embedding-2-preview@1536
 *   B2 qdrant-cosine + gemini-embedding-001@3072
 *
 * Before this module both runs recorded only a vectorId, so the dataset could
 * not tell them apart — the reason that experiment had to be assembled by hand.
 */
import { describe, expect, it } from "vitest";
import {
  architecturesPresent,
  deriveStack,
  isUnlabelled,
  stackKey,
  type RagVectorLike,
} from "./rag-stack.js";

const ARM_A: RagVectorLike = {
  _id: "6a7f10555668b1155468f3a9",
  vectorIndexTool: "cloudflare-v2",
  embeddingModel: "gemini-embedding-2-preview",
  embeddingDimension: 1536,
  similarityMetric: "cosine",
  contextPerMessage: 8,
  minimumSimilarity: 0.3,
};

const ARM_B2: RagVectorLike = {
  ...ARM_A,
  _id: "6a803e909d6b045c51653e23",
  vectorIndexTool: "qdrant-cosine",
  embeddingModel: "gemini-embedding-001",
  embeddingDimension: 3072,
};

describe("deriveStack", () => {
  it("labels a plain vector arm", () => {
    const d = deriveStack(ARM_A);
    expect(d.architecture).toBe("vector");
    expect(d.indexTool).toBe("cloudflare-v2");
    expect(d.embeddingDimension).toBe(1536);
    expect(d.learnedRouting).toBe(false);
  });

  it("distinguishes the two BioRenew arms", () => {
    // The whole point. These two produced 84.3% and 84.0%, and until now the
    // dataset could not say which was which.
    expect(stackKey(deriveStack(ARM_A))).not.toBe(stackKey(deriveStack(ARM_B2)));
  });

  it("treats runs on the same stack as one arm", () => {
    // Replicates pool into a noise band only if their keys match.
    const replicate = { ...ARM_A, _id: "different-vector-same-config" };
    expect(stackKey(deriveStack(replicate))).toBe(stackKey(deriveStack(ARM_A)));
  });
});

describe("architecture detection", () => {
  it("finds PageIndex from its tree key", () => {
    const d = deriveStack({ ...ARM_A, pageindexTreeIndexKey: "tree/abc" });
    expect(d.architecture).toBe("pageindex");
  });

  it("finds RAPTOR and carries its retrieval mode", () => {
    const d = deriveStack({
      ...ARM_A,
      raptorTreeKey: "raptor/xyz",
      raptorConfig: { retrievalMode: "tree-traversal" },
    });
    expect(d.architecture).toBe("raptor");
    expect(d.retrievalMode).toBe("tree-traversal");
    expect(stackKey(d)).toContain("tree-traversal");
  });

  it("does NOT count an architecture whose build failed", () => {
    // A failed LightRAG graph means the vector is serving plain vector search.
    // Labelling it `lightrag` would credit LightRAG for a score it had no part
    // in — the same mistake as reading arm B1's number, which never produced a
    // usable index at all.
    const failed = deriveStack({
      ...ARM_A,
      lightragConfig: { graphBuildStatus: "failed", retrievalMode: "hybrid" },
    });
    expect(failed.architecture).toBe("vector");
    expect(failed.architecturesPresent).toEqual([]);

    const built = deriveStack({
      ...ARM_A,
      lightragConfig: { graphBuildStatus: "complete", retrievalMode: "hybrid" },
    });
    expect(built.architecture).toBe("lightrag");
  });

  it("ignores a Neo4j strategy with no completed graph", () => {
    const d = deriveStack({
      ...ARM_A,
      neo4jRetrievalStrategy: "graph-enhanced",
      neo4jGraphBuildStatus: "building",
    });
    expect(d.architecture).toBe("vector");
  });

  it("reports a hybrid rather than silently picking one", () => {
    // A vector can carry both. Collapsing to whichever the code checked first
    // attributes the score to the wrong arm.
    const doc = {
      ...ARM_A,
      raptorTreeKey: "r/1",
      lightragConfig: { graphBuildStatus: "complete", retrievalMode: "hybrid" },
    };
    expect(architecturesPresent(doc)).toEqual(["raptor", "lightrag"]);
    const d = deriveStack(doc);
    expect(d.architecture).toBe("raptor"); // precedence
    expect(stackKey(d)).toContain("hybrid:raptor+lightrag");
  });

  it("orders precedence by how much each overrides vector search", () => {
    const d = deriveStack({
      ...ARM_A,
      pageindexTreeIndexKey: "t/1",
      raptorTreeKey: "r/1",
    });
    // PageIndex does not consult the vector index at all, so it wins.
    expect(d.architecture).toBe("pageindex");
  });
});

describe("stackKey", () => {
  it("renders unknown parts as ? instead of dropping them", () => {
    // Dropping a missing embedding model would pool a 1536-dim arm with a
    // 3072-dim one and report the difference between them as noise.
    const k = stackKey(deriveStack({ vectorIndexTool: "qdrant-cosine" }));
    expect(k).toContain("?");
    expect(k).not.toBe(stackKey(deriveStack(ARM_A)));
  });

  it("marks learned routing, which changes retrieval at query time", () => {
    const d = deriveStack({ ...ARM_A, useLearnedRouting: true });
    expect(stackKey(d)).toContain("routed");
    expect(stackKey(d)).not.toBe(stackKey(deriveStack(ARM_A)));
  });

  it("marks a non-default compression strategy but not 'none'", () => {
    expect(stackKey(deriveStack({ ...ARM_A, compressionStrategy: "none" }))).toBe(
      stackKey(deriveStack(ARM_A)),
    );
    expect(stackKey(deriveStack({ ...ARM_A, compressionStrategy: "llmlingua" }))).toContain("cmp:");
  });

  it("is stable across calls", () => {
    expect(stackKey(deriveStack(ARM_B2))).toBe(stackKey(deriveStack(ARM_B2)));
  });
});

describe("isUnlabelled", () => {
  it("flags a descriptor too incomplete to compare", () => {
    expect(isUnlabelled(deriveStack({}))).toBe(true);
    expect(isUnlabelled(deriveStack({ vectorIndexTool: "qdrant-cosine" }))).toBe(true);
    expect(isUnlabelled(deriveStack(ARM_A))).toBe(false);
  });
});

describe("the embedding model already carries its dimension (real data)", () => {
  /**
   * Found by probing the live BioRenew vector, not by reading the model —
   * `embeddingModel` came back as "gemini-embedding-2-preview@1536", so the
   * first stackKey rendered `…@1536@1536`. Two arms differing only in
   * dimension would still have been distinguishable, but every key was wrong
   * and the doubled suffix would have made the ledger unreadable.
   */
  it("splits the @dim suffix out of the model name", () => {
    const d = deriveStack({
      vectorIndexTool: "cloudflare-v2",
      embeddingModel: "gemini-embedding-2-preview@1536",
      embeddingDimension: 1536,
    });
    expect(d.embeddingModel).toBe("gemini-embedding-2-preview");
    expect(d.embeddingDimension).toBe(1536);
    expect(stackKey(d)).toBe("vector/cloudflare-v2/gemini-embedding-2-preview@1536");
    expect(stackKey(d)).not.toContain("@1536@1536");
  });

  it("recovers the dimension when only the model string carries it", () => {
    const d = deriveStack({
      vectorIndexTool: "qdrant-cosine",
      embeddingModel: "gemini-embedding-001@3072",
    });
    expect(d.embeddingDimension).toBe(3072);
    expect(d.embeddingModel).toBe("gemini-embedding-001");
  });

  it("leaves a model with no suffix alone", () => {
    const d = deriveStack({ vectorIndexTool: "x", embeddingModel: "text-embedding-3-large" });
    expect(d.embeddingModel).toBe("text-embedding-3-large");
    expect(d.embeddingDimension).toBeNull();
  });

  it("does not mistake an @ that is not a dimension for one", () => {
    const d = deriveStack({ vectorIndexTool: "x", embeddingModel: "org@custom-model" });
    expect(d.embeddingModel).toBe("org@custom-model");
    expect(d.embeddingDimension).toBeNull();
  });
});
