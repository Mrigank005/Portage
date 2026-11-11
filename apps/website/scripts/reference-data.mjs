// Builds src/data/reference.json for the reference docs from Portage itself, so the docs can't drift from the code:
// - the MCP tools, their input schemas and the prompts, asked of the real Portage MCP server over stdio (tools/list);
// - each reference file's purpose and placement, from get_reference_code;
// - the CLI usage text, from packages/cli/src/cli.ts.
// If the server can't be started (for example a partial install), the committed copy is kept and the build goes on.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const serverDir = path.join(repo, "packages/mcp-server");
const out = path.resolve(here, "../src/data/reference.json");

async function generate() {
  const req = createRequire(path.join(serverDir, "package.json"));
  const sdk = (p) => import(pathToFileURL(req.resolve(`@modelcontextprotocol/sdk/${p}`)).href);
  const { Client } = await sdk("client/index.js");
  const { StdioClientTransport } = await sdk("client/stdio.js");

  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "src/index.ts"], cwd: serverDir, stderr: "pipe" });
  const client = new Client({ name: "portage-website", version: "0.0.0" });
  await client.connect(transport);
  try {
    const version = client.getServerVersion();
    const instructions = client.getInstructions() ?? "";
    const { tools } = await client.listTools();
    const { prompts } = await client.listPrompts();

    const refTool = tools.find((t) => t.name === "get_reference_code");
    const names = refTool?.inputSchema?.properties?.name?.enum ?? [];
    const references = [];
    for (const name of names) {
      const r = await client.callTool({ name: "get_reference_code", arguments: { name } });
      const lines = r.content[0].text.split("\n");
      const field = (label) => (lines.find((l) => l.startsWith(`- **${label}:**`)) ?? "").replace(`- **${label}:** `, "").replace(/`/g, "");
      references.push({ name, filename: lines[0].replace("# Portage reference: ", ""), purpose: lines[2], placement: field("Where"), packages: field("Packages"), settings: field("Settings") });
    }

    const cli = fs.readFileSync(path.join(repo, "packages/cli/src/cli.ts"), "utf8");
    const help = /const HELP = `([\s\S]*?)`;/.exec(cli)?.[1];
    if (!help) throw new Error("couldn't find HELP in packages/cli/src/cli.ts");

    return {
      generatedFrom: "Portage's MCP server (tools/list, prompts/list, get_reference_code) and packages/cli/src/cli.ts",
      server: version,
      instructions,
      tools: tools.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })),
      prompts,
      references,
      cliHelp: help,
    };
  } finally {
    await client.close();
  }
}

try {
  const data = await generate();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(data, null, 2) + "\n");
  console.log(`Wrote reference data: ${data.tools.length} tools, ${data.prompts.length} prompt, ${data.references.length} reference files`);
} catch (err) {
  if (!fs.existsSync(out)) throw err;
  console.warn(`Kept the committed reference data (couldn't ask the MCP server: ${err instanceof Error ? err.message : err})`);
}
