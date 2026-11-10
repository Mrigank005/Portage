// The Portage playbook: what the coding agent does, in order. One source for both the Claude Code skill
// (plugin/skills/portage-migrate/SKILL.md, written by `npm run skill:sync`) and the MCP prompt that GitHub Copilot and
// Cursor use. A test fails if SKILL.md drifts from this text.

export const SKILL_NAME = "portage-migrate";

export const SKILL_DESCRIPTION =
  "Add PayPal to a Node.js app that takes payments with Stripe (Next.js or Express), or move its checkout to PayPal, and prove it with a real PayPal sandbox payment. Use when the user asks to add PayPal, offer PayPal next to Stripe, migrate from Stripe to PayPal, or run Portage on a repository or its test suite.";

export const PLAYBOOK = `# Portage: add PayPal to a Stripe app

You are adding PayPal to an app that already takes payments with Stripe. Portage's tools find the payment code, make the plan and hand you tested reference code; you write the integration in the app's own style; a real PayPal sandbox payment decides whether it worked.

## Rules

- **Nothing is edited before the developer approves the plan.** For apps in Portage's own \`suite/\` folder the plan counts as approved; say so when you continue.
- **PayPal SDK code comes from ContextMatic, never from memory.** Before writing any call to the PayPal Server SDK (\`@paypal/paypal-server-sdk\`), use the \`context-matic\` MCP server: \`fetch_api\` (language \`typescript\`, key \`paypal\`), then \`endpoint_search\` for every method and \`model_search\` for every model you use. Each plan step lists its lookups. If ContextMatic is unavailable, stop and say so.
- **Start from Portage's reference code** where a plan step names it (\`get_reference_code\`). It is typechecked against the real PayPal packages and tested against the PayPal sandbox. Adapt names, paths and style to the app; keep the behaviour.
- **Keep a log of your ContextMatic lookups** (tool, query, what it confirmed). It goes in the report and the pull request under "ContextMatic lookups".
- **Money goes through the money helper.** Stripe amounts are integer minor units (\`2400\`); PayPal amounts are decimal strings (\`"24.00"\`). Refuse amounts PayPal can't represent; never round.
- **The server decides the price.** The browser sends what is being bought (product, quantity), never an amount.
- **Sandbox only.** Never use live keys. Never print, log or commit secrets; they live in the developer's own env file.
- **Stripe keeps working** in add mode. Don't change how Stripe payments behave.

## Workflow

1. **Scan.** Call \`scan_payment_surface\` with the absolute path of the repository. If it says the repository isn't supported, tell the developer why, in its words, and stop without changing anything.
2. **Plan.** Call \`plan_migration\` with the same path and the mode the developer wants: \`add\` keeps Stripe and adds PayPal (the default); \`replace\` moves new payments to PayPal. If the repository has several apps, pass \`app\`.
3. **Approve.** Show the headline, the steps, the files and the "Needs a person" items. Ask the developer to decide each "Needs a person" item. Wait for approval.
4. **Edit, in the plan's order.** For each step: fetch the reference code it names, make its ContextMatic lookups, then write the change. Reuse the app functions the plan names (for example the fulfilment function the Stripe webhook already calls) instead of writing parallel logic. Add the PayPal settings to the app's example env file with placeholder values only.
5. **Check.** Install the new packages, then typecheck and build the app and run its existing tests. Fix what fails.
6. **Copy the catalog** (replace mode only, or when the plan says so). Call \`migrate_catalog\` with \`dryRun: true\`, show the result, then run it for real once the developer agrees.
7. **Prove it.** If the \`verify_checkout\` tool is available, run it: a real sandbox payment through the new PayPal button, the webhook, and a refund. If it fails, read its logs and screenshots, fix the code and run it again. If the tool isn't available, say the sandbox payment test was not run; never claim it passed.
8. **Report.** Summarise what changed, what was verified and how, your ContextMatic lookups, and anything left for a person. If \`generate_report\` is available, use it.

## What Portage supports

Node.js apps in TypeScript or JavaScript, on Next.js (App Router; the Pages Router works but is not in the tested set) or Express, taking one-time payments with Stripe Checkout. Portage refuses, with a reason: other languages and frameworks, Stripe Connect, custom card forms (Stripe Elements) without Checkout, and subscription-only billing.
`;

export function skillMarkdown(): string {
  return `---\nname: ${SKILL_NAME}\ndescription: ${SKILL_DESCRIPTION}\n---\n\n${PLAYBOOK}`;
}
