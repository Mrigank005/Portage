// Portage webhook relay: lets PayPal sandbox webhooks reach an app running on a developer's laptop.
//
// PayPal can only deliver webhooks to a public HTTPS URL. Each tester picks a random channel name and registers
// https://<relay>/hooks/<channel> as a webhook in their own PayPal sandbox app. The relay keeps what PayPal sends,
// byte for byte with PayPal's signature headers, and Portage on the tester's machine long-polls
// /channels/<channel>/events and forwards each event to the local app, which verifies the signature with PayPal itself.
//
// The relay never verifies, changes or acts on events, and it holds no credentials. Channel names are long and random,
// so one tester can't read another's events; events are sandbox data, kept in memory for at most a day.
import http from "node:http";

const PORT = Number(process.env.PORT ?? 4310);
const HOST = process.env.HOST ?? "0.0.0.0";
const MAX_BODY = 256 * 1024;
const MAX_EVENTS = 100; // per channel
const MAX_CHANNELS = 1000;
const EVENT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_WAIT_S = 25;
const CHANNEL = /^[A-Za-z0-9_-]{20,64}$/;

/** @type {Map<string, {seq: number, events: any[], waiters: Set<() => void>, touched: number}>} */
const channels = new Map();

function channel(name) {
  let ch = channels.get(name);
  if (!ch) {
    if (channels.size >= MAX_CHANNELS) {
      // Drop the channel used least recently.
      let oldest;
      for (const [k, v] of channels) if (!oldest || v.touched < oldest[1].touched) oldest = [k, v];
      if (oldest) {
        for (const wake of oldest[1].waiters) wake();
        channels.delete(oldest[0]);
      }
    }
    ch = { seq: 0, events: [], waiters: new Set(), touched: Date.now() };
    channels.set(name, ch);
  }
  ch.touched = Date.now();
  return ch;
}

function prune(ch) {
  const cutoff = Date.now() - EVENT_TTL_MS;
  while (ch.events.length && (ch.events.length > MAX_EVENTS || ch.events[0].receivedAt < cutoff)) ch.events.shift();
}

function send(res, status, body, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const ABOUT = `Portage webhook relay

PayPal sandbox webhooks for apps running locally. Register https://<this host>/hooks/<channel> as a webhook in your
PayPal sandbox app (Portage does this for you), then let Portage forward events to your app.

POST /hooks/<channel>                      PayPal delivers here
GET  /channels/<channel>/events?after=N    Portage long-polls here (wait up to ${MAX_WAIT_S}s)

Channel names are 20-64 characters of A-Z a-z 0-9 _ -. Events are kept in memory for up to a day and are never
verified or changed here: your app verifies each one with PayPal.
Source: https://github.com/Mrigank005/Portage/tree/main/apps/webhook-relay
`;

export function createRelay() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://relay");
      const parts = url.pathname.split("/").filter(Boolean);

      if (req.method === "GET" && url.pathname === "/") return send(res, 200, ABOUT);
      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true, channels: channels.size });

      if (parts[0] === "hooks" && parts.length === 2) {
        if (req.method !== "POST") return send(res, 405, { error: "PayPal delivers webhooks with POST." }, { allow: "POST" });
        if (!CHANNEL.test(parts[1])) return send(res, 404, { error: "Unknown channel name format." });
        const body = await readBody(req);
        const ch = channel(parts[1]);
        const headers = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if ((k.startsWith("paypal-") || k === "content-type" || k === "user-agent") && typeof v === "string") headers[k] = v;
        }
        ch.seq += 1;
        ch.events.push({ seq: ch.seq, receivedAt: Date.now(), headers, body: body.toString("utf8") });
        prune(ch);
        for (const wake of ch.waiters) wake();
        ch.waiters.clear();
        return send(res, 200, { received: true });
      }

      if (parts[0] === "channels" && parts[2] === "events" && parts.length === 3) {
        if (req.method !== "GET") return send(res, 405, { error: "Use GET." }, { allow: "GET" });
        if (!CHANNEL.test(parts[1])) return send(res, 404, { error: "Unknown channel name format." });
        const after = Math.max(0, Number.parseInt(url.searchParams.get("after") ?? "0", 10) || 0);
        const wait = Math.min(MAX_WAIT_S, Math.max(0, Number(url.searchParams.get("wait") ?? "0") || 0));
        const ch = channel(parts[1]);
        prune(ch);
        const pending = () => ch.events.filter((e) => e.seq > after);
        if (pending().length || wait === 0) return send(res, 200, { latest: ch.seq, events: pending() });
        await new Promise((resolve) => {
          const done = () => {
            clearTimeout(timer);
            ch.waiters.delete(done);
            resolve();
          };
          const timer = setTimeout(done, wait * 1000);
          ch.waiters.add(done);
          req.on("close", done);
        });
        if (res.destroyed) return;
        return send(res, 200, { latest: ch.seq, events: pending() });
      }

      return send(res, 404, { error: "Not found. See / for the routes." });
    } catch (err) {
      if (!res.headersSent) send(res, err.status ?? 500, { error: err.status === 413 ? "Body too large." : "Relay error." });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("server.mjs")) {
  const server = createRelay();
  server.listen(PORT, HOST, () => console.log(`Portage webhook relay listening on ${HOST}:${PORT}`));
}
