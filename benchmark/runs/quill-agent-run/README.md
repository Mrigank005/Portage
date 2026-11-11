# Run: a coding agent, a fresh clone and one pasted prompt

**Date:** 2026-11-11 · **Agent:** Claude Code, run headless (`claude -p`, permission prompts off, since nobody is there to click them) · **App:** Quill, from `suite/quill-saas` · **Stripe side:** Standin · **PayPal side:** the real sandbox

The two earlier runs ([Brewbox](../brewbox-add/README.md), [Quill](../quill-add/README.md)) were made by following Portage's playbook by hand while tuning it. This one is what a judge does: clone the repository into an empty folder, follow the README, paste the prompt, and let an agent do the rest. Nothing was fixed along the way.

## Setup, as the README says

1. `git clone`, `npm install` (49 seconds), `cp .env.example .env`, and fill in the PayPal sandbox keys and a sandbox buyer login.
2. `npx portage try quill`: checks Node, the PayPal keys, the buyer login, a browser and the relay; copies Quill into `trial/quill-saas` with its settings and a git baseline; installs its packages; prints the prompt (27 seconds).
3. Open the folder in Claude Code and paste the prompt.
4. Before the agent ran, the fresh clone's tests passed (Standin 15, core 58, MCP server 9, relay 5) and the suite end-to-end check passed 21 of 21.

## Run 1: the agent stopped, as it should

ContextMatic needs a one-time browser sign-in. A headless session can't do that, so `context-matic` was unavailable. The agent scanned and planned (both only read), then **stopped before editing anything** and said why, quoting the rule: *"If ContextMatic is unavailable, stop and say so."* It listed what would unblock it: authorise `context-matic` with `/mcp`. Cost: 7 turns, 33 seconds, no files changed.

That is the playbook's rule working: PayPal SDK code comes from ContextMatic lookups, never from memory, even when the agent could have written the parts that don't touch the SDK. A person at the keyboard signs in once; the README says how.

## Run 2: the same prompt with ContextMatic signed in

My own Claude Code was already signed in to ContextMatic. The repository's project config registers `context-matic` under a different identity that isn't signed in, so for this run only I removed that entry from the scratch clone's `.mcp.json`, and the agent used the signed-in one. Nothing else was changed. 64 turns, 7 minutes.

What the agent did, with no help:

- Followed the `portage-migrate` skill: scan, plan (shown, then carried on, since this is a test app), edits in the plan's order.
- Fetched Portage's reference code (`paypal-client`, `paypal-money`, `paypal-webhook`, `paypal-buttons-browser`) and adapted it.
- Made **all 15 ContextMatic lookups** the plan lists (`fetch_api`, `ask`, `endpoint_search` for `createOrder`, `captureOrder` and `refundCapturedPayment`, `model_search` for the order, amount, experience context, status and refund models), then a few more for enum names it needed.
- Wrote the integration ([changes.diff](changes.diff): 4 files changed, 3 created, lockfile left out): the Stripe webhook's inline logic moved into shared `fulfilPayment` and `recordPaymentRefund`; the create-order, capture and PayPal webhook routes; PayPal refunds in the admin route (a bad partial amount is refused, never turned into a full refund); PayPal buttons next to each Stripe button.
- Typechecked, ran `setup_webhook_relay`, started the app and ran `verify_checkout`, which **passed on its first run** (14 of 14 steps, 72 seconds; [report card](verify/result.json), [screenshots](verify/)): real sandbox payment, capture checked with PayPal, the real `PAYMENT.CAPTURE.COMPLETED` and `PAYMENT.CAPTURE.REFUNDED` webhooks verified by the app, a forged webhook rejected with 400, the refund.
- Checked that Stripe still works: paid a Stripe test order through Standin, fulfilled it and partially refunded it with the credit clawback.
- Confirmed the payment with PayPal's own MCP server: `get_order` returned the order COMPLETED, the capture REFUNDED and `custom_id` equal to the app's own purchase ID; `get_refund` returned the refund COMPLETED for $9.00.
- Scanned its own diff for secrets (the one match was the placeholder line in `.env.example`) and reported what changed, the report card, its ContextMatic lookups and what it left behind.

## What it cost and what it shows

About $1.33 of model usage for the run that did the work (the stopped run cost $0.45). The agent never saw or printed a secret except the public PayPal client ID, which the page renders for the buttons.

The point isn't that the code is clever. It's that the process held: an agent with no special knowledge of PayPal's SDK, given Portage's plan, reference code and ContextMatic, produced a working, verified integration, and the check that it works isn't the agent's word but a real payment that PayPal itself confirms.
