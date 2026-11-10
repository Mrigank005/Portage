import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadMap, planMigration, renderPlan, scanRepo, type Plan } from "../src/index.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const suite = (name: string) => path.resolve(here, "../../../suite", name);
const fixture = (name: string) => path.join(here, "fixtures", name);
const files = (p: Plan, kind: keyof Plan["files"]) => p.files[kind].map((f) => f.file);
const map = loadMap();

/** Every SDK method the plan asks the agent to look up is one the map has confirmed. */
function lookupsAreConfirmed(p: Plan) {
  const methods = new Set(map.paypalSdk.methods.map((m) => m.split(".")[1]));
  const models = new Set(map.paypalSdk.models);
  for (const l of p.contextmatic) {
    if (l.tool === "endpoint_search") assert.ok(methods.has(l.query), `unconfirmed method ${l.query}`);
    if (l.tool === "model_search") assert.ok(models.has(l.query), `unconfirmed model ${l.query}`);
  }
  assert.equal(p.contextmatic[0].tool, "fetch_api");
}

test("Brewbox, add mode: new routes in the App Router, existing fulfilment reused", () => {
  const p = planMigration(scanRepo(suite("brewbox-store")));
  assert.equal(p.status, "ready");
  assert.equal(p.mode, "add");
  assert.deepEqual(files(p, "create"), [
    "lib/paypal.ts",
    "lib/paypal-money.ts",
    "app/api/paypal/orders/route.ts",
    "app/api/paypal/orders/[orderId]/capture/route.ts",
    "app/api/webhooks/paypal/route.ts",
    "app/PayPalButtons.tsx",
  ]);
  assert.deepEqual(files(p, "edit").sort(), [".env.example", "app/api/admin/refund/route.ts", "app/page.tsx", "lib/fulfilment.ts", "lib/orders.ts", "package.json"]);
  assert.deepEqual(files(p, "remove"), []);
  assert.deepEqual(p.routes.map((r) => `${r.method} ${r.path}`), ["POST /api/paypal/orders", "POST /api/paypal/orders/[orderId]/capture", "POST /api/webhooks/paypal"]);
  assert.deepEqual(p.dependencies.add, ["@paypal/paypal-server-sdk", "@paypal/react-paypal-js"]);
  assert.deepEqual(
    p.events.map((e) => [e.stripe, e.paypal, e.reuse.join()]),
    [
      ["checkout.session.completed", "PAYMENT.CAPTURE.COMPLETED", "fulfillOrder"],
      ["charge.refunded", "PAYMENT.CAPTURE.REFUNDED", "recordRefund"],
    ],
  );
  assert.deepEqual(p.dataModel.map((d) => [d.entity, d.file]), [["Order", "lib/orders.ts"]]);
  assert.ok(p.steps.some((s) => s.id === "fulfilment" && s.title.includes("fulfillOrder")), "fulfillOrder takes Stripe-shaped arguments");
  assert.ok(p.steps.find((s) => s.id === "create-order-route")!.details.some((d) => d.includes("Name clash")), "the app has its own createOrder");
  assert.equal(p.catalog.needed, false);
  assert.deepEqual(p.needsHuman, []);
  assert.ok(p.env.add.some((e) => e.name === "NEXT_PUBLIC_PAYPAL_CLIENT_ID"));
  assert.ok(p.untouched.some((u) => u.includes("POST /api/checkout")));
  lookupsAreConfirmed(p);
  const md = renderPlan(p);
  assert.match(md, /Nothing has been changed yet/);
  assert.ok(!md.includes("``"), "no broken inline code in the Markdown");
});

test("Brewbox, replace mode: catalog copied, Stripe checkout removed, Stripe history kept", () => {
  const p = planMigration(scanRepo(suite("brewbox-store")), { mode: "replace" });
  assert.equal(p.status, "ready");
  assert.equal(p.catalog.needed, true);
  assert.deepEqual(files(p, "remove"), ["app/api/checkout/route.ts"]);
  assert.ok(!files(p, "edit").includes("app/api/checkout/route.ts"), "a removed file gets no edits");
  assert.ok(files(p, "edit").includes("app/page.tsx"));
  assert.ok(p.steps.some((s) => s.id === "catalog"));
  assert.ok(p.needsHuman.some((i) => i.code === "STRIPE_HISTORY"));
  assert.ok(p.steps.find((s) => s.id === "create-order-route")!.details.some((d) => d.includes("portage.catalog.json")));
});

test("Quill, add mode: routes added to the Express server, inline logic extracted into shared functions", () => {
  const p = planMigration(scanRepo(suite("quill-saas")));
  assert.equal(p.status, "ready");
  assert.deepEqual(files(p, "create"), ["src/paypal.ts", "src/paypal-money.ts"]);
  assert.deepEqual(files(p, "edit").sort(), [".env.example", "package.json", "src/db.ts", "src/server.ts"]);
  assert.deepEqual(p.routes.map((r) => `${r.method} ${r.path} ${r.file}`), [
    "POST /paypal/orders src/server.ts",
    "POST /paypal/orders/:orderId/capture src/server.ts",
    "POST /webhooks/paypal src/server.ts",
  ]);
  assert.deepEqual(p.dependencies.add, ["@paypal/paypal-server-sdk"], "server-rendered HTML needs no React package");
  const shared = p.steps.find((s) => s.id === "shared-handlers")!;
  assert.equal(shared.details.length, 3);
  assert.deepEqual(p.events.map((e) => [e.paypal, e.reuse.join()]), [
    ["PAYMENT.CAPTURE.COMPLETED", "fulfilPayment"],
    ["PAYMENT.CAPTURE.REFUNDED", "recordPaymentRefund"],
  ]);
  assert.deepEqual(p.money, [{ currency: "USD", paypal: "ok", note: '2 decimals on both sides; 2400 → "24.00".' }]);
  assert.ok(p.steps.find((s) => s.id === "create-order-route")!.details.some((d) => d.includes("NO_SHIPPING")));
  assert.ok(p.steps.find((s) => s.id === "create-order-route")!.details.some((d) => d.includes("emailAddress")));
  assert.ok(p.events[1].notes.some((n) => n.includes("running")), "refund events don't carry Stripe's running total");
  lookupsAreConfirmed(p);
});

test("Ledgerline: a blocked plan with no steps", () => {
  const p = planMigration(scanRepo(suite("ledgerline-flask")));
  assert.equal(p.status, "blocked");
  assert.deepEqual(p.steps, []);
  assert.deepEqual(p.blockers.map((b) => b.code), ["LANGUAGE_UNSUPPORTED"]);
  assert.match(p.headline, /^Blocked: .*Python/);
  assert.match(renderPlan(p), /Nothing was changed\.$/);
});

test("Connect is blocked; asking for an app that doesn't exist is blocked", () => {
  assert.equal(planMigration(scanRepo(fixture("next-connect"))).blockers[0].code, "STRIPE_CONNECT");
  const p = planMigration(scanRepo(suite("quill-saas")), { app: "nope" });
  assert.equal(p.status, "blocked");
  assert.ok(p.blockers.some((b) => b.code === "APP_NOT_FOUND"));
});

test("CommonJS Express sample: plain HTML buttons, webhook path derived, review items carried over", () => {
  const p = planMigration(scanRepo(fixture("express-commonjs")));
  assert.equal(p.status, "ready");
  assert.deepEqual(p.routes.map((r) => r.path), ["/paypal/orders", "/paypal/orders/:orderId/capture", "/paypal/webhook"]);
  assert.deepEqual(p.dependencies.add, ["@paypal/paypal-server-sdk"]);
  assert.ok(p.needsHuman.some((i) => i.message.includes("allow_promotion_codes")));
  assert.ok(files(p, "edit").includes("public/index.html"));
  assert.deepEqual(p.events.filter((e) => e.paypal === "PAYMENT.CAPTURE.COMPLETED").map((e) => e.reuse.join()), ["fulfillCheckout", "fulfillCheckout"]);
});

test("Pages Router: new routes go under pages/api, and an address-collecting checkout keeps shipping", () => {
  const p = planMigration(scanRepo(fixture("pages-router")));
  assert.equal(p.status, "ready");
  assert.deepEqual(p.routes.map((r) => r.file), ["pages/api/paypal/orders.ts", "pages/api/paypal/orders/[orderId]/capture.ts", "pages/api/paypal/webhook.ts"]);
  assert.ok(p.steps.find((s) => s.id === "create-order-route")!.details.some((d) => d.includes("GET_FROM_FILE")));
  assert.deepEqual(p.money.map((m) => [m.currency, m.paypal]), [["HUF", "whole-units-only"]]);
  assert.ok(p.needsHuman.some((i) => i.code === "CURRENCY_PRECISION"));
  assert.ok(p.needsHuman.some((i) => i.code === "PAGES_ROUTER"));
});

test("Monorepo: every path is inside the app's folder", () => {
  const p = planMigration(scanRepo(fixture("monorepo")));
  assert.equal(p.app.root, "apps/web");
  for (const f of [...files(p, "create"), ...files(p, "edit")]) assert.ok(f.startsWith("apps/web/"), f);
  assert.ok(files(p, "create").includes("apps/web/app/api/paypal/orders/route.ts"));
  assert.ok(files(p, "create").includes("apps/web/lib/paypal.ts"));
  assert.deepEqual(p.money.map((m) => [m.currency, m.paypal]), [["JPY", "ok"]]);
  assert.deepEqual(p.dataModel.map((d) => d.entity), ["orders"]);
});

test("Server-action checkout: plan still adds API routes, mirrors the action, and reuses its fulfilment", () => {
  const p = planMigration(scanRepo(fixture("next-server-action")));
  assert.equal(p.status, "ready");
  assert.deepEqual(p.routes.map((r) => r.file), ["app/api/paypal/orders/route.ts", "app/api/paypal/orders/[orderId]/capture/route.ts", "app/api/paypal/webhook/route.ts"]);
  assert.ok(p.steps.find((s) => s.id === "create-order-route")!.details[0].includes("server action startCheckout"));
  assert.deepEqual(p.events.map((e) => [e.paypal, e.reuse.join()]), [["PAYMENT.CAPTURE.COMPLETED", "grantAccess"]]);
  assert.ok(p.needsHuman.some((i) => i.code === "CHECKOUT_CUSTOM_UI"));
});

test("Multi-app repos: the plan says which app it chose and how to choose another", () => {
  const s = scanRepo(fixture("monorepo"));
  const p = planMigration({ ...s, apps: [...s.apps, { ...s.apps[0], root: "apps/shop", name: "@acme/shop" }] });
  assert.equal(p.app.root, "apps/web");
  assert.ok(p.notes.some((n) => n.code === "OTHER_APPS" && n.message.includes("`apps/shop`")));
});

test("Plans are deterministic", () => {
  const a = planMigration(scanRepo(suite("quill-saas")));
  const b = planMigration(scanRepo(suite("quill-saas")));
  assert.deepEqual(a, b);
});
