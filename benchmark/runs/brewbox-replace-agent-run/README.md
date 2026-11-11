# Run: replace mode, Brewbox moves from Stripe to PayPal

**Date:** 2026-11-11 · **Agent:** Claude Code, headless (`claude -p`, permission prompts off), on the fresh clone used for [the Quill agent run](../quill-agent-run/README.md) · **App:** Brewbox (Next.js App Router), from `npx portage try brewbox --mode replace` · **Stripe side:** Standin · **PayPal side:** the real sandbox

Replace mode is the harder of Portage's two modes. New payments must go through PayPal only, the Stripe catalog stops being the source of prices, and orders already paid with Stripe must still be refundable. This run is the agent doing all of that from one pasted prompt, with no help.

## What the agent did

79 turns, 13 minutes, about $4 of model usage.

1. Followed the `portage-migrate` skill: scan, the replace-mode plan (12 steps, 1 item for a person), shown and then carried on, since this is a test app.
2. Made the plan's ContextMatic lookups, plus `getOrder` and `PaypalWalletResponse`, which it needed for the buyer's email on the webhook path.
3. **Copied the catalog:** `migrate_catalog` dry run (3 products, 3 one-time prices, all exact in USD), then for real. It created three PayPal sandbox catalog products and wrote [`portage.catalog.json`](portage.catalog.json), which the shop page and the create-order route now read instead of Stripe.
4. Wrote the integration ([changes.diff](changes.diff): 17 files, +834/−103, lockfile left out):
   - **Removed** `POST /api/checkout` and the Stripe "Buy now" button: the old route now answers 404.
   - **Added** the create-order, capture and PayPal webhook routes; PayPal JS SDK v6 buttons on each product.
   - **Kept** the Stripe client, the Stripe webhook and the Stripe branch of the refund route, so orders already paid with Stripe can still be refunded.
   - **Unprompted:** the relay also subscribes to `PAYMENT.CAPTURE.DENIED`, so the agent handled it too (a capture that starts PENDING and is later denied marks the order failed, instead of leaving it waiting).
5. Typechecked, built (`next build`), ran `setup_webhook_relay`, started the app, and probed it before testing: old Stripe checkout 404, unknown product 400, unsigned webhook 400.
6. `verify_checkout` **passed on its first run**: 13 of 13 steps in 88 seconds ([report card](verify/result.json), [screenshots](verify/)). That covered the PayPal button, the US sandbox buyer approving $49.00, the capture checked with PayPal, the real `PAYMENT.CAPTURE.COMPLETED` and `REFUNDED` webhooks verified by the app, the refund, and a forged webhook rejected with 400.

## Checks the agent added on its own

- **The app's own PayPal refund route:** a second sandbox payment ($24.00). Through `/api/admin/refund`, an invalid amount got 400, then a $10.00 partial refund left the order *partially refunded*, then the rest left it *refunded*.
- **An order already paid with Stripe:** it made an order the old way, paid it on Standin's test pay page, saw the Stripe webhook fulfil it, then refunded it through the app's refund route, which still sends Stripe orders to Stripe. (Standin, not live Stripe.)
- **PayPal's own toolkit:** skipped, and said so. PayPal's MCP server answered 401 because its sandbox token had expired, and `verify_checkout` had already checked the same IDs with PayPal. That is the playbook's "optional, never blocking" rule working.

## What it left for a person

- **Stripe history:** when no Stripe-paid orders are left, the Stripe client, webhook and refund branch can go. That's the plan's own "needs a person" item.
- **The admin refund route has no sign-in.** That was already true, but in live mode it could now move real PayPal money.
- **`PAYMENT.CAPTURE.PENDING` and `PAYMENT.CAPTURE.REVERSED` are acknowledged but not acted on.** REVERSED is a chargeback, and how to show one on an order is a business decision.

Each of these is a real judgement call, and the agent flagged it instead of guessing.
