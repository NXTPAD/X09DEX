// Cloudflare build step: finds (or creates) the X09 DEX KV namespace and writes its ID
// into wrangler.jsonc, so no one has to paste IDs by hand. Safe to run on every build.
import { execSync } from "node:child_process";
import fs from "node:fs";

const TITLE = "x09-dex-kv";
const FILE = "wrangler.jsonc";
const cfg = fs.readFileSync(FILE, "utf8");
if (!cfg.includes("PASTE_KV_NAMESPACE_ID_HERE")) { console.log(`${FILE} already has a KV namespace ID.`); process.exit(0); }

const run = (cmd) => execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
const find = () => {
  const out = run("npx wrangler kv namespace list");
  const list = JSON.parse(out.slice(out.indexOf("[")));
  return list.find((n) => n.title === TITLE)?.id || "";
};

let id = find();
if (!id) { console.log(`${TITLE} not found — creating it`); run(`npx wrangler kv namespace create ${TITLE}`); id = find(); }
if (!id) { console.error(`Could not find or create ${TITLE}`); process.exit(1); }
fs.writeFileSync(FILE, cfg.replace("PASTE_KV_NAMESPACE_ID_HERE", id));
console.log(`Using KV namespace ${TITLE} (${id})`);
