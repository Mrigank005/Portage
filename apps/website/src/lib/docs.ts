// The docs sidebar, in reading order.
export const DOCS: { group: string; pages: { href: string; title: string }[] }[] = [
  {
    group: "Get started",
    pages: [
      { href: "/docs", title: "Quickstart" },
      { href: "/docs/install", title: "Use it on your repo" },
    ],
  },
  {
    group: "Concepts",
    pages: [
      { href: "/docs/how-it-works", title: "How it works" },
      { href: "/docs/verify", title: "Proving it: verify_checkout" },
      { href: "/docs/relay", title: "Webhook relay" },
      { href: "/docs/contextmatic", title: "ContextMatic lookups" },
    ],
  },
  {
    group: "Reference",
    pages: [
      { href: "/docs/tools", title: "MCP tools" },
      { href: "/docs/cli", title: "CLI" },
      { href: "/docs/configuration", title: "Configuration" },
    ],
  },
  {
    group: "Help",
    pages: [{ href: "/docs/troubleshooting", title: "Troubleshooting" }],
  },
];
