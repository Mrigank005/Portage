// Checks that the keys in .env work. Prints pass/fail per item and never prints a secret.
// Run: node --env-file=.env scripts/check-setup.mjs
const env = process.env;
const results = [];
const add = (name, ok, detail = "") => results.push({ name, ok, detail });

function present(key) {
  const v = env[key] ?? "";
  return v !== "" && v !== "pk_test_" && v !== "sk_test_";
}

// --- PayPal sandbox ---
if (!present("PAYPAL_CLIENT_ID") || !present("PAYPAL_CLIENT_SECRET")) {
  add("PayPal client ID and secret", false, "missing in .env");
} else if ((env.PAYPAL_ENVIRONMENT ?? "sandbox") !== "sandbox") {
  add("PayPal environment", false, `PAYPAL_ENVIRONMENT is "${env.PAYPAL_ENVIRONMENT}", expected "sandbox"`);
} else {
  try {
    const res = await fetch("https://api-m.sandbox.paypal.com/v1/oauth2/token", {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.access_token) {
      add("PayPal sandbox keys", true, `token issued, expires in ${Math.round(body.expires_in / 3600)} h`);
    } else {
      add("PayPal sandbox keys", false, `${res.status} ${body.error ?? ""} (are these the Sandbox keys, not Live?)`);
    }
  } catch (e) {
    add("PayPal sandbox keys", false, `network error: ${e.message}`);
  }
}
for (const k of ["PAYPAL_SANDBOX_BUSINESS_EMAIL", "PAYPAL_SANDBOX_BUYER_EMAIL"]) {
  add(k, present(k) && /@/.test(env[k]), present(k) ? "" : "missing in .env");
}
for (const k of ["PAYPAL_SANDBOX_BUSINESS_PASSWORD", "PAYPAL_SANDBOX_BUYER_PASSWORD"]) {
  add(k, present(k), present(k) ? "" : "missing in .env");
}

// --- Stripe side: Standin (local, default) or real Stripe test mode ---
const stripeBase = (env.STRIPE_API_BASE || "https://api.stripe.com").replace(/\/+$/, "");
const usingStandin = !/^https:\/\/api\.stripe\.com$/.test(stripeBase);
const stripeLabel = usingStandin ? `Standin (${stripeBase})` : "Stripe test mode";

if (!present("STRIPE_SECRET_KEY")) {
  add("Stripe secret key", false, "missing in .env (use sk_test_standin for Standin)");
} else if (!env.STRIPE_SECRET_KEY.startsWith("sk_test_")) {
  add("Stripe secret key", false, "not a test key (must start with sk_test_). Live keys are never used.");
} else {
  try {
    const res = await fetch(`${stripeBase}/v1/products?limit=100&active=true`, {
      headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
      signal: AbortSignal.timeout(5000),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      const sample = (body.data ?? []).filter((p) => p.metadata?.portage_sample === "brewbox").length;
      add(stripeLabel, true, `${(body.data ?? []).length} products, ${sample} of 3 Brewbox sample products`);
    } else {
      add(stripeLabel, false, `${res.status} ${body.error?.message ?? ""}`);
    }
  } catch (e) {
    if (usingStandin) {
      add(stripeLabel, true, "not running, expected until Standin is built and started");
    } else {
      add(stripeLabel, false, `network error: ${e.message}`);
    }
  }
}
if (present("STRIPE_PUBLISHABLE_KEY") && !env.STRIPE_PUBLISHABLE_KEY.startsWith("pk_test_")) {
  add("Stripe publishable key", false, "not a test key (must start with pk_test_)");
}

// --- Optional / later ---
add("PAYPAL_WEBHOOK_ID (set after the relay is deployed)", true, present("PAYPAL_WEBHOOK_ID") ? "set" : "not set yet, expected");
add("STRIPE_WEBHOOK_SECRET", present("STRIPE_WEBHOOK_SECRET"), present("STRIPE_WEBHOOK_SECRET") ? "set" : "missing (use whsec_standin for Standin)");

const width = Math.max(...results.map((r) => r.name.length));
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  ${r.detail}`);
}
console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
