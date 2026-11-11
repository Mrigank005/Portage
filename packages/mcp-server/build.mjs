// Bundles the MCP server and everything it needs (including ts-morph, the PayPal Server SDK and the map) into one file
// inside the plugin, so the plugin works after an agent copies it into its own plugin cache. playwright-core (used by
// verify_checkout to drive an installed Chrome or Edge) reads its own package files at runtime, so it can't be
// bundled: it is copied next to the bundle instead, into node_modules/, where Node finds it. Output is not committed.
import { build } from "esbuild";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const outfile = path.resolve(process.argv[2] ?? fileURLToPath(new URL("../../plugin/server/portage-mcp.cjs", import.meta.url)));

await build({
  entryPoints: [fileURLToPath(new URL("./src/index.ts", import.meta.url))],
  outfile,
  bundle: true,
  platform: "node",
  target: "node20",
  // CommonJS output: ts-morph's bundled TypeScript uses require() for Node built-ins.
  format: "cjs",
  external: ["playwright-core"],
  banner: { js: "/* Portage MCP server. Built from packages/mcp-server; MIT licensed. */" },
  // core's map loader uses import.meta.url, but the server embeds the map with setMap, so that path never runs.
  logOverride: { "empty-import-meta": "silent" },
  legalComments: "external",
}).catch(() => process.exit(1));

// Copy playwright-core (no dependencies of its own) next to the bundle.
const require = createRequire(fileURLToPath(new URL("../core/package.json", import.meta.url)));
const pwDir = path.dirname(require.resolve("playwright-core/package.json"));
const dest = path.join(path.dirname(outfile), "node_modules", "playwright-core");
fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(pwDir, dest, { recursive: true });

console.log(`Built ${outfile} (+ node_modules/playwright-core)`);
