import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getTask } from "../src/review-board.js";
{ const e=resolve(dirname(fileURLToPath(import.meta.url)),"../.env");
  if(existsSync(e)) for(const l of readFileSync(e,"utf8").split("\n")){const m=l.match(/^([A-Z0-9_]+)=(.*)$/); if(m&&process.env[m[1]]===undefined)process.env[m[1]]=m[2];}}
const base = process.env.REVIEW_BOARD_URL ?? "http://localhost:7777";
function auth(){const id=process.env.CF_ACCESS_CLIENT_ID,s=process.env.CF_ACCESS_CLIENT_SECRET;return id&&s?{"CF-Access-Client-Id":id,"CF-Access-Client-Secret":s}:{};}
const [id, action] = process.argv.slice(2);
const t = await getTask(id);
console.log(`TASK ${id}\n  title: ${t.title}\n  status: ${t.status}`);
if (action === "done" || action === "cancel") {
  const status = action === "done" ? "DONE" : "CANCELED";
  const res = await fetch(`${base}/api/tasks/${id}`, { method:"PATCH", headers:{...auth(),"Content-Type":"application/json"}, body: JSON.stringify({ status }) });
  console.log(`PATCH status=${status} -> ${res.status}`);
  if(!res.ok) console.log(await res.text());
  const t2 = await getTask(id); console.log(`  now: ${t2.status}`);
} else {
  console.log("\n--- description ---\n" + (t.description || "(none)").slice(0, 1600));
}
