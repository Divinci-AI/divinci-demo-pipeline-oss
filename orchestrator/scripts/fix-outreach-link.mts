// One-off: replace the bare embed demo link in a live outreach task with the
// deployed branded landing-worker URL. Usage: tsx scripts/fix-outreach-link.mts
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getTask, updateTask } from "../src/review-board.js";

{
  const envPath = resolve(dirname(fileURLToPath(import.meta.url)), "../.env");
  if (existsSync(envPath))
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
}

const TASK_ID = "f512e558-ec80-490f-a9f0-53fc891a1541";
const EMBED = "https://embed.stage.divinci.app/?release=6a293367c50b252c45c6ca47";
const WORKER = "https://mdspinecare-landing.divinci-ai.workers.dev";

const task = await getTask(TASK_ID);
const before = task.description ?? "";
console.log("embed link present in description:", before.includes(EMBED));

let after = before.replaceAll(EMBED, WORKER);
// Annotate the demo-link line so a reader knows WHY this is the link to send.
after = after.replace(
  new RegExp(`(${WORKER.replace(/[.?*+^$()|[\]\\]/g, "\\$&")})(\\s*)$`, "m"),
  `$1 ← branded Cloudflare Worker (Divinci SDK release implementation) — send THIS, not the bare embed`,
);

if (after === before) {
  console.log("no change needed (embed link not found verbatim) — current description left intact");
} else {
  await updateTask(TASK_ID, { description: after });
  console.log("✓ updated task — embed link replaced with the deployed worker URL");
}
