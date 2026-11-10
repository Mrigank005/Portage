# Portage

**Add PayPal to your app in one pull request, tested in the PayPal sandbox.**

Portage is a plugin for AI coding agents. It reads a codebase that takes payments through Stripe, wires PayPal into the same checkout, orders and webhooks, then proves the result works with a real PayPal sandbox payment before handing over a pull request.

> **Status:** in active development for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/) (October–November 2026). This README describes the planned product; sections marked *planned* are not built yet.

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

- Node.js and TypeScript apps on Next.js (App Router and Pages Router) and Express
- Stripe Checkout one-time payments, webhooks, refunds, products and prices
- Tested in Claude Code and Codex; setup files for Cursor and GitHub Copilot (best effort)

Saved cards and existing subscribers can't be moved by code, and Portage says so in its report rather than attempting it.

## Built with the APIMatic Context Plugin

Portage uses [ContextMatic](https://github.com/apimatic/context-matic), APIMatic's Context Plugin, in two places:

1. **To build Portage.** This repo registers ContextMatic as an MCP server for every coding agent we develop with ([`.mcp.json`](.mcp.json), [`.cursor/mcp.json`](.cursor/mcp.json), [`.vscode/mcp.json`](.vscode/mcp.json)), and [`AGENTS.md`](AGENTS.md) requires that all PayPal SDK code is written from ContextMatic lookups, not from memory.
2. **Inside Portage.** The Portage plugin ships with ContextMatic registered ([`plugin/.mcp.json`](plugin/.mcp.json)), and its migration skill makes the user's coding agent call ContextMatic's `endpoint_search` and `model_search` before writing each PayPal SDK call.

Details: [docs/apimatic-context-plugin.md](docs/apimatic-context-plugin.md).

## Planned repository layout

```
packages/core        scanner, Stripe→PayPal mapping, planner, report builder
packages/mcp-server  Portage MCP tools
packages/cli         `portage init` (per-agent setup) and `portage report`
plugin/              skill and agent configuration
suite/               small test apps used to evaluate Portage
apps/website         project website with setup prompts and benchmark results
apps/webhook-relay   forwards PayPal sandbox webhooks to apps running locally
```

## Getting started

Setup prompts and run instructions will be added here as the first release comes together. You will need Node.js 20+, a PayPal developer account with sandbox credentials, and a supported coding agent. See [`.env.example`](.env.example) for the configuration Portage will read.

## License

[MIT](LICENSE)
