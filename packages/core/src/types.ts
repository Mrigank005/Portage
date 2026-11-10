// Shapes of what scan_payment_surface and plan_migration return. All file paths are POSIX paths relative to the
// scanned repository's root, so results are the same on Windows and Linux.
import type { MapStatus } from "./map.ts";

export type Confidence = "high" | "medium";
export type Severity = "blocker" | "needs-human" | "info";

export interface Loc {
  file: string;
  line: number;
}

/** How a route reads in reports: "POST /api/checkout", or "server action checkoutWithStripe". */
export function routeLabel(r: { kind: string; method: string; path: string }): string {
  return r.kind === "next-action" ? `server action ${r.path}` : `${r.method} ${r.path}`;
}

export interface Issue {
  code: string;
  severity: Severity;
  message: string;
  where?: Loc[];
}

export interface Route {
  /** next-action is a Next.js server action: method "ACTION", path is the exported function's name. */
  kind: "next-app" | "next-pages" | "next-action" | "express";
  method: string;
  path: string;
  file: string;
  line: number;
}

/** A call into the app's own code, such as the function that fulfils an order. */
export interface AppCall {
  name: string;
  line: number;
  module?: string;
  definedIn?: Loc;
  params?: string;
}

export interface StripeCall extends Loc {
  path: string;
  snippet: string;
  confidence: Confidence;
  status: MapStatus | "unknown";
  role: string;
  inTest: boolean;
  enclosing?: string;
}

export interface ClientSetup extends Loc {
  keyEnv?: string;
  customHost: boolean;
  apiVersion?: string;
  names: string[];
}

export interface LineItem {
  kind: "price" | "price_data" | "dynamic";
  priceId?: string;
  currency?: string;
  unitAmount?: string;
  quantity?: string;
  productName?: string;
  expr?: string;
}

export interface CheckoutSession extends Loc {
  route?: Route;
  modes: string[];
  lineItems: LineItem[];
  params: Record<string, string>;
  idempotencyKey: boolean;
  connectOption: boolean;
  successUrl?: string;
  cancelUrl?: string;
  usesSessionIdPlaceholder: boolean;
  response: "redirect" | "json-url" | "json-id" | "client-secret" | "unknown";
  sessionVar?: string;
  sessionIdStoredAs: { call: string; field: string; line: number }[];
  appCalls: AppCall[];
  currencies: string[];
  inTest: boolean;
}

export interface HandledEvent {
  type: string;
  line: number;
  appCalls: AppCall[];
  stripeCalls: string[];
  fieldsRead: string[];
}

export interface WebhookHandler extends Loc {
  route?: Route;
  verify: string;
  rawBody: string;
  secretEnv?: string;
  events: HandledEvent[];
  inTest: boolean;
}

export interface RefundCall extends Loc {
  route?: Route;
  by: "payment_intent" | "charge" | "unknown";
  source?: string;
  sourceField?: string;
  partial: boolean;
  inTest: boolean;
}

export interface ClientSideUse extends Loc {
  kind: "stripe-js" | "elements" | "embedded-checkout" | "redirect-to-checkout" | "payment-link";
  detail: string;
}

export interface Trigger extends Loc {
  target: string;
  snippet: string;
}

export interface DataField extends Loc {
  entity: string;
  field: string;
  source: "typescript" | "prisma";
}

export interface EnvVarRef {
  name: string;
  where: Loc[];
}

export interface Framework {
  id: "next" | "express" | "unsupported" | "none";
  label: string;
  version?: string;
  router?: "app" | "pages" | "both";
  supported: boolean;
}

export interface AppScan {
  root: string;
  name: string;
  language: "typescript" | "javascript";
  framework: Framework;
  stripeVersion?: string;
  srcDir: boolean;
  clients: ClientSetup[];
  checkouts: CheckoutSession[];
  webhooks: WebhookHandler[];
  refunds: RefundCall[];
  calls: StripeCall[];
  clientSide: ClientSideUse[];
  triggers: Trigger[];
  dataModel: DataField[];
  envVars: EnvVarRef[];
  envExampleFiles: { file: string; keys: string[] }[];
  hardcodedIds: (Loc & { id: string })[];
  issues: Issue[];
  supported: boolean;
}

export interface ForeignStripeUse extends Loc {
  language: string;
  what: string;
}

export interface ScanResult {
  tool: "portage";
  kind: "scan";
  version: 1;
  repo: { path: string; name: string };
  languages: Record<string, number>;
  apps: AppScan[];
  otherLanguages: ForeignStripeUse[];
  issues: Issue[];
  supported: boolean;
  stats: { filesSeen: number; filesParsed: number; ms: number };
}

export type Mode = "add" | "replace";

export interface FileChange {
  file: string;
  why: string;
}

export interface PlanStep {
  id: string;
  title: string;
  kind: "dependency" | "config" | "create" | "edit" | "remove" | "catalog" | "verify";
  files: string[];
  details: string[];
  contextmatic: ContextMaticLookup[];
}

export interface ContextMaticLookup {
  tool: "fetch_api" | "ask" | "endpoint_search" | "model_search";
  query: string;
  why: string;
}

export interface EventPlan {
  stripe: string;
  paypal: string | null;
  status: MapStatus | "unknown";
  reuse: string[];
  notes: string[];
}

export interface Plan {
  tool: "portage";
  kind: "plan";
  version: 1;
  repo: { path: string; name: string };
  app: { root: string; name: string; framework: string };
  mode: Mode;
  status: "ready" | "blocked";
  headline: string;
  blockers: Issue[];
  needsHuman: Issue[];
  notes: Issue[];
  steps: PlanStep[];
  files: { create: FileChange[]; edit: FileChange[]; remove: FileChange[] };
  routes: { method: string; path: string; file: string; purpose: string }[];
  env: { add: { name: string; example: string; note: string }[]; remove: string[] };
  dependencies: { add: string[]; remove: string[] };
  events: EventPlan[];
  dataModel: { entity: string; file: string; line: number; add: string[]; note: string }[];
  money: { currency: string; paypal: "ok" | "whole-units-only" | "in-country-only" | "unsupported"; note: string }[];
  catalog: { needed: boolean; reason: string };
  untouched: string[];
  contextmatic: ContextMaticLookup[];
  verify: { checkoutPath?: string; webhookPath?: string; triggerFile?: string };
}
