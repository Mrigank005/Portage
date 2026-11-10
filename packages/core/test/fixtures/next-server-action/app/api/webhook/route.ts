import { stripe } from "@/lib/stripe";
import { grantAccess } from "@/lib/access";

export async function POST(req: Request) {
  let data;
  let eventType;
  const event = stripe.webhooks.constructEvent(await req.text(), req.headers.get("stripe-signature")!, process.env.STRIPE_WEBHOOK_SECRET!);
  data = event.data;
  eventType = event.type;
  if (eventType === "checkout.session.completed") {
    await grantAccess(data.object);
  }
  return new Response("ok");
}
