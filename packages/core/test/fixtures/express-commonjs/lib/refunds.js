// The Stripe client arrives as a parameter, so only its name says it is Stripe.
module.exports = async function refund(stripe, paymentIntentId) {
  return stripe.refunds.create({ payment_intent: paymentIntentId });
};
