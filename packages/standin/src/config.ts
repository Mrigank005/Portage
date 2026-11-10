// Standin's config file plays the role of the Stripe dashboard: it declares, per API key (account),
// the webhook endpoints and the catalog that "already exist" when the server starts.
import fs from "node:fs";
import { buildPrice, buildProduct, buildWebhookEndpoint } from "./objects.ts";
import type { Account, Obj } from "./core.ts";

export interface StandinConfig {
  /** Secret that signs webhooks. Defaults to whsec_standin. */
  webhookSecret?: string;
  accounts?: Record<
    string,
    {
      webhookEndpoints?: { url: string; enabledEvents: string[] }[];
      products?: { slug: string; name: string; description?: string; cents: number; currency?: string; metadata?: Record<string, string> }[];
    }
  >;
}

export function loadConfig(file: string): StandinConfig {
  return JSON.parse(fs.readFileSync(file, "utf8")) as StandinConfig;
}

/** Applies a config account block to an account. Safe to run repeatedly: existing items are kept. */
export function seedAccount(acct: Account, block: NonNullable<StandinConfig["accounts"]>[string], secret: string): void {
  for (const ep of block.webhookEndpoints ?? []) {
    if (!acct.webhookEndpoints.some((e: Obj) => e.url === ep.url)) {
      acct.webhookEndpoints.push(buildWebhookEndpoint({ url: ep.url, enabledEvents: ep.enabledEvents }, secret));
    }
  }
  for (const p of block.products ?? []) {
    if (acct.products.some((x: Obj) => x.metadata?.standin_seed === p.slug)) continue;
    const product = buildProduct({
      name: p.name,
      description: p.description,
      metadata: { ...(p.metadata ?? {}), standin_seed: p.slug, slug: p.slug },
    });
    const price = buildPrice({ product: product.id, currency: p.currency ?? "usd", unitAmount: p.cents });
    product.default_price = price.id;
    acct.products.push(product);
    acct.prices.push(price);
  }
}
