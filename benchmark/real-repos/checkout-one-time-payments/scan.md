Source: https://github.com/stripe-samples/checkout-one-time-payments at commit `c834ba3ae155bd77a6aeb5879b58edd6a944af00`. Stripe's own sample for one-time Checkout payments: an Express server with plain HTML, next to servers in six other languages.

# Portage scan: checkout-one-time-payments

**Result: supported.** Portage can plan this migration.

Files by language: TypeScript 11 · JavaScript 9 · Ruby 5 · PHP 4 · C# 3 · Go 1 · Java or Kotlin 1 · Python 1

- **OTHER_LANGUAGES**: Stripe is also used from C# and Go and Java or Kotlin and PHP and Python and Ruby. Portage only changes the Node.js apps and leaves that code alone. (server/dotnet/Program.cs:2, server/dotnet/Program.cs:3, server/dotnet/Program.cs:63, server/dotnet/Program.cs:85, server/dotnet/Program.cs:96)

## stripe-sample-checkout-one-time-payments-nextjs (server/nextjs)

Next.js 16.1.5 (App Router) · TypeScript · stripe 20.2.0 · **supported**

| What | Where | Details |
|---|---|---|
| Stripe client | server/nextjs/lib/stripe.ts:8 | key from `STRIPE_SECRET_KEY`; API version 2025-12-15.clover |
| Checkout `POST /api/create-checkout-session` | server/nextjs/app/api/create-checkout-session/route.ts:11 | mode payment; price `process.env.PRICE`; success URL uses {CHECKOUT_SESSION_ID}; responds with redirect |
| Webhook `POST /api/webhook` | server/nextjs/app/api/webhook/route.ts:13 | verified with constructEvent; raw body via request.text(); secret `STRIPE_WEBHOOK_SECRET`; handles `checkout.session.completed` |
| Checkout button | server/nextjs/app/page.tsx:42 | `POST /api/create-checkout-session`: `<form action="/api/create-checkout-session" method="POST">` |
| Settings |  | `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` |

### Stripe calls (4)

| Call | Where | Portage |
|---|---|---|
| `checkout.sessions.retrieve` | server/nextjs/app/api/checkout-session/route.ts:15 | mapped |
| `prices.retrieve` | server/nextjs/app/api/config/route.ts:6 | catalog |
| `checkout.sessions.create` | server/nextjs/app/api/create-checkout-session/route.ts:11 | mapped |
| `webhooks.constructEvent` | server/nextjs/app/api/webhook/route.ts:13 | mapped |

## checkout-one-time-payments (server/node)

Express 4.17.1 · JavaScript · stripe 20.2.0 · **supported**

| What | Where | Details |
|---|---|---|
| Stripe client | server/node/server.js:15 | key from `STRIPE_SECRET_KEY` |
| Checkout `POST /create-checkout-session` | server/node/server.js:72 | mode payment; price `process.env.PRICE`; success URL uses {CHECKOUT_SESSION_ID}; responds with redirect |
| Webhook `POST /webhook` | server/node/server.js:99 | verified with constructEvent; raw body via req.rawBody; secret `STRIPE_WEBHOOK_SECRET`; handles `checkout.session.completed` |
| Settings |  | `STRIPE_PUBLISHABLE_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` |

### Stripe calls (4)

| Call | Where | Portage |
|---|---|---|
| `prices.retrieve` | server/node/server.js:44 | catalog |
| `checkout.sessions.retrieve` | server/node/server.js:56 | mapped |
| `checkout.sessions.create` | server/node/server.js:72 | mapped |
| `webhooks.constructEvent` | server/node/server.js:99 | mapped |

_Scanned 100 files, parsed 11. The scan only reads files; it never changes the repository, and it never reads real env files._
