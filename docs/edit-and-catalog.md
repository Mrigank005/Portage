# The edit step: playbook, reference code and catalog copy

After the developer approves a plan, the coding agent makes the change. Portage keeps it on rails three ways.

## The playbook

One text ([`playbook.ts`](../packages/core/src/playbook.ts)) tells the agent what to do in order: scan, plan, approval, edits, checks, catalog copy, the sandbox test, the report. Claude Code loads it as the [`portage-migrate` skill](../plugin/skills/portage-migrate/SKILL.md); GitHub Copilot and Cursor get the same text as the MCP prompt `migrate`. A test keeps the two identical.

Its rules: nothing is edited before approval; every PayPal Server SDK call is looked up through ContextMatic first (and the lookups are logged); start from Portage's reference code where the plan names it; all money goes through the money helper; the server decides prices; sandbox only, no secrets in code or logs; Stripe keeps working in add mode.

## Reference code

`get_reference_code` hands the agent small, tested files for the parts of a PayPal integration that must be exact. The agent adapts names, paths and style; the behaviour stays.

| Name | What it is | How it is checked |
|---|---|---|
| `paypal-client` | One SDK client, created on first use; Orders and Payments controllers; PayPal-Request-Id; retries (including POST, safe because every POST is idempotent through its request id); log-safe errors with PayPal's `debug_id` | Typechecked against `@paypal/paypal-server-sdk` 2.5; creates, reads and fails to capture a real sandbox order in the tests |
| `paypal-money` | Minor units ↔ PayPal amounts; refuses instead of rounding (HUF, TWD); accepts SDK (camelCase) and webhook (snake_case) amounts | Agrees with Portage's own helper on thousands of amounts |
| `paypal-webhook` | Verifies webhooks with `POST /v1/notifications/verify-webhook-signature` (the SDK has no webhook methods), sending the raw body unchanged; caches the OAuth token; retries; finds the capture a refund belongs to | Against a fake PayPal (exact bytes forwarded, token cached, retries on a dropped connection and a 503) and the real sandbox (a forged signature gets `FAILURE`) |
| `PayPalButtons` | React/Next.js buttons on PayPal's JS SDK v6 (`@paypal/react-paypal-js/sdk-v6`), sending the existing checkout form's fields | Typechecked against the package; used in the Brewbox run |
| `paypal-buttons-browser` | The same for server-rendered HTML, with no build step | Syntax-checked |

Server and React files can be fetched as TypeScript or converted to JavaScript (ES modules or CommonJS). The plan names the reference for each step it applies to.

The files live in [`packages/core/reference`](../packages/core/reference) and are embedded into the MCP server by `npm run reference:embed` (a test fails if the embedded copy is stale).

## Catalog copy

`migrate_catalog` is for replace mode, when the Stripe catalog stops being the source of prices.

- Reads products and one-time prices with the official Stripe SDK, through `STRIPE_API_BASE` when it is set (so suite apps read from Standin).
- Creates PayPal catalog products with `POST /v1/catalogs/products`, the call the PayPal Agent Toolkit's `create_product` makes. Portage calls the API directly instead of bundling the toolkit, because the toolkit's dependency tree carries seven security advisories.
- Writes `portage.catalog.json`: the Stripe → PayPal product mapping, and each one-time price already converted to a PayPal amount (PayPal catalog products have no one-time prices, so the app's create-order route reads amounts from here).
- Dry run by default. Test keys and the PayPal sandbox only. Reads five settings (`STRIPE_SECRET_KEY`, `STRIPE_API_BASE`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENVIRONMENT`) from the app's env files and never returns their values.
- Idempotent: each product gets a deterministic PayPal-Request-Id, and existing mappings are reused, so re-runs never duplicate products.
- Skips, with a reason: recurring prices (subscriptions), prices without a fixed amount, and amounts PayPal can't represent.

Tested against Standin and a fake PayPal, and against the real sandbox: Brewbox's three products are created once, and a second run from an empty folder gets the same three back.
