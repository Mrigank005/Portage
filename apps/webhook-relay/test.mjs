import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createRelay } from "./server.mjs";

let base;
let server;
before(async () => {
  server = createRelay();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const ch = "test_channel_0123456789abcdef";
const body = '{"id":"WH-1","event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"amount":{"value":"24.00"}}}  ';

test("keeps the exact bytes and PayPal's signature headers", async () => {
  const post = await fetch(`${base}/hooks/${ch}`, {
    method: "POST",
    headers: { "content-type": "application/json", "paypal-transmission-id": "t-1", "paypal-transmission-sig": "sig==", "paypal-cert-url": "https://api.sandbox.paypal.com/cert", "paypal-auth-algo": "SHA256withRSA", "paypal-transmission-time": "2026-11-11T00:00:00Z", cookie: "dropped" },
    body,
  });
  assert.equal(post.status, 200);
  const res = await (await fetch(`${base}/channels/${ch}/events?after=0`)).json();
  assert.equal(res.latest, 1);
  assert.equal(res.events[0].body, body);
  assert.equal(res.events[0].headers["paypal-transmission-sig"], "sig==");
  assert.equal(res.events[0].headers["paypal-auth-algo"], "SHA256withRSA");
  assert.equal(res.events[0].headers.cookie, undefined);
});

test("long-polls until an event arrives, and only returns newer events", async () => {
  const start = Date.now();
  const poll = fetch(`${base}/channels/${ch}/events?after=1&wait=10`).then((r) => r.json());
  setTimeout(() => fetch(`${base}/hooks/${ch}`, { method: "POST", body: "{}" }), 300);
  const res = await poll;
  assert.ok(Date.now() - start < 5000);
  assert.deepEqual(res.events.map((e) => e.seq), [2]);
});

test("times out with no events", async () => {
  const res = await (await fetch(`${base}/channels/other_channel_0123456789ab/events?after=0&wait=1`)).json();
  assert.deepEqual(res, { latest: 0, events: [] });
});

test("refuses short channel names, other methods and large bodies", async () => {
  assert.equal((await fetch(`${base}/hooks/short`, { method: "POST", body: "{}" })).status, 404);
  assert.equal((await fetch(`${base}/hooks/${ch}`)).status, 405);
  const big = await fetch(`${base}/hooks/${ch}`, { method: "POST", body: "x".repeat(300 * 1024) }).catch(() => ({ status: 413 }));
  assert.equal(big.status, 413);
  assert.equal((await fetch(`${base}/health`)).status, 200);
});

test("keeps at most 100 events per channel", async () => {
  const c = "cap_channel_0123456789abcdef";
  for (let i = 0; i < 105; i++) await fetch(`${base}/hooks/${c}`, { method: "POST", body: String(i) });
  const res = await (await fetch(`${base}/channels/${c}/events?after=0`)).json();
  assert.equal(res.events.length, 100);
  assert.equal(res.events[0].body, "5");
});
