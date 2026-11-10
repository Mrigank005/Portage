Source: https://github.com/stripe-samples/accept-a-payment at commit `1a57c3b2f5aaf4ecd8de59ab0b1c3c5638827625`. Stripe's sample with several apps in one repository: prebuilt Checkout and custom card forms, in many languages.

# Portage scan: accept-a-payment

**Result: supported.** Portage can plan this migration.

Files by language: JavaScript 96 · TypeScript 49 · PHP 39 · Ruby 17 · Java or Kotlin 14 · C# 8 · Go 4 · Python 4

- **OTHER_LANGUAGES**: Stripe is also used from Java or Kotlin and C# and Go and PHP and Python and Ruby. Portage only changes the Node.js apps and leaves that code alone. (custom-payment-flow/client/android-kotlin/app/src/main/java/com/example/app/AfterpayClearpayActivity.kt:7, custom-payment-flow/client/android-kotlin/app/src/main/java/com/example/app/AfterpayClearpayActivity.kt:8, custom-payment-flow/client/android-kotlin/app/src/main/java/com/example/app/AfterpayClearpayActivity.kt:9, custom-payment-flow/client/android-kotlin/app/src/main/java/com/example/app/AfterpayClearpayActivity.kt:10, custom-payment-flow/client/android-kotlin/app/src/main/java/com/example/app/AfterpayClearpayActivity.kt:11)

## accept-a-payment (custom-payment-flow/client/react-cra)

Node.js with no recognised web framework · JavaScript · **not supported**

| What | Where | Details |
|---|---|---|
| Browser | custom-payment-flow/client/react-cra/src/ApplePay.jsx:59 | confirms a payment from a custom card form |
| Browser | custom-payment-flow/client/react-cra/src/Card.jsx:43 | confirms a payment from a custom card form |
| Browser | custom-payment-flow/client/react-cra/src/Card.jsx:88 | renders a Stripe Elements card form |
| Browser | custom-payment-flow/client/react-cra/src/Fpx.jsx:4 | loads Stripe.js |
| Browser | custom-payment-flow/client/react-cra/src/Fpx.jsx:23 | confirms a payment from a custom card form |
| Browser | custom-payment-flow/client/react-cra/src/Fpx.jsx:41 | renders a Stripe Elements card form |
| Browser | custom-payment-flow/client/react-cra/src/GooglePay.jsx:59 | confirms a payment from a custom card form |
| Browser | custom-payment-flow/client/react-cra/src/Ideal.jsx:4 | loads Stripe.js |
| Browser | custom-payment-flow/client/react-cra/src/Ideal.jsx:23 | confirms a payment from a custom card form |
| Browser | custom-payment-flow/client/react-cra/src/Ideal.jsx:41 | renders a Stripe Elements card form |
| Browser | custom-payment-flow/client/react-cra/src/SepaDebit.jsx:3 | loads Stripe.js |
| Browser | custom-payment-flow/client/react-cra/src/SepaDebit.jsx:22 | confirms a payment from a custom card form |
| Browser | custom-payment-flow/client/react-cra/src/SepaDebit.jsx:54 | renders a Stripe Elements card form |
| Browser | custom-payment-flow/client/react-cra/src/index.jsx:5 | loads Stripe.js |

### Blockers

- **FRAMEWORK_UNSUPPORTED**: Node.js with no recognised web framework isn't supported yet. Portage supports Next.js (App Router) and Express apps.
- **ELEMENTS_ONLY**: Payments go through a custom card form (Stripe Elements and PaymentIntents), not Stripe Checkout. Custom card forms are out of Portage's scope. (custom-payment-flow/client/react-cra/src/ApplePay.jsx:59, custom-payment-flow/client/react-cra/src/Card.jsx:43, custom-payment-flow/client/react-cra/src/Card.jsx:88, custom-payment-flow/client/react-cra/src/Fpx.jsx:23, custom-payment-flow/client/react-cra/src/Fpx.jsx:41, custom-payment-flow/client/react-cra/src/GooglePay.jsx:59)

## react-native-expo (custom-payment-flow/client/react-native-expo)

Node.js with no recognised web framework · JavaScript · **not supported**

### Blockers

- **FRAMEWORK_UNSUPPORTED**: Node.js with no recognised web framework isn't supported yet. Portage supports Next.js (App Router) and Express apps.
- **NO_ONE_TIME_CHECKOUT**: Found Stripe code, but no Checkout session in payment mode, which is what Portage migrates.

## stripe-sample-accept-a-payment-custom-payment-flow-nextjs (custom-payment-flow/server/nextjs)

Next.js 16.2.6 (App Router) · TypeScript · stripe 20.2.0 · **not supported**

| What | Where | Details |
|---|---|---|
| Stripe client | custom-payment-flow/server/nextjs/lib/stripe.ts:12 | key from `STRIPE_SECRET_KEY`; API version 2025-12-15.clover |
| Webhook `POST /api/webhook` | custom-payment-flow/server/nextjs/app/api/webhook/route.ts:16 | verified with constructEvent; raw body via request.text(); secret `STRIPE_WEBHOOK_SECRET`; handles `payment_intent.succeeded`; `payment_intent.payment_failed` |
| Browser | custom-payment-flow/server/nextjs/app/card/CardForm.tsx:57 | confirms a payment from a custom card form |
| Browser | custom-payment-flow/server/nextjs/app/card/CardForm.tsx:98 | renders a Stripe Elements card form |
| Browser | custom-payment-flow/server/nextjs/app/card/page.tsx:4 | loads Stripe.js |
| Browser | custom-payment-flow/server/nextjs/app/success/page.tsx:4 | loads Stripe.js |
| Settings |  | `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` |

### Stripe calls (5)

| Call | Where | Portage |
|---|---|---|
| `tax.calculations.create` | custom-payment-flow/server/nextjs/app/api/create-payment-intent/route.ts:11 | needs-human |
| `customers.create` | custom-payment-flow/server/nextjs/app/api/create-payment-intent/route.ts:96 | needs-human |
| `paymentIntents.create` | custom-payment-flow/server/nextjs/app/api/create-payment-intent/route.ts:111 | needs-human |
| `paymentIntents.retrieve` | custom-payment-flow/server/nextjs/app/api/payment/next/route.ts:16 | mapped |
| `webhooks.constructEvent` | custom-payment-flow/server/nextjs/app/api/webhook/route.ts:16 | mapped |

### Blockers

- **ELEMENTS_ONLY**: Payments go through a custom card form (Stripe Elements and PaymentIntents), not Stripe Checkout. Custom card forms are out of Portage's scope. (custom-payment-flow/server/nextjs/app/card/CardForm.tsx:57, custom-payment-flow/server/nextjs/app/card/CardForm.tsx:98, custom-payment-flow/server/nextjs/app/api/create-payment-intent/route.ts:111)

### Needs a person

- **CALL_NEEDS_HUMAN**: `tax.calculations.create`: No automatic tax. The app computes tax and sends it as amount.breakdown.tax_total. (custom-payment-flow/server/nextjs/app/api/create-payment-intent/route.ts:11)
- **CALL_NEEDS_HUMAN**: `customers.create`: No customer object in Orders v2. The payer's name and email come back on capture. (custom-payment-flow/server/nextjs/app/api/create-payment-intent/route.ts:96)
- **CALL_NEEDS_HUMAN**: `paymentIntents.create`: Orders v2 with PayPal card fields (custom card forms are out of Portage's scope). (custom-payment-flow/server/nextjs/app/api/create-payment-intent/route.ts:111)

## stripe-sample-accept-a-payment (custom-payment-flow/server/node)

Express 4.19.2 · JavaScript · stripe 20.2.0 · **not supported**

| What | Where | Details |
|---|---|---|
| Stripe client | custom-payment-flow/server/node/server.js:14 | key from `STRIPE_SECRET_KEY`; API version 2023-10-16 |
| Webhook `POST /webhook` | custom-payment-flow/server/node/server.js:195 | verified with constructEvent; raw body via req.rawBody; secret `STRIPE_WEBHOOK_SECRET`; handles `payment_intent.succeeded`; `payment_intent.payment_failed` |
| Settings |  | `STRIPE_PUBLISHABLE_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` |

### Stripe calls (5)

| Call | Where | Portage |
|---|---|---|
| `tax.calculations.create` | custom-payment-flow/server/node/server.js:54 | needs-human |
| `customers.create` | custom-payment-flow/server/node/server.js:135 | needs-human |
| `paymentIntents.create` | custom-payment-flow/server/node/server.js:151 | needs-human |
| `paymentIntents.retrieve` | custom-payment-flow/server/node/server.js:168 | mapped |
| `webhooks.constructEvent` | custom-payment-flow/server/node/server.js:195 | mapped |

### Blockers

- **ELEMENTS_ONLY**: Payments go through a custom card form (Stripe Elements and PaymentIntents), not Stripe Checkout. Custom card forms are out of Portage's scope. (custom-payment-flow/server/node/server.js:151)

### Needs a person

- **CALL_NEEDS_HUMAN**: `tax.calculations.create`: No automatic tax. The app computes tax and sends it as amount.breakdown.tax_total. (custom-payment-flow/server/node/server.js:54)
- **CALL_NEEDS_HUMAN**: `customers.create`: No customer object in Orders v2. The payer's name and email come back on capture. (custom-payment-flow/server/node/server.js:135)
- **CALL_NEEDS_HUMAN**: `paymentIntents.create`: Orders v2 with PayPal card fields (custom card forms are out of Portage's scope). (custom-payment-flow/server/node/server.js:151)

## stripe-sample-accept-a-payment (custom-payment-flow/server/node-typescript)

Express 4.21.0 · TypeScript · stripe 20.1.2 · **not supported**

| What | Where | Details |
|---|---|---|
| Stripe client | custom-payment-flow/server/node-typescript/src/server.ts:13 | key from `STRIPE_SECRET_KEY`; API version 2025-12-15.clover |
| Webhook `POST /webhook` | custom-payment-flow/server/node-typescript/src/server.ts:193 | verified with constructEvent; raw body via express.raw(); secret `STRIPE_WEBHOOK_SECRET`; handles `payment_intent.succeeded`; `payment_intent.payment_failed` |
| Settings |  | `STRIPE_PUBLISHABLE_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` |

### Stripe calls (5)

| Call | Where | Portage |
|---|---|---|
| `tax.calculations.create` | custom-payment-flow/server/node-typescript/src/server.ts:59 | needs-human |
| `customers.create` | custom-payment-flow/server/node-typescript/src/server.ts:134 | needs-human |
| `paymentIntents.create` | custom-payment-flow/server/node-typescript/src/server.ts:145 | needs-human |
| `paymentIntents.retrieve` | custom-payment-flow/server/node-typescript/src/server.ts:166 | mapped |
| `webhooks.constructEvent` | custom-payment-flow/server/node-typescript/src/server.ts:193 | mapped |

### Blockers

- **ELEMENTS_ONLY**: Payments go through a custom card form (Stripe Elements and PaymentIntents), not Stripe Checkout. Custom card forms are out of Portage's scope. (custom-payment-flow/server/node-typescript/src/server.ts:145)

### Needs a person

- **CALL_NEEDS_HUMAN**: `tax.calculations.create`: No automatic tax. The app computes tax and sends it as amount.breakdown.tax_total. (custom-payment-flow/server/node-typescript/src/server.ts:59)
- **CALL_NEEDS_HUMAN**: `customers.create`: No customer object in Orders v2. The payer's name and email come back on capture. (custom-payment-flow/server/node-typescript/src/server.ts:134)
- **CALL_NEEDS_HUMAN**: `paymentIntents.create`: Orders v2 with PayPal card fields (custom card forms are out of Portage's scope). (custom-payment-flow/server/node-typescript/src/server.ts:145)

## stripe-sample-elements-with-checkout-sessions-react (elements-with-checkout-sessions/client/react-cra)

Node.js with no recognised web framework · JavaScript · **not supported**

| What | Where | Details |
|---|---|---|
| Browser | elements-with-checkout-sessions/client/react-cra/src/App.jsx:2 | loads Stripe.js |
| Browser | elements-with-checkout-sessions/client/react-cra/src/CheckoutForm.jsx:117 | renders a Stripe Elements card form |

### Blockers

- **FRAMEWORK_UNSUPPORTED**: Node.js with no recognised web framework isn't supported yet. Portage supports Next.js (App Router) and Express apps.
- **ELEMENTS_ONLY**: Payments go through a custom card form (Stripe Elements and PaymentIntents), not Stripe Checkout. Custom card forms are out of Portage's scope. (elements-with-checkout-sessions/client/react-cra/src/CheckoutForm.jsx:117)

## stripe-sample-elements-with-checkout-sessions (elements-with-checkout-sessions/server/node)

Express 4.21.2 · JavaScript · stripe 22.0.2 · **supported**

| What | Where | Details |
|---|---|---|
| Stripe client | elements-with-checkout-sessions/server/node/server.js:18 | key from `STRIPE_SECRET_KEY` |
| Checkout `POST /create-checkout-session` | elements-with-checkout-sessions/server/node/server.js:39 | mode payment; inline price 2000 USD; responds with client-secret |
| Webhook `POST /webhook` | elements-with-checkout-sessions/server/node/server.js:101 | verified with constructEvent; raw body via req.rawBody; secret `STRIPE_WEBHOOK_SECRET`; handles `checkout.session.completed` |
| Settings |  | `STRIPE_PUBLISHABLE_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` |

### Stripe calls (3)

| Call | Where | Portage |
|---|---|---|
| `checkout.sessions.create` | elements-with-checkout-sessions/server/node/server.js:39 | mapped |
| `checkout.sessions.retrieve` | elements-with-checkout-sessions/server/node/server.js:75 | mapped |
| `webhooks.constructEvent` | elements-with-checkout-sessions/server/node/server.js:101 | mapped |

### Needs a person

- **CHECKOUT_CUSTOM_UI**: Checkout runs with `ui_mode` custom/elements: the payment form is built from Stripe Elements in the app's own UI. PayPal buttons sit beside that form; find the client code that renders it. (elements-with-checkout-sessions/server/node/server.js:39)

## react-cra (payment-element/client/react-cra)

Node.js with no recognised web framework · JavaScript · **not supported**

| What | Where | Details |
|---|---|---|
| Browser | payment-element/client/react-cra/src/App.jsx:8 | loads Stripe.js |
| Browser | payment-element/client/react-cra/src/CheckoutForm.jsx:25 | confirms a payment from a custom card form |
| Browser | payment-element/client/react-cra/src/CheckoutForm.jsx:58 | renders a Stripe Elements card form |

### Blockers

- **FRAMEWORK_UNSUPPORTED**: Node.js with no recognised web framework isn't supported yet. Portage supports Next.js (App Router) and Express apps.
- **ELEMENTS_ONLY**: Payments go through a custom card form (Stripe Elements and PaymentIntents), not Stripe Checkout. Custom card forms are out of Portage's scope. (payment-element/client/react-cra/src/CheckoutForm.jsx:25, payment-element/client/react-cra/src/CheckoutForm.jsx:58)

## stripe-sample-accept-a-payment-payment-element-nextjs (payment-element/server/nextjs)

Next.js 16.2.6 (App Router) · TypeScript · stripe 20.2.0 · **not supported**

| What | Where | Details |
|---|---|---|
| Stripe client | payment-element/server/nextjs/lib/stripe.ts:12 | key from `STRIPE_SECRET_KEY`; API version 2025-12-15.clover |
| Webhook `POST /api/webhook` | payment-element/server/nextjs/app/api/webhook/route.ts:14 | verified with constructEvent; raw body via request.text(); secret `STRIPE_WEBHOOK_SECRET`; handles `payment_intent.succeeded`; `payment_intent.payment_failed` |
| Browser | payment-element/server/nextjs/components/CheckoutForm.tsx:27 | confirms a payment from a custom card form |
| Browser | payment-element/server/nextjs/components/CheckoutForm.tsx:47 | renders a Stripe Elements card form |
| Browser | payment-element/server/nextjs/components/StripeProvider.tsx:4 | loads Stripe.js |
| Settings |  | `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` |

### Stripe calls (3)

| Call | Where | Portage |
|---|---|---|
| `paymentIntents.create` | payment-element/server/nextjs/app/api/create-payment-intent/route.ts:8 | needs-human |
| `webhooks.constructEvent` | payment-element/server/nextjs/app/api/webhook/route.ts:14 | mapped |
| `paymentIntents.retrieve` | payment-element/server/nextjs/app/success/page.tsx:26 | mapped |

### Blockers

- **ELEMENTS_ONLY**: Payments go through a custom card form (Stripe Elements and PaymentIntents), not Stripe Checkout. Custom card forms are out of Portage's scope. (payment-element/server/nextjs/components/CheckoutForm.tsx:27, payment-element/server/nextjs/components/CheckoutForm.tsx:47, payment-element/server/nextjs/app/api/create-payment-intent/route.ts:8)

### Needs a person

- **CALL_NEEDS_HUMAN**: `paymentIntents.create`: Orders v2 with PayPal card fields (custom card forms are out of Portage's scope). (payment-element/server/nextjs/app/api/create-payment-intent/route.ts:8)

## stripe-sample-accept-a-payment (payment-element/server/node)

Express 4.22.1 · JavaScript · stripe 20.2.0 · **not supported**

| What | Where | Details |
|---|---|---|
| Stripe client | payment-element/server/node/server.js:13 | key from `STRIPE_SECRET_KEY`; API version 2023-10-16 |
| Webhook `POST /webhook` | payment-element/server/node/server.js:125 | verified with constructEvent; raw body via req.rawBody; secret `STRIPE_WEBHOOK_SECRET`; handles `payment_intent.succeeded`; `payment_intent.payment_failed` |
| Settings |  | `STRIPE_PUBLISHABLE_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` |

### Stripe calls (4)

| Call | Where | Portage |
|---|---|---|
| `tax.calculations.create` | payment-element/server/node/server.js:47 | needs-human |
| `paymentIntents.create` | payment-element/server/node/server.js:85, payment-element/server/node/server.js:93 | needs-human |
| `webhooks.constructEvent` | payment-element/server/node/server.js:125 | mapped |

### Blockers

- **ELEMENTS_ONLY**: Payments go through a custom card form (Stripe Elements and PaymentIntents), not Stripe Checkout. Custom card forms are out of Portage's scope. (payment-element/server/node/server.js:85, payment-element/server/node/server.js:93)

### Needs a person

- **CALL_NEEDS_HUMAN**: `tax.calculations.create`: No automatic tax. The app computes tax and sends it as amount.breakdown.tax_total. (payment-element/server/node/server.js:47)
- **CALL_NEEDS_HUMAN**: `paymentIntents.create`: Orders v2 with PayPal card fields (custom card forms are out of Portage's scope). (payment-element/server/node/server.js:85, payment-element/server/node/server.js:93)

## stripe-sample-accept-a-payment (payment-element/server/node-typescript)

Express 4.21.0 · TypeScript · stripe 20.1.2 · **not supported**

| What | Where | Details |
|---|---|---|
| Stripe client | payment-element/server/node-typescript/src/server.ts:16 | key from `STRIPE_SECRET_KEY`; API version 2025-12-15.clover |
| Webhook `POST /webhook` | payment-element/server/node-typescript/src/server.ts:130 | verified with constructEvent; raw body via express.raw(); secret `STRIPE_WEBHOOK_SECRET`; handles `payment_intent.succeeded`; `payment_intent.payment_failed` |
| Settings |  | `STRIPE_PUBLISHABLE_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` |

### Stripe calls (4)

| Call | Where | Portage |
|---|---|---|
| `tax.calculations.create` | payment-element/server/node-typescript/src/server.ts:52 | needs-human |
| `paymentIntents.create` | payment-element/server/node-typescript/src/server.ts:87, payment-element/server/node-typescript/src/server.ts:95 | needs-human |
| `webhooks.constructEvent` | payment-element/server/node-typescript/src/server.ts:130 | mapped |

### Blockers

- **ELEMENTS_ONLY**: Payments go through a custom card form (Stripe Elements and PaymentIntents), not Stripe Checkout. Custom card forms are out of Portage's scope. (payment-element/server/node-typescript/src/server.ts:87, payment-element/server/node-typescript/src/server.ts:95)

### Needs a person

- **CALL_NEEDS_HUMAN**: `tax.calculations.create`: No automatic tax. The app computes tax and sends it as amount.breakdown.tax_total. (payment-element/server/node-typescript/src/server.ts:52)
- **CALL_NEEDS_HUMAN**: `paymentIntents.create`: Orders v2 with PayPal card fields (custom card forms are out of Portage's scope). (payment-element/server/node-typescript/src/server.ts:87, payment-element/server/node-typescript/src/server.ts:95)

## stripe-sample-accept-a-payment-prebuilt-checkout-page-nextjs (prebuilt-checkout-page/server/nextjs)

Next.js 16.2.11 (App Router) · TypeScript · stripe 20.2.0 · **supported**

| What | Where | Details |
|---|---|---|
| Stripe client | prebuilt-checkout-page/server/nextjs/lib/stripe.ts:12 | key from `STRIPE_SECRET_KEY`; API version 2025-12-15.clover |
| Checkout `POST /api/create-checkout-session` | prebuilt-checkout-page/server/nextjs/app/api/create-checkout-session/route.ts:8 | mode payment; price `process.env.PRICE`; success URL uses {CHECKOUT_SESSION_ID}; responds with redirect |
| Webhook `POST /api/webhook` | prebuilt-checkout-page/server/nextjs/app/api/webhook/route.ts:14 | verified with constructEvent; raw body via request.text(); secret `STRIPE_WEBHOOK_SECRET`; handles `checkout.session.completed` |
| Checkout button | prebuilt-checkout-page/server/nextjs/app/CheckoutButton.tsx:13 | `POST /api/create-checkout-session`: `form.action = "/api/create-checkout-session";` |
| Settings |  | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` |

### Stripe calls (5)

| Call | Where | Portage |
|---|---|---|
| `checkout.sessions.retrieve` | prebuilt-checkout-page/server/nextjs/app/api/checkout-session/route.ts:15, prebuilt-checkout-page/server/nextjs/app/success/page.tsx:26 | mapped |
| `checkout.sessions.create` | prebuilt-checkout-page/server/nextjs/app/api/create-checkout-session/route.ts:8 | mapped |
| `webhooks.constructEvent` | prebuilt-checkout-page/server/nextjs/app/api/webhook/route.ts:14 | mapped |
| `prices.retrieve` | prebuilt-checkout-page/server/nextjs/app/page.tsx:7 | catalog |

## accept-a-payment-checkout (prebuilt-checkout-page/server/node)

Express 4.21.0 · JavaScript · stripe 20.3.0 · **supported**

| What | Where | Details |
|---|---|---|
| Stripe client | prebuilt-checkout-page/server/node/server.js:15 | key from `STRIPE_SECRET_KEY`; API version 2023-10-16 |
| Checkout `POST /create-checkout-session` | prebuilt-checkout-page/server/node/server.js:56 | mode payment; price `process.env.PRICE`; success URL uses {CHECKOUT_SESSION_ID}; responds with redirect |
| Webhook `POST /webhook` | prebuilt-checkout-page/server/node/server.js:81 | verified with constructEvent; raw body via req.rawBody; secret `STRIPE_WEBHOOK_SECRET`; handles `checkout.session.completed` |
| Settings |  | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` |

### Stripe calls (3)

| Call | Where | Portage |
|---|---|---|
| `checkout.sessions.retrieve` | prebuilt-checkout-page/server/node/server.js:46 | mapped |
| `checkout.sessions.create` | prebuilt-checkout-page/server/node/server.js:56 | mapped |
| `webhooks.constructEvent` | prebuilt-checkout-page/server/node/server.js:81 | mapped |

_Scanned 719 files, parsed 108. The scan only reads files; it never changes the repository, and it never reads real env files._
