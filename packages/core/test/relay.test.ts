import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
// @ts-expect-error: plain JavaScript module without types
import { createRelay } from "../../../apps/webhook-relay/server.mjs";
import { Forwarder, newChannel, readEnv, setupWebhookRelay, summarizeEvent, writeEnv } from "../src/index.ts";

function listen(server: http.Server): Promise<string> {
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(server.address() as { port: number }).port}`)));
}

let relay: http.Server;
let relayUrl: string;
let app: http.Server;
let appUrl: string;
const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];

before(async () => {
  relay = createRelay();
  relayUrl = await listen(relay);
  app = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      res.writeHead(body.includes("FORGED") ? 400 : 200).end();
    });
  });
  appUrl = await listen(app);
});
after(() => {
  relay.close();
  app.close();
});

const captureEvent = JSON.stringify({
  id: "WH-1",
  event_type: "PAYMENT.CAPTURE.COMPLETED",
  resource: { id: "CAP-1", supplementary_data: { related_ids: { order_id: "ORDER-1" } }, amount: { value: "24.00", currency_code: "USD" } },
});
const refundEvent = JSON.stringify({
  id: "WH-2",
  event_type: "PAYMENT.CAPTURE.REFUNDED",
  resource: { id: "REF-1", links: [{ rel: "self", href: "https://api.sandbox.paypal.com/v2/payments/refunds/REF-1" }, { rel: "up", href: "https://api.sandbox.paypal.com/v2/payments/captures/CAP-1" }] },
});

test("summarizes capture and refund events", () => {
  assert.deepEqual(summarizeEvent(captureEvent), { eventId: "WH-1", eventType: "PAYMENT.CAPTURE.COMPLETED", resourceId: "CAP-1", orderId: "ORDER-1", captureId: "CAP-1" });
  assert.equal(summarizeEvent(refundEvent).captureId, "CAP-1");
  assert.equal(summarizeEvent("not json").eventType, null);
});

test("new channels are long, random and accepted by the relay", () => {
  const a = newChannel();
  assert.match(a, /^[A-Za-z0-9_-]{20,64}$/);
  assert.notEqual(a, newChannel());
});

test("forwards only new events, byte for byte with PayPal's headers, and reports the app's answer", async () => {
  const channel = newChannel();
  await fetch(`${relayUrl}/hooks/${channel}`, { method: "POST", body: "old event" });
  const fwd = new Forwarder(relayUrl, channel, `${appUrl}/api/webhooks/paypal`);
  await fwd.start();
  try {
    const sig = { "content-type": "application/json", "paypal-transmission-id": "tid-1", "paypal-transmission-sig": "c2ln", "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT", "paypal-auth-algo": "SHA256withRSA", "paypal-transmission-time": "2026-11-11T10:00:00Z" };
    await fetch(`${relayUrl}/hooks/${channel}`, { method: "POST", headers: sig, body: captureEvent });
    const d = await fwd.waitFor((x) => x.eventType === "PAYMENT.CAPTURE.COMPLETED", 10_000);
    assert.ok(d);
    assert.equal(d.ok, true);
    assert.equal(d.orderId, "ORDER-1");
    const got = received.at(-1)!;
    assert.equal(got.body, captureEvent);
    for (const [k, v] of Object.entries(sig)) assert.equal(got.headers[k], v);
    assert.ok(!received.some((r) => r.body === "old event"), "events from before start() are not replayed");

    await fetch(`${relayUrl}/hooks/${channel}`, { method: "POST", headers: sig, body: captureEvent.replace("WH-1", "WH-FORGED") });
    const bad = await fwd.waitFor((x) => x.eventId === "WH-FORGED", 10_000);
    assert.equal(bad?.status, 400);
    assert.equal(bad?.ok, false);
    assert.equal(await fwd.waitFor((x) => x.eventId === "never", 300), null);
  } finally {
    await fwd.stop();
  }
});

test("writeEnv replaces in place, appends the rest, keeps line endings; readEnv reads them back", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "portage-env-"));
  const file = path.join(dir, ".env.local");
  fs.writeFileSync(file, "# keep me\r\nPAYPAL_CLIENT_ID=abc\r\nPAYPAL_WEBHOOK_ID=old\r\n");
  const r = writeEnv(file, { PAYPAL_WEBHOOK_ID: "WH-NEW", PORTAGE_RELAY_URL: "https://relay.example" });
  assert.deepEqual(r, { replaced: ["PAYPAL_WEBHOOK_ID"], added: ["PORTAGE_RELAY_URL"] });
  assert.equal(fs.readFileSync(file, "utf8"), "# keep me\r\nPAYPAL_CLIENT_ID=abc\r\nPAYPAL_WEBHOOK_ID=WH-NEW\r\nPORTAGE_RELAY_URL=https://relay.example\r\n");
  const { values, from } = readEnv(dir, [".env.local"], ["PAYPAL_WEBHOOK_ID", "PAYPAL_CLIENT_ID"] as const);
  assert.deepEqual(values, { PAYPAL_CLIENT_ID: "abc", PAYPAL_WEBHOOK_ID: "WH-NEW" });
  assert.equal(from.PAYPAL_WEBHOOK_ID, ".env.local");
});

test("setupWebhookRelay registers the webhook once, reuses it on re-runs, and writes the settings", async () => {
  const calls: { method: string; url: string; body: string }[] = [];
  const hooks: { id: string; url: string }[] = [];
  const paypal = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push({ method: req.method!, url: req.url!, body });
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/oauth2/token") return res.end(JSON.stringify({ access_token: "tok" }));
      if (req.url === "/v1/notifications/webhooks" && req.method === "GET") return res.end(JSON.stringify({ webhooks: hooks }));
      if (req.url === "/v1/notifications/webhooks" && req.method === "POST") {
        const w = { id: `WH-${hooks.length + 1}`, url: JSON.parse(body).url };
        hooks.push(w);
        return res.writeHead(201).end(JSON.stringify(w));
      }
      res.writeHead(404).end("{}");
    });
  });
  const base = await listen(paypal);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "portage-relay-"));
  fs.writeFileSync(path.join(dir, ".env.local"), "PAYPAL_ENVIRONMENT=sandbox\nPAYPAL_CLIENT_ID=id\nPAYPAL_CLIENT_SECRET=secret\nPAYPAL_WEBHOOK_ID=\n");
  try {
    const first = await setupWebhookRelay({ appDir: dir, relayUrl: "https://relay.example", paypalApiBase: base, skipWake: true });
    assert.equal(first.webhookId, "WH-1");
    assert.equal(first.reusedWebhook, false);
    assert.equal(first.newChannel, true);
    const created = JSON.parse(calls.find((c) => c.method === "POST" && c.url === "/v1/notifications/webhooks")!.body);
    assert.match(created.url, /^https:\/\/relay\.example\/hooks\/ptg_[A-Za-z0-9_-]{24}$/);
    assert.deepEqual(created.event_types.map((e: { name: string }) => e.name).sort(), ["PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.DENIED", "PAYMENT.CAPTURE.PENDING", "PAYMENT.CAPTURE.REFUNDED", "PAYMENT.CAPTURE.REVERSED"]);
    const env = fs.readFileSync(path.join(dir, ".env.local"), "utf8");
    assert.match(env, /^PAYPAL_WEBHOOK_ID=WH-1$/m);
    assert.match(env, /^PORTAGE_RELAY_URL=https:\/\/relay\.example$/m);
    assert.ok(!JSON.stringify(first).includes("secret"), "never returns credentials");

    const second = await setupWebhookRelay({ appDir: dir, relayUrl: "https://relay.example", paypalApiBase: base, skipWake: true });
    assert.equal(second.webhookId, "WH-1");
    assert.equal(second.reusedWebhook, true);
    assert.equal(second.newChannel, false);
    assert.equal(hooks.length, 1);

    fs.writeFileSync(path.join(dir, ".env.local"), "PAYPAL_ENVIRONMENT=live\nPAYPAL_CLIENT_ID=id\nPAYPAL_CLIENT_SECRET=secret\n");
    await assert.rejects(setupWebhookRelay({ appDir: dir, relayUrl: "https://relay.example", paypalApiBase: base, skipWake: true }), /sandbox/);
  } finally {
    paypal.close();
  }
});
