// Writes the portage-migrate skill from the playbook in packages/core/src/playbook.ts, to two places:
// plugin/skills/portage-migrate/SKILL.md (the Claude Code plugin) and .claude/skills/portage-migrate/SKILL.md (the
// project skill, so Claude Code has the playbook in this repository without installing the plugin).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { skillMarkdown } from "../packages/core/src/playbook.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const rel of ["plugin/skills/portage-migrate/SKILL.md", ".claude/skills/portage-migrate/SKILL.md"]) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, skillMarkdown());
  console.log(`Wrote ${rel}`);
}
