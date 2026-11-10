// Portage reference: money conversion between the app's Stripe-style amounts and PayPal amounts.
//
// Stripe amounts are integers in the currency's minor unit ("2400" = 24.00 USD; "2400" = 2400 JPY).
// PayPal amounts are decimal strings with PayPal's own number of decimals ("24.00", "2400").
// They disagree for HUF and TWD (two decimals on Stripe, none on PayPal), so this refuses instead of rounding.
// Self-contained on purpose: copy it into the app as it is. Portage's tests check it against Portage's own helper.

export interface PayPalMoney {
  currencyCode: string;
  value: string;
}

/** Decimal places PayPal accepts, per currency it supports (developer.paypal.com/api/rest/reference/currency-codes). */
const PAYPAL_DECIMALS: Record<string, number> = {
  AUD: 2, BRL: 2, CAD: 2, CNY: 2, CZK: 2, DKK: 2, EUR: 2, HKD: 2, HUF: 0, ILS: 2, JPY: 0, MYR: 2, MXN: 2,
  TWD: 0, NZD: 2, NOK: 2, PHP: 2, PLN: 2, GBP: 2, RUB: 2, SGD: 2, SEK: 2, CHF: 2, THB: 2, USD: 2,
};
/** Stripe's zero- and three-decimal currencies (docs.stripe.com/currencies); everything else is two. */
const STRIPE_ZERO = new Set(["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "VND", "VUV", "XAF", "XOF", "XPF"]);
const STRIPE_THREE = new Set(["BHD", "JOD", "KWD", "OMR", "TND"]);

const code = (currency: string): string => {
  if (!/^[A-Za-z]{3}$/.test(currency)) throw new Error(`"${currency}" is not a currency code`);
  return currency.toUpperCase();
};
const stripeDecimals = (c: string) => (STRIPE_ZERO.has(c) ? 0 : STRIPE_THREE.has(c) ? 3 : 2);

export function paypalSupportsCurrency(currency: string): boolean {
  return code(currency) in PAYPAL_DECIMALS;
}

/** 2400, "usd" → { currencyCode: "USD", value: "24.00" }. Throws for amounts PayPal can't represent exactly. */
export function toPayPalMoney(minorUnits: number, currency: string): PayPalMoney {
  if (!Number.isSafeInteger(minorUnits) || minorUnits < 0) throw new Error(`Amount must be a whole number of minor units, got ${minorUnits}`);
  const c = code(currency);
  const pp = PAYPAL_DECIMALS[c];
  if (pp === undefined) throw new Error(`PayPal does not accept payments in ${c}`);
  const st = stripeDecimals(c);
  let units = BigInt(minorUnits);
  if (st > pp) {
    const factor = 10n ** BigInt(st - pp);
    if (units % factor !== 0n) throw new Error(`${minorUnits} (${c} minor units) has no exact PayPal amount: PayPal takes ${pp} decimals for ${c}`);
    units /= factor;
  } else if (st < pp) {
    units *= 10n ** BigInt(pp - st);
  }
  return { currencyCode: c, value: format(units, pp) };
}

/**
 * { currencyCode: "USD", value: "24.00" } → 2400. Also accepts the snake_case shape PayPal's webhooks and REST
 * responses use ({ currency_code, value }), so SDK results and webhook payloads go through the same helper.
 */
export function fromPayPalMoney(money: { currencyCode?: string; currency_code?: string; value?: string }): number {
  const c = code(money.currencyCode ?? money.currency_code ?? "");
  const pp = PAYPAL_DECIMALS[c];
  if (pp === undefined) throw new Error(`PayPal does not accept payments in ${c}`);
  const m = /^(\d+)(?:\.(\d+))?$/.exec(money.value ?? "");
  if (!m || (m[2] ?? "").length > pp) throw new Error(`"${money.value}" is not a valid ${c} amount`);
  const st = stripeDecimals(c);
  const units = BigInt(m[1] + (m[2] ?? "").padEnd(pp, "0"));
  const minor = st >= pp ? units * 10n ** BigInt(st - pp) : units / 10n ** BigInt(pp - st);
  if (st < pp && units % 10n ** BigInt(pp - st) !== 0n) throw new Error(`"${money.value}" ${c} has no exact amount in minor units`);
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`"${money.value}" is too large`);
  return Number(minor);
}

function format(units: bigint, decimals: number): string {
  if (decimals === 0) return units.toString();
  const s = units.toString().padStart(decimals + 1, "0");
  return `${s.slice(0, -decimals)}.${s.slice(-decimals)}`;
}
