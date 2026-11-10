// Stripe use in languages Portage doesn't support yet. Found with plain patterns, so the refusal message can say
// exactly what was found and where, instead of just "unsupported".
import type { ForeignStripeUse } from "../types.ts";

interface LangRule {
  language: string;
  ext: RegExp;
  patterns: [RegExp, string][];
}

const RULES: LangRule[] = [
  {
    language: "Python",
    ext: /\.py$/,
    patterns: [
      [/^\s*(import stripe\b|from stripe\b)/, "imports stripe-python"],
      [/\.checkout\.(Session\.create|sessions\.create)\s*\(/, "creates a Checkout session"],
      [/(Webhook\.construct_event|construct_event)\s*\(/, "verifies Stripe webhooks"],
      [/(Refund\.create|\.refunds\.create)\s*\(/, "creates refunds"],
      [/(Subscription\.(create|modify|cancel)|\.subscriptions\.(create|update|cancel))\s*\(/, "manages subscriptions"],
    ],
  },
  {
    language: "Ruby",
    ext: /\.(rb|erb)$/,
    patterns: [
      [/require\s+['"]stripe['"]/, "requires the stripe gem"],
      [/Stripe::Checkout::Session\.create/, "creates a Checkout session"],
      [/Stripe::Webhook\.construct_event/, "verifies Stripe webhooks"],
      [/Stripe::Refund\.create/, "creates refunds"],
    ],
  },
  {
    language: "PHP",
    ext: /\.php$/,
    patterns: [
      [/\\?Stripe\\StripeClient|new\s+StripeClient/, "creates a Stripe client"],
      [/checkout->sessions->create|Checkout\\Session::create/, "creates a Checkout session"],
      [/Webhook::constructEvent/, "verifies Stripe webhooks"],
      [/refunds->create|Refund::create/, "creates refunds"],
    ],
  },
  {
    language: "Go",
    ext: /\.go$/,
    patterns: [
      [/"github\.com\/stripe\/stripe-go/, "imports stripe-go"],
      [/session\.New\(|checkout\/session/, "creates a Checkout session"],
      [/webhook\.ConstructEvent/, "verifies Stripe webhooks"],
    ],
  },
  {
    language: "Java or Kotlin",
    ext: /\.(java|kt)$/,
    patterns: [
      [/import\s+com\.stripe\./, "imports stripe-java"],
      [/Session\.create\(/, "creates a Checkout session"],
      [/Webhook\.constructEvent/, "verifies Stripe webhooks"],
    ],
  },
  {
    language: "C#",
    ext: /\.cs$/,
    patterns: [
      [/using\s+Stripe(\.Checkout)?;/, "uses Stripe.net"],
      [/new\s+SessionService\(/, "creates a Checkout session"],
      [/EventUtility\.ConstructEvent/, "verifies Stripe webhooks"],
    ],
  },
];

export function languageOf(rel: string): string | null {
  return RULES.find((r) => r.ext.test(rel))?.language ?? null;
}

export function scanForeign(rel: string, text: string): ForeignStripeUse[] {
  const rule = RULES.find((r) => r.ext.test(rel));
  if (!rule || !/stripe/i.test(text)) return [];
  const out: ForeignStripeUse[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const [re, what] of rule.patterns) {
      if (re.test(line)) {
        out.push({ language: rule.language, file: rel, line: i + 1, what });
        break;
      }
    }
  });
  return out;
}
