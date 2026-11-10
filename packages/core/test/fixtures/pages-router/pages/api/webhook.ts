import type { NextApiRequest, NextApiResponse } from "next";
import { buffer } from "micro";
import { getStripe } from "~/lib/stripe";
import { markPaid } from "~/lib/orders";

export const config = { api: { bodyParser: false } };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const sig = req.headers["stripe-signature"] as string;
  const event = getStripe().webhooks.constructEvent(await buffer(req), sig, process.env.STRIPE_WEBHOOK_SECRET!);
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    await markPaid(session.client_reference_id!);
  }
  res.json({ received: true });
}
