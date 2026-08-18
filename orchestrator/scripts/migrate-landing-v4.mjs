/**
 * migrate-landing-v4 — roll the two general code refinements onto existing demos'
 * foundation.html (idempotent):
 *   1. Hero starter typeahead (hover a starter → types into the embed chat input).
 *   2. Ask bar now scrolls to AND focuses the hero chat input (was: scroll to #example).
 *
 * Updates foundation.html only; the translate+build+deploy driver copies it over
 * dist/index.html. Run with no args (all demos) — excelspine is skipped by guards.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RUNS = resolve(dirname(fileURLToPath(import.meta.url)), "../../runs");
const TARGETS = [
  ["excelspine","2026-06-15-001"],["amymyersmd","2026-06-15-001"],["backincontrol","2026-06-15-001"],
  ["caseymeans","2026-06-15-001"],["centenoschultz","2026-06-15-001"],["discsportsspine","2026-06-15-001"],
  ["drchatterjee","2026-06-15-001"],["drhyman","2026-06-15-001"],["drvondawright","2026-06-15-001"],
  ["drwilliamli","2026-06-15-001"],["mdspinecare","2026-06-10-001"],["nutritionfacts","2026-06-15-001"],
  ["peterattiamd","2026-06-15-001"],["stoneclinic","2026-06-14-001"],["texasback","2026-06-15-001"],
];

const ASK_OLD =
  "if(form){form.addEventListener('submit',function(ev){ev.preventDefault();var text=(input.value||'').trim();if(!text)return;if(iframe&&iframe.contentWindow){iframe.contentWindow.postMessage({type:'divinci-ask',text:text},'*');}input.value='';(document.getElementById('example')||heroChat).scrollIntoView({behavior:'smooth',block:'start'});if(bar)bar.classList.remove('show');});}";
const ASK_NEW =
  "var heroFocus=function(){var top=document.getElementById('top')||iframe;if(top)top.scrollIntoView({behavior:'smooth',block:'start'});try{var el=iframe&&iframe.contentDocument&&iframe.contentDocument.querySelector('textarea,input[type=text],input[type=email],input:not([type])');if(el)setTimeout(function(){el.focus({preventScroll:true});},460);}catch(e){}if(bar)bar.classList.remove('show');};" +
  "if(input){input.readOnly=true;input.style.cursor='pointer';input.addEventListener('click',heroFocus);input.addEventListener('focus',heroFocus);}" +
  "if(form){form.addEventListener('submit',function(ev){ev.preventDefault();heroFocus();});}";

const TYPEAHEAD =
  `<script>/*hero-typeahead*/(function(){
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

let n = 0;
for (const [p, run] of TARGETS) {
  const fpath = join(RUNS, p, run, "landing", "foundation.html");
  if (!existsSync(fpath)) { console.log(`SKIP ${p}`); continue; }
  let html = readFileSync(fpath, "utf8");
  const flags = [];
  if (html.includes(ASK_OLD)) { html = html.replace(ASK_OLD, ASK_NEW); flags.push("askbar"); }
  if (!html.includes("/*hero-typeahead*/") && html.includes('id="df-hero-embed"') && html.includes("</body>")) {
    html = html.replace("</body>", `${TYPEAHEAD}\n</body>`); flags.push("typeahead");
  }
  writeFileSync(fpath, html);
  n++;
  console.log(`OK ${p.padEnd(16)} [${flags.join(",") || "—"}]`);
}
console.log(`\nPatched ${n}/${TARGETS.length}.`);
