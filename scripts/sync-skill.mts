// Writes plugin/skills/portage-migrate/SKILL.md from the playbook in packages/core/src/playbook.ts.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { skillMarkdown } from "../packages/core/src/playbook.ts";

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../plugin/skills/portage-migrate/SKILL.md");
fs.writeFileSync(file, skillMarkdown());
console.log(`Wrote ${path.relative(process.cwd(), file)}`);
