import { stripe } from "@/lib/stripe";

export async function POST() {
  const account = await stripe.accounts.create({ type: "express" });
  const link = await stripe.accountLinks.create({ account: account.id, type: "account_onboarding", refresh_url: "https://example.com", return_url: "https://example.com" });
  return Response.json({ url: link.url });
}
