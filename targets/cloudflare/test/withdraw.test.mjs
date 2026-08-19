// Withdrawing a published site whose owner refuses AI use.
//
// Two invariants carry all the weight, and both are about not lying:
//   1. The IRREVERSIBLE step runs LAST, so a mid-way failure leaves a
//      recoverable state rather than a live directory card pointing at a
//      corpus we already deleted.
//   2. `withdrawn` is true ONLY when the corpus is actually gone. A withdrawal
//      that delists a site while it keeps answering from the owner's content
//      is the failure this module exists to prevent, and reporting it as
//      success would conceal precisely that.
import { withdrawHost, slugify } from "../src/withdraw.js";

let fail = 0;
const ok = (c, m) => { if (!c) { console.log("  ❌ " + m); fail++; } else console.log("  ✅ " + m); };

// The slug must match index.js's slugify EXACTLY or we destroy the wrong
// database — or, more likely, none at all, and report success.
ok(slugify("www.si.edu") === "si-edu", "www is stripped and dots become hyphens: www.si.edu -> si-edu");
ok(slugify("naturalhistory.si.edu") === "naturalhistory-si-edu", "matches the wrp-<slug> database name");
ok(slugify("WWW.Example.COM") === "example-com", "case-folds, so a host cannot miss its own database");

function fakeEnv() {
  const order = [], puts = [];
  return {
    order, puts,
    BUCKET: {
      put: async (k, v) => { order.push(`put:${k.split("/")[0]}`); puts.push([k, v]); },
      delete: async (k) => { order.push(`del:${k.split("/")[0]}`); },
    },
  };
}

/** Recording stubs; each pushes its own name so ORDER is observable. */
function stubs(env, { destroyOk = true, directoryOk = true } = {}) {
  return {
    removeFromDirectory: async () => { env.order.push("directory"); return { ok: directoryOk, ...(directoryOk ? {} : { reason: "500" }) }; },
    deprecateRelease: async (_e, id) => { env.order.push("deprecate"); return id ? { ok: true } : { ok: true, skipped: "no release linked" }; },
    destroyCorpus: async () => { env.order.push("destroy"); return destroyOk ? { ok: true, database: "wrp-x" } : { ok: false, database: "wrp-x", reason: "turso 500" }; },
    deleteArtifacts: async (_e, slug) => { env.order.push("artifacts"); return { ok: true, deleted: [`sites/${slug}/raw.json`, `sites/${slug}/chunks.json`, `sites/${slug}/links.json`] }; },
    deleteActivityEvents: async () => { env.order.push("activity"); return { ok: true, deleted: 2 }; },
  };
}

{
  const env = fakeEnv();
  const r = await withdrawHost(env, { host: "example.com", releaseId: "r1", reason: "reserves AI use" }, stubs(env));

  const iDir = env.order.indexOf("directory");
  const iDep = env.order.indexOf("deprecate");
  const iDes = env.order.indexOf("destroy");
  ok(iDir >= 0 && iDep >= 0 && iDes >= 0, "all three remote steps ran");
  ok(iDir < iDes && iDep < iDes,
     "the IRREVERSIBLE corpus destroy runs LAST, after both reversible steps");
  ok(r.withdrawn === true, "reports withdrawn when the corpus is actually gone");
  ok(r.steps.activity?.ok === true,
     "clears the site's publish events, so the public feed stops naming a withdrawn host");
  ok(env.puts.some(([k]) => k.startsWith("withdrawn/")), "writes the evidence record");
  ok(env.puts.some(([k]) => k.startsWith("seeds")), "tombstones the host so it cannot be re-queued");

  const ev = JSON.parse(env.puts.find(([k]) => k.startsWith("withdrawn/"))[1]);
  ok(ev.steps.directory && ev.steps.release && ev.steps.corpus, "the record carries a per-step outcome");
  ok(/withdrawn:/.test(JSON.parse(env.puts.find(([k]) => k.startsWith("seeds"))[1]).reason),
     "the tombstone reason marks it as WITHDRAWN, which is what /submit refuses on");
}

{
  // The whole point: a corpus that survives must NOT be reported as withdrawn.
  const env = fakeEnv();
  const r = await withdrawHost(env, { host: "example.com", releaseId: "r1", reason: "x" },
                               stubs(env, { destroyOk: false }));
  ok(r.withdrawn === false, "a FAILED destroy is never rounded up to withdrawn");
  ok(r.steps.corpus.ok === false, "the failing step names itself");
  ok(env.puts.some(([k]) => k.startsWith("withdrawn/")),
     "still writes evidence on partial failure — a silent partial is unrecoverable");
}

{
  // Tidying the card is secondary to ending the use.
  const env = fakeEnv();
  const r = await withdrawHost(env, { host: "example.com", releaseId: "r1", reason: "x" },
                               stubs(env, { directoryOk: false }));
  ok(r.steps.directory.ok === false, "records the directory failure");
  ok(r.withdrawn === true, "still destroys the corpus — ending the use outranks tidying the card");
}

{
  const env = fakeEnv();
  const r = await withdrawHost(env, { host: "example.com", releaseId: null, reason: "x" }, stubs(env));
  ok(r.steps.release.skipped === "no release linked", "a host with no release skips deprecation cleanly");
  ok(r.withdrawn === true, "and still counts as withdrawn once the corpus is gone");
}

{
  // Idempotence: an "already gone" database is success, so a retry after a
  // partial run can finish rather than erroring out on step three forever.
  const env = fakeEnv();
  const s = stubs(env);
  s.destroyCorpus = async () => { env.order.push("destroy"); return { ok: true, alreadyGone: true, database: "wrp-x" }; };
  const r = await withdrawHost(env, { host: "example.com", releaseId: "r1", reason: "x" }, s);
  ok(r.withdrawn === true, "an already-destroyed corpus counts as withdrawn, making retries safe");
}

{
  // Regression: links.json is derived from the withdrawn site's own pages, so
  // it must go with them. It was added to the crawler after this list existed,
  // which is exactly how an artifact gets left behind.
  const { deleteArtifacts } = await import("../src/withdraw.js");
  const asked = [];
  const env = { BUCKET: { delete: async (k) => { asked.push(k); } } };
  const r = await deleteArtifacts(env, "example-com");
  ok(asked.includes("sites/example-com/links.json"),
     "withdrawal deletes the link map, not just raw and chunks");
  ok(r.deleted.length === 3, "and reports every artifact it removed");
}

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
