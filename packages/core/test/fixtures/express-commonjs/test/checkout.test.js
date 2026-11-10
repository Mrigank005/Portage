// Test code: must not change what Portage concludes about the app.
const stripe = require("stripe")("sk_test_fixture");

test("subscription checkout", async () => {
  await stripe.checkout.sessions.create({ mode: "subscription", line_items: [{ price: "price_TESTONLY1234", quantity: 1 }] });
});
