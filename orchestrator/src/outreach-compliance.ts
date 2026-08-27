/**
 * Compliance elements for outreach email: opt-out, postal address, and the
 * suppression list that makes the opt-out real.
 *
 * ═══ WHY THIS IS A MODULE AND NOT A PROMPT RULE ═══
 *
 * Same reasoning as `ensureCcLine` and `ensureSignature` in outreach-assets:
 * a drafting rule the model may or may not follow is not a guarantee. For the
 * Cc that costs a record; here it costs a legal obligation. So the footer is
 * INJECTED and then VALIDATED, and the suppression check is a refusal rather
 * than advice.
 *
 * ═══ WHAT THE LAW ACTUALLY ASKS FOR ═══
 *
 * US CAN-SPAM (15 U.S.C. 7704) permits cold B2B mail but requires all of:
 *   - a functioning opt-out mechanism, honoured within 10 business days
 *   - the sender's valid physical postal address
 *   - non-deceptive headers and subject
 *   - identification as an advertisement where applicable
 *
 * California's B.O.T. Act (SB 1001) requires a bot to disclose itself when
 * communicating to incentivise a sale — not merely when asked. EU AI Act
 * Art. 50 points the same way. That element ALREADY EXISTS here: the
 * `SIGNATURE_BLOCK` in outreach-assets says "Divinci's AI agent. I wrote this
 * email and I'll answer if you reply." This module does not duplicate it.
 *
 * ⚠️ NOT LEGAL ADVICE, and deliberately not a claim of compliance. This
 * module supplies mechanism, not a verdict. CASL (Canada) requires consent
 * rather than opt-out and is NOT satisfied by anything here; GDPR/PECR needs
 * a lawful basis that no code can establish. Jurisdiction is a function of
 * where the RECIPIENT is, which the pipeline does not know. See
 * notes/KNOWN-GAPS.yaml `outbound-bot-disclosure-and-optout-unverified`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The sender's legal entity name, as it appears in the footer.
 *
 * ⚠️ NO DEFAULT, for exactly the reason `senderPostalAddress` has none. A
 * default here would be the name of whoever this repository was extracted
 * from, and a fork's outreach would then identify a company that did not send
 * it — a false statement in a commercial email, satisfying every structural
 * check on the way out.
 *
 * Returns null when unset; callers surface that as a validation problem rather
 * than inventing an identity.
 */
export function senderLegalName(env: NodeJS.ProcessEnv = process.env): string | null {
  return stripOneQuoteLayer((env.OUTREACH_SENDER_LEGAL_NAME ?? "").trim()) || null;
}

export const COMPLIANCE_START = "<!-- compliance:start (auto-injected by the pipeline) -->";
export const COMPLIANCE_END = "<!-- compliance:end -->";

/**
 * Strip one layer of matched surrounding quotes.
 *
 * `orchestrator/.env` is parsed by `/^([A-Z0-9_]+)=(.*)$/`, which takes the
 * rest of the line VERBATIM and does not strip quotes — unlike every other
 * dotenv implementation. So the habit of quoting a value containing spaces puts
 * literal quote marks into the value, and they would appear in the footer of
 * every email sent. Invisible until someone reads a sent message closely.
 *
 * Strips ONE matched layer only: an interior quote (`Suite 2 "The Annex"`) is
 * left alone, and a value that is nothing but quotes reads as absent rather
 * than empty. Shared by all three footer fields — each one is written by hand
 * into the same file, so each one can pick up the same quotes.
 */
export function stripOneQuoteLayer(value: string): string {
  const quoted = /^(["'])([\s\S]*)\1$/.exec(value);
  return (quoted ? quoted[2] : value).trim();
}

/**
 * The sender's physical postal address.
 *
 * ⚠️ THERE IS NO DEFAULT, AND THERE MUST NEVER BE ONE. A placeholder address
 * is worse than no email at all: it satisfies every structural check, reads
 * as compliant to anyone reviewing the draft, and is a false statement in a
 * commercial message sent to thousands of people. An invented address is the
 * single most likely way this module could cause the harm it exists to
 * prevent, so absence fails loudly and blocks the draft.
 *
 * Returns null when unset; callers surface that as a validation problem.
 */
export function senderPostalAddress(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = stripOneQuoteLayer((env.OUTREACH_POSTAL_ADDRESS ?? "").trim());
  if (!raw) return null;
  // A single line, so it renders sanely in a mail client. Operators write it
  // with commas or newlines; normalise both to " · ".
  return raw.split(/\s*[\n]+\s*/).map((s) => s.trim()).filter(Boolean).join(", ");
}

/**
 * Where an opt-out request lands.
 *
 * Defaults to the outreach Cc — a mailbox a human demonstrably reads, since
 * every outreach thread already lands there. That matters more than having a
 * dedicated address: an unsubscribe alias nobody monitors is not a
 * "functioning mechanism", it is a decoration that also happens to be a
 * compliance claim.
 */
export function optOutAddress(env: NodeJS.ProcessEnv = process.env): string | null {
  /**
   * ⚠️ The fallback was a real person's address in the originating repo. Two
   * things go wrong when that ships to a fork: opt-outs are routed to someone
   * with no ability to honour them for that fork — so the address is offered
   * and the request is silently dropped, which is worse than offering
   * nothing — and a public repository publishes an individual's inbox as
   * bulk-mail infrastructure.
   *
   * An unset opt-out address must therefore block the footer, exactly as an
   * unset postal address does.
   */
  return stripOneQuoteLayer((env.OUTREACH_OPTOUT_ADDRESS ?? "").trim()) || null;
}

/* ────────────────────────────  suppression list  ──────────────────────── */

/**
 * Where honoured opt-outs are recorded.
 *
 * A file in the repo, not a database: the pipeline drafts on a laptop and the
 * list has to be readable by the same process that drafts, with no network
 * dependency. A suppression check that can fail open because a service is
 * unreachable is not a suppression check.
 */
export function suppressionPath(root: string = process.cwd()): string {
  return join(root, "outreach", "suppression-list.json");
}

export interface SuppressionEntry {
  /** Lower-cased address (`foo@bar.com`) or bare domain (`bar.com`). */
  entry: string;
  /** ISO-8601 date the request arrived — the start of the 10-business-day clock. */
  requestedAt: string;
  /** ISO-8601 date it was recorded here. */
  honouredAt: string;
  /** Free text: where the request came from, for audit. */
  source?: string;
}

/**
 * Domains that must never be suppressed wholesale.
 *
 * A bare-domain entry suppresses everyone at that domain. For a company that
 * is exactly right — "stop emailing us" means the company, not one mailbox.
 * For a consumer mailbox provider it would silently suppress every unrelated
 * recipient who happens to use it, and the failure is invisible: mail simply
 * stops being drafted, with no error anywhere.
 */
export const NEVER_SUPPRESS_WHOLE_DOMAIN = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com",
  "yahoo.com", "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com",
  "gmx.com", "mail.com", "yandex.com", "zoho.com", "fastmail.com",
]);

/**
 * Normalise an address for matching.
 *
 * Strips sub-addressing (`foo+news@bar.com` → `foo@bar.com`) DELIBERATELY
 * over-broadly. The two failure directions are not symmetric: under-matching
 * sends mail to someone who asked us to stop, which is the violation this
 * whole module exists to prevent; over-matching costs one email that might
 * have been welcome. When in doubt, do not send.
 */
export function normaliseAddress(value: string): string {
  const v = (value ?? "").trim().toLowerCase();
  const at = v.lastIndexOf("@");
  if (at === -1) return v;
  const local = v.slice(0, at).split("+")[0];
  return `${local}@${v.slice(at + 1)}`;
}

export function domainOf(value: string): string {
  const v = normaliseAddress(value);
  const at = v.lastIndexOf("@");
  return at === -1 ? v : v.slice(at + 1);
}

export function loadSuppressionList(root: string = process.cwd()): SuppressionEntry[] {
  const p = suppressionPath(root);
  if (!existsSync(p)) return [];
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    return Array.isArray(parsed) ? (parsed as SuppressionEntry[]) : [];
  } catch (err) {
    /**
     * A corrupt list must NOT read as an empty list.
     *
     * Empty means "nobody has opted out", which is precisely the state that
     * permits sending to everyone. A parse error here would silently convert
     * every honoured opt-out into permission, so it throws.
     */
    throw new Error(
      `suppression list at ${p} is unreadable (${err instanceof Error ? err.message : String(err)}) — ` +
        `refusing to treat it as empty, because empty means "send to everyone"`,
    );
  }
}

/** True when this recipient has opted out, by address or by whole domain. */
export function isSuppressed(recipient: string, list: SuppressionEntry[]): boolean {
  const addr = normaliseAddress(recipient);
  if (!addr) return false;
  const dom = domainOf(addr);
  for (const e of list) {
    const entry = normaliseAddress(e.entry);
    if (!entry) continue;
    if (entry === addr) return true;
    if (!entry.includes("@") && entry === dom) return true;
  }
  return false;
}

/** Record an opt-out. Idempotent on the normalised entry. */
export function addSuppression(
  entry: string,
  opts: { requestedAt?: string; source?: string; root?: string; now?: () => Date } = {},
): SuppressionEntry[] {
  const root = opts.root ?? process.cwd();
  const now = opts.now ?? (() => new Date());
  const normalised = normaliseAddress(entry);
  if (!normalised) throw new Error("cannot suppress an empty entry");
  if (!normalised.includes("@") && NEVER_SUPPRESS_WHOLE_DOMAIN.has(normalised)) {
    throw new Error(
      `refusing to suppress the whole domain "${normalised}" — it is a consumer mailbox ` +
        `provider, so this would silently stop mail to every unrelated recipient there. ` +
        `Suppress the specific address instead.`,
    );
  }
  const list = loadSuppressionList(root);
  if (list.some((e) => normaliseAddress(e.entry) === normalised)) return list;
  const stamp = now().toISOString();
  list.push({
    entry: normalised,
    requestedAt: opts.requestedAt ?? stamp,
    honouredAt: stamp,
    source: opts.source,
  });
  const p = suppressionPath(root);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(list, null, 2)}\n`, "utf8");
  return list;
}

/* ──────────────────────────────  the footer  ──────────────────────────── */

/**
 * Build the compliance footer.
 *
 * Throws when the postal address is unset — see `senderPostalAddress`. The
 * throw is the point: a caller that "handles" it by omitting the address has
 * reintroduced the defect.
 */
export function complianceFooter(env: NodeJS.ProcessEnv = process.env): string {
  /**
   * All three are REQUIRED and none has a default. Each absence fails loudly
   * for the same reason: the value it would have to invent is a claim about
   * who sent the message and how to make it stop, and an invented one passes
   * every structural check on the way out.
   */
  const missing = [
    !senderLegalName(env) && "OUTREACH_SENDER_LEGAL_NAME",
    !senderPostalAddress(env) && "OUTREACH_POSTAL_ADDRESS",
    !optOutAddress(env) && "OUTREACH_OPTOUT_ADDRESS",
  ].filter((v): v is string => typeof v === "string");
  if (missing.length) {
    throw new Error(
      `${missing.join(", ")} not set — refusing to build a compliance footer without a real ` +
        "sender identity, postal address and opt-out route. CAN-SPAM requires them, and a " +
        "placeholder would be a false statement in a commercial email.",
    );
  }
  const postal = senderPostalAddress(env)!;
  const sender = senderLegalName(env)!;
  const optOut = optOutAddress(env)!;
  return [
    COMPLIANCE_START,
    `You're receiving this because ${sender} builds AI assistants from public websites and we built one for yours.`,
    `Don't want these? Reply with "unsubscribe" — or email ${optOut} — and we'll stop. No reply needed beyond that.`,
    `${sender} · ${postal}`,
    COMPLIANCE_END,
  ].join("\n");
}

/**
 * Append or replace the footer. Idempotent on the marked block, like the
 * signature — outreach re-runs on every `--watch` poll and a draft that
 * accumulates footers is worse than one missing it.
 *
 * Placed AFTER the signature: the signature is the sign-off, and boilerplate
 * belongs below it.
 */
export function ensureComplianceFooter(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const block = complianceFooter(env);
  const marked = new RegExp(`${escapeRe(COMPLIANCE_START)}[\\s\\S]*?${escapeRe(COMPLIANCE_END)}`);
  if (marked.test(text)) return text.replace(marked, block);
  return `${text.trimEnd()}\n\n${block}\n`;
}

function escapeRe(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Structural checks on the finished artifact, mirroring `emailLinkProblems`:
 * run AFTER injection, because injection is what puts these there.
 */
export function complianceProblems(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const problems: string[] = [];
  const postal = senderPostalAddress(env);
  if (!postal) {
    problems.push(
      "OUTREACH_POSTAL_ADDRESS is not set — a commercial email needs a real postal address, " +
        "and the pipeline will not invent one",
    );
  } else if (!text.includes(postal)) {
    problems.push("the draft does not carry the sender's postal address");
  }
  if (!/unsubscribe/i.test(text)) {
    problems.push("the draft offers no opt-out — CAN-SPAM requires a functioning one");
  }
  const sender = senderLegalName(env);
  if (!sender) {
    problems.push(
      "OUTREACH_SENDER_LEGAL_NAME is not set — a commercial email must identify who sent it, " +
        "and the pipeline will not send as somebody else",
    );
  } else if (!text.includes(sender)) {
    problems.push("the draft does not carry the sender's legal name");
  }
  const optOut = optOutAddress(env);
  if (!optOut) {
    problems.push(
      "OUTREACH_OPTOUT_ADDRESS is not set — an opt-out route that reaches nobody able to honour " +
        "it is worse than none, because it also makes a compliance claim",
    );
  } else if (!text.includes(optOut)) {
    problems.push(`the draft does not name the opt-out address (${optOut})`);
  }
  return problems;
}

/**
 * Refuse to draft to someone who has opted out.
 *
 * Returned as a hard error rather than a validation problem: a "problem"
 * triggers a re-draft, and re-drafting a message to someone who asked us to
 * stop is the same violation, just slower.
 */
export function assertNotSuppressed(recipient: string, root: string = process.cwd()): void {
  const list = loadSuppressionList(root);
  if (isSuppressed(recipient, list)) {
    throw new Error(
      `${recipient} is on the outreach suppression list — they asked us to stop. ` +
        `Remove them from ${suppressionPath(root)} only if they asked to resubscribe.`,
    );
  }
}
