// Standin tests. They use the official `stripe` SDK against Standin, verify webhooks with the SDK's own
// signature check, and validate every object type against Stripe's public OpenAPI spec.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import Stripe from "stripe";
import { startStandin, type RunningStandin } from "../src/server.ts";
import { signPayload } from "../src/webhooks.ts";
import { makeValidator } from "./spec.ts";

const KEY = "sk_test_unit";
const SECRET = "whsec_unit";
let standin: RunningStandin;
let stripe: Stripe;
let spec: Awaited<ReturnType<typeof makeValidator>>;
let hook: { server: http.Server; port: number; received: { headers: http.IncomingHttpHeaders; body: string }[] };

const base = () => `http://127.0.0.1:${standin.port}`;

async function raw(method: string, path: string, form?: Record<string, string>, key: string | null = KEY) {
  const res = await fetch(`${base()}${path}`, {
    method,
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    body: form ? new URLSearchParams(form) : undefined,
  });
  return { status: res.status, headers: res.headers, json: (await res.json()) as any };
}

before(async () => {
  spec = await makeValidator();
  standin = await startStandin({ port: 0, host: "127.0.0.1", webhookSecret: SECRET, statePath: null });
  stripe = new Stripe(KEY, { host: "127.0.0.1", port: standin.port, protocol: "http", maxNetworkRetries: 0, telemetry: false });
  const received: typeof hook.received = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(200).end("ok");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  hook = { server, port: (server.address() as any).port, received };
});

after(async () => {
  await standin.close();
  hook.server.closeAllConnections();
  await new Promise((r) => hook.server.close(r));
});

test("targets the Stripe API version the spec describes", () => {
  assert.equal(spec.specVersion, "2026-10-28.endive");
});

test("products and prices match Stripe's spec, including expansion", async () => {
  const created = await raw("POST", "/v1/products", {
    name: "House Blend Beans, 1 lb",
    description: "Medium roast whole beans",
    "default_price_data[currency]": "usd",
    "default_price_data[unit_amount]": "1800",
    "metadata[slug]": "house-blend",
  });
  assert.equal(created.status, 200);
  spec.validate("product", created.json);
  assert.equal(created.json.metadata.slug, "house-blend");

  const price = await raw("GET", `/v1/prices/${created.json.default_price}`);
  spec.validate("price", price.json);
  assert.equal(price.json.unit_amount, 1800);
  assert.equal(price.json.unit_amount_decimal, "1800");

  const listed = await raw("GET", "/v1/products?limit=5&active=true&expand[]=data.default_price");
  assert.equal(listed.status, 200);
  assert.equal(listed.json.object, "list");
  for (const p of listed.json.data) spec.validate("product", p);
  assert.equal(listed.json.data[0].default_price.object, "price");

  const viaSdk = await stripe.products.list({ limit: 5, expand: ["data.default_price"] });
  assert.equal((viaSdk.data[0].default_price as Stripe.Price).unit_amount, 1800);

  const bad = await raw("GET", "/v1/products?expand[]=data.nonsense");
  assert.equal(bad.status, 400);
  assert.match(bad.json.error.message, /cannot be expanded/);

  // shippable, url and images round-trip and stay within Stripe's spec.
  const kit = await stripe.products.create({ name: "Pour-Over Kit", shippable: true, url: "https://example.com/kit", images: ["https://example.com/kit.png"] });
  assert.deepEqual([kit.shippable, kit.url, kit.images], [true, "https://example.com/kit", ["https://example.com/kit.png"]]);
  spec.validate("product", (await raw("GET", `/v1/products/${kit.id}`)).json);
  const notBool = await raw("POST", "/v1/products", { name: "x", shippable: "maybe" });
  assert.equal(notBool.status, 400);
});

test("checkout, payment, webhooks and refunds work end to end with the official SDK", async () => {
  // Register a webhook endpoint through the API.
  const endpoint = await raw("POST", "/v1/webhook_endpoints", {
    url: `http://127.0.0.1:${hook.port}/hook`,
    "enabled_events[0]": "charge.succeeded",
    "enabled_events[1]": "payment_intent.succeeded",
    "enabled_events[2]": "checkout.session.completed",
    "enabled_events[3]": "charge.refunded",
  });
  assert.equal(endpoint.status, 200);
  spec.validate("webhook_endpoint", endpoint.json);
  assert.equal(endpoint.json.secret, SECRET);

  const product = await stripe.products.create({ name: "Pour-Over Starter Kit", default_price_data: { currency: "usd", unit_amount: 4900 } });
  const priceId = product.default_price as string;

  // Create a Checkout Session the way a real app does.
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{ price: priceId, quantity: 2 }],
    success_url: "http://shop.test/order/ord_1?session_id={CHECKOUT_SESSION_ID}",
    cancel_url: "http://shop.test/cart",
    client_reference_id: "ord_1",
    metadata: { orderId: "ord_1" },
  });
  assert.equal(session.amount_total, 9800);
  assert.equal(session.payment_status, "unpaid");
  assert.match(session.url!, /\/pay\/cs_test_/);
  const rawSession = await raw("GET", `/v1/checkout/sessions/${session.id}`);
  spec.validate("checkout.session", rawSession.json);

  // The hosted pay page renders, then a test-card payment redirects to success_url.
  const page = await fetch(session.url!.replace("localhost", "127.0.0.1"));
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Pay \$98\.00/);
  const paid = await fetch(`${base()}/pay/${session.id}`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: "buyer@example.test", name: "Test Buyer", cardNumber: "4242 4242 4242 4242", exp: "12 / 34", cvc: "123" }),
  });
  assert.equal(paid.status, 303);
  assert.equal(paid.headers.get("location"), `http://shop.test/order/ord_1?session_id=${session.id}`);

  // Three webhooks arrive, each signed so the official SDK accepts it. Deliveries run in parallel, so (as on
  // Stripe) arrival order is not guaranteed; the order they were emitted in is.
  await standin.idle();
  assert.equal(hook.received.length, 3);
  const types: string[] = [];
  for (const r of hook.received) {
    const event = stripe.webhooks.constructEvent(r.body, r.headers["stripe-signature"] as string, SECRET);
    spec.validate("event", JSON.parse(r.body));
    types.push(event.type);
    const objectSchema = event.type.startsWith("charge.") ? "charge" : event.type.startsWith("payment_intent.") ? "payment_intent" : "checkout.session";
    spec.validate(objectSchema, event.data.object);
  }
  const expectedOrder = ["charge.succeeded", "payment_intent.succeeded", "checkout.session.completed"];
  assert.deepEqual([...types].sort(), [...expectedOrder].sort());
  const emitted = standin.store.state.accounts[KEY].events.map((e) => e.type);
  assert.deepEqual(emitted, expectedOrder);

  // Fulfilment-style lookups an app makes after the webhook.
  const full = await stripe.checkout.sessions.retrieve(session.id, { expand: ["line_items"] });
  assert.equal(full.payment_status, "paid");
  assert.equal(full.customer_details?.email, "buyer@example.test");
  assert.equal(full.line_items!.data[0].quantity, 2);
  assert.equal(full.line_items!.data[0].description, "Pour-Over Starter Kit");
  const lineItems = await raw("GET", `/v1/checkout/sessions/${session.id}/line_items`);
  assert.equal(lineItems.json.data.length, 1);
  for (const li of lineItems.json.data) spec.validate("item", li);
  const finalSession = await raw("GET", `/v1/checkout/sessions/${session.id}`);
  spec.validate("checkout.session", finalSession.json);

  const pi = await raw("GET", `/v1/payment_intents/${full.payment_intent}`);
  spec.validate("payment_intent", pi.json);
  assert.equal(pi.json.status, "succeeded");
  const charge = await raw("GET", `/v1/charges/${pi.json.latest_charge}`);
  spec.validate("charge", charge.json);
  assert.equal(charge.json.payment_method_details.card.last4, "4242");

  // Partial refund, then the rest, then an over-refund.
  hook.received.length = 0;
  const first = await stripe.refunds.create({ payment_intent: full.payment_intent as string, amount: 2500 });
  assert.equal(first.amount, 2500);
  await standin.idle();
  assert.equal(hook.received.length, 1);
  const refundEvent = stripe.webhooks.constructEvent(hook.received[0].body, hook.received[0].headers["stripe-signature"] as string, SECRET);
  assert.equal(refundEvent.type, "charge.refunded");
  assert.equal((refundEvent.data.object as Stripe.Charge).amount_refunded, 2500);
  assert.equal((refundEvent.data.object as Stripe.Charge).refunded, false);
  spec.validate("refund", (await raw("GET", `/v1/refunds/${first.id}`)).json);

  const tooMuch = await raw("POST", "/v1/refunds", { payment_intent: full.payment_intent as string, amount: "999999" });
  assert.equal(tooMuch.status, 400);
  const rest = await stripe.refunds.create({ payment_intent: full.payment_intent as string });
  assert.equal(rest.amount, 7300);
  const again = await raw("POST", "/v1/refunds", { payment_intent: full.payment_intent as string });
  assert.equal(again.status, 400);
  assert.equal(again.json.error.code, "charge_already_refunded");
  const refunds = await raw("GET", `/v1/refunds?payment_intent=${full.payment_intent}`);
  assert.equal(refunds.json.data.length, 2);
  assert.equal((await raw("GET", `/v1/charges/${pi.json.latest_charge}`)).json.refunded, true);

  await standin.idle();
  assert.equal(standin.deliveries.length, 5);
  assert.ok(standin.deliveries.every((d) => d.ok), "every webhook delivery succeeded");

  // Events can be listed and retrieved; pending_webhooks has counted down to zero as endpoints accepted them.
  const events = await raw("GET", "/v1/events?limit=100");
  assert.equal(events.json.data.length, 5);
  assert.equal(events.json.data[0].type, "charge.refunded", "newest first");
  for (const e of events.json.data) {
    spec.validate("event", e);
    assert.equal(e.pending_webhooks, 0);
  }
  const completed = await raw("GET", "/v1/events?type=checkout.session.completed");
  assert.equal(completed.json.data.length, 1);
  const one = await raw("GET", `/v1/events/${completed.json.data[0].id}`);
  assert.equal(one.json.data.object.id, session.id);
  assert.equal((await raw("GET", "/v1/events/evt_missing")).status, 404);
});

test("control: the spec check really rejects objects that don't match", async () => {
  const product = (await raw("POST", "/v1/products", { name: "Control", "default_price_data[currency]": "usd", "default_price_data[unit_amount]": "100" })).json;
  spec.validate("product", product); // the real thing passes

  const mutations: [string, string, (o: any) => void][] = [
    ["product", "missing required field", (o) => delete o.name],
    ["product", "wrong type", (o) => (o.active = "yes")],
    ["product", "wrong object tag", (o) => (o.object = "price")],
    ["product", "wrong type on metadata", (o) => (o.metadata = [1, 2])],
    ["product", "a field the spec does not declare", (o) => (o.invented_field = "x")],
    ["product", "a field Stripe has removed", (o) => (o.type = "service")],
  ];
  for (const [schema, why, mutate] of mutations) {
    const copy = structuredClone(product);
    mutate(copy);
    assert.throws(() => spec.validate(schema, copy), /does not match Stripe's OpenAPI spec/, `${schema}: ${why} should be rejected`);
  }

  const price = (await raw("GET", `/v1/prices/${product.default_price}`)).json;
  const badPrice = { ...price, type: "sometimes" }; // not one of the allowed enum values
  assert.throws(() => spec.validate("price", badPrice), /allowedValues|enum|one of/i);

  const session = (await stripe.checkout.sessions.create({ mode: "payment", line_items: [{ price: price.id, quantity: 1 }], success_url: "http://x.test/ok" })) as any;
  const rawSession = (await raw("GET", `/v1/checkout/sessions/${session.id}`)).json;
  spec.validate("checkout.session", rawSession);
  assert.throws(() => spec.validate("checkout.session", { ...rawSession, status: "bogus" }), /does not match/);
  const { mode: _omit, ...withoutMode } = rawSession;
  assert.throws(() => spec.validate("checkout.session", withoutMode), /mode/);
  assert.throws(() => spec.validate("checkout.session", { ...rawSession, total_details: { ...rawSession.total_details, made_up: 1 } }), /total_details\/made_up is not declared/);
});

test("the official SDK rejects a webhook with a bad signature", () => {
  const payload = JSON.stringify({ id: "evt_x", object: "event", type: "charge.succeeded", data: { object: {} } });
  assert.throws(() => stripe.webhooks.constructEvent(payload, signPayload(payload, "whsec_wrong"), SECRET), /signature/i);
  const stale = signPayload(payload, SECRET, Math.floor(Date.now() / 1000) - 3600);
  assert.throws(() => stripe.webhooks.constructEvent(payload, stale, SECRET), /tolerance|timestamp/i);
});

test("a declined test card keeps the session open and sends no events", async () => {
  await standin.idle(); // nothing from earlier tests still in flight
  hook.received.length = 0;
  const price = (await raw("POST", "/v1/prices", { currency: "usd", unit_amount: "1000", "product_data[name]": "Decline test" })).json;
  spec.validate("price", price);
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{ price: price.id, quantity: 1 }],
    success_url: "http://shop.test/ok",
  });
  const res = await fetch(`${base()}/pay/${session.id}`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: "a@b.test", name: "A", cardNumber: "4000 0000 0000 0002", exp: "12 / 34", cvc: "123" }),
  });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Your card was declined/);
  assert.equal((await stripe.checkout.sessions.retrieve(session.id)).status, "open");
  await standin.idle();
  assert.equal(hook.received.length, 0);
});

test("expiry dates: two- and four-digit years are read correctly, past and malformed ones are refused", async () => {
  const price = (await raw("POST", "/v1/prices", { currency: "usd", unit_amount: "700", "product_data[name]": "Expiry test" })).json;
  const payWith = async (exp: string) => {
    const s = await stripe.checkout.sessions.create({ mode: "payment", line_items: [{ price: price.id, quantity: 1 }], success_url: "http://shop.test/ok" });
    const res = await fetch(`${base()}/pay/${s.id}`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "e@x.test", name: "E", cardNumber: "4242424242424242", exp, cvc: "123" }),
    });
    return { session: s, res };
  };
  const year = new Date().getFullYear();
  for (const [exp, expectedYear] of [[`12 / ${(year + 3) % 100}`, year + 3], [`12 / ${year + 3}`, year + 3]] as const) {
    const { session, res } = await payWith(exp);
    assert.equal(res.status, 303, `"${exp}" should be accepted`);
    const pi = await stripe.paymentIntents.retrieve((await stripe.checkout.sessions.retrieve(session.id)).payment_intent as string);
    const charge = await stripe.charges.retrieve(pi.latest_charge as string);
    assert.equal(charge.payment_method_details?.card?.exp_year, expectedYear);
  }
  for (const [exp, message] of [[`01 / ${year - 1}`, /in the past/], ["13 / 40", /incomplete/], ["12", /incomplete/], ["ab / cd", /incomplete/]] as const) {
    const { session, res } = await payWith(exp);
    assert.equal(res.status, 200, `"${exp}" should be refused`);
    assert.match(await res.text(), message);
    assert.equal((await stripe.checkout.sessions.retrieve(session.id)).status, "open");
  }
});

test("success_url: every {CHECKOUT_SESSION_ID} placeholder is filled in", async () => {
  const price = (await raw("POST", "/v1/prices", { currency: "usd", unit_amount: "300", "product_data[name]": "Placeholder test" })).json;
  const s = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{ price: price.id, quantity: 1 }],
    success_url: "http://shop.test/ok?a={CHECKOUT_SESSION_ID}&b={CHECKOUT_SESSION_ID}",
  });
  const res = await fetch(`${base()}/pay/${s.id}`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: "p@x.test", name: "P", cardNumber: "4242424242424242", exp: "12 / 40", cvc: "123" }),
  });
  assert.equal(res.headers.get("location"), `http://shop.test/ok?a=${s.id}&b=${s.id}`);
});

test("inactive prices are stored as inactive and refused by Checkout", async () => {
  const product = await stripe.products.create({ name: "Retired blend" });
  const inactive = await stripe.prices.create({ product: product.id, currency: "usd", unit_amount: 1200, active: false });
  assert.equal(inactive.active, false);
  spec.validate("price", (await raw("GET", `/v1/prices/${inactive.id}`)).json);
  const refused = await raw("POST", "/v1/checkout/sessions", { success_url: "http://x.test", "line_items[0][price]": inactive.id, "line_items[0][quantity]": "1" });
  assert.equal(refused.status, 400);
  assert.equal(refused.json.error.param, "line_items[0][price]");
  assert.match(refused.json.error.message, /inactive/);
  const active = await stripe.prices.list({ product: product.id, active: true });
  assert.equal(active.data.length, 0);
});

test("lists page newest first with starting_after and ending_before", async () => {
  const key = "sk_test_paging";
  const ids: string[] = [];
  for (const name of ["first", "second", "third"]) ids.push((await raw("POST", "/v1/products", { name }, key)).json.id);
  const page1 = (await raw("GET", "/v1/products?limit=1", undefined, key)).json;
  assert.deepEqual(page1.data.map((p: any) => p.id), [ids[2]]);
  assert.equal(page1.has_more, true);
  const page2 = (await raw("GET", `/v1/products?limit=1&starting_after=${ids[2]}`, undefined, key)).json;
  assert.deepEqual(page2.data.map((p: any) => p.id), [ids[1]]);
  const back = (await raw("GET", `/v1/products?limit=5&ending_before=${ids[0]}`, undefined, key)).json;
  assert.deepEqual(back.data.map((p: any) => p.id), [ids[2], ids[1]]);
  assert.equal(back.has_more, false);
  const both = await raw("GET", `/v1/products?starting_after=${ids[0]}&ending_before=${ids[2]}`, undefined, key);
  assert.equal(both.status, 400);
});

test("listens on localhost only unless a host is given", async () => {
  const local = await startStandin({ port: 0, statePath: null });
  try {
    const address = local.server.address() as { address: string };
    assert.equal(address.address, "127.0.0.1");
    const health = await fetch(`http://127.0.0.1:${local.port}/`);
    assert.equal(health.status, 200);
  } finally {
    await local.close();
  }
});

test("errors use Stripe's format", async () => {
  const unknown = await raw("GET", "/v1/customers");
  assert.equal(unknown.status, 404);
  assert.match(unknown.json.error.message, /Unrecognized request URL \(GET: \/v1\/customers\)/);

  const live = await raw("GET", "/v1/products", undefined, "sk_live_nope");
  assert.equal(live.status, 401);
  assert.match(live.json.error.message, /test-mode/);
  assert.equal((await raw("GET", "/v1/products", undefined, null)).status, 401);

  const sub = await raw("POST", "/v1/checkout/sessions", { mode: "subscription", success_url: "http://x.test", "line_items[0][price]": "price_x", "line_items[0][quantity]": "1" });
  assert.equal(sub.status, 400);
  assert.equal(sub.json.error.param, "mode");

  const noPrice = await raw("POST", "/v1/checkout/sessions", { success_url: "http://x.test", "line_items[0][price]": "price_missing", "line_items[0][quantity]": "1" });
  assert.equal(noPrice.status, 404);
  assert.equal(noPrice.json.error.code, "resource_missing");

  const missing = await raw("POST", "/v1/checkout/sessions", { success_url: "http://x.test" });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.error.param, "line_items");
});

test("accounts are isolated by API key", async () => {
  await raw("POST", "/v1/products", { name: "Only for account A" }, "sk_test_account_a");
  const b = await raw("GET", "/v1/products", undefined, "sk_test_account_b");
  assert.equal(b.json.data.length, 0);
});

test("idempotency keys replay the same response", async () => {
  const send = (name: string) =>
    fetch(`${base()}/v1/products`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/x-www-form-urlencoded", "Idempotency-Key": "idem-1" },
      body: new URLSearchParams({ name }),
    });
  const a = await send("Idempotent product");
  const b = await send("Idempotent product");
  assert.equal((await a.json() as any).id, (await b.json() as any).id);
  assert.equal(b.headers.get("idempotent-replayed"), "true");
  const c = await send("A different body");
  assert.equal(c.status, 400);
  assert.equal(((await c.json()) as any).error.type, "idempotency_error");
});

test("config seeds an account like a pre-configured dashboard", async () => {
  const seeded = await startStandin({
    port: 0,
    host: "127.0.0.1",
    statePath: null,
    config: {
      accounts: {
        sk_test_seeded: {
          webhookEndpoints: [{ url: "http://127.0.0.1:1/hook", enabledEvents: ["checkout.session.completed"] }],
          products: [{ slug: "beans", name: "Beans", description: "Good beans", cents: 1500, metadata: { shop: "test" } }],
        },
      },
    },
  });
  try {
    const headers = { Authorization: "Bearer sk_test_seeded" };
    const products = (await (await fetch(`http://127.0.0.1:${seeded.port}/v1/products?expand[]=data.default_price`, { headers })).json()) as any;
    assert.equal(products.data.length, 1);
    spec.validate("product", products.data[0]);
    assert.equal(products.data[0].default_price.unit_amount, 1500);
    assert.deepEqual(products.data[0].metadata, { shop: "test", standin_seed: "beans", slug: "beans" });
    const endpoints = (await (await fetch(`http://127.0.0.1:${seeded.port}/v1/webhook_endpoints`, { headers })).json()) as any;
    assert.equal(endpoints.data.length, 1);
    assert.equal(endpoints.data[0].secret, undefined, "secrets are only shown at creation");
  } finally {
    await seeded.close();
  }
});
