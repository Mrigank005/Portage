// A tiny file-backed order store. A real shop would use a database; the payment code around it is what matters here.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export type OrderStatus = "pending" | "paid" | "partially_refunded" | "refunded" | "failed";

export interface OrderItem {
  priceId: string;
  name: string;
  quantity: number;
  unitAmount: number;
}

export interface Order {
  id: string;
  status: OrderStatus;
  items: OrderItem[];
  total: number;
  currency: string;
  email: string | null;
  stripeSessionId: string | null;
  paymentIntentId: string | null;
  refundedAmount: number;
  createdAt: string;
  paidAt: string | null;
}

const dataDir = () => process.env.BREWBOX_DATA_DIR ?? path.join(process.cwd(), "data");
const ordersFile = () => path.join(dataDir(), "orders.json");

function readAll(): Order[] {
  try {
    return JSON.parse(fs.readFileSync(ordersFile(), "utf8")) as Order[];
  } catch {
    return [];
  }
}

function writeAll(orders: Order[]): void {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(ordersFile(), JSON.stringify(orders, null, 2));
}

export function createOrder(input: { items: OrderItem[]; currency: string }): Order {
  const order: Order = {
    id: `ord_${randomBytes(5).toString("hex")}`,
    status: "pending",
    items: input.items,
    total: input.items.reduce((sum, i) => sum + i.unitAmount * i.quantity, 0),
    currency: input.currency,
    email: null,
    stripeSessionId: null,
    paymentIntentId: null,
    refundedAmount: 0,
    createdAt: new Date().toISOString(),
    paidAt: null,
  };
  writeAll([...readAll(), order]);
  return order;
}

export const getOrder = (id: string): Order | undefined => readAll().find((o) => o.id === id);
export const listOrders = (): Order[] => readAll().reverse();
export const findOrderByPaymentIntent = (paymentIntentId: string): Order | undefined =>
  readAll().find((o) => o.paymentIntentId === paymentIntentId);

export function updateOrder(id: string, patch: Partial<Order>): Order | undefined {
  const orders = readAll();
  const i = orders.findIndex((o) => o.id === id);
  if (i < 0) return undefined;
  orders[i] = { ...orders[i], ...patch };
  writeAll(orders);
  return orders[i];
}

/** Receipts go to a log file here; a real shop would call its email provider. */
export function sendReceipt(order: Order): void {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.appendFileSync(path.join(dataDir(), "outbox.log"), `${new Date().toISOString()} receipt to ${order.email} for ${order.id}\n`);
}
