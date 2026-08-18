/**
 * Per-customer landing copy generation.
 *
 * The landing template ships a NEUTRAL `src/i18n/ui/en.ts` ("Acme Expert").
 * Driving brand.config alone re-skins the component chrome but leaves the prose
 * (title, hero, corpus, chat, bios, transcript) generic. This module generates
 * a customized en.ts from the prospect's research via the local `claude` CLI
 * (headless `claude -p`) — always available, no API keys.
 *
 * Safety: the generated file MUST keep the template's exact key structure and
 * array lengths or the build breaks. We validate the output structurally
 * (dynamic import + deep shape compare) against the neutral en.ts and FALL BACK
 * to neutral when it doesn't match — so a bad generation never breaks a deploy.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { runClaude } from "./claude-cli.js";

const execFileP = promisify(execFile);

export interface CopyGenInput {
  prospectName: string;
  productName: string;
  /** research-expanded.md (or any prose brief) — trimmed into the prompt. */
  research: string;
  evalQueries: string[];
  /** The template's neutral en.ts source, used as the exact shape to match. */
  neutralEnTs: string;
  /**
   * The team, in the exact order the cards will render.
   *
   * Passed so the generator writes one role and one body PER PERSON instead of
   * writing about whoever the research foregrounds. `brand.config.bios` and
   * `en.ts bios.{roles,bodies}` are joined by array index at render time, and
   * until now the generator never saw the names — so the two lists described
   * different people in different orders. EvoNexus published Rory Moore's
   * biography under Gene Dantsker's name and photograph.
   */
  bios?: Array<{ name: string; title: string }>;
}

/**
 * The team section of the prompt.
 *
 * `bios.roles` and `bios.bodies` are the ONE place the "match the template's
 * array lengths exactly" rule must be broken: their length is set by how many
 * people the team scraper found, not by the template's two placeholders. The
 * renderer indexes them against brand.config.bios, so a short array leaves real
 * cards with no role and no text.
 */
export function biosBlock(bios?: Array<{ name: string; title: string }>): string[] {
  if (!bios?.length) return [];
  return [
    "THE TEAM — these people, in this exact order:",
    ...bios.map((b, i) => `  ${i}. ${b.name}${b.title ? ` — ${b.title}` : ""}`),
    "",
    "TEAM RULES (these OVERRIDE the array-length rule above):",
    `- \`bios.roles\` MUST have exactly ${bios.length} entries and \`bios.bodies\` exactly ${bios.length}, in that order.`,
    "- Entry i describes PERSON i and nobody else. Name that person in their own",
    "  body text so the pairing is checkable.",
    "- Do not write about a person who is not on the list, and do not move",
    "  someone's description onto another person's card.",
    "- If the research says nothing about person i, give them a short factual",
    "  role and an EMPTY body (\"\"). An empty body renders a clean name-and-photo",
    "  card. Never fill the gap with text about somebody else.",
    "",
  ];
}

export async function generateEnTs(input: CopyGenInput): Promise<string> {
  const prompt = [
    "You are a senior marketing copywriter. Write the landing-page copy for an",
    "AI assistant, as a TypeScript file `en.ts`.",
    "",
    "OUTPUT RULES (critical):",
    "- Return ONLY the file contents. No markdown fences, no commentary.",
    "- Match the TEMPLATE structure EXACTLY: same `export const en = {…}`, same",
    "  keys, same nesting, same array lengths, and keep",
    "  `export type UIStrings = typeof en;` at the end.",
    "- Preserve inline markup tokens verbatim where the template uses them:",
    "  {br}, {kbd}…{/kbd}, **bold**, *italic*, and [[n]] citation markers.",
    "- Replace ONLY the human-readable English strings with copy tailored to the",
    "  customer below. Keep it accurate to the research — do not invent facts,",
    "  credentials, or numbers that aren't supported.",
    "- The transcript answers must stay plausible and grounded; keep the same",
    "  number of paragraphs and the [[n]] markers.",
    "",
    `CUSTOMER: ${input.productName} (${input.prospectName})`,
    "",
    "RESEARCH BRIEF:",
    input.research.slice(0, 4500),
    "",
    "REPRESENTATIVE QUESTIONS (reuse as example/starter/transcript questions):",
    ...input.evalQueries.map((q) => `- ${q}`),
    "",
    ...biosBlock(input.bios),
    "TEMPLATE en.ts (match this structure exactly):",
    input.neutralEnTs,
  ].join("\n");

  let out = await runClaude(prompt);
  // Strip accidental markdown fences if the model added them.
  const fence = out.match(/```(?:ts|typescript)?\s*\n([\s\S]*?)```/);
  if (fence) out = fence[1].trim();
  return out;
}

/**
 * Can `generated` stand in for `neutral`? DIRECTIONAL — the arguments are not
 * interchangeable.
 *
 * Objects must have identical key sets: a missing key renders `undefined` and
 * an extra one means the generator invented structure, which is a bad
 * generation even though nothing would read it.
 *
 * Arrays only require `generated` to be AT LEAST as long. This used to demand
 * exact equality, and that was wrong about how the template renders. These
 * arrays are indexed by a driver whose length lives somewhere else —
 * TranscriptShowcase builds its exchanges from a hardcoded 5-entry
 * `exchangeMeta` and reads `t.answers[i]`; bios render from `brand.bios`. So a
 * SHORT array renders undefined and must fail, while a LONG one is simply
 * unused and is not a defect.
 *
 * Demanding equality made the copy generator's ordinary variation fatal: on a
 * failure the build silently keeps the NEUTRAL copy, so a demo shipped reading
 * "Acme Expert" under the customer's own domain. drchatterjee had 6 answers
 * against the template's 5 and had been shipping template copy since June.
 */
export function isCompatibleShape(generated: unknown, neutral: unknown): boolean {
  if (Array.isArray(generated) || Array.isArray(neutral)) {
    if (!Array.isArray(generated) || !Array.isArray(neutral)) return false;
    if (generated.length < neutral.length) return false;
    // Compare only the positions the renderer can reach.
    return neutral.every((v, i) => isCompatibleShape(generated[i], v));
  }
  if (generated && neutral && typeof generated === "object" && typeof neutral === "object") {
    const kg = Object.keys(generated as object).sort();
    const kn = Object.keys(neutral as object).sort();
    if (kg.length !== kn.length || kg.some((k, i) => k !== kn[i])) return false;
    return kg.every((k) =>
      isCompatibleShape((generated as Record<string, unknown>)[k], (neutral as Record<string, unknown>)[k]),
    );
  }
  // Leaf: both must be the same primitive type (string vs string, etc.).
  return typeof generated === typeof neutral;
}

/** Leaf sentinel used by the AST shape skeleton (never a real value). */
const LEAF = "·leaf·";

/**
 * Extract a STRUCTURAL skeleton of the `export const en = {…}` object by parsing
 * the source with the TypeScript compiler and walking the AST — WITHOUT ever
 * evaluating it. Returns nested objects/arrays with LEAF sentinels at the
 * primitives, so isCompatibleShape() can compare keys + array lengths.
 *
 * SECURITY: this replaces a prior `import()` of the generated file. The copy is
 * produced by an LLM from the prospect's (semi-untrusted) website research, so
 * executing it (which import does, including top-level/side-effecting code) was
 * an RCE vector. AST parsing never runs the code.
 */
export function extractEnShape(source: string): unknown {
  const sf = ts.createSourceFile("en.ts", source, ts.ScriptTarget.Latest, true);

  const fromNode = (raw: ts.Node): unknown => {
    // Unwrap `as const`, `satisfies X` and parentheses before deciding what
    // this is. Without it any wrapper makes the whole object read as a LEAF —
    // and LEAF vs LEAF compares equal, so EVERY generated file would validate
    // and the demo's copy would never be checked again. A checker that
    // silently stops checking is exactly the failure this module guards.
    let node: ts.Node = raw;
    while (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node))
      node = node.expression;
    if (ts.isObjectLiteralExpression(node)) {
      const obj: Record<string, unknown> = {};
      for (const prop of node.properties) {
        if (ts.isPropertyAssignment(prop)) {
          const name = ts.isStringLiteralLike(prop.name) || ts.isNumericLiteral(prop.name)
            ? prop.name.text
            : ts.isIdentifier(prop.name)
              ? prop.name.text
              : undefined;
          if (name !== undefined) obj[name] = fromNode(prop.initializer);
        }
        // spreads / shorthand / methods aren't expected in the data object;
        // ignoring them keeps the shape strict (they'd just be absent → mismatch).
      }
      return obj;
    }
    if (ts.isArrayLiteralExpression(node)) {
      return node.elements.map(fromNode);
    }
    // Any non-container initializer is a leaf (string/number/bool/template/etc.).
    return LEAF;
  };

  let shape: unknown;
  const visit = (node: ts.Node) => {
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === "en" && decl.initializer) {
          shape = fromNode(decl.initializer);
        }
      }
    }
    if (shape === undefined) ts.forEachChild(node, visit);
  };
  visit(sf);
  return shape;
}

/**
 * Materialize the literal VALUES of the `export const en = {…}` object from
 * source via the TS AST — strings/numbers/bools/arrays/objects only, NEVER
 * executing the code (same RCE-safety reason as extractEnShape). Template
 * literals with substitutions are flattened to their literal parts (lossy, but
 * the copy we read — transcript/chat — has none). Returns null on parse failure.
 */
export function extractEnObject(source: string): Record<string, unknown> | null {
  try {
    const sf = ts.createSourceFile("en.ts", source, ts.ScriptTarget.Latest, true);
    const val = (node: ts.Node): unknown => {
      if (ts.isStringLiteralLike(node)) return node.text;
      if (ts.isNumericLiteral(node)) return Number(node.text);
      if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
      if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
      if (node.kind === ts.SyntaxKind.NullKeyword) return null;
      if (ts.isTemplateExpression(node)) {
        return node.head.text + node.templateSpans.map((s) => s.literal.text).join("");
      }
      if (ts.isArrayLiteralExpression(node)) return node.elements.map(val);
      if (ts.isObjectLiteralExpression(node)) {
        const o: Record<string, unknown> = {};
        for (const prop of node.properties) {
          if (ts.isPropertyAssignment(prop)) {
            const name =
              ts.isStringLiteralLike(prop.name) || ts.isNumericLiteral(prop.name) || ts.isIdentifier(prop.name)
                ? prop.name.text
                : undefined;
            if (name !== undefined) o[name] = val(prop.initializer);
          }
        }
        return o;
      }
      return undefined;
    };
    let out: Record<string, unknown> | null = null;
    const visit = (node: ts.Node) => {
      if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.name.text === "en" && decl.initializer) {
            out = val(decl.initializer) as Record<string, unknown>;
          }
        }
      }
      if (out === null) ts.forEachChild(node, visit);
    };
    visit(sf);
    return out;
  } catch {
    return null;
  }
}

/**
 * Validate a generated en.ts against the neutral one by comparing AST-derived
 * shape skeletons (keys + array lengths). Never executes either file.
 */
export function validateEnTs(generatedPath: string, neutralPath: string): boolean {
  return explainEnTsMismatch(generatedPath, neutralPath) === undefined;
}

/**
 * WHY the generated copy was rejected, or undefined if it was not.
 *
 * Rejection is not a small thing: the run keeps the NEUTRAL copy and deploys,
 * so the demo ships titled "Acme Expert AI", with the neutral og:title,
 * og:description, chat welcome and CTA. It is the most expensive silent
 * outcome this pipeline has, and until now the only trace was
 * `failed shape validation — keeping neutral copy`, which names nothing.
 *
 * Diagnosing one instance by hand cost most of an hour; the cause was a single
 * key added to the template (`header.menuAriaLabel`) that every existing
 * generated file predated.
 */
export function explainEnTsMismatch(generatedPath: string, neutralPath: string): string | undefined {
  let gen: unknown, neu: unknown;
  try {
    gen = extractEnShape(readFileSync(generatedPath, "utf8"));
    neu = extractEnShape(readFileSync(neutralPath, "utf8"));
  } catch (err) {
    return `could not read/parse: ${(err as Error).message.split("\n")[0]}`;
  }
  if (!gen) return "the GENERATED file did not parse as an `en` object";
  if (!neu) return "the NEUTRAL template file did not parse as an `en` object";
  const reasons: string[] = [];
  diffShape(gen, neu, "en", reasons);
  return reasons.length ? reasons.slice(0, 6).join("; ") : undefined;
}

/** Collect every reason `isCompatibleShape` would have returned false. */
function diffShape(generated: unknown, neutral: unknown, path: string, out: string[]): void {
  if (Array.isArray(neutral)) {
    if (!Array.isArray(generated)) out.push(`${path} is not an array in the generated copy`);
    else if (generated.length < neutral.length)
      out.push(`${path} has ${generated.length} entries, template expects ${neutral.length}`);
    else neutral.forEach((v, i) => diffShape(generated[i], v, `${path}[${i}]`, out));
    return;
  }
  if (neutral && typeof neutral === "object") {
    if (!generated || typeof generated !== "object") {
      out.push(`${path} is missing or not an object in the generated copy`);
      return;
    }
    const g = generated as Record<string, unknown>;
    const n = neutral as Record<string, unknown>;
    for (const k of Object.keys(n)) {
      if (!(k in g)) {
        // The common case, and the one worth naming precisely: the template
        // grew a key that every existing generated file predates.
        out.push(`${path}.${k} is MISSING from the generated copy (did the template add it?)`);
        continue;
      }
      diffShape(g[k], n[k], `${path}.${k}`, out);
    }
    for (const k of Object.keys(g)) if (!(k in n)) out.push(`${path}.${k} is EXTRA in the generated copy`);
    return;
  }
  if (typeof generated !== typeof neutral)
    out.push(`${path} is ${typeof generated} in the generated copy, ${typeof neutral} in the template`);
}
