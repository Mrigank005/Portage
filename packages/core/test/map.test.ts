// The map is data, so these tests keep it internally consistent and keep every PayPal SDK reference inside the set
// of methods and models we confirmed through ContextMatic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadMap, ruleForCall, ruleForEvent } from "../src/index.ts";

const map = loadMap();
const STATUSES = new Set(Object.keys(map.statuses));

test("every call rule has a valid status, and blockers name their reason", () => {
  for (const r of map.calls) {
    assert.ok(STATUSES.has(r.status), `${r.stripe}: ${r.status}`);
    assert.ok(r.paypal.length > 0, r.stripe);
    if (r.status === "blocker") assert.ok(r.blocker, `${r.stripe} is a blocker without a code`);
  }
});

test("call rules are unique per method and mode", () => {
  const keys = map.calls.map((r) => `${r.stripe}|${r.when?.mode ?? ""}`);
  assert.equal(new Set(keys).size, keys.length);
});

test("every SDK method and model the map names was confirmed through ContextMatic", () => {
  for (const r of map.calls) {
    for (const m of r.sdk ?? []) assert.ok(map.paypalSdk.methods.includes(m), `${r.stripe} names unconfirmed method ${m}`);
    for (const m of r.models ?? []) assert.ok(map.paypalSdk.models.includes(m), `${r.stripe} names unconfirmed model ${m}`);
  }
  assert.ok(map.paypalSdk.notInSdk.webhookVerification.includes("verify-webhook-signature"));
});

test("webhook events map to well-formed PayPal event names", () => {
  const seen = new Set<string>();
  for (const e of map.events) {
    assert.ok(!seen.has(e.stripe), `duplicate ${e.stripe}`);
    seen.add(e.stripe);
    assert.ok(STATUSES.has(e.status), e.stripe);
    if (e.paypal !== null) assert.match(e.paypal, /^[A-Z]+(\.[A-Z_]+)+$/, e.stripe);
    if (e.status === "mapped") assert.ok(e.paypal, `${e.stripe} is mapped but has no PayPal event`);
  }
  assert.equal(ruleForEvent("checkout.session.completed")?.paypal, "PAYMENT.CAPTURE.COMPLETED");
  assert.equal(ruleForEvent("charge.refunded")?.paypal, "PAYMENT.CAPTURE.REFUNDED");
});

test("object field rules belong to objects that events carry", () => {
  const objects = new Set(map.events.map((e) => e.stripe.split(".").slice(0, -1).join(".")));
  for (const f of map.objectFields) assert.ok(objects.has(f.object), `${f.object}.${f.stripe}`);
});

test("lookups pick the right rule", () => {
  assert.equal(ruleForCall("checkout.sessions.create", "payment")?.status, "mapped");
  assert.equal(ruleForCall("checkout.sessions.create", "subscription")?.status, "needs-human");
  assert.equal(ruleForCall("checkout.sessions.create", "setup")?.role, "saved-payment");
  assert.equal(ruleForCall("accounts.create")?.blocker, "STRIPE_CONNECT");
  assert.equal(ruleForCall("products.list")?.status, "catalog");
  assert.equal(ruleForCall("refunds.create")?.sdk?.[0], "PaymentsController.refundCapturedPayment");
  assert.equal(ruleForCall("balance.retrieve"), undefined);
});

test("currency data matches PayPal's published rules", () => {
  for (const [c, d] of Object.entries(map.currencies.paypal)) assert.ok(d === 0 || d === 2, `${c}: ${d}`);
  for (const c of ["HUF", "JPY", "TWD"]) assert.equal(map.currencies.paypal[c], 0, c);
  for (const c of map.currencies.paypalInCountryOnly) assert.ok(c in map.currencies.paypal, c);
  assert.equal(Object.keys(map.currencies.paypal).length, 25);
});
