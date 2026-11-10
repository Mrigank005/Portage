import Stripe from "stripe";

// For tests, STRIPE_API_BASE points the official Stripe SDK at a local Stripe-compatible server (Standin),
// the same way Stripe documents pointing it at stripe-mock. Unset it to talk to real Stripe.
const base = process.env.STRIPE_API_BASE ? new URL(process.env.STRIPE_API_BASE) : null;

export const stripe = new Stripe(
  process.env.STRIPE_SECRET_KEY!,
  base
    ? {
        host: base.hostname,
        port: Number(base.port || (base.protocol === "https:" ? 443 : 80)),
        protocol: base.protocol.replace(":", "") as "http" | "https",
      }
    : {},
);
