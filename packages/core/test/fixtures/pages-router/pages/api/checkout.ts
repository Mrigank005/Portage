import type { NextApiRequest, NextApiResponse } from "next";
import { getStripe } from "~/lib/stripe";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();
  const params = {
    mode: "payment" as const,
    line_items: [{ price_data: { currency: "huf", unit_amount: 1045, product_data: { name: "Paprika" } }, quantity: 2 }],
    success_url: "https://example.com/thanks?session_id={CHECKOUT_SESSION_ID}",
    shipping_address_collection: { allowed_countries: ["HU" as const] },
  };
  const session = await getStripe().checkout.sessions.create(params);
  res.status(200).json({ id: session.id });
}
