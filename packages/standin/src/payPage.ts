// Standin's hosted test checkout page: the stand-in for checkout.stripe.com.
import type { Obj } from "./core.ts";

export interface TestCard {
  brand: string;
  funding: "credit" | "debit";
  /** Set when the card should be declined. */
  decline?: string;
}

/** Stripe's public test card numbers that Standin understands. */
export const TEST_CARDS: Record<string, TestCard> = {
  "4242424242424242": { brand: "visa", funding: "credit" },
  "5555555555554444": { brand: "mastercard", funding: "credit" },
  "4000056655665556": { brand: "visa", funding: "debit" },
  "4000000000000002": { brand: "visa", funding: "credit", decline: "Your card was declined." },
  "4000000000009995": { brand: "visa", funding: "credit", decline: "Your card has insufficient funds." },
  "4000000000000069": { brand: "visa", funding: "credit", decline: "Your card has expired." },
};

const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Formats an amount in the currency's smallest unit, so zero-decimal currencies such as JPY show correctly. */
export function money(minor: number, currency: string): string {
  const format = new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() });
  const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
  return format.format(minor / 10 ** digits);
}

export function renderPayPage(p: {
  session: Obj;
  items: { description: string; quantity: number; unitAmount: number; total: number }[];
  error?: string;
  prefill?: { email?: string; name?: string };
}): string {
  const s = p.session;
  const rows = p.items
    .map(
      (i) => `<tr><td>${esc(i.description)}<span class="qty"> × ${i.quantity}</span></td><td class="num">${money(i.total, s.currency)}</td></tr>`,
    )
    .join("");
  const cancel = s.cancel_url
    ? `<a class="cancel" href="${esc(s.cancel_url)}">Cancel and go back</a>`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Standin test checkout</title>
<style>
  :root{color-scheme:light dark;--bg:#f4f6f9;--card:#fff;--ink:#131a25;--muted:#586273;--line:#dbe0e8;--accent:#1d4ed0;--bad:#b3261e;--warn:#fbf0df;--warnink:#7a4a00}
  @media (prefers-color-scheme:dark){:root{--bg:#0e131d;--card:#161c29;--ink:#e5e9f1;--muted:#9aa3b4;--line:#283043;--accent:#86a6ff;--bad:#f27b70;--warn:#2e2416;--warnink:#f0a947}}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
  .banner{background:var(--warn);color:var(--warnink);padding:10px 16px;text-align:center;font-size:.9rem}
  main{max-width:460px;margin:32px auto;padding:0 16px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:22px}
  h1{font-size:1.25rem;margin:0 0 4px}.sub{color:var(--muted);margin:0 0 16px;font-size:.9rem}
  table{width:100%;border-collapse:collapse;margin-bottom:8px}td{padding:8px 0;border-bottom:1px solid var(--line)}.num{text-align:right;font-variant-numeric:tabular-nums}.qty{color:var(--muted)}
  .total{display:flex;justify-content:space-between;font-weight:600;padding:10px 0 16px}
  label{display:block;font-size:.85rem;color:var(--muted);margin:12px 0 4px}
  input{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit;font:inherit}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  button{width:100%;margin-top:18px;padding:12px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer}
  button:focus-visible,input:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  .err{color:var(--bad);margin:12px 0 0}.cancel{display:block;text-align:center;margin-top:14px;color:var(--muted);font-size:.9rem}
  .hint{color:var(--muted);font-size:.8rem;margin-top:14px}
</style></head><body>
<div class="banner">Standin test checkout. No real payment is made. Use test card 4242 4242 4242 4242.</div>
<main><div class="card">
  <h1>Pay ${money(s.amount_total, s.currency)}</h1>
  <p class="sub">Session ${esc(s.id.slice(0, 24))}…</p>
  <table>${rows}</table>
  <div class="total"><span>Total</span><span class="num">${money(s.amount_total, s.currency)}</span></div>
  <form method="post" action="/pay/${esc(s.id)}">
    <label for="email">Email</label><input id="email" name="email" type="email" required value="${esc(p.prefill?.email ?? s.customer_email ?? "")}" autocomplete="email">
    <label for="name">Name on card</label><input id="name" name="name" required value="${esc(p.prefill?.name ?? "Test Buyer")}" autocomplete="cc-name">
    <label for="cardNumber">Card number</label><input id="cardNumber" name="cardNumber" required value="4242 4242 4242 4242" inputmode="numeric" autocomplete="cc-number">
    <div class="row"><div><label for="exp">Expiry</label><input id="exp" name="exp" required value="12 / 34" autocomplete="cc-exp"></div>
    <div><label for="cvc">CVC</label><input id="cvc" name="cvc" required value="123" inputmode="numeric" autocomplete="cc-csc"></div></div>
    ${p.error ? `<p class="err" role="alert">${esc(p.error)}</p>` : ""}
    <button type="submit">Pay ${money(s.amount_total, s.currency)}</button>
  </form>
  ${cancel}
  <p class="hint">Other test cards: 4000 0000 0000 0002 (declined), 4000 0000 0000 9995 (insufficient funds).</p>
</div></main></body></html>`;
}

export function renderMessage(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:460px;margin:64px auto;padding:0 16px}</style></head><body><h1>${esc(title)}</h1><p>${esc(body)}</p></body></html>`;
}
