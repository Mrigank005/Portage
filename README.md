# Portage

**Add PayPal to your app in one pull request, tested in the PayPal sandbox.**

Portage is a plugin for AI coding agents. It reads a codebase that takes payments through Stripe, wires PayPal into the same checkout, orders and webhooks, then proves the result works with a real PayPal sandbox payment before handing over a pull request.

> **Status:** in active development for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/) (October–November 2026). Built so far: **Standin** (the local Stripe-compatible server) and the **test suite** (Brewbox, Quill, Ledgerline). The Portage plugin itself is next; sections marked *planned* are not built yet.

---

## Why

Most small online businesses and SaaS apps start on one payment provider. Adding PayPal later means learning a second API, translating every payment flow, keeping orders and receipts in sync, and testing everything end to end, so teams put it off.

AI coding agents should make this easy, but they guess at payment APIs. PayPal's Server SDK v2 is too new to be in most models' training data, and in payments a wrong guess becomes a bug. Portage combines a migration playbook, accurate SDK context from the **APIMatic Context Plugin**, and a real sandbox payment that proves the change works.

## How it works *(planned)*

1. **Scan.** Find every Stripe call, webhook, price ID and environment variable by parsing the code's structure.
2. **Plan.** Map each flow to its PayPal equivalent and list anything that can't be moved automatically.
3. **Approve.** Nothing is edited until the developer approves the plan.
4. **Edit.** The coding agent writes the PayPal integration with the official PayPal Server SDK, looking up every SDK method and model through ContextMatic first.
5. **Copy the catalog.** Recreate Stripe products and prices as PayPal catalog products.
6. **Prove it.** Start the app and complete a real sandbox checkout in a headless browser: buyer approval, capture, webhook, order marked paid, refund.
7. **Hand over a pull request** with a report card of what changed, what was tested, and what still needs a human.

### Two modes

- **Add PayPal alongside Stripe** (default): cards stay on Stripe; PayPal, Venmo and Pay Later appear at checkout and flow into the app's existing orders and fulfilment code.
- **Replace Stripe**: the same engine plus a removal step.

### Supported in the first release

- Node.js and TypeScript apps on Next.js (App Router; Pages Router planned) and Express
- Stripe Checkout one-time payments, webhooks, refunds, products and prices
- Tested in Claude Code and GitHub Copilot (VS Code agent mode); setup files for Cursor (best effort)
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
2. **Inside Portage.** The Portage plugin ships with ContextMatic registered ([`plugin/.mcp.json`](plugin/.mcp.json)), and its migration skill makes the user's coding agent call ContextMatic's `endpoint_search` and `model_search` before writing each PayPal SDK call.

Details: [docs/apimatic-context-plugin.md](docs/apimatic-context-plugin.md).

## Repository layout

```
packages/standin     Standin, the local Stripe-compatible test server      (built)
suite/               small test apps used to evaluate Portage              (built)
  brewbox-store        Next.js shop
  quill-saas           Express app selling credit packs
  ledgerline-flask     Flask app, unsupported on purpose
scripts/             setup checks, PayPal token refresh, suite end-to-end check
packages/core        scanner, Stripe→PayPal mapping, planner, report builder   (planned)
packages/mcp-server  Portage MCP tools                                         (planned)
packages/cli         `portage init` (per-agent setup) and `portage report`     (planned)
plugin/              skill and agent configuration                             (planned)
apps/website         project website with setup prompts and benchmark results  (planned)
apps/webhook-relay   forwards PayPal sandbox webhooks to apps running locally  (planned)
```

## Getting started

You need Node.js 20+. You won't need a Stripe account.

```bash
npm install
npm test                # Standin's tests; the first run downloads Stripe's OpenAPI spec into .cache/
npm run suite:e2e       # Standin + Brewbox + Quill, with real payments driven through each
```

The suite check starts everything itself and needs ports 4242, 4300 and 4301 free. See [`suite/README.md`](suite/README.md) to run the apps by hand.

Setup prompts for the Portage plugin will be added here as it comes together. It will also need a PayPal developer account with sandbox credentials and a supported coding agent; see [`.env.example`](.env.example) for the configuration it reads.

## License

[MIT](LICENSE)
