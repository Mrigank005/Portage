# Scan and plan

Portage's first two tools decide what a migration involves before any code changes. Both are deterministic code, not model output: the same repository always gives the same scan and the same plan. Both only read files.

| | MCP tool | CLI |
|---|---|---|
| Scan | `scan_payment_surface({ repoPath })` | `npx portage scan <path> [--json]` |
| Plan | `plan_migration({ repoPath, mode?, app? })` | `npx portage plan <path> [--mode add\|replace] [--app <folder>] [--json]` |

Each returns a Markdown report for people and the same result as JSON for the agent. The CLI exits with 0 when the repository is supported, 3 when it isn't, and 2 for bad arguments.

## Scan

The scanner parses TypeScript and JavaScript with [ts-morph](https://ts-morph.com) and follows each file's own `tsconfig.json` or `jsconfig.json`, so path aliases like `@/lib/stripe` resolve.

### How it decides a call is Stripe

A call such as `x.checkout.sessions.create(...)` counts when its receiver provably comes from the `stripe` package:

- `new Stripe(key)`, `Stripe(key)` or `require("stripe")(key)`, including clients created lazily (`client = new Stripe(...)` inside a function) and through a factory (`getStripe()`);
- imported from the app's own module that creates one, whatever it's called locally (`import payments from "@/lib/stripe"`), by `import`, `require`, destructuring or a namespace import.

Those are **high** confidence. When the receiver is only *named* like Stripe (for example a `stripe` parameter), the call is reported with **medium** confidence and flagged, and only if it uses a real Stripe resource name.

### What it reports, per app

| Finding | Details |
|---|---|
| Framework | Next.js (App Router, Pages Router or both) or Express, with versions; other frameworks by name |
| Stripe clients | Where they're created, the key's env var, custom API hosts (Standin, stripe-mock), API version |
| Checkout sessions | The route or server action that creates them; modes (including modes set in different branches); line items (price IDs, inline `price_data`, currencies, amounts); reference IDs; success and cancel URLs; idempotency keys; how the browser gets to Stripe (redirect, JSON, client secret); where the session ID is stored |
| Webhook handlers | Route; how the raw body is read; the secret's env var; every event type handled (`switch`, `if`, variables copied from `event.type`, handler tables); for each event, the app functions it calls (with their definitions and parameters), other Stripe calls, and the Stripe object fields it reads |
| Refunds | Route; by payment intent or charge; where the ID comes from (for example `order.paymentIntentId`); partial amounts |
| Checkout button | The form, link, `fetch` or server-action call that starts checkout |
| Browser code | Stripe.js, Elements card forms, embedded Checkout, `redirectToCheckout`, Payment Links |
| Stored Stripe IDs | Fields in TypeScript interfaces, types and classes, Drizzle tables, Mongoose schemas and Prisma models |
| Settings | Stripe-related env vars used in code, and the key names (never values) in example env files |
| Every Stripe call | With its status in the Stripe→PayPal map: mapped, catalog, needs a person, blocker, or not in the map |

Monorepos are split into apps by `package.json`. Test files are scanned but never affect the result.

### When Portage refuses

| Code | Meaning |
|---|---|
| `LANGUAGE_UNSUPPORTED` | Stripe is used only from Python, Ruby, PHP, Go, Java/Kotlin or C#. The report lists the lines it found. |
| `NO_STRIPE` | No Stripe payment code at all |
| `FRAMEWORK_UNSUPPORTED` | Fastify, NestJS, Koa, Hono, Remix, SvelteKit, Nuxt, Astro, or no web framework |
| `STRIPE_CONNECT` | Connect accounts, transfers, application fees or `transfer_data`: adding PayPal would bypass the platform's payment splits |
| `ELEMENTS_ONLY` | A custom card form (Stripe Elements and PaymentIntents) with no Checkout |
| `SUBSCRIPTIONS_ONLY` | Subscription billing only |
| `NO_ONE_TIME_CHECKOUT` | Stripe code, but no Checkout session in payment mode |

Things Portage can work around are listed for a person instead: subscriptions or Elements next to Checkout, promotion codes, automatic tax, a custom Elements UI on Checkout Sessions, Pages Router apps, currencies PayPal doesn't accept, and prices PayPal can't represent (for example 10.45 HUF, because PayPal takes HUF in whole forints).

### Safety

- Read-only: the tests check that file modification times don't change.
- Real env files (`.env`, `.env.local`, ...) are never opened. Example files (`.env.example` and similar) contribute key names only; values are dropped. The tests plant secrets and check none appear in the output.
- Symlinks are not followed, dependency and build folders are skipped, and large files are skipped.

## Plan

The planner applies [`maps/stripe-paypal.json`](../packages/core/maps/stripe-paypal.json) to the scan. The map is data: Stripe calls, Checkout parameters, webhook events and object fields, each with its PayPal counterpart and status, plus currency rules. Every PayPal SDK method and model it names was confirmed through ContextMatic ([lookups](contextmatic-lookups.md)).

A plan has:

- **Steps** in order: packages, settings, PayPal client and money helper, order fields, shared fulfilment, create-order route, capture route, PayPal webhook, refunds, buttons, then the sandbox test. Each step names its files, what to do in this app's terms, and the ContextMatic lookups to make first.
- **Files** to create, change and remove; **routes**; **webhook events** (Stripe event, PayPal event, the app function to reuse, and field-by-field notes); **order fields**; **money** per currency; **settings**; **items for a person**; and in add mode, **what stays as it is**.

Decisions the planner makes from the code:

- New routes follow the app's layout: App Router route files, Pages Router API files, or routes added to the Express file that registers the Stripe ones. The PayPal client goes next to the Stripe client.
- The fulfilment code the Stripe webhook already calls is reused. If its arguments are Stripe-shaped (`sessionId`, `paymentIntentId`), the plan says to make it provider-neutral. If fulfilment is written inline in the webhook, the plan extracts it into a shared function first, so Stripe and PayPal can't drift apart. Refund bookkeeping gets the same treatment.
- Order records gain `paymentProvider`, `paypalOrderId` and `paypalCaptureId` next to the existing Stripe fields, so refunds can find the PayPal capture.
- `shippingPreference` is `NO_SHIPPING` unless the Stripe session collects an address.
- PayPal refund events carry only that refund's amount, while Stripe's `charge.refunded` carries a running total; the plan says how to bridge it.
- Name clashes are called out (for example an app function called `createOrder`).
- With several supported apps, the planner picks the one needing the fewest decisions and says how to plan the others.
- In add mode the catalog stays on Stripe: one-time PayPal orders carry their own item names and amounts. In replace mode the plan copies the catalog with `migrate_catalog` and keeps the Stripe client, webhook and refunds for orders already paid with Stripe.

## Money

[`money.ts`](../packages/core/src/money.ts) converts Stripe's integer minor units to PayPal's decimal strings and back, using each provider's own decimal rules (Stripe: zero-decimal, three-decimal and special-case currencies; PayPal: the 25 currencies it accepts, with HUF, JPY and TWD taking no decimals). It uses integer arithmetic only, and refuses rather than rounds: `1045` in HUF (10.45 HUF) has no PayPal amount, so it raises `PRECISION_LOSS`. Round trips are tested on thousands of amounts.
