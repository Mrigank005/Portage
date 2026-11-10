# Portage test suite

Small apps that take card payments through Stripe. Portage reads them, adds PayPal, and proves the result with a real PayPal sandbox payment. They run against [Standin](../docs/standin.md), a local Stripe-compatible server, so no Stripe account is needed.

| App | Stack | What's in it | Port |
|---|---|---|---|
| [`brewbox-store`](brewbox-store) | Next.js (App Router), TypeScript | Coffee shop. Catalog read from Stripe, Checkout with catalog prices, signed webhook, order table, receipt, admin refunds | 4300 |
| [`quill-saas`](quill-saas) | Express, TypeScript | Credit packs. Checkout with inline `price_data`, `listLineItems`, `express.raw` webhook, credits granted and clawed back on refund | 4301 |
| [`ledgerline-flask`](ledgerline-flask) | Flask, Python | Invoice payments. **Unsupported on purpose**: Portage must refuse it with a clear message | none |

The first two use the official `stripe` Node SDK. Each reads `STRIPE_API_BASE` (default `http://localhost:4242`) to find Standin; delete it to use real Stripe test keys instead. Both listen on `127.0.0.1` only. Their admin refund actions have no sign-in, which is fine for a local test app and not for anything else.

Ledgerline isn't started by the suite check. It is written against current stripe-python (16.x) and Flask; its webhook handler has been exercised with signed, forged and unrelated events.

## Try it by hand

```bash
npm install                     # from the repository root
npm run standin                 # terminal 1: Standin on :4242

cd suite/brewbox-store          # terminal 2
cp .env.example .env.local
npm run dev                     # http://localhost:4300
```

Buy something, pay with test card `4242 4242 4242 4242` on Standin's pay page, and watch the order turn paid on the order page. Refund it from `/admin/orders`.

## Check everything at once

```bash
npm run suite:e2e
```

Starts Standin, Brewbox and Quill, then drives a real payment through each (shop page, checkout, hosted test pay page, signed webhook, fulfilment, partial refund, full refund). It also checks that bad input is refused safely: a webhook with a bad signature, an unknown price, a refund amount that isn't a whole number of cents, and pack names that aren't real packs. Finally it checks that nothing is reachable from the network. 21 checks.
