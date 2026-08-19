/**
 * Deterministic polish pass for the generated foundation HTML.
 *
 * `claude -p` generates the bespoke shell but can't see its own output, so some
 * polish is unreliable when left to the prompt alone. This module rewrites the
 * generated HTML deterministically AFTER generation — the same bulletproof
 * approach as the example-chat renderer — so every prospect inherits the fixes
 * regardless of how the one-shot generation drifted.
 *
 * Passes:
 *  1. Corpus video — splice the "documents being indexed" video into the #how
 *     ("Built on …'s published content") section. Prefers a <!--CORPUS_VIDEO-->
 *     marker; falls back to inserting before the stat-cards grid.
 *  2. Header no-wrap — inject CSS so header links/CTAs never wrap to two lines on
 *     mobile (the "Ask the AI" button wrapped before this backstop existed).
 */

export interface PolishOpts {
  palette: { primary: string; accent: string; mid: string; cream: string; soft: string; text: string };
  corpusVideo?: { videoUrl: string; posterUrl?: string };
  /** Team info for the single-member heading fix. */
  team?: { count: number; leadName?: string };
  /** Hero illustration URL — enables the orbiting-ring + cursor-glow animation. */
  heroImageUrl?: string;
  /** True if the brand logo is light/white (skip the white contrast chip). */
  logoIsLight?: boolean;
  /** Product name — used for the fixed Ask bar placeholder. */
  productName?: string;
  /** Footer legal links (per-brand overrides; defaults to Divinci's). */
  links?: { terms?: string; privacy?: string; aiSafety?: string };
  /** Embed iframe URL — used by the language switcher to build locale-switch links. */
  embedUrl?: string;
  /** Conversation starter questions for the example-cards section. */
  conversationStarters?: string[];
  /** QA test results scored by the pipeline. When present, renders a QA-results section. */
  qaScore?: number;
  qaPassedCount?: number;
  qaTestCount?: number;
  /** Run result ID — links to the full QA run page. */
  qaRunId?: string;
  /** Suite ID — links to the QA suite report. */
  qaSuiteId?: string;
  /** White-label workspace ID — needed to build QA report URLs. */
  workspaceId?: string;
}

/** The 36 supported locales with their emoji flags and autonyms.
 *  Matches divinci-landing-template/src/i18n/locales.ts. */
const LOCALES: { code: string; flag: string; autonym: string }[] = [
  { code: "en", flag: "🇺🇸", autonym: "English" },
  { code: "es", flag: "🇪🇸", autonym: "Español" },
  { code: "fr", flag: "🇫🇷", autonym: "Français" },
  { code: "de", flag: "🇩🇪", autonym: "Deutsch" },
  { code: "it", flag: "🇮🇹", autonym: "Italiano" },
  { code: "pt", flag: "🇵🇹", autonym: "Português" },
  { code: "nl", flag: "🇳🇱", autonym: "Nederlands" },
  { code: "pl", flag: "🇵🇱", autonym: "Polski" },
  { code: "ru", flag: "🇷🇺", autonym: "Русский" },
  { code: "uk", flag: "🇺🇦", autonym: "Українська" },
  { code: "cs", flag: "🇨🇿", autonym: "Čeština" },
  { code: "ro", flag: "🇷🇴", autonym: "Română" },
  { code: "el", flag: "🇬🇷", autonym: "Ελληνικά" },
  { code: "tr", flag: "🇹🇷", autonym: "Türkçe" },
  { code: "ar", flag: "🇸🇦", autonym: "العربية" },
  { code: "he", flag: "🇮🇱", autonym: "עברית" },
  { code: "hi", flag: "🇮🇳", autonym: "हिन्दी" },
  { code: "bn", flag: "🇧🇩", autonym: "বাংলা" },
  { code: "ta", flag: "🇮🇳", autonym: "தமிழ்" },
  { code: "te", flag: "🇮🇳", autonym: "తెలుగు" },
  { code: "mr", flag: "🇮🇳", autonym: "मराठी" },
  { code: "gu", flag: "🇮🇳", autonym: "ગુજરાતી" },
  { code: "pa", flag: "🇮🇳", autonym: "ਪੰਜਾਬੀ" },
  { code: "ur", flag: "🇵🇰", autonym: "اردو" },
  { code: "fa", flag: "🇮🇷", autonym: "فارسی" },
  { code: "th", flag: "🇹🇭", autonym: "ไทย" },
  { code: "vi", flag: "🇻🇳", autonym: "Tiếng Việt" },
  { code: "id", flag: "🇮🇩", autonym: "Bahasa Indonesia" },
  { code: "ms", flag: "🇲🇾", autonym: "Bahasa Melayu" },
  { code: "fil", flag: "🇵🇭", autonym: "Filipino" },
  { code: "ja", flag: "🇯🇵", autonym: "日本語" },
  { code: "ko", flag: "🇰🇷", autonym: "한국어" },
  { code: "zh-hans", flag: "🇨🇳", autonym: "简体中文" },
  { code: "zh-hant", flag: "🇹🇼", autonym: "繁體中文" },
  { code: "sw", flag: "🇰🇪", autonym: "Kiswahili" },
  { code: "zu", flag: "🇿🇦", autonym: "isiZulu" },
];

/**
 * Animated hero: turn the static hero illustration into a slowly ORBITING full
 * circle (the half-arch illustration + a 180°-rotated copy complete the ring),
 * and add a page-wide cursor-tracked "globe" glow (acmenutrition-style). Replaces the
 * generated static hero <img> in place; appends scoped CSS + a pointermove script.
 */
function injectHeroAnimation(html: string, heroImageUrl: string, p: PolishOpts["palette"]): string {
  if (html.includes("hero-orbit")) return html; // idempotent
  const esc = heroImageUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const imgRe = new RegExp(`<img\\b[^>]*${esc}[^>]*>`, "i");
  if (!imgRe.test(html)) return html; // no static hero bg to upgrade
  const orbitImgs = `<img class="ho-top" src="${heroImageUrl}" alt=""/><img class="ho-bot" src="${heroImageUrl}" alt=""/>`;
  // Base = faded/blurred rotating ring. Focus = a SHARP rotating ring (in sync),
  // revealed only inside a cursor-tracked circular mask → the bg comes "into
  // focus as a globe" wherever the mouse hovers.
  const bg = /^#[0-9a-f]{6}$/i.test(p.cream) ? p.cream : "#ffffff"; // hero section + globe color
  const ring =
    `<div class="hero-orbit" aria-hidden="true">${orbitImgs}</div>` +
    `<div class="hero-focus" aria-hidden="true"><div class="hero-orbit hf">${orbitImgs}</div></div>` +
    `<div class="hero-globe" aria-hidden="true"></div>`;
  let out = html.replace(imgRe, ring);
  // Wrap ALL hero-section children in a .circle-overlay (z above the header) so
  // the orbiting illustration rises OVER the header bar (the section's own solid
  // bg stays BELOW the header). Anchored to the section tag (not the ring) so the
  // wrapper nests cleanly regardless of how the generation nested the bg image.
  const ringIdx = out.indexOf('class="hero-orbit"');
  if (ringIdx !== -1) {
    const secStart = out.lastIndexOf("<section", ringIdx);
    const secTagEnd = secStart === -1 ? -1 : out.indexOf(">", secStart);
    const secClose = out.indexOf("</section>", ringIdx);
    if (secStart !== -1 && secTagEnd !== -1 && secClose !== -1) {
      out =
        out.slice(0, secTagEnd + 1) +
        '<div class="circle-overlay">' +
        out.slice(secTagEnd + 1, secClose) +
        "</div><!--/circle-overlay-->" +
        out.slice(secClose);
    }
  }
  const css = `<style>/*hero-anim*/
body{background-image:radial-gradient(600px circle at var(--mx,50%) var(--my,42%), ${a(p.accent, "1f")}, transparent 60%),radial-gradient(840px circle at calc(var(--mx,50%) - 160px) calc(var(--my,42%) + 130px), ${a(p.primary, "17")}, transparent 66%);background-attachment:fixed}
/* Glassy full-width header: translucent blurred bar, items crisp + full width.
   (Backdrop-blur also frosts page content as it scrolls under the sticky bar.) */
header{background:${a(p.primary, "d1")}!important;-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px)}
header>div{max-width:none!important;padding-left:1.5rem!important;padding-right:2rem!important}
/* the hero section gets a solid bg so the orbit's faded edge blends seamlessly,
   and is pulled up under the header so the orbit can overlap the bar */
section:has(.hero-orbit){background:${bg}!important;margin-top:-64px}
/* lift the whole hero (orbit + content) ABOVE the header so the illustration
   rises OVER the bar; the section's solid bg stays below it. pointer-events:none
   lets clicks pass THROUGH the overlay to the header links underneath; the
   content re-enables them so the chat + buttons stay interactive. */
.circle-overlay{position:relative;z-index:51;top:11px;pointer-events:none}
.circle-overlay > [class~="z-10"],.circle-overlay > [style*="z-index:10"],.circle-overlay > [style*="z-index: 10"]{pointer-events:auto}
/* fade the orbit's lower arc into the section's white floor so overflow:hidden
   never hard-cuts it — gives a clean dissolve + breathing room before #how.
   (the orbit is positioned proportionally, so a bottom mask beats extra padding) */
.circle-overlay::after{content:"";position:absolute;left:0;right:0;bottom:0;height:220px;z-index:2;pointer-events:none;background:linear-gradient(to bottom,transparent,${bg})}
/* push hero content clear of the header, and add bottom room before the next section */
section:has(.hero-orbit) .circle-overlay > [class~="z-10"]{padding-top:6rem!important;padding-bottom:11rem!important}
.hero-orbit{position:absolute;left:50%;top:44%;width:min(1500px,152vw);aspect-ratio:1;transform:translate(-50%,-50%);z-index:0;pointer-events:none;opacity:.55;animation:heroSpin 90s linear infinite;-webkit-mask-image:radial-gradient(closest-side,#000 80%,transparent 99%);mask-image:radial-gradient(closest-side,#000 80%,transparent 99%)}
.hero-orbit img{position:absolute;left:0;width:100%;height:auto;filter:blur(4px)}
.hero-orbit img.ho-top{top:0}
.hero-orbit img.ho-bot{bottom:0;transform:rotate(180deg)}
/* clip the sharp focus-reveal out of the header band so hovering a nav item
   never sharpens the orbit over the text (the faint base orbit still shows) */
.hero-focus{position:absolute;inset:0;z-index:0;pointer-events:none;clip-path:inset(56px 0 0 0);-webkit-mask-image:radial-gradient(280px circle at var(--hmx,-1000px) var(--hmy,-1000px),#000 0%,#000 34%,transparent 72%);mask-image:radial-gradient(280px circle at var(--hmx,-1000px) var(--hmy,-1000px),#000 0%,#000 34%,transparent 72%)}
.hero-focus .hero-orbit.hf{opacity:.95}
.hero-focus .hero-orbit.hf img{filter:none}
/* light "globe" the same color as the section — clears the orbit center for the
   content and rises up to overlap the header, so content can sit higher */
.hero-globe{position:absolute;left:50%;top:-260px;transform:translateX(-50%);width:min(780px,82vw);height:min(780px,82vw);border-radius:50%;z-index:1;pointer-events:none;background:radial-gradient(circle, ${bg} 0%, ${bg} 44%, transparent 72%)}
@keyframes heroSpin{to{transform:translate(-50%,-50%) rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.hero-orbit{animation:none}}
</style>`;
  out = out.includes("</head>") ? out.replace("</head>", `${css}\n</head>`) : css + out;
  // Body aurora tracks the viewport cursor; the hero focus globe tracks the
  // cursor RELATIVE to the hero section (so the mask circle sits under the mouse).
  const js = `<script>/*hero-anim*/(function(){
var orbit=document.querySelector('.hero-orbit');var hero=orbit&&orbit.closest('section');
var x=0,y=0,r=null;
function f(){document.body.style.setProperty('--mx',x+'px');document.body.style.setProperty('--my',y+'px');
if(hero){var b=hero.getBoundingClientRect();hero.style.setProperty('--hmx',(x-b.left)+'px');hero.style.setProperty('--hmy',(y-b.top)+'px');}
r=null;}
addEventListener('pointermove',function(e){x=e.clientX;y=e.clientY;if(r===null)r=requestAnimationFrame(f);},{passive:true});
})();</script>`;
  out = out.includes("</body>") ? out.replace("</body>", `${js}\n</body>`) : out + js;
  return out;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * When the team has exactly one person, a generic "Meet the team" heading reads
 * oddly — rewrite it to "Meet <name>". Targets the first <h2> inside #team and
 * only when its text is a generic team heading (so it never clobbers a real one).
 */
function fixSingleMemberTeamHeading(html: string, leadName: string): string {
  const teamIdx = html.search(/<section[^>]*id="team"/i);
  if (teamIdx === -1) return html;
  const after = html.slice(teamIdx);
  const m = after.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i);
  if (!m) return html;
  const plain = m[1].replace(/<[^>]+>/g, "").trim();
  if (!/^meet\s+(the|our)\s+team$|^our\s+team$|^the\s+team$/i.test(plain)) return html;
  const newH2 = m[0].replace(m[1], `Meet ${escHtml(leadName)}`);
  return html.slice(0, teamIdx) + after.replace(m[0], newH2);
}

function a(hex: string, alpha: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? `${hex}${alpha}` : hex;
}

/** A framed, autoplaying corpus video block for the #how section. */
export function renderCorpusVideo(videoUrl: string, posterUrl: string | undefined, palette: PolishOpts["palette"]): string {
  const poster = posterUrl ? ` poster="${posterUrl}"` : "";
  return `<div id="corpus-video" class="overflow-hidden rounded-2xl" style="border:1px solid ${a(palette.primary, "26")};box-shadow:0 10px 30px rgba(0,0,0,.10)"><video src="${videoUrl}"${poster} autoplay muted loop playsinline preload="metadata" aria-label="The practice's published documents being indexed and cited" style="display:block;width:100%;aspect-ratio:16/9;object-fit:cover;background:${palette.primary}"></video></div>`;
}

/** Splice the corpus video into the #how section (marker → before stats → after first paragraph). */
function injectCorpusVideo(html: string, block: string): string {
  if (html.includes('id="corpus-video"')) return html; // already present (idempotent)
  if (html.includes("<!--CORPUS_VIDEO-->")) return html.replace("<!--CORPUS_VIDEO-->", block);
  const howIdx = html.search(/<section[^>]*id="how"/i);
  if (howIdx === -1) return html; // no corpus section to attach to
  // No marker → the generation didn't lay out a column for it, so constrain the
  // block (right-aligned, a bit under half) rather than letting it go full-bleed.
  const constrained = `<div style="max-width:30rem;margin-left:auto;margin-top:2.5rem">${block}</div>`;
  const after = html.slice(howIdx);
  // Insert before the first stat-cards grid inside #how.
  const gridRel = after.search(/<div[^>]*\bgrid\b[^>]*(?:grid-cols|sm:grid-cols|md:grid-cols)/i);
  if (gridRel !== -1) {
    const at = howIdx + gridRel;
    return html.slice(0, at) + constrained + "\n        " + html.slice(at);
  }
  // Fallback: after the section's first paragraph (the intro/description).
  const pRel = after.search(/<\/p>/i);
  if (pRel !== -1) {
    const at = howIdx + pRel + 4;
    return html.slice(0, at) + "\n        " + constrained + html.slice(at);
  }
  return html;
}

/** Inject a small CSS backstop so header links/CTAs never wrap on mobile. */
function injectHeaderNowrap(html: string): string {
  if (html.includes("/*polish-nowrap*/")) return html;
  const css = "<style>/*polish-nowrap*/header a,header button{white-space:nowrap}</style>";
  if (html.includes("</head>")) return html.replace("</head>", `${css}\n</head>`);
  return css + html;
}

/**
 * Mobile hamburger nav. The generated header hides its section links behind
 * `hidden md:flex` with no mobile affordance. Inject a self-contained menu that,
 * at runtime, reads the header's own anchors (so it works regardless of markup),
 * builds a hamburger + dropdown, and tucks the CTA into the menu on mobile.
 * Styling is custom CSS (not Tailwind classes) so it survives the CDN JIT not
 * seeing JS-inserted nodes.
 */
function injectMobileNav(html: string, palette: PolishOpts["palette"]): string {
  if (html.includes("mnav-menu")) return html; // idempotent
  const css = `<style>/*mobile-nav*/
.mnav-toggle{display:none}
.mnav-menu{display:none;position:absolute;left:0;right:0;top:100%;flex-direction:column;background:${palette.primary};padding:.5rem 1rem 1rem;box-shadow:0 14px 28px rgba(0,0,0,.28);border-top:1px solid rgba(255,255,255,.12);z-index:60}
.mnav-menu a{color:#fff;text-decoration:none;padding:.85rem .5rem;font-weight:600;border-radius:.5rem;font-size:1rem}
.mnav-menu a:hover{background:rgba(255,255,255,.08)}
.mnav-menu a.mnav-cta{margin-top:.5rem;text-align:center;background:${palette.accent};color:#fff}
@media(max-width:767px){.mnav-toggle{display:inline-flex;align-items:center;justify-content:center;width:2.75rem;height:2.75rem;border:0;border-radius:.5rem;background:transparent;color:#fff;cursor:pointer;flex:0 0 auto}.mnav-menu.mnav-open{display:flex}.mnav-hide{display:none!important}}
</style>`;
  const script = `<script>/*mobile-nav*/(function(){
if(document.getElementById('mnav-menu'))return;
var h=document.querySelector('header');if(!h)return;var nav=h.querySelector('nav')||h;
var anchors=[].slice.call(h.querySelectorAll('a[href^="#"]'));
var logo=anchors.filter(function(a){return a.querySelector('img')||a.getAttribute('href')==='#top';});
var ctas=anchors.filter(function(a){if(logo.indexOf(a)>-1)return false;var bg=getComputedStyle(a).backgroundColor;return bg&&bg!=='rgba(0, 0, 0, 0)'&&bg!=='transparent';});
var sect=anchors.filter(function(a){return logo.indexOf(a)<0&&ctas.indexOf(a)<0;});
if(!sect.length&&!ctas.length)return;
var menu=document.createElement('div');menu.className='mnav-menu';menu.id='mnav-menu';
sect.forEach(function(a){var l=document.createElement('a');l.href=a.getAttribute('href');l.textContent=(a.textContent||'').trim();l.addEventListener('click',function(){menu.classList.remove('mnav-open');});menu.appendChild(l);});
if(ctas[0]){var c=document.createElement('a');c.href=ctas[0].getAttribute('href');c.textContent=(ctas[0].textContent||'Ask the AI').trim();c.className='mnav-cta';c.addEventListener('click',function(){menu.classList.remove('mnav-open');});menu.appendChild(c);ctas[0].classList.add('mnav-hide');}
var btn=document.createElement('button');btn.className='mnav-toggle';btn.setAttribute('aria-label','Open menu');btn.setAttribute('aria-expanded','false');btn.innerHTML='<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>';
btn.addEventListener('click',function(){var o=menu.classList.toggle('mnav-open');btn.setAttribute('aria-expanded',o?'true':'false');});
nav.appendChild(btn);
if(getComputedStyle(h).position==='static')h.style.position='relative';
h.appendChild(menu);
})();</script>`;
  let out = html.includes("</head>") ? html.replace("</head>", `${css}\n</head>`) : css + html;
  out = out.includes("</body>") ? out.replace("</body>", `${script}\n</body>`) : out + script;
  return out;
}

/**
 * Team-avatar parity backstop. If a generation rendered an initials-fallback
 * avatar as a heavy solid-dark disk (instead of the prompt's ring + light fill),
 * normalize it at runtime: light tinted fill, primary ring, primary initials —
 * so it matches the photo avatars beside it. Heuristic targets reasonably large,
 * near-square, fully-round, image-free elements whose text is just initials.
 */
function injectAvatarParity(html: string, palette: PolishOpts["palette"]): string {
  if (html.includes("/*avatar-parity*/")) return html;
  const fill = a(palette.primary, "14");
  const script = `<script>/*avatar-parity*/(function(){
var P=${JSON.stringify(palette.primary)},F=${JSON.stringify(fill)};
[].slice.call(document.querySelectorAll('div,span')).forEach(function(el){
if(el.querySelector('img,svg'))return;
var w=el.offsetWidth,hh=el.offsetHeight;if(w<56||Math.abs(w-hh)>4)return;
var cs=getComputedStyle(el),br=parseFloat(cs.borderRadius)||0;
if(cs.borderRadius!=='9999px'&&br<w/2-3)return;
var t=(el.textContent||'').trim();if(!/^[A-Z][A-Za-z.]{0,3}$/.test(t)||el.children.length>1)return;
el.style.background=F;el.style.border='3px solid '+P;el.style.boxSizing='border-box';
var span=el.querySelector('span')||el;span.style.color=P;
});
})();</script>`;
  return html.includes("</body>") ? html.replace("</body>", `${script}\n</body>`) : html + script;
}

/** Apply all deterministic polish passes to a generated foundation document. */
/**
 * Fixed "Ask" bar (acmenutrition.ai-style) + embed iframe auto-resize.
 *
 * The hero chat is an iframed /embed/. A fixed iframe height yields an unwanted
 * inner scrollbar, and the embed's own (in-iframe) sticky bar can't pin to the
 * real page viewport. So we: (a) make the iframe auto-resize to the embed's
 * content (the embed posts `divinci-embed-height` — see patchEmbedBridge), and
 * (b) add a page-level fixed Ask bar that reveals once the hero chat scrolls out
 * of view and hands the question to the embed via a `divinci-ask` postMessage
 * (the embed routes it to the chat composer). Idempotent via the #df-askbar id.
 */
function injectAskBar(html: string, p: PolishOpts["palette"], productName?: string): string {
  if (html.includes('id="df-askbar"')) return html; // idempotent
  // Tag + de-scroll the hero embed iframe so JS can drive its height.
  let out = html.replace(/<iframe\b[^>]*\/embed\/[^>]*>/i, (tag) => {
    let t = tag;
    t = /\bid=/.test(t) ? t.replace(/id="[^"]*"/, 'id="df-hero-embed"') : t.replace("<iframe", '<iframe id="df-hero-embed"');
    if (!/scrolling=/.test(t)) t = t.replace("<iframe", '<iframe scrolling="no"');
    if (/style="/.test(t)) {
      t = t.replace(/style="([^"]*)"/, (_m, s) => {
        const cleaned = String(s).replace(/max-height:[^;]*;?/g, "").replace(/height:[^;]*;?/g, "");
        return `style="${cleaned};height:640px;display:block;"`.replace(/;{2,}/g, ";");
      });
    } else {
      t = t.replace("<iframe", '<iframe style="width:100%;height:640px;border:0;display:block;"');
    }
    return t;
  });
  if (!out.includes('id="df-hero-embed"')) return html; // no embed iframe → nothing to do
  const placeholder = `Ask ${escHtml(productName || "the AI")} a question…`;
  const css = `<style>/*ask-bar*/
#df-askbar{position:fixed;left:0;right:0;bottom:0;z-index:60;transform:translateY(120%);opacity:0;transition:transform .42s cubic-bezier(.22,1,.36,1),opacity .42s ease;pointer-events:none}
#df-askbar.show{transform:none;opacity:1;pointer-events:auto}
#df-askbar .bar{max-width:48rem;margin:0 auto;padding:0 1rem 1rem}
#df-askbar form{display:flex;gap:.5rem;align-items:center;background:rgba(255,255,255,.88);border:1px solid ${a(p.primary, "38")};border-radius:1rem;padding:.55rem;box-shadow:0 -8px 40px rgba(13,36,56,.18);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px)}
#df-askbar input{flex:1;min-width:0;border:1px solid ${a(p.primary, "40")};border-radius:9999px;padding:.62rem 1rem;font-size:.95rem;color:${p.text};background:#fff;outline:none}
#df-askbar input:focus{border-color:${p.primary};box-shadow:0 0 0 3px ${a(p.primary, "2e")}}
#df-askbar button{flex:none;border:0;border-radius:9999px;background:${p.accent};color:#fff;font-weight:700;padding:.62rem 1.4rem;font-size:.95rem;cursor:pointer;transition:filter .15s}
#df-askbar button:hover{filter:brightness(.92)}
</style>`;
  const bar = `<div id="df-askbar" aria-hidden="true"><div class="bar"><form id="df-askbar-form"><input id="df-askbar-input" type="text" autocomplete="off" placeholder="${placeholder}" aria-label="${placeholder}"/><button type="submit">Ask</button></form></div></div>`;
  const js = `<script>/*ask-bar*/(function(){
var iframe=document.getElementById('df-hero-embed');var bar=document.getElementById('df-askbar');
var form=document.getElementById('df-askbar-form');var input=document.getElementById('df-askbar-input');
var heroChat=document.getElementById('chat')||iframe;var footer=document.querySelector('footer');
var heroOut=false,footerNear=false;function sync(){if(bar)bar.classList.toggle('show',heroOut&&!footerNear);}
window.addEventListener('message',function(e){var d=e.data;if(!d||d.type!=='divinci-embed-height'||!d.height)return;if(iframe){iframe.style.height=Math.min(Math.max(d.height,360),1500)+'px';}});
if(heroChat&&'IntersectionObserver' in window){new IntersectionObserver(function(en){heroOut=en[0].intersectionRatio<0.12;sync();},{threshold:[0,0.12,1]}).observe(heroChat);}
if(footer&&'IntersectionObserver' in window){new IntersectionObserver(function(en){footerNear=en[0].isIntersecting;sync();},{rootMargin:'0px 0px 140px 0px'}).observe(footer);}
var heroFocus=function(){var top=document.getElementById('top')||iframe;if(top)top.scrollIntoView({behavior:'smooth',block:'start'});try{var el=iframe&&iframe.contentDocument&&iframe.contentDocument.querySelector('textarea,input[type=text],input[type=email],input:not([type])');if(el)setTimeout(function(){el.focus({preventScroll:true});},460);}catch(e){}if(bar)bar.classList.remove('show');};
if(input){input.readOnly=true;input.style.cursor='pointer';input.addEventListener('click',heroFocus);input.addEventListener('focus',heroFocus);}
if(form){form.addEventListener('submit',function(ev){ev.preventDefault();heroFocus();});}
/* autofocus the hero chat's first input on load (same-origin embed) */
var done=false;function fz(){if(done)return;try{var doc=iframe&&iframe.contentDocument;if(!doc)return;var el=doc.querySelector('textarea,input[type=text],input[type=email],input:not([type])');if(el){el.focus({preventScroll:true});done=true;}}catch(e){}}
if(iframe){iframe.addEventListener('load',fz);[400,1000,2000].forEach(function(t){setTimeout(fz,t);});}
})();</script>`;
  out = out.includes("</head>") ? out.replace("</head>", `${css}\n</head>`) : css + out;
  out = out.includes("</body>") ? out.replace("</body>", `${bar}\n${js}\n</body>`) : out + bar + js;
  return out;
}

/**
 * Ensure the footer carries the legal links (AI Safety · Terms · Privacy).
 * The generated footer often drops them; re-add a muted, color-inheriting row
 * before </footer> so it reads on light OR dark footers. Idempotent: skipped if
 * the footer already links terms-of-service.
 */
function injectFooterLegal(html: string, links?: PolishOpts["links"]): string {
  const start = html.search(/<footer\b/i);
  if (start === -1) return html;
  const end = html.indexOf("</footer>", start);
  if (end === -1) return html;
  const region = html.slice(start, end);
  if (/terms-of-service|terms of service/i.test(region)) return html; // already present
  const terms = links?.terms ?? "https://divinci.ai/terms-of-service/?ref=footer";
  const privacy = links?.privacy ?? "https://divinci.ai/privacy-policy/?ref=footer";
  const safety = links?.aiSafety ?? "https://divinci.ai/ai-safety/?ref=footer";
  const lk = (href: string, label: string) =>
    `<a href="${href}" target="_blank" rel="noopener" style="color:inherit;opacity:.85;text-decoration:none">${label}</a>`;
  const block = `\n  <div style="max-width:72rem;margin:.75rem auto 0;padding:0 1.5rem;text-align:center;font-size:.8rem;opacity:.75;display:flex;flex-wrap:wrap;gap:.25rem .75rem;justify-content:center;align-items:center">${lk(safety, "AI Safety")}<span style="opacity:.4">·</span>${lk(terms, "Terms of Service")}<span style="opacity:.4">·</span>${lk(privacy, "Privacy Policy")}</div>\n`;
  return html.slice(0, end) + block + html.slice(end);
}

// ── Language Switcher (fixed top-right globe dropdown with glyph animation) ──

const LS_GLOBE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`;

function renderLanguageSwitcher(p: PolishOpts["palette"]): string {
  const items = LOCALES.map(
    (l, i) =>
      `<button class="ls-i" role="menuitem" data-locale="${l.code}" data-index="${i}">` +
      `<span class="ls-f">${l.flag}</span>` +
      `<span class="ls-t">${l.autonym}</span>` +
      `</button>`
  ).join("");
  const css = `<style>/*ls-globe*/
.ls-r{position:relative;z-index:60;display:inline-flex;align-items:center}
.ls-b{align-items:center;background:rgba(255,255,255,.88);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);border:1px solid ${a(p.primary,"30")};border-radius:999px;color:${p.text};cursor:pointer;display:flex;font-size:1.05rem;gap:.35rem;height:2.5rem;justify-content:center;padding:.4rem;transition:border-color .2s,box-shadow .2s;width:2.5rem}
.ls-b:focus-visible{outline:2px solid ${p.accent};outline-offset:2px}
.ls-b:hover{border-color:${p.primary};box-shadow:0 0 0 3px ${a(p.primary,"1c")}}
.ls-b{position:relative}
.ls-b svg{flex:none;transition:opacity .25s}
.ls-gl{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:1.15rem;font-weight:700;line-height:1;opacity:0;transition:opacity .25s;pointer-events:none}
.ls-b:hover svg{opacity:0}
.ls-b:hover .ls-gl{opacity:1}
.ls-d{background:rgba(255,255,255,.96);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);border:1px solid ${a(p.primary,"22")};border-radius:1rem;box-shadow:0 8px 40px rgba(0,0,0,.15);display:none;margin-top:.5rem;max-height:60vh;overflow-y:auto;padding:.5rem;position:absolute;right:0;top:100%;width:max-content;min-width:200px}
.ls-r.open .ls-d{display:block}
.ls-i{background:transparent;border:0;border-radius:.6rem;color:${p.text};cursor:pointer;display:flex;font-size:.9rem;gap:.5rem;padding:.4rem .65rem;transition:background .12s;width:100%;text-align:left;white-space:nowrap}
.ls-i:hover,.ls-i.hov{background:${a(p.primary,"0e")}}
.ls-i:focus-visible{outline:2px solid ${p.accent};outline-offset:-2px}
.ls-f{font-size:1.15rem;line-height:1}
.ls-t{position:relative;overflow:hidden}
</style>`;
  const js = `<script>/*ls-globe*/(function(){
var C=${JSON.stringify(LOCALES.map(l=>l.autonym))},P=${JSON.stringify(p.primary)};
var r=document.querySelector('.ls-r'),b=r.querySelector('.ls-b'),d=r.querySelector('.ls-d');
/* relocate the globe into the header nav (before the Ask-the-AI CTA) so it never overlaps it */
try{var hnav=document.querySelector('header nav')||document.querySelector('header');if(hnav){var ask=Array.prototype.find.call(hnav.querySelectorAll('a,button'),function(x){return /ask\\s+the\\s+ai/i.test((x.textContent||'').trim());});if(ask&&ask.parentNode===hnav){hnav.insertBefore(r,ask);}else{hnav.appendChild(r);}}}catch(e){}
/* globe→glyph carousel on hover (acmenutrition parity): cycle scripts to signal "switch language" */
var gx=b.querySelector('.ls-gl'),GL=['あ','中','ع','文','ñ'],gi=0,gt=null;
if(gx){b.addEventListener('mouseenter',function(){if(gt)return;gx.textContent=GL[gi%GL.length];gt=setInterval(function(){gi++;gx.textContent=GL[gi%GL.length];},900);});b.addEventListener('mouseleave',function(){if(gt){clearInterval(gt);gt=null;}gx.textContent='';});}
b.addEventListener('click',function(e){e.stopPropagation();r.classList.toggle('open');b.setAttribute('aria-expanded',r.classList.contains('open'));});
document.addEventListener('click',function(e){if(!r.contains(e.target)){r.classList.remove('open');b.setAttribute('aria-expanded','false');}});
d.addEventListener('keydown',function(e){if(e.key==='Escape'){r.classList.remove('open');b.focus();}});
/* navigate to the selected locale (en→/, others→/<code>/) */
d.addEventListener('click',function(e){var i=e.target.closest('.ls-i');if(!i)return;var code=i.dataset.locale;try{localStorage.setItem('df-lang',code);}catch(_){}location.assign(code==='en'?'/':'/'+code+'/');});
/* Glyph animation: on hover, scramble the autonym characters briefly */
d.addEventListener('mouseover',function(e){var i=e.target.closest('.ls-i');if(!i)return;
var idx=+i.dataset.index,target=C[idx],t=i.querySelector('.ls-t');
if(t._lsAnim)return;t._lsAnim=true;var orig=t.textContent,len=target.length;
var chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
var step=0,steps=8;var iv=setInterval(function(){step++;
var r='';for(var j=0;j<len;j++){if(step>=steps||j>=step){r+=target[j];}else{r+=chars[Math.floor(Math.random()*chars.length)];}}
t.textContent=r;if(step>=steps+4){clearInterval(iv);t.textContent=target;t._lsAnim=false;}},48);});
var items=d.querySelectorAll('.ls-i');var idx=-1;
d.addEventListener('keydown',function(e){if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();
var dir=e.key==='ArrowDown'?1:-1;if(idx===-1)idx=dir===1?0:items.length-1;else idx=Math.max(0,Math.min(items.length-1,idx+dir));
items.forEach(function(el,i){el.classList.toggle('hov',i===idx);});if(idx>=0)items[idx].focus();}});
})();</script>`;
  return `${css}<div class="ls-r" role="combobox" aria-expanded="false" aria-haspopup="menu" aria-label="Switch language"><button class="ls-b" aria-label="Switch language">${LS_GLOBE_SVG}<span class="ls-gl" aria-hidden="true"></span></button><div class="ls-d" role="menu">${items}</div></div>${js}`;
}

/** Inject the language-switcher globle+dropdown into the page body. */
function injectLanguageSwitcher(html: string, p: PolishOpts["palette"]): string {
  if (html.includes('class="ls-r"')) return html;
  const block = renderLanguageSwitcher(p);
  return html.includes("</body>") ? html.replace("</body>", `${block}\n</body>`) : html + block;
}

// ── Example Cards — REMOVED ──
// The example-cards row was a non-interactive duplicate of the in-chat
// "Try asking" starters (which are release-specific + functional). acmenutrition has
// no such row, so we strip both the marker and any previously-injected .ec-row.

function stripExampleCards(html: string): string {
  return html
    .replace(/\s*<!--EXAMPLE_CARDS-->\s*/g, "")
    .replace(/<style>\/\*ex-cards\*\/[\s\S]*?<\/style>\s*<div class="ec-row"[\s\S]*?<\/div>/g, "");
}

// ── Language Pills (corpus #how section) ──

function renderLanguagePills(p: PolishOpts["palette"]): string {
  const pills = LOCALES.map((l) => `<span class="lp-pill">${l.flag} ${escHtml(l.autonym)}</span>`).join("");
  const css = `<style>/*lang-pills*/
.lp-row{display:flex;flex-wrap:wrap;gap:.4rem;justify-content:center;padding:1.5rem 0}
.lp-pill{background:${a(p.soft,"70")};border-radius:999px;color:${p.text};font-size:.78rem;padding:.2rem .65rem;white-space:nowrap;line-height:1.7;opacity:.8}
</style>`;
  return `${css}<div class="lp-row" aria-label="Supported languages">${pills}</div>`;
}

function injectLanguagePills(html: string, p: PolishOpts["palette"]): string {
  if (!html.includes("<!--LANGUAGE_PILLS-->")) return html;
  const block = renderLanguagePills(p);
  return html.replace("<!--LANGUAGE_PILLS-->", block);
}

// ── QA Results ──

function renderQaResults(opts: PolishOpts): string {
  const p = opts.palette;
  const score = typeof opts.qaScore === "number";
  const counts = typeof opts.qaPassedCount === "number" && typeof opts.qaTestCount === "number";
  if (!score && !counts) return ""; // nothing to show
  const hasLinks = opts.qaRunId && opts.qaSuiteId && opts.workspaceId;
  const runUrl = hasLinks
    ? `https://divinci.ai/app/${opts.workspaceId}/qa/${opts.qaSuiteId}/run/${opts.qaRunId}`
    : null;
  const css = `<style>/*qa-results*/
.qa-sec{background:${a(p.soft,"50")};border-radius:1.5rem;margin:2rem auto;max-width:36rem;padding:2rem;text-align:center}
.qa-sec h3{color:${p.primary};font-size:1.3rem;margin:0 0 1.2rem}
.qa-row{display:flex;gap:2rem;justify-content:center;flex-wrap:wrap}
.qa-stat{text-align:center}
.qa-num{color:${p.primary};display:block;font-size:2rem;font-weight:700;line-height:1.1}
.qa-lbl{color:${p.text};font-size:.82rem;opacity:.75}
.qa-link{color:${p.accent};display:inline-block;font-size:.85rem;margin-top:1rem;text-decoration:none}
.qa-link:hover{text-decoration:underline}
</style>`;
  let stats = "";
  if (score) stats += `<div class="qa-stat"><span class="qa-num">${(opts.qaScore! * 100).toFixed(0)}%</span><span class="qa-lbl">score</span></div>`;
  if (counts) stats += `<div class="qa-stat"><span class="qa-num">${opts.qaPassedCount}/${opts.qaTestCount}</span><span class="qa-lbl">tests passed</span></div>`;
  const link = runUrl ? `<a class="qa-link" href="${runUrl}" target="_blank" rel="noopener">View full report →</a>` : "";
  const section = `<section class="qa-sec"><h3>QA Test Results</h3><div class="qa-row">${stats}</div>${link}</section>`;
  return `${css}\n${section}`;
}

function injectQaResults(html: string, opts: PolishOpts): string {
  if (!html.includes("<!--QA_RESULTS-->")) return html;
  const block = renderQaResults(opts);
  if (!block) return html.replace("<!--QA_RESULTS-->", ""); // no data → remove marker silently
  return html.replace("<!--QA_RESULTS-->", block);
}

/**
 * Header logo legibility: a colored/dark logo blends into the dark primary
 * header bar. Wrap it in a white "chip" for contrast (when logoIsLight is
 * falsy), and ALWAYS de-crop — drop the rounded-full/object-cover that
 * truncates a wide wordmark logo into a circle — normalizing to object-contain
 * + auto width. Idempotent via the data-logo-fixed / logo-chip markers.
 */
function upgradeHeaderLogo(html: string, logoIsLight: boolean | undefined): string {
  if (html.includes("logo-chip") || html.includes("data-logo-fixed")) return html;
  const hStart = html.indexOf("<header");
  const hEnd = html.indexOf("</header>");
  if (hStart === -1 || hEnd === -1) return html;
  const header = html.slice(hStart, hEnd);
  const m = header.match(/<img\b[^>]*\blogo[^>]*>/i);
  if (!m) return html;
  const imgTag = m[0];
  const src = (imgTag.match(/\bsrc="([^"]*)"/i) || [])[1] || "/brand/logo.svg";
  const alt = (imgTag.match(/\balt="([^"]*)"/i) || [])[1] || "logo";
  const img =
    `<img data-logo-fixed src="${src}" alt="${alt}" style="height:46px;width:auto;` +
    `max-width:230px;object-fit:contain;display:block;flex-shrink:0;">`;
  const replacement = logoIsLight
    ? img
    : `<span class="logo-chip" style="display:inline-flex;align-items:center;` +
      `background:#ffffff;border-radius:14px;padding:6px 13px;flex-shrink:0;` +
      `box-shadow:0 1px 3px rgba(0,0,0,.18);">${img}</span>`;
  const newHeader = header.replace(imgTag, replacement);
  return html.slice(0, hStart) + newHeader + html.slice(hStart + header.length);
}

/**
 * Hero starter type-ahead (acmenutrition-style): hovering a conversation starter in
 * the hero chat types it into the chat input (clears on mouse-out). The starters
 * live in the same-origin /embed/ iframe, so this wires from the parent into the
 * embed via the native value setter + input event (so React state follows).
 * Idempotent; no-ops if there's no tagged hero embed.
 */
function injectHeroTypeahead(html: string): string {
  if (html.includes("/*hero-typeahead*/")) return html;
  if (!html.includes('id="df-hero-embed"')) return html;
  const js = `<script>/*hero-typeahead*/(function(){
var f=document.getElementById('df-hero-embed');if(!f)return;
function nativeSet(ta,v){try{var s=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;s.call(ta,v);ta.dispatchEvent(new Event('input',{bubbles:true}));}catch(e){ta.value=v;}}
function wire(){var d;try{d=f.contentDocument;}catch(e){return false;}if(!d)return false;
var ta=d.querySelector('textarea');if(!ta)return false;
var btns=[].slice.call(d.querySelectorAll('button')).filter(function(b){var t=(b.textContent||'').trim();return t.length>=12&&/\\?\\s*$/.test(t);});
if(!btns.length)return false;if(ta.__ta)return true;ta.__ta=1;
var timer=null,preview='',committed=false;
btns.forEach(function(b){var full=(b.textContent||'').trim();
 b.addEventListener('mouseenter',function(){if(committed)return;if(ta.value&&ta.value!==preview)return;clearInterval(timer);var i=0;
  timer=setInterval(function(){i++;preview=full.slice(0,i);nativeSet(ta,preview);if(i>=full.length){clearInterval(timer);}},20);});
 b.addEventListener('mouseleave',function(){clearInterval(timer);if(!committed&&ta.value===preview){nativeSet(ta,'');preview='';}});
 b.addEventListener('mousedown',function(){committed=true;clearInterval(timer);});});
return true;}
var n=0,iv=setInterval(function(){n++;if(wire()===true||n>32){clearInterval(iv);}},250);
f.addEventListener('load',function(){var m=0,iv2=setInterval(function(){m++;if(wire()===true||m>32){clearInterval(iv2);}},250);});
})();</script>`;
  return html.includes("</body>") ? html.replace("</body>", `${js}\n</body>`) : html + js;
}

/** Put "Real answers," on its own line in the #example section heading.
 *  Idempotent: once a <br> is inserted the spaced source string no longer matches. */
function addExampleHeadingBreak(html: string): string {
  return html.replace("Real answers, straight from", "Real answers,<br>straight from");
}

export function polishFoundation(html: string, opts: PolishOpts): string {
  let out = html;
  out = addExampleHeadingBreak(out);
  if (opts.corpusVideo?.videoUrl) {
    out = injectCorpusVideo(out, renderCorpusVideo(opts.corpusVideo.videoUrl, opts.corpusVideo.posterUrl, opts.palette));
  }
  out = upgradeHeaderLogo(out, opts.logoIsLight);
  out = injectHeaderNowrap(out);
  out = injectMobileNav(out, opts.palette);
  out = injectAvatarParity(out, opts.palette);
  if (opts.team?.count === 1 && opts.team.leadName) {
    out = fixSingleMemberTeamHeading(out, opts.team.leadName);
  }
  if (opts.heroImageUrl) {
    out = injectHeroAnimation(out, opts.heroImageUrl, opts.palette);
  }
  out = injectFooterLegal(out, opts.links);
  out = injectAskBar(out, opts.palette, opts.productName);
  out = injectHeroTypeahead(out);
  // New sections (acmenutrition.ai parity)
  out = injectLanguageSwitcher(out, opts.palette);
  out = injectLanguagePills(out, opts.palette);
  // Example-cards row intentionally NOT injected: it duplicates the in-chat
  // "Try asking" starters and acmenutrition has no such row. Strip the marker (and
  // any previously-injected .ec-row) so neither renders.
  out = stripExampleCards(out);
  out = injectQaResults(out, opts);
  return out;
}
