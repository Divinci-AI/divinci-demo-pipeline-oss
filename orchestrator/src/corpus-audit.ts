/**
 * corpus-audit.ts — how much of each demo corpus is JSON-LD page furniture?
 *
 * `jsonLdToMarkdown()` appended the entire flattened JSON-LD to every scraped
 * page under "## Structured Data". On a Yoast WordPress site that block is
 * larger than the page's prose, so the chunker made it the bulk of the corpus.
 * Acme Security measured 82% of chunks / 84% of chunk TEXT, and its /about/ page — 743
 * words on the actual space — contributed no prose at all. The live assistant
 * answered "I don't have specific details on the types of spaces available".
 *
 * Fixed at ingestion (server-resources process-html.ts, 2026-08-14), which only
 * helps NEW crawls. This tells us which existing corpora are worth re-crawling,
 * and — run again afterwards — whether the re-crawl actually worked.
 *
 * ⚠️ Judge a chunk by its FULL text, not a preview. A 120-char preview shows
 * only the furniture at the top of a chunk that may continue into real prose,
 * which is how a first pass here reported "0 prose keywords" for a corpus that
 * did contain some.
 */

/** A chunk is furniture-dominated when most of it is structured-data emissions. */
export function isFurnitureChunk(text: string): boolean {
  const lines = text.split("\n").map((l)=>(l.trim())).filter((l)=>(l.length > 0));
  if (lines.length === 0) return false;
  const structured = lines.filter((l)=>(/^\*\*(@?[\w@ >.-]+)\*\*\s*:/.test(l))).length;
  // Same shape as the retrieval-time filter (isBoilerplateChunk) so the two
  // agree about what furniture is — a metric that disagreed with the filter
  // would send us re-crawling corpora the filter was already handling.
  const hasFurnitureType =
    /\*\*Type\*\*:\s*(BreadcrumbList|ListItem|WebSite|WebPage|SearchAction|SiteNavigationElement|CollectionPage|ImageObject|ReadAction|EntryPoint)\b/.test(text);
  if (lines.length < 4) return hasFurnitureType && structured / lines.length >= 0.5;
  return structured / lines.length >= 0.6 && hasFurnitureType;
}

export interface CorpusStats {
  prospect: string;
  chunks: number;
  furniture: number;
  /** Share of CHUNKS that are furniture. */
  furnitureRate: number;
  /** Share of chunk TEXT (chars) that sits in furniture chunks — the better
   *  measure of wasted corpus, since furniture chunks are often long. */
  textRate: number;
}

export function summariseCorpus(prospect: string, texts: string[]): CorpusStats {
  const flags = texts.map(isFurnitureChunk);
  const furniture = flags.filter(Boolean).length;
  const totalChars = texts.reduce((a, t)=>(a + t.length), 0);
  const furnChars = texts.reduce((a, t, i)=>(a + (flags[i] ? t.length : 0)), 0);
  return {
    prospect,
    chunks: texts.length,
    furniture,
    furnitureRate: texts.length ? furniture / texts.length : 0,
    textRate: totalChars ? furnChars / totalChars : 0,
  };
}

/**
 * Worth re-crawling?
 *
 * 25% is deliberately not 0: every site emits SOME structured data, and a
 * re-crawl costs a full ingest plus the WWW-RAG submit. Below this the
 * retrieval-time filter handles it and the corpus is mostly real content.
 */
export const RECRAWL_THRESHOLD = 0.25;

export function needsRecrawl(s: CorpusStats): boolean {
  return s.chunks > 0 && s.furnitureRate >= RECRAWL_THRESHOLD;
}
