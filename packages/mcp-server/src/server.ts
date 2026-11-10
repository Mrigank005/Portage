// The Portage MCP server: scan_payment_surface, plan_migration, get_reference_code and migrate_catalog, plus the
// playbook as the `migrate` prompt (for agents without Claude Code skills, such as GitHub Copilot and Cursor).
// verify_checkout and generate_report arrive in later phases.
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  CatalogError,
  migrateCatalog,
  pickApp,
  planMigration,
  PLAYBOOK,
  REFERENCES,
  referenceCode,
  renderCatalog,
  renderPlan,
  renderScan,
  scanRepo,
  setMap,
  type PaymentMap,
} from "@portage/core";
import map from "@portage/core/maps/stripe-paypal.json" with { type: "json" };

// Embed the map so the bundled server doesn't depend on files next to it.
setMap(map as PaymentMap);

export const VERSION = "0.1.0";

const INSTRUCTIONS = `Portage adds PayPal to apps that take payments with Stripe, and proves the result with a real PayPal sandbox payment.
Workflow: scan_payment_surface, then plan_migration, then show the plan to the developer and wait for approval before editing anything. The full playbook is the "migrate" prompt.
While editing, start from get_reference_code where a plan step names it, and look up every PayPal Server SDK method and model with the context-matic MCP server (APIMatic Context Plugin) first.
scan_payment_surface, plan_migration and get_reference_code only read. migrate_catalog is a dry run unless dryRun is false.`;

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

  const referenceNames = REFERENCES.map((r) => r.name) as [string, ...string[]];
  server.registerTool(
    "get_reference_code",
    {
      title: "Get Portage reference code",
      description: `Returns one of Portage's tested reference files for the parts of a PayPal integration that must be exact, with where it goes, the packages and settings it needs. TypeScript files are typechecked against the real PayPal packages; the money helper and webhook verifier are tested against the PayPal sandbox. Adapt names, paths and style to the app; keep the behaviour. Available: ${REFERENCES.map((r) => `${r.name} (${r.purpose.split(".")[0]})`).join("; ")}. Read-only.`,
      inputSchema: {
        name: z.enum(referenceNames).describe("Which reference file."),
        language: z.enum(["typescript", "javascript"]).default("typescript").describe("javascript converts server and React files for JavaScript apps."),
        module: z.enum(["esm", "commonjs"]).default("esm").describe("For javascript: ES modules (import) or CommonJS (require)."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ name, language, module }) => {
      try {
        const r = referenceCode(name, language, module);
        const fence = r.filename.endsWith(".tsx") ? "tsx" : r.filename.endsWith(".jsx") ? "jsx" : r.language === "typescript" ? "ts" : "js";
        const head = [
          `# Portage reference: ${r.filename}`,
          "",
          r.purpose,
          "",
          `- **Where:** ${r.placement}`,
          `- **Packages:** ${r.packages.length ? r.packages.map((p) => `\`${p}\``).join(", ") : "none"}`,
          `- **Settings:** ${r.env.length ? r.env.map((e) => `\`${e}\``).join(", ") : "none"}`,
          ...r.notes.map((n) => `- ${n}`),
          "",
          `\`\`\`${fence}`,
          r.code.trimEnd(),
          "```",
        ];
        return { content: [text(head.join("\n"))] };
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "migrate_catalog",
    {
      title: "Copy the Stripe catalog to PayPal",
      description:
        "Reads the app's Stripe products and one-time prices (through STRIPE_API_BASE when set, so suite apps read from Standin) and creates matching PayPal sandbox catalog products, then writes portage.catalog.json with the ID mapping and the prices as PayPal amounts. Dry run by default: nothing is created or written until dryRun is false. Test keys and the PayPal sandbox only. Reads STRIPE_SECRET_KEY, STRIPE_API_BASE, PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_ENVIRONMENT from the app's env files and never shows their values. Idempotent: re-runs reuse existing products.",
      inputSchema: {
        repoPath,
        app: z.string().optional().describe("Which app, when the repository has several (its folder or package name)."),
        dryRun: z.boolean().default(true).describe("true (default): only report what would happen."),
        envFiles: z.array(z.string()).optional().describe("Env files to read, relative to the app folder. Default: .env.local, .env."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ repoPath: p, app, dryRun, envFiles }) => {
      try {
        const root = path.resolve(p);
        const scan = scanRepo(root);
        const chosen = pickApp(scan, app);
        if (app && !chosen) throw new Error(`No app called "${app}" in this repository.`);
        const appDir = chosen ? path.join(root, chosen.root) : root;
        const result = await migrateCatalog({ appDir, dryRun, envFiles });
        return { content: [text(renderCatalog(result)), text(`Catalog data (JSON):\n${JSON.stringify(result)}`)] };
      } catch (err) {
        return err instanceof CatalogError ? { isError: true, content: [text(err.message)] } : failure(err);
      }
    },
  );

  server.registerPrompt(
    "migrate",
    {
      title: "Add PayPal with Portage",
      description: "Portage's playbook: scan, plan, approval, edits with ContextMatic and reference code, checks, and the sandbox payment test.",
      argsSchema: {
        repoPath: z.string().describe("The repository or app to migrate."),
        mode: z.enum(["add", "replace"]).optional().describe("add (default) keeps Stripe; replace moves new payments to PayPal."),
      },
    },
    ({ repoPath: p, mode }) => ({
      messages: [{ role: "user", content: { type: "text", text: `${PLAYBOOK}\n\n---\n\nApply this playbook to \`${p}\` in **${mode ?? "add"}** mode.` } }],
    }),
  );

  return server;
}
