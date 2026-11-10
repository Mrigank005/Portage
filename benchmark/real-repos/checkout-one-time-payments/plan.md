Source: https://github.com/stripe-samples/checkout-one-time-payments at commit `c834ba3ae155bd77a6aeb5879b58edd6a944af00`. Stripe's own sample for one-time Checkout payments: an Express server with plain HTML, next to servers in six other languages.

# Portage plan: add PayPal to stripe-sample-checkout-one-time-payments-nextjs

**Mode:** add PayPal alongside Stripe · **App:** server/nextjs (Next.js 16.1.5 (App Router)) · **Status:** ready for approval

3 new routes · 6 new files · 3 changed files · 5 new settings · 2 items to review · 0 blockers

## Steps

1. **Add the PayPal packages** (`server/nextjs/package.json`)
   - Server: `@paypal/paypal-server-sdk` (the APIMatic-generated PayPal Server SDK).
   - Browser: `@paypal/react-paypal-js` for the PayPal buttons.
   - ContextMatic first: fetch_api `language=typescript, key=paypal`
2. **Document the PayPal settings in .env.local.example** (`server/nextjs/.env.local.example`)
   - Add `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENVIRONMENT`, `PAYPAL_WEBHOOK_ID`, `NEXT_PUBLIC_PAYPAL_CLIENT_ID` with placeholder values only. Real values go in the developer's own env file, which is never committed.
   - `STRIPE_SECRET_KEY` → `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENVIRONMENT`: PAYPAL_ENVIRONMENT=sandbox. Real values go in .env, never in the repo.
   - `STRIPE_WEBHOOK_SECRET` → `PAYPAL_WEBHOOK_ID`: PayPal webhooks are verified by webhook ID through the verification API, not with a shared secret.
3. **Create the PayPal client and the money helper** (`server/nextjs/lib/paypal.ts`, `server/nextjs/lib/paypal-money.ts`)
   - `server/nextjs/lib/paypal.ts`: one shared SDK client (client credentials from the environment, sandbox unless PAYPAL_ENVIRONMENT says otherwise) with the Orders and Payments controllers, next to `server/nextjs/lib/stripe.ts`.
   - `server/nextjs/lib/paypal-money.ts`: converts the app's integer minor units to PayPal's decimal strings and back (2400 → "24.00"; JPY stays whole). It refuses amounts PayPal can't represent instead of rounding (HUF and TWD take no decimals on PayPal). Portage's own tested helper is the reference.
   - Also a small helper for the webhook verification call, which is a REST call: the Server SDK has no webhook methods (confirmed through ContextMatic).
   - ContextMatic first: ask `How do I configure the PayPal Server SDK client with client credentials for the sandbox environment?`; model_search `Money`
4. **Add `POST /api/paypal/orders`** (`server/nextjs/app/api/paypal/orders/route.ts`)
   - Mirror the Stripe checkout (`POST /api/create-checkout-session`, server/nextjs/app/api/create-checkout-session/route.ts:11): same input validation, same app record (the app's order record), then `ordersController.createOrder` instead of `checkout.sessions.create`.
   - Read each price on the server exactly as the Stripe route does (from Stripe), never from the browser.
   - intent `CAPTURE`; items with `quantity` as a string; `amount.breakdown.itemTotal` equal to the sum of the items, and `amount.value` equal to that (PayPal rejects the order otherwise). Amounts go through the money helper.
   - `customId` ← the app's own order ID, so the webhook can find the record.
   - `shippingPreference` `NO_SHIPPING` (the Stripe session doesn't collect an address).
   - Send `paypalRequestId` (PayPal-Request-Id) so a retried request can't create a second order.
   - Store the PayPal order ID on the app's record.
   - Return the PayPal order ID as JSON; the buttons need it.
   - ContextMatic first: endpoint_search `createOrder`; model_search `OrderRequest`; model_search `PurchaseUnitRequest`; model_search `ItemRequest`; model_search `AmountWithBreakdown`; model_search `PaypalWalletExperienceContext`
5. **Add `POST /api/paypal/orders/[orderId]/capture`** (`server/nextjs/app/api/paypal/orders/[orderId]/capture/route.ts`)
   - Capture with `ordersController.captureOrder`, sending a PayPal-Request-Id.
   - Only treat it as paid when the order status is `COMPLETED` and the capture status is `COMPLETED`; check the captured amount and currency against the app's own record.
   - Then fulfil with the app's fulfilment code, recording `paymentProvider: "paypal"`, the PayPal order ID and the capture ID (`purchaseUnits[0].payments.captures[0].id`).
   - Send the browser to the same success page Stripe uses (`${domainURL}/success?session_id={CHECKOUT_SESSION_ID}`). It has no PayPal equivalent for `{CHECKOUT_SESSION_ID}`, so pass the app's own order ID.
   - ContextMatic first: endpoint_search `captureOrder`; model_search `Order`
6. **Add `POST /api/paypal/webhook`** (`server/nextjs/app/api/paypal/webhook/route.ts`)
   - Verify every event with `POST /v1/notifications/verify-webhook-signature` (PAYPAL_WEBHOOK_ID plus the PAYPAL-TRANSMISSION-ID, -TIME, -SIG, PAYPAL-CERT-URL and PAYPAL-AUTH-ALGO headers) and answer 400 when it fails, like the Stripe handler does for a bad signature.
   - `PAYMENT.CAPTURE.COMPLETED` (was `checkout.session.completed`): update the app's record.
   - Find the app's record by `custom_id`, or by the stored PayPal order or capture ID. Make every branch idempotent: PayPal retries deliveries.
   - Register the webhook URL in the PayPal developer dashboard (or through the PayPal API) for these event types; its ID is PAYPAL_WEBHOOK_ID.
   - ContextMatic first: ask `Does the PayPal Server SDK include a method to verify webhook signatures?`
7. **Show PayPal buttons next to the existing checkout** (`server/nextjs/app/PayPalButtons.tsx`, `server/nextjs/app/page.tsx`)
   - server/nextjs/app/page.tsx:42 starts checkout (`POST /api/create-checkout-session`): `<form action="/api/create-checkout-session" method="POST">`
   - Create `server/nextjs/app/PayPalButtons.tsx`, a client component using `@paypal/react-paypal-js` (`PayPalScriptProvider`, `PayPalButtons`) that calls `POST /api/paypal/orders` in `createOrder` and `POST /api/paypal/orders/{id}/capture` in `onApprove`.
   - Keep the existing Stripe button exactly as it is.
   - onCancel returns to the page the buyer was on, like Stripe's cancel_url.
8. **Prove it with a real PayPal sandbox payment**
   - Typecheck and build the app.
   - Run verify_checkout: buy something with the PayPal sandbox buyer, check the order is marked paid by the capture route and by the webhook, then refund it and check the order shows the refund.
   - Run the app's existing Stripe checkout once more to confirm it still works.

## Files

| Change | File | Why |
|---|---|---|
| create | `server/nextjs/lib/paypal.ts` | PayPal Server SDK client |
| create | `server/nextjs/lib/paypal-money.ts` | Minor units ↔ PayPal decimal strings |
| create | `server/nextjs/app/api/paypal/orders/route.ts` | POST /api/paypal/orders |
| create | `server/nextjs/app/api/paypal/orders/[orderId]/capture/route.ts` | POST /api/paypal/orders/[orderId]/capture |
| create | `server/nextjs/app/api/paypal/webhook/route.ts` | POST /api/paypal/webhook |
| create | `server/nextjs/app/PayPalButtons.tsx` | PayPal buttons (client component) |
| change | `server/nextjs/package.json` | PayPal dependencies |
| change | `server/nextjs/.env.local.example` | PayPal settings (placeholders only) |
| change | `server/nextjs/app/page.tsx` | Add PayPal buttons next to the Stripe checkout |

## New routes

| Route | File | Purpose |
|---|---|---|
| `POST /api/paypal/orders` | `server/nextjs/app/api/paypal/orders/route.ts` | Create a PayPal order from the same trusted prices the Stripe checkout uses |
| `POST /api/paypal/orders/[orderId]/capture` | `server/nextjs/app/api/paypal/orders/[orderId]/capture/route.ts` | Capture the approved order and fulfil it with the app's existing code |
| `POST /api/paypal/webhook` | `server/nextjs/app/api/paypal/webhook/route.ts` | Receive PayPal webhooks, verify them, and update orders (captures, refunds) |

## Webhook events

| Stripe | PayPal | Reuses | Notes |
|---|---|---|---|
| `checkout.session.completed` | `PAYMENT.CAPTURE.COMPLETED` | - | Call the same fulfilment code the Stripe handler calls. With server-side capture the capture route already knows the result, so fulfil there too and keep fulfilment idempotent: the webhook can arrive first, second or twice. |

## Settings

- `PAYPAL_CLIENT_ID`: From the PayPal developer dashboard (sandbox app)
- `PAYPAL_CLIENT_SECRET`: Server only. Never sent to the browser or committed
- `PAYPAL_ENVIRONMENT`: sandbox or live
- `PAYPAL_WEBHOOK_ID`: ID of the webhook registered for this app; used to verify webhooks
- `NEXT_PUBLIC_PAYPAL_CLIENT_ID`: Same client ID, exposed to the browser for the buttons (it is public)

**Catalog:** Not needed: Stripe stays the source of prices, and one-time PayPal orders carry their own item names and amounts.

## Needs a person

- **NO_ORDER_RECORD**: Couldn't find where the app stores Stripe IDs on its own records. Decide where the PayPal order and capture IDs live before refunds can work.
- **FULFILMENT_UNKNOWN**: Couldn't find what the app does when a Stripe payment succeeds. Point Portage at the fulfilment code before the capture route is written.

## Stays as it is

- Stripe Checkout at `POST /api/create-checkout-session` (server/nextjs/app/api/create-checkout-session/route.ts:11)
- Stripe webhook at `POST /api/webhook` (server/nextjs/app/api/webhook/route.ts:13)
- The Stripe catalog as the source of prices

## Notes

- **OTHER_APPS**: This repository has 2 apps Portage can migrate. This plan is for server/nextjs; to plan another, pass its folder as `app` (`server/node`).
- **OTHER_LANGUAGES**: Stripe is also used from C# and Go and Java or Kotlin and PHP and Python and Ruby. Portage only changes the Node.js apps and leaves that code alone. (server/dotnet/Program.cs:2, server/dotnet/Program.cs:3, server/dotnet/Program.cs:63, server/dotnet/Program.cs:85, server/dotnet/Program.cs:96)
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
