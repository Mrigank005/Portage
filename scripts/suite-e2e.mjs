// End-to-end check for the test suite: starts Standin, Brewbox and Quill, then drives a real payment
// through each app (product page -> checkout -> hosted test pay page -> signed webhook -> fulfilment)
// and a partial and a full refund. Nothing here touches PayPal or real Stripe.
// Run: node scripts/suite-e2e.mjs
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORTS = { standin: 4242, brewbox: 4300, quill: 4301 };
const URLS = {
  standin: `http://localhost:${PORTS.standin}`,
  brewbox: `http://localhost:${PORTS.brewbox}`,
  quill: `http://localhost:${PORTS.quill}`,
};
const WEBHOOK_SECRET = "whsec_standin";

const tsxCli = createRequire(path.join(root, "package.json")).resolve("tsx/cli");
const nextBin = createRequire(path.join(root, "suite/brewbox-store/package.json")).resolve("next/dist/bin/next");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "portage-suite-"));

const children = [];
const logs = {};

function start(name, args, cwd, env) {
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  logs[name] = [];
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (d) => {
      logs[name].push(...String(d).split("\n").filter(Boolean));
      if (logs[name].length > 200) logs[name].splice(0, logs[name].length - 200);
    });
  }
  child.on("exit", (code) => logs[name].push(`[exited with code ${code}]`));
  children.push(child);
  return child;
}

function killAll() {
  for (const c of children) {
    if (c.exitCode !== null) continue;
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(c.pid), "/T", "/F"], { stdio: "ignore" });
    else c.kill("SIGTERM");
  }
}

// Stop the services even if the run is interrupted with Ctrl-C.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    killAll();
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(130);
  });
}

async function waitForUrl(url, ms) {
  const end = Date.now() + ms;
  let last = "";
  while (Date.now() < end) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (res.status < 500) return;
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = e.cause?.code ?? e.message;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`${url} did not become ready (${last})`);
}

async function poll(fn, ms, what) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const results = [];
async function check(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}  (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (e) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name}\n        ${String(e.message).split("\n").join("\n        ")}`);
  }
}

const form = (obj) => new URLSearchParams(obj);
const http = (url, init = {}) => fetch(url, { signal: AbortSignal.timeout(90_000), ...init });

/** Plays the buyer on Standin's hosted test checkout page and returns where it redirects to. */
async function payOnStandin(checkoutUrl, email) {
  const page = await http(checkoutUrl);
  assert.equal(page.status, 200, "pay page loads");
  assert.match(await page.text(), /Standin test checkout/);
  const paid = await http(checkoutUrl, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ email, name: "Test Buyer", cardNumber: "4242 4242 4242 4242", exp: "12 / 34", cvc: "123" }),
  });
  assert.equal(paid.status, 303, "paying redirects to success_url");
  return paid.headers.get("location");
}

async function standinGet(path, key) {
  const res = await http(`${URLS.standin}${path}`, { headers: { Authorization: `Bearer ${key}` } });
  return res.json();
}

// ---------------------------------------------------------------------------------------------------------

let exitCode = 0;
try {
  for (const [name, url] of Object.entries(URLS)) {
    const up = await fetch(url, { signal: AbortSignal.timeout(1500) }).then(() => true, () => false);
    if (up) throw new Error(`Port ${new URL(url).port} is already in use (${name}). Stop whatever is running there and try again.`);
  }

  console.log("Starting Standin, Brewbox and Quill...");
  const common = { STRIPE_API_BASE: URLS.standin, STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET };
  start("standin", [tsxCli, "packages/standin/src/cli.ts", "--config", "suite/standin.config.json", "--no-persist"], root, { STANDIN_PORT: String(PORTS.standin) });
  await waitForUrl(`${URLS.standin}/_standin/health`, 30_000);

  const brewboxKey = "sk_test_standin_brewbox";
  const quillKey = "sk_test_standin_quill";
  start("brewbox", [nextBin, "dev", "-H", "127.0.0.1", "-p", String(PORTS.brewbox)], path.join(root, "suite/brewbox-store"), {
    ...common,
    STRIPE_SECRET_KEY: brewboxKey,
    APP_URL: URLS.brewbox,
    BREWBOX_DATA_DIR: path.join(tmp, "brewbox"),
    NEXT_TELEMETRY_DISABLED: "1",
  });
  start("quill", [tsxCli, "src/server.ts"], path.join(root, "suite/quill-saas"), {
    ...common,
    STRIPE_SECRET_KEY: quillKey,
    PORT: String(PORTS.quill),
    HOST: "127.0.0.1",
    APP_URL: URLS.quill,
    ADMIN_TOKEN: "quill-admin",
    QUILL_DATA_DIR: path.join(tmp, "quill"),
  });
  await Promise.all([waitForUrl(`${URLS.quill}/`, 60_000), waitForUrl(`${URLS.brewbox}/`, 150_000)]);
  console.log("All services are up.\n");

  // ---- Brewbox (Next.js, catalog prices, order table) ----------------------------------------------------
  console.log("Brewbox (Next.js App Router)");
  let bb = {};
  await check("shop page lists the three Stripe products", async () => {
    const html = await (await http(`${URLS.brewbox}/`)).text();
    for (const name of ["House Blend Beans, 1 lb", "Single Origin Ethiopia, 12 oz", "Pour-Over Starter Kit"]) {
      assert.ok(html.includes(name), `missing product: ${name}`);
    }
    bb.priceIds = [...html.matchAll(/name="priceId"[^>]*value="(price_[A-Za-z0-9]+)"/g)].map((m) => m[1]);
    assert.equal(bb.priceIds.length, 3);
  });
  const ordersOnDisk = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(tmp, "brewbox", "orders.json"), "utf8")).length;
    } catch {
      return 0;
    }
  };
  await check("an unknown price is refused with 400 and creates no order", async () => {
    const before = ordersOnDisk();
    const res = await http(`${URLS.brewbox}/api/checkout`, { method: "POST", redirect: "manual", body: form({ priceId: "price_doesnotexist" }) });
    assert.equal(res.status, 400);
    assert.equal(ordersOnDisk(), before);
  });
  await check("checkout redirects to the hosted pay page", async () => {
    const res = await http(`${URLS.brewbox}/api/checkout`, { method: "POST", redirect: "manual", body: form({ priceId: bb.priceIds[0], quantity: "2" }) });
    assert.equal(res.status, 303);
    bb.payUrl = res.headers.get("location");
    assert.match(bb.payUrl, /\/pay\/cs_test_/);
  });
  await check("paying with the test card returns to the order page", async () => {
    const location = await payOnStandin(bb.payUrl, "buyer@brewbox.test");
    const m = location.match(/\/order\/(ord_[a-f0-9]+)\?session_id=cs_test_/);
    assert.ok(m, `unexpected redirect: ${location}`);
    bb.orderId = m[1];
  });
  await check("signed webhook marks the order paid with the right total and email", async () => {
    const order = await poll(async () => {
      const o = await (await http(`${URLS.brewbox}/api/orders/${bb.orderId}`)).json();
      return o.status === "paid" ? o : null;
    }, 20_000, "the order to be marked paid");
    const price = await standinGet(`/v1/prices/${bb.priceIds[0]}`, brewboxKey);
    assert.equal(order.total, price.unit_amount * 2);
    assert.equal(order.email, "buyer@brewbox.test");
    assert.ok(order.paymentIntentId?.startsWith("pi_"));
    bb.order = order;
  });
  await check("order page shows the payment and the receipt was sent", async () => {
    const html = await (await http(`${URLS.brewbox}/order/${bb.orderId}`)).text();
    assert.match(html, /Payment received/);
    const outbox = fs.readFileSync(path.join(tmp, "brewbox", "outbox.log"), "utf8");
    assert.match(outbox, new RegExp(`receipt to buyer@brewbox.test for ${bb.orderId}`));
  });
  await check("a refund amount that isn't a whole number of cents is refused, and nothing is refunded", async () => {
    for (const amount of ["abc", "-5", "0", "12.5"]) {
      const res = await http(`${URLS.brewbox}/api/admin/refund`, { method: "POST", redirect: "manual", body: form({ orderId: bb.orderId, amount }) });
      assert.equal(res.status, 400, `amount "${amount}" should be refused`);
    }
    await new Promise((r) => setTimeout(r, 1000)); // give any (wrong) refund webhook time to land
    const order = await (await http(`${URLS.brewbox}/api/orders/${bb.orderId}`)).json();
    assert.equal(order.status, "paid");
    assert.equal(order.refundedAmount, 0);
  });
  await check("partial refund from the admin page updates the order", async () => {
    const res = await http(`${URLS.brewbox}/api/admin/refund`, { method: "POST", redirect: "manual", body: form({ orderId: bb.orderId, amount: "500" }) });
    assert.equal(res.status, 303);
    const order = await poll(async () => {
      const o = await (await http(`${URLS.brewbox}/api/orders/${bb.orderId}`)).json();
      return o.status === "partially_refunded" ? o : null;
    }, 15_000, "the partial refund webhook");
    assert.equal(order.refundedAmount, 500);
  });
  await check("full refund of the remainder closes the order", async () => {
    await http(`${URLS.brewbox}/api/admin/refund`, { method: "POST", redirect: "manual", body: form({ orderId: bb.orderId }) });
    const order = await poll(async () => {
      const o = await (await http(`${URLS.brewbox}/api/orders/${bb.orderId}`)).json();
      return o.status === "refunded" ? o : null;
    }, 15_000, "the full refund webhook");
    assert.equal(order.refundedAmount, bb.order.total);
    const html = await (await http(`${URLS.brewbox}/admin/orders`)).text();
    assert.ok(html.includes(bb.orderId));
  });
  await check("webhook with a bad signature is rejected", async () => {
    const res = await http(`${URLS.brewbox}/api/webhooks/stripe`, { method: "POST", headers: { "stripe-signature": "t=1,v1=bad", "content-type": "application/json" }, body: "{}" });
    assert.equal(res.status, 400);
  });

  // ---- Quill (Express, inline prices, credit packs) ------------------------------------------------------
  console.log("\nQuill (Express)");
  const email = "writer@quill.test";
  let q = {};
  await check("pricing page lists both packs", async () => {
    const html = await (await http(`${URLS.quill}/`)).text();
    assert.match(html, /Starter/);
    assert.match(html, /Team/);
  });
  await check("pack names that aren't real packs are refused cleanly and create no purchase", async () => {
    for (const pack of ["constructor", "__proto__", "toString", "enterprise"]) {
      const res = await http(`${URLS.quill}/checkout`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form({ pack, email: "probe@quill.test" }) });
      assert.equal(res.status, 400, `pack "${pack}" should be refused`);
      assert.match(await res.text(), /Choose a pack/);
    }
    const acct = await (await http(`${URLS.quill}/api/purchases?email=probe@quill.test`)).json();
    assert.equal(acct.purchases.length, 0);
  });
  await check("checkout redirects to the hosted pay page", async () => {
    const res = await http(`${URLS.quill}/checkout`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form({ pack: "starter", email }) });
    assert.equal(res.status, 303);
    q.payUrl = res.headers.get("location");
    assert.match(q.payUrl, /\/pay\/cs_test_/);
  });
  await check("paying with the test card returns to the account page", async () => {
    const location = await payOnStandin(q.payUrl, email);
    assert.match(location, /\/account\?email=writer%40quill\.test&session_id=cs_test_/);
  });
  await check("signed webhook grants the credits", async () => {
    const acct = await poll(async () => {
      const a = await (await http(`${URLS.quill}/api/purchases?email=${email}`)).json();
      return a.purchases[0]?.status === "paid" ? a : null;
    }, 20_000, "the purchase to be marked paid");
    assert.equal(acct.credits, 100);
    assert.equal(acct.purchases[0].amount, 900);
    q.purchaseId = acct.purchases[0].id;
    const page = await (await http(`${URLS.quill}/account?email=${email}`)).text();
    assert.match(page, /<strong>100<\/strong> credits/);
  });
  await check("refund without the admin token is refused", async () => {
    const res = await http(`${URLS.quill}/admin/refund`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form({ purchaseId: q.purchaseId }) });
    assert.equal(res.status, 401);
  });
  await check("partial refund takes back credits in proportion", async () => {
    const res = await http(`${URLS.quill}/admin/refund`, { method: "POST", headers: { "x-admin-token": "quill-admin", "content-type": "application/x-www-form-urlencoded" }, body: form({ purchaseId: q.purchaseId, amount: "300" }) });
    assert.equal(res.status, 200);
    const acct = await poll(async () => {
      const a = await (await http(`${URLS.quill}/api/purchases?email=${email}`)).json();
      return a.purchases[0].status === "partially_refunded" ? a : null;
    }, 15_000, "the partial refund webhook");
    assert.equal(acct.credits, 67);
  });
  await check("full refund of the remainder takes back the rest", async () => {
    await http(`${URLS.quill}/admin/refund`, { method: "POST", headers: { "x-admin-token": "quill-admin", "content-type": "application/x-www-form-urlencoded" }, body: form({ purchaseId: q.purchaseId }) });
    const acct = await poll(async () => {
      const a = await (await http(`${URLS.quill}/api/purchases?email=${email}`)).json();
      return a.purchases[0].status === "refunded" ? a : null;
    }, 15_000, "the full refund webhook");
    assert.equal(acct.credits, 0);
    assert.equal(acct.purchases[0].refundedAmount, 900);
  });
  await check("webhook with a bad signature is rejected", async () => {
    const res = await http(`${URLS.quill}/webhooks/stripe`, { method: "POST", headers: { "stripe-signature": "t=1,v1=bad", "content-type": "application/json" }, body: "{}" });
    assert.equal(res.status, 400);
  });

  // ---- Standin's own record -------------------------------------------------------------------------------
  console.log("\nStandin");
  await check("every webhook Standin sent was accepted (6 deliveries)", async () => {
    const { data } = await (await http(`${URLS.standin}/_standin/deliveries`)).json();
    const failed = data.filter((d) => !d.ok);
    assert.equal(failed.length, 0, `failed deliveries: ${JSON.stringify(failed)}`);
    assert.equal(data.length, 6, `expected 6 deliveries, got ${data.length}`);
  });
  await check("Standin and both apps listen on localhost only", async () => {
    const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal);
    if (!lan) return; // no network interface to test against
    for (const port of Object.values(PORTS)) {
      const reachable = await fetch(`http://${lan.address}:${port}/`, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
      assert.equal(reachable, false, `port ${port} answered on the network address ${lan.address}`);
    }
  });
} catch (e) {
  console.log(`\nSetup failed: ${e.message}`);
  results.push({ name: "setup", ok: false });
}

const failed = results.filter((r) => !r.ok);
if (failed.length) {
  for (const [name, lines] of Object.entries(logs)) {
    console.log(`\n--- last ${name} log lines ---\n${lines.slice(-25).join("\n")}`);
  }
}
console.log(`\n${results.length - failed.length} of ${results.length} checks passed.`);
exitCode = failed.length ? 1 : 0;
killAll();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(exitCode);
