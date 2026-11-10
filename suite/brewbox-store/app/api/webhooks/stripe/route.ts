import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { stripe } from "@/lib/stripe";
import { fulfillOrder, recordRefund } from "@/lib/fulfilment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  // Signature checks need the exact bytes Stripe sent, so read the body as text.
  const payload = await request.text();
  const signature = request.headers.get("stripe-signature") ?? "";

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(payload, signature, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch {
    return new Response("Webhook signature verification failed", { status: 400 });
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.payment_status === "paid" && session.client_reference_id) {
        fulfillOrder(session.client_reference_id, {
          sessionId: session.id,
          paymentIntentId: typeof session.payment_intent === "string" ? session.payment_intent : (session.payment_intent?.id ?? null),
          email: session.customer_details?.email ?? null,
        });
      }
      break;
    }
    case "charge.refunded": {
      const charge = event.data.object as Stripe.Charge;
      const paymentIntentId = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
      if (paymentIntentId) recordRefund(paymentIntentId, charge.amount_refunded, charge.refunded);
      break;
    }
    default:
      // Other events are acknowledged and ignored.
      break;
  }

  return NextResponse.json({ received: true });
}
