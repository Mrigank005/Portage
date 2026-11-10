import { NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { getOrder } from "@/lib/orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Demo admin action: refund an order (fully, or partly when `amount` in cents is given).
export async function POST(request: Request) {
  const form = await request.formData();
  const order = getOrder(String(form.get("orderId") ?? ""));
  if (!order?.paymentIntentId) {
    return NextResponse.json({ error: "Order not found or not paid" }, { status: 404 });
  }

  // An amount that is present but not a positive whole number of cents is an error, never "refund everything".
  const rawAmount = String(form.get("amount") ?? "").trim();
  let amount: number | undefined;
  if (rawAmount !== "") {
    if (!/^\d+$/.test(rawAmount) || Number(rawAmount) <= 0) {
      return NextResponse.json({ error: "amount must be a positive whole number of cents" }, { status: 400 });
    }
    amount = Number(rawAmount);
  }

  try {
    await stripe.refunds.create({
      payment_intent: order.paymentIntentId,
      ...(amount !== undefined ? { amount } : {}),
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }

  const origin = process.env.APP_URL ?? new URL(request.url).origin;
  return NextResponse.redirect(`${origin}/admin/orders`, 303);
}
