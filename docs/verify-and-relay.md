# Proving it: `verify_checkout` and the webhook relay

A migration is finished when a real PayPal sandbox payment goes through the app, PayPal's webhooks reach it, and a refund comes back. Portage checks all of that itself instead of trusting that the code looks right.

## The webhook relay

PayPal only delivers webhooks to a public HTTPS URL, and the app under test runs on the developer's laptop. [`apps/webhook-relay`](../apps/webhook-relay) sits in between. It's deployed on Render from [`render.yaml`](../render.yaml) at **https://portage-relay.onrender.com**.

1. `setup_webhook_relay` (or `npx portage relay setup <app>`) picks a long random channel, registers `https://portage-relay.onrender.com/hooks/<channel>` as a webhook in the developer's **own** PayPal sandbox app for the five capture events in Portage's map, and writes `PAYPAL_WEBHOOK_ID`, `PORTAGE_RELAY_URL` and `PORTAGE_RELAY_CHANNEL` to the app's env file. Re-runs reuse the channel and the webhook.
2. PayPal posts events to the relay, which keeps each body byte for byte, with PayPal's signature headers.
3. On the developer's machine, Portage long-polls the channel and posts each event to the app's webhook route exactly as PayPal sent it. The app verifies the signature with PayPal, as it would in production. (`verify_checkout` does this while it runs; `npx portage relay forward <app> --to <url>` does it during development.)

The relay never verifies, changes or acts on events, and holds no credentials. Channels are 24 random characters, so one tester can't read another's events. Events are sandbox data, kept in memory for at most a day.

## `verify_checkout`

The agent starts the app, then calls `verify_checkout` with its URL, the page with the PayPal button, the webhook route and the text the app shows once an order is paid and once it's refunded. It drives the installed Chrome or Edge (through `playwright-core`, so there's no browser download):

| Step | How it's checked |
|---|---|
| App is running | The checkout page answers |
| Webhook relay connected | The relay answers; forwarding starts after the newest event already there |
| Checkout form filled | Optional `fill`: CSS selector → value, for forms the order needs (Quill's email) |
| PayPal button is on the page | JS SDK v6 `<paypal-button>`, or the v5 button iframe |
| PayPal checkout opens | A popup or a redirect with an order ID, which PayPal confirms belongs to the app's credentials |
| Sandbox buyer approves | Logs in as the sandbox buyer and approves. PayPal's known messages ("doesn't accept payments in your currency", "Things don't appear to be working") come back with their fix |
| App captures the payment | **Asked of PayPal, not the app**: `getOrder` must show a capture |
| App shows the order as paid | The page the buyer lands on shows the paid text |
| `PAYMENT.CAPTURE.COMPLETED` webhook | PayPal's real event reaches the app through the relay, and the app answers 2xx after verifying it |
| Refund through PayPal | A full refund with `refundCapturedPayment`, as a merchant would make from the PayPal dashboard |
| `PAYMENT.CAPTURE.REFUNDED` webhook | Forwarded; the app answers 2xx; the page shows the refunded text |
| PayPal shows the capture refunded | `getCapturedPayment` returns REFUNDED |
| Forged webhook is rejected | A copy of a real event with a changed event ID, sent with PayPal's original signature, must get a 4xx |

The result is a report card (PASS, FAIL, WARN or SKIP for each step, with a reason that says what to fix), PayPal's order, capture and refund IDs, and screenshots plus `result.json` under `.portage/` in the app folder. The playbook has the agent fix the first failing step and run it again.

**WARN** is for PayPal's sandbox, not the app. In one Brewbox run PayPal never generated `PAYMENT.CAPTURE.COMPLETED`: its own webhook events API listed only the refund event. `verify_checkout` now waits a minute, carries on with the refund, looks again at the end, and if the event still hasn't come it asks PayPal's events API and reports a warning with what PayPal said. A capture route that records the payment itself, as Portage's plan requires, doesn't depend on that event.

Sandbox only. Credentials and the buyer login come from the app's env files and never appear in the output. Use a US sandbox buyer (`PAYPAL_SANDBOX_US_BUYER_EMAIL`/`_PASSWORD`, or `PAYPAL_SANDBOX_BUYER_*`).

From a terminal:

```bash
npx portage relay setup path/to/app
npx portage verify path/to/app --url http://localhost:3000 --webhook /api/webhooks/paypal \
  --paid-text "Payment received" --refunded-text "Order refunded"
```

(In Git Bash, set `MSYS_NO_PATHCONV=1`, or Git Bash rewrites `/api/...` into a Windows path. `verify_checkout` says so if it happens.)

## Results

- [Brewbox](../benchmark/runs/brewbox-add/README.md) (Next.js, React buttons): 13 of 13 steps.
- [Quill](../benchmark/runs/quill-add/README.md) (Express, server-rendered buttons, a form to fill): 14 of 14 steps.
- [A headless Claude Code agent on a fresh clone](../benchmark/runs/quill-agent-run/README.md): one pasted prompt, no help, 14 of 14 steps on the first `verify_checkout`. Its first attempt stopped before editing anything because ContextMatic wasn't signed in, which is the playbook's rule working.

All used real PayPal sandbox payments, real PayPal webhooks through the relay, and Standin in place of Stripe.

## Confirming with PayPal's own tools

If PayPal's MCP server (the PayPal Agent Toolkit) is connected to the agent, the playbook has it look up the same order and refund with `get_order` and `get_refund`, quote what PayPal returned, and check that the order's `custom_id` is the app's own order ID. It's optional and never blocks: if the toolkit isn't connected, or its token has expired, the agent says so in one line, because `verify_checkout` has already checked the same IDs with PayPal. `list_transactions` isn't used for this: PayPal's transaction search lags behind new payments, and in the Brewbox run it didn't yet list a capture that `get_order` already showed as refunded. [The Brewbox run](../benchmark/runs/brewbox-add/README.md) shows the lookups.
