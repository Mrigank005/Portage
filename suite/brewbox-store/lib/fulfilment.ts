import { findOrderByPaymentIntent, getOrder, sendReceipt, updateOrder } from "./orders";

/** Marks an order paid and sends the receipt. Safe to call twice, because webhooks can be delivered more than once. */
export function fulfillOrder(orderId: string, payment: { sessionId: string; paymentIntentId: string | null; email: string | null }) {
  const order = getOrder(orderId);
  if (!order) return { ok: false as const, reason: "unknown order" };
  if (order.status !== "pending") return { ok: true as const, alreadyFulfilled: true };
  const updated = updateOrder(orderId, {
    status: "paid",
    paidAt: new Date().toISOString(),
    stripeSessionId: payment.sessionId,
    paymentIntentId: payment.paymentIntentId,
    email: payment.email,
  })!;
  sendReceipt(updated);
  return { ok: true as const, alreadyFulfilled: false };
}

/** Records a refund reported by the payment provider. */
export function recordRefund(paymentIntentId: string, amountRefunded: number, fullyRefunded: boolean) {
  const order = findOrderByPaymentIntent(paymentIntentId);
  if (!order) return { ok: false as const, reason: "unknown payment" };
  updateOrder(order.id, {
    refundedAmount: amountRefunded,
    status: fullyRefunded ? "refunded" : "partially_refunded",
  });
  return { ok: true as const };
}
