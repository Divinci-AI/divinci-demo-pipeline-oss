/**
 * Deterministic "example chat" (transcript showcase) renderer for GENERATED mode.
 *
 * The template's TranscriptShowcase.astro renders ONE real conversation with the
 * assistant — grounded answers, inline bold/italic, [[n]] citation
 * superscripts, themed source pills, and a decoy composer that nudges the visitor
 * up into the live hero chat. Generated mode lost that section.
 *
 * We render it HERE, in TypeScript, rather than asking `claude` to reproduce the
 * conversation: the citation/markup mini-syntax is exactly the kind of thing an
 * LLM mangles, and the copy is already written (per-client) in en.draft.ts's
 * `transcript` block. So we parse the proven mini-syntax deterministically and
 * splice a self-contained section (literal-hex inline styles, no Tailwind color
 * names) into the generated foundation — identical look, zero generation risk.
 */

export interface TranscriptCopy {
  heading: string;
  subheading: string;
  online: string;
  assistantLabel: string;
  recommendationPrefix: string;
  composerAria: string;
  composerPlaceholder: string;
  questions: string[];
  /** One string[] per question — paragraphs, in the bold/italic/[[n]] mini-syntax. */
  answers: string[][];
  /** Starter question chips shown between the example chat and the team section. */
  starterQuestions?: string[];
}

export interface ExampleChatOpts {
  productName: string;
  siteName: string;
  palette: { primary: string; accent: string; mid: string; cream: string; soft: string; text: string };
  logoUrl: string;
  /** Logo is light/white → the logo-circle needs a dark (primary) fill so it
   *  doesn't wash out against the light chat chrome. */
  logoIsLight?: boolean;
  /** Lead practitioner's headshot — used as the assistant ("AI") avatar so the
   *  responses wear the face of the practice. Falls back to the logo. */
  avatarImageUrl?: string;
  welcomeMessage: string;
  /** Anchor the decoy composer scrolls to (the live hero chat). */
  heroAnchor?: string;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** hex (#rrggbb) + 2-digit alpha → #rrggbbaa (valid CSS). */
function a(hex: string, alpha: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? `${hex}${alpha}` : hex;
}

type Seg = { t: "text" | "b" | "i"; v: string } | { t: "cite"; n: number };

/** Parse the non-nested mini-syntax into renderable segments (mirrors template). */
function parseInline(s: string): Seg[] {
  const out: Seg[] = [];
  const re = /\*\*([^*]+)\*\*|\*([^*]+)\*|\[\[(\d+)\]\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push({ t: "text", v: s.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ t: "b", v: m[1] });
    else if (m[2] !== undefined) out.push({ t: "i", v: m[2] });
    else if (m[3] !== undefined) out.push({ t: "cite", n: Number(m[3]) });
    last = re.lastIndex;
  }
  if (last < s.length) out.push({ t: "text", v: s.slice(last) });
  return out;
}

/**
 * Themed, honest "source" pills per exchange. These describe CONTENT TYPES the
 * clinic genuinely publishes (not fabricated filenames) and resolve the [[1]]/[[2]]
 * citation tooltips. Two per exchange so [[2]] always resolves.
 */
function sourcesFor(i: number, siteName: string): string[] {
  const sets = [
    ["Patient education library", "Procedure & recovery guides"],
    [`About ${siteName}`, "Practice overview"],
    ["Consultation preparation", "Patient FAQ"],
  ];
  return sets[i % sets.length];
}

function renderParas(answer: string[], sources: string[], palette: ExampleChatOpts["palette"]): string {
  const cite = (n: number): string => {
    const title = esc(sources[n - 1] ?? sources[sources.length - 1] ?? "Knowledge base");
    return `<sup tabindex="0" class="ex-cite" style="margin-left:.1em;cursor:help;border-radius:4px;background:${a(palette.accent, "26")};color:${palette.primary};padding:.05em .35em;font-size:.65em;font-weight:600;position:relative">${n}<span class="ex-tip" role="tooltip" style="position:absolute;bottom:100%;left:50%;transform:translateX(-50%);margin-bottom:.4rem;display:none;width:max-content;max-width:15rem;white-space:normal;border-radius:6px;background:${palette.text};color:#fff;padding:.4rem .6rem;font-size:.72rem;font-weight:400;font-style:normal;line-height:1.35;text-align:left;box-shadow:0 8px 24px rgba(0,0,0,.2);z-index:20">${title}</span></sup>`;
  };
  return answer
    .map((para) => {
      const inner = parseInline(para)
        .map((seg) =>
          seg.t === "b"
            ? `<strong style="font-weight:600">${esc(seg.v)}</strong>`
            : seg.t === "i"
              ? `<em>${esc(seg.v)}</em>`
              : seg.t === "cite"
                ? cite(seg.n)
                : esc(seg.v),
        )
        .join("");
      return `<p>${inner}</p>`;
    })
    .join("");
}

/** A full self-contained example-chat <section> (with a scoped <style>). */
export function renderExampleChat(t: TranscriptCopy, opts: ExampleChatOpts): string {
  const p = opts.palette;
  const anchor = opts.heroAnchor ?? "#top";
  const logo = esc(opts.logoUrl);
  // Header avatar: always the brand logo (small, centered) — keeps the window
  // title-bar branded and avoids the doctor's face stacking 3× down the thread.
  // The circle is ALWAYS the primary (dark) color: the generated foundation
  // mandates the logo sit on a solid-primary header bar, so the logo is light-on-
  // primary everywhere — a dark circle keeps it legible (the logoIsLight flag is
  // unreliable and a light tint washes white logos out).
  const logoAvatar = `<span style="display:flex;height:1.75rem;width:1.75rem;flex:0 0 auto;align-items:center;justify-content:center;overflow:hidden;border-radius:9999px;background:${p.primary};box-shadow:inset 0 0 0 1px ${a(p.primary, "26")}"><img src="${logo}" alt="" aria-hidden="true" style="max-width:65%;max-height:65%;width:auto;height:auto;object-fit:contain"/></span>`;
  // Message avatar: the lead practitioner's headshot fills the circle (the AI
  // "wears the face" of the practice); falls back to the logo when none exists.
  const avatar = opts.avatarImageUrl
    ? `<span style="display:flex;height:1.75rem;width:1.75rem;flex:0 0 auto;overflow:hidden;border-radius:9999px;box-shadow:inset 0 0 0 1px ${a(p.primary, "26")}"><img src="${esc(opts.avatarImageUrl)}" alt="" aria-hidden="true" style="height:100%;width:100%;object-fit:cover" width="28" height="28"/></span>`
    : logoAvatar;

  const exchanges = t.questions
    .map((q, i) => {
      const sources = sourcesFor(i, opts.siteName);
      const pills = sources
        .map(
          (s) =>
            `<span style="display:inline-flex;max-width:100%;align-items:center;gap:.25rem;border-radius:6px;border:1px solid ${a(p.primary, "26")};background:${a("#ffffff", "cc")};padding:.25rem .5rem;font-size:.72rem;color:#4b5563"><span aria-hidden="true">📄</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s)}</span></span>`,
        )
        .join("");
      return `
      <div style="display:flex;justify-content:flex-end"><p style="max-width:88%;border-radius:1rem;border-bottom-right-radius:.25rem;background:${p.primary};padding:.625rem 1rem;text-align:left;font-size:.95rem;font-weight:500;color:#fff">${esc(q)}</p></div>
      <div style="display:flex;flex-wrap:wrap;gap:.375rem">${pills}</div>
      <div style="display:flex;align-items:flex-start;gap:.5rem">${avatar}<div style="max-width:88%"><div style="display:flex;flex-direction:column;gap:.5rem;border-radius:1rem;border-top-left-radius:.25rem;background:${a(p.accent, "14")};padding:.75rem 1rem;font-size:.95rem;line-height:1.6;color:${p.text}">${renderParas(t.answers[i] ?? [], sources, p)}</div><p style="margin-top:.25rem;font-size:.7rem;color:#6b7280"><span style="font-weight:600;color:${p.primary}">${esc(t.assistantLabel)}</span> · ${esc(opts.productName)}</p></div></div>`;
    })
    .join("\n");

  return `
    <!-- ░░ EXAMPLE CHAT (transcript showcase) ░░ -->
    <style>
      .ex-cite:hover .ex-tip,.ex-cite:focus .ex-tip{display:block!important}
      .ex-scroll{scrollbar-width:thin;scrollbar-color:${a(p.primary, "40")} transparent}
      .ex-scroll::-webkit-scrollbar{width:8px}
      .ex-scroll::-webkit-scrollbar-thumb{background:${a(p.primary, "40")};border-radius:9999px}
      .ex-scroll::-webkit-scrollbar-track{background:transparent}
    </style>
    <section id="example" class="scroll-mt-20 py-20 sm:py-24" style="background:#ffffff">
      <div style="margin:0 auto;max-width:48rem;padding:0 1.5rem">
        <div style="text-align:center">
          <h2 style="font-size:1.875rem;font-weight:700;color:${p.text}">${esc(t.heading)}</h2>
          <p style="margin:1rem auto 0;max-width:36rem;font-size:1.125rem;color:#374151">${esc(t.subheading)}</p>
        </div>
        <div style="margin-top:2.5rem;overflow:hidden;border-radius:1.5rem;border:1px solid ${a(p.primary, "26")};background:linear-gradient(to bottom, ${a(p.accent, "12")}, #ffffff);box-shadow:0 10px 30px rgba(0,0,0,.08)">
          <div style="display:flex;align-items:center;gap:.5rem;border-bottom:1px solid ${a(p.primary, "1a")};background:${a("#ffffff", "b3")};padding:.75rem 1.25rem;backdrop-filter:blur(4px)">
            ${logoAvatar}
            <span style="font-weight:600;color:${p.primary}">${esc(opts.productName)}</span>
            <span style="margin-left:auto;display:inline-flex;align-items:center;gap:.375rem;font-size:.75rem;color:#6b7280"><span style="position:relative;display:flex;height:.5rem;width:.5rem"><span style="position:absolute;display:inline-flex;height:100%;width:100%;border-radius:9999px;background:${p.accent};opacity:.75;animation:ping 1.4s cubic-bezier(0,0,.2,1) infinite"></span><span style="position:relative;display:inline-flex;height:.5rem;width:.5rem;border-radius:9999px;background:${p.mid}"></span></span>${esc(t.online)}</span>
          </div>
          <div class="ex-scroll" style="height:26rem;overflow-y:auto;padding:1.25rem 1rem;display:flex;flex-direction:column;gap:1.25rem">
            <div style="display:flex;align-items:flex-start;gap:.5rem">${avatar}<p style="max-width:88%;border-radius:1rem;border-top-left-radius:.25rem;background:#fff;padding:.625rem 1rem;font-size:.95rem;line-height:1.6;color:${p.text};box-shadow:0 1px 2px rgba(0,0,0,.06)">${esc(opts.welcomeMessage)}</p></div>
            ${exchanges}
          </div>
          <a href="${anchor}" aria-label="${esc(t.composerAria)}" style="display:flex;align-items:center;gap:.5rem;border-top:1px solid ${a(p.primary, "1a")};background:${a("#ffffff", "b3")};padding:.75rem 1.25rem;text-decoration:none">
            <span style="flex:1;border-radius:9999px;border:1px solid ${a(p.primary, "26")};background:#fff;padding:.5rem 1rem;font-size:.9rem;color:#9ca3af">${esc(t.composerPlaceholder)}</span>
            <span aria-hidden="true" style="display:inline-flex;height:2.25rem;width:2.25rem;align-items:center;justify-content:center;border-radius:9999px;background:${p.primary};color:#fff">↑</span>
          </a>
        </div>
      </div>
    </section>`;
}

/**
 * Splice an example-chat section into a generated foundation document. Prefers a
 * literal <!--EXAMPLE_CHAT--> marker; falls back to inserting before the #team
 * section, then before </main>, then before </body>. Returns the html unchanged
 * (with a warning caller-side) only if no anchor exists.
 */
export function injectExampleChat(html: string, sectionHtml: string): string {
  if (html.includes("<!--EXAMPLE_CHAT-->")) {
    return html.replace("<!--EXAMPLE_CHAT-->", sectionHtml);
  }
  const team = html.search(/<!--[^>]*TEAM[^>]*-->|<section[^>]*id="team"/i);
  if (team !== -1) return html.slice(0, team) + sectionHtml + "\n\n    " + html.slice(team);
  const main = html.lastIndexOf("</main>");
  if (main !== -1) return html.slice(0, main) + sectionHtml + "\n  " + html.slice(main);
  const body = html.lastIndexOf("</body>");
  if (body !== -1) return html.slice(0, body) + sectionHtml + "\n" + html.slice(body);
  return html + sectionHtml;
}
