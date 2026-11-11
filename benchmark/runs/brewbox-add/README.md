# Run: add PayPal to Brewbox (add mode)

The first end-to-end run of Portage's workflow on [Brewbox](../../../suite/brewbox-store), the suite's Next.js store, made while tuning Portage (Phase 3). The agent was Claude Code (Opus 5.5) following the [portage-migrate playbook](../../../plugin/skills/portage-migrate/SKILL.md), working on a copy of Brewbox outside the repository.

**Result: a real PayPal sandbox purchase, capture, partial refund and full refund work through the migrated app, and Stripe checkout still works.**

- [`changes.diff`](changes.diff): everything that changed (13 files, +633 / −15), against Brewbox as it is in the suite
- [`shop-with-paypal-buttons.png`](shop-with-paypal-buttons.png): the shop with PayPal buttons next to the existing Stripe "Buy now" buttons
- [`paypal-review.png`](paypal-review.png): PayPal's sandbox review page for a $24.00 order (Pay in 4 offered automatically)

## What the agent did

1. `portage plan` on the copy: 11 steps, 0 items for a person, 0 blockers.
2. Followed the steps in order, starting from Portage's reference code (`paypal-client`, `paypal-money`, `paypal-webhook`, `PayPalButtons`) and making the ContextMatic lookups each step lists (see below).
3. Changes, in Brewbox's own style:
   - `lib/paypal.ts`, `lib/paypal-money.ts`, `lib/paypal-webhook.ts`: the reference code, unchanged.
   - `lib/orders.ts`: `paymentProvider`, `paypalOrderId`, `paypalCaptureId` on `Order`; lookups by PayPal IDs.
   - `lib/fulfilment.ts`: `fulfillOrder` takes Stripe or PayPal payment details (Stripe callers unchanged); `recordOrderRefund` records a running refunded total for either provider.
   - `POST /api/paypal/orders`: mirrors `POST /api/checkout` (same validation, prices read from Stripe on the server, same order record), then creates the PayPal order with `customId` = Brewbox's order ID.
   - `POST /api/paypal/orders/[orderId]/capture`: captures, checks the captured amount against the order, then calls the same `fulfillOrder` the Stripe webhook calls.
   - `POST /api/webhooks/paypal`: verifies with PayPal, then handles `PAYMENT.CAPTURE.COMPLETED` and `PAYMENT.CAPTURE.REFUNDED` idempotently.
   - `POST /api/admin/refund`: PayPal orders refund through `refundCapturedPayment`; Stripe orders exactly as before.
   - `app/page.tsx` + `app/PayPalButtons.tsx`: PayPal JS SDK v6 buttons beside each "Buy now" form, sending the same form fields.
4. `tsc` and `next build`: clean on the first try.

## What was verified, and how

Against Standin (as Stripe) and the **real PayPal sandbox**:

| Check | Result |
|---|---|
| API checks: Stripe checkout unchanged, a real PayPal order created with the right amount, items, SKU and `custom_id`, bad input refused, capture before approval refused, forged webhook rejected | 13 of 13 |
| Browser: click "Pay with PayPal", log in as the sandbox buyer in PayPal's popup, approve; Brewbox captures and shows the order paid | passed 4 times (3 on the final code) |
| Refunds on each real payment: repeated capture charges nothing; a non-numeric amount is refused; $10 partial refund, then the rest; PayPal reports PARTIALLY_REFUNDED, then REFUNDED; over-refund refused with PayPal's reason | 12 of 12, every run |

### Then with `verify_checkout` and real webhooks (2026-11-11)

Once the webhook relay was live, `setup_webhook_relay` registered a webhook in the PayPal sandbox app and `verify_checkout` ran the whole thing on its own ([report card](verify/result.json), [screenshots](verify/)):

| Step | Result |
|---|---|
| PayPal button on the page (JS SDK v6), popup, US sandbox buyer approves $49.00 | pass |
| PayPal shows capture `8TH46033C4632815B` COMPLETED; Brewbox shows "Payment received" | pass |
| PayPal's real `PAYMENT.CAPTURE.COMPLETED` webhook, through the relay; Brewbox verified it with PayPal | pass (HTTP 200) |
| A forged copy of that event (changed event ID, PayPal's original signature) | rejected (HTTP 400) |
| Full refund through PayPal; the real `PAYMENT.CAPTURE.REFUNDED` webhook; Brewbox shows "Order refunded" | pass (HTTP 200) |
| PayPal shows the capture REFUNDED | pass |

**Confirmed with PayPal's own tools.** The agent then looked the same payment up through PayPal's MCP server (the PayPal Agent Toolkit), independently of Portage:

| Agent Toolkit call | PayPal returned |
|---|---|
| `get_order 6F891298T78998147` | COMPLETED, $49.00 "Pour-Over Starter Kit", `custom_id` `ord_cecf941e83` (Brewbox's own order ID); capture `8TH46033C4632815B` REFUNDED |
| `get_refund 10C37321L8263421K` | COMPLETED, $49.00, `total_refunded_amount` 49.00, linked to that capture |
| `list_transactions 8TH46033C4632815B` | not found yet: PayPal's transaction search lags behind new payments, so the playbook now uses `get_order` and `get_refund` and doesn't treat this as a failure |

13 of 13 steps, 89 seconds. Earlier attempts found three things, now fixed: PayPal's login page keeps a hidden, sized password field (the browser step now follows the Next button instead); Git Bash rewrites `/api/...` arguments into Windows paths (`verify_checkout` now says so); and in one run PayPal's sandbox never generated `PAYMENT.CAPTURE.COMPLETED` at all (its own events API listed only the refund event), so a missing webhook from PayPal is now reported as a warning with that evidence, not as an app failure.

## What the run taught Portage

Each of these was fixed in Portage itself, not just in this app:

| Finding | Fix |
|---|---|
| PayPal showed "Things don't appear to be working at the moment" after the buyer logged in | Orders that send an `experience_context` must also send `return_url` and `cancel_url` (PayPal's v6 samples always do). Added to the map, the plan's create-order step, and this run. |
| Refund events carry only that refund's amount, so a running total looked impossible | ContextMatic showed `Refund.sellerPayableBreakdown.totalRefundedAmount`, the running total. The map, plan and reference code now use it, so the refund route and the webhook record the same total without double counting. |
| Webhook payloads are snake_case (`currency_code`), SDK objects camelCase | The reference money helper accepts both. |
| The plan didn't name a file for the webhook helper | The plan now creates `paypal-webhook.ts` next to the PayPal client. |
| A server-component page doesn't need `NEXT_PUBLIC_PAYPAL_CLIENT_ID` | The scan records whether a checkout page is a client component; the plan only adds the public variable when it is. |
| Intermittent `ECONNRESET` / `fetch failed` to the PayPal sandbox | The reference client turns on the SDK's retries (including POST, which is safe because every POST sends a PayPal-Request-Id); the webhook verifier and catalog copy retry too. |
| PayPal's popup needs a permissive `Cross-Origin-Opener-Policy` | The plan's buttons step says so (Helmet's default breaks it). |
| The default sandbox buyer got "This seller doesn't accept payments in your currency" | A US sandbox buyer works. Documented for testers. |

## ContextMatic lookups in this run

`fetch_api paypal`; `endpoint_search createOrder`, `captureOrder`, `getOrder`, `refundCapturedPayment`, `getRefund`; `model_search PurchaseUnitRequest`, `ItemRequest`, `AmountBreakdown`, `PaypalWalletExperienceContext`, `PaypalWalletContextShippingPreference`, `CaptureStatus`, `PaymentSource`, `RefundRequest`, `SellerPayableBreakdown`, `Money`. Two `ask` calls (client setup) failed with a server error on 2026-11-11; the client setup came from the code samples `endpoint_search` returns. Full record: [docs/contextmatic-lookups.md](../../../docs/contextmatic-lookups.md).
