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

const TOOLS = ["get_reference_code", "migrate_catalog", "plan_migration", "scan_payment_surface", "setup_webhook_relay", "verify_checkout"];
const WRITES = ["migrate_catalog", "setup_webhook_relay", "verify_checkout"];

test("lists the tools, marks which only read, and has instructions that require approval and ContextMatic", async () => {
  const { tools } = await dev.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), TOOLS);
  for (const t of tools) {
    assert.equal(t.annotations?.readOnlyHint, !WRITES.includes(t.name), t.name);
    assert.deepEqual(t.inputSchema.required, t.name === "get_reference_code" ? ["name"] : t.name === "verify_checkout" ? ["repoPath", "appUrl"] : ["repoPath"], t.name);
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

test("get_reference_code returns tested code, in TypeScript or converted to JavaScript", async () => {
  const ts = await call(dev, "get_reference_code", { name: "paypal-webhook" });
  assert.match(ts.content[0].text, /^# Portage reference: paypal-webhook\.ts/);
  assert.match(ts.content[0].text, /export async function verifyPayPalWebhook\(/);
  assert.match(ts.content[0].text, /\*\*Settings:\*\* .*PAYPAL_WEBHOOK_ID/);
  const cjs = await call(dev, "get_reference_code", { name: "paypal-client", language: "javascript", module: "commonjs" });
  assert.match(cjs.content[0].text, /paypal-client\.cjs/);
  assert.match(cjs.content[0].text, /require\("@paypal\/paypal-server-sdk"\)/);
  assert.ok(!/: Client \| undefined/.test(cjs.content[0].text), "types are removed");
  const jsx = await call(dev, "get_reference_code", { name: "PayPalButtons", language: "javascript" });
  assert.match(jsx.content[0].text, /PayPalButtons\.jsx[\s\S]*@paypal\/react-paypal-js\/sdk-v6/);
  const browser = await call(dev, "get_reference_code", { name: "paypal-buttons-browser" });
  assert.match(browser.content[0].text, /web-sdk\/v6\/core/);
});

test("the migrate prompt carries the playbook", async () => {
  const { prompts } = await dev.listPrompts();
  assert.deepEqual(prompts.map((p) => p.name), ["migrate"]);
  const got = await dev.getPrompt({ name: "migrate", arguments: { repoPath: "/repo/brewbox", mode: "add" } });
  const body = (got.messages[0].content as { text: string }).text;
  assert.match(body, /Nothing is edited before the developer approves the plan/);
  assert.match(body, /get_reference_code/);
  assert.match(body, /Apply this playbook to `\/repo\/brewbox` in \*\*add\*\* mode/);
});

test("migrate_catalog: a dry run reads the catalog from Standin and creates nothing; bad settings are a clear error", async () => {
  const { startStandin } = await import("../../standin/src/server.ts");
  const { loadConfig } = await import("../../standin/src/config.ts");
  const standin = await startStandin({ port: 0, statePath: null, config: loadConfig(path.resolve(pkgDir, "../../suite/standin.config.json")) });
  const envFile = path.join(tmp, "catalog.env");
  try {
    fs.writeFileSync(envFile, `STRIPE_SECRET_KEY=sk_test_standin_brewbox\nSTRIPE_API_BASE=http://127.0.0.1:${standin.port}\nPAYPAL_ENVIRONMENT=sandbox\n`);
    for (const client of [dev, bundled]) {
      const r = await call(client, "migrate_catalog", { repoPath: suite("brewbox-store"), envFiles: [envFile] });
      assert.ok(!r.isError, r.content[0]?.text);
      assert.match(r.content[0].text, /dry run[\s\S]*3 products would be created/);
      const data = json(r);
      assert.equal(data.counts.wouldCreate, 3);
      assert.ok(!JSON.stringify(data).includes("sk_test_standin_brewbox"), "setting values are never returned");
    }
    fs.writeFileSync(envFile, "STRIPE_SECRET_KEY=sk_live_nope\n");
    const live = await call(dev, "migrate_catalog", { repoPath: suite("brewbox-store"), envFiles: [envFile] });
    assert.equal(live.isError, true);
    assert.match(live.content[0].text, /test keys/);
  } finally {
    await standin.close();
  }
});

test("verify_checkout and setup_webhook_relay refuse live settings and report a stopped app as a failed step", async () => {
  const envFile = path.join(tmp, "verify.env");
  fs.writeFileSync(envFile, "PAYPAL_ENVIRONMENT=live\nPAYPAL_CLIENT_ID=id_value\nPAYPAL_CLIENT_SECRET=secret_value\n");
  for (const name of ["verify_checkout", "setup_webhook_relay"]) {
    const r = await call(dev, name, { repoPath: suite("brewbox-store"), appUrl: "http://127.0.0.1:9", envFiles: [envFile] });
    assert.equal(r.isError, true, name);
    assert.match(r.content[0].text, /sandbox/, name);
  }
  fs.writeFileSync(envFile, "PAYPAL_ENVIRONMENT=sandbox\nPAYPAL_CLIENT_ID=id_value\nPAYPAL_CLIENT_SECRET=secret_value\nPAYPAL_SANDBOX_BUYER_EMAIL=buyer@example.com\nPAYPAL_SANDBOX_BUYER_PASSWORD=pw_value\n");
  const outDir = path.join(tmp, "verify-out");
  for (const client of [dev, bundled]) {
    const r = await call(client, "verify_checkout", { repoPath: suite("brewbox-store"), appUrl: "http://127.0.0.1:9", envFiles: [envFile], outDir });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /FAIL \| App is running/);
    const all = r.content.map((c) => c.text).join("\n");
    for (const secret of ["id_value", "secret_value", "pw_value", "buyer@example.com"]) assert.ok(!all.includes(secret), `${secret} is never returned`);
  }
});

test("the bundled plugin server works on its own, with the map embedded", async () => {
  const { tools } = await bundled.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), TOOLS);
  const refCode = await call(bundled, "get_reference_code", { name: "paypal-money" });
  assert.match(refCode.content[0].text, /export function toPayPalMoney/);
  const plan = json(await call(bundled, "plan_migration", { repoPath: suite("brewbox-store") }));
  assert.equal(plan.status, "ready");
  assert.equal(plan.events[0].paypal, "PAYMENT.CAPTURE.COMPLETED");
  const ref = await call(bundled, "plan_migration", { repoPath: suite("ledgerline-flask") });
  assert.equal(json(ref).status, "blocked");
});
