// Portage's reference code: small, tested files for the parts of a PayPal integration that must be exact.
// The agent adapts them to the app (paths, style, names); the behaviour stays. TypeScript sources are typechecked
// against the real PayPal packages; the money helper and webhook verifier are also tested against the live sandbox.
import { ts } from "ts-morph";
import { REFERENCE_SOURCES } from "./reference-sources.ts";

export interface ReferenceInfo {
  name: string;
  file: string;
  purpose: string;
  placement: string;
  packages: string[];
  env: string[];
  notes: string[];
  /** "server" files can be converted to JavaScript; "browser" files are plain JavaScript already. */
  kind: "server" | "react" | "browser";
}

export const REFERENCES: ReferenceInfo[] = [
  {
    name: "paypal-client",
    file: "paypal-client.ts",
    kind: "server",
    purpose: "One shared PayPal Server SDK client (created on first use), the Orders and Payments controllers, PayPal-Request-Id, and log-safe error descriptions with PayPal's debug_id.",
    placement: "Next to the app's Stripe client module (for example lib/paypal.ts beside lib/stripe.ts).",
    packages: ["@paypal/paypal-server-sdk"],
    env: ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_ENVIRONMENT"],
    notes: ["No `logging` option is set on purpose: with one, the SDK logs every request and response."],
  },
  {
    name: "paypal-money",
    file: "paypal-money.ts",
    kind: "server",
    purpose: "Converts the app's integer minor units to PayPal amounts and back (2400 → \"24.00\"; JPY stays whole; refuses HUF/TWD fractions instead of rounding).",
    placement: "Next to the PayPal client. Self-contained: copy it as it is.",
    packages: [],
    env: [],
    notes: ["Use it for every PayPal amount: order items, item total, order total, refunds, and when reading amounts back from PayPal."],
  },
  {
    name: "paypal-webhook",
    file: "paypal-webhook.ts",
    kind: "server",
    purpose: "Verifies a PayPal webhook with POST /v1/notifications/verify-webhook-signature (the SDK has no webhook methods), passing the raw body unchanged; caches the OAuth token; finds the capture a refund belongs to.",
    placement: "Next to the PayPal client. The webhook route reads the body as text and calls verifyPayPalWebhook(headers, rawBody) before anything else.",
    packages: [],
    env: ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_ENVIRONMENT", "PAYPAL_WEBHOOK_ID"],
    notes: ["Answer 400 when verification fails, like a Stripe signature failure.", "PayPal retries deliveries: keep every branch idempotent."],
  },
  {
    name: "PayPalButtons",
    file: "PayPalButtons.tsx",
    kind: "react",
    purpose: "PayPal buttons for React or Next.js on PayPal's JS SDK v6 (@paypal/react-paypal-js/sdk-v6): a provider for the page and a button that sends the existing checkout form's fields to the create-order route and captures on approval.",
    placement: "A client component next to the page with the checkout button. Wrap the page section once in <PayPalCheckoutProvider>, and put <PayPalCheckoutButton formId=…> beside the existing checkout button.",
    packages: ["@paypal/react-paypal-js"],
    env: ["NEXT_PUBLIC_PAYPAL_CLIENT_ID (or however the app exposes public settings)"],
    notes: ["The create-order route answers { orderId }; the capture route answers { redirectUrl }.", "Never send amounts from the browser: the server reads prices itself."],
  },
  {
    name: "paypal-buttons-browser",
    file: "paypal-buttons.js",
    kind: "browser",
    purpose: "PayPal buttons for server-rendered pages (Express, plain HTML) on PayPal's JS SDK v6 with no build step: <paypal-button data-form=…> elements next to the existing checkout forms.",
    placement: "Serve it as a static file (or inline it). The page needs the <meta name=\"paypal-checkout\" …> tag, the buttons, and the v6 core script; see the comment at the top.",
    packages: [],
    env: ["PAYPAL_CLIENT_ID (rendered into the page; it is public)"],
    notes: ["Use https://www.sandbox.paypal.com/web-sdk/v6/core in sandbox and https://www.paypal.com/web-sdk/v6/core in production."],
  },
];

export interface ReferenceCode extends ReferenceInfo {
  language: "typescript" | "javascript";
  filename: string;
  code: string;
}

/**
 * A reference file, in TypeScript as written or converted to JavaScript (ES modules or CommonJS) for JavaScript apps.
 */
export function referenceCode(name: string, language: "typescript" | "javascript" = "typescript", moduleFormat: "esm" | "commonjs" = "esm"): ReferenceCode {
  const info = REFERENCES.find((r) => r.name === name);
  if (!info) throw new Error(`No reference called "${name}". Available: ${REFERENCES.map((r) => r.name).join(", ")}`);
  const source = REFERENCE_SOURCES[info.file];
  if (source === undefined) throw new Error(`Reference source ${info.file} is missing; run npm run reference:embed`);
  if (info.kind === "browser" || language === "typescript") {
    return { ...info, language: info.kind === "browser" ? "javascript" : "typescript", filename: info.file, code: source };
  }
  const out = ts.transpileModule(source, {
    fileName: info.file,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: moduleFormat === "commonjs" ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.Preserve,
      esModuleInterop: true,
      verbatimModuleSyntax: false,
    },
  });
  const filename = info.file.replace(/\.tsx$/, ".jsx").replace(/\.ts$/, moduleFormat === "commonjs" ? ".cjs" : ".js");
  return { ...info, language: "javascript", filename, code: out.outputText };
}
