import { listOrders } from "@/lib/orders";
import { formatMoney } from "@/lib/money";

export const dynamic = "force-dynamic";

export default function AdminOrders() {
  const orders = listOrders();
  return (
    <>
      <h1>Orders</h1>
      <p className="lede">Demo admin page. There is no sign-in here; a real shop would add one.</p>
      {orders.length === 0 ? (
        <p>No orders yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Order</th>
              <th>Items</th>
              <th>Status</th>
              <th>Email</th>
              <th className="num">Total</th>
              <th className="num">Refunded</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id}>
                <td>{o.id}</td>
                <td>{o.items.map((i) => `${i.name} × ${i.quantity}`).join(", ")}</td>
                <td>
                  <span className={`badge ${o.status}`}>{o.status.replace("_", " ")}</span>
                </td>
                <td>{o.email ?? "—"}</td>
                <td className="num">{formatMoney(o.total, o.currency)}</td>
                <td className="num">{o.refundedAmount ? formatMoney(o.refundedAmount, o.currency) : "—"}</td>
                <td>
                  {(o.status === "paid" || o.status === "partially_refunded") && (
                    <form action="/api/admin/refund" method="post">
                      <input type="hidden" name="orderId" value={o.id} />
                      <button type="submit">Refund</button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
