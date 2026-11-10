// Creates the three Brewbox sample products (with prices) through the Stripe API.
// By default that's Standin, the local Stripe-compatible server (STRIPE_API_BASE=http://localhost:4242);
// with STRIPE_API_BASE unset and a real sk_test_ key it targets Stripe test mode instead.
// Safe to re-run: products that already exist (matched by metadata) are skipped.
// Run: node --env-file=.env scripts/create-stripe-products.mjs
const key = process.env.STRIPE_SECRET_KEY ?? "";
const base = (process.env.STRIPE_API_BASE || "https://api.stripe.com").replace(/\/+$/, "");
if (!key.startsWith("sk_test_") || key === "sk_test_") {
  console.error("STRIPE_SECRET_KEY must be a test key (sk_test_...). For Standin use sk_test_standin.");
  process.exit(1);
}

const PRODUCTS = [
  { slug: "house-blend", name: "House Blend Beans, 1 lb", description: "Medium roast whole beans", cents: 1800 },
  { slug: "ethiopia-12oz", name: "Single Origin Ethiopia, 12 oz", description: "Light roast, floral notes", cents: 2400 },
  { slug: "pour-over-kit", name: "Pour-Over Starter Kit", description: "Dripper, filters and a scale", cents: 4900 },
];

async function stripe(path, { method = "GET", form, idempotencyKey } = {}) {
  let res;
  try {
    res = await fetch(`${base}/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
  } catch (e) {
    throw new Error(`Can't reach ${base}${base.includes("localhost") ? " (is Standin running?)" : ""}: ${e.message}`);
  }
  const body = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${body.error?.message ?? ""}`);
  return body;
}

try {
  console.log(`Target: ${base}`);
  const existing = await stripe("/products?limit=100&active=true");
  for (const p of PRODUCTS) {
    const found = existing.data.find((e) => e.metadata?.portage_sample === "brewbox" && e.metadata?.slug === p.slug);
    if (found) {
      console.log(`exists   ${p.name}  (${found.id})`);
      continue;
    }
    const created = await stripe("/products", {
      method: "POST",
      idempotencyKey: `portage-brewbox-${p.slug}`,
      form: {
        name: p.name,
        description: p.description,
        "default_price_data[currency]": "usd",
        "default_price_data[unit_amount]": String(p.cents),
        "metadata[portage_sample]": "brewbox",
        "metadata[slug]": p.slug,
      },
    });
    console.log(`created  ${p.name}  (${created.id}, $${(p.cents / 100).toFixed(2)})`);
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
