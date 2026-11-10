Source: https://github.com/vercel/nextjs-subscription-payments at commit `bdd0813206e47e6b218d42f15a7976c8a0d3c3eb`. A popular Next.js SaaS starter. Its checkout (a server action) sells subscriptions and one-time prices, so Portage plans PayPal for the one-time payments and leaves subscriptions on Stripe.

# Portage plan: add PayPal to nextjs-subscription-payments

**Mode:** add PayPal alongside Stripe · **App:** nextjs-subscription-payments (Next.js 14.2.3 (App Router)) · **Status:** ready for approval

3 new routes · 6 new files · 5 changed files · 5 new settings · 7 items to review · 0 blockers

## Steps

1. **Add the PayPal packages** (`package.json`)
   - Server: `@paypal/paypal-server-sdk` (the APIMatic-generated PayPal Server SDK).
   - Browser: `@paypal/react-paypal-js` for the PayPal buttons.
   - ContextMatic first: fetch_api `language=typescript, key=paypal`
2. **Document the PayPal settings in .env.example** (`.env.example`)
   - Add `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENVIRONMENT`, `PAYPAL_WEBHOOK_ID`, `NEXT_PUBLIC_PAYPAL_CLIENT_ID` with placeholder values only. Real values go in the developer's own env file, which is never committed.
   - `STRIPE_SECRET_KEY` → `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENVIRONMENT`: PAYPAL_ENVIRONMENT=sandbox. Real values go in .env, never in the repo.
   - `STRIPE_WEBHOOK_SECRET` → `PAYPAL_WEBHOOK_ID`: PayPal webhooks are verified by webhook ID through the verification API, not with a shared secret.
3. **Create the PayPal client and the money helper** (`utils/stripe/paypal.ts`, `utils/stripe/paypal-money.ts`)
   - `utils/stripe/paypal.ts`: one shared SDK client (client credentials from the environment, sandbox unless PAYPAL_ENVIRONMENT says otherwise) with the Orders and Payments controllers, next to `utils/stripe/config.ts`.
   - `utils/stripe/paypal-money.ts`: converts the app's integer minor units to PayPal's decimal strings and back (2400 → "24.00"; JPY stays whole). It refuses amounts PayPal can't represent instead of rounding (HUF and TWD take no decimals on PayPal). Portage's own tested helper is the reference.
   - Also a small helper for the webhook verification call, which is a REST call: the Server SDK has no webhook methods (confirmed through ContextMatic).
   - ContextMatic first: ask `How do I configure the PayPal Server SDK client with client credentials for the sandbox environment?`; model_search `Money`
4. **Record which provider paid, and the PayPal IDs, on `CheckoutResponse`** (`utils/stripe/server.ts`)
   - `CheckoutResponse` (utils/stripe/server.ts:18): add `paymentProvider` ("stripe" | "paypal"), `paypalOrderId`, `paypalCaptureId`. Keep `sessionId`: orders paid with Stripe still need them.
   - Initialise the new fields where records are created (`createClient`, `createOrRetrieveCustomer`).
   - Refunds look up the PayPal capture ID here, the way Stripe refunds use the payment intent ID.
5. **Pull the Stripe webhook's fulfilment code into one shared function** (`app/api/webhooks/route.ts`)
   - The `checkout.session.completed` branch (app/api/webhooks/route.ts:67) fulfils inline (`manageSubscriptionStatusChange`). Move it into `fulfilPayment`, called by both the Stripe webhook and the PayPal code, so the two can never drift apart.
   - Make each function idempotent and keep behaviour for Stripe payments exactly as it is.
6. **Add `POST /api/paypal/orders`** (`app/api/paypal/orders/route.ts`)
   - Mirror the Stripe checkout (`server action checkoutWithStripe`, utils/stripe/server.ts:89): same input validation, same app record (`createClient`, `createOrRetrieveCustomer`), then `ordersController.createOrder` instead of `checkout.sessions.create`.
   - Read each price on the server exactly as the Stripe route does (from Stripe), never from the browser.
   - intent `CAPTURE`; items with `quantity` as a string; `amount.breakdown.itemTotal` equal to the sum of the items, and `amount.value` equal to that (PayPal rejects the order otherwise). Amounts go through the money helper.
   - `customId` ← the app's own order ID, so the webhook can find the record.
   - `shippingPreference` `NO_SHIPPING` (the Stripe session doesn't collect an address).
   - Send `paypalRequestId` (PayPal-Request-Id) so a retried request can't create a second order.
   - Store the PayPal order ID the way the Stripe route stores the session ID (`object(…, { sessionId: session.id })` → `paypalOrderId`).
   - Return the PayPal order ID as JSON; the buttons need it.
   - ContextMatic first: endpoint_search `createOrder`; model_search `OrderRequest`; model_search `PurchaseUnitRequest`; model_search `ItemRequest`; model_search `AmountWithBreakdown`; model_search `PaypalWalletExperienceContext`
7. **Add `POST /api/paypal/orders/[orderId]/capture`** (`app/api/paypal/orders/[orderId]/capture/route.ts`)
   - Capture with `ordersController.captureOrder`, sending a PayPal-Request-Id.
   - Only treat it as paid when the order status is `COMPLETED` and the capture status is `COMPLETED`; check the captured amount and currency against the app's own record.
   - Then fulfil with the new shared fulfilment function (fulfilPayment), recording `paymentProvider: "paypal"`, the PayPal order ID and the capture ID (`purchaseUnits[0].payments.captures[0].id`).
   - Send the browser to the same success page Stripe uses (`getURL(redirectPath)`). It has no PayPal equivalent for `{CHECKOUT_SESSION_ID}`, so pass the app's own order ID.
   - ContextMatic first: endpoint_search `captureOrder`; model_search `Order`
8. **Add `POST /api/paypal/webhook`** (`app/api/paypal/webhook/route.ts`)
   - Verify every event with `POST /v1/notifications/verify-webhook-signature` (PAYPAL_WEBHOOK_ID plus the PAYPAL-TRANSMISSION-ID, -TIME, -SIG, PAYPAL-CERT-URL and PAYPAL-AUTH-ALGO headers) and answer 400 when it fails, like the Stripe handler does for a bad signature.
   - `BILLING.SUBSCRIPTION.ACTIVATED` (was `customer.subscription.created`): call `manageSubscriptionStatusChange` (needs a decision).
   - `BILLING.SUBSCRIPTION.UPDATED` (was `customer.subscription.updated`): call `manageSubscriptionStatusChange` (needs a decision).
   - `BILLING.SUBSCRIPTION.CANCELLED` (was `customer.subscription.deleted`): call `manageSubscriptionStatusChange` (needs a decision).
   - `PAYMENT.CAPTURE.COMPLETED` (was `checkout.session.completed`): call `fulfilPayment`.
   - Find the app's record by `custom_id`, or by the stored PayPal order or capture ID. Make every branch idempotent: PayPal retries deliveries.
   - Register the webhook URL in the PayPal developer dashboard (or through the PayPal API) for these event types; its ID is PAYPAL_WEBHOOK_ID.
   - ContextMatic first: ask `Does the PayPal Server SDK include a method to verify webhook signatures?`
9. **Show PayPal buttons next to the existing checkout** (`components/ui/Pricing/PayPalButtons.tsx`, `components/ui/Pricing/Pricing.tsx`)
   - components/ui/Pricing/Pricing.tsx:57 starts checkout (`server action checkoutWithStripe`): `const { errorRedirect, sessionId } = await checkoutWithStripe(`
   - Create `components/ui/Pricing/PayPalButtons.tsx`, a client component using `@paypal/react-paypal-js` (`PayPalScriptProvider`, `PayPalButtons`) that calls `POST /api/paypal/orders` in `createOrder` and `POST /api/paypal/orders/{id}/capture` in `onApprove`.
   - Keep the existing Stripe button exactly as it is.
   - onCancel returns to the page the buyer was on, like Stripe's cancel_url.
10. **Prove it with a real PayPal sandbox payment**
   - Typecheck and build the app.
   - Run verify_checkout: buy something with the PayPal sandbox buyer, check the order is marked paid by the capture route and by the webhook, then refund it and check the order shows the refund.
   - Run the app's existing Stripe checkout once more to confirm it still works.

## Files

| Change | File | Why |
|---|---|---|
| create | `utils/stripe/paypal.ts` | PayPal Server SDK client |
| create | `utils/stripe/paypal-money.ts` | Minor units ↔ PayPal decimal strings |
| create | `app/api/paypal/orders/route.ts` | POST /api/paypal/orders |
| create | `app/api/paypal/orders/[orderId]/capture/route.ts` | POST /api/paypal/orders/[orderId]/capture |
| create | `app/api/paypal/webhook/route.ts` | POST /api/paypal/webhook |
| create | `components/ui/Pricing/PayPalButtons.tsx` | PayPal buttons (client component) |
| change | `package.json` | PayPal dependencies |
| change | `.env.example` | PayPal settings (placeholders only) |
| change | `utils/stripe/server.ts` | Add PayPal fields to CheckoutResponse |
| change | `app/api/webhooks/route.ts` | Extract shared webhook logic |
| change | `components/ui/Pricing/Pricing.tsx` | Add PayPal buttons next to the Stripe checkout |

## New routes

| Route | File | Purpose |
|---|---|---|
| `POST /api/paypal/orders` | `app/api/paypal/orders/route.ts` | Create a PayPal order from the same trusted prices the Stripe checkout uses |
| `POST /api/paypal/orders/[orderId]/capture` | `app/api/paypal/orders/[orderId]/capture/route.ts` | Capture the approved order and fulfil it with the app's existing code |
| `POST /api/paypal/webhook` | `app/api/paypal/webhook/route.ts` | Receive PayPal webhooks, verify them, and update orders (captures, refunds) |

## Webhook events

| Stripe | PayPal | Reuses | Notes |
|---|---|---|---|
| `product.created` | none | `upsertProductRecord` | Stripe-specific event with no PayPal counterpart in Portage's map; it stays on the Stripe webhook. |
| `product.updated` | none | `upsertProductRecord` | Stripe-specific event with no PayPal counterpart in Portage's map; it stays on the Stripe webhook. |
| `price.created` | none | `upsertPriceRecord` | Stripe-specific event with no PayPal counterpart in Portage's map; it stays on the Stripe webhook. |
| `price.updated` | none | `upsertPriceRecord` | Stripe-specific event with no PayPal counterpart in Portage's map; it stays on the Stripe webhook. |
| `price.deleted` | none | `deletePriceRecord` | Stripe-specific event with no PayPal counterpart in Portage's map; it stays on the Stripe webhook. |
| `product.deleted` | none | `deleteProductRecord` | Stripe-specific event with no PayPal counterpart in Portage's map; it stays on the Stripe webhook. |
| `customer.subscription.created` | `BILLING.SUBSCRIPTION.ACTIVATED` | `manageSubscriptionStatusChange` | Subscriptions are a stretch goal. |
| `customer.subscription.updated` | `BILLING.SUBSCRIPTION.UPDATED` | `manageSubscriptionStatusChange` | Subscriptions are a stretch goal. |
| `customer.subscription.deleted` | `BILLING.SUBSCRIPTION.CANCELLED` | `manageSubscriptionStatusChange` | Subscriptions are a stretch goal. |
| `checkout.session.completed` | `PAYMENT.CAPTURE.COMPLETED` | `fulfilPayment` | Call the same fulfilment code the Stripe handler calls. With server-side capture the capture route already knows the result, so fulfil there too and keep fulfilment idempotent: the webhook can arrive first, second or twice. |

## Order records

- `CheckoutResponse` (utils/stripe/server.ts:18): add `paymentProvider`, `paypalOrderId`, `paypalCaptureId`. Keep `sessionId`: orders paid with Stripe still need them.

## Settings

- `PAYPAL_CLIENT_ID`: From the PayPal developer dashboard (sandbox app)
- `PAYPAL_CLIENT_SECRET`: Server only. Never sent to the browser or committed
- `PAYPAL_ENVIRONMENT`: sandbox or live
- `PAYPAL_WEBHOOK_ID`: ID of the webhook registered for this app; used to verify webhooks
- `NEXT_PUBLIC_PAYPAL_CLIENT_ID`: Same client ID, exposed to the browser for the buttons (it is public)

**Catalog:** Not needed: Stripe stays the source of prices, and one-time PayPal orders carry their own item names and amounts.

## Needs a person

- **SUBSCRIPTIONS_STAY**: Also sells subscriptions. Portage adds PayPal to one-time payments only and leaves subscriptions on Stripe. (utils/stripe/server.ts:89, utils/stripe/server.ts:153, utils/supabase/admin.ts:228)
- **PARAM_NEEDS_HUMAN**: Checkout sets `allow_promotion_codes`. PayPal: amount.breakdown.discount. PayPal has no promotion-code box. The app must apply codes itself. (utils/stripe/server.ts:89)
- **PARAM_NEEDS_HUMAN**: Checkout sets `subscription_data`. PayPal: PayPal Subscriptions. (utils/stripe/server.ts:89)
- **CALL_NEEDS_HUMAN**: `customers.create`: No customer object in Orders v2. The payer's name and email come back on capture. (utils/supabase/admin.ts:108)
- **CALL_NEEDS_HUMAN**: `customers.retrieve`: No customer object in Orders v2. The payer's name and email come back on capture. (utils/supabase/admin.ts:136)
- **CALL_NEEDS_HUMAN**: `customers.list`: No customer object in Orders v2. The payer's name and email come back on capture. (utils/supabase/admin.ts:142)
- **CALL_NEEDS_HUMAN**: `customers.update`: No customer object in Orders v2. The payer's name and email come back on capture. (utils/supabase/admin.ts:200)

## Stays as it is

- Stripe Checkout at `server action checkoutWithStripe` (utils/stripe/server.ts:89)
- Stripe webhook at `POST /api/webhooks` (app/api/webhooks/route.ts:33)

## Notes

- **CURRENCY_AT_RUNTIME**: The currency comes from the Stripe price at run time; the money helper checks it on every order.

## ContextMatic lookups to make while editing

- fetch_api `language=typescript, key=paypal`: Confirm the PayPal Server SDK and its key before writing any SDK code
- ask `How do I configure the PayPal Server SDK client with client credentials for the sandbox environment?`: Client setup
- model_search `Money`: Exact shape of currencyCode and value
- endpoint_search `createOrder`: Exact createOrder signature (body, paypalRequestId)
- model_search `OrderRequest`: intent, purchaseUnits
- model_search `PurchaseUnitRequest`: amount, items, customId
- model_search `ItemRequest`: name, unitAmount, quantity as string
- model_search `AmountWithBreakdown`: value must equal the item total
- model_search `PaypalWalletExperienceContext`: shippingPreference, returnUrl, cancelUrl
- endpoint_search `captureOrder`: Exact captureOrder signature and response
- model_search `Order`: status, purchaseUnits[].payments.captures[]
- ask `Does the PayPal Server SDK include a method to verify webhook signatures?`: Already answered: no. Use the REST verification call

Nothing has been changed yet. Approve this plan to continue.
