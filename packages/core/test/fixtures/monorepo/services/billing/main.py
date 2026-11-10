import stripe

stripe.api_key = "sk_test_fixture"


def refund(payment_intent):
    return stripe.Refund.create(payment_intent=payment_intent)
