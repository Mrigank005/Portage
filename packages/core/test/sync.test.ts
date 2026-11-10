// Generated files must match their sources, and plans must only name reference code that exists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { planMigration, REFERENCES, referenceCode, scanRepo, skillMarkdown } from "../src/index.ts";
import { REFERENCE_SOURCES } from "../src/reference-sources.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");

test("SKILL.md is the playbook (run npm run skill:sync after editing playbook.ts)", () => {
  const skill = fs.readFileSync(path.join(root, "plugin/skills/portage-migrate/SKILL.md"), "utf8").replace(/\r\n/g, "\n");
  assert.equal(skill, skillMarkdown());
});

test("embedded reference sources match the reference files (run npm run reference:embed after editing them)", () => {
  const dir = path.join(root, "packages/core/reference");
  const files = fs.readdirSync(dir).filter((f) => /\.(ts|tsx|js)$/.test(f)).sort();
  assert.deepEqual(Object.keys(REFERENCE_SOURCES).sort(), files);
  for (const f of files) assert.equal(REFERENCE_SOURCES[f], fs.readFileSync(path.join(dir, f), "utf8").replace(/\r\n/g, "\n"), f);
  for (const r of REFERENCES) assert.ok(files.includes(r.file), `${r.name} points at a missing file`);
});

test("plans name reference code that exists, for the right kind of page", () => {
  const names = new Set(REFERENCES.map((r) => r.name));
  const brewbox = planMigration(scanRepo(path.join(root, "suite/brewbox-store")));
  const quill = planMigration(scanRepo(path.join(root, "suite/quill-saas")));
  for (const p of [brewbox, quill]) for (const s of p.steps) for (const r of s.reference ?? []) assert.ok(names.has(r), `${s.id} names unknown reference ${r}`);
  const refs = (p: typeof brewbox, id: string) => p.steps.find((s) => s.id === id)?.reference;
  assert.deepEqual(refs(brewbox, "paypal-client"), ["paypal-client", "paypal-money"]);
  assert.deepEqual(refs(brewbox, "webhook-route"), ["paypal-webhook"]);
  assert.deepEqual(refs(brewbox, "buttons"), ["PayPalButtons"], "a React page gets the React buttons");
  assert.deepEqual(refs(quill, "buttons"), ["paypal-buttons-browser"], "server-rendered HTML gets the browser script");
});

test("reference code converts to JavaScript that Node can parse", async () => {
  for (const r of REFERENCES.filter((x) => x.kind === "server")) {
    for (const mod of ["esm", "commonjs"] as const) {
      const js = referenceCode(r.name, "javascript", mod);
      // Syntax check without running it.
      const file = path.join(os.tmpdir(), `portage-ref-${process.pid}-${r.name}.${mod === "commonjs" ? "cjs" : "mjs"}`);
      fs.writeFileSync(file, js.code);
      try {
        const check = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
        assert.equal(check.status, 0, `${js.filename}: ${check.stderr}`);
      } finally {
        fs.rmSync(file, { force: true });
      }
    }
  }
  assert.throws(() => referenceCode("nope"), /No reference called "nope"/);
});
