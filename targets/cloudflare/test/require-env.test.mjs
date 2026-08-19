// The configuration guard. Its whole job is to fail on a fresh deployment
// BEFORE it spends anything, naming what is missing.
import { checkConfig, assertConfigured, REQUIRED_VARS, REQUIRED_SECRETS } from "../src/require-env.js";

let fail = 0;
const ok = (c, m) => { if (!c) { console.log("  ❌ " + m); fail++; } else console.log("  ✅ " + m); };

const FULL = {
  TURSO_ORG: "acme", WHITELABEL_ID: "wl-1", CF_ACCOUNT_ID: "acct",
  CF_BROWSER_TOKEN: "t", TURSO_PLATFORM_TOKEN: "t", DIVINCI_API_KEY: "t",
  TRIGGER_TOKEN: "t", BUCKET: {}, AI: {},
};

ok(checkConfig(FULL).ok === true, "a fully configured env passes");
ok(checkConfig({}).ok === false, "an empty env fails");
ok(checkConfig(undefined).ok === false, "an absent env fails rather than throwing");

{
  // Configuring one variable at a time across five deploys is how a check like
  // this comes to be resented and then removed.
  const m = checkConfig({}).missing;
  ok(m.length === REQUIRED_VARS.length + REQUIRED_SECRETS.length + 2,
     "EVERY missing value is reported at once, bindings included");
}

{
  const r = checkConfig({ ...FULL, TURSO_ORG: "   " });
  ok(r.ok === false && r.missing.includes("TURSO_ORG"),
     "whitespace is treated as unset — TURSO_ORG='' is not a configured org");
}

{
  const r = checkConfig({ ...FULL, BUCKET: undefined });
  ok(r.missing.includes("BUCKET"),
     "a missing R2 binding is named, not left to throw 'cannot read properties of undefined'");
}
{
  const r = checkConfig({ ...FULL, AI: undefined });
  ok(r.missing.includes("AI"), "a missing Workers AI binding is named");
}

{
  // DIRECTORY_URL is deliberately NOT required: unset selects own-corpus mode.
  ok(checkConfig(FULL).ok === true, "DIRECTORY_URL is optional — unset is a valid mode, not a gap");
  // Nor is the shared-corpus registration secret.
  ok(checkConfig({ ...FULL, WWW_RAG_THEME_WEBHOOK_SECRET: undefined }).ok === true,
     "the shared-directory registration secret is optional");
}

{
  let msg = "";
  try { assertConfigured({ ...FULL, TURSO_ORG: undefined }); } catch (e) { msg = e.message; }
  ok(/TURSO_ORG/.test(msg), "the error names the variable");
  ok(/Turso organisation/.test(msg), "…and says what it is for, not just that it is absent");
  ok(/README/.test(msg), "…and points at the documentation");
}

{
  let threw = false;
  try { assertConfigured(FULL); } catch { threw = true; }
  ok(threw === false, "a configured env does not throw");
}

{
  // The message must never carry a secret's VALUE — this string is logged by
  // the cron and returned by /run.
  let msg = "";
  try { assertConfigured({ ...FULL, TURSO_ORG: undefined, DIVINCI_API_KEY: "sk-super-secret" }); }
  catch (e) { msg = e.message; }
  ok(!/sk-super-secret/.test(msg), "no secret VALUE appears in the error text");
}

console.log();
if (fail) { console.log(`❌ ${fail} config assertion(s) failed`); process.exit(1); }
console.log("✅ configuration guard: all assertions passed");
