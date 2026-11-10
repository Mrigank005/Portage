// The Portage MCP server. Phase 2 ships the two read-only tools: scan_payment_surface and plan_migration.
// migrate_catalog, verify_checkout and generate_report arrive in later phases.
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { planMigration, renderPlan, renderScan, scanRepo, setMap, type PaymentMap } from "@portage/core";
import map from "@portage/core/maps/stripe-paypal.json" with { type: "json" };

// Embed the map so the bundled server doesn't depend on files next to it.
setMap(map as PaymentMap);

export const VERSION = "0.1.0";

const INSTRUCTIONS = `Portage adds PayPal to apps that take payments with Stripe, and proves the result with a real PayPal sandbox payment.
Workflow: scan_payment_surface, then plan_migration, then show the plan to the developer and wait for approval before editing anything.
Before writing any PayPal Server SDK code, look up each method and model with the context-matic MCP server (APIMatic Context Plugin): the plan lists the lookups.
Both tools only read the repository. They never change files and never read real env files.`;

const repoPath = z.string().min(1).describe("Path to the repository or app folder. Absolute paths are safest; relative paths resolve against the server's working directory.");

function text(s: string) {
  return { type: "text" as const, text: s };
}

function failure(err: unknown) {
  return { isError: true, content: [text(`Portage couldn't finish: ${err instanceof Error ? err.message : String(err)}`)] };
}

export function createServer(): McpServer {
  const server = new McpServer({ name: "portage", version: VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "scan_payment_surface",
    {
      title: "Scan Stripe payment code",
      description:
        "Reads a repository and reports its Stripe payment surface: the Stripe client, Checkout sessions, webhook handlers and the events they handle (with the app functions they call), refunds, the checkout button, where Stripe IDs are stored, and settings. Detects the framework and says whether Portage supports the repo, with clear reasons when it doesn't. Read-only.",
      inputSchema: { repoPath },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ repoPath: p }) => {
      try {
        const scan = scanRepo(path.resolve(p));
        return { content: [text(renderScan(scan)), text(`Scan data (JSON):\n${JSON.stringify(scan)}`)] };
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "plan_migration",
    {
      title: "Plan the PayPal migration",
      description:
        "Scans the repository and turns the result into a step-by-step plan from Portage's Stripe→PayPal map: files to create and change, new routes, webhook event mapping, order fields, money conversion, settings, items that need a person, and the ContextMatic lookups to make while editing. Mode 'add' (default) keeps Stripe and adds PayPal; 'replace' moves checkout to PayPal. Show the plan to the developer and get approval before editing. Read-only.",
      inputSchema: {
        repoPath,
        mode: z.enum(["add", "replace"]).default("add").describe("add: PayPal alongside Stripe (default). replace: PayPal instead of Stripe for new payments."),
        app: z.string().optional().describe("Which app to plan for, when the repository has several (its folder or package name)."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ repoPath: p, mode, app }) => {
      try {
        const plan = planMigration(scanRepo(path.resolve(p)), { mode, app });
        return { content: [text(renderPlan(plan)), text(`Plan data (JSON):\n${JSON.stringify(plan)}`)] };
      } catch (err) {
        return failure(err);
      }
    },
  );

  return server;
}
