import { notFound } from "next/navigation";
import { getOrder } from "@/lib/orders";
import { formatMoney } from "@/lib/money";
import PendingRefresh from "./PendingRefresh";

export const dynamic = "force-dynamic";

const HEADINGS: Record<string, string> = {
  pending: "Confirming your payment…",
  paid: "Payment received",
  partially_refunded: "Payment received",
  refunded: "Order refunded",
  failed: "Checkout could not start",
};

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const order = getOrder(id);
  if (!order) notFound();

  return (
    <>
      <h1>{HEADINGS[order.status]}</h1>
      <p className="lede">
        Order {order.id} <span className={`badge ${order.status}`}>{order.status.replace("_", " ")}</span>
      </p>
      {order.status === "pending" && <PendingRefresh />}
      <table>
        <thead>
          <tr>
            <th>Item</th>
            <th className="num">Qty</th>
            <th className="num">Price</th>
          </tr>
        </thead>
        <tbody>
          {order.items.map((item) => (
            <tr key={item.priceId}>
              <td>{item.name}</td>
              <td className="num">{item.quantity}</td>
              <td className="num">{formatMoney(item.unitAmount * item.quantity, order.currency)}</td>
            </tr>
          ))}
          <tr>
            <td colSpan={2}>
              <strong>Total</strong>
            </td>
            <td className="num">
              <strong>{formatMoney(order.total, order.currency)}</strong>
            </td>
          </tr>
        </tbody>
      </table>
      {order.email && <p className="note">A receipt was sent to {order.email}.</p>}
    </>
  );
}
