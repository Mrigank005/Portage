"""Ledgerline: a small Flask invoicing app that takes card payments with Stripe Checkout.

This is a Portage test app with a purpose: it is written in Python, which Portage does not support yet.
Portage must stop and say so instead of attempting a partial change.
"""
import os

import stripe
from flask import Flask, abort, jsonify, redirect, request

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WEBHOOK_SECRET = os.environ["STRIPE_WEBHOOK_SECRET"]
BASE_URL = os.environ.get("APP_URL", "http://localhost:4302")

app = Flask(__name__)
INVOICES = {}  # invoice id -> {"amount": cents, "status": "unpaid" | "paid" | "refunded"}


@app.post("/invoices/<invoice_id>/pay")
def pay_invoice(invoice_id):
    invoice = INVOICES.get(invoice_id)
    if invoice is None:
        abort(404)
    session = stripe.checkout.Session.create(
        mode="payment",
        client_reference_id=invoice_id,
        line_items=[
            {
                "price_data": {
                    "currency": "usd",
                    "unit_amount": invoice["amount"],
                    "product_data": {"name": f"Invoice {invoice_id}"},
                },
                "quantity": 1,
            }
        ],
        success_url=f"{BASE_URL}/invoices/{invoice_id}?paid=1",
        cancel_url=f"{BASE_URL}/invoices/{invoice_id}",
    )
    return redirect(session.url, code=303)


@app.post("/webhooks/stripe")
def stripe_webhook():
    try:
        event = stripe.Webhook.construct_event(
            request.get_data(), request.headers.get("Stripe-Signature", ""), WEBHOOK_SECRET
        )
    except (ValueError, stripe.SignatureVerificationError):
        abort(400)

    if event.type == "checkout.session.completed":
        # stripe-python returns Stripe objects, not dicts: use attribute access.
        session = event.data.object
        invoice = INVOICES.get(getattr(session, "client_reference_id", None))
        if invoice is not None and getattr(session, "payment_status", None) == "paid":
            invoice["status"] = "paid"
            invoice["payment_intent"] = getattr(session, "payment_intent", None)
    return jsonify(received=True)


@app.post("/invoices/<invoice_id>/refund")
def refund_invoice(invoice_id):
    invoice = INVOICES.get(invoice_id)
    if invoice is None or "payment_intent" not in invoice:
        abort(404)
    stripe.Refund.create(payment_intent=invoice["payment_intent"])
    invoice["status"] = "refunded"
    return jsonify(invoice)
