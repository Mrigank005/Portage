# Run: add PayPal to Quill (add mode)

**Date:** 2026-11-11 · **App:** [`suite/quill-saas`](../../../suite/quill-saas) (Express 5, server-rendered HTML, no build step), copied outside the repo · **Stripe side:** Standin, the local Stripe-compatible server, not real Stripe · **PayPal side:** the real PayPal sandbox

The second tuning run, on an app shaped differently from Brewbox: Express instead of Next.js, HTML strings instead of React, and a checkout form the buyer has to fill in (an email for the credits).

## What the agent did

1. `plan_migration` on the copy: 11 steps, 3 new routes, 3 new files, 4 changed files, nothing needing a person.
2. Followed the plan in order, starting from Portage's reference code (`paypal-client`, `paypal-money`, `paypal-webhook`, `paypal-buttons-browser`). The full change: [changes.diff](changes.diff) (9 files, +604/−23, lockfile left out).
   - `src/db.ts`: `paymentProvider`, `paypalOrderId`, `paypalCaptureId` on `Purchase`; lookups by PayPal order and capture.
   - `src/server.ts`: the Stripe webhook's inline logic moved into `fulfilPayment` and `recordPaymentRefund`, now shared with PayPal; `POST /paypal/orders`, `POST /paypal/orders/:orderId/capture`, `POST /webhooks/paypal` (raw body, verified with PayPal before anything else); PayPal refunds in the admin route (a partial amount must be whole cents, for both providers); PayPal JS SDK v6 buttons inside each pack's form, sending that form's fields.
3. `tsc`: clean on the first try.
4. `setup_webhook_relay`, then `verify_checkout`.

## What `verify_checkout` found

| Step | Result |
|---|---|
| Fill the pack's email field (`fill`), PayPal button (JS SDK v6), popup, US sandbox buyer approves $9.00 | pass |
| PayPal shows capture `5U2946948L952602P` COMPLETED; the account page shows "100 credits available" | pass |
| PayPal's real `PAYMENT.CAPTURE.COMPLETED` webhook through the relay, verified by Quill with PayPal | pass (HTTP 200) |
| A forged copy of that event | rejected (HTTP 400) |
| Full refund through PayPal; the real `PAYMENT.CAPTURE.REFUNDED` webhook; the purchase shows "refunded" | pass (HTTP 200) |
| PayPal shows the capture REFUNDED | pass |

14 of 14 steps, 69 seconds ([report card](verify/result.json), [screenshots](verify/)). Afterwards Quill's own records showed the purchase refunded through PayPal, $9.00 refunded and the 100 credits taken back, and Stripe checkout still redirected to Standin's checkout page.

## What the run taught Portage

| Finding | Fix |
|---|---|
| Quill's PayPal button needs the email field filled, or the create-order route (correctly) refuses | `verify_checkout` takes `fill` (CSS selector → value) and fills the form before clicking. |
| The plan's first step named PayPal's old JS SDK v5 script while the buttons step used v6 | The map now names the v6 core script, so the two steps agree. |
| PayPal's login page sometimes reports its hidden Log In button as visible | The browser step follows the Next button while it shows and only then logs in. |

## ContextMatic lookups in this run

The SDK calls Quill makes (`createOrder`, `captureOrder`, `refundCapturedPayment`) and the models it builds or reads (`OrderRequest`, `PurchaseUnitRequest`, `ItemRequest`, `AmountWithBreakdown`, `PaypalWalletExperienceContext`, `Money`, `Order`, `SellerPayableBreakdown`, `RefundRequest`) were all confirmed by earlier lookups ([#2–#17](../../../docs/contextmatic-lookups.md)); the reference code they come from is typechecked against the SDK. `verify_checkout` itself reads the capture through `PaymentCollection.captures` and `getCapturedPayment` (lookups #19 and #20).
