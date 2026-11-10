"use server";
import type Stripe from "stripe";
import { stripe } from "@/lib/stripe";

export async function startCheckout(price: { id: string; type: "one_time" | "recurring" }) {
  let params: Stripe.Checkout.SessionCreateParams = {
    line_items: [{ price: price.id, quantity: 1 }],
    ui_mode: "elements",
    return_url: "https://example.com/done?session_id={CHECKOUT_SESSION_ID}",
  };
  if (price.type === "recurring") {
    params = { ...params, mode: "subscription" };
  } else {
    params = { ...params, mode: "payment" };
  }
  const session = await stripe.checkout.sessions.create(params);
  return { clientSecret: session.client_secret };
}
