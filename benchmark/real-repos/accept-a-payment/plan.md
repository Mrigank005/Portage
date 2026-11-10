Source: https://github.com/stripe-samples/accept-a-payment at commit `1a57c3b2f5aaf4ecd8de59ab0b1c3c5638827625`. Stripe's sample with several apps in one repository: prebuilt Checkout and custom card forms, in many languages.

# Portage plan: add PayPal to stripe-sample-accept-a-payment-prebuilt-checkout-page-nextjs

**Mode:** add PayPal alongside Stripe · **App:** prebuilt-checkout-page/server/nextjs (Next.js 16.2.11 (App Router)) · **Status:** ready for approval

3 new routes · 7 new files · 3 changed files · 5 new settings · 2 items to review · 0 blockers

## Steps

1. **Add the PayPal packages** (`prebuilt-checkout-page/server/nextjs/package.json`)
   - Server: `@paypal/paypal-server-sdk` (the APIMatic-generated PayPal Server SDK).
   - Browser: `@paypal/react-paypal-js` for the PayPal buttons.
   - ContextMatic first: fetch_api `language=typescript, key=paypal`
2. **Document the PayPal settings in .env.local.example** (`prebuilt-checkout-page/server/nextjs/.env.local.example`)
   - Add `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENVIRONMENT`, `PAYPAL_WEBHOOK_ID`, `NEXT_PUBLIC_PAYPAL_CLIENT_ID` with placeholder values only. Real values go in the developer's own env file, which is never committed.
   - `STRIPE_SECRET_KEY` → `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENVIRONMENT`: PAYPAL_ENVIRONMENT=sandbox. Real values go in .env, never in the repo.
   - `STRIPE_WEBHOOK_SECRET` → `PAYPAL_WEBHOOK_ID`: PayPal webhooks are verified by webhook ID through the verification API, not with a shared secret.
3. **Create the PayPal client and the money helper** (`prebuilt-checkout-page/server/nextjs/lib/paypal.ts`, `prebuilt-checkout-page/server/nextjs/lib/paypal-money.ts`)
   - `prebuilt-checkout-page/server/nextjs/lib/paypal.ts`: one shared SDK client (client credentials from the environment, sandbox unless PAYPAL_ENVIRONMENT says otherwise) with the Orders and Payments controllers, next to `prebuilt-checkout-page/server/nextjs/lib/stripe.ts`.
   - `prebuilt-checkout-page/server/nextjs/lib/paypal-money.ts`: converts the app's integer minor units to PayPal's decimal strings and back (2400 → "24.00"; JPY stays whole). It refuses amounts PayPal can't represent instead of rounding (HUF and TWD take no decimals on PayPal). Portage's own tested helper is the reference.
   - Start from Portage's reference code: get_reference_code `paypal-client`, get_reference_code `paypal-money`
   - ContextMatic first: ask `How do I configure the PayPal Server SDK client with client credentials for the sandbox environment?`; model_search `Money`
4. **Add `POST /api/paypal/orders`** (`prebuilt-checkout-page/server/nextjs/app/api/paypal/orders/route.ts`)
   - Mirror the Stripe checkout (`POST /api/create-checkout-session`, prebuilt-checkout-page/server/nextjs/app/api/create-checkout-session/route.ts:8): same input validation, same app record (the app's order record), then `ordersController.createOrder` instead of `checkout.sessions.create`.
   - Read each price on the server exactly as the Stripe route does (from Stripe), never from the browser.
   - intent `CAPTURE`; items with `quantity` as a string; `amount.breakdown.itemTotal` equal to the sum of the items, and `amount.value` equal to that (PayPal rejects the order otherwise). Amounts go through the money helper.
   - `customId` ← the app's own order ID, so the webhook can find the record.
   - Set `paymentSource.paypal.experienceContext.returnUrl` and `cancelUrl` to the same pages as the Stripe session's success and cancel URLs (`${domainURL}/success?session_id={CHECKOUT_SESSION_ID}`, `${domainURL}/canceled`), with the app's order ID in place of `{CHECKOUT_SESSION_ID}`. They are required whenever an experience context is sent: without them PayPal shows "Things don't appear to be working at the moment" after the buyer logs in.
   - `shippingPreference` `NO_SHIPPING` (the Stripe session doesn't collect an address).
   - Send `paypalRequestId` (PayPal-Request-Id) so a retried request can't create a second order.
   - Store the PayPal order ID on the app's record.
   - Answer `{ orderId }` as JSON: the buttons call this route to start the payment. For a bad request answer 400 with `{ error }`, a message the buyer can read.
   - ContextMatic first: endpoint_search `createOrder`; model_search `OrderRequest`; model_search `PurchaseUnitRequest`; model_search `ItemRequest`; model_search `AmountWithBreakdown`; model_search `PaypalWalletExperienceContext`
5. **Add `POST /api/paypal/orders/[orderId]/capture`** (`prebuilt-checkout-page/server/nextjs/app/api/paypal/orders/[orderId]/capture/route.ts`)
   - Capture with `ordersController.captureOrder`, sending a PayPal-Request-Id.
   - Only treat it as paid when the order status is `COMPLETED` and the capture status is `COMPLETED`; check the captured amount and currency against the app's own record.
   - Then fulfil with the app's fulfilment code, recording `paymentProvider: "paypal"`, the PayPal order ID and the capture ID (`purchaseUnits[0].payments.captures[0].id`).
   - Send the browser to the same success page Stripe uses (`${domainURL}/success?session_id={CHECKOUT_SESSION_ID}`). It has no PayPal equivalent for `{CHECKOUT_SESSION_ID}`, so pass the app's own order ID.
   - Answer `{ redirectUrl }` (the buttons go there), or a 4xx/5xx with `{ error }` that the buttons show. Log failures with PayPal's debug_id.
   - ContextMatic first: endpoint_search `captureOrder`; model_search `Order`
6. **Add `POST /api/paypal/webhook`** (`prebuilt-checkout-page/server/nextjs/lib/paypal-webhook.ts`, `prebuilt-checkout-page/server/nextjs/app/api/paypal/webhook/route.ts`)
   - Verify every event with `verifyPayPalWebhook(headers, rawBody)` from the `paypal-webhook` reference before anything else (it calls `POST /v1/notifications/verify-webhook-signature` with PAYPAL_WEBHOOK_ID and the five PAYPAL-* transmission headers), and answer 400 when it fails, like the Stripe handler does for a bad signature.
   - Read the body with `await request.text()`: PayPal checks the signature over the exact bytes it sent.
   - `PAYMENT.CAPTURE.COMPLETED` (was `checkout.session.completed`): update the app's record.
   - Find the app's record by `custom_id`, or by the stored PayPal order or capture ID. Make every branch idempotent: PayPal retries deliveries.
   - Register the webhook URL in the PayPal developer dashboard (or through the PayPal API) for these event types; its ID is PAYPAL_WEBHOOK_ID.
   - Start from Portage's reference code: get_reference_code `paypal-webhook`
   - ContextMatic first: ask `Does the PayPal Server SDK include a method to verify webhook signatures?`
7. **Show PayPal buttons next to the existing checkout** (`prebuilt-checkout-page/server/nextjs/app/PayPalButtons.tsx`, `prebuilt-checkout-page/server/nextjs/app/CheckoutButton.tsx`)
   - prebuilt-checkout-page/server/nextjs/app/CheckoutButton.tsx:13 starts checkout (`POST /api/create-checkout-session`): `form.action = "/api/create-checkout-session";`
   - Create `prebuilt-checkout-page/server/nextjs/app/PayPalButtons.tsx` from the `PayPalButtons` reference (PayPal JS SDK v6 through `@paypal/react-paypal-js/sdk-v6`). Wrap the page section once in `PayPalCheckoutProvider` with the public client ID (from `NEXT_PUBLIC_PAYPAL_CLIENT_ID`, since the page is a client component), and put `PayPalCheckoutButton` beside the existing button with `createOrderUrl="/api/paypal/orders"`, `captureOrderUrl="/api/paypal/orders/{orderId}/capture"` and the existing form's id as `formId` (give the form an id if it has none).
   - Keep the existing Stripe button exactly as it is.
   - Cancelling leaves the buyer on the same page, like Stripe's cancel_url.
   - PayPal opens a popup: if the app sends a `Cross-Origin-Opener-Policy` header (Helmet sends `same-origin` by default), use `same-origin-allow-popups` on pages with PayPal buttons, as PayPal's v6 samples do.
   - Start from Portage's reference code: get_reference_code `PayPalButtons`
8. **Prove it with a real PayPal sandbox payment**
   - Typecheck and build the app.
   - Run verify_checkout: buy something with the PayPal sandbox buyer, check the order is marked paid by the capture route and by the webhook, then refund it and check the order shows the refund.
   - Run the app's existing Stripe checkout once more to confirm it still works.

## Files

| Change | File | Why |
|---|---|---|
| create | `prebuilt-checkout-page/server/nextjs/lib/paypal.ts` | PayPal Server SDK client |
| create | `prebuilt-checkout-page/server/nextjs/lib/paypal-money.ts` | Minor units ↔ PayPal decimal strings |
| create | `prebuilt-checkout-page/server/nextjs/app/api/paypal/orders/route.ts` | POST /api/paypal/orders |
| create | `prebuilt-checkout-page/server/nextjs/app/api/paypal/orders/[orderId]/capture/route.ts` | POST /api/paypal/orders/[orderId]/capture |
| create | `prebuilt-checkout-page/server/nextjs/lib/paypal-webhook.ts` | PayPal webhook verification (a REST call: the SDK has no webhook methods) |
| create | `prebuilt-checkout-page/server/nextjs/app/api/paypal/webhook/route.ts` | POST /api/paypal/webhook |
| create | `prebuilt-checkout-page/server/nextjs/app/PayPalButtons.tsx` | PayPal buttons (client component) |
| change | `prebuilt-checkout-page/server/nextjs/package.json` | PayPal dependencies |
| change | `prebuilt-checkout-page/server/nextjs/.env.local.example` | PayPal settings (placeholders only) |
| change | `prebuilt-checkout-page/server/nextjs/app/CheckoutButton.tsx` | Add PayPal buttons next to the Stripe checkout |

## New routes

| Route | File | Purpose |
|---|---|---|
| `POST /api/paypal/orders` | `prebuilt-checkout-page/server/nextjs/app/api/paypal/orders/route.ts` | Create a PayPal order from the same trusted prices the Stripe checkout uses |
| `POST /api/paypal/orders/[orderId]/capture` | `prebuilt-checkout-page/server/nextjs/app/api/paypal/orders/[orderId]/capture/route.ts` | Capture the approved order and fulfil it with the app's existing code |
| `POST /api/paypal/webhook` | `prebuilt-checkout-page/server/nextjs/app/api/paypal/webhook/route.ts` | Receive PayPal webhooks, verify them, and update orders (captures, refunds) |

## Webhook events

| Stripe | PayPal | Reuses | Notes |
|---|---|---|---|
| `checkout.session.completed` | `PAYMENT.CAPTURE.COMPLETED` | - | Call the same fulfilment code the Stripe handler calls. With server-side capture the capture route already knows the result, so fulfil there too and keep fulfilment idempotent: the webhook can arrive first, second or twice. |

## Settings

- `PAYPAL_CLIENT_ID`: From the PayPal developer dashboard (sandbox app)
- `PAYPAL_CLIENT_SECRET`: Server only. Never sent to the browser or committed
- `PAYPAL_ENVIRONMENT`: sandbox or live
- `PAYPAL_WEBHOOK_ID`: ID of the webhook registered for this app; used to verify webhooks
- `NEXT_PUBLIC_PAYPAL_CLIENT_ID`: Same client ID, for buttons in client components (it is public)

**Catalog:** Not needed: Stripe stays the source of prices, and one-time PayPal orders carry their own item names and amounts.

## Needs a person

- **NO_ORDER_RECORD**: Couldn't find where the app stores Stripe IDs on its own records. Decide where the PayPal order and capture IDs live before refunds can work.
- **FULFILMENT_UNKNOWN**: Couldn't find what the app does when a Stripe payment succeeds. Point Portage at the fulfilment code before the capture route is written.

## Stays as it is

- Stripe Checkout at `POST /api/create-checkout-session` (prebuilt-checkout-page/server/nextjs/app/api/create-checkout-session/route.ts:8)
- Stripe webhook at `POST /api/webhook` (prebuilt-checkout-page/server/nextjs/app/api/webhook/route.ts:14)
- The Stripe catalog as the source of prices

## Notes

- **OTHER_APPS**: This repository has 3 apps Portage can migrate. This plan is for prebuilt-checkout-page/server/nextjs; to plan another, pass its folder as `app` (`elements-with-checkout-sessions/server/node`, `prebuilt-checkout-page/server/node`).
- **OTHER_LANGUAGES**: Stripe is also used from Java or Kotlin and C# and Go and PHP and Python and Ruby. Portage only changes the Node.js apps and leaves that code alone. (custom-payment-flow/client/android-kotlin/app/src/main/java/com/example/app/AfterpayClearpayActivity.kt:7, custom-payment-flow/client/android-kotlin/app/src/main/java/com/example/app/AfterpayClearpayActivity.kt:8, custom-payment-flow/client/android-kotlin/app/src/main/java/com/example/app/AfterpayClearpayActivity.kt:9, custom-payment-flow/client/android-kotlin/app/src/main/java/com/example/app/AfterpayClearpayActivity.kt:10, custom-payment-flow/client/android-kotlin/app/src/main/java/com/example/app/AfterpayClearpayActivity.kt:11)
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
