// Builders for the Stripe objects Standin returns. Shapes follow Stripe's public OpenAPI spec
// (the tests validate every object type against it).
import { API_VERSION, ids, nowSeconds, type Obj } from "./core.ts";

export function buildProduct(p: {
  name: string;
  description?: string;
  metadata?: Obj;
  active?: boolean;
  hidden?: boolean;
  shippable?: boolean | null;
  url?: string | null;
  images?: string[];
}): Obj {
  const t = nowSeconds();
  return {
    id: ids.product(),
    object: "product",
    active: p.active ?? true,
    created: t,
    default_price: null,
    description: p.description ?? null,
    images: p.images ?? [],
    livemode: false,
    marketing_features: [],
    metadata: p.metadata ?? {},
    name: p.name,
    package_dimensions: null,
    shippable: p.shippable ?? null,
    statement_descriptor: null,
    tax_code: null,
    unit_label: null,
    updated: t,
    url: p.url ?? null,
    ...(p.hidden ? { _hidden: true } : {}),
  };
}

export function buildPrice(p: {
  product: string;
  currency: string;
  unitAmount: number;
  metadata?: Obj;
  nickname?: string;
  lookupKey?: string;
  active?: boolean;
  recurring?: { interval: string; interval_count?: number };
  hidden?: boolean;
}): Obj {
  return {
    id: ids.price(),
    object: "price",
    active: p.active ?? true,
    billing_scheme: "per_unit",
    created: nowSeconds(),
    currency: p.currency,
    custom_unit_amount: null,
    livemode: false,
    lookup_key: p.lookupKey ?? null,
    metadata: p.metadata ?? {},
    nickname: p.nickname ?? null,
    product: p.product,
    recurring: p.recurring
      ? {
          interval: p.recurring.interval,
          interval_count: p.recurring.interval_count ?? 1,
          meter: null,
          trial_period_days: null,
          usage_type: "licensed",
        }
      : null,
    tax_behavior: "unspecified",
    tiers_mode: null,
    transform_quantity: null,
    type: p.recurring ? "recurring" : "one_time",
    unit_amount: p.unitAmount,
    unit_amount_decimal: String(p.unitAmount),
    ...(p.hidden ? { _hidden: true } : {}),
  };
}

export function buildSession(p: {
  id: string;
  url: string;
  currency: string;
  subtotal: number;
  successUrl: string;
  cancelUrl: string | null;
  clientReferenceId: string | null;
  customerEmail: string | null;
  metadata: Obj;
}): Obj {
  const t = nowSeconds();
  return {
    id: p.id,
    object: "checkout.session",
    adaptive_pricing: null,
    after_expiration: null,
    allow_promotion_codes: null,
    amount_subtotal: p.subtotal,
    amount_total: p.subtotal,
    automatic_tax: { enabled: false, liability: null, provider: null, status: null },
    billing_address_collection: null,
    cancel_url: p.cancelUrl,
    client_reference_id: p.clientReferenceId,
    client_secret: null,
    collected_information: null,
    consent: null,
    consent_collection: null,
    created: t,
    currency: p.currency,
    currency_conversion: null,
    custom_fields: [],
    custom_text: { after_submit: null, shipping_address: null, submit: null, terms_of_service_acceptance: null },
    customer: null,
    customer_creation: "if_required",
    customer_details: null,
    customer_email: p.customerEmail,
    discounts: [],
    expires_at: t + 24 * 60 * 60,
    invoice: null,
    invoice_creation: null,
    livemode: false,
    locale: null,
    metadata: p.metadata,
    mode: "payment",
    payment_intent: null,
    payment_link: null,
    payment_method_collection: "if_required",
    payment_method_configuration_details: null,
    payment_method_options: {},
    payment_method_types: ["card"],
    payment_status: "unpaid",
    phone_number_collection: { enabled: false },
    recovered_from: null,
    saved_payment_method_options: null,
    setup_intent: null,
    shipping_address_collection: null,
    shipping_cost: null,
    shipping_options: [],
    status: "open",
    submit_type: null,
    subscription: null,
    success_url: p.successUrl,
    tax_id_collection: { enabled: false, required: "never" },
    total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 },
    ui_mode: "hosted_page",
    url: p.url,
  };
}

export function buildLineItem(p: { priceId: string; description: string; quantity: number; unitAmount: number; currency: string }): Obj {
  const total = p.unitAmount * p.quantity;
  return {
    id: ids.lineItem(),
    object: "item",
    amount_discount: 0,
    amount_subtotal: total,
    amount_tax: 0,
    amount_total: total,
    currency: p.currency,
    description: p.description,
    _priceId: p.priceId,
    quantity: p.quantity,
  };
}

export interface CardInfo {
  brand: string;
  last4: string;
  funding: "credit" | "debit";
  exp_month: number;
  exp_year: number;
}

export function buildPaymentIntent(p: { amount: number; currency: string; chargeId: string; paymentMethodId: string; metadata: Obj; description: string | null; receiptEmail: string | null }): Obj {
  return {
    id: ids.paymentIntent(),
    object: "payment_intent",
    amount: p.amount,
    amount_capturable: 0,
    amount_received: p.amount,
    capture_method: "automatic",
    client_secret: null,
    confirmation_method: "automatic",
    created: nowSeconds(),
    currency: p.currency,
    customer: null,
    description: p.description,
    last_payment_error: null,
    latest_charge: p.chargeId,
    livemode: false,
    metadata: p.metadata,
    next_action: null,
    payment_method: p.paymentMethodId,
    payment_method_types: ["card"],
    receipt_email: p.receiptEmail,
    setup_future_usage: null,
    shipping: null,
    statement_descriptor: null,
    status: "succeeded",
  };
}

export function buildCharge(p: {
  id: string;
  paymentIntentId: string;
  paymentMethodId: string;
  amount: number;
  currency: string;
  card: CardInfo;
  email: string | null;
  name: string | null;
  metadata: Obj;
  description: string | null;
}): Obj {
  return {
    id: p.id,
    object: "charge",
    amount: p.amount,
    amount_captured: p.amount,
    amount_refunded: 0,
    application: null,
    application_fee: null,
    application_fee_amount: null,
    balance_transaction: ids.balanceTransaction(),
    billing_details: {
      address: { city: null, country: null, line1: null, line2: null, postal_code: null, state: null },
      email: p.email,
      name: p.name,
      phone: null,
    },
    calculated_statement_descriptor: "STANDIN TEST",
    captured: true,
    created: nowSeconds(),
    currency: p.currency,
    customer: null,
    description: p.description,
    disputed: false,
    failure_balance_transaction: null,
    failure_code: null,
    failure_message: null,
    livemode: false,
    metadata: p.metadata,
    outcome: {
      network_status: "approved_by_network",
      reason: null,
      risk_level: "normal",
      risk_score: 20,
      seller_message: "Payment complete.",
      type: "authorized",
    },
    paid: true,
    payment_intent: p.paymentIntentId,
    payment_method: p.paymentMethodId,
    payment_method_details: {
      type: "card",
      card: {
        brand: p.card.brand,
        country: "US",
        exp_month: p.card.exp_month,
        exp_year: p.card.exp_year,
        funding: p.card.funding,
        last4: p.card.last4,
        network: p.card.brand,
      },
    },
    receipt_email: p.email,
    receipt_number: null,
    receipt_url: null,
    refunded: false,
    review: null,
    shipping: null,
    source_transfer: null,
    statement_descriptor: null,
    statement_descriptor_suffix: null,
    status: "succeeded",
    transfer_data: null,
    transfer_group: null,
  };
}

export function buildRefund(p: { amount: number; currency: string; chargeId: string; paymentIntentId: string; reason: string | null; metadata: Obj }): Obj {
  return {
    id: ids.refund(),
    object: "refund",
    amount: p.amount,
    balance_transaction: ids.balanceTransaction(),
    charge: p.chargeId,
    created: nowSeconds(),
    currency: p.currency,
    metadata: p.metadata,
    payment_intent: p.paymentIntentId,
    reason: p.reason,
    receipt_number: null,
    source_transfer_reversal: null,
    status: "succeeded",
    transfer_reversal: null,
  };
}

export function buildEvent(type: string, object: Obj, pending: number): Obj {
  return {
    id: ids.event(),
    object: "event",
    api_version: API_VERSION,
    created: nowSeconds(),
    data: { object },
    livemode: false,
    pending_webhooks: pending,
    request: { id: null, idempotency_key: null },
    type,
  };
}

export function buildWebhookEndpoint(p: { url: string; enabledEvents: string[]; description?: string | null; metadata?: Obj }, secret?: string): Obj {
  return {
    id: ids.webhookEndpoint(),
    object: "webhook_endpoint",
    api_version: null,
    application: null,
    created: nowSeconds(),
    description: p.description ?? null,
    enabled_events: p.enabledEvents,
    livemode: false,
    metadata: p.metadata ?? {},
    status: "enabled",
    url: p.url,
    ...(secret ? { secret } : {}),
  };
}
