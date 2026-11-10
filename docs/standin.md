# Standin: a local Stripe-compatible test server

*Status: working. Covered by 15 tests, and driven end to end by the suite check (`npm run suite:e2e`).*

## Why it exists

Portage adds PayPal to apps that already take payments through Stripe, so its test apps need a working Stripe backend. Stripe is currently invite-only in India, where Portage is built, so we couldn't open a Stripe account. Standin fills that gap: it implements the small part of the Stripe API our test apps use, on `localhost`.

It also means nobody else needs a Stripe account to try Portage, judges included.

Standin is **only** for Portage's test suite. On a real repo, Portage reads that project's code, and catalog migration calls real Stripe with the project's own keys.

## What it implements

| Area | Endpoints | Notes |
|---|---|---|
| Products | `POST/GET /v1/products`, `GET/POST /v1/products/:id` | `default_price_data`, metadata, `active`, `expand[]=data.default_price` |
| Prices | `POST/GET /v1/prices`, `GET /v1/prices/:id` | One-time and recurring price objects, `active`; `expand[]=product` |
| Checkout | `POST/GET /v1/checkout/sessions`, `GET /v1/checkout/sessions/:id`, `GET …/line_items`, `POST …/expire` | **Payment mode only.** Line items by active `price` (inactive prices are refused, as on Stripe) or inline `price_data`; `expand[]=line_items` and `payment_intent` |
| Test pay page | `GET/POST /pay/:session_id` | Stands in for checkout.stripe.com; takes Stripe's public test cards; redirects to `success_url` with `{CHECKOUT_SESSION_ID}` filled in |
| Payments | `GET /v1/payment_intents/:id`, `GET /v1/charges/:id` | Created when a session is paid; `expand[]=latest_charge` |
| Refunds | `POST/GET /v1/refunds`, `GET /v1/refunds/:id` | Full and partial, by `payment_intent` or `charge`; Stripe's over-refund and already-refunded errors |
| Events | `GET /v1/events`, `GET /v1/events/:id` | Filter by `type`; `pending_webhooks` counts down as endpoints accept the event |
| Webhook endpoints | `POST/GET /v1/webhook_endpoints` | Also declared in the config file, like a pre-configured dashboard |
| Helpers | `GET /` (health), `GET /_standin/deliveries` | Delivery log, used by tests |

Lists come newest first and page with `limit`, `starting_after` and `ending_before`. Everything else returns Stripe's own `Unrecognized request URL` 404, so a gap is loud instead of silent. Subscription mode, customers, invoices, Connect and the rest are not implemented.

## Events

For a payment, Standin emits these events in this order:

1. `charge.succeeded`
2. `payment_intent.succeeded`
3. `checkout.session.completed`

and `charge.refunded` for each refund, `checkout.session.expired` when a session expires. Each event goes to every webhook endpoint that enabled it. Deliveries run in parallel, so, as on Stripe, the order they *arrive* in is not guaranteed. Each delivery gets up to three attempts.

Each delivery carries a `Stripe-Signature` header in Stripe's documented scheme: `t=<unix seconds>,v1=<HMAC-SHA256 of "<t>.<raw body>" with the endpoint secret>`. The apps verify it with the official SDK's `stripe.webhooks.constructEvent`.

## Accounts and configuration

Like real Stripe, data belongs to an account, and the account is identified by the API key. Any `sk_test_…` key works and gets its own empty account on first use; live keys (`sk_live_…`) are rejected. `suite/standin.config.json` plays the role of the Stripe dashboard: for each key it declares the webhook endpoints and the catalog that already exist when the server starts.

| Setting | Default | Purpose |
|---|---|---|
| `--config` / `STANDIN_CONFIG` | none | Config file with accounts, webhook endpoints and seed products |
| `--port` / `STANDIN_PORT` | `4242` | Listening port |
| `--host` / `STANDIN_HOST` | localhost only | Address to listen on. By default Standin answers on `127.0.0.1` and `::1` only, so it isn't reachable from the network |
| `--state` / `STANDIN_STATE_FILE` | `.standin/state.json` | Where state is saved between restarts; `--no-persist` keeps it in memory |
| `STANDIN_WEBHOOK_SECRET` | `whsec_standin` | Secret Standin signs webhooks with |

## Test cards

| Number | Result |
|---|---|
| `4242 4242 4242 4242` | Succeeds (Visa) |
| `5555 5555 5555 4444` | Succeeds (Mastercard) |
| `4000 0566 5566 5556` | Succeeds (Visa debit) |
| `4000 0000 0000 0002` | Declined |
| `4000 0000 0000 9995` | Insufficient funds |
| `4000 0000 0000 0069` | Expired card |

The expiry date can be `MM / YY` or `MM / YYYY` and must not be in the past.

## How the test apps use it

The apps use the official `stripe` Node SDK, unmodified, configured with a custom host. This is the same pattern Stripe documents for stripe-mock:

```ts
const base = process.env.STRIPE_API_BASE ? new URL(process.env.STRIPE_API_BASE) : null;
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, base
  ? { host: base.hostname, port: Number(base.port), protocol: base.protocol.replace(":", "") as "http" | "https" }
  : {});
```

Remove `STRIPE_API_BASE` and the same code talks to real Stripe.

## How we keep it honest

- **Real response shapes.** The tests validate every object type Standin returns (product, price, checkout session, line item, payment intent, charge, refund, event, webhook endpoint) against Stripe's public OpenAPI specification, API version `2026-10-28.endive`. Because Stripe's schemas allow extra properties, the check also fails on any field the spec doesn't declare, so a made-up or retired field can't slip through.
- **The check is tested too.** A control test takes valid objects, breaks them (missing field, wrong type, wrong enum value, invented field, field Stripe has removed) and requires the check to reject each one.
- **Real signature checks.** The tests verify every webhook with the official SDK's `constructEvent`, and confirm it rejects a wrong secret and a stale timestamp.
- **Real SDK.** Tests and apps use the official `stripe` package (v23), not a hand-written client.
- **Plain labelling.** Portage's reports, the README and the website say that the suite runs on Standin, not live Stripe.
- **Real-world code too.** Portage's scan and plan steps also run on public open-source apps that use Stripe, and those results are published alongside the suite.

What Standin does *not* prove: that these apps behave identically on live Stripe. It proves they work against an implementation whose responses conform to Stripe's published API description.

## Running it

```bash
npm install
npm run standin          # Standin on http://localhost:4242, with the suite's config
npm test                 # Standin's tests (downloads Stripe's OpenAPI spec once into .cache/)
npm run suite:e2e        # starts Standin, Brewbox and Quill and drives real payments through them
```
