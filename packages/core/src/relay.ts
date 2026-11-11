// The local side of Portage's webhook relay (apps/webhook-relay).
//
// setupWebhookRelay registers https://<relay>/hooks/<channel> as a webhook in the developer's own PayPal sandbox app
// (PayPal's REST API: the Server SDK has no webhook methods) and writes PAYPAL_WEBHOOK_ID, PORTAGE_RELAY_URL and
// PORTAGE_RELAY_CHANNEL to the app's env file. Forwarder long-polls the relay and posts each event, byte for byte with
// PayPal's signature headers, to the app's webhook route; the app verifies it with PayPal as it would in production.
import { randomBytes } from "node:crypto";
import path from "node:path";
import { readEnv, writeEnv } from "./env.ts";

/** Portage's public relay. Override with PORTAGE_RELAY_URL (for example a relay you deploy yourself from render.yaml). */
export const DEFAULT_RELAY_URL = "https://portage-relay.onrender.com";

/** The PayPal events Portage's map uses (see maps/stripe-paypal.json, "events"). */
export const RELAY_EVENT_TYPES = [
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.PENDING",
  "PAYMENT.CAPTURE.DENIED",
  "PAYMENT.CAPTURE.REFUNDED",
  "PAYMENT.CAPTURE.REVERSED",
] as const;

export class RelayError extends Error {}

export interface RelayEvent {
  seq: number;
  receivedAt: number;
  headers: Record<string, string>;
  body: string;
}

export interface EventSummary {
  eventId: string | null;
  eventType: string | null;
  resourceId: string | null;
  orderId: string | null;
  captureId: string | null;
}

export function newChannel(): string {
  return `ptg_${randomBytes(18).toString("base64url")}`;
}

/** What an event is about: the PayPal order and capture, from the shapes PayPal sends for capture and refund events. */
export function summarizeEvent(body: string): EventSummary {
  try {
    const e = JSON.parse(body) as {
      id?: string;
      event_type?: string;
      resource?: { id?: string; supplementary_data?: { related_ids?: { order_id?: string } }; links?: { rel?: string; href?: string }[] };
    };
    const r = e.resource ?? {};
    const type = e.event_type ?? null;
    let captureId: string | null = null;
    if (type?.startsWith("PAYMENT.CAPTURE.") && type !== "PAYMENT.CAPTURE.REFUNDED") captureId = r.id ?? null;
    else {
      const up = r.links?.find((l) => l.rel === "up" && /\/captures\//.test(l.href ?? ""));
      captureId = up?.href?.match(/\/captures\/([^/?#]+)/)?.[1] ?? null;
    }
    return { eventId: e.id ?? null, eventType: type, resourceId: r.id ?? null, orderId: r.supplementary_data?.related_ids?.order_id ?? null, captureId };
  } catch {
    return { eventId: null, eventType: null, resourceId: null, orderId: null, captureId: null };
  }
}

async function fetchWithRetry(url: string, init: RequestInit, attempts = 3, timeoutMs = 30_000): Promise<Response> {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
      if ((res.status === 429 || res.status >= 500) && i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
        continue;
      }
      return res;
    } catch (err) {
      if (i >= attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
}

/** Free Render services sleep when idle and take up to a minute to wake. */
export async function wakeRelay(relayUrl: string, timeoutMs = 120_000): Promise<number> {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${relayUrl}/health`, { signal: AbortSignal.timeout(30_000) });
      if (res.ok) return Date.now() - start;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = (err as Error).message;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new RelayError(`The webhook relay at ${relayUrl} didn't answer within ${Math.round(timeoutMs / 1000)}s (${last}).`);
}

export async function pollRelay(relayUrl: string, channel: string, after: number, waitS: number, signal?: AbortSignal): Promise<{ latest: number; events: RelayEvent[] }> {
  const res = await fetch(`${relayUrl}/channels/${encodeURIComponent(channel)}/events?after=${after}&wait=${waitS}`, {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout((waitS + 30) * 1000)]) : AbortSignal.timeout((waitS + 30) * 1000),
  });
  if (!res.ok) throw new RelayError(`Relay answered HTTP ${res.status}.`);
  return (await res.json()) as { latest: number; events: RelayEvent[] };
}

export interface Delivery extends EventSummary {
  seq: number;
  /** The app's HTTP status, or null when it couldn't be reached. */
  status: number | null;
  ok: boolean;
  error?: string;
  at: number;
}

/** Posts one event to the app as PayPal sent it. */
export async function deliver(target: string, headers: Record<string, string>, body: string): Promise<{ status: number | null; error?: string }> {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) if (k.startsWith("paypal-") || k === "content-type" || k === "user-agent") h[k] = v;
  h["content-type"] ??= "application/json";
  try {
    const res = await fetch(target, { method: "POST", headers: h, body, redirect: "manual", signal: AbortSignal.timeout(30_000) });
    await res.arrayBuffer().catch(() => undefined);
    return { status: res.status };
  } catch (err) {
    return { status: null, error: (err as Error).message };
  }
}

/** Long-polls the relay and forwards new events to the app until stopped. */
export class Forwarder {
  readonly deliveries: Delivery[] = [];
  /** Raw events, kept so a test can replay or alter one. */
  readonly events: RelayEvent[] = [];
  private after = 0;
  private stopped = false;
  private abort = new AbortController();
  private loop?: Promise<void>;
  private listeners = new Set<() => void>();
  lastError?: string;

  constructor(
    private readonly relayUrl: string,
    private readonly channel: string,
    private readonly target: string,
    private readonly log: (m: string) => void = () => {},
  ) {}

  /** Starts after the newest event already on the relay, so old events aren't replayed. */
  async start(): Promise<void> {
    const first = await pollRelay(this.relayUrl, this.channel, 0, 0);
    this.after = first.latest;
    this.loop = this.run();
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      try {
        const { events } = await pollRelay(this.relayUrl, this.channel, this.after, 20, this.abort.signal);
        this.lastError = undefined;
        for (const e of events) {
          this.after = Math.max(this.after, e.seq);
          this.events.push(e);
          const summary = summarizeEvent(e.body);
          const r = await deliver(this.target, e.headers, e.body);
          const d: Delivery = { ...summary, seq: e.seq, status: r.status, ok: r.status !== null && r.status >= 200 && r.status < 300, error: r.error, at: Date.now() };
          this.deliveries.push(d);
          this.log(`webhook ${d.eventType ?? "?"} → app answered ${d.status ?? d.error}`);
          for (const l of this.listeners) l();
        }
      } catch (err) {
        if (this.stopped) break;
        this.lastError = (err as Error).message;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  /** Resolves with the first delivery matching the test, or null after the timeout. */
  waitFor(test: (d: Delivery) => boolean, timeoutMs: number): Promise<Delivery | null> {
    const found = this.deliveries.find(test);
    if (found) return Promise.resolve(found);
    return new Promise((resolve) => {
      const check = () => {
        const d = this.deliveries.find(test);
        if (d) finish(d);
      };
      const finish = (d: Delivery | null) => {
        clearTimeout(timer);
        this.listeners.delete(check);
        resolve(d);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      this.listeners.add(check);
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    await this.loop?.catch(() => undefined);
  }
}

// --- Registering the webhook with PayPal ---

const KEYS = ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_ENVIRONMENT", "PORTAGE_RELAY_URL", "PORTAGE_RELAY_CHANNEL", "PAYPAL_WEBHOOK_ID"] as const;

export interface RelaySetupOptions {
  appDir: string;
  /** Env files to read credentials from (relative to appDir or absolute). Default .env.local, .env. */
  envFiles?: string[];
  /** The env file to write PAYPAL_WEBHOOK_ID, PORTAGE_RELAY_URL and PORTAGE_RELAY_CHANNEL to. Default: the first of envFiles. */
  writeTo?: string;
  relayUrl?: string;
  /** For tests. */
  paypalApiBase?: string;
  /** For tests: skip waking the relay. */
  skipWake?: boolean;
}

export interface RelaySetupResult {
  relayUrl: string;
  webhookId: string;
  reusedWebhook: boolean;
  newChannel: boolean;
  eventTypes: string[];
  envFile: string;
  replaced: string[];
  added: string[];
  settingsFrom: Record<string, string>;
  relayWokeInMs: number | null;
}

export async function paypalAccessToken(base: string, id: string, secret: string): Promise<string> {
  const res = await fetchWithRetry(`${base}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new RelayError(`PayPal sign-in failed (HTTP ${res.status}). Check PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.`);
  return ((await res.json()) as { access_token: string }).access_token;
}

export async function setupWebhookRelay(opts: RelaySetupOptions): Promise<RelaySetupResult> {
  const appDir = path.resolve(opts.appDir);
  const envFiles = opts.envFiles ?? [".env.local", ".env"];
  const { values, from } = readEnv(appDir, envFiles, KEYS);
  if (values.PAYPAL_ENVIRONMENT && values.PAYPAL_ENVIRONMENT !== "sandbox") throw new RelayError("Portage only registers webhooks in the PayPal sandbox. Set PAYPAL_ENVIRONMENT=sandbox.");
  if (!values.PAYPAL_CLIENT_ID || !values.PAYPAL_CLIENT_SECRET) throw new RelayError(`PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET not found in ${envFiles.join(", ")} or the environment.`);

  const relayUrl = (opts.relayUrl ?? values.PORTAGE_RELAY_URL ?? DEFAULT_RELAY_URL).replace(/\/$/, "");
  if (!/^https:\/\//.test(relayUrl) && !opts.paypalApiBase) throw new RelayError("PayPal only delivers webhooks to HTTPS URLs; the relay URL must start with https://.");
  const channel = values.PORTAGE_RELAY_CHANNEL && /^[A-Za-z0-9_-]{20,64}$/.test(values.PORTAGE_RELAY_CHANNEL) ? values.PORTAGE_RELAY_CHANNEL : newChannel();
  const hookUrl = `${relayUrl}/hooks/${channel}`;

  const relayWokeInMs = opts.skipWake ? null : await wakeRelay(relayUrl);

  const base = (opts.paypalApiBase ?? "https://api-m.sandbox.paypal.com").replace(/\/$/, "");
  const token = await paypalAccessToken(base, values.PAYPAL_CLIENT_ID, values.PAYPAL_CLIENT_SECRET);
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const list = await fetchWithRetry(`${base}/v1/notifications/webhooks`, { headers: auth });
  if (!list.ok) throw new RelayError(`Listing PayPal webhooks failed (HTTP ${list.status}).`);
  const existing = ((await list.json()) as { webhooks?: { id: string; url: string }[] }).webhooks ?? [];
  let webhookId = existing.find((w) => w.url === hookUrl)?.id;
  const reusedWebhook = !!webhookId;

  if (!webhookId) {
    const res = await fetchWithRetry(`${base}/v1/notifications/webhooks`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ url: hookUrl, event_types: RELAY_EVENT_TYPES.map((name) => ({ name })) }),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; name?: string; message?: string; debug_id?: string };
    if (!res.ok || !body.id) {
      if (body.name === "WEBHOOK_NUMBER_LIMIT_EXCEEDED") {
        throw new RelayError("This PayPal sandbox app already has the maximum of 10 webhooks. Delete one in the PayPal developer dashboard (Apps & Credentials → your app → Webhooks), then run this again.");
      }
      throw new RelayError(`PayPal refused the webhook (HTTP ${res.status}${body.name ? `, ${body.name}` : ""}${body.debug_id ? `, debug_id ${body.debug_id}` : ""}).`);
    }
    webhookId = body.id;
  }

  const envFile = path.resolve(appDir, opts.writeTo ?? envFiles[0]);
  const { replaced, added } = writeEnv(envFile, { PAYPAL_WEBHOOK_ID: webhookId, PORTAGE_RELAY_URL: relayUrl, PORTAGE_RELAY_CHANNEL: channel });

  return {
    relayUrl,
    webhookId,
    reusedWebhook,
    newChannel: channel !== values.PORTAGE_RELAY_CHANNEL,
    eventTypes: [...RELAY_EVENT_TYPES],
    envFile: path.relative(appDir, envFile) || envFile,
    replaced,
    added,
    settingsFrom: from as Record<string, string>,
    relayWokeInMs,
  };
}

export function renderRelaySetup(r: RelaySetupResult): string {
  return [
    "# PayPal webhooks via the Portage relay",
    "",
    `- **Relay:** ${r.relayUrl}${r.relayWokeInMs !== null ? ` (answered in ${(r.relayWokeInMs / 1000).toFixed(1)}s)` : ""}`,
    `- **PayPal webhook:** ${r.webhookId} (${r.reusedWebhook ? "already registered, reused" : "registered now"}), for ${r.eventTypes.join(", ")}`,
    `- **Channel:** ${r.newChannel ? "new private channel" : "existing channel"} (kept in ${r.envFile}; it isn't shown here because anyone with it can read this app's sandbox webhooks)`,
    `- **Wrote to ${r.envFile}:** ${[...r.replaced.map((k) => `${k} (replaced)`), ...r.added.map((k) => `${k} (added)`)].join(", ")}`,
    "",
    "Restart the app so it reads the new PAYPAL_WEBHOOK_ID: it must match the webhook PayPal signed the event for, or verification fails.",
    "verify_checkout forwards the relay's events to the app while it runs. To forward them during development, run `npx portage relay forward <app folder> --to <the app's PayPal webhook URL>`.",
  ].join("\n");
}
