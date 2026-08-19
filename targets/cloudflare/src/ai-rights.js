// Port of scripts/lib/check-ai-robots.py. Keep the two agent sets in sync with
// it — they encode a policy decision, not a fact about crawlers.
//
// The distinction that matters: TRAINING refusals are not about us. We build a
// retrieval index for the site's own content and cite it; we do not train. A
// host that says `search=yes, ai-train=no, use=reference` has permitted
// precisely what we do, and refusing them would decline work they allowed.
//
// ⚠️ ClaudeBot is classed as TRAINING deliberately — Anthropic's retrieval
// agents are Claude-User and Claude-SearchBot. Do not "fix" this by moving it.
const AI_TRAIN_AGENTS = new Set([
  "gptbot", "ccbot", "google-extended", "anthropic-ai", "claudebot", "claude-web",
  "bytespider", "amazonbot", "applebot-extended", "meta-externalagent",
  "meta-externalfetcher", "facebookbot", "cohere-ai", "diffbot", "imagesiftbot",
  "omgilibot", "ai2bot", "timpibot", "webzio-extended", "pangubot",
]);

// Blocking one of these refuses inference-time retrieval — our use case.
const AI_INFERENCE_AGENTS = new Set([
  "chatgpt-user", "oai-searchbot", "claude-user", "claude-searchbot",
  "perplexitybot", "perplexity-user", "youbot", "duckassistbot",
  "cloudflarebrowserrenderingcrawler",
]);

const isAiAgent = (a) => AI_TRAIN_AGENTS.has(a) || AI_INFERENCE_AGENTS.has(a);

export function parseRobots(txt) {
  const lines = (txt || "").split("\n").map((l) => l.split("#")[0].trim());
  const signals = [];
  const blocked = new Set();
  let starAll = false;
  let group = [];
  for (const l of lines) {
    if (!l) { group = []; continue; }
    let m = /^user-agent\s*:\s*(.+)$/i.exec(l);
    if (m) { group.push(m[1].trim().toLowerCase()); continue; }
    m = /^content-signal\s*:\s*(.+)$/i.exec(l);
    if (m) { signals.push(m[1].trim()); continue; }
    m = /^disallow\s*:\s*(.*)$/i.exec(l);
    if (m && m[1].trim() === "/") {
      for (const ua of group) {
        if (isAiAgent(ua)) blocked.add(ua);
        else if (ua === "*") starAll = true;
      }
    }
  }
  return { blocked: [...blocked].sort(), signal: signals.join("; "), starAll };
}

/** `reserved` means the host refuses OUR use and we must not publish it.
 *  `trainOnly` is recorded and never blocking. */
export function verdict(host, txt) {
  const { blocked, signal, starAll } = parseRobots(txt);
  const sig = signal.toLowerCase();
  const trainNo = /\bai-train\s*=\s*no\b/.test(sig);
  const inputNo = /\bai-input\s*=\s*no\b/.test(sig);
  const searchNo = /\bsearch\s*=\s*no\b/.test(sig);

  const blockedTrain = blocked.filter((a) => AI_TRAIN_AGENTS.has(a));
  const blockedInfer = blocked.filter((a) => AI_INFERENCE_AGENTS.has(a));

  const reasons = [], notes = [];
  if (inputNo) reasons.push(`Content-Signal ai-input=no — inference-time use, i.e. us (${signal})`);
  if (searchNo) reasons.push(`Content-Signal search=no — declines indexing at all (${signal})`);
  if (blockedInfer.length) {
    reasons.push(`blocks ${blockedInfer.length} INFERENCE-time agent(s) with Disallow: / (${blockedInfer.slice(0, 6).join(", ")})`);
  }
  if (starAll) reasons.push("User-agent: * is Disallow: / — refuses every crawler, ours included");

  if (trainNo && !inputNo) notes.push(`declines TRAINING only (${signal}) — we do not train`);
  if (blockedTrain.length) {
    notes.push(`blocks ${blockedTrain.length} training-corpus crawler(s) (${blockedTrain.slice(0, 6).join(", ")}) — not our use case`);
  }

  return {
    host,
    reserved: reasons.length > 0,
    reasons,
    trainOnly: notes.length > 0 && reasons.length === 0,
    notes,
    contentSignal: signal,
  };
}

/**
 * Fetch robots.txt and rule on it.
 *
 * THREE outcomes, not two — and conflating the last two is the bug this
 * distinction exists to prevent:
 *
 *   200            we read the rules. Authoritative either way.
 *   404 / 410      there is definitively no robots.txt. Authoritative "no
 *                  restriction stated" — an absent file is a real answer.
 *   anything else  the host REFUSED to tell us (403/405/429/503) or was
 *                  unreachable. We do not know the rules and must not pretend
 *                  "no restriction found" means "no restriction exists".
 *
 * `verifiable` is the field callers should branch on. `reserved` deliberately
 * keeps the laptop gate's semantics so the two pipelines never disagree about
 * the same host — the blocking decision on unverifiable hosts belongs to the
 * caller, not here. (dspace.mit.edu 405s every non-browser client, and was
 * published on the strength of a robots.txt nobody ever read.)
 */
/**
 * Fetch robots.txt through Browser Rendering.
 *
 * ⚠️ WHY A FALLBACK IS NECESSARY AT ALL. Plain `fetch()` from a Worker is
 * 403'd by hosts that serve robots.txt to anyone else — standardebooks.org
 * answers 200 to curl with our exact User-Agent and 403 to the Worker, and we
 * had ALREADY CRAWLED 2,566 pages of libraryofcongress.gov whose robots.txt we
 * then recorded as unreadable. Cloudflare's Worker egress is shared and widely
 * abused, so origins WAF it on reputation.
 *
 * Left unhandled this is not a cosmetic gap: it publishes a false claim about
 * the host ("declined to state its rules" when it did no such thing) and, since
 * unverifiable hosts are refused, silently blocks legitimate sites for a reason
 * that has nothing to do with them.
 *
 * Browser Rendering is the same path the crawl itself uses, so if it cannot
 * reach robots.txt we could not have crawled the site either — which makes a
 * failure here genuinely about the host.
 */
async function fetchRobotsViaBrowser(host, env) {
  if (!env?.CF_ACCOUNT_ID || !env?.CF_BROWSER_TOKEN) return null;
  for (const scheme of ["https", "http"]) {
    try {
      const r = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/browser-rendering/content`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.CF_BROWSER_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ url: `${scheme}://${host}/robots.txt` }),
        },
      );
      const j = await r.json();
      if (!j.success || typeof j.result !== "string") continue;
      // Browsers wrap text/plain in <pre>. Strip tags and decode the few
      // entities that matter for robots syntax.
      const text = j.result
        .replace(/<[^>]+>/g, "")
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
      // A rendered 404 page is not a robots.txt. Require a directive to
      // appear, or an empty-but-real file.
      if (!/user-?agent\s*:/i.test(text) && text.trim().length > 200) continue;
      return text;
    } catch { /* try next scheme */ }
  }
  return null;
}

/**
 * The User-Agent this crawler presents when reading robots.txt.
 *
 * ⚠️ SET `CRAWLER_CONTACT_URL`. The default names nobody, deliberately — the
 * extracted version hardcoded the originating deployment's domain, so every
 * fork would have identified itself as that operator to every site it read.
 * That is misattribution in the direction that matters: a site owner who
 * decides to block based on this string would be blocking the wrong party, and
 * the operator actually crawling them would never hear about it.
 *
 * Being reachable is also the deal the crawl policy makes with site owners. A
 * crawler that cannot be contacted cannot be asked to stop.
 */
export function robotsUserAgent(env) {
  const contact = env?.CRAWLER_CONTACT_URL;
  return contact
    ? `wwwrag-crawler/0.1 (+${contact}; robots-precheck)`
    : "wwwrag-crawler/0.1 (robots-precheck; operator contact not configured)";
}

export async function checkAiRights(host, env) {
  let lastStatus = null;
  let networkError = null;
  for (const scheme of ["https", "http"]) {
    try {
      const res = await fetch(`${scheme}://${host}/robots.txt`, {
        headers: { "User-Agent": robotsUserAgent(env) },
        signal: AbortSignal.timeout(10_000),
        redirect: "follow",
      });
      if (res.status === 404 || res.status === 410) {
        return { ...verdict(host, ""), fetched: true, verifiable: true, status: res.status,
          unverifiableReason: null };
      }
      if (res.ok) {
        return { ...verdict(host, await res.text()), fetched: true, verifiable: true,
          status: res.status, unverifiableReason: null };
      }
      // A refusal is INFORMATION — remember it rather than falling through to
      // the generic "unreachable", so the operator sees 405 and not a shrug.
      lastStatus = res.status;
    } catch (e) {
      networkError = String(e?.name || e).slice(0, 80);
    }
  }
  // 4xx and 5xx are not the same claim. A 403/405/429 is the host DECLINING —
  // an act, and likely to persist. A 5xx is the host being BROKEN, which says
  // nothing about its policy and is often transient. Reporting both as
  // "declined to state its rules" attributes an intent the server never
  // expressed, and an operator reading that about a 500 would go looking for a
  // policy decision that does not exist.
  // Direct fetch failed. Before calling this host unverifiable — a claim that
  // both maligns it and blocks it — ask again down the path that actually
  // works for us.
  const viaBrowser = await fetchRobotsViaBrowser(host, env);
  if (viaBrowser !== null) {
    return {
      ...verdict(host, viaBrowser),
      fetched: true, verifiable: true, status: lastStatus,
      via: "browser-rendering", unverifiableReason: null,
    };
  }

  const unverifiableReason = !lastStatus
    ? `robots.txt unreachable (${networkError || "no response"}) — could not ask`
    : lastStatus >= 500
      ? `robots.txt errored with HTTP ${lastStatus} — the host's server failed, ` +
        `which states no policy either way (often transient)`
      : `robots.txt refused with HTTP ${lastStatus} — the host declined to state its rules`;
  return {
    ...verdict(host, ""),
    fetched: false,
    verifiable: false,
    status: lastStatus,
    unverifiableReason,
  };
}
