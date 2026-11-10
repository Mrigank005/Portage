// Webhook signing and delivery, using Stripe's documented Stripe-Signature scheme:
//   Stripe-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" with the endpoint secret>
// so the official SDK's stripe.webhooks.constructEvent verifies Standin's events unchanged.
import { createHmac } from "node:crypto";
import type { Obj } from "./core.ts";

export function signPayload(payload: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

export interface Delivery {
  account: string;
  eventId: string;
  type: string;
  url: string;
  ok: boolean;
  status: number | null;
  attempts: number;
  error?: string;
  at: string;
}

const RETRY_DELAYS_MS = [0, 1000, 3000];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Delivers one event to one endpoint, with up to three attempts, and records the outcome.
 * Resolves to true when the endpoint accepted the event.
 */
export async function deliverEvent(args: {
  account: string;
  endpoint: Obj;
  event: Obj;
  secret: string;
  deliveries: Delivery[];
  log: (line: string) => void;
}): Promise<boolean> {
  const { account, endpoint, event, secret, deliveries, log } = args;
  const payload = JSON.stringify(event);
  const record: Delivery = {
    account,
    eventId: event.id,
    type: event.type,
    url: endpoint.url,
    ok: false,
    status: null,
    attempts: 0,
    at: new Date().toISOString(),
  };
  deliveries.push(record);
  if (deliveries.length > 500) deliveries.splice(0, deliveries.length - 500);

  for (const delay of RETRY_DELAYS_MS) {
    if (delay) await sleep(delay);
    record.attempts++;
    try {
      const res = await fetch(endpoint.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Stripe-Signature": signPayload(payload, secret),
          "User-Agent": "Standin/0.1 (Stripe-compatible test server)",
        },
        body: payload,
        signal: AbortSignal.timeout(10_000),
      });
      record.status = res.status;
      delete record.error;
      if (res.ok) {
        record.ok = true;
        log(`webhook ${event.type} -> ${endpoint.url} ${res.status}`);
        return true;
      }
    } catch (e) {
      record.error = (e as Error).message;
    }
  }
  log(`webhook ${event.type} -> ${endpoint.url} FAILED after ${record.attempts} attempts (${record.error ?? record.status})`);
  return false;
}
