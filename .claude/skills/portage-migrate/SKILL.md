---
name: portage-migrate
description: Add PayPal to a Node.js app that takes payments with Stripe (Next.js or Express), or move its checkout to PayPal, and prove it with a real PayPal sandbox payment. Use when the user asks to add PayPal, offer PayPal next to Stripe, migrate from Stripe to PayPal, or run Portage on a repository or its test suite.
---

# Portage: add PayPal to a Stripe app

You are adding PayPal to an app that already takes payments with Stripe. Portage's tools find the payment code, make the plan and hand you tested reference code; you write the integration in the app's own style; a real PayPal sandbox payment decides whether it worked.

## Rules

- **Nothing is edited before the developer approves the plan.** If you can't ask (your question fails, or there's no way to ask), stop after showing the plan: no answer is not approval. The one exception is a test app that `npx portage try` copied into `trial/`, whose prompt says the plan counts as approved; say so when you continue.
- **Edit only the app the plan is for.** If the repository has several apps and the developer hasn't named one, list them and ask. Never edit Portage's own repository (its `suite/` apps, `packages/` or tests): to try Portage on a suite app, run `npx portage try <app>` and work on the copy in `trial/`. Never change code or tests outside the app to make them pass; if your change breaks something outside the app, stop and report it.
- **PayPal SDK code comes from ContextMatic, never from memory.** Before writing any call to the PayPal Server SDK (`@paypal/paypal-server-sdk`), use the `context-matic` MCP server: `fetch_api` (language `typescript`, key `paypal`), then `endpoint_search` for every method and `model_search` for every model you use. Each plan step lists its lookups. If ContextMatic is unavailable, stop and say so.
- **Start from Portage's reference code** where a plan step names it (`get_reference_code`). It is typechecked against the real PayPal packages and tested against the PayPal sandbox. Adapt names, paths and style to the app; keep the behaviour.
- **Keep a log of your ContextMatic lookups** (tool, query, what it confirmed). It goes in the report and the pull request under "ContextMatic lookups".
- **Money goes through the money helper.** Stripe amounts are integer minor units (`2400`); PayPal amounts are decimal strings (`"24.00"`). Refuse amounts PayPal can't represent; never round.
- **The server decides the price.** The browser sends what is being bought (product, quantity), never an amount.
- **Sandbox only.** Never use live keys. Never print, log or commit secrets; they live in the developer's own env file.
- **Stripe keeps working** in add mode. Don't change how Stripe payments behave.

## Workflow

1. **Scan.** Call `scan_payment_surface` with the absolute path of the repository. If it says the repository isn't supported, tell the developer why, in its words, and stop without changing anything.
2. **Plan.** Call `plan_migration` with the same path and the mode the developer wants: `add` keeps Stripe and adds PayPal (the default); `replace` moves new payments to PayPal. If the repository has several apps, pass `app`.
3. **Approve.** Show the headline, the steps, the files and the "Needs a person" items. Ask the developer to decide each "Needs a person" item. Wait for approval.
4. **Edit, in the plan's order.** For each step: fetch the reference code it names, make its ContextMatic lookups, then write the change. Reuse the app functions the plan names (for example the fulfilment function the Stripe webhook already calls) instead of writing parallel logic. Add the PayPal settings to the app's example env file with placeholder values only.
5. **Check.** Install the new packages, then typecheck and build the app and run its existing tests. Fix what fails.
6. **Copy the catalog** (replace mode only, or when the plan says so). Call `migrate_catalog` with `dryRun: true`, show the result, then run it for real once the developer agrees.
7. **Connect webhooks.** Call `setup_webhook_relay` once. It registers a webhook in the developer's own PayPal sandbox app that points at Portage's relay, and writes `PAYPAL_WEBHOOK_ID`, `PORTAGE_RELAY_URL` and `PORTAGE_RELAY_CHANNEL` to the app's env file (pass `writeTo` if the app loads a different file at runtime). Then start or restart the app so it reads them.
8. **Prove it.** With the app running, call `verify_checkout` with its URL, the page with the PayPal button, the PayPal webhook route, and the text the app shows once an order is paid and once it is refunded. It makes a real sandbox payment in a headless browser, checks the capture with PayPal, forwards PayPal's real webhooks to the app, sends a forged one that must be rejected, and refunds. If a step fails, read its detail, log and screenshots, fix the code, restart the app if you changed server code or settings, and run it again, until it passes. A **WARN** step is PayPal's sandbox being late with a webhook, not the app failing: report it as it is. If the tool isn't available, say the sandbox payment test was not run; never claim it passed.
9. **Confirm with PayPal's own tools (optional, never blocking).** If PayPal's MCP server (the PayPal Agent Toolkit) is connected to you, look up the IDs that `verify_checkout` reported: `get_order` with the order ID (it shows the order, the app's `custom_id`, and the capture's current status) and `get_refund` with the refund ID. Say in the report what PayPal returned, and whether `custom_id` is the app's own order ID. Don't rely on `list_transactions` for a payment made minutes ago: PayPal's transaction search can lag by hours, so "not found" there isn't a failure. If the toolkit isn't connected, or a call fails (for example an expired token), say so in one line and carry on: `verify_checkout` has already checked the same IDs with PayPal.
10. **Report.** Summarise what changed; the `verify_checkout` report card (each step, PayPal's order, capture and refund IDs, and where the screenshots are); your ContextMatic lookups; and anything left for a person. Keep `.portage/` (the screenshots) out of git.

## What Portage supports

Node.js apps in TypeScript or JavaScript, on Next.js (App Router; the Pages Router works but is not in the tested set) or Express, taking one-time payments with Stripe Checkout. Portage refuses, with a reason: other languages and frameworks, Stripe Connect, custom card forms (Stripe Elements) without Checkout, and subscription-only billing.
