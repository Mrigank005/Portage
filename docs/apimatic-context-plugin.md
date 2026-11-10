# How Portage uses the APIMatic Context Plugin

[ContextMatic](https://github.com/apimatic/context-matic) is APIMatic's Context Plugin: an MCP server that gives coding agents version-accurate documentation for SDKs that APIMatic generates, including the **PayPal Server SDK**. Portage depends on it in two ways.

## 1. Building Portage

Every coding agent we develop with is configured to load ContextMatic from this repository:

| Agent | Config file |
|---|---|
| Claude Code | [`.mcp.json`](../.mcp.json) |
| Cursor | [`.cursor/mcp.json`](../.cursor/mcp.json) |
| VS Code / GitHub Copilot | [`.vscode/mcp.json`](../.vscode/mcp.json) |
| Codex | `~/.codex/config.toml` (see below) |

[`AGENTS.md`](../AGENTS.md) (also loaded by Claude Code through [`CLAUDE.md`](../CLAUDE.md)) makes ContextMatic lookups mandatory before any PayPal Server SDK code is written, and asks for the lookups to be listed in each pull request.

Codex reads MCP servers from its user configuration. Add:

```toml
[mcp_servers.context-matic]
url = "https://chatbotapi.apimatic.io/mcp/plugins"
```

The first time an agent connects, ContextMatic asks you to sign in through your browser. No APIMatic credentials are needed for the PayPal SDK.

## 2. Inside Portage *(in development)*

Portage itself is a plugin for coding agents. Its plugin configuration already registers ContextMatic ([`plugin/.mcp.json`](../plugin/.mcp.json)); Portage's own MCP server will sit next to it. When Portage migrates a codebase, its skill will direct the agent as follows:

| Migration step | ContextMatic tool | Why |
|---|---|---|
| Plan | `fetch_api`, `ask` | Confirm which PayPal flows the SDK supports natively for the app's language and framework |
| Edit | `endpoint_search` | Exact signatures for `createOrder`, `captureOrder`, refunds and other calls before they are written |
| Edit | `model_search` | Exact fields for `OrderRequest`, `PurchaseUnitRequest`, `Money` and other models, including deprecated fields to avoid |
| Fix | `ask`, `endpoint_search` | When the sandbox test fails, check the SDK's real behaviour before changing code |

Portage's own tools handle the parts that must be exact without AI (finding Stripe code, the Stripe→PayPal mapping, money conversion, and the sandbox payment test). ContextMatic makes sure the code the agent writes against the PayPal SDK is correct the first time.

## Why it matters for a migration tool

APIMatic's [case study](https://www.apimatic.io/product/context-plugins/case-study) ran PayPal integration and migration tasks with and without the Context Plugin. Without it, agents produced 16 compile and runtime errors, needed 11 manual fixes, and introduced payment security bugs; with it, they produced 1 error and needed no manual fixes. A tool that edits payment code on someone else's behalf can't afford those errors, so ContextMatic is a core dependency of Portage rather than an optional extra.
