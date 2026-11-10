// Money conversion between Stripe and PayPal. Code decides this, never the model.
//
// Stripe: integer amounts in the currency's minor unit, as Stripe defines it (2400 = 24.00 USD, 2400 = 2400 JPY).
// PayPal: decimal strings with PayPal's number of decimals ("24.00", "2400").
// The two disagree for HUF and TWD: Stripe takes two decimals, PayPal takes none, so 1045 HUF-fillér (10.45 HUF)
// has no exact PayPal amount. We refuse instead of rounding someone's money.
import { loadMap } from "./map.ts";

export type MoneyErrorCode = "INVALID_AMOUNT" | "INVALID_CURRENCY" | "PAYPAL_CURRENCY_UNSUPPORTED" | "PRECISION_LOSS" | "INVALID_PAYPAL_VALUE";

export class MoneyError extends Error {
  constructor(
    readonly code: MoneyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MoneyError";
  }
}

export interface PayPalMoney {
  currencyCode: string;
  value: string;
}

const norm = (currency: string): string => {
  if (typeof currency !== "string" || !/^[A-Za-z]{3}$/.test(currency)) {
    throw new MoneyError("INVALID_CURRENCY", `"${currency}" is not a three-letter ISO 4217 currency code`);
  }
  return currency.toUpperCase();
};

/** Decimal places in Stripe's minor unit for a currency (Stripe docs, "Supported currencies"). */
export function stripeExponent(currency: string): number {
  const c = norm(currency);
  const { currencies } = loadMap();
  if (currencies.stripeTwoDecimalWholeOnly.includes(c)) return 2; // Stripe's special cases (ISK, UGX) take precedence
  if (currencies.stripeZeroDecimal.includes(c)) return 0;
  if (currencies.stripeThreeDecimal.includes(c)) return 3;
  return 2;
}

/** Decimal places PayPal accepts, or null when PayPal doesn't support the currency at all. */
export function paypalExponent(currency: string): number | null {
  const c = norm(currency);
  const decimals = loadMap().currencies.paypal[c];
  return decimals === undefined ? null : decimals;
}

export function paypalSupports(currency: string): boolean {
  return paypalExponent(currency) !== null;
}

/** Currencies PayPal only accepts for in-country accounts (BRL, CNY, MYR). */
export function paypalInCountryOnly(currency: string): boolean {
  return loadMap().currencies.paypalInCountryOnly.includes(norm(currency));
}

/** Converts a Stripe amount (integer minor units) to PayPal Money. Throws MoneyError instead of rounding. */
export function toPayPalMoney(minor: number, currency: string): PayPalMoney {
  if (typeof minor !== "number" || !Number.isSafeInteger(minor) || minor < 0) {
    throw new MoneyError("INVALID_AMOUNT", `Amount must be a non-negative whole number of minor units, got ${String(minor)}`);
  }
  const code = norm(currency);
  const pe = paypalExponent(code);
  if (pe === null) {
    throw new MoneyError("PAYPAL_CURRENCY_UNSUPPORTED", `PayPal does not accept payments in ${code}`);
  }
  const se = stripeExponent(code);
  let units = BigInt(minor);
  let places = se;
  if (se > pe) {
    const factor = 10n ** BigInt(se - pe);
    if (units % factor !== 0n) {
      throw new MoneyError(
        "PRECISION_LOSS",
        `${minor} in Stripe's ${code} minor units is ${formatScaled(units, se)} ${code}, but PayPal takes ${pe} decimal places for ${code}`,
      );
    }
    units /= factor;
    places = pe;
  } else if (se < pe) {
    units *= 10n ** BigInt(pe - se);
    places = pe;
  }
  return { currencyCode: code, value: formatScaled(units, places) };
}

/** Converts PayPal Money back to a Stripe-style integer amount in minor units. */
export function fromPayPalMoney(money: PayPalMoney): number {
  const code = norm(money?.currencyCode);
  const pe = paypalExponent(code);
  if (pe === null) throw new MoneyError("PAYPAL_CURRENCY_UNSUPPORTED", `PayPal does not accept payments in ${code}`);
  const value = money.value;
  const m = typeof value === "string" ? /^(\d+)(?:\.(\d+))?$/.exec(value) : null;
  if (!m) throw new MoneyError("INVALID_PAYPAL_VALUE", `"${String(value)}" is not a PayPal decimal amount`);
  const frac = m[2] ?? "";
  if (frac.length > pe) {
    throw new MoneyError("INVALID_PAYPAL_VALUE", `"${value}" has more than ${pe} decimal places for ${code}`);
  }
  const se = stripeExponent(code);
  const scaled = BigInt(m[1] + frac.padEnd(pe, "0")) * 10n ** BigInt(Math.max(se - pe, 0));
  const minor = se < pe ? scaled / 10n ** BigInt(pe - se) : scaled;
  if (se < pe && scaled % 10n ** BigInt(pe - se) !== 0n) {
    throw new MoneyError("PRECISION_LOSS", `"${value}" ${code} can't be expressed in Stripe's minor units`);
  }
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new MoneyError("INVALID_PAYPAL_VALUE", `"${value}" is too large`);
  return Number(minor);
}

function formatScaled(units: bigint, places: number): string {
  if (places === 0) return units.toString();
  const s = units.toString().padStart(places + 1, "0");
  return `${s.slice(0, -places)}.${s.slice(-places)}`;
}
