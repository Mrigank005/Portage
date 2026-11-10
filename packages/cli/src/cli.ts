// portage scan <path> [--json]
// portage plan <path> [--mode add|replace] [--app <name>] [--json]
import path from "node:path";
import { planMigration, renderPlan, renderScan, scanRepo, type Mode } from "@portage/core";

const HELP = `Portage: adds PayPal to apps that use Stripe.

Usage:
  portage scan <path> [--json]                              Report the Stripe payment code and whether Portage supports it
  portage plan <path> [--mode add|replace] [--app <name>] [--json]
                                                            Plan the PayPal migration (default mode: add)

Both commands only read the repository.`;

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (v !== undefined) flags.set(k, v);
      else if (rest[i + 1] && !rest[i + 1].startsWith("--") && (k === "mode" || k === "app")) flags.set(k, rest[++i]);
      else flags.set(k, true);
    } else positional.push(a);
  }
  if (!cmd || cmd === "help" || cmd === "--help" || flags.has("help")) {
    console.log(HELP);
    return 0;
  }
  if (cmd !== "scan" && cmd !== "plan") {
    console.error(`Unknown command "${cmd}".\n\n${HELP}`);
    return 2;
  }
  if (positional.length !== 1) {
    console.error(`portage ${cmd} needs exactly one path.\n\n${HELP}`);
    return 2;
  }
  const target = path.resolve(positional[0]);
  const json = flags.has("json");
  try {
    const scan = scanRepo(target);
    if (cmd === "scan") {
      console.log(json ? JSON.stringify(scan, null, 2) : renderScan(scan));
      return scan.supported ? 0 : 3;
    }
    const mode = (flags.get("mode") ?? "add") as Mode;
    if (mode !== "add" && mode !== "replace") {
      console.error(`--mode must be "add" or "replace", not "${String(mode)}"`);
      return 2;
    }
    const app = typeof flags.get("app") === "string" ? (flags.get("app") as string) : undefined;
    const plan = planMigration(scan, { mode, app });
    console.log(json ? JSON.stringify(plan, null, 2) : renderPlan(plan));
    return plan.status === "ready" ? 0 : 3;
  } catch (err) {
    console.error(`portage: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
