# Working on Portage

Instructions for any AI coding agent (Claude Code, GitHub Copilot, Cursor) working in this repository.

## Project

Portage is a plugin for AI coding agents that adds PayPal to codebases that use Stripe, then verifies the result with a real PayPal sandbox payment. TypeScript throughout, Node.js 20+.

## Rule: PayPal SDK code comes from ContextMatic, not memory

PayPal Server SDK v2 is newer than most models' training data. Before writing or changing any code that calls the PayPal Server SDK, use the **context-matic** MCP server (APIMatic Context Plugin), registered in `.mcp.json`:

1. `fetch_api` with `language=typescript` and `key=paypal`, to confirm the API and SDK.
2. `ask` for the integration pattern you need (client setup, order creation, capture, refunds, webhooks).
3. `endpoint_search` for the exact method signature of every SDK call you write.
4. `model_search` for every request or response model you construct or read.

Do not guess method names, model fields or enum values. If ContextMatic is unavailable, stop and say so instead of writing PayPal SDK code from memory.

Record the lookups behind each change in the pull request description under a "ContextMatic lookups" heading, listing the tool, the query, and what it confirmed.

## Rule: the Stripe→PayPal map is data, and its SDK names are confirmed

`packages/core/maps/stripe-paypal.json` holds every Stripe→PayPal translation; the planner contains no PayPal knowledge of its own. To name a new PayPal SDK method or model in the map, look it up through ContextMatic first, add it to `paypalSdk.methods` or `paypalSdk.models`, and record the lookup in `docs/contextmatic-lookups.md`. `packages/core/test/map.test.ts` fails on unconfirmed names.

## Other rules

- Sandbox only. Never use live PayPal or Stripe keys.
- Secrets live in `.env` (see `.env.example`). Never commit `.env`, keys, tokens or passwords.
- Stripe amounts are integer minor units (`2400`); PayPal amounts are decimal strings (`"24.00"`). Zero-decimal currencies such as JPY stay whole. Convert in one shared helper.
- Use the `PayPal-Request-Id` header for idempotent PayPal calls.
- Verify PayPal webhooks with the verify-webhook-signature API before trusting them.
- Suite apps talk to **Standin** (`STRIPE_API_BASE`), never to real Stripe. Standin must stay compatible with the official `stripe` Node SDK: response shapes from Stripe's public OpenAPI spec, and the same `Stripe-Signature` webhook scheme. Don't change a suite app to work around a Standin gap; fix Standin. See `docs/standin.md`.
- Never claim results were verified against live Stripe. Reports, docs and the website say the suite runs on Standin.
