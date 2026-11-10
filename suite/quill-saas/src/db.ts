// A tiny file-backed store for users' credit balances and purchases.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export interface Purchase {
  id: string;
  email: string;
  pack: string;
  credits: number;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "partially_refunded" | "refunded" | "failed";
  sessionId: string | null;
  paymentIntentId: string | null;
  refundedAmount: number;
  creditsClawedBack: number;
  createdAt: string;
}

interface Data {
  credits: Record<string, number>;
  purchases: Purchase[];
}

const dir = () => process.env.QUILL_DATA_DIR ?? path.join(process.cwd(), "data");
const file = () => path.join(dir(), "db.json");

function load(): Data {
  try {
    return JSON.parse(fs.readFileSync(file(), "utf8")) as Data;
  } catch {
    return { credits: {}, purchases: [] };
  }
}

function save(data: Data): void {
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(data, null, 2));
}

export function createPurchase(p: Pick<Purchase, "email" | "pack" | "credits" | "amount" | "currency">): Purchase {
  const data = load();
  const purchase: Purchase = {
    id: `pur_${randomBytes(5).toString("hex")}`,
    ...p,
    status: "pending",
    sessionId: null,
    paymentIntentId: null,
    refundedAmount: 0,
    creditsClawedBack: 0,
    createdAt: new Date().toISOString(),
  };
  data.purchases.push(purchase);
  save(data);
  return purchase;
}

export const getPurchase = (id: string): Purchase | undefined => load().purchases.find((p) => p.id === id);
export const findByPaymentIntent = (pi: string): Purchase | undefined => load().purchases.find((p) => p.paymentIntentId === pi);

export function updatePurchase(id: string, patch: Partial<Purchase>): Purchase | undefined {
  const data = load();
  const p = data.purchases.find((x) => x.id === id);
  if (!p) return undefined;
  Object.assign(p, patch);
  save(data);
  return p;
}

export function addCredits(email: string, delta: number): number {
  const data = load();
  data.credits[email] = Math.max(0, (data.credits[email] ?? 0) + delta);
  save(data);
  return data.credits[email];
}

export function accountFor(email: string): { email: string; credits: number; purchases: Purchase[] } {
  const data = load();
  return { email, credits: data.credits[email] ?? 0, purchases: data.purchases.filter((p) => p.email === email).reverse() };
}
