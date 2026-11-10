# ContextMatic lookups

A record of the lookups made through [ContextMatic](https://github.com/apimatic/context-matic) (the APIMatic Context Plugin) while building Portage, and what each one changed. Every PayPal Server SDK method and model that Portage's [Stripe→PayPal map](../packages/core/maps/stripe-paypal.json) names comes from these lookups. A test ([`map.test.ts`](../packages/core/test/map.test.ts)) fails if the map names a method or model that isn't on the confirmed list.

All lookups use `language=typescript` and `key=paypal`.

## 2026-11-10: building the Stripe→PayPal map (Phase 2)

| # | Tool | Query | What it confirmed | Where it went |
|---|---|---|---|---|
| 1 | `fetch_api` | `paypal` | The PayPal Server SDK covers Orders, Payments, US-only Vault, Transaction Search and Subscriptions. | Scope of `paypalSdk` in the map |
| 2 | `endpoint_search` | `createOrder` | `OrdersController.createOrder` takes `body: OrderRequest`, `paypalRequestId`, `prefer`; returns `Order`. | Checkout rule; plan step "create-order route" |
| 3 | `endpoint_search` | `captureOrder` | `OrdersController.captureOrder` takes `id`, `paypalRequestId`, optional `OrderCaptureRequest`; returns `Order`. | Checkout rule; plan step "capture route" |
| 4 | `endpoint_search` | `refundCapturedPayment` | `PaymentsController.refundCapturedPayment` takes `captureId`, `paypalRequestId` (kept 45 days), optional `RefundRequest`. An empty body is a full refund; an amount is a partial refund. The same search also returned `getCapturedPayment` and `captureAuthorizedPayment`. | `refunds.create`, `paymentIntents.retrieve`, `charges.retrieve`, manual-capture rules |
| 5 | `endpoint_search` | `getOrder` | `OrdersController.getOrder` takes `id` and optional `fields`; returns `Order`. The results also listed `authorizeOrder`. | `checkout.sessions.retrieve` and `listLineItems` rules |
| 6 | `endpoint_search` | `getRefund` | `PaymentsController.getRefund` takes `refundId`; returns `Refund`. | `refunds.retrieve` rule |
| 7 | `ask` | Does the SDK include a method to verify webhook signatures? | **No.** The SDK has no webhook methods at all. | `paypalSdk.notInSdk`: Portage plans a direct REST call to `POST /v1/notifications/verify-webhook-signature` instead of inventing an SDK method |
| 8 | `model_search` | `PurchaseUnitRequest` | `amount` (`AmountWithBreakdown`), `items` (`ItemRequest[]`), `customId` (for reconciliation, hidden from the payer), `invoiceId` (must be unique per merchant). | `client_reference_id` and `metadata` map to `customId`, not `invoiceId` |
| 9 | `model_search` | `ItemRequest` | `name`, `unitAmount` (`Money`), and `quantity` as a **string** of a whole number. | Line-item rule: quantity becomes a string |
| 10 | `model_search` | `AmountBreakdown` (and `AmountWithBreakdown`) | `itemTotal`, `taxTotal`, `shipping`, `discount`…; the total must equal item total plus tax, shipping and handling, minus discounts. `value` is an integer for currencies like JPY. | Plan rule that `amount.value` equals the item total; discount and tax rules |
| 11 | `model_search` | `PaypalWalletExperienceContext` | `returnUrl`, `cancelUrl`, `shippingPreference`, `locale`, `userAction`. | `success_url`, `cancel_url`, `locale` and `shipping_address_collection` rules (NO_SHIPPING unless the session collects an address) |
| 12 | `model_search` | `RefundRequest` | `amount` (`Money`), `customId`, `invoiceId`, `noteToPayer`. | Partial refunds send `amount` from the money helper |

Currency rules (which currencies PayPal accepts and which take no decimals) come from PayPal's own [currency codes page](https://developer.paypal.com/api/rest/reference/currency-codes/) and Stripe's [currencies page](https://docs.stripe.com/currencies), both read on 2026-11-10. They are not SDK facts, so they aren't ContextMatic lookups.

## Inside Portage

`plan_migration` turns the same rule into instructions for the agent doing the migration: each step of a plan lists the ContextMatic lookups to make before writing that step's code (for example `endpoint_search createOrder` and `model_search PurchaseUnitRequest` before the create-order route). The Portage skill requires them and asks for them to be logged in the pull request.
