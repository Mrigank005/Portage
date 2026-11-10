---
name: portage-migrate
description: Add PayPal to a Node.js app that takes payments with Stripe (Next.js App Router or Express), or move its checkout to PayPal, and prove it with a real PayPal sandbox payment. Use when the user asks to add PayPal, offer PayPal next to Stripe, migrate from Stripe to PayPal, or run Portage on a repository or its test suite.
---

# Portage: add PayPal to a Stripe app

You are adding PayPal to an existing app that already takes payments with Stripe. Portage's tools find the payment code and make the plan; you write the code; a real PayPal sandbox payment decides whether it worked.

## Rules

- **Nothing is edited before the developer approves the plan.** For apps in Portage's own `suite/` folder the plan counts as approved; say so when you proceed.
- **PayPal SDK code comes from ContextMatic, never from memory.** Before writing any call to the PayPal Server SDK (`@paypal/paypal-server-sdk`), use the `context-matic` MCP server: `fetch_api` (language `typescript`, key `paypal`), then `endpoint_search` for every method and `model_search` for every model you use. The plan lists the lookups for each step. If ContextMatic is unavailable, stop and say so.
- **Keep a log of the lookups** (tool, query, what it confirmed). It goes in the report and the pull request under "ContextMatic lookups".
- **Money goes through one helper.** Stripe amounts are integer minor units (`2400`); PayPal amounts are decimal strings (`"24.00"`). JPY stays whole; HUF and TWD take no decimals on PayPal. Refuse, never round.
- **Sandbox only.** Never use live keys. Never print, log or commit secrets; they live in the developer's own env file.
- **Stripe keeps working** in add mode. Don't change how Stripe payments behave.

## Workflow

1. **Scan.** Call `scan_payment_surface` with the repository path (absolute). If it says the repo isn't supported, tell the developer why, in its words, and stop. Change nothing.
2. **Plan.** Call `plan_migration` with the same path and the mode the developer wants (`add` keeps Stripe and adds PayPal, the default; `replace` moves new payments to PayPal). If the repo has several apps, pass `app`.
3. **Show the plan and wait for approval.** Show the headline, the steps, the files and the "Needs a person" items. Ask the developer to decide each "Needs a person" item. Don't edit anything until they approve.
4. **Edit, step by step, in the plan's order.** Match the app's own style. For each step, make that step's ContextMatic lookups first. Reuse the app's existing functions the plan names (for example the fulfilment function the Stripe webhook already calls) instead of writing parallel logic.
5. **Check.** Typecheck and build the app. Fix what fails.
6. **Prove it.** If the `verify_checkout` tool is available, run it: a real sandbox payment through the new PayPal buttons, the webhook, and a refund. If it fails, read its logs, fix the code and run it again. If the tool isn't available, say that the sandbox payment test was not run; don't claim it passed.
7. **Report.** Summarise what changed, what was verified and how, the ContextMatic lookups, and anything left for a person. If `generate_report` is available, use it.

## What Portage supports

Node.js apps in TypeScript or JavaScript, on Next.js (App Router; Pages Router works but is not in the tested set) or Express, taking one-time payments with Stripe Checkout. It refuses, with a reason: other languages, other frameworks, Stripe Connect, custom card forms (Stripe Elements) without Checkout, and subscription-only billing.
