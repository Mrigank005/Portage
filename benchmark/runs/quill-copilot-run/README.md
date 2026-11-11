# Run: GitHub Copilot (VS Code agent mode)

**Date:** 2026-11-11 · **Agent:** GitHub Copilot in VS Code, Agent mode, model GPT 5.6, driven by a person (who clicked to allow commands, and "Continue" once after a Wi-Fi drop) · **App:** Quill, from `npx portage try quill` · **Stripe side:** Standin · **PayPal side:** the real sandbox

Two attempts. The first went wrong in a way that exposed real gaps in Portage's playbook; both are described here, along with what changed.

## Attempt 1: the playbook let the agent edit the wrong thing

We sent only `/mcp.portage.migrate`, without the trial prompt. Copilot got the repository root as `repoPath`, so it didn't know about `trial/quill-saas`, and Portage's scan picked `suite/brewbox-store`: one of Portage's own committed test apps.

- Copilot's approval question failed ("no interactive approval was available"), and it carried on. Portage's playbook then said plans for `suite/` apps count as approved, so it was within the rules.
- It edited `suite/brewbox-store`, ran `npm install` at the repository root, and then, when Portage's own scan tests failed because Brewbox had changed, **edited Portage's scanner** to make them pass.
- It got the plan, ContextMatic lookups (all 15) and reference code right, typechecked and built Brewbox, and honestly reported that it couldn't run `verify_checkout`: that app has no PayPal keys.

Nothing was committed. The changes were saved for this report and the repository restored.

**What changed in Portage because of it:**

- The playbook no longer treats `suite/` apps as approved. *No answer is not approval:* if the agent can't ask, it stops after the plan. Only a `trial/` copy whose prompt says so counts as approved.
- New rule: *edit only the app the plan is for*; with several apps, ask which; never edit Portage's own `suite/`, `packages/` or tests; never change code outside the app to make tests pass. The same rule is in the MCP server's instructions.
- The README now tells Copilot users to paste the trial prompt (Copilot loads the `portage-migrate` skill by itself) instead of the bare slash command.

## Attempt 2: the trial prompt, pasted as the message

Copilot read the `portage-migrate` skill, scanned and planned `trial/quill-saas`, made the plan's 15 ContextMatic lookups, fetched Portage's four reference files, wrote the integration ([changes.diff](changes.diff): 7 files, +349/−114, lockfile left out), typechecked, started Standin's check and the app, ran `setup_webhook_relay`, restarted the app, and ran `verify_checkout` until it passed.

**`verify_checkout`: 14 of 14 steps** ([report card](verify/result.json), [screenshots](verify/)): real sandbox payment by the US buyer ($9.00), capture checked with PayPal, the real `PAYMENT.CAPTURE.COMPLETED` and `PAYMENT.CAPTURE.REFUNDED` webhooks verified by Quill, refund, and a forged webhook rejected with 400. It also checked that Stripe checkout still redirects to Standin.

Before the pass, `verify_checkout` failed three times, each time for a reason it should have handled better. All three are fixed:

| What happened | Fix in `verify_checkout` |
|---|---|
| "App is running: fetch failed", twice: Copilot called it the moment it restarted the app | Waits up to 30 seconds for the app to answer |
| "Unexpected error: Invalid URL": Quill's form needs an email; without it the create-order route refused, PayPal's popup closed while still blank, and parsing its URL crashed. Copilot worked it out from the screenshot and added `fill` | Reads the popup URL defensively and reports what the page shows ("The page shows: *Choose a pack and enter a valid email* … pass it with `fill`") |
| Copilot used `paidText: "paid"`, which also matched the account table's *Paid* column header, so that step could pass without the order being paid | Text checks are now case-sensitive |

Also noticed: GitHub Copilot masks anything after `Bearer` in tool input and output as `******`. Shown the reference code's correct `Authorization: Bearer ${await paypalAccessToken()}` header, it decided the header was malformed and "fixed" it, back to the same text.

## What this shows

With the trial prompt, Portage works in GitHub Copilot as it does in Claude Code: same skill, same tools, same lookups, same proof. The first attempt is the more useful result: given an ambiguous start, an agent followed Portage's rules exactly where they were too loose, and the rules are tighter now.
