/**
 * Where a prospect came from — the input side of source yield.
 *
 * `requestedBy` already exists and answers a DIFFERENT question: which *band*
 * a prospect sits in (`direct` outranks `discovered`, always). That is a
 * priority decision. This answers which *mechanism* produced it, which is an
 * accounting question, and the two are deliberately separate fields:
 * plugging in a new discovery source must never be able to change how the
 * queue is ordered.
 *
 * Why it exists: on 2026-08-23 the question "is <source> still worth polling?"
 * turned out to be unanswerable for ANY source, including the one we already
 * run. 217 queued prospects carried slug/name/url/anchorCustomer/cluster/score
 * and nothing at all about origin, so no yield could be attributed and every
 * argument about a source was a hunch. A source that cannot be measured cannot
 * be dropped on evidence, only on taste.
 */

/**
 * The registered sources. A prospect's source MUST appear here.
 *
 * Validated rather than free-text on purpose: a typo in a free-text field
 * silently creates a second bucket, splitting one source's yield across
 * `web-search` and `websearch` so both look half as productive as they are.
 * That is the same failure the ScoredQA rubricVersion hash produced, and the
 * same reason `requestedBy` is validated. Adding a real source is one line
 * here — the friction is the feature.
 */
export const SOURCES = [
  /** Michael handed the URL over himself. */
  "direct",
  /** The loop's discovery pass: a single model call, no web access. */
  "model-recall",
  /**
   * Inferred, not observed. Stamped onto entries that predate this field.
   *
   * Kept distinct from `model-recall` so historical yield is never quoted as
   * if it were measured. Every pre-2026-08-24 discovered prospect is assumed
   * to have come from the model-recall pass because that is the only discovery
   * mechanism that has ever existed — a sound inference, but an inference, and
   * a report that blends the two would launder it into a fact.
   */
  "model-recall:backfilled",
  /**
   * Two-stage web discovery — see discover-web.ts. Distinct from
   * `model-recall` because it is a different instrument answering a different
   * question: recall proposes companies that were notable during training,
   * web search proposes ones with dated evidence of shipping. Blending their
   * yield would hide exactly the comparison this source was added to settle.
   */
  "web-search",
] as const;

export type Source = (typeof SOURCES)[number];

export function isSource(value: unknown): value is Source {
  return typeof value === "string" && (SOURCES as readonly string[]).includes(value);
}

/**
 * The source to assume for an entry that carries none.
 *
 * Only ever returns a `:backfilled` value, so an unstamped entry can never be
 * mistaken for a measured one. Going forward every writer stamps explicitly;
 * this exists for the 217 entries written before the field did.
 */
export function inferSource(p: { requestedBy?: string; directSeq?: number }): Source {
  // `direct` is not inferred — it is recorded, by requestedBy, and has been
  // since long before this field. There is nothing uncertain about it.
  if (p.requestedBy === "direct" || typeof p.directSeq === "number") return "direct";
  return "model-recall:backfilled";
}

/** The source of a prospect, stamped if present and inferred otherwise. */
export function sourceOf(p: { source?: string; requestedBy?: string; directSeq?: number }): Source {
  return isSource(p.source) ? p.source : inferSource(p);
}

/** True when the value is an inference rather than something a writer recorded. */
export function isInferred(source: Source): boolean {
  return source.endsWith(":backfilled");
}
