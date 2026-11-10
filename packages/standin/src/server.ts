// Standin: a local Stripe-compatible test server. It implements the part of the Stripe API that
// Portage's test apps use, closely enough that the official `stripe` SDK works against it unchanged.
import http from "node:http";
import qs from "qs";
import {
  API_VERSION,
  Store,
  StripeError,
  badParam,
  clean,
  ids,
  mergeMetadata,
  missingParam,
  noSuch,
  nowSeconds,
  toArray,
  toInt,
  type Account,
  type Obj,
} from "./core.ts";
import {
  buildCharge,
  buildEvent,
  buildLineItem,
  buildPaymentIntent,
  buildPrice,
  buildProduct,
  buildRefund,
  buildSession,
  buildWebhookEndpoint,
} from "./objects.ts";
import { TEST_CARDS, money, renderMessage, renderPayPage } from "./payPage.ts";
import { deliverEvent, type Delivery } from "./webhooks.ts";
import { seedAccount, type StandinConfig } from "./config.ts";

export interface StandinOptions {
  port?: number;
  /** Address to listen on. By default Standin listens on localhost only (127.0.0.1 and, when available, ::1). */
  host?: string;
  /** Secret that signs webhooks. Default whsec_standin. */
  webhookSecret?: string;
  /** Where to persist state between restarts. null keeps everything in memory. */
  statePath?: string | null;
  config?: StandinConfig;
  log?: (line: string) => void;
}

export interface RunningStandin {
  server: http.Server;
  port: number;
  store: Store;
  deliveries: Delivery[];
  /** Resolves once every webhook delivery that has started has finished (accepted or given up). */
  idle: () => Promise<void>;
  close: () => Promise<void>;
}

interface Ctx {
  key: string;
  acct: Account;
  params: string[];
  query: Obj;
  body: Obj;
  host: string;
}
interface Result {
  status?: number;
  body: Obj;
}
type Handler = (c: Ctx) => Result;

/** The URL fragments each object type may be expanded on, per Stripe's `expand` parameter. */
function expandList(c: Ctx, allowed: string[], listEndpoint = false): string[] {
  const raw = toArray(c.query.expand ?? c.body.expand).map(String);
  const expand = raw.map((e) => (listEndpoint && e.startsWith("data.") ? e.slice(5) : e));
  for (const e of expand) {
    if (!allowed.includes(e)) throw badParam(`This property cannot be expanded (${e}).`, "expand");
  }
  return expand;
}

export async function startStandin(opts: StandinOptions = {}): Promise<RunningStandin> {
  const webhookSecret = opts.webhookSecret ?? opts.config?.webhookSecret ?? "whsec_standin";
  const log = opts.log ?? (() => {});
  const store = new Store(opts.statePath ?? null);
  const deliveries: Delivery[] = [];
  const pending = new Set<Promise<void>>();

  for (const [key, block] of Object.entries(opts.config?.accounts ?? {})) seedAccount(store.account(key), block, webhookSecret);
  store.save();

  // --- Output helpers (with expansion) ---------------------------------------------------

  const findPrice = (acct: Account, id: string) => acct.prices.find((p) => p.id === id);
  const findProduct = (acct: Account, id: string) => acct.products.find((p) => p.id === id);

  const outPrice = (acct: Account, price: Obj, expand: string[] = []): Obj => {
    const o = clean(price);
    if (expand.includes("product")) o.product = clean(findProduct(acct, price.product)!);
    return o;
  };
  const outProduct = (acct: Account, product: Obj, expand: string[] = []): Obj => {
    const o = clean(product);
    if (expand.includes("default_price") && product.default_price) {
      o.default_price = outPrice(acct, findPrice(acct, product.default_price)!);
    }
    return o;
  };
  const outLineItem = (acct: Account, li: Obj): Obj => {
    const o = clean(li);
    o.price = outPrice(acct, findPrice(acct, li._priceId)!);
    return o;
  };
  const outPaymentIntent = (acct: Account, pi: Obj, expand: string[] = []): Obj => {
    const o = clean(pi);
    if (expand.includes("latest_charge")) o.latest_charge = clean(acct.charges.find((c) => c.id === pi.latest_charge)!);
    return o;
  };
  const outSession = (acct: Account, s: Obj, expand: string[] = []): Obj => {
    const o = clean(s);
    if (expand.includes("line_items")) {
      o.line_items = {
        object: "list",
        data: (acct.lineItems[s.id] ?? []).map((li) => outLineItem(acct, li)),
        has_more: false,
        url: `/v1/checkout/sessions/${s.id}/line_items`,
      };
    }
    if (expand.includes("payment_intent") && s.payment_intent) {
      o.payment_intent = outPaymentIntent(acct, acct.paymentIntents.find((p) => p.id === s.payment_intent)!);
    }
    return o;
  };

  function list(items: Obj[], query: Obj, url: string, map: (o: Obj) => Obj, filter?: (o: Obj) => boolean): Obj {
    // Newest first, like Stripe.
    const arr = items.filter((i) => !i._hidden && (!filter || filter(i))).reverse();
    const limit = Math.min(Math.max(parseInt(String(query.limit ?? "10"), 10) || 10, 1), 100);
    if (query.starting_after && query.ending_before) throw badParam("You may only specify one of these parameters: ending_before, starting_after.");
    if (query.ending_before) {
      const idx = arr.findIndex((i) => i.id === query.ending_before);
      if (idx < 0) throw noSuch("object", String(query.ending_before), "ending_before");
      const newer = arr.slice(0, idx);
      return { object: "list", data: newer.slice(-limit).map(map), has_more: newer.length > limit, url };
    }
    let rest = arr;
    if (query.starting_after) {
      const idx = arr.findIndex((i) => i.id === query.starting_after);
      if (idx < 0) throw noSuch("object", String(query.starting_after), "starting_after");
      rest = arr.slice(idx + 1);
    }
    return { object: "list", data: rest.slice(0, limit).map(map), has_more: rest.length > limit, url };
  }

  // --- Events ---------------------------------------------------------------------------------

  function emit(key: string, acct: Account, type: string, object: Obj): void {
    const targets = acct.webhookEndpoints.filter(
      (e) => e.status === "enabled" && (e.enabled_events.includes("*") || e.enabled_events.includes(type)),
    );
    const event = buildEvent(type, object, targets.length);
    acct.events.push(event);
    // Every delivery carries the event as it was emitted; the stored copy's pending_webhooks counts down
    // as endpoints accept it, as on Stripe.
    const snapshot = structuredClone(event);
    for (const endpoint of targets) {
      const job: Promise<void> = deliverEvent({ account: key, endpoint, event: snapshot, secret: webhookSecret, deliveries, log })
        .then((ok) => {
          if (ok) {
            event.pending_webhooks = Math.max(0, event.pending_webhooks - 1);
            store.save();
          }
        })
        .finally(() => pending.delete(job));
      pending.add(job);
    }
  }

  // --- Handlers: catalog ----------------------------------------------------------------------

  const createProduct: Handler = (c) => {
    const b = c.body;
    if (!b.name) throw missingParam("name");
    if (b.shippable !== undefined && b.shippable !== "true" && b.shippable !== "false") throw badParam("shippable", "Invalid boolean");
    const product = buildProduct({
      name: String(b.name),
      description: b.description,
      metadata: mergeMetadata({}, b.metadata),
      active: b.active === undefined ? true : b.active !== "false",
      shippable: b.shippable === undefined ? null : b.shippable === "true",
      url: b.url ? String(b.url) : null,
      images: toArray(b.images).map(String),
    });
    c.acct.products.push(product);
    if (b.default_price_data) {
      const d = b.default_price_data;
      if (!d.currency) throw missingParam("default_price_data[currency]");
      const price = buildPrice({
        product: product.id,
        currency: String(d.currency).toLowerCase(),
        unitAmount: toInt(d.unit_amount),
        recurring: d.recurring ? { interval: String(d.recurring.interval), interval_count: d.recurring.interval_count ? toInt(d.recurring.interval_count) : 1 } : undefined,
      });
      c.acct.prices.push(price);
      product.default_price = price.id;
    }
    return { body: outProduct(c.acct, product, expandList(c, ["default_price"])) };
  };

  const getProduct: Handler = (c) => {
    const p = findProduct(c.acct, c.params[0]);
    if (!p) throw noSuch("product", c.params[0]);
    return { body: outProduct(c.acct, p, expandList(c, ["default_price"])) };
  };

  const updateProduct: Handler = (c) => {
    const p = findProduct(c.acct, c.params[0]);
    if (!p) throw noSuch("product", c.params[0]);
    const b = c.body;
    if (b.name !== undefined) p.name = String(b.name);
    if (b.description !== undefined) p.description = b.description === "" ? null : String(b.description);
    if (b.active !== undefined) p.active = b.active !== "false";
    if (b.metadata !== undefined) p.metadata = mergeMetadata(p.metadata, b.metadata);
    if (b.default_price !== undefined) {
      if (!findPrice(c.acct, String(b.default_price))) throw noSuch("price", String(b.default_price), "default_price");
      p.default_price = String(b.default_price);
    }
    p.updated = nowSeconds();
    return { body: outProduct(c.acct, p) };
  };

  const listProducts: Handler = (c) => {
    const expand = expandList(c, ["default_price"], true);
    const active = c.query.active === undefined ? undefined : c.query.active === "true";
    return {
      body: list(c.acct.products, c.query, "/v1/products", (p) => outProduct(c.acct, p, expand), (p) => active === undefined || p.active === active),
    };
  };

  const createPrice: Handler = (c) => {
    const b = c.body;
    if (!b.currency) throw missingParam("currency");
    let productId = b.product ? String(b.product) : "";
    if (!productId && b.product_data) {
      if (!b.product_data.name) throw missingParam("product_data[name]");
      const product = buildProduct({ name: String(b.product_data.name), metadata: mergeMetadata({}, b.product_data.metadata) });
      c.acct.products.push(product);
      productId = product.id;
    }
    if (!productId) throw missingParam("product");
    if (!findProduct(c.acct, productId)) throw noSuch("product", productId, "product");
    const price = buildPrice({
      product: productId,
      currency: String(b.currency).toLowerCase(),
      unitAmount: toInt(b.unit_amount),
      metadata: mergeMetadata({}, b.metadata),
      nickname: b.nickname,
      lookupKey: b.lookup_key,
      active: b.active === undefined ? true : b.active !== "false",
      recurring: b.recurring ? { interval: String(b.recurring.interval), interval_count: b.recurring.interval_count ? toInt(b.recurring.interval_count) : 1 } : undefined,
    });
    c.acct.prices.push(price);
    return { body: outPrice(c.acct, price, expandList(c, ["product"])) };
  };

  const getPrice: Handler = (c) => {
    const p = findPrice(c.acct, c.params[0]);
    if (!p) throw noSuch("price", c.params[0]);
    return { body: outPrice(c.acct, p, expandList(c, ["product"])) };
  };

  const listPrices: Handler = (c) => {
    const expand = expandList(c, ["product"], true);
    const active = c.query.active === undefined ? undefined : c.query.active === "true";
    return {
      body: list(
        c.acct.prices,
        c.query,
        "/v1/prices",
        (p) => outPrice(c.acct, p, expand),
        (p) => (active === undefined || p.active === active) && (!c.query.product || p.product === c.query.product),
      ),
    };
  };

  // --- Handlers: Checkout ---------------------------------------------------------------------

  const createSession: Handler = (c) => {
    const b = c.body;
    const mode = String(b.mode ?? "payment");
    if (mode !== "payment") {
      throw badParam(`Standin only implements Checkout Sessions in payment mode (got "${mode}").`, "mode");
    }
    if (!b.success_url) throw missingParam("success_url");
    const rawItems = toArray(b.line_items);
    if (rawItems.length === 0) throw missingParam("line_items");

    let currency = "";
    const items: Obj[] = rawItems.map((it, i) => {
      const quantity = toInt(it.quantity, 1);
      let price: Obj | undefined;
      if (it.price) {
        price = findPrice(c.acct, String(it.price));
        if (!price) throw noSuch("price", String(it.price), `line_items[${i}][price]`);
        if (!price.active) {
          throw badParam("The price specified is inactive. This field only accepts active prices.", `line_items[${i}][price]`);
        }
      } else if (it.price_data) {
        const d = it.price_data;
        if (!d.currency) throw missingParam(`line_items[${i}][price_data][currency]`);
        let productId = d.product ? String(d.product) : "";
        if (!productId) {
          if (!d.product_data?.name) throw missingParam(`line_items[${i}][price_data][product_data][name]`);
          const product = buildProduct({
            name: String(d.product_data.name),
            description: d.product_data.description,
            metadata: mergeMetadata({}, d.product_data.metadata),
            hidden: true,
          });
          c.acct.products.push(product);
          productId = product.id;
        } else if (!findProduct(c.acct, productId)) {
          throw noSuch("product", productId, `line_items[${i}][price_data][product]`);
        }
        price = buildPrice({
          product: productId,
          currency: String(d.currency).toLowerCase(),
          unitAmount: toInt(d.unit_amount),
          active: false,
          hidden: true,
        });
        c.acct.prices.push(price);
      } else {
        throw missingParam(`line_items[${i}][price]`);
      }
      if (price.unit_amount === null || price.unit_amount === undefined) throw badParam("Standin needs prices with a fixed unit_amount.", `line_items[${i}][price]`);
      if (currency && currency !== price.currency) {
        throw badParam("You cannot combine currencies on a single Checkout Session.", `line_items[${i}][price]`);
      }
      currency = price.currency;
      const product = findProduct(c.acct, price.product);
      return buildLineItem({
        priceId: price.id,
        description: product?.name ?? "Item",
        quantity,
        unitAmount: price.unit_amount,
        currency: price.currency,
      });
    });

    const id = ids.session();
    const session = buildSession({
      id,
      url: `http://${c.host}/pay/${id}`,
      currency,
      subtotal: items.reduce((sum, li) => sum + li.amount_total, 0),
      successUrl: String(b.success_url),
      cancelUrl: b.cancel_url ? String(b.cancel_url) : null,
      clientReferenceId: b.client_reference_id ? String(b.client_reference_id) : null,
      customerEmail: b.customer_email ? String(b.customer_email) : null,
      metadata: mergeMetadata({}, b.metadata),
    });
    session._paymentIntentData = b.payment_intent_data ?? {};
    c.acct.sessions.push(session);
    c.acct.lineItems[id] = items;
    return { body: outSession(c.acct, session, expandList(c, ["line_items", "payment_intent"])) };
  };

  const findSessionOr404 = (c: Ctx): Obj => {
    const s = c.acct.sessions.find((x) => x.id === c.params[0]);
    if (!s) throw noSuch("checkout.session", c.params[0]);
    expireIfNeeded(c.key, c.acct, s);
    return s;
  };

  const getSession: Handler = (c) => ({ body: outSession(c.acct, findSessionOr404(c), expandList(c, ["line_items", "payment_intent"])) });

  const listSessions: Handler = (c) => {
    const expand = expandList(c, ["line_items", "payment_intent"], true);
    return { body: list(c.acct.sessions, c.query, "/v1/checkout/sessions", (s) => outSession(c.acct, s, expand)) };
  };

  const listSessionLineItems: Handler = (c) => {
    const s = findSessionOr404(c);
    return { body: list(c.acct.lineItems[s.id] ?? [], c.query, `/v1/checkout/sessions/${s.id}/line_items`, (li) => outLineItem(c.acct, li)) };
  };

  const expireSession: Handler = (c) => {
    const s = findSessionOr404(c);
    if (s.status !== "open") throw badParam(`Only Checkout Sessions with a status of \`open\` can be expired. This Session has a status of \`${s.status}\`.`);
    s.status = "expired";
    emit(c.key, c.acct, "checkout.session.expired", clean(s));
    return { body: outSession(c.acct, s) };
  };

  function expireIfNeeded(key: string, acct: Account, s: Obj): void {
    if (s.status === "open" && nowSeconds() > s.expires_at) {
      s.status = "expired";
      emit(key, acct, "checkout.session.expired", clean(s));
      store.save();
    }
  }

  const successRedirect = (s: Obj): string => String(s.success_url).replaceAll("{CHECKOUT_SESSION_ID}", s.id);

  // --- Handlers: payments, refunds, webhook endpoints -----------------------------------------

  const getPaymentIntent: Handler = (c) => {
    const pi = c.acct.paymentIntents.find((p) => p.id === c.params[0]);
    if (!pi) throw noSuch("payment_intent", c.params[0]);
    return { body: outPaymentIntent(c.acct, pi, expandList(c, ["latest_charge"])) };
  };

  const getCharge: Handler = (c) => {
    const ch = c.acct.charges.find((x) => x.id === c.params[0]);
    if (!ch) throw noSuch("charge", c.params[0]);
    return { body: clean(ch) };
  };

  const createRefund: Handler = (c) => {
    const b = c.body;
    let charge: Obj | undefined;
    if (b.charge) {
      charge = c.acct.charges.find((x) => x.id === String(b.charge));
      if (!charge) throw noSuch("charge", String(b.charge), "charge");
    } else if (b.payment_intent) {
      const pi = c.acct.paymentIntents.find((p) => p.id === String(b.payment_intent));
      if (!pi) throw noSuch("payment_intent", String(b.payment_intent), "payment_intent");
      charge = c.acct.charges.find((x) => x.id === pi.latest_charge);
    } else {
      throw badParam("Must provide either the `charge` or `payment_intent` parameter.");
    }
    if (!charge) throw badParam("This PaymentIntent has no charge to refund.");
    const refundable = charge.amount_captured - charge.amount_refunded;
    if (refundable <= 0) {
      throw new StripeError(400, { type: "invalid_request_error", code: "charge_already_refunded", message: `Charge ${charge.id} has already been refunded.` });
    }
    const amount = b.amount === undefined ? refundable : toInt(b.amount);
    if (amount <= 0) throw badParam("Invalid positive integer", "amount");
    if (amount > refundable) {
      throw badParam(`Refund amount (${money(amount, charge.currency)}) is greater than unrefunded amount on charge (${money(refundable, charge.currency)}).`, "amount");
    }
    const refund = buildRefund({
      amount,
      currency: charge.currency,
      chargeId: charge.id,
      paymentIntentId: charge.payment_intent,
      reason: b.reason ? String(b.reason) : null,
      metadata: mergeMetadata({}, b.metadata),
    });
    c.acct.refunds.push(refund);
    charge.amount_refunded += amount;
    charge.refunded = charge.amount_refunded >= charge.amount_captured;
    emit(c.key, c.acct, "charge.refunded", clean(charge));
    return { body: clean(refund) };
  };

  const getRefund: Handler = (c) => {
    const r = c.acct.refunds.find((x) => x.id === c.params[0]);
    if (!r) throw noSuch("refund", c.params[0]);
    return { body: clean(r) };
  };

  const listRefunds: Handler = (c) => ({
    body: list(c.acct.refunds, c.query, "/v1/refunds", clean, (r) => (!c.query.payment_intent || r.payment_intent === c.query.payment_intent) && (!c.query.charge || r.charge === c.query.charge)),
  });

  const createWebhookEndpoint: Handler = (c) => {
    const b = c.body;
    if (!b.url) throw missingParam("url");
    const events = toArray(b.enabled_events).map(String);
    if (events.length === 0) throw missingParam("enabled_events");
    const endpoint = buildWebhookEndpoint({ url: String(b.url), enabledEvents: events, description: b.description, metadata: mergeMetadata({}, b.metadata) }, webhookSecret);
    c.acct.webhookEndpoints.push(endpoint);
    return { body: clean(endpoint) };
  };

  const getEvent: Handler = (c) => {
    const e = c.acct.events.find((x) => x.id === c.params[0]);
    if (!e) throw noSuch("event", c.params[0]);
    return { body: clean(e) };
  };

  const listEvents: Handler = (c) => {
    const types = toArray(c.query.types).map(String);
    return {
      body: list(c.acct.events, c.query, "/v1/events", clean, (e) => (!c.query.type || e.type === c.query.type) && (types.length === 0 || types.includes(e.type))),
    };
  };

  const listWebhookEndpoints: Handler = (c) => ({
    body: list(c.acct.webhookEndpoints, c.query, "/v1/webhook_endpoints", (e) => {
      const { secret: _secret, ...rest } = clean(e);
      return rest;
    }),
  });

  // --- The hosted pay page --------------------------------------------------------------------

  function payPageItems(acct: Account, session: Obj) {
    return (acct.lineItems[session.id] ?? []).map((li) => ({
      description: li.description,
      quantity: li.quantity,
      unitAmount: li.amount_subtotal / li.quantity,
      total: li.amount_total,
    }));
  }

  function completePayment(key: string, acct: Account, session: Obj, form: Obj): { redirect: string } | { error: string } {
    const digits = String(form.cardNumber ?? "").replace(/\s+/g, "");
    const card = TEST_CARDS[digits];
    if (!card) return { error: "Standin only accepts Stripe's public test cards, such as 4242 4242 4242 4242." };
    if (card.decline) return { error: card.decline };

    // Expiry as "MM / YY" or "MM / YYYY", and not in the past.
    const [mm, yy] = String(form.exp ?? "").replace(/\s+/g, "").split("/");
    const exp_month = Number(mm);
    let exp_year = Number(yy);
    if (!/^\d{1,2}$/.test(mm ?? "") || !/^(\d{2}|\d{4})$/.test(yy ?? "") || exp_month < 1 || exp_month > 12) {
      return { error: "Your card's expiration date is incomplete. Use MM / YY." };
    }
    if (exp_year < 100) exp_year += 2000;
    const today = new Date();
    if (exp_year < today.getFullYear() || (exp_year === today.getFullYear() && exp_month < today.getMonth() + 1)) {
      return { error: "Your card's expiration date is in the past." };
    }
    const email = String(form.email || session.customer_email || "") || null;
    const name = String(form.name || "") || null;
    const pmId = ids.paymentMethod();
    const chargeId = ids.charge();
    const piData = session._paymentIntentData ?? {};
    const metadata = mergeMetadata({}, piData.metadata);
    const description = piData.description ? String(piData.description) : null;

    const pi = buildPaymentIntent({ amount: session.amount_total, currency: session.currency, chargeId, paymentMethodId: pmId, metadata, description, receiptEmail: email });
    const charge = buildCharge({
      id: chargeId,
      paymentIntentId: pi.id,
      paymentMethodId: pmId,
      amount: session.amount_total,
      currency: session.currency,
      card: { brand: card.brand, funding: card.funding, last4: digits.slice(-4), exp_month, exp_year },
      email,
      name,
      metadata,
      description,
    });
    acct.paymentIntents.push(pi);
    acct.charges.push(charge);

    session.status = "complete";
    session.payment_status = "paid";
    session.payment_intent = pi.id;
    session.customer_details = {
      address: { city: null, country: null, line1: null, line2: null, postal_code: null, state: null },
      business_name: null,
      email,
      individual_name: null,
      name,
      phone: null,
      tax_exempt: "none",
      tax_ids: [],
    };

    emit(key, acct, "charge.succeeded", clean(charge));
    emit(key, acct, "payment_intent.succeeded", clean(pi));
    emit(key, acct, "checkout.session.completed", clean(session));
    return { redirect: successRedirect(session) };
  }

  // --- Routing --------------------------------------------------------------------------------

  const routes: [string, RegExp, Handler][] = [
    ["POST", /^\/v1\/products$/, createProduct],
    ["GET", /^\/v1\/products$/, listProducts],
    ["GET", /^\/v1\/products\/([^/]+)$/, getProduct],
    ["POST", /^\/v1\/products\/([^/]+)$/, updateProduct],
    ["POST", /^\/v1\/prices$/, createPrice],
    ["GET", /^\/v1\/prices$/, listPrices],
    ["GET", /^\/v1\/prices\/([^/]+)$/, getPrice],
    ["POST", /^\/v1\/checkout\/sessions$/, createSession],
    ["GET", /^\/v1\/checkout\/sessions$/, listSessions],
    ["GET", /^\/v1\/checkout\/sessions\/([^/]+)\/line_items$/, listSessionLineItems],
    ["POST", /^\/v1\/checkout\/sessions\/([^/]+)\/expire$/, expireSession],
    ["GET", /^\/v1\/checkout\/sessions\/([^/]+)$/, getSession],
    ["GET", /^\/v1\/payment_intents\/([^/]+)$/, getPaymentIntent],
    ["GET", /^\/v1\/charges\/([^/]+)$/, getCharge],
    ["POST", /^\/v1\/refunds$/, createRefund],
    ["GET", /^\/v1\/refunds$/, listRefunds],
    ["GET", /^\/v1\/refunds\/([^/]+)$/, getRefund],
    ["GET", /^\/v1\/events$/, listEvents],
    ["GET", /^\/v1\/events\/([^/]+)$/, getEvent],
    ["POST", /^\/v1\/webhook_endpoints$/, createWebhookEndpoint],
    ["GET", /^\/v1\/webhook_endpoints$/, listWebhookEndpoints],
  ];

  function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (d) => chunks.push(d));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }

  const parse = (s: string): Obj => qs.parse(s, { depth: 10, arrayLimit: 200 }) as Obj;

  function sendJson(res: http.ServerResponse, status: number, body: Obj, extra: Record<string, string> = {}): void {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Request-Id": ids.request(),
      "Stripe-Version": API_VERSION,
      "Access-Control-Allow-Origin": "*",
      ...extra,
    });
    res.end(JSON.stringify(body));
  }

  const handler: http.RequestListener = async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? "/", "http://standin.local");
    const method = req.method ?? "GET";
    const host = req.headers.host ?? "localhost:4242";
    let label = "";
    let status = 500;
    try {
      // Hosted pay page (no API key, like checkout.stripe.com)
      const pay = url.pathname.match(/^\/pay\/([^/]+)$/);
      if (pay) {
        const found = store.findSession(pay[1]);
        if (!found) {
          status = 404;
          res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
          return void res.end(renderMessage("Checkout session not found", "This test session does not exist (Standin may have been restarted without saved state)."));
        }
        const { key, acct, session } = found;
        label = key;
        expireIfNeeded(key, acct, session);
        const page = (error?: string, prefill?: Obj) =>
          renderPayPage({ session, items: payPageItems(acct, session), error, prefill });
        if (session.status === "complete") {
          status = 303;
          res.writeHead(303, { Location: successRedirect(session) });
          return void res.end();
        }
        if (session.status === "expired") {
          status = 410;
          res.writeHead(410, { "Content-Type": "text/html; charset=utf-8" });
          return void res.end(renderMessage("This checkout session has expired", "Start a new checkout from the store."));
        }
        if (method === "POST") {
          const form = parse(await readBody(req));
          const outcome = completePayment(key, acct, session, form);
          store.save();
          if ("error" in outcome) {
            status = 200;
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            return void res.end(page(outcome.error, form));
          }
          status = 303;
          res.writeHead(303, { Location: outcome.redirect });
          return void res.end();
        }
        status = 200;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return void res.end(page());
      }

      // Standin's own endpoints
      if (url.pathname === "/" || url.pathname === "/_standin/health") {
        status = 200;
        return sendJson(res, 200, { name: "standin", description: "Stripe-compatible test server", api_version: API_VERSION, accounts: Object.keys(store.state.accounts).length });
      }
      if (url.pathname === "/_standin/deliveries") {
        status = 200;
        return sendJson(res, 200, { data: deliveries });
      }

      // Stripe API
      const auth = String(req.headers.authorization ?? "");
      const key = auth.startsWith("Bearer ") ? auth.slice(7).trim() : auth.startsWith("Basic ") ? Buffer.from(auth.slice(6), "base64").toString().split(":")[0] : "";
      label = key;
      if (!key) {
        throw new StripeError(401, { type: "invalid_request_error", message: "You did not provide an API key. You need to provide your API key in the Authorization header, using Bearer auth (e.g. 'Authorization: Bearer YOUR_SECRET_KEY')." });
      }
      if (!/^(sk|rk)_test_/.test(key)) {
        throw new StripeError(401, { type: "invalid_request_error", message: "Standin only accepts test-mode API keys (sk_test_...). Live keys are never used." });
      }
      const acct = store.account(key);

      const rawBody = method === "GET" || method === "DELETE" ? "" : await readBody(req);
      const body = parse(rawBody);
      const query = parse(url.search.slice(1));

      // Idempotency (POST only)
      const idemKey = req.headers["idempotency-key"] ? String(req.headers["idempotency-key"]) : null;
      const idemSlot = idemKey ? `${method} ${url.pathname} ${idemKey}` : null;
      if (idemSlot && acct.idempotency[idemSlot]) {
        const saved = acct.idempotency[idemSlot];
        if (saved.fingerprint !== rawBody) {
          throw new StripeError(400, { type: "idempotency_error", message: `Keys for idempotent requests can only be used with the same parameters they were first used with. Try using a key other than '${idemKey}' if you meant to execute a different request.` });
        }
        status = saved.status;
        return sendJson(res, saved.status, saved.body, { "Idempotent-Replayed": "true" });
      }

      const route = routes.find(([m, re]) => m === method && re.test(url.pathname));
      if (!route) {
        throw new StripeError(404, {
          type: "invalid_request_error",
          message: `Unrecognized request URL (${method}: ${url.pathname}). Standin implements only the part of the Stripe API that Portage's test apps use; see docs/standin.md.`,
        });
      }
      const params = (url.pathname.match(route[1]) ?? []).slice(1).map(decodeURIComponent);
      const result = route[2]({ key, acct, params, query, body, host });
      status = result.status ?? 200;
      if (idemSlot) acct.idempotency[idemSlot] = { fingerprint: rawBody, status, body: result.body };
      if (method !== "GET") store.save();
      return sendJson(res, status, result.body);
    } catch (e) {
      if (e instanceof StripeError) {
        status = e.status;
        return sendJson(res, e.status, { error: e.body });
      }
      status = 500;
      log(`internal error: ${(e as Error).stack ?? e}`);
      return sendJson(res, 500, { error: { type: "api_error", message: "Standin hit an internal error. See the Standin log." } });
    } finally {
      const who = label ? ` [${label.replace(/^(sk|rk)_test_/, "")}]` : "";
      log(`${method} ${url.pathname} ${status} ${Date.now() - started}ms${who}`);
    }
  };

  const listen = (srv: http.Server, port: number, host: string) =>
    new Promise<void>((resolve, reject) => {
      srv.once("error", reject);
      srv.listen(port, host, () => {
        srv.off("error", reject);
        resolve();
      });
    });

  // Localhost only by default: Standin is a test server and should not be reachable from the network.
  const server = http.createServer(handler);
  const servers = [server];
  await listen(server, opts.port ?? 4242, opts.host ?? "127.0.0.1");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (opts.port ?? 4242);
  if (!opts.host) {
    // Also answer on the IPv6 loopback, since "localhost" may resolve to ::1. Skipped where IPv6 is unavailable.
    const v6 = http.createServer(handler);
    try {
      await listen(v6, port, "::1");
      servers.push(v6);
    } catch {
      v6.close();
    }
  }

  const idle = async () => {
    while (pending.size) await Promise.allSettled([...pending]);
  };

  return {
    server,
    port,
    store,
    deliveries,
    idle,
    close: async () => {
      await idle();
      store.save();
      for (const srv of servers) {
        srv.closeAllConnections();
        await new Promise<void>((resolve) => srv.close(() => resolve()));
      }
    },
  };
}
