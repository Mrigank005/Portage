Source: https://github.com/nextjs/saas-starter at commit `6e33e58b1e553a41fe22e6b941a7229a002de361`. The Next.js SaaS starter (Drizzle, Postgres): subscriptions through Checkout and the customer portal.

# Portage scan: saas-starter

**Result: not supported.** Only subscription billing found. Portage migrates one-time Checkout payments; subscriptions are on its roadmap.

Files by language: TypeScript 41 · JavaScript 1

## saas-starter

Next.js 15.6.0 (App Router) · TypeScript · stripe 18.1.0 · **not supported**

| What | Where | Details |
|---|---|---|
| Stripe client | lib/payments/stripe.ts:10 | key from `STRIPE_SECRET_KEY`; API version 2025-04-30.basil |
| Checkout | lib/payments/stripe.ts:27 | mode subscription; price `priceId`; reference `user.id.toString()`; success URL uses {CHECKOUT_SESSION_ID}; responds with redirect |
| Webhook `POST /api/stripe/webhook` | app/api/stripe/webhook/route.ts:14 | verified with constructEvent; raw body via request.text(); handles `customer.subscription.updated` → handleSubscriptionChange (lib/payments/stripe.ts:117); `customer.subscription.deleted` → handleSubscriptionChange (lib/payments/stripe.ts:117) |
| Stored Stripe IDs | lib/db/schema.ts:27 | teams: `stripeCustomerId`, `stripeSubscriptionId`, `stripeProductId` |
| Settings |  | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` |

### Stripe calls (15)

| Call | Where | Portage |
|---|---|---|
| `checkout.sessions.retrieve` | app/api/stripe/checkout/route.ts:18 | mapped |
| `subscriptions.retrieve` | app/api/stripe/checkout/route.ts:36 | needs-human |
| `webhooks.constructEvent` | app/api/stripe/webhook/route.ts:14 | mapped |
| `products.create` | lib/db/seed.ts:9, lib/db/seed.ts:24 | catalog |
| `prices.create` | lib/db/seed.ts:14, lib/db/seed.ts:29 | catalog |
| `checkout.sessions.create` | lib/payments/stripe.ts:27 | needs-human |
| `billingPortal.configurations.list` | lib/payments/stripe.ts:55 | needs-human |
| `products.retrieve` | lib/payments/stripe.ts:60 | catalog |
| `prices.list` | lib/payments/stripe.ts:65, lib/payments/stripe.ts:150 | catalog |
| `billingPortal.configurations.create` | lib/payments/stripe.ts:73 | needs-human |
| `billingPortal.sessions.create` | lib/payments/stripe.ts:110 | needs-human |
| `products.list` | lib/payments/stripe.ts:168 | catalog |

### Blockers

- **SUBSCRIPTIONS_ONLY**: Only subscription billing found. Portage migrates one-time Checkout payments; subscriptions are on its roadmap. (lib/payments/stripe.ts:27, app/api/stripe/checkout/route.ts:36, lib/payments/stripe.ts:55, lib/payments/stripe.ts:73, lib/payments/stripe.ts:110)

_Scanned 55 files, parsed 12. The scan only reads files; it never changes the repository, and it never reads real env files._
