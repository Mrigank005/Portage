// migrate_catalog: copies an app's Stripe products to the PayPal catalog and writes portage.catalog.json.
//
// Reads products and prices with the official Stripe SDK (through STRIPE_API_BASE when set, so suite apps read from
// Standin) and creates PayPal catalog products with POST /v1/catalogs/products: the same call the PayPal Agent
// Toolkit's create_product makes. PayPal catalog products carry no one-time prices, so the prices go into
// portage.catalog.json, already converted to PayPal amounts, for the app's create-order route to read.
//
// Safety: dry run by default; only test keys (sk_test_ / sandbox); reads only the five settings it needs from the
// named env files and never returns their values; idempotent (a PayPal-Request-Id per product, and existing mappings
// are reused).
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Stripe from "stripe";
import { toPayPalMoney, type PayPalMoney } from "./money.ts";

export type PayPalProductType = "PHYSICAL" | "DIGITAL" | "SERVICE";

export interface CatalogOptions {
  /** The app's folder (where portage.catalog.json is written). */
  appDir: string;
  /** Env files to read settings from, relative to appDir. Default: .env.local, .env (first value wins; then the process environment). */
  envFiles?: string[];
  dryRun?: boolean;
  /** Product type when Stripe doesn't say (metadata.paypal_type or shippable). Default PHYSICAL. */
  defaultType?: PayPalProductType;
  /** For tests: where PayPal's REST API is. */
  paypalApiBase?: string;
}

export interface CatalogPrice {
  stripePriceId: string;
  unitAmount: number;
  currency: string;
  paypal: PayPalMoney;
  isDefault: boolean;
}

export interface CatalogProduct {
  stripeProductId: string;
  paypalProductId: string | null;
  name: string;
  description: string | null;
  type: PayPalProductType;
  typeFrom: "metadata" | "shippable" | "default";
  status: "would-create" | "created" | "reused";
  prices: CatalogPrice[];
}

export interface CatalogResult {
  dryRun: boolean;
  appDir: string;
  file: string;
  stripeSource: "Standin (local Stripe-compatible server)" | "Stripe (test mode)";
  paypalEnvironment: "sandbox";
  settingsFrom: Record<string, string>;
  products: CatalogProduct[];
  skipped: { stripeId: string; reason: string }[];
  counts: { products: number; created: number; reused: number; wouldCreate: number; prices: number; skipped: number };
}

const KEYS = ["STRIPE_SECRET_KEY", "STRIPE_API_BASE", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_ENVIRONMENT"] as const;
type Key = (typeof KEYS)[number];

/** Reads only the settings migrate_catalog needs. Returns values (internal use only) and where each came from (safe to show). */
export function readSettings(appDir: string, envFiles: string[]): { values: Partial<Record<Key, string>>; from: Record<string, string> } {
  const values: Partial<Record<Key, string>> = {};
  const from: Record<string, string> = {};
  for (const f of envFiles) {
    const file = path.resolve(appDir, f);
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const m = /^[ \t]*(?:export[ \t]+)?([A-Z0-9_]+)[ \t]*=[ \t]*(.*)$/.exec(line);
      if (!m || !(KEYS as readonly string[]).includes(m[1])) continue;
      const k = m[1] as Key;
      const v = m[2].trim().replace(/^(["'])(.*)\1$/, "$2");
      if (v && values[k] === undefined) {
        values[k] = v;
        from[k] = f;
      }
    }
  }
  for (const k of KEYS) {
    if (values[k] === undefined && process.env[k]) {
      values[k] = process.env[k];
      from[k] = "process environment";
    }
  }
  return { values, from };
}

export class CatalogError extends Error {}

function stripeClient(key: string, apiBase: string | undefined): Stripe {
  if (!apiBase) return new Stripe(key);
  const u = new URL(apiBase);
  return new Stripe(key, { host: u.hostname, port: Number(u.port || (u.protocol === "https:" ? 443 : 80)), protocol: u.protocol.replace(":", "") as "http" | "https" });
}

/**
 * fetch with up to two retries, with backoff, for dropped connections, 429 and 5xx. Safe here: the token call changes
 * nothing, and product creation sends a deterministic PayPal-Request-Id, so a retry returns the same product.
 */
async function fetchWithRetry(url: string, init: RequestInit, attempts = 3): Promise<Response> {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, init);
      if ((res.status === 429 || res.status >= 500) && i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** i));
        continue;
      }
      return res;
    } catch (err) {
      if (i >= attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
  }
}

async function paypalToken(base: string, id: string, secret: string): Promise<string> {
  const res = await fetchWithRetry(`${base}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new CatalogError(`PayPal sign-in failed (HTTP ${res.status}). Check PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.`);
  return ((await res.json()) as { access_token: string }).access_token;
}

const https = (u: unknown): string | undefined => (typeof u === "string" && /^https:\/\/\S+$/.test(u) ? u : undefined);

function productType(p: Stripe.Product, fallback: PayPalProductType): { type: PayPalProductType; from: CatalogProduct["typeFrom"] } {
  const meta = String(p.metadata?.paypal_type ?? "").toUpperCase();
  if (meta === "PHYSICAL" || meta === "DIGITAL" || meta === "SERVICE") return { type: meta, from: "metadata" };
  if (p.shippable === true) return { type: "PHYSICAL", from: "shippable" };
  if (p.shippable === false) return { type: "DIGITAL", from: "shippable" };
  return { type: fallback, from: "default" };
}

export async function migrateCatalog(opts: CatalogOptions): Promise<CatalogResult> {
  const dryRun = opts.dryRun ?? true;
  const appDir = path.resolve(opts.appDir);
  const envFiles = opts.envFiles ?? [".env.local", ".env"];
  const { values, from } = readSettings(appDir, envFiles);

  const stripeKey = values.STRIPE_SECRET_KEY;
  if (!stripeKey) throw new CatalogError(`STRIPE_SECRET_KEY not found in ${envFiles.join(", ")} or the environment.`);
  if (!/^(sk|rk)_test_/.test(stripeKey)) throw new CatalogError("Portage only copies catalogs with Stripe test keys (sk_test_…). The key it found is not a test key.");
  if (values.PAYPAL_ENVIRONMENT && values.PAYPAL_ENVIRONMENT !== "sandbox") throw new CatalogError("Portage only creates products in the PayPal sandbox. Set PAYPAL_ENVIRONMENT=sandbox.");
  if (!dryRun && (!values.PAYPAL_CLIENT_ID || !values.PAYPAL_CLIENT_SECRET)) {
    throw new CatalogError(`PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are needed to create products; not found in ${envFiles.join(", ")} or the environment.`);
  }

  const stripe = stripeClient(stripeKey, values.STRIPE_API_BASE);
  const products: Stripe.Product[] = [];
  for await (const p of stripe.products.list({ active: true, limit: 100 })) products.push(p);
  const prices: Stripe.Price[] = [];
  for await (const p of stripe.prices.list({ active: true, limit: 100 })) prices.push(p);

  const file = path.join(appDir, "portage.catalog.json");
  const existing = new Map<string, string>();
  try {
    const prev = JSON.parse(fs.readFileSync(file, "utf8")) as { products?: { stripeProductId: string; paypalProductId: string | null }[] };
    for (const p of prev.products ?? []) if (p.paypalProductId) existing.set(p.stripeProductId, p.paypalProductId);
  } catch {
    /* no previous catalog */
  }

  const base = (opts.paypalApiBase ?? "https://api-m.sandbox.paypal.com").replace(/\/$/, "");
  let token: string | undefined;
  const skipped: CatalogResult["skipped"] = [];
  const out: CatalogProduct[] = [];

  for (const p of [...products].sort((a, b) => a.id.localeCompare(b.id))) {
    const { type, from: typeFrom } = productType(p, opts.defaultType ?? "PHYSICAL");
    const defaultPriceId = typeof p.default_price === "string" ? p.default_price : p.default_price?.id;
    const own: CatalogPrice[] = [];
    for (const pr of prices.filter((x) => (typeof x.product === "string" ? x.product : x.product.id) === p.id).sort((a, b) => a.id.localeCompare(b.id))) {
      if (pr.type !== "one_time") {
        skipped.push({ stripeId: pr.id, reason: "recurring price: subscriptions are not in Portage's scope yet" });
        continue;
      }
      if (pr.unit_amount === null) {
        skipped.push({ stripeId: pr.id, reason: "price has no fixed unit amount (tiered or custom amount)" });
        continue;
      }
      try {
        own.push({ stripePriceId: pr.id, unitAmount: pr.unit_amount, currency: pr.currency, paypal: toPayPalMoney(pr.unit_amount, pr.currency), isDefault: pr.id === defaultPriceId });
      } catch (err) {
        skipped.push({ stripeId: pr.id, reason: (err as Error).message });
      }
    }

    const description = p.description ? p.description.slice(0, 256) : null;
    const entry: CatalogProduct = { stripeProductId: p.id, paypalProductId: existing.get(p.id) ?? null, name: p.name.slice(0, 127), description, type, typeFrom, status: "reused", prices: own };
    if (!entry.paypalProductId) {
      if (dryRun) entry.status = "would-create";
      else {
        token ??= await paypalToken(base, values.PAYPAL_CLIENT_ID!, values.PAYPAL_CLIENT_SECRET!);
        const body: Record<string, string> = { name: entry.name, type };
        if (description) body.description = description;
        const image = https(p.images?.[0]);
        if (image) body.image_url = image;
        const home = https(p.url);
        if (home) body.home_url = home;
        // Same product + same PayPal app → same request id, so a re-run returns the product PayPal already made.
        const requestId = `portage-catalog-${createHash("sha256").update(`${values.PAYPAL_CLIENT_ID}:${p.id}`).digest("hex").slice(0, 32)}`;
        const res = await fetchWithRetry(`${base}/v1/catalogs/products`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "PayPal-Request-Id": requestId, Prefer: "return=representation" },
          body: JSON.stringify(body),
        });
        const data = (await res.json().catch(() => ({}))) as { id?: string; name?: string; debug_id?: string; details?: { issue?: string; field?: string }[] };
        if (!res.ok || !data.id) {
          const d = data.details?.[0];
          throw new CatalogError(`PayPal refused product ${p.id} (HTTP ${res.status}${d ? `: ${d.field ?? ""} ${d.issue ?? ""}`.trimEnd() : ""}${data.debug_id ? `, debug_id ${data.debug_id}` : ""}).`);
        }
        entry.paypalProductId = data.id;
        entry.status = "created";
      }
    }
    out.push(entry);
  }

  const result: CatalogResult = {
    dryRun,
    appDir,
    file,
    stripeSource: values.STRIPE_API_BASE ? "Standin (local Stripe-compatible server)" : "Stripe (test mode)",
    paypalEnvironment: "sandbox",
    settingsFrom: from,
    products: out,
    skipped,
    counts: {
      products: out.length,
      created: out.filter((p) => p.status === "created").length,
      reused: out.filter((p) => p.status === "reused").length,
      wouldCreate: out.filter((p) => p.status === "would-create").length,
      prices: out.reduce((n, p) => n + p.prices.length, 0),
      skipped: skipped.length,
    },
  };

  if (!dryRun) {
    const saved = {
      about: "Written by Portage migrate_catalog. Maps Stripe products to PayPal catalog products. PayPal catalog products have no one-time prices, so prices are kept here, already converted to PayPal amounts.",
      paypalEnvironment: "sandbox",
      products: out.map(({ status: _status, typeFrom: _from, ...p }) => p),
      skipped,
    };
    fs.writeFileSync(file, `${JSON.stringify(saved, null, 2)}\n`);
  }
  return result;
}

export function renderCatalog(r: CatalogResult): string {
  const lines = [
    `# Portage catalog copy${r.dryRun ? " (dry run)" : ""}`,
    "",
    `Source: ${r.stripeSource} · Target: PayPal ${r.paypalEnvironment} · ${r.counts.products} products, ${r.counts.prices} one-time prices`,
    "",
    r.dryRun
      ? `Nothing was created. ${r.counts.wouldCreate} product${r.counts.wouldCreate === 1 ? "" : "s"} would be created${r.counts.reused ? ` and ${r.counts.reused} already mapped` : ""}. Run again with dryRun false to create them and write portage.catalog.json.`
      : `Created ${r.counts.created}, reused ${r.counts.reused}. Wrote ${path.basename(r.file)}.`,
    "",
    "| Stripe product | PayPal product | Name | Type | Prices |",
    "|---|---|---|---|---|",
    ...r.products.map(
      (p) =>
        `| \`${p.stripeProductId}\` | ${p.paypalProductId ? `\`${p.paypalProductId}\`` : p.status} | ${p.name.replace(/\|/g, "\\|")} | ${p.type}${p.typeFrom === "default" ? " (default; set metadata.paypal_type to change)" : ""} | ${p.prices.map((x) => `${x.paypal.value} ${x.paypal.currencyCode}${x.isDefault ? " (default)" : ""}`).join(", ") || "none"} |`,
    ),
    "",
  ];
  if (r.skipped.length) lines.push("Skipped:", "", ...r.skipped.map((s) => `- \`${s.stripeId}\`: ${s.reason}`), "");
  lines.push(`Settings read from: ${Object.entries(r.settingsFrom).map(([k, f]) => `${k} (${f})`).join(", ") || "nowhere"}. Values are never shown.`);
  return lines.join("\n");
}
