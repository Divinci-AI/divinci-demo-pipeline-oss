#!/usr/bin/env node
// divinci-local — crawl, chunk and embed on THIS machine, then sync only the
// finished vectors up to your Divinci workspace.
//
//   node src/cli.mjs check
//   node src/cli.mjs run https://example.com --whitelabel <id> --limit 50
//   node src/cli.mjs run https://example.com --whitelabel <id> --dry-run
//
// Nothing but the vectors leaves the machine, and embedding costs nothing.

import { crawlSite, DEFAULT_UA } from "./crawl.mjs";
// Imported from the Cloudflare target ON PURPOSE. Both targets must chunk
// identically or a corpus built half locally and half on the edge would hold
// two different chunkings of the same pages. One implementation is the only way
// to guarantee that; a copy would drift.
import { chunkMarkdown } from "../../cloudflare/src/chunk.js";
import { coalesceChunks } from "../../cloudflare/src/coalesce.js";
import { preflight, embedBatch, MODEL, DIM } from "./embed.mjs";
import { resolveSession, describeSession, NotAuthenticatedError } from "./session.mjs";
import { init, finalize, pushAll, contentHash } from "./sync.mjs";

const EMBED_BATCH = 32;   // laptop-sized; raise if you have GPU headroom

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = { _: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--whitelabel" || a === "-w") opts.whitelabel = rest[++i];
    else if (a === "--limit" || a === "-n") opts.limit = Number(rest[++i]);
    else if (a === "--delay") opts.delayMs = Number(rest[++i]);
    else if (a === "--profile") opts.profile = rest[++i];
    else if (a.startsWith("-")) { console.error(`unknown flag: ${a}`); process.exit(2); }
    else opts._.push(a);
  }
  return { cmd, opts };
}

async function cmdCheck() {
  let bad = 0;
  const pf = await preflight();
  if (pf.ok) console.log(`✅ Ollama: ${MODEL} (${DIM}-d) at ${pf.host}`);
  else { console.log(`❌ Ollama\n   ${pf.reason.replace(/\n/g, "\n   ")}`); bad++; }

  try {
    const s = resolveSession();
    console.log(`✅ Divinci session: ${describeSession(s)}`);
  } catch (e) {
    console.log(`❌ Divinci session\n   ${e.message.replace(/\n/g, "\n   ")}`);
    bad++;
  }
  console.log();
  console.log(bad ? `${bad} problem(s) — fix the above, then re-run \`check\`.` : "Ready.");
  process.exit(bad ? 1 : 0);
}

async function cmdRun(opts) {
  const url = opts._[0];
  if (!url) { console.error("usage: run <url> --whitelabel <id> [--limit N] [--dry-run]"); process.exit(2); }
  if (!opts.whitelabel && !opts.dryRun) {
    console.error("--whitelabel <id> is required (the workspace the vector is created in).\n" +
                  "No default: a default here would sync your corpus into somebody else's workspace.");
    process.exit(2);
  }

  const pf = await preflight();
  if (!pf.ok) { console.error(`❌ ${pf.reason}`); process.exit(1); }

  // Resolve the session BEFORE crawling. Discovering an expired login after
  // twenty minutes of crawling and embedding wastes all of it.
  let session = null;
  if (!opts.dryRun) {
    try { session = resolveSession({ profile: opts.profile }); }
    catch (e) { console.error(`❌ ${e.message}`); process.exit(e instanceof NotAuthenticatedError ? 30 : 1); }
    console.log(`   session: ${describeSession(session)}`);
  }

  const host = new URL(url).host;
  const limit = opts.limit ?? 100;

  console.log(`\n── crawl ${host} (limit ${limit}) ──`);
  const { pages, skipped, discovered } = await crawlSite(url, {
    limit, delayMs: opts.delayMs ?? 500, userAgent: DEFAULT_UA,
    onPage: ({ found, chars }) => process.stdout.write(`\r   ${found}/${limit} pages, last ${chars} chars   `),
  });
  console.log(`\n   ${pages.length} pages kept of ${discovered} discovered ` +
              `(${skipped.disallowed} disallowed, ${skipped.failed} failed, ${skipped.empty} too thin)`);
  if (!pages.length) { console.error("❌ nothing crawled — a JS-rendered site needs the Cloudflare target"); process.exit(1); }

  console.log(`\n── chunk ──`);
  const seen = new Set();
  const chunks = [];
  let rawCount = 0;
  for (const p of pages) {
    const split = chunkMarkdown(p.text);
    rawCount += split.length;
    // HTML-derived text splits into one fragment per menu item; coalesce back
    // into retrievable units before spending an embedding on each.
    for (const text of coalesceChunks(split)) {
      const h = contentHash(text);
      if (seen.has(h)) continue;          // identical boilerplate across pages
      seen.add(h);
      chunks.push({ contentHash: h, url: p.url, text });
    }
  }
  console.log(`   ${chunks.length} unique chunks (coalesced from ${rawCount} fragments)`);
  if (!chunks.length) { console.error("❌ no chunks survived — the pages had no substantial text"); process.exit(1); }

  console.log(`\n── embed (${MODEL}, on this machine) ──`);
  const rows = [];
  for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
    const slice = chunks.slice(i, i + EMBED_BATCH);
    const vecs = await embedBatch(slice.map((c) => c.text));
    slice.forEach((c, j) => rows.push({ ...c, embedding: vecs[j] }));
    process.stdout.write(`\r   ${rows.length}/${chunks.length}   `);
  }
  console.log(`\n   ${rows.length} vectors, ${DIM}-d — cost: nothing, and none of the text left this machine`);

  if (opts.dryRun) {
    console.log(`\n✅ dry run complete. ${rows.length} vectors ready; nothing was uploaded.`);
    return;
  }

  console.log(`\n── sync → ${session.apiUrl} ──`);
  const { vectorId } = await init(session, opts.whitelabel, host);
  console.log(`   vector ${vectorId}`);
  await pushAll(session, opts.whitelabel, vectorId, rows, {
    onProgress: ({ sent, total }) => process.stdout.write(`\r   ${sent}/${total} rows   `),
  });
  await finalize(session, opts.whitelabel, vectorId, rows.length);
  console.log(`\n\n✅ ${host}: ${rows.length} chunks synced to vector ${vectorId}`);
}

const { cmd, opts } = parseArgs(process.argv.slice(2));
try {
  if (cmd === "check") await cmdCheck();
  else if (cmd === "run") await cmdRun(opts);
  else {
    console.log("divinci-local — local crawl + embed, sync vectors to Divinci\n");
    console.log("  check                              verify Ollama and the CLI session");
    console.log("  run <url> --whitelabel <id>        crawl, embed locally, sync up");
    console.log("      --limit N     page cap (default 100)");
    console.log("      --delay MS    pause between requests (default 500)");
    console.log("      --dry-run     do everything except upload");
    console.log("      --profile P   divinci CLI profile (default: the CLI default)");
    process.exit(cmd ? 2 : 0);
  }
} catch (e) {
  console.error(`\n❌ ${e.message ?? e}`);
  process.exit(1);
}
