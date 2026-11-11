# Portage

**Add PayPal to your app in one pull request, tested in the PayPal sandbox.**

Portage is a plugin for AI coding agents. It reads a codebase that takes payments through Stripe, wires PayPal into the same checkout, orders and webhooks, then proves the result works with a real PayPal sandbox payment before handing over a pull request.

> **Status:** in active development for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/) (October–November 2026). Built so far: **Standin** (the local Stripe-compatible server), the **test suite** (Brewbox, Quill, Ledgerline), Portage's **scan** and **plan** tools, tested **reference code** for the PayPal parts that must be exact, **catalog copy**, the playbook that drives the edit step, the **webhook relay** and **`verify_checkout`**, the automated sandbox payment test. Portage's workflow has added PayPal to Brewbox (Next.js) and Quill (Express), and `verify_checkout` passed on both with real sandbox payments, real PayPal webhooks and refunds ([Brewbox](benchmark/runs/brewbox-add/README.md), [Quill](benchmark/runs/quill-add/README.md)). A headless Claude Code agent, given only the README prompt on a fresh clone, did the same for Quill unaided ([the run](benchmark/runs/quill-agent-run/README.md)). Steps marked *planned* are not built yet.

---

## Why

Most small online businesses and SaaS apps start on one payment provider. Adding PayPal later means learning a second API, translating every payment flow, keeping orders and receipts in sync, and testing everything end to end, so teams put it off.

AI coding agents should make this easy, but they guess at payment APIs. PayPal's Server SDK v2 is too new to be in most models' training data, and in payments a wrong guess becomes a bug. Portage combines a migration playbook, accurate SDK context from the **APIMatic Context Plugin**, and a real sandbox payment that proves the change works.

## How it works

1. **Scan** *(built)*. Parse the code's structure to find the Stripe client, Checkout sessions, webhook handlers and the events they handle (down to the app function each one calls), refunds, the checkout button, where Stripe IDs are stored, and settings. Unsupported repos get a clear reason instead of a partial run.
2. **Plan** *(built)*. Apply the [Stripe→PayPal map](packages/core/maps/stripe-paypal.json) (data, not code) to list the files to create and change, the new routes, the webhook event mapping, money conversion and anything that needs a person, plus the ContextMatic lookups to make for each step.
3. **Approve.** Nothing is edited until the developer approves the plan.
4. **Edit** *(built: playbook and reference code)*. The coding agent writes the PayPal integration with the official PayPal Server SDK, starting from Portage's tested reference code (`get_reference_code`) and looking up every SDK method and model through ContextMatic first. Buttons use PayPal's JS SDK v6.
5. **Copy the catalog** *(built, replace mode)*. `migrate_catalog` copies Stripe products to the PayPal catalog (dry run first, idempotent) and keeps one-time prices, as PayPal amounts, in `portage.catalog.json`. It makes the same call as the PayPal Agent Toolkit's `create_product` (`POST /v1/catalogs/products`); Portage doesn't bundle the toolkit itself because its dependency tree adds seven npm security advisories, and Portage keeps `npm audit` at zero.
6. **Prove it** *(built)*. `setup_webhook_relay` points a PayPal sandbox webhook at Portage's relay, so PayPal's webhooks reach an app on localhost. `verify_checkout` then completes a real sandbox checkout in a headless browser: buyer approval, the capture checked with PayPal, PayPal's real webhooks forwarded to the app (and a forged one that must be rejected), the order marked paid, then a refund. The agent fixes whatever fails and runs it again. If PayPal's own MCP server (the Agent Toolkit) is connected, the agent also looks the payment up there.
7. **Hand over a pull request** *(built, as the playbook's report step)*. The agent writes what changed, the `verify_checkout` report card with PayPal's order, capture and refund IDs, its ContextMatic lookups, and what still needs a human, ready for the pull request description.

Scan and plan only read code; they never change files and never read real env files. How they work, and everything they detect: [docs/scan-and-plan.md](docs/scan-and-plan.md). The edit step, reference code and catalog copy: [docs/edit-and-catalog.md](docs/edit-and-catalog.md). The sandbox test and the relay: [docs/verify-and-relay.md](docs/verify-and-relay.md). Results on five real open-source Stripe apps: [benchmark/real-repos](benchmark/real-repos/README.md).

### Two modes

- **Add PayPal alongside Stripe** (default): cards stay on Stripe; PayPal, Venmo and Pay Later appear at checkout and flow into the app's existing orders and fulfilment code.
- **Replace Stripe**: new payments go through PayPal only. The Stripe catalog is copied to PayPal (`migrate_catalog`), the Stripe checkout is removed, and Stripe stays only to refund orders it already took. A headless agent did this to Brewbox from one prompt and passed `verify_checkout` on its first run ([the run](benchmark/runs/brewbox-replace-agent-run/README.md)).

### Supported in the first release

- Node.js apps in TypeScript or JavaScript on Next.js and Express (the Next.js Pages Router is scanned and planned, but not yet in the tested set)
- Stripe Checkout one-time payments, webhooks, refunds, products and prices
- Tested in Claude Code ([Quill](benchmark/runs/quill-agent-run/README.md), [Brewbox, replace mode](benchmark/runs/brewbox-replace-agent-run/README.md)) and GitHub Copilot in VS Code agent mode ([Quill](benchmark/runs/quill-copilot-run/README.md)); setup files for Cursor (not yet run)
- No Stripe account needed to try it: the test apps run against Standin (below)

Saved cards and existing subscribers can't be moved by code, and Portage says so in its report rather than attempting it.

## Why there's a fake Stripe in here

Portage is built in India, where Stripe is currently invite-only. Our invite hasn't arrived yet. Rather than wait by the letterbox, we wrote **Standin**: a small local server that speaks just enough of the Stripe API for our test apps.

- The test apps use the **official `stripe` Node SDK**, unmodified, pointed at `localhost` instead of Stripe.
- Standin serves a simple test checkout page and sends webhooks signed the same way Stripe signs them, so the SDK's own signature check passes.
- Its responses are checked against Stripe's public OpenAPI specification, so the shapes are real rather than guessed. A control test breaks valid objects on purpose and requires the check to reject them.
- It covers only what the test apps use: products, prices, Checkout sessions, payments, refunds and their webhooks. Anything else returns Stripe's own "Unrecognized request URL" error.

On your own repo, none of this applies. Portage reads your code, and catalog migration uses your project's real Stripe keys. Standin exists only so the test suite runs anywhere, and as a bonus, you don't need a Stripe account to try Portage. We also scan real open-source apps that use Stripe, so the results aren't limited to code we wrote ourselves.

For the record, PayPal's sandbox worked from India on the first try.

Details: [docs/standin.md](docs/standin.md).

## Built with the APIMatic Context Plugin

Portage uses [ContextMatic](https://github.com/apimatic/context-matic), APIMatic's Context Plugin, in two places:

1. **To build Portage.** This repo registers ContextMatic as an MCP server for every coding agent we develop with ([`.mcp.json`](.mcp.json), [`.cursor/mcp.json`](.cursor/mcp.json), [`.vscode/mcp.json`](.vscode/mcp.json)), and [`AGENTS.md`](AGENTS.md) requires that all PayPal SDK code is written from ContextMatic lookups, not from memory.
2. **Inside Portage.** The Portage plugin ships with ContextMatic registered ([`plugin/.mcp.json`](plugin/.mcp.json)). Every plan lists the ContextMatic lookups to make for each step, and the [migration skill](plugin/skills/portage-migrate/SKILL.md) makes the user's coding agent call `endpoint_search` and `model_search` before writing each PayPal SDK call.

Every PayPal SDK method and model in Portage's map was confirmed through ContextMatic, and a test keeps it that way. The lookups, and what each one changed: [docs/contextmatic-lookups.md](docs/contextmatic-lookups.md). More: [docs/apimatic-context-plugin.md](docs/apimatic-context-plugin.md).

## Repository layout

```
packages/core        scanner, Stripe→PayPal map (maps/stripe-paypal.json),
                     money conversion, planner                                (built)
packages/mcp-server  Portage MCP server: scan_payment_surface, plan_migration, get_reference_code,
                     migrate_catalog, setup_webhook_relay, verify_checkout, and the
                     `migrate` prompt (built)
packages/cli         `portage try`, `init`, `scan`, `plan`, `relay` and `verify` (built)
packages/standin     Standin, the local Stripe-compatible test server         (built)
plugin/              plugin manifest, MCP config and the portage-migrate skill
suite/               small test apps used to evaluate Portage                 (built)
  brewbox-store        Next.js shop
  quill-saas           Express app selling credit packs
  ledgerline-flask     Flask app, unsupported on purpose
benchmark/real-repos scan and plan results on real open-source Stripe apps
benchmark/runs       full runs on the suite apps, with verify_checkout report cards and screenshots
scripts/             setup checks, PayPal token refresh, suite end-to-end check, real-repo benchmark
apps/website         project website with setup prompts and benchmark results (planned)
apps/webhook-relay   forwards PayPal sandbox webhooks to apps running locally (built; on Render)
```

## Try it

You need:

- Node.js 20.9 or newer, Git, and Google Chrome or Microsoft Edge (`verify_checkout` drives the browser you already have).
- A coding agent: Claude Code, VS Code with GitHub Copilot (Agent mode), or Cursor.
- A free [PayPal developer account](https://developer.paypal.com/) for sandbox credentials. You won't need a Stripe account: the test apps run on Standin.

```bash
git clone https://github.com/Mrigank005/Portage
cd Portage
npm install
cp .env.example .env      # then fill in the PayPal sandbox section (below)
npx portage try quill     # or: npx portage try brewbox
```

**What goes in `.env`.** In the PayPal developer dashboard, with **Sandbox** selected:

- *Apps & Credentials*: open the default app (or create one) and copy its **Client ID** and **Secret** into `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`.
- *Testing Tools → Sandbox Accounts*: pick a **Personal** account, open *View/Edit account*, and copy its email and password into `PAYPAL_SANDBOX_BUYER_EMAIL` and `PAYPAL_SANDBOX_BUYER_PASSWORD`. A **US** personal account works best: in our runs, a non-US default buyer got "This seller doesn't accept payments in your currency". You can create one under *Create account* (country: United States).

Leave everything else as it is. The keys stay on your machine; Portage never prints them.

**`npx portage try quill`** checks your setup (Node, the PayPal keys, the buyer login, a browser, the webhook relay). It then copies the Quill test app into `trial/quill-saas` with its settings and a git baseline, installs its packages, and prints a prompt.

**Then open the Portage folder in your agent** and paste the prompt:

- **Claude Code:** approve the project's MCP servers (`portage` and `context-matic`) when asked, and sign in to context-matic (APIMatic's Context Plugin, free) with `/mcp`. The playbook is the `portage-migrate` skill.
- **GitHub Copilot:** open Copilot Chat in **Agent** mode and start the two servers from `.vscode/mcp.json` when VS Code offers. Paste the prompt as your message: Copilot loads the `portage-migrate` skill by itself. (The `/mcp.portage.migrate` prompt holds the same playbook, but on its own it doesn't say which app or where its settings are.)
- **Cursor:** enable the two servers in *Settings → MCP*. The playbook is the `migrate` prompt.

The agent scans the app, shows its plan, writes the PayPal integration with ContextMatic lookups and Portage's reference code, registers a PayPal sandbox webhook through Portage's relay, then runs `verify_checkout`: a real sandbox payment in a headless browser, PayPal's real webhooks, a forged one that must be rejected, and a refund. It fixes what fails and reports a report card. `cd trial/quill-saas && git diff` shows every change.

### On your own repository

```bash
npx portage init --agent claude                                   # installs the Claude Code plugin
npx portage init --agent copilot --project path/to/your/repo      # writes .vscode/mcp.json there
npx portage init --agent cursor  --project path/to/your/repo      # writes .cursor/mcp.json there
```

Then ask your agent to add PayPal with Portage. Put your PayPal sandbox settings in that repository's own env file. Catalog copy (replace mode) also uses its Stripe **test** keys.

### Run the tests

```bash
npm test                # all tests; the first run downloads Stripe's OpenAPI spec into .cache/.
                        # With PayPal sandbox keys in .env, a few tests also run against the real sandbox.
npm run suite:e2e       # Standin + Brewbox + Quill, with real payments driven through each (needs ports 4242, 4300, 4301)

npx portage scan suite/brewbox-store          # what Portage finds in a Stripe app
npx portage plan suite/quill-saas             # the plan for adding PayPal (--mode replace for the other mode)
npx portage plan suite/ledgerline-flask       # a refusal, with the reason
```

See [`suite/README.md`](suite/README.md) to run the apps by hand. Working in this repository with any of the three agents gives it Portage's MCP tools (`scan_payment_surface`, `plan_migration`, `get_reference_code`, `migrate_catalog`, `setup_webhook_relay`, `verify_checkout`) and the `migrate` prompt, next to ContextMatic.

## License

[MIT](LICENSE)
