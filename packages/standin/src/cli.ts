// Starts Standin from the command line.
//   tsx src/cli.ts --config ../../suite/standin.config.json [--port 4242] [--host 127.0.0.1]
//                  [--state .standin/state.json | --no-persist]
// Without --host, Standin listens on localhost only.
import path from "node:path";
import { loadConfig } from "./config.ts";
import { startStandin } from "./server.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const configPath = arg("config") ?? process.env.STANDIN_CONFIG;
const config = configPath ? loadConfig(path.resolve(configPath)) : undefined;
const port = Number(arg("port") ?? process.env.STANDIN_PORT ?? 4242);
const persist = !process.argv.includes("--no-persist") && process.env.STANDIN_STATE_FILE !== "";
const statePath = persist ? path.resolve(arg("state") ?? process.env.STANDIN_STATE_FILE ?? ".standin/state.json") : null;

const host = arg("host") ?? process.env.STANDIN_HOST;

const running = await startStandin({
  port,
  host,
  config,
  statePath,
  webhookSecret: process.env.STANDIN_WEBHOOK_SECRET,
  log: (line) => console.log(`[standin] ${line}`),
});

console.log(`[standin] listening on http://localhost:${running.port}${host ? ` (bound to ${host})` : " (localhost only)"}`);
console.log(`[standin] accounts from config: ${Object.keys(config?.accounts ?? {}).join(", ") || "(none)"}`);
console.log(`[standin] state: ${statePath ?? "in memory"}`);

const shutdown = async () => {
  await running.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
