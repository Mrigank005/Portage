Source: https://github.com/vercel/nextjs-subscription-payments at commit `bdd0813206e47e6b218d42f15a7976c8a0d3c3eb`. A popular Next.js SaaS starter. Its checkout (a server action) sells subscriptions and one-time prices, so Portage plans PayPal for the one-time payments and leaves subscriptions on Stripe.

# Portage scan: nextjs-subscription-payments

**Result: supported.** Portage can plan this migration.

Files by language: TypeScript 54 · JavaScript 2

## nextjs-subscription-payments

Next.js 14.2.3 (App Router) · TypeScript · stripe 14.25.0 · **supported**

| What | Where | Details |
|---|---|---|
| Stripe client | utils/stripe/config.ts:3 | key from `STRIPE_SECRET_KEY_LIVE` |
| Checkout `server action checkoutWithStripe` | utils/stripe/server.ts:89 | mode subscription or payment; price `price.id`; session ID stored as `sessionId` |
| Webhook `POST /api/webhooks` | app/api/webhooks/route.ts:33 | verified with constructEvent; raw body via request.text(); handles `product.created` → upsertProductRecord (utils/supabase/admin.ts:20); `product.updated` → upsertProductRecord (utils/supabase/admin.ts:20); `price.created` → upsertPriceRecord (utils/supabase/admin.ts:38); `price.updated` → upsertPriceRecord (utils/supabase/admin.ts:38); `price.deleted` → deletePriceRecord (utils/supabase/admin.ts:86); `product.deleted` → deleteProductRecord (utils/supabase/admin.ts:76); `customer.subscription.created` → manageSubscriptionStatusChange (utils/supabase/admin.ts:211); `customer.subscription.updated` → manageSubscriptionStatusChange (utils/supabase/admin.ts:211); `customer.subscription.deleted` → manageSubscriptionStatusChange (utils/supabase/admin.ts:211); `checkout.session.completed` → manageSubscriptionStatusChange (utils/supabase/admin.ts:211) |
| Checkout button | components/ui/Pricing/Pricing.tsx:57 | `server action checkoutWithStripe`: `const { errorRedirect, sessionId } = await checkoutWithStripe(` |
| Browser | components/ui/Pricing/Pricing.tsx:79 | redirects to Checkout from the browser (Stripe.js) |
| Browser | utils/stripe/client.ts:1 | loads Stripe.js |
| Stored Stripe IDs | utils/stripe/server.ts:18 | CheckoutResponse: `sessionId` |
| Settings |  | `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY_LIVE`, `STRIPE_SECRET_KEY`, `STRIPE_SECRET_KEY_LIVE`, `STRIPE_WEBHOOK_SECRET` |

### Stripe calls (8)

| Call | Where | Portage |
|---|---|---|
| `webhooks.constructEvent` | app/api/webhooks/route.ts:33 | mapped |
| `checkout.sessions.create` | utils/stripe/server.ts:89 | mapped |
| `billingPortal.sessions.create` | utils/stripe/server.ts:153 | needs-human |
| `customers.create` | utils/supabase/admin.ts:108 | needs-human |
| `customers.retrieve` | utils/supabase/admin.ts:136 | needs-human |
| `customers.list` | utils/supabase/admin.ts:142 | needs-human |
| `customers.update` | utils/supabase/admin.ts:200 | needs-human |
| `subscriptions.retrieve` | utils/supabase/admin.ts:228 | needs-human |

### Needs a person

- **SUBSCRIPTIONS_STAY**: Also sells subscriptions. Portage adds PayPal to one-time payments only and leaves subscriptions on Stripe. (utils/stripe/server.ts:89, utils/stripe/server.ts:153, utils/supabase/admin.ts:228)
- **PARAM_NEEDS_HUMAN**: Checkout sets `allow_promotion_codes`. PayPal: amount.breakdown.discount. PayPal has no promotion-code box. The app must apply codes itself. (utils/stripe/server.ts:89)
- **PARAM_NEEDS_HUMAN**: Checkout sets `subscription_data`. PayPal: PayPal Subscriptions. (utils/stripe/server.ts:89)
- **CALL_NEEDS_HUMAN**: `customers.create`: No customer object in Orders v2. The payer's name and email come back on capture. (utils/supabase/admin.ts:108)
- **CALL_NEEDS_HUMAN**: `customers.retrieve`: No customer object in Orders v2. The payer's name and email come back on capture. (utils/supabase/admin.ts:136)
- **CALL_NEEDS_HUMAN**: `customers.list`: No customer object in Orders v2. The payer's name and email come back on capture. (utils/supabase/admin.ts:142)
- **CALL_NEEDS_HUMAN**: `customers.update`: No customer object in Orders v2. The payer's name and email come back on capture. (utils/supabase/admin.ts:200)

_Scanned 90 files, parsed 12. The scan only reads files; it never changes the repository, and it never reads real env files._
