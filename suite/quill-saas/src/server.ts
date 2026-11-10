// Quill: sells credit packs for a writing assistant. Express, Stripe Checkout with inline prices, webhooks.
import express from "express";
import type Stripe from "stripe";
import { stripe } from "./stripe.js";
import { accountFor, addCredits, createPurchase, findByPaymentIntent, getPurchase, updatePurchase } from "./db.js";

const PORT = Number(process.env.PORT ?? 4301);
const HOST = process.env.HOST ?? "127.0.0.1";
const BASE_URL = process.env.APP_URL ?? `http://localhost:${PORT}`;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "quill-admin";

const PACKS = {
  starter: { name: "Starter", credits: 100, cents: 900 },
  team: { name: "Team", credits: 500, cents: 3900 },
} as const;
type PackId = keyof typeof PACKS;

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>:root{color-scheme:light dark;--bg:#f6f5fa;--card:#fff;--ink:#1c1a2b;--muted:#625f78;--line:#dedbea;--accent:#4b3fd1}
@media (prefers-color-scheme:dark){:root{--bg:#12111c;--card:#1b1a29;--ink:#e9e7f5;--muted:#a09db8;--line:#2d2b42;--accent:#a49dff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:720px;margin:0 auto;padding:40px 16px}h1{font-size:1.8rem;margin:0 0 6px}p.lede{color:var(--muted);margin:0 0 24px}
.packs{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px}.pack{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px;display:flex;flex-direction:column;gap:8px}
.pack h2{margin:0;font-size:1.1rem}.price{font-size:1.4rem;font-weight:650}label{font-size:.85rem;color:var(--muted)}
input,button{font:inherit;border-radius:8px;border:1px solid var(--line);padding:9px 11px;background:transparent;color:inherit}button{background:var(--accent);color:#fff;border-color:var(--accent);font-weight:600;cursor:pointer}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;font-size:.92rem}th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line)}
a{color:var(--accent)}button:focus-visible,input:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}</style></head><body><main>${body}</main></body></html>`;

const app = express();

// --- Webhooks. This route needs the raw request body, so it is registered before the body parsers. ---
app.post("/webhooks/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.header("stripe-signature") ?? "", process.env.STRIPE_WEBHOOK_SECRET!);
  } catch {
    res.status(400).send("Webhook signature verification failed");
    return;
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const purchase = session.client_reference_id ? getPurchase(session.client_reference_id) : undefined;
    if (purchase && purchase.status === "pending" && session.payment_status === "paid") {
      // Confirm what was bought from the session's line items, then grant the credits.
      const items = await stripe.checkout.sessions.listLineItems(session.id);
      console.log(`[quill] ${purchase.id} paid: ${items.data.map((i) => `${i.description} x${i.quantity}`).join(", ")}`);
      updatePurchase(purchase.id, {
        status: "paid",
        sessionId: session.id,
        paymentIntentId: typeof session.payment_intent === "string" ? session.payment_intent : (session.payment_intent?.id ?? null),
      });
      addCredits(purchase.email, purchase.credits);
    }
  } else if (event.type === "charge.refunded") {
    const charge = event.data.object as Stripe.Charge;
    const pi = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
    const purchase = pi ? findByPaymentIntent(pi) : undefined;
    if (purchase) {
      // Take back credits in proportion to the amount refunded.
      const shouldBeClawedBack = Math.round((purchase.credits * charge.amount_refunded) / purchase.amount);
      const delta = shouldBeClawedBack - purchase.creditsClawedBack;
      if (delta > 0) addCredits(purchase.email, -delta);
      updatePurchase(purchase.id, {
        status: charge.refunded ? "refunded" : "partially_refunded",
        refundedAmount: charge.amount_refunded,
        creditsClawedBack: shouldBeClawedBack,
      });
    }
  }
  res.json({ received: true });
});

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get("/", (_req, res) => {
  const cards = (Object.entries(PACKS) as [PackId, (typeof PACKS)[PackId]][])
    .map(
      ([id, p]) => `<form class="pack" method="post" action="/checkout"><h2>${p.name}</h2><div class="price">${money(p.cents)}</div>
      <div>${p.credits} credits</div><input type="hidden" name="pack" value="${id}">
      <label for="email-${id}">Email</label><input id="email-${id}" name="email" type="email" required placeholder="you@example.com">
      <button type="submit">Buy ${p.name}</button></form>`,
    )
    .join("");
  res.send(page("Quill", `<h1>Quill credits</h1><p class="lede">Credits power Quill's rewrite and summarise tools.</p><div class="packs">${cards}</div>`));
});

app.post("/checkout", async (req, res) => {
  const packId = String(req.body.pack ?? "");
  const email = String(req.body.email ?? "").trim().toLowerCase();
  // Own keys only: "constructor" or "__proto__" must not count as a pack.
  if (!Object.hasOwn(PACKS, packId) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    res.status(400).send(page("Quill", "<h1>Choose a pack and enter a valid email</h1><p><a href='/'>Back</a></p>"));
    return;
  }
  const pack = PACKS[packId as PackId];

  const purchase = createPurchase({ email, pack: packId, credits: pack.credits, amount: pack.cents, currency: "usd" });
  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: email,
      client_reference_id: purchase.id,
      line_items: [
        {
          price_data: {
            currency: "usd",
            unit_amount: pack.cents,
            product_data: { name: `Quill ${pack.name} credits`, description: `${pack.credits} credits` },
          },
          quantity: 1,
        },
      ],
      metadata: { purchaseId: purchase.id, pack: packId },
      success_url: `${BASE_URL}/account?email=${encodeURIComponent(email)}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/`,
    });
  } catch (err) {
    console.error("[quill] could not create a checkout session:", (err as Error).message);
    updatePurchase(purchase.id, { status: "failed" });
    res.status(502).send(page("Quill", "<h1>Checkout is unavailable right now</h1><p>Please try again in a moment. <a href='/'>Back</a></p>"));
    return;
  }
  updatePurchase(purchase.id, { sessionId: session.id });
  res.redirect(303, session.url!);
});

app.get("/account", (req, res) => {
  const email = String(req.query.email ?? "").toLowerCase();
  const acct = accountFor(email);
  const rows = acct.purchases
    .map((p) => `<tr><td>${esc(p.id)}</td><td>${esc(PACKS[p.pack as PackId]?.name ?? p.pack)}</td><td>${p.credits}</td><td>${money(p.amount)}</td><td>${esc(p.status.replace("_", " "))}</td></tr>`)
    .join("");
  res.send(
    page(
      "Your Quill account",
      `<h1>${esc(email || "Account")}</h1><p class="lede"><strong>${acct.credits}</strong> credits available.</p>
      <table><thead><tr><th>Purchase</th><th>Pack</th><th>Credits</th><th>Paid</th><th>Status</th></tr></thead><tbody>${rows || "<tr><td colspan='5'>No purchases yet.</td></tr>"}</tbody></table>
      <p><a href="/">Buy more credits</a></p>`,
    ),
  );
});

app.get("/api/purchases", (req, res) => {
  res.json(accountFor(String(req.query.email ?? "").toLowerCase()));
});

// Demo admin action, protected by a shared token: refund a purchase fully, or partly with `amount` in cents.
app.post("/admin/refund", async (req, res) => {
  if (req.header("x-admin-token") !== ADMIN_TOKEN) {
    res.status(401).json({ error: "Missing or wrong admin token" });
    return;
  }
  const purchase = getPurchase(String(req.body.purchaseId ?? ""));
  if (!purchase?.paymentIntentId) {
    res.status(404).json({ error: "Purchase not found or not paid" });
    return;
  }
  try {
    const refund = await stripe.refunds.create({
      payment_intent: purchase.paymentIntentId,
      ...(req.body.amount ? { amount: Number(req.body.amount) } : {}),
    });
    res.json({ refunded: refund.amount });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Last-resort error handler. Express's default handler copies an error's `headers` onto the response, and
// Stripe errors carry Stripe's own response headers, which produces a malformed reply. Answer plainly instead.
const onError: express.ErrorRequestHandler = (err, _req, res, _next) => {
  console.error("[quill] unhandled error:", err instanceof Error ? err.message : err);
  if (res.headersSent) return;
  res.status(500).type("text/plain").send("Something went wrong. Please try again.");
};
app.use(onError);

app.listen(PORT, HOST, () => console.log(`[quill] listening on ${BASE_URL} (bound to ${HOST})`));
