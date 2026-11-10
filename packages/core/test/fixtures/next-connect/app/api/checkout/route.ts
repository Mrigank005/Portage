import { stripe } from "@/lib/stripe";

export async function POST(request: Request) {
  const { sellerAccount, cents } = await request.json();
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{ price_data: { currency: "usd", unit_amount: cents, product_data: { name: "Listing" } }, quantity: 1 }],
    payment_intent_data: { application_fee_amount: 100, transfer_data: { destination: sellerAccount } },
    success_url: "https://example.com/done",
  });
  return Response.json({ url: session.url });
}
