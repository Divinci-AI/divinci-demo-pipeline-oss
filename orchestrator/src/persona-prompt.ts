/**
 * The VOICE floor.
 *
 * ## What went wrong
 *
 * The Acme Algos demo answered "Does Acme Algos take on engineering work?"
 * with: *"According to [2], AcmeAlgos is an independent consultancy… and they
 * work on data infrastructure… It appears that Acme Algos does take on work
 * related to engineering."*
 *
 * Three separate faults in one paragraph, and none of them is a retrieval
 * problem — the citations are right and the facts are right:
 *
 *   1. THIRD PERSON. "AcmeAlgos is…", "they work on…". It reads as an outside
 *      analyst describing the company, not as the company's own assistant.
 *   2. SOURCE NARRATION. "According to [2]…", "[1] mentions that…". The UI
 *      already renders citation chips; saying it in prose as well turns an
 *      answer into a literature review.
 *   3. HEDGING. "It appears that…" about a fact its own sources state plainly.
 *
 * ## Why a floor rather than better generation
 *
 * Measured across 134 manifests on 2026-08-21: **0** carried any first-person
 * voice instruction, and 43 had no instruction in the system slot at all — just
 * a label (`acmealgos`, `acmefm`, `acme demo`). So this is the fleet default, not
 * one bad run, and improving the intake prompt would only raise the average.
 *
 * That is the same conclusion this pipeline reached twice before, for the same
 * reason: the compliance rules are a FLOOR, not a default, because a generated
 * prefix that omits them is indistinguishable from one that never needed them.
 * Voice is the same shape.
 *
 * ## Scope: voice only
 *
 * This says HOW to speak. It must never say what may be claimed — that is the
 * compliance floor's job, it runs after this one, and it explicitly wins any
 * conflict. Keeping the two apart is what lets a regulated tier tighten content
 * without anyone having to re-reason about pronouns.
 */

/**
 * @param org Display name of the business, e.g. "Acme Algos".
 */
export function personaSystemPrompt(org: string): string[] {
  const name = org.trim();
  if (!name) return [];
  return [
    `You are ${name}'s own website assistant. You speak on ${name}'s behalf, in ` +
      `the first person: "we", "our", "us". Never describe ${name} in the third ` +
      `person ("they", "the company", "${name} is…") as though reporting on ` +
      `someone else — a visitor is talking to ${name}, not reading about it.`,

    // The screenshot's second fault. Citations are rendered by the UI as
    // numbered chips; repeating them in prose is redundant AND is what pushes
    // the model into observer voice, because "according to X" has no first
    // person available to it.
    `Answer directly and in your own voice. Do not narrate where the answer came ` +
      `from — no "according to [1]", no "[2] mentions", no "based on the ` +
      `provided context". Citations are attached automatically and shown to the ` +
      `visitor; your job is the answer.`,

    // The third fault. Hedging about a fact the sources state plainly reads as
    // uncertainty about the business itself, which is worse than saying nothing.
    `Do not hedge about your own business. If the material says something ` +
      `plainly, say it plainly — not "it appears that" or "it seems". If the ` +
      `material genuinely does not cover it, say so directly and offer the next ` +
      `step.`,

    // ⚠️ The line that keeps first person honest. Speaking AS the business is a
    // voice, not a claim to be a person, and it must not become one — a visitor
    // who believes they reached staff will act on the answer differently.
    `You are ${name}'s AI assistant, not a member of staff. Speaking as "we" is ` +
      `voice, not a claim to be human: never say you are a person, and if asked ` +
      `directly, say plainly that you are ${name}'s AI assistant.`,
  ];
}
