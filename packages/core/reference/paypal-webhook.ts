// Portage reference: verify a PayPal webhook before trusting it.
//
// The PayPal Server SDK has no webhook methods (confirmed through ContextMatic), so this calls PayPal's REST API
// directly: POST /v1/notifications/verify-webhook-signature, with an OAuth token for the same credentials.
// The event is passed to PayPal exactly as received (the raw body text), never re-serialised, because PayPal checks
// the signature over the original bytes.
import { randomUUID } from "node:crypto";

export interface PayPalWebhookEvent {
  id: string;
  event_type: string;
  resource_type?: string;
  resource: Record<string, unknown> & {
    id?: string;
    status?: string;
    custom_id?: string;
    amount?: { currency_code?: string; value?: string };
    supplementary_data?: { related_ids?: { order_id?: string } };
    /** On refund events: total_refunded_amount is the running refunded total for the capture. */
    seller_payable_breakdown?: { total_refunded_amount?: { currency_code?: string; value?: string } };
    links?: { href: string; rel: string; method?: string }[];
  };
  create_time?: string;
}

export type WebhookVerification = { verified: true; event: PayPalWebhookEvent } | { verified: false; reason: string };

const HEADERS = ["paypal-transmission-id", "paypal-transmission-time", "paypal-transmission-sig", "paypal-cert-url", "paypal-auth-algo"] as const;

/** PayPal's REST base URL for the configured environment. PAYPAL_API_BASE overrides it (for tests only). */
export function paypalApiBase(): string {
  if (process.env.PAYPAL_API_BASE) return process.env.PAYPAL_API_BASE.replace(/\/$/, "");
  return process.env.PAYPAL_ENVIRONMENT === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
}

/**
 * fetch with up to two retries, with backoff, for dropped connections, 429 and 5xx. Safe for these calls: getting a
 * token and verifying a signature change nothing at PayPal.
 */
async function fetchWithRetry(url: string, init: RequestInit, attempts = 3): Promise<Response> {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, init);
      if ((res.status === 429 || res.status >= 500) && i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** i));
        continue;
      }
      return res;
    } catch (err) {
      if (i >= attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
  }
}

let cached: { token: string; expiresAt: number } | undefined;

/** A client-credentials access token, cached until a minute before it expires (PayPal sends expires_in). */
export async function paypalAccessToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt) return cached.token;
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error("PayPal is not configured: set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET");
  const res = await fetchWithRetry(`${paypalApiBase()}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`PayPal OAuth failed with HTTP ${res.status}`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: data.access_token, expiresAt: Date.now() + Math.max(0, data.expires_in - 60) * 1000 };
  return data.access_token;
}

function header(headers: Headers | Record<string, string | string[] | undefined>, name: string): string | undefined {
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? undefined;
  const record = headers as Record<string, string | string[] | undefined>;
  const key = Object.keys(record).find((k) => k.toLowerCase() === name);
  const v = key ? record[key] : undefined;
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Verifies a webhook delivery with PayPal.
 * @param headers the request headers (a Fetch `Headers`, or Node/Express `req.headers`)
 * @param rawBody the request body exactly as received, as text
 */
export async function verifyPayPalWebhook(headers: Headers | Record<string, string | string[] | undefined>, rawBody: string): Promise<WebhookVerification> {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) return { verified: false, reason: "PAYPAL_WEBHOOK_ID is not set" };
  const values = HEADERS.map((h) => header(headers, h));
  if (values.some((v) => !v)) return { verified: false, reason: "missing PayPal transmission headers" };

  let event: PayPalWebhookEvent;
  try {
    event = JSON.parse(rawBody) as PayPalWebhookEvent;
  } catch {
    return { verified: false, reason: "body is not JSON" };
  }
  if (!event || typeof event.event_type !== "string") return { verified: false, reason: "body is not a PayPal event" };

  const [transmissionId, transmissionTime, transmissionSig, certUrl, authAlgo] = values as string[];
  // Splice the raw body in as the event so PayPal sees the original bytes.
  const body =
    `{"auth_algo":${JSON.stringify(authAlgo)},"cert_url":${JSON.stringify(certUrl)},"transmission_id":${JSON.stringify(transmissionId)},` +
    `"transmission_sig":${JSON.stringify(transmissionSig)},"transmission_time":${JSON.stringify(transmissionTime)},` +
    `"webhook_id":${JSON.stringify(webhookId)},"webhook_event":${rawBody}}`;

  const res = await fetchWithRetry(`${paypalApiBase()}/v1/notifications/verify-webhook-signature`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await paypalAccessToken()}`, "Content-Type": "application/json", "PayPal-Request-Id": randomUUID() },
    body,
  });
  if (!res.ok) {
    // Say which field PayPal rejected (for example a malformed webhook_id), without echoing any values.
    const err = (await res.json().catch(() => ({}))) as { name?: string; details?: { field?: string; issue?: string }[] };
    const d = err.details?.[0];
    return { verified: false, reason: `verification call failed with HTTP ${res.status}${d ? `: ${d.field ?? ""} ${d.issue ?? ""}`.trimEnd() : err.name ? `: ${err.name}` : ""}` };
  }
  const result = (await res.json()) as { verification_status?: string };
  return result.verification_status === "SUCCESS" ? { verified: true, event } : { verified: false, reason: `verification_status ${result.verification_status ?? "missing"}` };
}

/** For PAYMENT.CAPTURE.REFUNDED: the refund's resource links "up" to the capture it refunds. */
export function capturedPaymentIdOfRefund(event: PayPalWebhookEvent): string | undefined {
  const up = event.resource.links?.find((l) => l.rel === "up" && /\/captures\//.test(l.href));
  return up ? up.href.split("/captures/")[1]?.split(/[/?]/)[0] : undefined;
}
