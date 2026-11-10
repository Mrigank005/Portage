import payments from "@/lib/stripe";

export async function POST(request: Request) {
  const { orderId, amount } = await request.json();
  const session = await payments.checkout.sessions.create({
    mode: "payment",
    client_reference_id: orderId,
    line_items: [{ price_data: { currency: "jpy", unit_amount: amount, product_data: { name: "Order" } }, quantity: 1 }],
    success_url: "https://example.com/thanks",
  });
  return Response.json({ url: session.url });
}
