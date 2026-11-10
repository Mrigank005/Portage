// Portage reference: one shared PayPal Server SDK client for the app.
//
// Every SDK name here was confirmed through ContextMatic (APIMatic Context Plugin): fetch_api paypal,
// endpoint_search createOrder / captureOrder / refundCapturedPayment / getCapturedPayment, model_search Money.
// Typechecked against @paypal/paypal-server-sdk 2.x. Adapt the import paths and style to the app; keep the behaviour.
import { randomUUID } from "node:crypto";
import { ApiError, Client, CustomError, Environment, OrdersController, PaymentsController } from "@paypal/paypal-server-sdk";

/** "sandbox" unless PAYPAL_ENVIRONMENT is explicitly "live". */
export const paypalEnvironment: "sandbox" | "live" = process.env.PAYPAL_ENVIRONMENT === "live" ? "live" : "sandbox";

let client: Client | undefined;

/**
 * The SDK client, created on first use so that importing this module during a build (when PayPal settings may be
 * absent) doesn't throw. The SDK fetches and caches its OAuth token itself.
 */
export function paypalClient(): Client {
  if (client) return client;
  const oAuthClientId = process.env.PAYPAL_CLIENT_ID;
  const oAuthClientSecret = process.env.PAYPAL_CLIENT_SECRET;
  if (!oAuthClientId || !oAuthClientSecret) {
    throw new Error("PayPal is not configured: set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET");
  }
  client = new Client({
    clientCredentialsAuthCredentials: { oAuthClientId, oAuthClientSecret },
    environment: paypalEnvironment === "live" ? Environment.Production : Environment.Sandbox,
    timeout: 15_000,
    httpClientOptions: {
      // Retry dropped connections, 429s and 5xx with backoff (PayPal recommends it). POST is included on purpose:
      // every POST here sends a PayPal-Request-Id, so a retried POST returns the original result instead of
      // charging twice. The SDK's defaults are no retries, and never for POST.
      retryConfig: {
        maxNumberOfRetries: 2,
        retryOnTimeout: true, // the SDK treats network errors (ECONNRESET, ...) as timeouts
        maximumRetryWaitTime: 10,
        httpMethodsToRetry: ["GET", "PUT", "POST", "PATCH"],
      },
    },
    // No `logging` option on purpose: with one, the SDK logs every request and response, which can include payer
    // details. Log failures yourself with describePayPalError.
  });
  return client;
}

export const ordersApi = (): OrdersController => new OrdersController(paypalClient());
export const paymentsApi = (): PaymentsController => new PaymentsController(paypalClient());

/** A fresh PayPal-Request-Id. Send one with every POST; reuse the same value when retrying the same request. */
export const paypalRequestId = (): string => randomUUID();

/** A log-safe description of a PayPal error, including PayPal's debug_id, which PayPal support asks for. */
export function describePayPalError(err: unknown): string {
  if (err instanceof ApiError) {
    // The SDK keeps PayPal's error body as sent (snake_case), and PayPal also returns the id as a header.
    const r = (err instanceof CustomError ? err.result : undefined) as { name?: string; message?: string; debug_id?: string; details?: { issue?: string }[] } | undefined;
    const debugId = r?.debug_id ?? err.headers?.["paypal-debug-id"] ?? (typeof err.body === "string" ? /"debug_id"\s*:\s*"([^"]+)"/.exec(err.body)?.[1] : undefined);
    const issue = r?.details?.[0]?.issue;
    const detail = [r?.name, issue ?? r?.message, debugId ? `debug_id ${debugId}` : ""].filter(Boolean).join(" · ");
    return `PayPal API error ${err.statusCode}${detail ? `: ${detail}` : ""}`;
  }
  return err instanceof Error ? err.message : String(err);
}
