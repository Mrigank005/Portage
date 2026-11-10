Source: https://github.com/vercel/next.js (examples/with-stripe-typescript) at commit `4d51724b7c1ce377bce7564e6a5237d2846d0867`. Vercel's official Next.js App Router example: hosted and embedded Checkout, Elements, and a webhook route.

# Portage scan: with-stripe-typescript

**Result: supported.** Portage can plan this migration.

Files by language: TypeScript 25 · JavaScript 1

## with-stripe-typescript

Next.js latest (App Router) · TypeScript · stripe 14.8.0 · **supported**

| What | Where | Details |
|---|---|---|
| Stripe client | lib/stripe.ts:5 | key from `STRIPE_SECRET_KEY`; API version 2023-10-16 |
| Checkout `server action createCheckoutSession` | app/actions/stripe.ts:21 | mode payment; inline price formatAmountForStripe( Number(data.get("customDonation") as string), CURRENCY, ); responds with client-secret |
| Webhook `POST /api/webhooks` | app/api/webhooks/route.ts:11 | verified with constructEvent; raw body via request.text(); secret `STRIPE_WEBHOOK_SECRET`; handles `checkout.session.completed`; `payment_intent.payment_failed`; `payment_intent.succeeded` |
| Checkout button | app/components/CheckoutForm.tsx:42 | `server action createCheckoutSession`: `const { client_secret, url } = await createCheckoutSession(data);` |
| Browser | app/components/CheckoutForm.tsx:73 | uses embedded Stripe Checkout |
| Browser | app/components/CheckoutForm.tsx:77 | uses embedded Stripe Checkout |
| Browser | app/components/ElementsForm.tsx:3 | loads Stripe.js |
| Browser | app/components/ElementsForm.tsx:97 | confirms a payment from a custom card form |
| Browser | app/components/ElementsForm.tsx:149 | renders a Stripe Elements card form |
| Browser | utils/get-stripejs.ts:4 | loads Stripe.js |
| Settings |  | `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` |

### Stripe calls (6)

| Call | Where | Portage |
|---|---|---|
| `checkout.sessions.create` | app/actions/stripe.ts:21 | mapped |
| `paymentIntents.create` | app/actions/stripe.ts:59 | needs-human |
| `webhooks.constructEvent` | app/api/webhooks/route.ts:11 | mapped |
| `checkout.sessions.retrieve` | app/donate-with-checkout/result/page.tsx:15, app/donate-with-embedded-checkout/result/page.tsx:15 | mapped |
| `paymentIntents.retrieve` | app/donate-with-elements/result/page.tsx:15 | mapped |

### Needs a person

- **ELEMENTS_STAY**: Also has a custom card form (Stripe Elements). Portage leaves it on Stripe. (app/components/ElementsForm.tsx:97, app/components/ElementsForm.tsx:149)
- **CALL_NEEDS_HUMAN**: `paymentIntents.create`: Orders v2 with PayPal card fields (custom card forms are out of Portage's scope). (app/actions/stripe.ts:59)

_Scanned 38 files, parsed 15. The scan only reads files; it never changes the repository, and it never reads real env files._
