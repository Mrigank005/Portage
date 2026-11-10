import { test } from "node:test";
import assert from "node:assert/strict";
import { MoneyError, fromPayPalMoney, paypalExponent, stripeExponent, toPayPalMoney } from "../src/index.ts";

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof MoneyError, `expected MoneyError, got ${String(e)}`);
    return e.code;
  }
  assert.fail("expected a MoneyError");
};

test("two-decimal currencies become decimal strings", () => {
  assert.deepEqual(toPayPalMoney(2400, "usd"), { currencyCode: "USD", value: "24.00" });
  assert.equal(toPayPalMoney(5, "EUR").value, "0.05");
  assert.equal(toPayPalMoney(0, "GBP").value, "0.00");
  assert.equal(toPayPalMoney(123456789, "CAD").value, "1234567.89");
});

test("zero-decimal currencies stay whole", () => {
  assert.deepEqual(toPayPalMoney(2400, "jpy"), { currencyCode: "JPY", value: "2400" });
});

test("HUF and TWD: Stripe has two decimals, PayPal none, and fractions are refused, not rounded", () => {
  assert.equal(stripeExponent("HUF"), 2);
  assert.equal(paypalExponent("HUF"), 0);
  assert.equal(toPayPalMoney(1000, "huf").value, "10");
  assert.equal(toPayPalMoney(50000, "TWD").value, "500");
  assert.equal(code(() => toPayPalMoney(1045, "HUF")), "PRECISION_LOSS");
  assert.equal(code(() => toPayPalMoney(1, "TWD")), "PRECISION_LOSS");
});

test("currencies PayPal doesn't accept are refused", () => {
  assert.equal(code(() => toPayPalMoney(1000, "INR")), "PAYPAL_CURRENCY_UNSUPPORTED");
  assert.equal(code(() => toPayPalMoney(1000, "KWD")), "PAYPAL_CURRENCY_UNSUPPORTED");
  assert.equal(paypalExponent("INR"), null);
});

test("Stripe's special cases: ISK and UGX are written with two decimals", () => {
  assert.equal(stripeExponent("ISK"), 2);
  assert.equal(stripeExponent("UGX"), 2);
  assert.equal(stripeExponent("KWD"), 3);
  assert.equal(stripeExponent("JPY"), 0);
});

test("bad amounts and currency codes are refused", () => {
  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, "100" as unknown as number]) {
    assert.equal(code(() => toPayPalMoney(bad, "USD")), "INVALID_AMOUNT", String(bad));
  }
  for (const bad of ["US", "usd1", "", "U$D"]) assert.equal(code(() => toPayPalMoney(100, bad)), "INVALID_CURRENCY", bad);
});

test("PayPal amounts convert back to minor units", () => {
  assert.equal(fromPayPalMoney({ currencyCode: "USD", value: "24.00" }), 2400);
  assert.equal(fromPayPalMoney({ currencyCode: "usd", value: "24" }), 2400);
  assert.equal(fromPayPalMoney({ currencyCode: "USD", value: "24.5" }), 2450);
  assert.equal(fromPayPalMoney({ currencyCode: "JPY", value: "2400" }), 2400);
  assert.equal(fromPayPalMoney({ currencyCode: "HUF", value: "10" }), 1000);
  assert.equal(code(() => fromPayPalMoney({ currencyCode: "USD", value: "24.001" })), "INVALID_PAYPAL_VALUE");
  assert.equal(code(() => fromPayPalMoney({ currencyCode: "HUF", value: "10.5" })), "INVALID_PAYPAL_VALUE");
  for (const bad of ["abc", "-1", "1e3", " 1.00", "", "1,00"]) {
    assert.equal(code(() => fromPayPalMoney({ currencyCode: "USD", value: bad })), "INVALID_PAYPAL_VALUE", bad);
  }
});

test("round trips are exact", () => {
  let seed = 7;
  const rand = () => (seed = (seed * 48271) % 2147483647);
  for (let i = 0; i < 2000; i++) {
    for (const [cur, step] of [["USD", 1], ["EUR", 1], ["JPY", 1], ["HUF", 100], ["TWD", 100]] as const) {
      const minor = (rand() % 10_000_000) * step;
      assert.equal(fromPayPalMoney(toPayPalMoney(minor, cur)), minor, `${minor} ${cur}`);
    }
  }
});
