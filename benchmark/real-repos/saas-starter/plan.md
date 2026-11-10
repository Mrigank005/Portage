Source: https://github.com/nextjs/saas-starter at commit `6e33e58b1e553a41fe22e6b941a7229a002de361`. The Next.js SaaS starter (Drizzle, Postgres): subscriptions through Checkout and the customer portal.

# Portage plan: add PayPal to saas-starter

**Mode:** add PayPal alongside Stripe · **App:** saas-starter (Next.js 15.6.0 (App Router)) · **Status:** blocked

Blocked: Only subscription billing found. Portage migrates one-time Checkout payments; subscriptions are on its roadmap.

## Why Portage stopped

- **SUBSCRIPTIONS_ONLY**: Only subscription billing found. Portage migrates one-time Checkout payments; subscriptions are on its roadmap. (lib/payments/stripe.ts:27, app/api/stripe/checkout/route.ts:36, lib/payments/stripe.ts:55, lib/payments/stripe.ts:73, lib/payments/stripe.ts:110)

Nothing was changed.
