// verify_checkout: proves a PayPal integration works with a real sandbox payment, in a real browser.
//
// 1. Opens the app's checkout page in Chrome or Edge (installed browsers, driven by playwright-core) and clicks the
//    PayPal button: PayPal's JS SDK v6 <paypal-button> or the v5 button iframe, in a popup or a full-page redirect.
// 2. Logs in as the sandbox buyer and approves.
// 3. Checks with PayPal itself (Orders API, through the PayPal Server SDK) that the app captured the order.
// 4. Forwards PayPal's real PAYMENT.CAPTURE.COMPLETED webhook from the relay to the app, then a forged copy, which the
//    app must reject.
// 5. Refunds the capture through PayPal (as a merchant would from the PayPal dashboard), and forwards the
//    PAYMENT.CAPTURE.REFUNDED webhook.
// Sandbox only. Buyer and API credentials are read from the app's env files and never shown.
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Client, Environment, OrdersController, PaymentsController, type Order } from "@paypal/paypal-server-sdk";
import type { Browser, BrowserContext, Locator, Page } from "playwright-core";
import { readEnv } from "./env.ts";
import { deliver, Forwarder, paypalAccessToken, wakeRelay, type Delivery } from "./relay.ts";

export interface VerifyOptions {
  /** The app's folder: env files are read from here, and evidence is written under .portage/ here. */
  appDir: string;
  /** Where the running app is, for example http://127.0.0.1:3000. */
  appUrl: string;
  /** The page with the PayPal button. Default "/". */
  checkoutPath?: string;
  /** The app's PayPal webhook route, for example /api/webhooks/paypal. Without it the webhook checks are skipped. */
  webhookPath?: string;
  /** Which PayPal button on the page, when there are several (0-based). Default 0. */
  buttonIndex?: number;
  /** Form fields to fill before clicking the PayPal button, as CSS selector → value (for example an email the order needs). */
  fill?: Record<string, string>;
  /** Text the app shows after a successful payment, checked on the page the buyer lands on. */
  paidText?: string;
  /** Text the app shows once the order is refunded, checked after the refund webhook. */
  refundedText?: string;
  /** Refund the payment through PayPal and check the refund webhook. Default true. */
  refund?: boolean;
  envFiles?: string[];
  outDir?: string;
  headless?: boolean;
  /** Browser to use. Default: Chrome, then Edge, then Playwright's own Chromium if installed. */
  browser?: "chrome" | "msedge" | "chromium";
}

/** warn: something PayPal's sandbox didn't do in time (late webhooks). It's reported, but doesn't fail the app. */
export type StepStatus = "pass" | "fail" | "warn" | "skip";
export interface VerifyStep {
  name: string;
  status: StepStatus;
  detail: string;
}

export interface VerifyResult {
  ok: boolean;
  appUrl: string;
  steps: VerifyStep[];
  paypalOrderId: string | null;
  captureId: string | null;
  refundId: string | null;
  amount: string | null;
  webhooks: Omit<Delivery, "at">[];
  screenshots: string[];
  outDir: string;
  browser: string | null;
  settingsFrom: Record<string, string>;
  durationMs: number;
  log: string[];
}

const KEYS = [
  "PAYPAL_CLIENT_ID",
  "PAYPAL_CLIENT_SECRET",
  "PAYPAL_ENVIRONMENT",
  "PAYPAL_WEBHOOK_ID",
  "PORTAGE_RELAY_URL",
  "PORTAGE_RELAY_CHANNEL",
  "PAYPAL_SANDBOX_US_BUYER_EMAIL",
  "PAYPAL_SANDBOX_US_BUYER_PASSWORD",
  "PAYPAL_SANDBOX_BUYER_EMAIL",
  "PAYPAL_SANDBOX_BUYER_PASSWORD",
] as const;

export class VerifyError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const where = (u: string) => {
  try {
    const x = new URL(u);
    return x.pathname + x.search;
  } catch {
    return u;
  }
};
const firstLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 300);

function sdkClient(id: string, secret: string) {
  const client = new Client({
    clientCredentialsAuthCredentials: { oAuthClientId: id, oAuthClientSecret: secret },
    environment: Environment.Sandbox,
    timeout: 30_000,
    httpClientOptions: { retryConfig: { maxNumberOfRetries: 2, retryOnTimeout: true, maximumRetryWaitTime: 10, httpMethodsToRetry: ["GET", "POST"] } },
  });
  return { orders: new OrdersController(client), payments: new PaymentsController(client) };
}

async function launch(preferred: VerifyOptions["browser"], headless: boolean): Promise<{ browser: Browser; name: string }> {
  const { chromium } = await import("playwright-core");
  const order = preferred ? [preferred] : (["chrome", "msedge", "chromium"] as const);
  const errors: string[] = [];
  for (const name of order) {
    try {
      const browser = await chromium.launch({ headless, ...(name === "chromium" ? {} : { channel: name }) });
      return { browser, name };
    } catch (err) {
      errors.push(`${name}: ${firstLine(err)}`);
    }
  }
  throw new VerifyError(`No browser could be started. Install Google Chrome or Microsoft Edge, or run \`npx playwright install chromium\`. (${errors.join("; ")})`);
}

/** The PayPal button: JS SDK v6 renders <paypal-button>; v5 renders buttons inside an iframe. */
async function findButton(page: Page, index: number): Promise<{ button: Locator; kind: string }> {
  const v6 = page.locator("paypal-button");
  const v5 = page.frameLocator("iframe[title*='PayPal' i], iframe[name^='__zoid__paypal_buttons']").nth(index).locator("[data-funding-source='paypal']").first();
  const kind = await Promise.race([
    v6.nth(index).waitFor({ state: "visible", timeout: 30_000 }).then(() => "v6"),
    v5.waitFor({ state: "visible", timeout: 30_000 }).then(() => "v5"),
  ]).catch(() => null);
  if (kind === "v6") return { button: v6.nth(index), kind: "JS SDK v6 <paypal-button>" };
  if (kind === "v5") return { button: v5, kind: "JS SDK v5 button iframe" };
  const count = await v6.count();
  throw new VerifyError(count > index ? `A PayPal button exists but never became visible.` : `No PayPal button appeared within 30s (found ${count} <paypal-button> and no PayPal button iframe).`);
}

async function paypalLogin(p: Page, email: string, password: string, log: (m: string) => void): Promise<void> {
  const emailBox = p.locator("input#email, input[name='login_email']").first();
  await emailBox.waitFor({ state: "visible", timeout: 60_000 });
  await emailBox.fill(email);
  // PayPal shows email and password on one page or on two. On the two-page form the password field and Log In button
  // are already in the page, sized but hidden, before Next is clicked, so "visible" can't be trusted for them. Next is
  // the reliable signal: while it shows, click it; once it's gone, log in. (If Next stops responding, try Log In.)
  const pass = p.locator("input#password, input[name='login_password']").first();
  const next = p.locator("button#btnNext");
  const login = p.locator("button#btnLogin");
  const deadline = Date.now() + 90_000;
  let nextClicks = 0;
  while (Date.now() < deadline) {
    const nextShowing = await next.isVisible().catch(() => false);
    if (nextShowing && nextClicks < 5) {
      nextClicks += 1;
      await next.click({ timeout: 5_000 }).catch(() => log("PayPal's Next button wasn't clickable yet"));
      await p.waitForTimeout(1500);
      continue;
    }
    if (await login.isVisible().catch(() => false)) {
      const ok = await pass.fill(password, { timeout: 10_000 }).then(() => login.click({ timeout: 10_000 })).then(() => true, () => false);
      if (ok) return;
      nextClicks = 0;
    }
    await p.waitForTimeout(1000);
  }
  throw new Error("PayPal's login page didn't reach the password step within 90s");
}

/**
 * Whether PayPal generated an event for a resource, from PayPal's webhook events API (REST; the Server SDK has no
 * webhook methods). Tells a PayPal-side delay apart from a delivery problem. null when it can't be checked.
 */
async function paypalHasEvent(id: string, secret: string, eventType: string, resourceId: string): Promise<boolean | null> {
  try {
    const base = "https://api-m.sandbox.paypal.com";
    const token = await paypalAccessToken(base, id, secret);
    const res = await fetch(`${base}/v1/notifications/webhooks-events?page_size=50`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return null;
    const { events } = (await res.json()) as { events?: { event_type?: string; resource?: { id?: string } }[] };
    return (events ?? []).some((e) => e.event_type === eventType && e.resource?.id === resourceId);
  } catch {
    return null;
  }
}

/** Playwright's text match ignores case, so "paid" would also match a "Paid" column header. Match exactly as written. */
const caseSensitive = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

function captureOf(order: Order) {
  const c = order.purchaseUnits?.[0]?.payments?.captures?.[0];
  return c ? { id: c.id ?? null, status: (c.status as string | undefined) ?? null, amount: c.amount ? `${c.amount.value} ${c.amount.currencyCode}` : null } : null;
}

export async function verifyCheckout(opts: VerifyOptions): Promise<VerifyResult> {
  const started = Date.now();
  const appDir = path.resolve(opts.appDir);
  const appUrl = opts.appUrl.replace(/\/$/, "");
  const envFiles = opts.envFiles ?? [".env.local", ".env"];
  const { values: env, from } = readEnv(appDir, envFiles, KEYS);
  const outDir = path.resolve(appDir, opts.outDir ?? path.join(".portage", `verify-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`));
  fs.mkdirSync(outDir, { recursive: true });

  const steps: VerifyStep[] = [];
  const logLines: string[] = [];
  const screenshots: string[] = [];
  const log = (m: string) => logLines.push(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${m}`);
  const step = (name: string, status: StepStatus, detail: string) => {
    steps.push({ name, status, detail });
    log(`${status.toUpperCase()} ${name}: ${detail}`);
  };
  const shot = async (p: Page, name: string) => {
    const file = path.join(outDir, `${String(screenshots.length + 1).padStart(2, "0")}-${name}.png`);
    if (await p.screenshot({ path: file }).then(() => true, () => false)) screenshots.push(path.relative(appDir, file));
  };

  const result: VerifyResult = {
    ok: false,
    appUrl,
    steps,
    paypalOrderId: null,
    captureId: null,
    refundId: null,
    amount: null,
    webhooks: [],
    screenshots,
    outDir: path.relative(appDir, outDir),
    browser: null,
    settingsFrom: Object.fromEntries(Object.entries(from).map(([k, f]) => [k, f === "process environment" ? f : path.relative(appDir, path.resolve(appDir, f as string)).replace(/\\/g, "/")])),
    durationMs: 0,
    log: logLines,
  };

  for (const [name, v] of [["checkoutPath", opts.checkoutPath], ["webhookPath", opts.webhookPath]] as const) {
    if (v && /^[A-Za-z]:[\\/]/.test(v)) {
      throw new VerifyError(`${name} "${v}" is a Windows file path, not a URL path. In Git Bash, set MSYS_NO_PATHCONV=1 (Git Bash rewrites arguments that start with /), or pass it as it appears in the browser, such as /api/webhooks/paypal.`);
    }
  }
  // Settings.
  if (env.PAYPAL_ENVIRONMENT && env.PAYPAL_ENVIRONMENT !== "sandbox") throw new VerifyError("verify_checkout runs only against the PayPal sandbox. Set PAYPAL_ENVIRONMENT=sandbox.");
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) throw new VerifyError(`PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET not found in ${envFiles.join(", ")} or the environment.`);
  const buyer = env.PAYPAL_SANDBOX_US_BUYER_EMAIL && env.PAYPAL_SANDBOX_US_BUYER_PASSWORD
    ? { email: env.PAYPAL_SANDBOX_US_BUYER_EMAIL, password: env.PAYPAL_SANDBOX_US_BUYER_PASSWORD, which: "PAYPAL_SANDBOX_US_BUYER" }
    : env.PAYPAL_SANDBOX_BUYER_EMAIL && env.PAYPAL_SANDBOX_BUYER_PASSWORD
      ? { email: env.PAYPAL_SANDBOX_BUYER_EMAIL, password: env.PAYPAL_SANDBOX_BUYER_PASSWORD, which: "PAYPAL_SANDBOX_BUYER" }
      : null;
  if (!buyer) throw new VerifyError("No sandbox buyer login found. Add PAYPAL_SANDBOX_BUYER_EMAIL and PAYPAL_SANDBOX_BUYER_PASSWORD (a US sandbox personal account works best) to the app's env file.");
  const sdk = sdkClient(env.PAYPAL_CLIENT_ID, env.PAYPAL_CLIENT_SECRET);

  const relayReady = !!(opts.webhookPath && env.PORTAGE_RELAY_URL && env.PORTAGE_RELAY_CHANNEL && env.PAYPAL_WEBHOOK_ID);
  const webhookTarget = opts.webhookPath ? `${appUrl}${opts.webhookPath.startsWith("/") ? "" : "/"}${opts.webhookPath}` : null;
  let forwarder: Forwarder | null = null;
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;

  try {
    // 1. The app is up.
    const checkoutUrl = `${appUrl}${opts.checkoutPath ?? "/"}`;
    // An agent often starts or restarts the app just before calling this, so give it up to 30 seconds to come up.
    let ping: number | string = "no answer";
    for (const until = Date.now() + 30_000; ; ) {
      ping = await fetch(checkoutUrl, { signal: AbortSignal.timeout(30_000) }).then((r) => r.status, (e) => firstLine(e));
      if ((typeof ping === "number" && ping < 500) || Date.now() > until) break;
      await sleep(1000);
    }
    if (typeof ping !== "number" || ping >= 500) {
      step("App is running", "fail", `${checkoutUrl} answered ${ping} for 30 seconds. Start the app first, and check its terminal for errors.`);
      return result;
    }
    step("App is running", "pass", `${checkoutUrl} answered HTTP ${ping}`);

    // 2. Webhook forwarding.
    if (relayReady) {
      try {
        const woke = await wakeRelay(env.PORTAGE_RELAY_URL!);
        forwarder = new Forwarder(env.PORTAGE_RELAY_URL!, env.PORTAGE_RELAY_CHANNEL!, webhookTarget!, log);
        await forwarder.start();
        step("Webhook relay connected", "pass", `${env.PORTAGE_RELAY_URL} (answered in ${(woke / 1000).toFixed(1)}s); forwarding to ${webhookTarget}`);
      } catch (err) {
        forwarder = null;
        step("Webhook relay connected", "fail", firstLine(err));
      }
    } else {
      step(
        "Webhook relay connected",
        "skip",
        !opts.webhookPath ? "No webhookPath given, so webhooks aren't tested." : "PORTAGE_RELAY_URL, PORTAGE_RELAY_CHANNEL or PAYPAL_WEBHOOK_ID is missing: run setup_webhook_relay first, then restart the app.",
      );
    }

    // 3. Browser and the PayPal button.
    const launched = await launch(opts.browser, opts.headless ?? true);
    browser = launched.browser;
    result.browser = launched.name;
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text().split("\n")[0].slice(0, 200));
    });
    page.on("pageerror", (e) => consoleErrors.push(firstLine(e)));
    await page.goto(checkoutUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
    for (const [selector, value] of Object.entries(opts.fill ?? {})) {
      const filled = await page.locator(selector).first().fill(value, { timeout: 15_000 }).then(() => true, () => false);
      if (!filled) {
        await shot(page, "fill-failed");
        step("Checkout form filled", "fail", `No field matches ${selector}`);
        return result;
      }
    }
    if (opts.fill && Object.keys(opts.fill).length) step("Checkout form filled", "pass", Object.keys(opts.fill).join(", "));
    let found: { button: Locator; kind: string };
    try {
      found = await findButton(page, opts.buttonIndex ?? 0);
    } catch (err) {
      await shot(page, "no-paypal-button");
      step("PayPal button is on the page", "fail", `${firstLine(err)}${consoleErrors.length ? ` Browser console errors: ${consoleErrors.slice(0, 3).join(" | ")}` : ""}`);
      return result;
    }
    await shot(page, "checkout-page");
    step("PayPal button is on the page", "pass", `${found.kind}, using button ${(opts.buttonIndex ?? 0) + 1} of ${Math.max(1, await page.locator("paypal-button").count())}`);

    // 4. Click: PayPal opens a popup, or redirects the page.
    const popupPromise = context.waitForEvent("page", { timeout: 30_000 }).catch(() => null);
    await found.button.click();
    const paypalPage = await Promise.race([
      popupPromise,
      page.waitForURL(/paypal\.com/, { timeout: 30_000 }).then(() => page, () => null),
    ]);
    if (!paypalPage) {
      await shot(page, "after-click");
      step("PayPal checkout opens", "fail", `Clicking the button opened no PayPal window.${consoleErrors.length ? ` Browser console errors: ${consoleErrors.slice(0, 3).join(" | ")}` : " Check that the create-order route returns the PayPal order ID."}`);
      return result;
    }
    // The order ID is the token in PayPal's checkout URL. PayPal opens the popup blank and closes it again if the app's
    // create-order route fails, so read the URL defensively.
    const tokenOf = (u: string) => {
      try {
        return new URL(u).searchParams.get("token");
      } catch {
        return null;
      }
    };
    for (let i = 0; i < 60 && !result.paypalOrderId && !paypalPage.isClosed(); i++) {
      result.paypalOrderId = tokenOf(paypalPage.url());
      if (!result.paypalOrderId) await sleep(500);
    }
    await paypalPage.waitForLoadState("domcontentloaded").catch(() => undefined);
    if (!result.paypalOrderId) {
      // Say what the checkout page itself shows: an app usually puts the create-order error next to the button.
      const shown = (await page.locator("[role=alert], .paypal-error, .error").allInnerTexts().catch(() => [] as string[])).map((t) => t.trim()).filter(Boolean);
      if (!paypalPage.isClosed()) await shot(paypalPage, "paypal-window");
      await shot(page, "checkout-after-click");
      step(
        "PayPal checkout opens",
        "fail",
        `${paypalPage === page ? "The page" : "PayPal's popup"} ${paypalPage.isClosed() ? "closed again" : "opened"} without an order ID, so the app's create-order route probably failed.${shown.length ? ` The page shows: "${shown.join(" | ").slice(0, 200)}".` : ""} If the checkout form needs a field (an email, say), pass it with \`fill\`.${consoleErrors.length ? ` Browser console errors: ${consoleErrors.slice(-3).join(" | ")}` : ""}`,
      );
      return result;
    }
    const created = await sdk.orders.getOrder({ id: result.paypalOrderId }).then((r) => r.result, (e) => e);
    if (created instanceof Error) {
      step("PayPal checkout opens", "fail", `PayPal can't find order ${result.paypalOrderId} with this app's credentials: ${firstLine(created)}`);
      return result;
    }
    result.amount = created.purchaseUnits?.[0]?.amount ? `${created.purchaseUnits[0].amount.value} ${created.purchaseUnits[0].amount.currencyCode}` : null;
    step("PayPal checkout opens", "pass", `${paypalPage === page ? "Redirect" : "Popup"} for order ${result.paypalOrderId} (${created.status}, ${result.amount ?? "amount unknown"}), created by the app with its own credentials`);

    // 5. Buyer approves.
    try {
      await paypalLogin(paypalPage, buyer.email, buyer.password, log);
      const pay = paypalPage.locator("button#payment-submit-btn, button[data-testid='submit-button-initial']").first();
      await pay.waitFor({ state: "visible", timeout: 90_000 });
      await paypalPage.waitForTimeout(1500);
      await shot(paypalPage, "paypal-review");
      await pay.click();
      step("Sandbox buyer approves", "pass", `Logged in as ${buyer.which} and approved ${result.amount ?? "the payment"}`);
    } catch (err) {
      await shot(paypalPage, "paypal-login-or-review");
      const body = (await paypalPage.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
      const known = /doesn.t accept payments in your currency/i.test(body)
        ? " PayPal says the seller doesn't accept the buyer's currency: use a US sandbox buyer (PAYPAL_SANDBOX_US_BUYER_EMAIL / _PASSWORD)."
        : /things don.t appear to be working/i.test(body)
          ? " PayPal shows \"Things don't appear to be working\": the order's experience context needs returnUrl and cancelUrl."
          : "";
      step("Sandbox buyer approves", "fail", `${firstLine(err)}${known}`);
      return result;
    }

    // 6. The app captures. Ask PayPal, not the app.
    let capture: ReturnType<typeof captureOf> = null;
    let status = "";
    for (let i = 0; i < 45; i++) {
      await sleep(2000);
      const o = await sdk.orders.getOrder({ id: result.paypalOrderId }).then((r) => r.result, () => null);
      if (!o) continue;
      status = String(o.status);
      capture = captureOf(o);
      if (capture?.id) break;
    }
    if (!capture?.id) {
      await shot(page, "after-approval");
      step("App captures the payment", "fail", `PayPal shows order ${result.paypalOrderId} as ${status || "unknown"} after 90s with no capture. The button's onApprove must call the app's capture route, which calls captureOrder.${consoleErrors.length ? ` Browser console errors: ${consoleErrors.slice(-3).join(" | ")}` : ""}`);
      return result;
    }
    result.captureId = capture.id;
    step("App captures the payment", capture.status === "COMPLETED" || capture.status === "PENDING" ? "pass" : "fail", `PayPal shows capture ${capture.id} ${capture.status} for ${capture.amount}`);

    // 7. The buyer lands on the app's success page.
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
    await sleep(1500);
    if (opts.paidText) {
      const seen = await page.getByText(caseSensitive(opts.paidText)).first().waitFor({ state: "visible", timeout: 30_000 }).then(() => true, () => false);
      await shot(page, "after-payment");
      step("App shows the order as paid", seen ? "pass" : "fail", seen ? `"${opts.paidText}" on ${where(page.url())}` : `"${opts.paidText}" didn't appear on ${where(page.url())} within 30s`);
    } else {
      await shot(page, "after-payment");
      step("App shows the order as paid", "skip", `No paidText given; the buyer landed on ${where(page.url())} (screenshot saved)`);
    }

    // 8. Webhooks. PayPal's sandbox sends PAYMENT.CAPTURE.COMPLETED late, and sometimes not at all, so wait a minute
    // for it, go on to the refund, and look again at the end.
    const capturedAt = Date.now();
    const isCompleted = (d: Delivery) => d.eventType === "PAYMENT.CAPTURE.COMPLETED" && (d.captureId === result.captureId || d.orderId === result.paypalOrderId);
    const isRefunded = (d: Delivery) => d.eventType === "PAYMENT.CAPTURE.REFUNDED" && (d.captureId === result.captureId || (!!result.refundId && d.resourceId === result.refundId));
    const judge = (name: string, d: Delivery) =>
      step(
        name,
        d.ok ? "pass" : "fail",
        d.ok
          ? `Real PayPal event forwarded through the relay; the app verified it with PayPal and answered ${d.status}`
          : `The app answered ${d.status ?? d.error}. If it's 400, verification failed: check that PAYPAL_WEBHOOK_ID matches the relay webhook, that the app was restarted after setup_webhook_relay, and that the route verifies the raw body.`,
      );
    let completedJudged = false;
    if (forwarder) {
      const completed = await forwarder.waitFor(isCompleted, 60_000);
      if (completed) {
        judge("PAYMENT.CAPTURE.COMPLETED webhook", completed);
        completedJudged = true;
      }
    }

    // 9. Refund through PayPal; the app hears about it from the webhook.
    if (opts.refund === false) {
      step("Refund through PayPal", "skip", "refund: false");
    } else if (capture.status !== "COMPLETED") {
      step("Refund through PayPal", "skip", `The capture is ${capture.status}, so it can't be refunded yet`);
    } else {
      try {
        const r = await sdk.payments.refundCapturedPayment({ captureId: capture.id, paypalRequestId: `portage-verify-refund-${capture.id}` });
        result.refundId = r.result.id ?? null;
        step("Refund through PayPal", r.result.status === "COMPLETED" || r.result.status === "PENDING" ? "pass" : "fail", `Refund ${r.result.id} ${r.result.status} (full amount, as a merchant would refund from PayPal)`);
      } catch (err) {
        step("Refund through PayPal", "fail", firstLine(err));
      }
      if (result.refundId && forwarder) {
        const refunded = await forwarder.waitFor(isRefunded, 180_000);
        if (refunded) judge("PAYMENT.CAPTURE.REFUNDED webhook", refunded);
        else step("PAYMENT.CAPTURE.REFUNDED webhook", "warn", `PayPal's sandbox hadn't sent it after 3 minutes${forwarder.lastError ? ` (relay: ${forwarder.lastError})` : ""}.`);
      } else if (result.refundId) {
        step("PAYMENT.CAPTURE.REFUNDED webhook", "skip", "Webhook relay not connected");
      }
      if (result.refundId && opts.refundedText) {
        let seen = false;
        for (let i = 0; i < 3 && !seen; i++) {
          await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
          seen = await page.getByText(caseSensitive(opts.refundedText)).first().waitFor({ state: "visible", timeout: 10_000 }).then(() => true, () => false);
        }
        await shot(page, "after-refund");
        step("App shows the order as refunded", seen ? "pass" : "fail", seen ? `"${opts.refundedText}" on ${where(page.url())}` : `"${opts.refundedText}" didn't appear after the refund webhook`);
      }
      if (result.refundId) {
        const final = await sdk.payments.getCapturedPayment({ captureId: capture.id }).then((r) => String(r.result.status), (e) => `error: ${firstLine(e)}`);
        step("PayPal shows the capture refunded", final === "REFUNDED" ? "pass" : "fail", `Capture ${capture.id} is ${final}`);
      }
    }

    // 10. A late PAYMENT.CAPTURE.COMPLETED, and a forged copy of a real event, which the app must reject.
    if (forwarder) {
      if (!completedJudged) {
        const late = forwarder.deliveries.find(isCompleted) ?? (await forwarder.waitFor(isCompleted, result.refundId ? 15_000 : 120_000));
        if (late) judge("PAYMENT.CAPTURE.COMPLETED webhook", late);
        else {
          const generated = await paypalHasEvent(env.PAYPAL_CLIENT_ID, env.PAYPAL_CLIENT_SECRET, "PAYMENT.CAPTURE.COMPLETED", capture.id);
          step(
            "PAYMENT.CAPTURE.COMPLETED webhook",
            "warn",
            `PayPal's sandbox hadn't sent it ${Math.round((Date.now() - capturedAt) / 1000)}s after the capture. ${
              generated === false
                ? "PayPal's webhook events API has no such event for this capture either, so the delay is on PayPal's side, not the app's."
                : generated
                  ? `PayPal generated it, but it hadn't reached the relay${forwarder.lastError ? ` (relay: ${forwarder.lastError})` : ""}.`
                  : "PayPal's webhook events API couldn't be checked."
            } The app's capture route recorded the payment without it; that's why the plan records payments from both.`,
          );
        }
      }
      const real = forwarder.deliveries.find((d) => d.ok && (isCompleted(d) || isRefunded(d)));
      const original = real && forwarder.events.find((e) => e.seq === real.seq);
      if (real && original) {
        const forgedId = `WH-PORTAGE-FORGED-${randomBytes(6).toString("hex")}`;
        let body = original.body.replace(/"id"\s*:\s*"WH-[^"]+"/, `"id":"${forgedId}"`);
        if (body === original.body) body = original.body.replace(/}\s*$/, ',"portage_forged":true}');
        const forged = await deliver(webhookTarget!, { ...original.headers, "paypal-transmission-id": randomUUID() }, body);
        const rejected = forged.status !== null && (forged.status < 200 || forged.status >= 300);
        step(
          "Forged webhook is rejected",
          rejected ? "pass" : "fail",
          rejected
            ? `A copy of the real ${real.eventType} event with a changed event ID, sent with PayPal's original signature, got HTTP ${forged.status}${forged.status! >= 500 ? " (rejected, though 400 would be clearer than a server error)" : ""}`
            : forged.status === null
              ? `Couldn't reach the app: ${forged.error}`
              : `The app accepted a webhook whose signature doesn't match (HTTP ${forged.status}). It must verify every event with verify-webhook-signature and answer 400 when verification fails.`,
        );
      } else {
        step("Forged webhook is rejected", "skip", "No real, verified PayPal event arrived to make a forged copy of");
      }
    } else {
      step("PAYMENT.CAPTURE.COMPLETED webhook", "skip", "Webhook relay not connected");
      step("Forged webhook is rejected", "skip", "Webhook relay not connected");
    }
    return result;
  } catch (err) {
    step("Unexpected error", "fail", firstLine(err));
    if (context) for (const p of context.pages()) await shot(p, "error");
    return result;
  } finally {
    await forwarder?.stop();
    if (forwarder) result.webhooks = forwarder.deliveries.map(({ at: _at, ...d }) => d);
    await browser?.close().catch(() => undefined);
    result.ok = steps.length > 0 && steps.every((s) => s.status !== "fail");
    result.durationMs = Date.now() - started;
    fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify(result, null, 2));
  }
}

export function renderVerify(r: VerifyResult): string {
  const icon = { pass: "PASS", fail: "FAIL", warn: "WARN", skip: "SKIP" } as const;
  const lines = [
    `# Sandbox checkout test: ${r.ok ? "passed" : "failed"}${r.steps.some((s) => s.status === "warn") ? ` (with ${r.steps.filter((s) => s.status === "warn").length} PayPal sandbox warning${r.steps.filter((s) => s.status === "warn").length > 1 ? "s" : ""})` : ""}`,
    "",
    `App ${r.appUrl}, browser ${r.browser ?? "not started"}, ${(r.durationMs / 1000).toFixed(0)}s. PayPal sandbox only.`,
    "",
    "| | Step | Result |",
    "|---|---|---|",
    ...r.steps.map((s) => `| ${icon[s.status]} | ${s.name} | ${s.detail.replace(/\|/g, "\\|")} |`),
    "",
    `- **PayPal order:** ${r.paypalOrderId ?? "none"}; **capture:** ${r.captureId ?? "none"}; **refund:** ${r.refundId ?? "none"}; **amount:** ${r.amount ?? "unknown"}`,
  ];
  if (r.webhooks.length) lines.push(`- **Webhooks forwarded:** ${r.webhooks.map((w) => `${w.eventType} → ${w.status ?? w.error}`).join("; ")}`);
  lines.push(`- **Evidence:** ${r.outDir} (screenshots and result.json). Keep .portage/ out of git.`);
  if (!r.ok) lines.push("", "Fix the first failing step, restart the app if you changed its settings or server code, and run verify_checkout again.");
  return lines.join("\n");
}
