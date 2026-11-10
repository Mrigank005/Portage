const express = require("express");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY, { apiVersion: "2026-10-28.endive" });

const app = express();
app.use(express.static("public"));

app.post("/create-checkout-session", async (req, res) => {
  const session = await stripe.checkout.sessions.create(
    {
      mode: "payment",
      line_items: [{ price: "price_1Px8k2EXAMPLEabcd", quantity: 1 }],
      success_url: `${process.env.DOMAIN}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.DOMAIN}/canceled.html`,
      allow_promotion_codes: true,
    },
    { idempotencyKey: req.get("Idempotency-Key") },
  );
  res.redirect(303, session.url);
});

app.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.sendStatus(400);
  }
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      fulfillCheckout(event.data.object.id);
      break;
    default:
      break;
  }
  res.sendStatus(200);
});

function fulfillCheckout(sessionId) {
  console.log("fulfilling", sessionId);
}

app.listen(4242);
