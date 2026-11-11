// portage try and portage init: what they write, and that they never lose a developer's own files.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { initAgent, setupTrial, trialPrompt } from "../src/setup.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "portage-cli-"));
const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });

test("try copies the app as git tracks it, writes its settings, and leaves a clean git baseline", async () => {
  const dir = path.join(tmp(), "quill-saas");
  const r = await setupTrial("quill", { dir, install: false });
  assert.ok(fs.existsSync(path.join(dir, "src", "server.ts")));
  assert.ok(fs.existsSync(path.join(dir, "package.json")));
  const env = fs.readFileSync(path.join(dir, ".env"), "utf8");
  assert.match(env, /^STRIPE_API_BASE=http:\/\/localhost:4242$/m, "Standin settings come from the app's own example");
  assert.match(env, /^PORT=4301$/m);
  assert.ok(!fs.existsSync(path.join(dir, "data")) && !fs.existsSync(path.join(dir, "node_modules")), "no local state is copied");
  assert.equal(git(dir, "status", "--porcelain").trim(), "", "the baseline commit holds everything, and the env file is ignored");
  assert.match(git(dir, "log", "--format=%s"), /quill-saas before Portage/);
  assert.ok(!git(dir, "ls-files").split("\n").includes(".env"), "the env file with sandbox keys is never tracked");
  assert.match(fs.readFileSync(r.promptFile, "utf8"), /setup_webhook_relay[\s\S]*verify_checkout/);
});

test("try refuses to overwrite a folder that already has work in it, unless forced", async () => {
  const dir = path.join(tmp(), "quill-saas");
  await setupTrial("quill", { dir, install: false });
  fs.writeFileSync(path.join(dir, "agent-notes.txt"), "work in progress");
  await assert.rejects(setupTrial("quill", { dir, install: false }), /already exists/);
  assert.ok(fs.existsSync(path.join(dir, "agent-notes.txt")), "refusing leaves the folder alone");
  await setupTrial("quill", { dir, install: false, force: true });
  assert.ok(!fs.existsSync(path.join(dir, "agent-notes.txt")));
});

test("the trial prompt names the app, how to start it, and which tools to use, and no setting values", () => {
  for (const [app, port, start] of [["quill", "4301", "node --env-file=.env"], ["brewbox", "4300", "npm run dev"]] as const) {
    const p = trialPrompt(app, path.join(process.cwd(), "trial", "x"));
    assert.match(p, new RegExp(port));
    assert.ok(p.includes(start));
    assert.match(p, /portage-migrate skill[\s\S]*`migrate` prompt/);
    assert.match(p, /Never print them/);
    assert.ok(!/sk_test|client_secret|password=/i.test(p));
  }
});

test("init for Copilot and Cursor merges into the project's MCP config and keeps its other servers", () => {
  const project = tmp();
  fs.mkdirSync(path.join(project, ".vscode"));
  fs.writeFileSync(path.join(project, ".vscode", "mcp.json"), JSON.stringify({ servers: { mine: { type: "stdio", command: "x" } }, inputs: [] }));
  const copilot = initAgent("copilot", { project });
  const vscode = JSON.parse(fs.readFileSync(path.join(project, ".vscode", "mcp.json"), "utf8"));
  assert.deepEqual(Object.keys(vscode.servers).sort(), ["context-matic", "mine", "portage"]);
  assert.deepEqual(vscode.inputs, [], "other settings in the file are kept");
  assert.equal(vscode.servers.portage.command, "node");
  assert.ok(fs.existsSync(vscode.servers.portage.args[0]), "the config points at the built bundle");
  assert.ok(fs.existsSync(path.join(path.dirname(vscode.servers.portage.args[0]), "node_modules", "playwright-core", "package.json")), "playwright-core sits next to the bundle");
  assert.match(copilot.next.join("\n"), /mcp\.portage\.migrate/);

  initAgent("cursor", { project });
  const cursor = JSON.parse(fs.readFileSync(path.join(project, ".cursor", "mcp.json"), "utf8"));
  assert.deepEqual(Object.keys(cursor.mcpServers).sort(), ["context-matic", "portage"]);
  assert.equal(cursor.mcpServers["context-matic"].headers["X-Apimatic-Mcp-Client"], "Cursor");
});

test("init refuses to rewrite an MCP config it can't parse", () => {
  const project = tmp();
  fs.mkdirSync(path.join(project, ".cursor"));
  fs.writeFileSync(path.join(project, ".cursor", "mcp.json"), "{ // comments aren't JSON\n}");
  assert.throws(() => initAgent("cursor", { project }), /isn't valid JSON/);
  assert.match(fs.readFileSync(path.join(project, ".cursor", "mcp.json"), "utf8"), /comments/, "the file is untouched");
});
