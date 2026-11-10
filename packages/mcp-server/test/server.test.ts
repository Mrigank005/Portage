// Talks to the real server over stdio with the official MCP client, both from source and as the bundled plugin file.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const suite = (name: string) => path.resolve(pkgDir, "../../suite", name);

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };

async function connect(args: string[]): Promise<Client> {
  const transport = new StdioClientTransport({ command: process.execPath, args, cwd: pkgDir, stderr: "pipe" });
  const client = new Client({ name: "portage-test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

const call = async (client: Client, name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as ToolResult;
const json = (r: ToolResult) => JSON.parse(r.content[1].text.replace(/^[^\n]*\n/, ""));

let dev: Client;
let bundled: Client;
let tmp: string;

before(async () => {
  dev = await connect(["--import", "tsx", "src/index.ts"]);
  // Build the plugin bundle into a folder with nothing else in it, to prove it is self-contained.
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "portage-mcp-"));
  const out = path.join(tmp, "portage-mcp.cjs");
  execFileSync(process.execPath, ["build.mjs", out], { cwd: pkgDir, stdio: "pipe" });
  bundled = await connect([out]);
});

after(async () => {
  await dev?.close();
  await bundled?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test("lists the two read-only tools, with instructions that require approval and ContextMatic", async () => {
  const { tools } = await dev.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["plan_migration", "scan_payment_surface"]);
  for (const t of tools) {
    assert.equal(t.annotations?.readOnlyHint, true, t.name);
    assert.deepEqual(t.inputSchema.required, ["repoPath"], t.name);
  }
  const plan = tools.find((t) => t.name === "plan_migration")!;
  assert.deepEqual((plan.inputSchema.properties as Record<string, { enum?: string[] }>).mode.enum, ["add", "replace"]);
  const instructions = dev.getInstructions() ?? "";
  assert.match(instructions, /approval/);
  assert.match(instructions, /context-matic/);
});

test("scan_payment_surface returns a readable report and the data", async () => {
  const r = await call(dev, "scan_payment_surface", { repoPath: suite("brewbox-store") });
  assert.ok(!r.isError);
  assert.match(r.content[0].text, /\*\*Result: supported\.\*\*/);
  const scan = json(r);
  assert.equal(scan.apps[0].framework.id, "next");
  assert.equal(scan.apps[0].webhooks[0].events[0].type, "checkout.session.completed");
});

test("plan_migration: ready for Quill in either mode, blocked for Ledgerline", async () => {
  const add = await call(dev, "plan_migration", { repoPath: suite("quill-saas") });
  assert.equal(json(add).status, "ready");
  assert.equal(json(add).mode, "add");
  assert.match(add.content[0].text, /Approve this plan to continue/);
  const replace = await call(dev, "plan_migration", { repoPath: suite("quill-saas"), mode: "replace" });
  assert.equal(json(replace).mode, "replace");
  const blocked = await call(dev, "plan_migration", { repoPath: suite("ledgerline-flask") });
  assert.equal(json(blocked).status, "blocked");
  assert.match(blocked.content[0].text, /Why Portage stopped[\s\S]*Python/);
});

test("bad input becomes a tool error, not a crash", async () => {
  const missing = await call(dev, "scan_payment_surface", { repoPath: path.join(pkgDir, "no-such-folder") });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /Not a folder/);
  let rejected = false;
  try {
    const r = await call(dev, "plan_migration", { repoPath: suite("quill-saas"), mode: "sideways" });
    rejected = r.isError === true;
  } catch {
    rejected = true;
  }
  assert.ok(rejected, "an invalid mode is rejected");
  // The server is still healthy afterwards.
  assert.equal(json(await call(dev, "plan_migration", { repoPath: suite("brewbox-store") })).status, "ready");
});

test("the bundled plugin server works on its own, with the map embedded", async () => {
  const { tools } = await bundled.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["plan_migration", "scan_payment_surface"]);
  const plan = json(await call(bundled, "plan_migration", { repoPath: suite("brewbox-store") }));
  assert.equal(plan.status, "ready");
  assert.equal(plan.events[0].paypal, "PAYMENT.CAPTURE.COMPLETED");
  const ref = await call(bundled, "plan_migration", { repoPath: suite("ledgerline-flask") });
  assert.equal(json(ref).status, "blocked");
});
