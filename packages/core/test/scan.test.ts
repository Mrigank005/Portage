import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanRepo, type AppScan, type ScanResult } from "../src/index.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const suite = (name: string) => path.resolve(here, "../../../suite", name);
const fixture = (name: string) => path.join(here, "fixtures", name);
const only = (s: ScanResult): AppScan => {
  assert.equal(s.apps.length, 1, `expected one app, got ${s.apps.map((a) => a.root).join(", ")}`);
  return s.apps[0];
};
const codes = (a: { issues: { code: string }[] }) => a.issues.map((i) => i.code);

test("Brewbox (Next.js App Router): the whole payment surface", () => {
  const s = scanRepo(suite("brewbox-store"));
  assert.equal(s.supported, true);
  const app = only(s);
  assert.equal(app.framework.id, "next");
  assert.equal(app.framework.router, "app");
  assert.equal(app.language, "typescript");
  assert.deepEqual(app.issues.filter((i) => i.severity !== "info"), []);

  assert.equal(app.clients.length, 1);
  assert.equal(app.clients[0].file, "lib/stripe.ts");
  assert.equal(app.clients[0].keyEnv, "STRIPE_SECRET_KEY");
  assert.equal(app.clients[0].customHost, true);

  const co = app.checkouts[0];
  assert.deepEqual(co.route && [co.route.kind, co.route.method, co.route.path], ["next-app", "POST", "/api/checkout"]);
  assert.deepEqual(co.modes, ["payment"]);
  assert.deepEqual(co.lineItems, [{ kind: "price", expr: "priceId", quantity: "quantity" }]);
  assert.equal(co.params.client_reference_id, "order.id");
  assert.equal(co.usesSessionIdPlaceholder, true);
  assert.equal(co.response, "redirect");
  assert.deepEqual(co.sessionIdStoredAs.map((x) => x.field), ["stripeSessionId"]);
  assert.ok(co.appCalls.some((c) => c.name === "createOrder" && c.definedIn?.file === "lib/orders.ts"));

  const wh = app.webhooks[0];
  assert.deepEqual(wh.route && [wh.route.method, wh.route.path], ["POST", "/api/webhooks/stripe"]);
  assert.equal(wh.rawBody, "request.text()");
  assert.equal(wh.secretEnv, "STRIPE_WEBHOOK_SECRET");
  assert.deepEqual(wh.events.map((e) => e.type), ["checkout.session.completed", "charge.refunded"]);
  const done = wh.events[0];
  assert.deepEqual(done.appCalls.map((c) => [c.name, c.definedIn?.file]), [["fulfillOrder", "lib/fulfilment.ts"]]);
  assert.match(done.appCalls[0].params ?? "", /paymentIntentId/);
  assert.ok(done.fieldsRead.includes("client_reference_id") && done.fieldsRead.includes("payment_status"));
  assert.deepEqual(wh.events[1].appCalls.map((c) => c.name), ["recordRefund"]);
  assert.ok(wh.events[1].fieldsRead.includes("amount_refunded"));

  const rf = app.refunds[0];
  assert.deepEqual([rf.route?.path, rf.by, rf.sourceField, rf.partial], ["/api/admin/refund", "payment_intent", "paymentIntentId", true]);

  assert.deepEqual(app.calls.map((c) => c.path).sort(), ["checkout.sessions.create", "prices.retrieve", "products.list", "refunds.create", "webhooks.constructEvent"]);
  assert.ok(app.calls.every((c) => c.confidence === "high"));
  assert.deepEqual(app.triggers.map((t) => [t.file, t.target]), [["app/page.tsx", "POST /api/checkout"]]);
  const order = app.dataModel.filter((d) => d.entity === "Order").map((d) => d.field);
  assert.deepEqual(order, ["stripeSessionId", "paymentIntentId"]);
  assert.deepEqual(app.envVars.map((e) => e.name), ["STRIPE_API_BASE", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]);
});

test("Quill (Express): inline price data, express.raw webhook, inline fulfilment", () => {
  const app = only(scanRepo(suite("quill-saas")));
  assert.equal(app.framework.id, "express");
  assert.equal(app.supported, true);
  const co = app.checkouts[0];
  assert.deepEqual(co.route && [co.route.kind, co.route.method, co.route.path], ["express", "POST", "/checkout"]);
  assert.equal(co.lineItems[0].kind, "price_data");
  assert.equal(co.lineItems[0].currency, "usd");
  assert.equal(co.lineItems[0].unitAmount, "pack.cents");
  assert.equal(co.params.customer_email, "email");
  assert.deepEqual(co.currencies, ["usd"]);
  const wh = app.webhooks[0];
  assert.deepEqual(wh.route && [wh.route.method, wh.route.path], ["POST", "/webhooks/stripe"]);
  assert.equal(wh.rawBody, "express.raw()");
  const done = wh.events.find((e) => e.type === "checkout.session.completed")!;
  assert.deepEqual(done.appCalls.map((c) => c.name), ["getPurchase", "updatePurchase", "addCredits"]);
  assert.deepEqual(done.stripeCalls, ["checkout.sessions.listLineItems"]);
  assert.ok(done.appCalls.every((c) => c.definedIn?.file === "src/db.ts"));
  assert.deepEqual(app.refunds.map((r) => [r.route?.path, r.partial]), [["/admin/refund", true]]);
  assert.deepEqual(app.triggers.map((t) => t.file), ["src/server.ts"]);
  assert.deepEqual(app.dataModel.filter((d) => d.entity === "Purchase").map((d) => d.field), ["sessionId", "paymentIntentId"]);
});

test("Ledgerline (Python Flask) is refused, naming what was found", () => {
  const s = scanRepo(suite("ledgerline-flask"));
  assert.equal(s.supported, false);
  assert.equal(s.apps.length, 0);
  assert.deepEqual(codes(s), ["LANGUAGE_UNSUPPORTED"]);
  assert.match(s.issues[0].message, /Python/);
  assert.match(s.issues[0].message, /Nothing was changed/);
  assert.deepEqual(s.otherLanguages.map((o) => o.what), ["imports stripe-python", "creates a Checkout session", "verifies Stripe webhooks", "creates refunds"]);
});

test("CommonJS sample: require('stripe')(key) is traced, tests are ignored, name-only matches are flagged", () => {
  const app = only(scanRepo(fixture("express-commonjs")));
  assert.equal(app.supported, true);
  assert.equal(app.language, "javascript");
  const live = app.calls.filter((c) => !c.inTest);
  assert.deepEqual(live.filter((c) => c.confidence === "high").map((c) => c.path).sort(), ["checkout.sessions.create", "webhooks.constructEvent"]);
  assert.deepEqual(live.filter((c) => c.confidence === "medium").map((c) => [c.path, c.file]), [["refunds.create", "lib/refunds.js"]]);
  assert.ok(app.calls.some((c) => c.inTest && c.file === "test/checkout.test.js"));
  assert.ok(!codes(app).includes("SUBSCRIPTIONS_STAY"), "a subscription in a test file must not count");
  assert.ok(codes(app).includes("NAME_MATCH_ONLY"));
  const co = app.checkouts.find((c) => !c.inTest)!;
  assert.equal(co.idempotencyKey, true);
  assert.equal(co.lineItems[0].priceId, "price_1Px8k2EXAMPLEabcd");
  assert.ok(app.issues.some((i) => i.code === "PARAM_NEEDS_HUMAN" && i.message.includes("allow_promotion_codes")));
  const wh = app.webhooks[0];
  assert.deepEqual([wh.route?.path, wh.rawBody], ["/webhook", "express.raw()"]);
  assert.deepEqual(wh.events.map((e) => [e.type, e.appCalls.map((c) => c.name).join()]), [
    ["checkout.session.completed", "fulfillCheckout"],
    ["checkout.session.async_payment_succeeded", "fulfillCheckout"],
  ]);
  assert.deepEqual(app.triggers.map((t) => t.file), ["public/index.html"]);
  assert.deepEqual(app.envExampleFiles, [{ file: ".env.example", keys: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "DOMAIN"] }]);
});

test("Stripe Connect stops the run", () => {
  const app = only(scanRepo(fixture("next-connect")));
  assert.equal(app.supported, false);
  const connect = app.issues.find((i) => i.code === "STRIPE_CONNECT")!;
  assert.equal(connect.severity, "blocker");
  assert.ok(connect.where!.some((w) => w.file === "app/api/onboard/route.ts"));
  assert.ok(connect.where!.some((w) => w.file === "app/api/checkout/route.ts"), "application_fee_amount on the session is Connect too");
});

test("Elements-only and subscription-only apps are out of scope, with the reason", () => {
  const el = only(scanRepo(fixture("elements-only")));
  assert.equal(el.supported, false);
  assert.ok(codes(el).includes("ELEMENTS_ONLY"));
  assert.ok(el.clientSide.some((c) => c.kind === "elements"));
  const sub = only(scanRepo(fixture("subscriptions-only")));
  assert.equal(sub.supported, false);
  assert.ok(codes(sub).includes("SUBSCRIPTIONS_ONLY"));
});

test("Pages Router: lazy client factory, path alias, micro buffer, and HUF prices", () => {
  const app = only(scanRepo(fixture("pages-router")));
  assert.equal(app.framework.router, "pages");
  assert.equal(app.supported, true);
  assert.ok(app.calls.every((c) => c.confidence === "high"), "getStripe() is traced to new Stripe()");
  const co = app.checkouts[0];
  assert.deepEqual(co.route && [co.route.kind, co.route.method, co.route.path], ["next-pages", "POST", "/api/checkout"]);
  assert.ok("shipping_address_collection" in co.params);
  assert.equal(app.webhooks[0].rawBody, "raw body helper");
  assert.deepEqual(app.webhooks[0].events[0].appCalls.map((c) => [c.name, c.definedIn?.file]), [["markPaid", "lib/orders.ts"]]);
  assert.ok(codes(app).includes("PAGES_ROUTER"));
  const precision = app.issues.find((i) => i.code === "CURRENCY_PRECISION")!;
  assert.equal(precision.severity, "needs-human");
  assert.match(precision.message, /10\.45 HUF/);
});

test("Unsupported framework and no Stripe at all", () => {
  const f = only(scanRepo(fixture("fastify-app")));
  assert.equal(f.supported, false);
  assert.match(f.issues.find((i) => i.code === "FRAMEWORK_UNSUPPORTED")!.message, /Fastify/);
  const none = scanRepo(fixture("no-stripe"));
  assert.equal(none.supported, false);
  assert.deepEqual(codes(none), ["NO_STRIPE"]);
});

test("Monorepo: finds the app that uses Stripe, follows a renamed client, notes the Python service", () => {
  const s = scanRepo(fixture("monorepo"));
  const app = only(s);
  assert.equal(app.root, "apps/web");
  assert.equal(app.name, "@acme/web");
  assert.deepEqual(app.calls.map((c) => [c.path, c.confidence]), [["checkout.sessions.create", "high"]]);
  assert.deepEqual(app.dataModel.map((d) => [d.entity, d.field, d.file]), [["orders", "stripeCheckoutSessionId", "apps/web/lib/schema.ts"]]);
  assert.deepEqual(codes(s), ["OTHER_LANGUAGES"]);
  assert.equal(s.supported, true);
});

test("Patterns from real open-source apps: server actions, params built in branches, event.type copied later", () => {
  const app = only(scanRepo(fixture("next-server-action")));
  assert.equal(app.supported, true);
  const co = app.checkouts[0];
  assert.deepEqual(co.route && [co.route.kind, co.route.path], ["next-action", "startCheckout"]);
  assert.deepEqual(co.modes, ["subscription", "payment"], "both branches' modes are possible");
  assert.equal(co.params.ui_mode, "elements");
  assert.equal(co.response, "client-secret");
  assert.ok(codes(app).includes("SUBSCRIPTIONS_STAY"));
  assert.ok(codes(app).includes("CHECKOUT_CUSTOM_UI"));
  assert.ok(!codes(app).includes("CHECKOUT_ROUTE_UNKNOWN"));
  assert.deepEqual(app.triggers.map((t) => [t.file, t.target]), [["components/Buy.tsx", "server action startCheckout"]]);
  const wh = app.webhooks[0];
  assert.deepEqual(wh.events.map((e) => [e.type, e.appCalls.map((c) => c.name).join()]), [["checkout.session.completed", "grantAccess"]]);
});

test("Never reads real env files, and never prints env values", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "portage-scan-"));
  try {
    fs.cpSync(fixture("express-commonjs"), tmp, { recursive: true });
    fs.writeFileSync(path.join(tmp, ".env"), "STRIPE_SECRET_KEY=sk_test_REAL_SECRET_MUST_NOT_APPEAR\nSTRIPE_SECRET_EXTRA=1\n");
    fs.writeFileSync(path.join(tmp, ".env.local"), "STRIPE_WEBHOOK_SECRET=whsec_REAL_SECRET_MUST_NOT_APPEAR\n");
    const out = JSON.stringify(scanRepo(tmp));
    assert.ok(!out.includes("REAL_SECRET_MUST_NOT_APPEAR"));
    assert.ok(!out.includes("STRIPE_SECRET_EXTRA"), "keys from a real .env must not leak either");
    assert.ok(!out.includes("placeholder_value"), "example files contribute key names only");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("The scan is read-only and deterministic", () => {
  const dir = suite("brewbox-store");
  const snapshot = () =>
    fs
      .readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && !String(e.parentPath ?? "").includes("node_modules") && !String(e.parentPath ?? "").includes(".next"))
      .map((e) => {
        const p = path.join(e.parentPath, e.name);
        return `${p}:${fs.statSync(p).mtimeMs}`;
      })
      .sort()
      .join("\n");
  const before = snapshot();
  const a = scanRepo(dir);
  const b = scanRepo(dir);
  assert.equal(snapshot(), before);
  a.stats.ms = b.stats.ms = 0;
  assert.deepEqual(a, b);
});

test("A path that isn't a folder is a clear error", () => {
  assert.throws(() => scanRepo(path.join(here, "does-not-exist")), /Not a folder/);
});
