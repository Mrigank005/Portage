import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export async function POST() {
  const intent = await stripe.paymentIntents.create({ amount: 2400, currency: "eur", automatic_payment_methods: { enabled: true } });
  return Response.json({ clientSecret: intent.client_secret });
}
