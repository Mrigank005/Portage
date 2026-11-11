// `portage try` and `portage init`: getting Portage in front of a coding agent.
//
// try:  copies a suite app into trial/<app> (gitignored) with a git baseline, writes its env file from the repository's
//       .env (Standin settings, PayPal sandbox keys, the sandbox buyer), installs its packages, and prints the prompt to
//       paste into the agent. The repository's own MCP configs (.mcp.json, .vscode/mcp.json, .cursor/mcp.json) and the
//       project skill (.claude/skills) already give Claude Code, GitHub Copilot and Cursor Portage's tools here.
// init: for using Portage on another repository. Builds the plugin bundle, then installs the Claude Code plugin, or
//       writes the MCP config for GitHub Copilot (.vscode/mcp.json) or Cursor (.cursor/mcp.json) into that repository.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_RELAY_URL, readEnv } from "@portage/core";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CONTEXTMATIC_URL = "https://chatbotapi.apimatic.io/mcp/plugins";
const BUNDLE = path.join(REPO, "plugin", "server", "portage-mcp.cjs");

type Check = { name: string; ok: boolean | "warn"; detail: string };

const SETTINGS = [
  "PAYPAL_ENVIRONMENT",
  "PAYPAL_CLIENT_ID",
  "PAYPAL_CLIENT_SECRET",
  "PAYPAL_SANDBOX_US_BUYER_EMAIL",
  "PAYPAL_SANDBOX_US_BUYER_PASSWORD",
  "PAYPAL_SANDBOX_BUYER_EMAIL",
  "PAYPAL_SANDBOX_BUYER_PASSWORD",
] as const;

function rootSettings() {
  return readEnv(REPO, [".env"], SETTINGS).values;
}

/** Checks what a sandbox run needs. Never prints a value. */
export async function checks(): Promise<Check[]> {
  const out: Check[] = [];
  const [major, minor] = process.versions.node.split(".").map(Number);
  out.push({ name: "Node.js 20.9 or newer", ok: major > 20 || (major === 20 && minor >= 9), detail: `found ${process.versions.node}` });

  const env = rootSettings();
  const hasEnvFile = fs.existsSync(path.join(REPO, ".env"));
  if (!hasEnvFile) out.push({ name: "PayPal sandbox keys in .env", ok: false, detail: "no .env in the repository root: copy .env.example to .env and fill in the PayPal sandbox section" });
  else if (env.PAYPAL_ENVIRONMENT && env.PAYPAL_ENVIRONMENT !== "sandbox") out.push({ name: "PayPal sandbox keys in .env", ok: false, detail: "PAYPAL_ENVIRONMENT must be sandbox" });
  else if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) out.push({ name: "PayPal sandbox keys in .env", ok: false, detail: "PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are empty (developer.paypal.com → Apps & Credentials → Sandbox)" });
  else {
    const res = await fetch("https://api-m.sandbox.paypal.com/v1/oauth2/token", {
      method: "POST",
      headers: { Authorization: `Basic ${Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(30_000),
    }).then((r) => r.status, (e: Error) => e.message);
    out.push({ name: "PayPal sandbox keys in .env", ok: res === 200, detail: res === 200 ? "PayPal issued a sandbox token" : `PayPal answered ${res} (are these the Sandbox keys, not Live?)` });
  }
  const us = env.PAYPAL_SANDBOX_US_BUYER_EMAIL && env.PAYPAL_SANDBOX_US_BUYER_PASSWORD;
  const any = us || (env.PAYPAL_SANDBOX_BUYER_EMAIL && env.PAYPAL_SANDBOX_BUYER_PASSWORD);
  out.push({
    name: "Sandbox buyer login in .env",
    ok: any ? true : false,
    detail: us ? "PAYPAL_SANDBOX_US_BUYER_* set" : any ? "PAYPAL_SANDBOX_BUYER_* set (if PayPal says the seller doesn't accept your currency, use a US personal account)" : "add a sandbox personal account's login as PAYPAL_SANDBOX_BUYER_EMAIL / _PASSWORD (a US account works best)",
  });

  try {
    const { chromium } = await import("playwright-core");
    let found = "";
    for (const channel of ["chrome", "msedge"] as const) {
      const b = await chromium.launch({ channel, headless: true }).catch(() => null);
      if (b) {
        await b.close();
        found = channel === "chrome" ? "Google Chrome" : "Microsoft Edge";
        break;
      }
    }
    out.push({ name: "A browser for verify_checkout", ok: !!found || "warn", detail: found || "neither Chrome nor Edge started; install one, or run `npx playwright install chromium`" });
  } catch (err) {
    out.push({ name: "A browser for verify_checkout", ok: "warn", detail: (err as Error).message.split("\n")[0] });
  }

  const relay = await fetch(`${DEFAULT_RELAY_URL}/health`, { signal: AbortSignal.timeout(60_000) }).then((r) => r.status, (e: Error) => e.message);
  out.push({ name: "Portage's webhook relay", ok: relay === 200 || "warn", detail: relay === 200 ? DEFAULT_RELAY_URL : `${DEFAULT_RELAY_URL} answered ${relay}; webhook checks will be skipped` });
  return out;
}

export function renderChecks(list: Check[]): string {
  return list.map((c) => `  ${c.ok === true ? "ok  " : c.ok === "warn" ? "warn" : "FAIL"}  ${c.name}: ${c.detail}`).join("\n");
}

// --- try ---

export const TRIAL_APPS = {
  brewbox: {
    folder: "brewbox-store",
    envFile: ".env.local",
    start: "npm run dev",
    url: "http://127.0.0.1:4300",
    stack: "a Next.js App Router shop",
  },
  quill: {
    folder: "quill-saas",
    envFile: ".env",
    start: "node --env-file=.env --import tsx src/server.ts",
    url: "http://127.0.0.1:4301",
    stack: "an Express app selling credit packs",
  },
} as const;
export type TrialApp = keyof typeof TRIAL_APPS;

/** The files git tracks in a suite app (so a fresh clone and a working copy give the same trial). */
function trackedFiles(dir: string): string[] {
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--", "."], { cwd: dir, encoding: "utf8" });
    const files = out.split("\0").filter(Boolean);
    if (files.length) return files;
  } catch {
    /* not a git checkout: fall back to a walk */
  }
  const files: string[] = [];
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) {
        if (!["node_modules", ".next", "data"].includes(e.name)) walk(r);
      } else if (!/^\.env(?!\.example$)/.test(e.name) && !e.name.endsWith(".tsbuildinfo")) files.push(r);
    }
  };
  walk("");
  return files;
}

export interface TrialResult {
  app: TrialApp;
  dir: string;
  prompt: string;
  promptFile: string;
}

export function trialPrompt(app: TrialApp, dir: string): string {
  const a = TRIAL_APPS[app];
  const rel = path.relative(REPO, dir).replace(/\\/g, "/");
  return `Use Portage to add PayPal to the app in \`${rel}\` (${a.stack}), in add mode, and prove it with a real PayPal sandbox payment.

Follow Portage's playbook: the portage-migrate skill in Claude Code, or the \`migrate\` prompt from the portage MCP server in GitHub Copilot and Cursor. This is a Portage test app, so the plan counts as approved: show it, then carry on without waiting.

Environment:
- The app takes card payments through Standin, a local Stripe-compatible server, not real Stripe. If nothing is listening on localhost:4242, start it from the repository root with \`npm run standin\` and leave it running.
- Start the app from \`${rel}\` with \`${a.start}\`, and leave it running; it serves ${a.url}. Restart it after changing its server code or settings.
- Its settings, including the PayPal sandbox keys and the sandbox buyer's login, are in \`${rel}/${a.envFile}\`. Never print them. Pass that file to Portage's tools if they ask for env files.

When the edits are done and the app typechecks: run setup_webhook_relay for the app (it writes to ${a.envFile}), restart the app, then run verify_checkout and fix whatever fails until every step passes. Finish with the report, including the verify_checkout report card. The app is a git repository, so \`git diff\` shows everything you changed.`;
}

export async function setupTrial(app: TrialApp, opts: { dir?: string; force?: boolean; install?: boolean; log?: (m: string) => void } = {}): Promise<TrialResult> {
  const log = opts.log ?? (() => {});
  const a = TRIAL_APPS[app];
  const src = path.join(REPO, "suite", a.folder);
  const dir = path.resolve(opts.dir ?? path.join(REPO, "trial", a.folder));
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) {
    if (!opts.force) throw new Error(`${dir} already exists (maybe with an agent's work in it). Pass --force to replace it, or --dir for another folder.`);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // Copy the app as git tracks it.
  for (const f of trackedFiles(src)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.copyFileSync(path.join(src, f), path.join(dir, f));
  }
  log(`Copied suite/${a.folder} to ${path.relative(REPO, dir) || dir}`);

  // Its env file: the app's own example settings (Standin), then PayPal and the sandbox buyer from the root .env.
  const example = fs.readFileSync(path.join(dir, ".env.example"), "utf8");
  const lines = example.split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l));
  const env = rootSettings();
  lines.push("", "# PayPal sandbox, copied from the Portage repository's .env by `portage try`");
  for (const k of SETTINGS) if (env[k]) lines.push(`${k}=${env[k]}`);
  if (!env.PAYPAL_ENVIRONMENT) lines.push("PAYPAL_ENVIRONMENT=sandbox");
  fs.writeFileSync(path.join(dir, a.envFile), lines.join("\n") + "\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), ["node_modules/", ".next/", "data/", ".env", ".env.*", "!.env.example", ".portage/", "*.tsbuildinfo", "next-env.d.ts", ""].join("\n"));
  log(`Wrote ${a.envFile} (Standin settings, and the PayPal sandbox settings from .env)`);

  if (opts.install !== false) {
    log("Installing the app's packages (npm install)…");
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const r = spawnSync(npm, ["install", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: dir, stdio: "inherit", shell: process.platform === "win32" });
    if (r.status !== 0) throw new Error(`npm install failed in ${dir}`);
  }

  // A git baseline, so the agent's change is one reviewable diff.
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.name=Portage", "-c", "user.email=portage@localhost", "-c", "commit.gpgsign=false", "commit", "-q", "-m", `${a.folder} before Portage`);
  log("Committed a git baseline");


  const prompt = trialPrompt(app, dir);
  const promptFile = path.join(path.dirname(dir), `${a.folder}.prompt.md`);
  fs.writeFileSync(promptFile, prompt + "\n");
  return { app, dir, prompt, promptFile };
}

// --- init ---

export type Agent = "claude" | "copilot" | "cursor";

export function buildBundle(log: (m: string) => void = () => {}): void {
  log("Building the Portage MCP server bundle (plugin/server)…");
  execFileSync(process.execPath, [path.join(REPO, "packages", "mcp-server", "build.mjs")], { cwd: REPO, stdio: "pipe" });
}

/** The Claude Code CLI: on PATH, or bundled with the VS Code extension. */
export function findClaude(): string | null {
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["claude"], { encoding: "utf8" });
  if (probe.status === 0 && probe.stdout.trim()) return probe.stdout.trim().split(/\r?\n/)[0];
  const ext = path.join(os.homedir(), ".vscode", "extensions");
  try {
    const dirs = fs.readdirSync(ext).filter((d) => d.startsWith("anthropic.claude-code-")).sort().reverse();
    for (const d of dirs) {
      const bin = path.join(ext, d, "resources", "native-binary", process.platform === "win32" ? "claude.exe" : "claude");
      if (fs.existsSync(bin)) return bin;
    }
  } catch {
    /* no VS Code extensions */
  }
  return null;
}

function mergeJson(file: string, key: "servers" | "mcpServers", servers: Record<string, unknown>): "created" | "updated" {
  let data: Record<string, Record<string, unknown>> = {};
  const existed = fs.existsSync(file);
  if (existed) {
    try {
      data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      throw new Error(`${file} isn't valid JSON (comments aren't supported); add the servers by hand: ${JSON.stringify(servers)}`);
    }
  }
  data[key] = { ...(data[key] ?? {}), ...servers };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  return existed ? "updated" : "created";
}

export interface InitResult {
  agent: Agent;
  done: string[];
  next: string[];
}

export function initAgent(agent: Agent, opts: { project?: string; log?: (m: string) => void } = {}): InitResult {
  const log = opts.log ?? (() => {});
  buildBundle(log);
  const done = [`Built ${path.relative(REPO, BUNDLE)} (with playwright-core next to it)`];
  const next: string[] = [];
  const bundle = BUNDLE.replace(/\\/g, "/");

  if (agent === "claude") {
    const marketplace = path.join(REPO, "plugin");
    const claude = findClaude();
    let installed = false;
    if (claude) {
      const add = spawnSync(claude, ["plugin", "marketplace", "add", marketplace], { encoding: "utf8" });
      const ok = add.status === 0 || /already/i.test(`${add.stdout}${add.stderr}`);
      if (ok) {
        // Reinstall so a rebuilt bundle is copied into Claude Code's plugin cache.
        spawnSync(claude, ["plugin", "uninstall", "portage@portage"], { encoding: "utf8" });
        const inst = spawnSync(claude, ["plugin", "install", "portage@portage"], { encoding: "utf8" });
        installed = inst.status === 0;
        if (installed) done.push("Installed the Claude Code plugin portage@portage (skill portage-migrate, MCP servers portage and context-matic)");
        else log(`claude plugin install failed: ${(inst.stderr || inst.stdout).trim().split("\n")[0]}`);
      } else log(`claude plugin marketplace add failed: ${(add.stderr || add.stdout).trim().split("\n")[0]}`);
    }
    if (!installed) {
      next.push(
        "In Claude Code, run these two commands:",
        `  /plugin marketplace add ${marketplace.replace(/\\/g, "/")}`,
        "  /plugin install portage@portage",
      );
    }
    next.push("Restart Claude Code. When it asks, sign in to context-matic (APIMatic's Context Plugin): run /mcp and choose it.");
  } else {
    const project = path.resolve(opts.project ?? process.cwd());
    if (agent === "copilot") {
      const file = path.join(project, ".vscode", "mcp.json");
      const how = mergeJson(file, "servers", {
        portage: { type: "stdio", command: "node", args: [bundle] },
        "context-matic": { type: "http", url: CONTEXTMATIC_URL },
      });
      done.push(`${how === "created" ? "Created" : "Updated"} ${file} with the portage and context-matic MCP servers`);
      next.push(
        "Open that folder in VS Code, open Copilot Chat in Agent mode, and start both servers when VS Code asks (or from .vscode/mcp.json). Sign in to context-matic when asked.",
        "The playbook is the MCP prompt: type /mcp.portage.migrate in the chat.",
      );
    } else {
      const file = path.join(project, ".cursor", "mcp.json");
      const how = mergeJson(file, "mcpServers", {
        portage: { command: "node", args: [bundle] },
        "context-matic": { type: "http", url: CONTEXTMATIC_URL, headers: { "X-Apimatic-Mcp-Client": "Cursor" } },
      });
      done.push(`${how === "created" ? "Created" : "Updated"} ${file} with the portage and context-matic MCP servers`);
      next.push("Open that folder in Cursor, enable both servers in Settings → MCP, and sign in to context-matic when asked.", "The playbook is the MCP prompt `migrate` from the portage server.");
    }
    next.push("Keep this Portage folder where it is: the config points at its plugin/server bundle.");
  }
  return { agent, done, next };
}
