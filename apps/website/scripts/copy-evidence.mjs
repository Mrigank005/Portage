// Copies each run's screenshots from benchmark/runs/<run>/verify/ into public/evidence/<run>/, so the site serves the
// same files the repository publishes (they are never edited or re-encoded). public/evidence/ is generated, not committed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const runs = path.resolve(here, "../../../benchmark/runs");
const out = path.resolve(here, "../public/evidence");

fs.rmSync(out, { recursive: true, force: true });
let count = 0;
for (const run of fs.readdirSync(runs, { withFileTypes: true }).filter((d) => d.isDirectory())) {
  const dir = path.join(runs, run.name, "verify");
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".png"))) {
    fs.mkdirSync(path.join(out, run.name), { recursive: true });
    fs.copyFileSync(path.join(dir, f), path.join(out, run.name, f));
    count++;
  }
}
console.log(`Copied ${count} screenshots into public/evidence/`);
