// migrate_catalog against Standin (as Stripe) and a fake PayPal, plus one live run against the PayPal sandbox when
// sandbox credentials are available.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Stripe from "stripe";
import { startStandin, type RunningStandin } from "../../standin/src/server.ts";
import { loadConfig } from "../../standin/src/config.ts";
import { CatalogError, migrateCatalog, renderCatalog } from "../src/index.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoEnv = path.resolve(here, "../../../.env");

let standin: RunningStandin;
let paypal: http.Server;
let paypalBase: string;
const posts: { requestId: string; body: Record<string, string> }[] = [];
const byRequestId = new Map<string, string>();
const dirs: string[] = [];

before(async () => {
  standin = await startStandin({ port: 0, statePath: null, config: loadConfig(path.resolve(here, "../../../suite/standin.config.json")) });
  paypal = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/oauth2/token") return res.end(JSON.stringify({ access_token: "fake", expires_in: 3600 }));
      if (req.url === "/v1/catalogs/products" && req.method === "POST") {
        const requestId = String(req.headers["paypal-request-id"]);
        const body = JSON.parse(raw);
        posts.push({ requestId, body });
        // Like PayPal: the same PayPal-Request-Id returns the same product.
        const id = byRequestId.get(requestId) ?? `PROD-FAKE${byRequestId.size + 1}`;
        byRequestId.set(requestId, id);
        res.statusCode = 201;
        return res.end(JSON.stringify({ id, name: body.name }));
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  await new Promise<void>((r) => paypal.listen(0, "127.0.0.1", () => r()));
  paypalBase = `http://127.0.0.1:${(paypal.address() as { port: number }).port}`;
});

after(async () => {
  await standin.close();
  await new Promise<void>((r) => paypal.close(() => r()));
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function appWith(env: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "portage-catalog-"));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, ".env.local"), Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n"));
  return dir;
}

const standinEnv = (key = "sk_test_standin_brewbox") => ({
  STRIPE_SECRET_KEY: key,
  STRIPE_API_BASE: `http://127.0.0.1:${standin.port}`,
  PAYPAL_CLIENT_ID: "client-id-not-secret-in-tests",
  PAYPAL_CLIENT_SECRET: "client-secret-must-not-leak",
  PAYPAL_ENVIRONMENT: "sandbox",
});

test("dry run lists what would be created, converts prices, writes nothing and never returns settings' values", async () => {
  const dir = appWith(standinEnv());
  const r = await migrateCatalog({ appDir: dir, paypalApiBase: paypalBase });
  assert.equal(r.dryRun, true);
  assert.equal(r.stripeSource, "Standin (local Stripe-compatible server)");
  assert.deepEqual(r.counts, { products: 3, created: 0, reused: 0, wouldCreate: 3, prices: 3, skipped: 0 });
  const names = r.products.map((p) => [p.name, p.type, p.typeFrom, p.prices.map((x) => `${x.paypal.value} ${x.paypal.currencyCode}${x.isDefault ? "*" : ""}`).join()]).sort();
  assert.deepEqual(names, [
    ["House Blend Beans, 1 lb", "PHYSICAL", "default", "18.00 USD*"],
    ["Pour-Over Starter Kit", "PHYSICAL", "default", "49.00 USD*"],
    ["Single Origin Ethiopia, 12 oz", "PHYSICAL", "default", "24.00 USD*"],
  ]);
  assert.equal(posts.length, 0, "a dry run creates nothing");
  assert.equal(fs.existsSync(path.join(dir, "portage.catalog.json")), false);
  const shown = JSON.stringify(r) + renderCatalog(r);
  assert.ok(!shown.includes("client-secret-must-not-leak") && !shown.includes("sk_test_standin_brewbox"), "values never appear");
  assert.equal(r.settingsFrom.PAYPAL_CLIENT_SECRET, ".env.local");
});

test("a real run creates each product once, writes portage.catalog.json, and a re-run reuses the mapping", async () => {
  const dir = appWith(standinEnv());
  const r = await migrateCatalog({ appDir: dir, dryRun: false, paypalApiBase: paypalBase });
  assert.equal(r.counts.created, 3);
  assert.equal(posts.length, 3);
  assert.ok(posts.every((p) => /^portage-catalog-[0-9a-f]{32}$/.test(p.requestId)), "each product has a deterministic PayPal-Request-Id");
  assert.equal(new Set(posts.map((p) => p.requestId)).size, 3);
  assert.deepEqual(Object.keys(posts[0].body).sort(), ["description", "name", "type"]);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "portage.catalog.json"), "utf8"));
  assert.equal(saved.products.length, 3);
  assert.ok(saved.products.every((p: { paypalProductId: string; prices: unknown[] }) => p.paypalProductId.startsWith("PROD-FAKE") && p.prices.length === 1));
  assert.ok(!JSON.stringify(saved).includes("client-secret"), "the catalog file holds no settings");

  const again = await migrateCatalog({ appDir: dir, dryRun: false, paypalApiBase: paypalBase });
  assert.deepEqual([again.counts.created, again.counts.reused], [0, 3]);
  assert.equal(posts.length, 3, "nothing is created twice");
});

test("recurring prices and amounts PayPal can't represent are skipped with a reason", async () => {
  const key = "sk_test_standin_catalog_edge";
  const stripe = new Stripe(key, { host: "127.0.0.1", port: standin.port, protocol: "http" });
  const product = await stripe.products.create({ name: "Paprika tin", shippable: false });
  await stripe.prices.create({ product: product.id, currency: "huf", unit_amount: 1045 });
  await stripe.prices.create({ product: product.id, currency: "huf", unit_amount: 2000 });
  await stripe.prices.create({ product: product.id, currency: "usd", unit_amount: 900, recurring: { interval: "month" } });
  const r = await migrateCatalog({ appDir: appWith(standinEnv(key)), paypalApiBase: paypalBase });
  assert.equal(r.products[0].type, "DIGITAL", "shippable: false means digital");
  assert.deepEqual(r.products[0].prices.map((p) => p.paypal), [{ currencyCode: "HUF", value: "20" }]);
  assert.deepEqual(r.skipped.map((s) => s.reason.split(":")[0]).sort(), ["1045 in Stripe's HUF minor units is 10.45 HUF, but PayPal takes 0 decimal places for HUF", "recurring price"]);
});

test("refuses live keys, live PayPal, and missing settings", async () => {
  await assert.rejects(migrateCatalog({ appDir: appWith({ ...standinEnv(), STRIPE_SECRET_KEY: "sk_live_abc" }) }), (e) => e instanceof CatalogError && /test keys/.test(e.message));
  await assert.rejects(migrateCatalog({ appDir: appWith({ ...standinEnv(), PAYPAL_ENVIRONMENT: "live" }) }), (e) => e instanceof CatalogError && /sandbox/.test(e.message));
  const noPayPal = standinEnv() as Record<string, string>;
  delete noPayPal.PAYPAL_CLIENT_ID;
  const saved = process.env.PAYPAL_CLIENT_ID;
  delete process.env.PAYPAL_CLIENT_ID;
  try {
    await assert.rejects(migrateCatalog({ appDir: appWith(noPayPal), dryRun: false, paypalApiBase: paypalBase }), /PAYPAL_CLIENT_ID/);
  } finally {
    if (saved !== undefined) process.env.PAYPAL_CLIENT_ID = saved;
  }
});

// ---------------------------------------------------------------------------------------------------------------

function sandboxSettings(): Record<string, string> | null {
  if (!fs.existsSync(repoEnv)) return null;
  const v: Record<string, string> = {};
  for (const line of fs.readFileSync(repoEnv, "utf8").split(/\r?\n/)) {
    const m = /^[ \t]*(PAYPAL_CLIENT_ID|PAYPAL_CLIENT_SECRET|PAYPAL_ENVIRONMENT)[ \t]*=[ \t]*(.*)$/.exec(line);
    if (m) v[m[1]] = m[2].trim();
  }
  return v.PAYPAL_CLIENT_ID && v.PAYPAL_CLIENT_SECRET && v.PAYPAL_ENVIRONMENT === "sandbox" ? v : null;
}
const live = sandboxSettings();

test("live sandbox: Brewbox's catalog is copied to PayPal, idempotently", { skip: live ? false : "no PayPal sandbox credentials" }, async () => {
  const dir = appWith({ ...standinEnv(), ...live! });
  const first = await migrateCatalog({ appDir: dir, dryRun: false });
  assert.equal(first.counts.products, 3);
  const ids = first.products.map((p) => p.paypalProductId!);
  assert.ok(ids.every((id) => /^PROD-/.test(id)), ids.join());

  // A fresh folder (no catalog file) still gets the same products back, thanks to the PayPal-Request-Id.
  const second = await migrateCatalog({ appDir: appWith({ ...standinEnv(), ...live! }), dryRun: false });
  assert.deepEqual(second.products.map((p) => p.paypalProductId), ids);

  // And PayPal really has them.
  const tokenRes = await fetch("https://api-m.sandbox.paypal.com/v1/oauth2/token", {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${live!.PAYPAL_CLIENT_ID}:${live!.PAYPAL_CLIENT_SECRET}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const { access_token } = (await tokenRes.json()) as { access_token: string };
  const got = await fetch(`https://api-m.sandbox.paypal.com/v1/catalogs/products/${ids[0]}`, { headers: { Authorization: `Bearer ${access_token}` } });
  assert.equal(got.status, 200);
  const product = (await got.json()) as { name: string; type: string };
  assert.equal(product.type, "PHYSICAL");
  assert.ok(first.products.some((p) => p.name === product.name));
});
