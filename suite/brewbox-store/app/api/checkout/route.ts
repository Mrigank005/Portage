import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { stripe } from "@/lib/stripe";
import { createOrder, updateOrder } from "@/lib/orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const form = await request.formData();
  const priceId = String(form.get("priceId") ?? "");
  const quantity = Math.min(Math.max(parseInt(String(form.get("quantity") ?? "1"), 10) || 1, 1), 10);
  if (!priceId) return NextResponse.json({ error: "priceId is required" }, { status: 400 });

  // Never trust a price sent by the browser: read it from Stripe.
  let price: Stripe.Price;
  try {
    price = await stripe.prices.retrieve(priceId, { expand: ["product"] });
  } catch {
    return NextResponse.json({ error: "That product is not available" }, { status: 400 });
  }
  if (!price.active || price.unit_amount === null) {
    return NextResponse.json({ error: "That product is not available" }, { status: 400 });
  }
  const product = price.product as Stripe.Product;

  const order = createOrder({
    items: [{ priceId, name: product.name, quantity, unitAmount: price.unit_amount }],
    currency: price.currency,
  });

  const origin = process.env.APP_URL ?? new URL(request.url).origin;
  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ price: priceId, quantity }],
      success_url: `${origin}/order/${order.id}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/`,
      client_reference_id: order.id,
      metadata: { orderId: order.id },
    });
  } catch {
    updateOrder(order.id, { status: "failed" });
    return NextResponse.json({ error: "Checkout is unavailable right now. Please try again." }, { status: 502 });
  }
  updateOrder(order.id, { stripeSessionId: session.id });

  return NextResponse.redirect(session.url!, 303);
}
