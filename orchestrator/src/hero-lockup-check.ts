/**
 * hero-lockup-check.ts — DETERMINISTIC checks on the deployed hero lockup.
 *
 * Why this exists: the vision-model design review passed the Acme Security demo with
 * "0 critical, 0 major" while its hero logo was rendering at a contrast ratio
 * of 1.12:1 — a white wordmark on a light tan background, effectively invisible
 * — and its "AI" mark sat 3.5px below the wordmark's optical centre. Both are
 * plainly visible to a person and both were missed.
 *
 * The design review is a VISION MODEL and is non-reproducible by its own
 * admission: five runs over one unchanged page produced 5/2/1/4/4 findings. It
 * is a prompt to look, not a check. These two defects are arithmetic — a
 * contrast ratio and a pixel delta — so they should be measured, not judged.
 *
 * Everything here runs IN THE PAGE against the DEPLOYED url, because both
 * defects are properties of the rendered result. The build cannot know them:
 * the logo is fetched from the customer's site at run time and the background
 * comes from an extracted palette.
 *
 * ⚠️ Colour is resolved through a canvas rather than parsed from
 * getComputedStyle. The first version regex-scraped numbers out of the computed
 * value and silently read an `oklch(0.577 0.062 0.111)` as an RGB triple,
 * producing a confident, meaningless 20.34:1. Canvas normalises any colour
 * space the browser accepts.
 */

export interface HeroLockupMeasurement {
  /** WCAG contrast between the logo's mean ink colour and its backdrop. */
  contrast: number | null;
  logoInk: [number, number, number] | null;
  background: [number, number, number] | null;
  /** Signed px: positive means the AI mark sits BELOW the wordmark's ink centre. */
  deltaPx: number | null;
  /**
   * The AI MARK's own contrast against what is painted behind it.
   *
   * Separate from `contrast`, which is the WORDMARK's. They are not the same
   * measurement and can disagree completely: Acme Advisors extracts `primary` and
   * `accent` as the same orange, so its header drew the AI in the exact colour
   * of the bar behind it — invisible — while this check reported 20.97:1 for
   * the white wordmark beside it and passed. A green badge on an absent mark.
   */
  aiContrast?: number | null;
  logoSrc: string | null;
  error?: string;
}

export interface LockupFinding {
  kind: "contrast" | "alignment";
  severity: "critical" | "major" | "minor";
  message: string;
  measured: number;
  threshold: number;
}

/**
 * WCAG 2.1 minimum for a graphical object / UI component is 3:1. A logo is
 * arguably exempt as "incidental branding", which is precisely the reasoning
 * that lets a 1.12 ship — the customer's own mark being unreadable is the
 * defect whatever the spec says about logos.
 */
export const MIN_LOGO_CONTRAST = 3;

/**
 * How far the AI mark may sit from the wordmark's optical centre.
 *
 * 1px, because the eye catches this: at 1.5px it reads as a wobble and the
 * defect was reported by a human at 3.5px. Deliberately NOT zero — sub-pixel
 * layout and font metrics make exact equality unreachable, and a threshold
 * nothing can pass is a check everyone turns off.
 */
export const MAX_ALIGNMENT_DELTA_PX = 1;

/** Grade a measurement. Pure, so it is testable without a browser. */
export function gradeLockup(m: HeroLockupMeasurement): LockupFinding[] {
  const out: LockupFinding[] = [];
  // The AI mark is OURS, not the customer's branding, so there is no
  // "incidental branding" argument for letting it be unreadable.
  if (m.aiContrast !== null && m.aiContrast !== undefined && m.aiContrast < MIN_LOGO_CONTRAST) {
    out.push({
      kind: "contrast",
      severity: m.aiContrast < 1.5 ? "critical" : "major",
      message: m.aiContrast < 1.5
        ? `AI mark is INVISIBLE against its background (${m.aiContrast.toFixed(2)}:1) — same colour as the bar behind it`
        : `AI mark is hard to read against its background (${m.aiContrast.toFixed(2)}:1)`,
      measured: m.aiContrast,
      threshold: MIN_LOGO_CONTRAST,
    });
  }
  if (m.contrast !== null && m.contrast < MIN_LOGO_CONTRAST) {
    out.push({
      kind: "contrast",
      // Below 1.5 the mark is not "hard to read", it is ABSENT. That is a
      // broken page, not a polish note, and it must not be gradeable as minor.
      severity: m.contrast < 1.5 ? "critical" : "major",
      message:
        `logo contrast ${m.contrast.toFixed(2)}:1 against its background` +
        (m.contrast < 1.5 ? " — the mark is effectively invisible" : ""),
      measured: m.contrast,
      threshold: MIN_LOGO_CONTRAST,
    });
  }
  if (m.deltaPx !== null && Math.abs(m.deltaPx) > MAX_ALIGNMENT_DELTA_PX) {
    out.push({
      kind: "alignment",
      severity: Math.abs(m.deltaPx) > 3 ? "major" : "minor",
      message:
        `AI mark sits ${Math.abs(m.deltaPx).toFixed(1)}px ` +
        `${m.deltaPx > 0 ? "below" : "above"} the wordmark's optical centre`,
      measured: Math.abs(m.deltaPx),
      threshold: MAX_ALIGNMENT_DELTA_PX,
    });
  }
  return out;
}

/**
 * The in-page probe, as a string so it can be handed to page.evaluate without
 * dragging a bundler in. Returns a HeroLockupMeasurement.
 */
export const HERO_PROBE = `(scope) => {
  const root = scope === "header" ? document.querySelector("header") : document;
  if (!root) return { error: "no <header> element", contrast:null, deltaPx:null, logoInk:null, background:null, logoSrc:null };
  const cv0 = document.createElement("canvas").getContext("2d");
  const toRGB = (css) => { cv0.fillStyle = "#000"; cv0.fillStyle = css;
    const s = cv0.fillStyle;
    if (s.startsWith("#")) return [1,3,5].map(i=>parseInt(s.slice(i,i+2),16));
    const n=(s.match(/[\\d.]+/g)||[]).map(Number); return n.slice(0,3).map(Math.round); };
  const lum = ([r,g,b]) => { const f=c=>{c/=255;return c<=0.03928?c/12.92:Math.pow((c+0.055)/1.055,2.4)};
    return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b); };
  const ratio = (a,b) => { const s=[lum(a),lum(b)].sort((m,n)=>n-m); return (s[0]+0.05)/(s[1]+0.05); };
  const transparent = (c) => /rgba\\(\\s*0,\\s*0,\\s*0,\\s*0\\s*\\)|transparent/.test(c);

  // EXACT baseline of a text element, in viewport px.
  //
  // ⚠️ This replaces a derived optical-centre metric that was WRONG and did
  // real damage. It computed the baseline from line-height and the font's
  // bounding box rather than measuring it, reported -5.6px for a Acme Renew
  // lockup the browser had aligned perfectly, and a 5.6px "correction" was
  // applied on the strength of it — pushing "AI" visibly below the wordmark.
  // The same metric then reported +0.0px afterwards, i.e. it validated its own
  // mistake. Measured truth: baseline delta 0.00px before that nudge, 5.60px
  // after.
  //
  // A zero-size inline-block sits with its bottom ON the baseline, which is
  // exactly what items-baseline aligns. No font metrics, no assumptions.
  //
  // For a lockup of two texts at the same size, BASELINE alignment IS correct
  // alignment. The residual optical difference here is ~0.43px (cap ascents
  // 36.33 vs 34.92), far below anything worth nudging.
  const baselineOf = (el) => {
    const p = document.createElement("span");
    p.style.cssText = "display:inline-block;width:0;height:0;";
    el.appendChild(p);
    const y = p.getBoundingClientRect().bottom;
    p.remove();
    return y;
  };

  // The AI mark's PAINTED colour, and its contrast with what is behind it.
  //
  // NOTE: no backticks anywhere in this block — it lives inside HERO_PROBE's
  // template literal and one would end the string mid-function.
  //
  // Computed "color" is useless here: the mark is a background-clip:text
  // gradient, so its colour is rgba(0,0,0,0) and the real ink lives in
  // backgroundImage. Read the gradient's first colour stop — for the
  // near-flat gradients the template emits that IS the mark's colour — and
  // fall back to the fill colour for a plainly-filled mark.
  const aiInkOf = (el) => {
    const cs = getComputedStyle(el);
    const bgi = cs.backgroundImage || "";
    const stop = bgi.match(/(rgba?\([^)]*\)|#[0-9a-f]{3,8})/i);
    if (stop && /text/.test(cs.webkitBackgroundClip || cs.backgroundClip || "")) return toRGB(stop[1]);
    const fill = cs.webkitTextFillColor || cs.color;
    return transparent(fill) ? null : toRGB(fill);
  };
  const behind = (el) => {
    let n = el;
    while (n) { const c = getComputedStyle(n).backgroundColor;
      if (!transparent(c)) return toRGB(c); n = n.parentElement; }
    return toRGB("#ffffff");
  };
  const aiContrastOf = (el) => {
    const ink = aiInkOf(el);
    return ink ? +ratio(ink, behind(el)).toFixed(2) : null;
  };

  const measureTextLockup = (root, toRGB, ratio, transparent) => {
    const leaves = [...root.querySelectorAll("span,div,a,h1,p")]
      .filter(e => e.children.length === 0 && e.textContent.trim().length > 0)
      .map(e => ({ e, r: e.getBoundingClientRect() }))
      .filter(o => o.r.width > 0 && o.r.height > 0);
    const ais = leaves.filter(o => o.e.textContent.trim() === "AI");
    if (!ais.length) return { error: "no AI mark found (text lockup)", contrast:null, deltaPx:null, logoInk:null, background:null, logoSrc:null };
    const ai = ais.sort((a,b) => b.r.width*b.r.height - a.r.width*a.r.height)[0];
    // The wordmark is the AI's SIBLING INSIDE THE LOCKUP — found by walking up
    // from the AI until an ancestor also contains other text.
    //
    // ⚠️ NOT "nearest by distance". The hero's subheading sits directly below
    // the lockup and is horizontally centred, so its centre is often closer to
    // the AI's centre than the wordmark's is — the wordmark is a wide box whose
    // centre is far to the left. That heuristic measured the AI against
    // "Our services, described in our own words." and reported -62.2px desktop
    // / +17.8px mobile for a lockup that is ~3px out. A confidently wrong
    // number is worse than NOT MEASURED: it would drive a 62px "correction".
    const isWord = (e) => e.children.length === 0 && e.textContent.trim().length > 0 && e.textContent.trim() !== "AI";
    let node = ai.e.parentElement, w = null;
    for (let hops = 0; node && hops < 5 && !w; hops++, node = node.parentElement) {
      const inside = [...node.querySelectorAll("span,div,a,h1,p")].filter(isWord)
        .map(e => ({ e, r: e.getBoundingClientRect() }))
        .filter(o => o.r.width > 0 && o.r.height > 0)
        // Same line: the lockup is baseline-aligned, so its own text overlaps
        // the AI vertically. A heading one line below never does.
        .filter(o => o.r.top < ai.r.bottom && o.r.bottom > ai.r.top)
        .sort((a,b) => b.r.width*b.r.height - a.r.width*a.r.height);
      if (inside.length) w = inside[0];
    }
    if (!w) return { error: "no wordmark text beside the AI mark", contrast:null, deltaPx:null, logoInk:null, background:null, logoSrc:null };

    let el = w.e, bgCss = null;
    while (el) { const c = getComputedStyle(el).backgroundColor;
      if (!transparent(c)) { bgCss = c; break; } el = el.parentElement; }
    const background = toRGB(bgCss || "#ffffff");
    // A gradient-filled wordmark reports color "rgba(0,0,0,0)" via
    // -webkit-text-fill-color: transparent; fall back to the background so the
    // contrast figure is not a fabricated 1:1.
    const colCss = getComputedStyle(w.e).webkitTextFillColor || getComputedStyle(w.e).color;
    const logoInk = transparent(colCss) ? background : toRGB(colCss);

    return {
      logoSrc: "text:" + w.e.textContent.trim().slice(0, 40),
      logoInk, background,
      contrast: +ratio(logoInk, background).toFixed(2),
      deltaPx: +(baselineOf(ai.e) - baselineOf(w.e)).toFixed(2),
      aiContrast: aiContrastOf(ai.e),
    };
  };

  const cands = [...root.querySelectorAll("img")]
    .filter(i => /logo/i.test(i.src + i.className + (i.alt||"")))
    .map(i => ({ i, r: i.getBoundingClientRect() }))
    .filter(o => o.r.width > 0 && (scope === "header" || (o.r.top >= 0 && o.r.top < innerHeight)))
    .sort((a,b) => b.r.width*b.r.height - a.r.width*a.r.height);
  // TEXT LOCKUP. When the brand's logo is a MARK (a square-ish glyph) the
  // template renders the name as styled text instead of an image, so there is
  // no <img> to find — and this probe used to answer "no in-viewport logo
  // image" and grade NOTHING. That is a silent pass: the Acme Renew demo shipped
  // with its AI mark visibly off the wordmark's centre while all four scopes
  // reported NOT MEASURED. The alignment question is identical for text; only
  // the ink measurement differs.
  if (!cands.length) return measureTextLockup(root, toRGB, ratio, transparent);
  const img = cands[0].i, r = cands[0].r;

  let el = img.parentElement, bgCss = null;
  while (el) { const c = getComputedStyle(el).backgroundColor;
    if (!transparent(c)) { bgCss = c; break; } el = el.parentElement; }
  const background = toRGB(bgCss || "#ffffff");

  const cv = document.createElement("canvas");
  cv.width = Math.max(1, Math.round(r.width)); cv.height = Math.max(1, Math.round(r.height));
  const ctx = cv.getContext("2d");
  // Apply the element's own CSS filter/opacity before sampling. drawImage uses
  // the SOURCE pixels, so without this the probe measures the logo file rather
  // than what the visitor sees — and reported 1.12:1 for an Acme Security page whose
  // \`brightness(0)\` had already made the mark black on cream at ~17:1. A check
  // that cries wolf on a correctly-fixed page is a check people switch off.
  const cs = getComputedStyle(img);
  if (cs.filter && cs.filter !== "none") ctx.filter = cs.filter;
  if (cs.opacity && +cs.opacity < 1) ctx.globalAlpha = +cs.opacity;
  ctx.drawImage(img, 0, 0, cv.width, cv.height);
  let d;
  try { d = ctx.getImageData(0,0,cv.width,cv.height).data; }
  catch (e) { return { error: "canvas tainted (logo served without CORS): " + e.message, contrast:null, deltaPx:null, logoInk:null, background, logoSrc:img.src }; }
  let sr=0,sg=0,sb=0,n=0,top=Infinity,bot=-1;
  for (let y=0;y<cv.height;y++) for (let x=0;x<cv.width;x++) {
    const k=(y*cv.width+x)*4; if (d[k+3] < 32) continue;
    sr+=d[k]; sg+=d[k+1]; sb+=d[k+2]; n++; if (y<top) top=y; if (y>bot) bot=y; }
  if (!n) return { error: "logo has no opaque pixels", contrast:null, deltaPx:null, logoInk:null, background, logoSrc:img.src };
  const logoInk = [Math.round(sr/n), Math.round(sg/n), Math.round(sb/n)];
  const inkCenterY = r.top + (top+bot)/2;

  // NEAREST AI mark, not one inside a fixed window: a 200px window matched the
  // sticky header's AI instead of the hero's and reported a 198px offset.
  const cx = r.left + r.width/2, cy = r.top + r.height/2;
  // LEAF elements only. textContent matches ANCESTORS too, and because the
  // wordmark is an <img> with no text, the whole lockup wrapper's textContent
  // is literally "AI" — so nearest-by-distance picked the CONTAINER, whose box
  // spans both marks and therefore never moves when the AI is nudged. That
  // made the check report a fixed 3.5px through three deploys that were each
  // actually changing the mark's position.
  const ais = [...root.querySelectorAll("span,div")]
    .filter(e => e.children.length === 0 && e.textContent.trim() === "AI" && e.getBoundingClientRect().width > 0)
    .map(e => { const rr = e.getBoundingClientRect();
      return { el: e, rr, d: Math.hypot(rr.left+rr.width/2-cx, rr.top+rr.height/2-cy) }; })
    .sort((a,b) => a.d - b.d);
  const ai = ais[0];

  return {
    logoSrc: img.src, logoInk, background,
    contrast: +ratio(logoInk, background).toFixed(2),
    deltaPx: ai ? +((ai.rr.top + ai.rr.height/2) - inkCenterY).toFixed(2) : null,
    aiContrast: ai ? aiContrastOf(ai.el) : null,
  };
}`;
