// portage scan <path> [--json]
// portage plan <path> [--mode add|replace] [--app <name>] [--json]
// portage relay setup <appDir> [--env f]... [--write-to f] [--relay-url u]
// portage relay forward <appDir> --to <url> [--env f]...
// portage verify <appDir> --url <appUrl> [--checkout /] [--webhook /path] [--paid-text t] [--refunded-text t] [--button n] [--no-refund] [--headed] [--env f]... [--json]
import path from "node:path";
import {
  Forwarder,
  planMigration,
  readEnv,
  renderPlan,
  renderRelaySetup,
  renderScan,
  renderVerify,
  scanRepo,
  setupWebhookRelay,
  verifyCheckout,
  wakeRelay,
  type Mode,
} from "@portage/core";

const HELP = `Portage: adds PayPal to apps that use Stripe.

Usage:
  portage scan <path> [--json]                              Report the Stripe payment code and whether Portage supports it
  portage plan <path> [--mode add|replace] [--app <name>] [--json]
                                                            Plan the PayPal migration (default mode: add)
  portage relay setup <appDir> [--write-to <file>] [--relay-url <url>]
                                                            Register a PayPal sandbox webhook that points at Portage's relay
                                                            and write PAYPAL_WEBHOOK_ID and the relay settings to the app's env file
  portage relay forward <appDir> --to <url>                 Forward PayPal sandbox webhooks from the relay to the running app
  portage verify <appDir> --url <appUrl> [--checkout <path>] [--webhook <path>]
                 [--paid-text <text>] [--refunded-text <text>] [--button <n>] [--fill <selector>=<value>]... [--no-refund] [--headed] [--json]
                                                            A real PayPal sandbox payment through the running app, in a browser

Options for relay and verify: --env <file> (repeatable; default .env.local and .env in the app folder).
scan and plan only read the repository. relay and verify use the PayPal sandbox only.`;

const VALUE_FLAGS = new Set(["mode", "app", "env", "write-to", "relay-url", "to", "url", "checkout", "webhook", "paid-text", "refunded-text", "button", "out", "fill"]);

function parse(rest: string[]) {
  const flags = new Map<string, string | true>();
  const envFiles: string[] = [];
  const fill: string[] = [];
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      let [k, v] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
      if (v === undefined && VALUE_FLAGS.has(k) && rest[i + 1] !== undefined && !rest[i + 1].startsWith("--")) v = rest[++i];
      if (k === "env" && typeof v === "string") envFiles.push(v);
      else if (k === "fill" && typeof v === "string") fill.push(v);
      else flags.set(k, v ?? true);
    } else positional.push(a);
  }
  return { flags, envFiles, fill, positional };
}

const str = (flags: Map<string, string | true>, k: string) => (typeof flags.get(k) === "string" ? (flags.get(k) as string) : undefined);

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest0] = argv;
  const sub = cmd === "relay" ? rest0[0] : undefined;
  const { flags, envFiles, fill, positional } = parse(cmd === "relay" ? rest0.slice(1) : rest0);
  if (!cmd || cmd === "help" || cmd === "--help" || flags.has("help")) {
    console.log(HELP);
    return 0;
  }
  if (!["scan", "plan", "relay", "verify"].includes(cmd) || (cmd === "relay" && sub !== "setup" && sub !== "forward")) {
    console.error(`Unknown command "${[cmd, sub].filter(Boolean).join(" ")}".\n\n${HELP}`);
    return 2;
  }
  if (positional.length !== 1) {
    console.error(`portage ${[cmd, sub].filter(Boolean).join(" ")} needs exactly one path.\n\n${HELP}`);
    return 2;
  }
  const target = path.resolve(positional[0]);
  const json = flags.has("json");
  const files = envFiles.length ? envFiles : undefined;
  try {
    if (cmd === "relay" && sub === "setup") {
      const r = await setupWebhookRelay({ appDir: target, envFiles: files, writeTo: str(flags, "write-to"), relayUrl: str(flags, "relay-url") });
      console.log(json ? JSON.stringify(r, null, 2) : renderRelaySetup(r));
      return 0;
    }
    if (cmd === "relay" && sub === "forward") {
      const to = str(flags, "to");
      if (!to) {
        console.error("portage relay forward needs --to <the app's PayPal webhook URL>.");
        return 2;
      }
      const { values } = readEnv(target, files ?? [".env.local", ".env"], ["PORTAGE_RELAY_URL", "PORTAGE_RELAY_CHANNEL"] as const);
      if (!values.PORTAGE_RELAY_URL || !values.PORTAGE_RELAY_CHANNEL) {
        console.error("PORTAGE_RELAY_URL and PORTAGE_RELAY_CHANNEL aren't set: run `portage relay setup` first.");
        return 1;
      }
      await wakeRelay(values.PORTAGE_RELAY_URL);
      const fwd = new Forwarder(values.PORTAGE_RELAY_URL, values.PORTAGE_RELAY_CHANNEL, to, (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`));
      await fwd.start();
      console.log(`Forwarding PayPal sandbox webhooks from ${values.PORTAGE_RELAY_URL} to ${to}. Ctrl+C to stop.`);
      await new Promise<void>((resolve) => process.once("SIGINT", () => resolve()));
      await fwd.stop();
      return 0;
    }
    if (cmd === "verify") {
      const url = str(flags, "url");
      if (!url) {
        console.error("portage verify needs --url <where the running app is>.");
        return 2;
      }
      const r = await verifyCheckout({
        appDir: target,
        appUrl: url,
        checkoutPath: str(flags, "checkout"),
        webhookPath: str(flags, "webhook"),
        paidText: str(flags, "paid-text"),
        refundedText: str(flags, "refunded-text"),
        fill: fill.length ? Object.fromEntries(fill.map((f) => [f.slice(0, f.lastIndexOf("=")), f.slice(f.lastIndexOf("=") + 1)])) : undefined,
        buttonIndex: str(flags, "button") ? Number(str(flags, "button")) : undefined,
        refund: !flags.has("no-refund"),
        headless: !flags.has("headed"),
        envFiles: files,
        outDir: str(flags, "out"),
      });
      console.log(json ? JSON.stringify(r, null, 2) : `${renderVerify(r)}\n\nLog:\n${r.log.join("\n")}`);
      return r.ok ? 0 : 1;
    }

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
    const plan = planMigration(scan, { mode, app: str(flags, "app") });
    console.log(json ? JSON.stringify(plan, null, 2) : renderPlan(plan));
    return plan.status === "ready" ? 0 : 3;
  } catch (err) {
    console.error(`portage: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
