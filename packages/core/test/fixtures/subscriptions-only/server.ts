import express from "express";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const app = express();

app.post("/subscribe", async (_req, res) => {
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: process.env.STRIPE_PRICE_PRO!, quantity: 1 }],
    success_url: "https://example.com/welcome",
  });
  res.redirect(303, session.url!);
});

app.post("/portal", async (req, res) => {
  const portal = await stripe.billingPortal.sessions.create({ customer: String(req.query.customer), return_url: "https://example.com" });
  res.redirect(303, portal.url);
});

app.listen(3000);
