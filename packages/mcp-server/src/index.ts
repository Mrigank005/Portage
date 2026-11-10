// Entry point: Portage's MCP server over stdio. stdout belongs to the protocol, so logs go to stderr.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, VERSION } from "./server.ts";

createServer()
  .connect(new StdioServerTransport())
  .then(
    () => console.error(`[portage] MCP server ${VERSION} ready on stdio`),
    (err: unknown) => {
      console.error("[portage] could not start:", err);
      process.exit(1);
    },
  );
