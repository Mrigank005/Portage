// Generates a fresh PayPal SANDBOX access token and stores it as env.PAYPAL_SANDBOX_ACCESS_TOKEN
// in your Claude Code user settings (~/.claude/settings.json), where the PayPal AI-Toolkit plugin reads it.
// Tokens expire after a few hours; re-run this when PayPal tools start returning 401, then restart Claude Code.
// Run: node --env-file=.env scripts/refresh-paypal-token.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { PAYPAL_CLIENT_ID: id, PAYPAL_CLIENT_SECRET: secret, PAYPAL_ENVIRONMENT = "sandbox" } = process.env;
if (!id || !secret) {
  console.error("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set in .env");
  process.exit(1);
}
if (PAYPAL_ENVIRONMENT !== "sandbox") {
  console.error(`Refusing to run: PAYPAL_ENVIRONMENT is "${PAYPAL_ENVIRONMENT}", expected "sandbox"`);
  process.exit(1);
}

const res = await fetch("https://api-m.sandbox.paypal.com/v1/oauth2/token", {
  method: "POST",
  headers: {
    Authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"),
    "Content-Type": "application/x-www-form-urlencoded",
  },
  body: "grant_type=client_credentials",
});
const body = await res.json().catch(() => ({}));
if (!res.ok || !body.access_token) {
  console.error(`PayPal rejected the keys: ${res.status} ${body.error ?? ""}`);
  process.exit(1);
}

const file = path.join(os.homedir(), ".claude", "settings.json");
const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
settings.env = { ...(settings.env ?? {}), PAYPAL_SANDBOX_ACCESS_TOKEN: body.access_token };
fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");

const expires = new Date(Date.now() + body.expires_in * 1000);
console.log(`Saved to ${file}`);
console.log(`Token expires about ${expires.toLocaleString()} (${Math.round(body.expires_in / 3600)} h from now).`);
console.log("Fully quit and reopen Claude Code so the PayPal plugin picks it up.");
