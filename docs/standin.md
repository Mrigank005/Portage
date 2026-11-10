# Standin: a local Stripe-compatible test server

*Status: in development.*

## Why it exists

Portage adds PayPal to apps that already take payments through Stripe, so its test apps need a working Stripe backend. Stripe is currently invite-only in India, where Portage is built, so we can't open a Stripe account. Standin fills that gap: it implements the small part of the Stripe API our test apps use, on `localhost`.

It also means nobody else needs a Stripe account to try Portage, judges included.

Standin is **only** for Portage's test suite. On a real repo, Portage reads that project's code, and catalog migration calls real Stripe with the project's own keys.

## What it implements

| Area | Endpoints | Notes |
|---|---|---|
| Products and prices | `POST/GET /v1/products`, `GET /v1/products/:id`, `POST/GET /v1/prices`, `GET /v1/prices/:id` | Includes `default_price_data` on product creation |
| Checkout | `POST /v1/checkout/sessions`, `GET /v1/checkout/sessions/:id` | Mode `payment` only; returns a `url` to Standin's test checkout page |
| Test checkout page | `GET /pay/:session_id` | Takes Stripe's public test card `4242 4242 4242 4242`; completes the session and redirects to `success_url` |
| Payments | `GET /v1/payment_intents/:id` | Created when a session completes |
| Refunds | `POST /v1/refunds`, `GET /v1/refunds/:id` | Full and partial, by `payment_intent` |
| Webhooks | Delivered to each app's configured URL | `checkout.session.completed`, `charge.refunded`, signed with the `Stripe-Signature` scheme |

Everything else returns a Stripe-style `404` error, so a gap is loud instead of silent.

## How the test apps use it

The apps use the official `stripe` Node SDK, unmodified, configured with a custom host:

```ts
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  host: "localhost",
  port: 4242,
  protocol: "http",
});
```

`STRIPE_API_BASE` (default `http://localhost:4242`) controls this, and removing it points the same code at real Stripe.

## Keeping it honest

- **Real response shapes.** Standin's responses are checked against Stripe's public OpenAPI specification in its tests.
- **Real signature checks.** Webhooks are signed with HMAC-SHA256 over `timestamp.payload`, using `STRIPE_WEBHOOK_SECRET`, exactly as Stripe documents. The apps verify them with the SDK's own `stripe.webhooks.constructEvent`, so a wrong signature fails the same way it would against Stripe.
- **Plain labelling.** Portage's reports, the README and the project website say that the suite runs on Standin, not live Stripe.
- **Real-world code too.** Portage's scan and plan steps also run on public open-source apps that use Stripe, and those results are published alongside the suite.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `STRIPE_API_BASE` | `http://localhost:4242` | Where the apps and Portage send Stripe API calls |
| `STRIPE_SECRET_KEY` | `sk_test_standin` | Any `sk_test_` key is accepted; live keys are rejected |
| `STRIPE_WEBHOOK_SECRET` | `whsec_standin` | Secret Standin signs webhooks with |
