// Loads the Stripe→PayPal map (maps/stripe-paypal.json) and answers lookups against it.
// The map is data; this file only knows how to read it.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export type MapStatus = "mapped" | "keep" | "catalog" | "needs-human" | "blocker";

export interface CallRule {
  stripe: string; // method path such as "checkout.sessions.create", or "accounts.*"
  when?: { mode?: string };
  role: string;
  status: MapStatus;
  paypal: string;
  sdk?: string[];
  rest?: string;
  models?: string[];
  notes?: string;
  blocker?: string;
}

export interface EventRule {
  stripe: string;
  paypal: string | null;
  status: MapStatus;
  notes?: string;
}

export interface ParamRule {
  stripe: string;
  paypal: string | null;
  status: MapStatus;
  notes?: string;
  blocker?: string;
}

export interface FieldRule {
  object: string;
  stripe: string;
  paypal: string;
}

export interface EnvRule {
  stripe: string;
  paypal: string[];
  notes?: string;
}

export interface PaymentMap {
  version: number;
  source: string;
  target: string;
  paypalSdk: {
    package: string;
    confirmedVia: string;
    methods: string[];
    models: string[];
    notInSdk: Record<string, string>;
  };
  statuses: Record<MapStatus, string>;
  calls: CallRule[];
  events: EventRule[];
  sessionParams: ParamRule[];
  objectFields: FieldRule[];
  config: {
    env: EnvRule[];
    packages: { server: string; react: string; browserScript: string };
    stripePackages: string[];
  };
  currencies: {
    paypal: Record<string, number>;
    paypalInCountryOnly: string[];
    stripeZeroDecimal: string[];
    stripeThreeDecimal: string[];
    stripeTwoDecimalWholeOnly: string[];
    sources: string[];
  };
}

let cached: PaymentMap | null = null;

export function loadMap(): PaymentMap {
  if (!cached) {
    const file = fileURLToPath(new URL("../maps/stripe-paypal.json", import.meta.url));
    cached = JSON.parse(fs.readFileSync(file, "utf8")) as PaymentMap;
  }
  return cached;
}

/** Use an already-loaded map (the bundled plugin embeds it instead of reading it from disk). */
export function setMap(map: PaymentMap): void {
  cached = map;
}

/** The rule for a Stripe method path. Exact rules win over wildcards; a `when.mode` rule needs that mode. */
export function ruleForCall(path: string, mode?: string, map = loadMap()): CallRule | undefined {
  const exact = map.calls.filter((r) => r.stripe === path);
  if (exact.length) {
    return exact.find((r) => r.when?.mode !== undefined && r.when.mode === mode) ?? exact.find((r) => !r.when) ?? (mode === undefined ? exact[0] : undefined);
  }
  return map.calls.find((r) => r.stripe.endsWith(".*") && path.startsWith(r.stripe.slice(0, -1)));
}

export function ruleForEvent(type: string, map = loadMap()): EventRule | undefined {
  return map.events.find((e) => e.stripe === type);
}

export function ruleForParam(name: string, map = loadMap()): ParamRule | undefined {
  return map.sessionParams.find((p) => p.stripe === name);
}
