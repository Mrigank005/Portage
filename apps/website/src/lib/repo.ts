// Everything the site says about runs comes from the repository's own files, read at build time:
// benchmark/runs/<run>/verify/result.json (written by verify_checkout), the screenshots next to it, and changes.diff.
// The only hand-written part is the short description of each run below.
import fs from "node:fs";
import path from "node:path";

export const REPO = path.resolve(process.cwd(), "../..");
export const GITHUB = "https://github.com/Mrigank005/Portage";
export const blob = (p: string) => `${GITHUB}/blob/main/${p}`;
export const tree = (p: string) => `${GITHUB}/tree/main/${p}`;
export const RELAY_URL = "https://portage-relay.onrender.com";

/** Set once the demo video is on YouTube; the video section stays hidden until then. */
export const YOUTUBE_ID = "_-oA4U_pZKk";

export type StepStatus = "pass" | "fail" | "warn" | "skip";
export interface Step {
  name: string;
  status: StepStatus;
  detail: string;
}
export interface VerifyResult {
  ok: boolean;
  appUrl: string;
  steps: Step[];
  paypalOrderId: string | null;
  captureId: string | null;
  refundId: string | null;
  amount: string | null;
  webhooks: { eventType: string | null; status: number | null }[];
  screenshots: string[];
  browser: string | null;
  durationMs: number;
  log: string[];
}

interface RunMeta {
  slug: string;
  title: string;
  kind: "agent" | "tuning";
  agent: string;
  model?: string;
  driver: string;
  mode: "add" | "replace";
  app: string;
  stack: string;
  /** Whole run, start to report, when we timed it. */
  minutes?: number;
  firstTry: boolean;
  summary: string;
  highlights: string[];
}

const META: RunMeta[] = [
  {
    slug: "quill-agent-run",
    title: "One prompt on a fresh clone",
    kind: "agent",
    agent: "Claude Code",
    driver: "Headless, no human input",
    mode: "add",
    app: "Quill",
    stack: "Express, server-rendered HTML",
    minutes: 7,
    firstTry: true,
    summary:
      "The repository was cloned into an empty folder and set up exactly as the README says. The agent got one pasted prompt and nothing else: it planned, made all fifteen ContextMatic lookups, wrote the integration and passed every proof step on its first run.",
    highlights: [
      "All 15 planned ContextMatic lookups made before any PayPal code was written",
      "Re-checked that Stripe checkout, fulfilment and refunds still work",
      "Confirmed the order and refund with PayPal's own MCP server",
    ],
  },
  {
    slug: "brewbox-replace-agent-run",
    title: "Stripe to PayPal, completely",
    kind: "agent",
    agent: "Claude Code",
    driver: "Headless, no human input",
    mode: "replace",
    app: "Brewbox",
    stack: "Next.js App Router shop",
    minutes: 13,
    firstTry: true,
    summary:
      "Replace mode: new payments go through PayPal only. The agent copied the catalog to PayPal, removed the Stripe checkout, kept Stripe refunds working for orders Stripe already took, and passed every proof step on its first run.",
    highlights: [
      "Catalog copied to PayPal with migrate_catalog: dry run first, then three products created",
      "Old Stripe checkout removed (it now answers 404); a Stripe-paid order still refunded through Stripe",
      "Added handling for PAYMENT.CAPTURE.DENIED, which the plan hadn't asked for",
    ],
  },
  {
    slug: "quill-copilot-run",
    title: "GitHub Copilot, a second AI vendor",
    kind: "agent",
    agent: "GitHub Copilot",
    model: "GPT 5.6",
    driver: "VS Code agent mode; a person clicked Allow",
    mode: "add",
    app: "Quill",
    stack: "Express, server-rendered HTML",
    firstTry: false,
    summary:
      "The same trial prompt in GitHub Copilot's agent mode. Copilot loaded the same skill, made the same lookups, and iterated on verify_checkout until all fourteen steps passed. An earlier attempt, started without the trial prompt, taught us three new guardrails, which every agent now follows.",
    highlights: [
      "Found and followed the same portage-migrate skill Claude Code uses",
      "Used verify_checkout's report to fix its own run: added the form field the checkout needed",
      "Its first attempt hardened Portage's rules: no answer is not approval, and only the planned app is edited",
    ],
  },
  {
    slug: "quill-add",
    title: "Guided tuning run: Quill",
    kind: "tuning",
    agent: "Claude Code",
    driver: "Playbook followed step by step while tuning Portage",
    mode: "add",
    app: "Quill",
    stack: "Express, server-rendered HTML",
    firstTry: true,
    summary:
      "One of the runs we used to tune Portage on an app shaped differently from Brewbox. It added the form-filling option to verify_checkout and aligned the plan on PayPal's JS SDK v6.",
    highlights: ["Introduced verify_checkout's fill option for checkout forms", "Every proof step passed, with real webhooks through the relay"],
  },
  {
    slug: "brewbox-add",
    title: "Guided tuning run: Brewbox",
    kind: "tuning",
    agent: "Claude Code",
    driver: "Playbook followed step by step while tuning Portage",
    mode: "add",
    app: "Brewbox",
    stack: "Next.js App Router shop",
    firstTry: false,
    summary:
      "The first full run, used to tune Portage against the real PayPal sandbox. It found the sandbox's sharp edges (return URLs, buyer currency, refund totals, a webhook PayPal never sent) and turned each one into part of Portage.",
    highlights: ["First real PayPal webhooks delivered through the relay", "Each sandbox quirk it hit is now handled in the plan, the reference code or the proof"],
  },
];

export interface Run extends RunMeta {
  result: VerifyResult;
  screenshots: { src: string; caption: string }[];
  diff: string;
  diffStats: { files: number; added: number; removed: number };
  readme: string;
}

function captionOf(file: string): string {
  const base = file.replace(/^\d+-/, "").replace(/\.png$/, "");
  return (
    {
      "checkout-page": "The app's checkout with the new PayPal button",
      "paypal-review": "PayPal's review page, logged in as the sandbox buyer",
      "after-payment": "Back in the app after the payment",
      "after-refund": "The same order after the refund webhook",
    } as Record<string, string>
  )[base] ?? base.replace(/-/g, " ");
}

function diffStats(diff: string) {
  let files = 0;
  let added = 0;
  let removed = 0;
  for (const l of diff.split("\n")) {
    if (l.startsWith("diff --git")) files++;
    else if (l.startsWith("+") && !l.startsWith("+++")) added++;
    else if (l.startsWith("-") && !l.startsWith("---")) removed++;
  }
  return { files, added, removed };
}

let cache: Run[] | null = null;
export function runs(): Run[] {
  if (cache) return cache;
  cache = META.map((m) => {
    const dir = path.join(REPO, "benchmark", "runs", m.slug);
    const result = JSON.parse(fs.readFileSync(path.join(dir, "verify", "result.json"), "utf8")) as VerifyResult;
    const pngs = fs.readdirSync(path.join(dir, "verify")).filter((f) => f.endsWith(".png")).sort();
    const diff = fs.existsSync(path.join(dir, "changes.diff")) ? fs.readFileSync(path.join(dir, "changes.diff"), "utf8").replace(/\r\n/g, "\n") : "";
    return {
      ...m,
      result,
      screenshots: pngs.map((f) => ({ src: `/evidence/${m.slug}/${f}`, caption: captionOf(f) })),
      diff,
      diffStats: diffStats(diff),
      readme: blob(`benchmark/runs/${m.slug}/README.md`),
    };
  });
  return cache;
}

export const runBySlug = (slug: string) => runs().find((r) => r.slug === slug);

export const passed = (r: Run) => r.result.steps.filter((s) => s.status === "pass").length;

export const seconds = (ms: number) => Math.round(ms / 1000);

/** Numbers quoted on the site, each one checkable in the repository. */
export const STATS = {
  tests: 92,
  e2eChecks: 21,
  lookups: 20,
  realRepos: 5,
  realReposPlanned: 4,
};
