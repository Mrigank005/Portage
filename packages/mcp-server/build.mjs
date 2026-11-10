// Bundles the MCP server and everything it needs (including ts-morph and the map) into one file inside the plugin,
// so the plugin works after an agent copies it into its own plugin cache. Output is not committed: `portage init` builds it.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const outfile = process.argv[2] ?? fileURLToPath(new URL("../../plugin/server/portage-mcp.cjs", import.meta.url));

await build({
  entryPoints: [fileURLToPath(new URL("./src/index.ts", import.meta.url))],
  outfile,
  bundle: true,
  platform: "node",
  target: "node20",
  // CommonJS output: ts-morph's bundled TypeScript uses require() for Node built-ins.
  format: "cjs",
  banner: { js: "/* Portage MCP server. Built from packages/mcp-server; MIT licensed. */" },
  // core's map loader uses import.meta.url, but the server embeds the map with setMap, so that path never runs.
  logOverride: { "empty-import-meta": "silent" },
  legalComments: "external",
}).catch(() => process.exit(1));

console.log(`Built ${outfile}`);
