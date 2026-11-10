import Fastify from "fastify";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const app = Fastify();

app.post("/checkout", async () => {
  const session = await stripe.checkout.sessions.create({ mode: "payment", line_items: [{ price: "price_FASTIFY12345", quantity: 1 }], success_url: "https://example.com" });
  return { url: session.url };
});

await app.listen({ port: 3000 });
