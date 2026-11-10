"use client";
// Portage reference: PayPal buttons for a React or Next.js page, on PayPal's JS SDK v6 through
// @paypal/react-paypal-js/sdk-v6 (the pattern in PayPal's official v6 samples).
//
// Wrap the page (or the part with buttons) in <PayPalCheckoutProvider> once, then put a <PayPalCheckoutButton> where
// the existing checkout button is. The button sends the same form fields the existing checkout form sends (pass the
// form's id), so quantity pickers and hidden product fields keep working. The server creates and captures the order;
// the browser never decides the amount.
import { useState, type ReactNode } from "react";
import { PayPalOneTimePaymentButton, PayPalProvider, type OnApproveDataOneTimePayments } from "@paypal/react-paypal-js/sdk-v6";

export function PayPalCheckoutProvider({
  clientId,
  environment = "sandbox",
  children,
}: {
  /** The app's public PayPal client ID (it is safe to send to the browser; the secret never is). */
  clientId: string | undefined;
  environment?: "sandbox" | "production";
  children: ReactNode;
}) {
  if (!clientId) return <>{children}</>; // PayPal not configured: the page still works with its other checkout.
  return (
    <PayPalProvider clientId={clientId} environment={environment} components={["paypal-payments"]} pageType="checkout">
      {children}
    </PayPalProvider>
  );
}

export function PayPalCheckoutButton({
  createOrderUrl,
  captureOrderUrl,
  formId,
  payload,
}: {
  /** Server route that creates the PayPal order and answers { orderId }. */
  createOrderUrl: string;
  /** Server route that captures it; "{orderId}" is replaced. It answers { redirectUrl } on success. */
  captureOrderUrl: string;
  /** Optional id of the existing checkout form whose fields describe what is being bought. */
  formId?: string;
  /** Extra fields to send with the create-order request. */
  payload?: Record<string, string>;
}) {
  const [error, setError] = useState<string | null>(null);

  const createOrder = async (): Promise<{ orderId: string }> => {
    setError(null);
    const fields: Record<string, string> = { ...payload };
    const form = formId ? (document.getElementById(formId) as HTMLFormElement | null) : null;
    if (form) for (const [k, v] of new FormData(form)) if (typeof v === "string") fields[k] = v;
    const res = await fetch(createOrderUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fields) });
    const data = (await res.json().catch(() => ({}))) as { orderId?: string; error?: string };
    if (!res.ok || !data.orderId) {
      const message = data.error ?? "PayPal checkout is unavailable right now.";
      setError(message);
      throw new Error(message);
    }
    return { orderId: data.orderId };
  };

  const onApprove = async ({ orderId }: OnApproveDataOneTimePayments) => {
    const res = await fetch(captureOrderUrl.replace("{orderId}", encodeURIComponent(orderId)), { method: "POST" });
    const data = (await res.json().catch(() => ({}))) as { redirectUrl?: string; error?: string };
    if (res.ok && data.redirectUrl) window.location.assign(data.redirectUrl);
    else setError(data.error ?? "The payment could not be completed. You have not been charged.");
  };

  return (
    <div className="paypal-checkout">
      <PayPalOneTimePaymentButton
        createOrder={createOrder}
        presentationMode="auto"
        onApprove={onApprove}
        onCancel={() => setError(null)}
        onError={() => setError("PayPal ran into a problem. Please try again.")}
      />
      {error ? (
        <p role="alert" className="paypal-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
