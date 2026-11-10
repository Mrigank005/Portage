// Tests for the reference code agents copy into apps. The live tests talk to the real PayPal sandbox and run only
// when sandbox credentials are available (the repo's .env or the environment); otherwise they are skipped.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "../src/money.ts";
import * as ref from "../reference/paypal-money.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoEnv = path.resolve(here, "../../../.env");
const PAYPAL_KEYS = ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_ENVIRONMENT"];

/** PayPal sandbox settings from the environment or the repo's .env (never printed). */
function sandboxCredentials(): Record<string, string> | null {
  const found: Record<string, string> = {};
  for (const k of PAYPAL_KEYS) if (process.env[k]) found[k] = process.env[k]!;
  if (fs.existsSync(repoEnv)) {
    for (const line of fs.readFileSync(repoEnv, "utf8").split(/\r?\n/)) {
      const m = /^\s*(PAYPAL_[A-Z_]+)\s*=\s*(.*)$/.exec(line);
      if (m && PAYPAL_KEYS.includes(m[1]) && !found[m[1]]) found[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  if (!found.PAYPAL_CLIENT_ID || !found.PAYPAL_CLIENT_SECRET) return null;
  if (found.PAYPAL_ENVIRONMENT && found.PAYPAL_ENVIRONMENT !== "sandbox") return null; // never run tests against live
  return found;
}
const live = sandboxCredentials();
const skipLive = live ? false : "no PayPal sandbox credentials";

// ---------------------------------------------------------------------------------------------------------------
// Money: the self-contained helper must agree with Portage's own, on success and on refusal.

test("reference money helper agrees with Portage's helper", () => {
  const currencies = ["USD", "EUR", "JPY", "HUF", "TWD", "GBP", "INR", "KWD", "ISK", "usd"];
  let seed = 11;
  const rand = () => (seed = (seed * 48271) % 2147483647);
  for (let i = 0; i < 3000; i++) {
    const amount = i < 20 ? [0, 1, 99, 100, 101, 1045, 2400, 9_999_999, 2 ** 53, -1, 1.5, 1000, 50000, 5, 10, 123456789, 7, 300, 12, 1e6][i] : rand() % 10_000_000;
    for (const cur of currencies) {
      let a: unknown;
      let b: unknown;
      try {
        a = core.toPayPalMoney(amount, cur);
      } catch {
        a = "error";
      }
      try {
        b = ref.toPayPalMoney(amount, cur);
      } catch {
        b = "error";
      }
      assert.deepEqual(b, a, `${amount} ${cur}`);
      if (a !== "error") assert.equal(ref.fromPayPalMoney(a as core.PayPalMoney), core.fromPayPalMoney(a as core.PayPalMoney));
    }
  }
  for (const bad of ["24.001", "abc", "", "-1"]) assert.throws(() => ref.fromPayPalMoney({ currencyCode: "USD", value: bad }));
  // Webhook payloads use snake_case.
  assert.equal(ref.fromPayPalMoney({ currency_code: "USD", value: "24.00" }), 2400);
  assert.equal(ref.fromPayPalMoney({ currency_code: "JPY", value: "2400" }), 2400);
  assert.equal(ref.paypalSupportsCurrency("inr"), false);
});

// ---------------------------------------------------------------------------------------------------------------
// Webhook verification against a fake PayPal, to pin down exactly what is sent.

type Seen = { tokenCalls: number; verifyBodies: string[]; requestIds: string[] };
let fake: http.Server;
let seen: Seen;
let fakeStatus = "SUCCESS";
// Flaky-network simulation: drop this many token connections, and answer this many verify calls with 503.
let dropTokenConnections = 0;
let verify503s = 0;
const savedEnv: Record<string, string | undefined> = {};

before(async () => {
  seen = { tokenCalls: 0, verifyBodies: [], requestIds: [] };
  fake = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url === "/v1/oauth2/token" && dropTokenConnections > 0) {
        dropTokenConnections--;
        req.socket.destroy();
        return;
      }
      if (req.url === "/v1/notifications/verify-webhook-signature" && verify503s > 0) {
        verify503s--;
        res.statusCode = 503;
        return res.end("{}");
      }
      if (req.url === "/v1/oauth2/token") {
        seen.tokenCalls++;
        assert.match(String(req.headers.authorization), /^Basic /);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ access_token: "fake-token", expires_in: 32400 }));
      } else if (req.url === "/v1/notifications/verify-webhook-signature") {
        assert.equal(req.headers.authorization, "Bearer fake-token");
        seen.verifyBodies.push(body);
        seen.requestIds.push(String(req.headers["paypal-request-id"]));
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ verification_status: fakeStatus }));
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", () => r()));
  for (const k of ["PAYPAL_API_BASE", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_WEBHOOK_ID"]) savedEnv[k] = process.env[k];
});

after(async () => {
  await new Promise<void>((r) => fake.close(() => r()));
  restoreEnv();
});

const transmission = {
  "paypal-transmission-id": "tx-1",
  "paypal-transmission-time": "2026-11-10T10:00:00Z",
  // Real-looking values: PayPal validates their format before it checks the signature.
  "paypal-transmission-sig": "c2lnbmF0dXJlLW5vdC12YWxpZA==",
  "paypal-cert-url": "https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-1d93a270",
  "paypal-auth-algo": "SHA256withRSA",
};
// Deliberately unusual formatting: verification must forward these exact bytes.
const rawEvent = '{"id":"WH-1",  "event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"id":"CAP-1","custom_id":"ord_1","amount":{"currency_code":"USD","value":"24.00"}}}';

test("webhook verification forwards the raw event, caches the token, and trusts only SUCCESS", async () => {
  const addr = fake.address() as { port: number };
  Object.assign(process.env, { PAYPAL_API_BASE: `http://127.0.0.1:${addr.port}`, PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret", PAYPAL_WEBHOOK_ID: "WH-ID-1" });
  const { verifyPayPalWebhook, capturedPaymentIdOfRefund } = await import("../reference/paypal-webhook.ts");

  const ok = await verifyPayPalWebhook(new Headers(transmission), rawEvent);
  assert.equal(ok.verified, true);
  assert.equal(ok.verified && ok.event.resource.custom_id, "ord_1");
  const sent = seen.verifyBodies[0];
  assert.ok(sent.endsWith(`"webhook_event":${rawEvent}}`), "the event bytes are spliced in unchanged");
  const parsed = JSON.parse(sent);
  assert.equal(parsed.webhook_id, "WH-ID-1");
  assert.equal(parsed.transmission_id, "tx-1");
  assert.equal(parsed.auth_algo, "SHA256withRSA");
  assert.match(seen.requestIds[0], /^[0-9a-f-]{36}$/, "a PayPal-Request-Id is sent");

  // Express-style headers (lower-case keys, possibly arrays) work too, and the token is reused.
  fakeStatus = "FAILURE";
  const failed = await verifyPayPalWebhook({ ...transmission, "paypal-transmission-id": ["tx-2"] }, rawEvent);
  assert.deepEqual(failed, { verified: false, reason: "verification_status FAILURE" });
  assert.equal(seen.tokenCalls, 1);

  const { "paypal-transmission-sig": _omit, ...missing } = transmission;
  assert.deepEqual(await verifyPayPalWebhook(missing, rawEvent), { verified: false, reason: "missing PayPal transmission headers" });
  assert.deepEqual(await verifyPayPalWebhook(transmission, "not json"), { verified: false, reason: "body is not JSON" });
  assert.equal(seen.verifyBodies.length, 2, "unverifiable requests never reach PayPal");

  const refund = { id: "WH-2", event_type: "PAYMENT.CAPTURE.REFUNDED", resource: { id: "REF-1", links: [{ rel: "self", href: "https://api.sandbox.paypal.com/v2/payments/refunds/REF-1" }, { rel: "up", href: "https://api.sandbox.paypal.com/v2/payments/captures/CAP-9" }] } };
  assert.equal(capturedPaymentIdOfRefund(refund), "CAP-9");
  fakeStatus = "SUCCESS";
  restoreEnv(); // later tests must not see the fake settings
});

function restoreEnv() {
  for (const [k, v] of Object.entries(savedEnv)) if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

test("webhook verification survives a dropped connection and a 503", async () => {
  const addr = fake.address() as { port: number };
  Object.assign(process.env, { PAYPAL_API_BASE: `http://127.0.0.1:${addr.port}`, PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret", PAYPAL_WEBHOOK_ID: "WHID1" });
  try {
    const mod = await import(`../reference/paypal-webhook.ts?retry=${Date.now()}`); // fresh token cache
    dropTokenConnections = 1;
    verify503s = 1;
    const before = seen.verifyBodies.length;
    const result = await mod.verifyPayPalWebhook(new Headers(transmission), rawEvent);
    assert.equal(result.verified, true);
    assert.equal(dropTokenConnections, 0, "the dropped token request was retried");
    assert.equal(verify503s, 0, "the 503 was retried");
    assert.equal(seen.verifyBodies.length, before + 1, "one verification reached the end");
  } finally {
    restoreEnv();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Live PayPal sandbox.

test("live sandbox: the reference client creates and reads an order; capture before approval is refused with a debug_id", { skip: skipLive }, async () => {
  const saved = PAYPAL_KEYS.map((k) => [k, process.env[k]] as const);
  Object.assign(process.env, live);
  try {
    const { ordersApi, paypalRequestId, describePayPalError } = await import("../reference/paypal-client.ts");
    const { toPayPalMoney } = await import("../reference/paypal-money.ts");
    const { CheckoutPaymentIntent, PaypalWalletContextShippingPreference, ApiError } = await import("@paypal/paypal-server-sdk");
    const amount = toPayPalMoney(2400, "usd");
    const created = await ordersApi().createOrder({
      body: {
        intent: CheckoutPaymentIntent.Capture,
        purchaseUnits: [{ customId: "portage-test", amount: { ...amount, breakdown: { itemTotal: amount } }, items: [{ name: "Portage test item", quantity: "1", unitAmount: amount }] }],
        paymentSource: { paypal: { experienceContext: { shippingPreference: PaypalWalletContextShippingPreference.NoShipping } } },
      },
      paypalRequestId: paypalRequestId(),
      prefer: "return=representation",
    });
    const order = created.result;
    assert.ok(order.id);
    assert.ok(["CREATED", "PAYER_ACTION_REQUIRED"].includes(String(order.status)), String(order.status));
    assert.ok(order.links?.some((l) => l.rel === "payer-action" || l.rel === "approve"), "the order has a link for the buyer");

    const fetched = (await ordersApi().getOrder({ id: order.id! })).result;
    assert.equal(fetched.purchaseUnits?.[0]?.customId, "portage-test");
    assert.equal(fetched.purchaseUnits?.[0]?.amount?.value, "24.00");

    await assert.rejects(
      ordersApi().captureOrder({ id: order.id!, paypalRequestId: paypalRequestId() }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.statusCode, 422);
        assert.match(describePayPalError(err), /422.*debug_id \w+/);
        return true;
      },
    );
  } finally {
    for (const [k, v] of saved) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test("live sandbox: PayPal accepts the verification request and rejects a forged signature", { skip: skipLive }, async () => {
  const saved = ["PAYPAL_API_BASE", "PAYPAL_WEBHOOK_ID", ...PAYPAL_KEYS].map((k) => [k, process.env[k]] as const);
  delete process.env.PAYPAL_API_BASE;
  // Until a webhook is registered, "0" stands in: PayPal still validates the request and answers FAILURE.
  Object.assign(process.env, live, { PAYPAL_WEBHOOK_ID: process.env.PAYPAL_WEBHOOK_ID || readEnvKey("PAYPAL_WEBHOOK_ID") || "0" });
  try {
    // A fresh module instance: the fake test above cached a fake token.
    const mod = await import(`../reference/paypal-webhook.ts?live=${Date.now()}`);
    const result = await mod.verifyPayPalWebhook(new Headers(transmission), rawEvent);
    assert.deepEqual(result, { verified: false, reason: "verification_status FAILURE" });
  } finally {
    for (const [k, v] of saved) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function readEnvKey(key: string): string | undefined {
  if (!fs.existsSync(repoEnv)) return undefined;
  // Line by line: a regex with \s around "=" could run past an empty value into the next line.
  for (const line of fs.readFileSync(repoEnv, "utf8").split(/\r?\n/)) {
    const m = /^[ \t]*([A-Z0-9_]+)[ \t]*=[ \t]*(.*)$/.exec(line);
    if (m && m[1] === key) return m[2].trim().replace(/^["']|["']$/g, "");
  }
  return undefined;
}
