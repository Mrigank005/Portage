// plan_migration: turns a scan into a concrete, reviewable plan. Deterministic: the same scan always gives the
// same plan. It reads the Stripe→PayPal map for every translation, so the PayPal knowledge lives in data.
import path from "node:path";
import { loadMap, ruleForEvent } from "./map.ts";
import { paypalExponent, paypalInCountryOnly, stripeExponent } from "./money.ts";
import { routeLabel } from "./types.ts";
import type {
  AppCall,
  AppScan,
  ContextMaticLookup,
  EventPlan,
  FileChange,
  Issue,
  Mode,
  Plan,
  PlanStep,
  ScanResult,
  WebhookHandler,
} from "./types.ts";

const FULFIL_RE = /fulfil|complete|grant|provision|markPaid|markAsPaid|deliver|activate|handle(Checkout|Order|Payment|Purchase)/i;
const SUCCESS_EVENTS = ["checkout.session.completed", "checkout.session.async_payment_succeeded", "payment_intent.succeeded", "charge.succeeded"];
const STRIPE_SHAPED = /session|paymentIntent|payment_intent|stripe|charge/i;
const SHARED_FULFIL = "fulfilPayment";
const SHARED_REFUND = "recordPaymentRefund";

export interface PlanOptions {
  mode?: Mode;
  /** Which app to plan for when the repo has several (its root or package name). */
  app?: string;
}

export function planMigration(scan: ScanResult, options: PlanOptions = {}): Plan {
  const mode: Mode = options.mode ?? "add";
  const repo = { path: scan.repo.path, name: scan.repo.name };
  const app = pickApp(scan, options.app);
  const base: Plan = {
    tool: "portage",
    kind: "plan",
    version: 1,
    repo,
    app: app ? { root: app.root, name: app.name, framework: app.framework.label } : { root: ".", name: repo.name, framework: "none" },
    mode,
    status: "blocked",
    headline: "",
    blockers: [],
    needsHuman: [],
    notes: [],
    steps: [],
    files: { create: [], edit: [], remove: [] },
    routes: [],
    env: { add: [], remove: [] },
    dependencies: { add: [], remove: [] },
    events: [],
    dataModel: [],
    money: [],
    catalog: { needed: false, reason: "" },
    untouched: [],
    contextmatic: [],
    verify: {},
  };

  const repoBlockers = scan.issues.filter((i) => i.severity === "blocker");
  const appBlockers = app?.issues.filter((i) => i.severity === "blocker") ?? [];
  if (!app || repoBlockers.length || appBlockers.length) {
    base.blockers = [...repoBlockers, ...appBlockers];
    if (options.app && !app) base.blockers.push({ code: "APP_NOT_FOUND", severity: "blocker", message: `No app called "${options.app}" in this repository.` });
    base.notes = scan.issues.filter((i) => i.severity === "info");
    base.headline = `Blocked: ${base.blockers[0]?.message ?? "nothing to migrate"}`;
    return base;
  }
  return buildPlan(base, scan, app, mode);
}

/**
 * The app to plan for. With several supported apps, prefer the one that needs the fewest decisions from a person,
 * then the one with the most for Portage to reuse (a webhook, refunds). Ties keep folder order, so this is stable.
 */
function pickApp(scan: ScanResult, wanted?: string): AppScan | undefined {
  if (wanted) return scan.apps.find((a) => a.root === wanted || a.name === wanted);
  const supported = scan.apps.filter((a) => a.supported);
  if (!supported.length) return scan.apps[0];
  const score = (a: AppScan) =>
    a.issues.filter((i) => i.severity === "needs-human").length * 10 - (a.webhooks.some((w) => !w.inTest) ? 2 : 0) - (a.refunds.some((r) => !r.inTest) ? 1 : 0);
  return [...supported].sort((x, y) => score(x) - score(y))[0];
}

const dirOf = (file: string) => path.posix.dirname(file);
const join = (...p: string[]) => path.posix.join(...p);

function buildPlan(plan: Plan, scan: ScanResult, app: AppScan, mode: Mode): Plan {
  const map = loadMap();
  const live = <T extends { inTest: boolean }>(xs: T[]) => xs.filter((x) => !x.inTest);
  const checkouts = live(app.checkouts).filter((c) => c.modes.some((m) => m === "payment" || m === "unspecified" || m === "unknown"));
  const co = checkouts[0];
  const wh: WebhookHandler | undefined = live(app.webhooks)[0];
  const refunds = live(app.refunds);
  const ts = app.language === "typescript";
  const ext = ts ? "ts" : "js";
  const prefix = app.root === "." ? "" : `${app.root}/`;
  const isNext = app.framework.id === "next";
  const clientFile = app.clients.find((c) => !/(^|\/)(tests?|__tests__)\//.test(c.file))?.file;
  const libDir = clientFile ? dirOf(clientFile) : isNext ? join(prefix, app.srcDir ? "src/lib" : "lib") : join(prefix, app.srcDir ? "src" : ".");
  const clientExt = clientFile ? (path.posix.extname(clientFile).slice(1) || ext) : ext;
  const paypalClientFile = join(libDir, `paypal.${clientExt}`);
  const moneyFile = join(libDir, `paypal-money.${clientExt}`);

  const lookups: ContextMaticLookup[] = [];
  const look = (tool: ContextMaticLookup["tool"], query: string, why: string): ContextMaticLookup => {
    const l = { tool, query, why };
    if (!lookups.some((x) => x.tool === tool && x.query === query)) lookups.push(l);
    return l;
  };
  const fetchApi = look("fetch_api", "language=typescript, key=paypal", "Confirm the PayPal Server SDK and its key before writing any SDK code");

  const create: FileChange[] = [];
  const edit: FileChange[] = [];
  const remove: FileChange[] = [];
  const addFile = (list: FileChange[], file: string, why: string) => {
    const existing = list.find((f) => f.file === file);
    if (existing) {
      if (!existing.why.includes(why)) existing.why += `; ${why}`;
    } else list.push({ file, why });
  };
  const steps: PlanStep[] = [];
  const needsHuman: Issue[] = app.issues.filter((i) => i.severity === "needs-human");
  const notes: Issue[] = [...scan.issues, ...app.issues].filter((i) => i.severity === "info");
  const others = scan.apps.filter((a) => a.supported && a !== app);
  if (others.length) {
    notes.unshift({
      code: "OTHER_APPS",
      severity: "info",
      message: `This repository has ${others.length + 1} apps Portage can migrate. This plan is for ${app.root === "." ? app.name : app.root}; to plan another, pass its folder as \`app\` (${others.map((a) => `\`${a.root}\``).join(", ")}).`,
    });
  }

  // ---- Routes and where they live.
  const apiBase = co?.route?.path.startsWith("/api/") || isNext ? "/api/paypal" : "/paypal";
  const webhookPath = wh?.route ? (/stripe/i.test(wh.route.path) ? wh.route.path.replace(/stripe/i, "paypal") : `${apiBase}/webhook`) : `${apiBase}/webhook`;
  let createRouteFile: string;
  let captureRouteFile: string;
  let webhookRouteFile: string;
  let capturePath: string;
  const pagesRouter = isNext && (co?.route?.kind === "next-pages" || (!co?.route && app.framework.router === "pages"));
  if (pagesRouter) {
    const pagesDir = nextDir(co?.route?.file ?? wh?.route?.file, prefix, "pages") ?? join(prefix, app.srcDir ? "src/pages" : "pages");
    createRouteFile = join(pagesDir, apiBase.slice(1), `orders.${ext}`);
    captureRouteFile = join(pagesDir, apiBase.slice(1), "orders", "[orderId]", `capture.${ext}`);
    webhookRouteFile = join(pagesDir, `${webhookPath.slice(1)}.${ext}`);
    capturePath = `${apiBase}/orders/[orderId]/capture`;
  } else if (isNext) {
    const appDir = nextDir(co?.route?.file ?? wh?.route?.file, prefix, "app") ?? join(prefix, app.srcDir ? "src/app" : "app");
    createRouteFile = join(appDir, apiBase.slice(1), "orders", `route.${ext}`);
    captureRouteFile = join(appDir, apiBase.slice(1), "orders", "[orderId]", "capture", `route.${ext}`);
    webhookRouteFile = join(appDir, webhookPath.slice(1), `route.${ext}`);
    capturePath = `${apiBase}/orders/[orderId]/capture`;
  } else {
    const routesFile = co?.route?.file ?? wh?.route?.file ?? join(prefix, `server.${ext}`);
    createRouteFile = captureRouteFile = routesFile;
    webhookRouteFile = wh?.route?.file ?? routesFile;
    capturePath = `${apiBase}/orders/:orderId/capture`;
  }
  plan.routes = [
    { method: "POST", path: `${apiBase}/orders`, file: createRouteFile, purpose: "Create a PayPal order from the same trusted prices the Stripe checkout uses" },
    { method: "POST", path: capturePath, file: captureRouteFile, purpose: "Capture the approved order and fulfil it with the app's existing code" },
    { method: "POST", path: webhookPath, file: webhookRouteFile, purpose: "Receive PayPal webhooks, verify them, and update orders (captures, refunds)" },
  ];

  // ---- Dependencies and configuration.
  const usesReact = isNext || app.triggers.some((t) => /\.(tsx|jsx)$/.test(t.file));
  plan.dependencies.add = [map.config.packages.server, ...(usesReact ? [map.config.packages.react] : [])];
  steps.push({
    id: "dependencies",
    title: "Add the PayPal packages",
    kind: "dependency",
    files: [join(prefix, "package.json")],
    details: [
      `Server: \`${map.config.packages.server}\` (the APIMatic-generated PayPal Server SDK).`,
      usesReact
        ? `Browser: \`${map.config.packages.react}\` for the PayPal buttons.`
        : `Browser: the PayPal JS SDK script (${map.config.packages.browserScript}); no package needed.`,
    ],
    contextmatic: [fetchApi],
  });
  addFile(edit, join(prefix, "package.json"), "PayPal dependencies");

  const envFile = app.envExampleFiles[0]?.file ?? join(prefix, ".env.example");
  plan.env.add = [
    { name: "PAYPAL_CLIENT_ID", example: "your-sandbox-client-id", note: "From the PayPal developer dashboard (sandbox app)" },
    { name: "PAYPAL_CLIENT_SECRET", example: "your-sandbox-client-secret", note: "Server only. Never sent to the browser or committed" },
    { name: "PAYPAL_ENVIRONMENT", example: "sandbox", note: "sandbox or live" },
    { name: "PAYPAL_WEBHOOK_ID", example: "your-webhook-id", note: "ID of the webhook registered for this app; used to verify webhooks" },
    ...(isNext ? [{ name: "NEXT_PUBLIC_PAYPAL_CLIENT_ID", example: "your-sandbox-client-id", note: "Same client ID, exposed to the browser for the buttons (it is public)" }] : []),
  ];
  const mappedEnv = map.config.env.filter((e) => app.envVars.some((v) => v.name === e.stripe) || app.envExampleFiles.some((f) => f.keys.includes(e.stripe)));
  steps.push({
    id: "config",
    title: `Document the PayPal settings in ${path.posix.basename(envFile)}`,
    kind: "config",
    files: [envFile],
    details: [
      `Add ${plan.env.add.map((e) => `\`${e.name}\``).join(", ")} with placeholder values only. Real values go in the developer's own env file, which is never committed.`,
      ...mappedEnv.map((e) => `\`${e.stripe}\` → ${e.paypal.map((p) => `\`${p}\``).join(", ")}${e.notes ? `: ${e.notes}` : ""}`),
    ],
    contextmatic: [],
  });
  addFile(app.envExampleFiles.length ? edit : create, envFile, "PayPal settings (placeholders only)");

  // ---- PayPal client and money helper.
  const clientLookups = [
    look("ask", "How do I configure the PayPal Server SDK client with client credentials for the sandbox environment?", "Client setup"),
    look("model_search", "Money", "Exact shape of currencyCode and value"),
  ];
  steps.push({
    id: "paypal-client",
    title: "Create the PayPal client and the money helper",
    kind: "create",
    files: [paypalClientFile, moneyFile],
    details: [
      `\`${paypalClientFile}\`: one shared SDK client (client credentials from the environment, sandbox unless PAYPAL_ENVIRONMENT says otherwise) with the Orders and Payments controllers${clientFile ? `, next to \`${clientFile}\`` : ""}.`,
      `\`${moneyFile}\`: converts the app's integer minor units to PayPal's decimal strings and back (2400 → "24.00"; JPY stays whole). It refuses amounts PayPal can't represent instead of rounding (HUF and TWD take no decimals on PayPal). Portage's own tested helper is the reference.`,
      "Also a small helper for the webhook verification call, which is a REST call: the Server SDK has no webhook methods (confirmed through ContextMatic).",
    ],
    contextmatic: clientLookups,
  });
  addFile(create, paypalClientFile, "PayPal Server SDK client");
  addFile(create, moneyFile, "Minor units ↔ PayPal decimal strings");

  // ---- Data model: where the app keeps Stripe IDs on its own records.
  const keyFields = new Set<string>([...(co?.sessionIdStoredAs.map((s) => s.field) ?? []), ...refunds.map((r) => r.sourceField).filter(Boolean) as string[]]);
  const entities = new Map<string, { entity: string; file: string; line: number; fields: string[] }>();
  for (const f of app.dataModel) {
    const key = `${f.file}#${f.entity}`;
    const e = entities.get(key) ?? { entity: f.entity, file: f.file, line: f.line, fields: [] };
    e.fields.push(f.field);
    entities.set(key, e);
  }
  let targets = [...entities.values()].filter((e) => e.fields.some((f) => keyFields.has(f)));
  if (!targets.length) targets = [...entities.values()].filter((e) => e.fields.some((f) => /stripe|session|payment_?intent/i.test(f)));
  plan.dataModel = targets.map((t) => ({
    entity: t.entity,
    file: t.file,
    line: t.line,
    add: ["paymentProvider", "paypalOrderId", "paypalCaptureId"],
    note: `Keep ${t.fields.map((f) => `\`${f}\``).join(", ")}: orders paid with Stripe still need them.`,
  }));
  const creators = (co?.appCalls ?? []).filter((c) => /^(create|insert|new|add|save)/i.test(c.name.split(".").pop()!));
  if (plan.dataModel.length) {
    steps.push({
      id: "data-model",
      title: `Record which provider paid, and the PayPal IDs, on ${plan.dataModel.map((d) => `\`${d.entity}\``).join(", ")}`,
      kind: "edit",
      files: [...new Set(plan.dataModel.map((d) => d.file))],
      details: [
        ...plan.dataModel.map((d) => `\`${d.entity}\` (${d.file}:${d.line}): add \`paymentProvider\` ("stripe" | "paypal"), \`paypalOrderId\`, \`paypalCaptureId\`. ${d.note}`),
        ...(creators.length ? [`Initialise the new fields where records are created (${creators.map((c) => `\`${c.name}\``).join(", ")}).`] : []),
        "Refunds look up the PayPal capture ID here, the way Stripe refunds use the payment intent ID.",
      ],
      contextmatic: [],
    });
    for (const d of plan.dataModel) addFile(edit, d.file, `Add PayPal fields to ${d.entity}`);
  } else {
    needsHuman.push({
      code: "NO_ORDER_RECORD",
      severity: "needs-human",
      message: "Couldn't find where the app stores Stripe IDs on its own records. Decide where the PayPal order and capture IDs live before refunds can work.",
    });
  }

  // ---- Fulfilment: reuse the code the Stripe webhook already calls.
  const reuseOverride = new Map<string, string[]>();
  const inlineBranches: { type: string; line: number; calls: AppCall[]; fn: string; what: string }[] = [];
  const success = wh?.events.find((e) => SUCCESS_EVENTS.includes(e.type));
  const fulfil: AppCall[] = success?.appCalls.filter((c) => FULFIL_RE.test(c.name)) ?? [];
  const inlineCalls = success?.appCalls ?? [];
  let fulfilText: string;
  if (fulfil.length) {
    const f = fulfil[0];
    fulfilText = `\`${f.name}\`${f.definedIn ? ` (${f.definedIn.file}:${f.definedIn.line})` : ""}`;
    if (f.params && STRIPE_SHAPED.test(f.params)) {
      steps.push({
        id: "fulfilment",
        title: `Make \`${f.name}\` provider-neutral`,
        kind: "edit",
        files: f.definedIn ? [f.definedIn.file] : [],
        details: [
          `It takes Stripe-shaped arguments (\`${f.params}\`). Add the provider and the PayPal IDs (or neutral names) so PayPal payments don't end up in fields named after Stripe. Keep its idempotency: it can be called by the capture route and by the webhook for the same payment.`,
          "The Stripe webhook keeps calling it exactly as before.",
        ],
        contextmatic: [],
      });
      if (f.definedIn) addFile(edit, f.definedIn.file, `Let ${f.name} record PayPal payments`);
    }
  } else if (success && inlineCalls.length) {
    fulfilText = `the new shared fulfilment function (${SHARED_FULFIL})`;
    reuseOverride.set(success.type, [SHARED_FULFIL]);
    inlineBranches.push({ type: success.type, line: success.line, calls: inlineCalls, fn: SHARED_FULFIL, what: "fulfils" });
  } else {
    fulfilText = "the app's fulfilment code";
    needsHuman.push({
      code: "FULFILMENT_UNKNOWN",
      severity: "needs-human",
      message: "Couldn't find what the app does when a Stripe payment succeeds. Point Portage at the fulfilment code before the capture route is written.",
    });
  }

  // Refund bookkeeping: reuse a refund-recording function if the Stripe handler has one, otherwise extract it too.
  const refundBranch = wh?.events.find((e) => e.type === "charge.refunded" || e.type === "charge.refund.updated");
  if (refundBranch && refundBranch.appCalls.length && !refundBranch.appCalls.some((c) => /refund/i.test(c.name))) {
    reuseOverride.set(refundBranch.type, [SHARED_REFUND]);
    inlineBranches.push({ type: refundBranch.type, line: refundBranch.line, calls: refundBranch.appCalls, fn: SHARED_REFUND, what: "records refunds" });
  }
  if (inlineBranches.length && wh) {
    steps.push({
      id: "shared-handlers",
      title: inlineBranches.length > 1 ? "Pull the Stripe webhook's inline logic into shared functions" : "Pull the Stripe webhook's fulfilment code into one shared function",
      kind: "edit",
      files: [wh.file],
      details: [
        ...inlineBranches.map(
          (b) =>
            `The \`${b.type}\` branch (${wh.file}:${b.line}) ${b.what} inline (${b.calls.map((c) => `\`${c.name}\``).join(", ")}). Move it into \`${b.fn}\`, called by both the Stripe webhook and the PayPal code, so the two can never drift apart.`,
        ),
        "Make each function idempotent and keep behaviour for Stripe payments exactly as it is.",
      ],
      contextmatic: [],
    });
    addFile(edit, wh.file, "Extract shared webhook logic");
  }

  // ---- Create-order route.
  const priceItems = co?.lineItems.filter((l) => l.kind === "price") ?? [];
  const dataItems = co?.lineItems.filter((l) => l.kind === "price_data") ?? [];
  const priceSource = priceItems.length
    ? mode === "add"
      ? "Read each price on the server exactly as the Stripe route does (from Stripe), never from the browser."
      : "Read each price from `portage.catalog.json` (written by migrate_catalog) or the app's own product table."
    : dataItems.length
      ? `Use the same server-side amounts the Stripe route uses (${dataItems.map((d) => `\`${d.unitAmount}\``).join(", ")})${dataItems.some((d) => d.currency) ? ` in ${[...new Set(dataItems.map((d) => d.currency).filter(Boolean))].map((c) => c!.toUpperCase()).join(", ")}` : ""}.`
      : "Build the items on the server the same way the Stripe route builds its line items.";
  const ref = co?.params.client_reference_id ?? co?.params.metadata;
  const shipping = co && "shipping_address_collection" in co.params ? "GET_FROM_FILE" : "NO_SHIPPING";
  const orderLookups = [
    look("endpoint_search", "createOrder", "Exact createOrder signature (body, paypalRequestId)"),
    look("model_search", "OrderRequest", "intent, purchaseUnits"),
    look("model_search", "PurchaseUnitRequest", "amount, items, customId"),
    look("model_search", "ItemRequest", "name, unitAmount, quantity as string"),
    look("model_search", "AmountWithBreakdown", "value must equal the item total"),
    look("model_search", "PaypalWalletExperienceContext", "shippingPreference, returnUrl, cancelUrl"),
  ];
  const storeOrderId = co?.sessionIdStoredAs[0];
  const collide = (co?.appCalls ?? []).some((c) => c.name === "createOrder");
  steps.push({
    id: "create-order-route",
    title: `Add \`POST ${apiBase}/orders\``,
    kind: isNext ? "create" : "edit",
    files: [createRouteFile],
    details: [
      `Mirror the Stripe checkout${co?.route ? ` (\`${routeLabel(co.route)}\`, ${co.file}:${co.line})` : ""}: same input validation, same app record (${creators.map((c) => `\`${c.name}\``).join(", ") || "the app's order record"}), then \`ordersController.createOrder\` instead of \`checkout.sessions.create\`.`,
      priceSource,
      `intent \`CAPTURE\`; items with \`quantity\` as a string; \`amount.breakdown.itemTotal\` equal to the sum of the items, and \`amount.value\` equal to that (PayPal rejects the order otherwise). Amounts go through the money helper.`,
      ref ? `\`customId\` ← the same reference the Stripe session carries (\`${ref}\`), so the webhook can find the app's record.` : "`customId` ← the app's own order ID, so the webhook can find the record.",
      `\`shippingPreference\` \`${shipping}\`${shipping === "NO_SHIPPING" ? " (the Stripe session doesn't collect an address)" : " (the Stripe session collects an address)"}.`,
      ...(co?.params.customer_email ? [`Prefill the buyer's email (\`${co.params.customer_email}\`) as \`paymentSource.paypal.emailAddress\`.`] : []),
      `Send \`paypalRequestId\` (PayPal-Request-Id) so a retried request can't create a second order${co?.idempotencyKey ? ", as the Stripe call uses an idempotency key" : ""}.`,
      storeOrderId ? `Store the PayPal order ID the way the Stripe route stores the session ID (\`${storeOrderId.call}(…, { ${storeOrderId.field}: session.id })\` → \`paypalOrderId\`).` : "Store the PayPal order ID on the app's record.",
      ...(collide ? ["Name clash: the app already has a function called `createOrder`. Keep the SDK call qualified (`ordersController.createOrder`)."] : []),
      "Return the PayPal order ID as JSON; the buttons need it.",
    ],
    contextmatic: orderLookups,
  });
  addFile(isNext ? create : edit, createRouteFile, `POST ${apiBase}/orders`);

  // ---- Capture route.
  const successUrl = co?.successUrl;
  const captureLookups = [
    look("endpoint_search", "captureOrder", "Exact captureOrder signature and response"),
    look("model_search", "Order", "status, purchaseUnits[].payments.captures[]"),
  ];
  steps.push({
    id: "capture-route",
    title: `Add \`POST ${capturePath}\``,
    kind: isNext ? "create" : "edit",
    files: [captureRouteFile],
    details: [
      "Capture with `ordersController.captureOrder`, sending a PayPal-Request-Id.",
      "Only treat it as paid when the order status is `COMPLETED` and the capture status is `COMPLETED`; check the captured amount and currency against the app's own record.",
      `Then fulfil with ${fulfilText}, recording \`paymentProvider: "paypal"\`, the PayPal order ID and the capture ID (\`purchaseUnits[0].payments.captures[0].id\`).`,
      successUrl
        ? `Send the browser to the same success page Stripe uses (\`${successUrl}\`). It has no PayPal equivalent for \`{CHECKOUT_SESSION_ID}\`, so pass the app's own order ID.`
        : "Send the browser to the app's existing success page.",
    ],
    contextmatic: captureLookups,
  });
  addFile(isNext ? create : edit, captureRouteFile, `POST ${capturePath}`);

  // ---- PayPal webhook route and events.
  const events: EventPlan[] = [];
  for (const e of wh?.events ?? []) {
    const rule = ruleForEvent(e.type);
    const evNotes: string[] = [];
    if (rule?.notes) evNotes.push(rule.notes);
    // The event's data.object type is the event name minus its last part: "charge.refunded" carries a charge.
    const object = e.type.split(".").slice(0, -1).join(".");
    const shown = new Set<string>();
    const fields: string[] = [];
    for (const f of e.fieldsRead) {
      const top = f.split(".")[0];
      const fr = map.objectFields.find((o) => o.object === object && (o.stripe === f || o.stripe === top));
      if (!fr || shown.has(fr.stripe)) continue;
      shown.add(fr.stripe);
      fields.push(`\`${fr.stripe}\` → ${fr.paypal}`);
    }
    if (fields.length) evNotes.push(`Fields the Stripe handler reads: ${fields.join("; ")}.`);
    if (e.stripeCalls.length) evNotes.push(`The Stripe handler also calls ${e.stripeCalls.map((c) => `\`${c}\``).join(", ")}; on PayPal the same data is on the order (\`getOrder\`) or the capture.`);
    if (!rule) evNotes.push("Stripe-specific event with no PayPal counterpart in Portage's map; it stays on the Stripe webhook.");
    events.push({ stripe: e.type, paypal: rule?.paypal ?? null, status: rule?.status ?? "unknown", reuse: reuseOverride.get(e.type) ?? e.appCalls.map((c) => c.name), notes: evNotes });
  }
  if (!events.some((e) => e.paypal === "PAYMENT.CAPTURE.COMPLETED")) {
    events.push({ stripe: "(none)", paypal: "PAYMENT.CAPTURE.COMPLETED", status: "mapped", reuse: fulfil.length ? [fulfil[0].name] : inlineBranches.length ? [SHARED_FULFIL] : [], notes: ["Added so a payment is recorded even if the browser closes before the capture route answers."] });
  }
  if (refunds.length && !events.some((e) => e.paypal === "PAYMENT.CAPTURE.REFUNDED")) {
    events.push({ stripe: "(none)", paypal: "PAYMENT.CAPTURE.REFUNDED", status: "mapped", reuse: [], notes: ["Refunds made in the PayPal dashboard should update the app too."] });
  }
  plan.events = events;
  const refundEvent = wh?.events.find((e) => e.type === "charge.refunded");
  const webhookLookups = [
    look("ask", "Does the PayPal Server SDK include a method to verify webhook signatures?", "Already answered: no. Use the REST verification call"),
    ...(refundEvent ? [look("endpoint_search", "getCapturedPayment", "Capture status and refunded total after a refund event")] : []),
  ];
  steps.push({
    id: "webhook-route",
    title: `Add \`POST ${webhookPath}\``,
    kind: isNext ? "create" : "edit",
    files: [webhookRouteFile],
    details: [
      `Verify every event with \`POST /v1/notifications/verify-webhook-signature\` (PAYPAL_WEBHOOK_ID plus the PAYPAL-TRANSMISSION-ID, -TIME, -SIG, PAYPAL-CERT-URL and PAYPAL-AUTH-ALGO headers) and answer 400 when it fails, like the Stripe handler does for a bad signature.`,
      ...(isNext ? [] : ["It doesn't need the raw body: register it after `express.json()` or give it `express.json()` itself."]),
      ...events.filter((e) => e.paypal).map((e) => `\`${e.paypal}\`${e.stripe !== "(none)" ? ` (was \`${e.stripe}\`)` : ""}: ${e.reuse.length ? `call ${e.reuse.map((r) => `\`${r}\``).join(", ")}` : "update the app's record"}${e.status === "needs-human" ? " (needs a decision)" : ""}.`),
      "Find the app's record by `custom_id`, or by the stored PayPal order or capture ID. Make every branch idempotent: PayPal retries deliveries.",
      ...(refundEvent ? ["Refund events carry only that refund's amount, not Stripe's running `amount_refunded`. Read the capture (`getCapturedPayment`) for its status and total, or keep a running total, before calling the same refund-recording code."] : []),
      "Register the webhook URL in the PayPal developer dashboard (or through the PayPal API) for these event types; its ID is PAYPAL_WEBHOOK_ID.",
    ],
    contextmatic: webhookLookups,
  });
  addFile(isNext ? create : edit, webhookRouteFile, `POST ${webhookPath}`);

  // ---- Refunds.
  if (refunds.length) {
    const refundLookups = [look("endpoint_search", "refundCapturedPayment", "Exact refund signature"), look("model_search", "RefundRequest", "amount as Money for partial refunds")];
    steps.push({
      id: "refunds",
      title: "Refund PayPal orders through PayPal",
      kind: "edit",
      files: [...new Set(refunds.map((r) => r.file))],
      details: [
        ...refunds.map((r) => `${r.route ? `\`${routeLabel(r.route)}\` ` : ""}(${r.file}:${r.line}) refunds by \`${r.by}\`${r.source ? ` from \`${r.source}\`` : ""}${r.partial ? ", with optional partial amounts" : ""}.`),
        "Branch on the record's provider: PayPal records call `paymentsController.refundCapturedPayment` with the stored capture ID (an empty body is a full refund; a partial refund sends `amount` converted by the money helper) and a PayPal-Request-Id. Stripe records keep calling `stripe.refunds.create` unchanged.",
        "Accept a partial amount only if it is a positive whole number of minor units, before converting it (the money helper refuses anything else, and an invalid amount must never become a full refund).",
      ],
      contextmatic: refundLookups,
    });
    for (const r of refunds) addFile(edit, r.file, "Refund PayPal orders through PayPal");
  }

  // ---- Front end: the buttons.
  const triggers = app.triggers;
  const reactTrigger = triggers.find((t) => /\.(tsx|jsx)$/.test(t.file));
  const buttonsFile = reactTrigger ? join(dirOf(reactTrigger.file), `PayPalButtons.${ts ? "tsx" : "jsx"}`) : undefined;
  steps.push({
    id: "buttons",
    title: mode === "add" ? "Show PayPal buttons next to the existing checkout" : "Replace the Stripe checkout button with PayPal buttons",
    kind: "edit",
    files: [...new Set([...(buttonsFile ? [buttonsFile] : []), ...triggers.map((t) => t.file)])],
    details: [
      ...(triggers.length
        ? triggers.map((t) => `${t.file}:${t.line} starts checkout (\`${t.target}\`): \`${t.snippet}\``)
        : ["No checkout button was found by its route. Find where the UI starts checkout."]),
      reactTrigger
        ? `Create \`${buttonsFile}\`, a client component using \`${map.config.packages.react}\` (\`PayPalScriptProvider\`, \`PayPalButtons\`) that calls \`POST ${apiBase}/orders\` in \`createOrder\` and \`POST ${capturePath.replace(/\[orderId\]|:orderId/, "{id}")}\` in \`onApprove\`.`
        : `Load the PayPal JS SDK script with the public client ID and the order's currency, and render \`paypal.Buttons({ createOrder, onApprove, onCancel })\` calling \`POST ${apiBase}/orders\` and \`POST ${capturePath.replace(/\[orderId\]|:orderId/, "{id}")}\`.`,
      mode === "add" ? "Keep the existing Stripe button exactly as it is." : "Remove the Stripe button once the PayPal buttons work.",
      "onCancel returns to the page the buyer was on, like Stripe's cancel_url.",
    ],
    contextmatic: [],
  });
  if (buttonsFile) addFile(create, buttonsFile, "PayPal buttons (client component)");
  for (const t of triggers) addFile(edit, t.file, mode === "add" ? "Add PayPal buttons next to the Stripe checkout" : "Swap the Stripe checkout for PayPal buttons");

  // ---- Catalog.
  // In replace mode on Next.js the Stripe checkout route file is deleted, so it needs no other edits.
  const removedFiles = new Set(mode === "replace" && isNext && co?.route ? [co.route.file] : []);
  const catalogCalls = live(app.calls).filter((c) => c.status === "catalog" && !removedFiles.has(c.file));
  if (mode === "replace" && (priceItems.length || catalogCalls.length || live(app.calls).some((c) => c.status === "catalog"))) {
    plan.catalog = { needed: true, reason: "Prices come from the Stripe catalog, which goes away in replace mode. migrate_catalog copies products and prices once and writes portage.catalog.json." };
    steps.push({
      id: "catalog",
      title: "Copy the Stripe catalog and read prices from the copy",
      kind: "catalog",
      files: [join(prefix, "portage.catalog.json"), ...new Set(catalogCalls.map((c) => c.file))],
      details: [
        "Run migrate_catalog (dry run first): reads products and prices through the app's Stripe key and writes `portage.catalog.json` with the ID mapping.",
        ...[...new Set(catalogCalls.map((c) => `${c.file}:${c.line} reads the catalog with \`${c.path}\``))],
        "Switch those reads to the catalog file (or the app's own product table).",
      ],
      contextmatic: [],
    });
    for (const c of catalogCalls) addFile(edit, c.file, "Read prices from portage.catalog.json");
  } else {
    plan.catalog = {
      needed: false,
      reason:
        mode === "add"
          ? "Not needed: Stripe stays the source of prices, and one-time PayPal orders carry their own item names and amounts."
          : "Not needed: the app builds its prices itself.",
    };
  }

  // ---- Replace mode: what goes, and what stays for payments already taken with Stripe.
  if (mode === "replace") {
    if (co?.route) {
      if (isNext) addFile(remove, co.route.file, `Stripe checkout (${routeLabel(co.route)})`);
      else addFile(edit, co.route.file, `Remove the Stripe checkout route (${routeLabel(co.route)})`);
    }
    const clientPkgs = map.config.stripePackages.filter((p) => p !== "stripe" && app.clientSide.length);
    plan.dependencies.remove = clientPkgs;
    plan.env.remove = app.envVars.map((e) => e.name).filter((n) => /PUBLISHABLE/i.test(n));
    steps.push({
      id: "remove-stripe-checkout",
      title: "Remove Stripe checkout",
      kind: "remove",
      files: [...remove.map((r) => r.file)],
      details: [
        co?.route ? `Remove \`${routeLabel(co.route)}\` and the Stripe checkout button.` : "Remove the Stripe checkout.",
        ...(clientPkgs.length ? [`Remove ${clientPkgs.map((p) => `\`${p}\``).join(", ")} if nothing else uses them.`] : []),
        "Keep the Stripe client, the Stripe webhook and the Stripe refund branch for now: payments already taken with Stripe can still be refunded or disputed. Remove them once none are left.",
      ],
      contextmatic: [],
    });
    needsHuman.push({
      code: "STRIPE_HISTORY",
      severity: "needs-human",
      message: "Replace mode keeps the Stripe client, webhook and refunds for orders already paid with Stripe. Decide when it's safe to remove them.",
    });
  }

  // ---- Verify.
  steps.push({
    id: "verify",
    title: "Prove it with a real PayPal sandbox payment",
    kind: "verify",
    files: [],
    details: [
      "Typecheck and build the app.",
      "Run verify_checkout: buy something with the PayPal sandbox buyer, check the order is marked paid by the capture route and by the webhook, then refund it and check the order shows the refund.",
      mode === "add" ? "Run the app's existing Stripe checkout once more to confirm it still works." : "Confirm no new Stripe checkout can be started.",
    ],
    contextmatic: [],
  });

  // ---- Money.
  const currencies = new Set<string>();
  for (const c of checkouts) for (const cur of c.currencies) currencies.add(cur.toUpperCase());
  plan.money = [...currencies].sort().map((cur) => {
    const pe = paypalExponent(cur);
    if (pe === null) return { currency: cur, paypal: "unsupported" as const, note: "PayPal doesn't accept this currency; PayPal buttons can't be offered for these payments." };
    if (paypalInCountryOnly(cur)) return { currency: cur, paypal: "in-country-only" as const, note: "Only for PayPal accounts in that country." };
    if (stripeExponent(cur) > pe) return { currency: cur, paypal: "whole-units-only" as const, note: `PayPal takes whole ${cur}; Stripe amounts have ${stripeExponent(cur)} decimals.` };
    return { currency: cur, paypal: "ok" as const, note: `${pe} decimals on both sides; ${pe === 2 ? "2400 → \"24.00\"" : "amounts stay whole"}.` };
  });
  if (!currencies.size && priceItems.length) {
    notes.push({ code: "CURRENCY_AT_RUNTIME", severity: "info", message: "The currency comes from the Stripe price at run time; the money helper checks it on every order." });
  }

  // ---- What stays as it is (add mode).
  if (mode === "add") {
    plan.untouched = [
      ...checkouts.map((c) => `Stripe Checkout${c.route ? ` at \`${routeLabel(c.route)}\`` : ""} (${c.file}:${c.line})`),
      ...live(app.webhooks).map((w) => `Stripe webhook${w.route ? ` at \`${routeLabel(w.route)}\`` : ""} (${w.file}:${w.line})`),
      ...(refunds.length ? ["Stripe refunds for orders paid with Stripe"] : []),
      ...(catalogCalls.length ? ["The Stripe catalog as the source of prices"] : []),
    ];
  }

  plan.steps = steps;
  plan.files = { create, edit, remove };
  plan.needsHuman = dedupeIssues(needsHuman);
  plan.notes = dedupeIssues(notes);
  plan.contextmatic = lookups;
  plan.verify = {
    ...(triggers[0] ? { triggerFile: triggers[0].file } : {}),
    checkoutPath: `${apiBase}/orders`,
    webhookPath,
  };
  plan.status = "ready";
  const n = (k: number, word: string) => `${k} ${word}${k === 1 ? "" : "s"}`;
  plan.headline = [
    n(plan.routes.length, "new route"),
    n(create.length, "new file"),
    n(edit.length, "changed file"),
    ...(remove.length ? [n(remove.length, "removed file")] : []),
    n(plan.env.add.length, "new setting"),
    n(plan.needsHuman.length, "item") + " to review",
    "0 blockers",
  ].join(" · ");
  return plan;
}

/** The Next.js `app` or `pages` folder holding a route file: the first path segment with exactly that name inside the app root. */
function nextDir(routeFile: string | undefined, prefix: string, name: "app" | "pages"): string | undefined {
  if (!routeFile) return undefined;
  const segs = routeFile.split("/");
  const start = prefix ? prefix.split("/").filter(Boolean).length : 0;
  const i = segs.indexOf(name, start);
  return i >= 0 ? segs.slice(0, i + 1).join("/") : undefined;
}

function dedupeIssues(issues: Issue[]): Issue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const k = `${i.code}|${i.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
