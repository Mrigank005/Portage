// Shared basics for Standin: ids, errors, the in-memory state and its optional file persistence.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type Obj = Record<string, any>;

/** Stripe API version Standin mirrors. Matches info.version of the OpenAPI spec we check against. */
export const API_VERSION = "2026-10-28.endive";

const ALPHA = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Stripe-looking ids: a prefix and random base62 characters. */
export function newId(prefix: string, length = 24): string {
  const bytes = randomBytes(length);
  let out = "";
  for (const b of bytes) out += ALPHA[b % 62];
  return `${prefix}${out}`;
}

export const ids = {
  product: () => newId("prod_", 14),
  price: () => newId("price_", 24),
  session: () => newId("cs_test_", 58),
  paymentIntent: () => newId("pi_3", 20),
  charge: () => newId("ch_3", 20),
  refund: () => newId("re_3", 20),
  event: () => newId("evt_1", 22),
  lineItem: () => newId("li_1", 22),
  paymentMethod: () => newId("pm_1", 22),
  webhookEndpoint: () => newId("we_1", 22),
  balanceTransaction: () => newId("txn_3", 20),
  request: () => newId("req_", 14),
};

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

// --- Errors, in Stripe's error format ---------------------------------------------------

export interface ErrorBody {
  type: "invalid_request_error" | "authentication_error" | "idempotency_error" | "card_error" | "api_error";
  message: string;
  code?: string;
  param?: string;
}

export class StripeError extends Error {
  constructor(public status: number, public body: ErrorBody) {
    super(body.message);
  }
}

export const missingParam = (name: string) =>
  new StripeError(400, { type: "invalid_request_error", message: `Missing required param: ${name}.`, param: name });

export const noSuch = (what: string, id: string, param?: string) =>
  new StripeError(404, {
    type: "invalid_request_error",
    code: "resource_missing",
    message: `No such ${what}: '${id}'`,
    ...(param ? { param } : {}),
  });

export const badParam = (message: string, param?: string, code?: string) =>
  new StripeError(400, { type: "invalid_request_error", message, ...(param ? { param } : {}), ...(code ? { code } : {}) });

// --- State ---------------------------------------------------------------------------------

export interface Account {
  products: Obj[];
  prices: Obj[];
  sessions: Obj[];
  /** Line items per checkout session id (stored with a price id; expanded on output). */
  lineItems: Record<string, Obj[]>;
  paymentIntents: Obj[];
  charges: Obj[];
  refunds: Obj[];
  events: Obj[];
  webhookEndpoints: Obj[];
  idempotency: Record<string, { fingerprint: string; status: number; body: Obj }>;
}

export interface State {
  accounts: Record<string, Account>;
}

export const emptyAccount = (): Account => ({
  products: [],
  prices: [],
  sessions: [],
  lineItems: {},
  paymentIntents: [],
  charges: [],
  refunds: [],
  events: [],
  webhookEndpoints: [],
  idempotency: {},
});

export class Store {
  state: State = { accounts: {} };

  constructor(private filePath: string | null) {
    if (filePath && fs.existsSync(filePath)) {
      try {
        this.state = JSON.parse(fs.readFileSync(filePath, "utf8"));
      } catch {
        // A corrupt state file just means starting fresh.
      }
    }
  }

  account(key: string): Account {
    return (this.state.accounts[key] ??= emptyAccount());
  }

  /** Find a checkout session by id across accounts (the hosted pay page has no API key). */
  findSession(id: string): { key: string; acct: Account; session: Obj } | null {
    for (const [key, acct] of Object.entries(this.state.accounts)) {
      const session = acct.sessions.find((s) => s.id === id);
      if (session) return { key, acct, session };
    }
    return null;
  }

  save(): void {
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.state));
  }
}

/** Drops internal fields (those starting with an underscore) from an object before it leaves the server. */
export function clean<T extends Obj>(o: T): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(o)) if (!k.startsWith("_")) out[k] = v;
  return out;
}

export const toInt = (v: unknown, fallback?: number): number => {
  if (v === undefined || v === null || v === "") {
    if (fallback !== undefined) return fallback;
    throw badParam("Invalid integer");
  }
  const n = Number(v);
  if (!Number.isInteger(n)) throw badParam(`Invalid integer: ${String(v)}`);
  return n;
};

export const toArray = (v: unknown): any[] => {
  if (v === undefined || v === null || v === "") return [];
  if (Array.isArray(v)) return v;
  if (typeof v === "object") return Object.keys(v as Obj).sort((a, b) => Number(a) - Number(b)).map((k) => (v as Obj)[k]);
  return [v];
};

/** Metadata params: keys set to an empty string are removed (Stripe's rule on update). */
export function mergeMetadata(existing: Obj, incoming: unknown): Obj {
  const next = { ...existing };
  if (incoming && typeof incoming === "object") {
    for (const [k, v] of Object.entries(incoming as Obj)) {
      if (v === "" || v === null) delete next[k];
      else next[k] = String(v);
    }
  }
  return next;
}
