// scan_payment_surface: reads a repository (never writes to it) and reports its Stripe payment surface, the
// framework, and whether Portage can migrate it. Unsupported repos get a clear reason, not a partial run.
import fs from "node:fs";
import path from "node:path";
import { loadMap, ruleForParam } from "../map.ts";
import { paypalExponent, paypalInCountryOnly, stripeExponent } from "../money.ts";
import { routeLabel, type AppScan, type ClientSideUse, type DataField, type EnvVarRef, type Issue, type Loc, type ScanResult, type Trigger } from "../types.ts";
import { clip, envKeys, isCodeFile, isEnvExampleFile, isTestPath, readText, walk, WEB_EXT } from "./files.ts";
import { scanForeign, languageOf } from "./foreign.ts";
import { allDeps, depVersion, detectFramework, readPackageJson } from "./framework.ts";
import { analyzeTypeScript } from "./typescript.ts";

const LANG_BY_EXT: [RegExp, string][] = [
  [/\.(ts|tsx|mts|cts)$/, "TypeScript"],
  [/\.(js|jsx|mjs|cjs)$/, "JavaScript"],
];

export function scanRepo(repoPath: string): ScanResult {
  const started = Date.now();
  const repoRoot = path.resolve(repoPath);
  let isDir = false;
  try {
    isDir = fs.statSync(repoRoot).isDirectory();
  } catch {
    /* handled below */
  }
  if (!isDir) throw new Error(`Not a folder: ${repoPath}`);

  const files = walk(repoRoot);
  const languages: Record<string, number> = {};
  for (const f of files) {
    if (/\.d\.[cm]?ts$/.test(f)) continue;
    const lang = LANG_BY_EXT.find(([re]) => re.test(f))?.[1] ?? languageOf(f);
    if (lang) languages[lang] = (languages[lang] ?? 0) + 1;
  }

  const pkgDirs = new Set(files.filter((f) => f === "package.json" || f.endsWith("/package.json")).map((f) => path.posix.dirname(f)).map((d) => (d === "." ? "" : d)));
  const appRootOf = (rel: string): string => {
    let dir = path.posix.dirname(rel);
    for (;;) {
      const key = dir === "." ? "" : dir;
      if (pkgDirs.has(key)) return key;
      if (key === "") return "";
      dir = path.posix.dirname(dir);
    }
  };

  const textCache = new Map<string, string | null>();
  const textOf = (rel: string) => {
    if (!textCache.has(rel)) textCache.set(rel, readText(path.join(repoRoot, rel)));
    return textCache.get(rel) ?? null;
  };

  const candidates: { rel: string; text: string }[] = [];
  const clientOnlyRoots = new Set<string>();
  const otherLanguages = [];
  for (const rel of files) {
    if (isCodeFile(rel)) {
      const text = textOf(rel);
      if (text && /stripe/i.test(text)) {
        candidates.push({ rel, text });
        if (/from\s+["']@stripe\/|require\(\s*["']@stripe\//.test(text) && !isTestPath(rel)) clientOnlyRoots.add(appRootOf(rel));
      }
    } else if (languageOf(rel)) {
      const text = textOf(rel);
      if (text) otherLanguages.push(...scanForeign(rel, text));
    }
  }

  const ts = analyzeTypeScript({ repoRoot, candidates, appRootOf });
  const roots = new Set<string>([...[...ts.stripeFiles].filter((f) => !isTestPath(f)).map(appRootOf), ...clientOnlyRoots]);

  const rootPkg = readPackageJson(repoRoot);
  const apps: AppScan[] = [];
  for (const root of [...roots].sort()) {
    const inApp = (rel: string) => appRootOf(rel) === root;
    const strip = (rel: string) => (root ? rel.slice(root.length + 1) : rel);
    const appAbs = path.join(repoRoot, root);
    const pkg = readPackageJson(appAbs);
    const appFiles = files.filter(inApp);
    const framework = detectFramework(appAbs, repoRoot, pkg, root ? rootPkg : null, appFiles.map(strip));
    const deps = { ...allDeps(root ? rootPkg : null), ...allDeps(pkg) };
    const own = <T extends Loc>(xs: T[]) => xs.filter((x) => inApp(x.file));

    const clients = own(ts.clients);
    const checkouts = own(ts.checkouts);
    const webhooks = own(ts.webhooks);
    const refunds = own(ts.refunds);
    const calls = own(ts.calls);
    const webFiles = appFiles.filter((f) => WEB_EXT.test(f) && !isTestPath(f));
    const clientSide = findClientSide(webFiles, textOf);
    const triggers = findTriggers(webFiles, textOf, checkouts);
    const dataModel: DataField[] = [...own(ts.dataModel), ...prismaFields(appFiles, textOf)];
    const keyNames = new Set([...clients.map((c) => c.keyEnv), ...webhooks.map((w) => w.secretEnv)].filter(Boolean) as string[]);
    const envVars: EnvVarRef[] = [...ts.envVars]
      .filter(([name]) => /stripe/i.test(name) || keyNames.has(name))
      .map(([name, where]) => ({ name, where: where.filter((l) => inApp(l.file)) }))
      .filter((e) => e.where.length)
      .sort((a, b) => a.name.localeCompare(b.name));
    const envExampleFiles = appFiles.filter(isEnvExampleFile).map((file) => ({ file, keys: envKeys(textOf(file) ?? "") }));

    const app: AppScan = {
      root: root || ".",
      name: pkg?.name ?? (root ? path.posix.basename(root) : path.basename(repoRoot)),
      language: [...ts.stripeFiles].some((f) => inApp(f) && /\.(ts|tsx|mts|cts)$/.test(f)) ? "typescript" : "javascript",
      framework,
      stripeVersion: depVersion(appAbs, repoRoot, "stripe", deps),
      srcDir: appFiles.some((f) => strip(f).startsWith("src/")),
      clients,
      checkouts,
      webhooks,
      refunds,
      calls,
      clientSide,
      triggers,
      dataModel,
      envVars,
      envExampleFiles,
      hardcodedIds: own(ts.hardcodedIds),
      issues: [],
      supported: false,
    };
    app.issues = appIssues(app);
    app.supported = !app.issues.some((i) => i.severity === "blocker");
    apps.push(app);
  }

  const issues: Issue[] = [];
  if (!apps.length) {
    if (otherLanguages.length) {
      const langs = [...new Set(otherLanguages.map((o) => o.language))];
      issues.push({
        code: "LANGUAGE_UNSUPPORTED",
        severity: "blocker",
        message: `This repository uses Stripe from ${langs.join(" and ")}, which Portage doesn't support yet. Portage supports Node.js apps (TypeScript or JavaScript) on Next.js (App Router) and Express. Nothing was changed.`,
        where: otherLanguages.slice(0, 8).map(({ file, line }) => ({ file, line })),
      });
    } else {
      issues.push({
        code: "NO_STRIPE",
        severity: "blocker",
        message: "No Stripe payment code found. Portage adds PayPal to apps that already take payments with Stripe.",
      });
    }
  } else if (otherLanguages.length) {
    const langs = [...new Set(otherLanguages.map((o) => o.language))];
    issues.push({
      code: "OTHER_LANGUAGES",
      severity: "info",
      message: `Stripe is also used from ${langs.join(" and ")}. Portage only changes the Node.js app${apps.length > 1 ? "s" : ""} and leaves that code alone.`,
      where: otherLanguages.slice(0, 5).map(({ file, line }) => ({ file, line })),
    });
  }

  return {
    tool: "portage",
    kind: "scan",
    version: 1,
    repo: { path: repoRoot, name: path.basename(repoRoot) },
    languages,
    apps,
    otherLanguages,
    issues,
    supported: !issues.some((i) => i.severity === "blocker") && apps.some((a) => a.supported),
    stats: { filesSeen: files.length, filesParsed: ts.parsed, ms: Date.now() - started },
  };
}

// ---------------------------------------------------------------------------------------------------------------

const CLIENT_PATTERNS: [RegExp, ClientSideUse["kind"], string][] = [
  [/<(PaymentElement|CardElement|CardNumberElement|ExpressCheckoutElement)\b/, "elements", "renders a Stripe Elements card form"],
  [/elements\.create\(\s*["'`](card|payment|cardNumber|expressCheckout)["'`]/, "elements", "creates a Stripe Elements card form"],
  [/\.confirm(Card)?Payment\(/, "elements", "confirms a payment from a custom card form"],
  [/<EmbeddedCheckout(Provider)?\b|initEmbeddedCheckout\(/, "embedded-checkout", "uses embedded Stripe Checkout"],
  [/\.redirectToCheckout\(/, "redirect-to-checkout", "redirects to Checkout from the browser (Stripe.js)"],
  [/https:\/\/buy\.stripe\.com\//, "payment-link", "links to a Stripe Payment Link"],
  [/from\s+["']@stripe\/stripe-js["']|require\(\s*["']@stripe\/stripe-js["']\)|js\.stripe\.com\/v3/, "stripe-js", "loads Stripe.js"],
];

function findClientSide(files: string[], textOf: (rel: string) => string | null): ClientSideUse[] {
  const out: ClientSideUse[] = [];
  for (const file of files) {
    const text = textOf(file);
    if (!text || !/stripe|Element|Checkout/.test(text)) continue;
    text.split(/\r?\n/).forEach((line, i) => {
      for (const [re, kind, detail] of CLIENT_PATTERNS) {
        if (re.test(line)) {
          out.push({ file, line: i + 1, kind, detail });
          break;
        }
      }
    });
  }
  return out;
}

/** A "use client" directive before any code (comments allowed). */
const USE_CLIENT = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*["']use client["']/;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Where the UI starts a checkout: forms, links and fetch calls that target a checkout route. */
function findTriggers(files: string[], textOf: (rel: string) => string | null, checkouts: AppScan["checkouts"]): Trigger[] {
  const out: Trigger[] = [];
  for (const co of checkouts) {
    if (co.inTest || !co.route) continue;
    const route = co.route;
    const action = route.kind === "next-action";
    // A route is started by its URL; a server action by calling (or passing) the function.
    const re = action ? new RegExp(`\\b${esc(route.path)}\\b`) : new RegExp(`["'\`}=]\\s*${esc(route.path)}(?=["'\`?#])`);
    for (const file of files) {
      if ((route.kind === "next-app" || action) && file === route.file) continue;
      if (action && !/\.[cm]?[jt]sx?$/.test(file)) continue;
      const text = textOf(file);
      if (!text || !text.includes(route.path)) continue;
      text.split(/\r?\n/).forEach((line, i) => {
        if (file === route.file && i + 1 === route.line) return; // the route's own registration
        if (action && /^\s*(import|export)\b/.test(line)) return;
        const m = re.exec(line);
        if (m && !out.some((t) => t.file === file && t.line === i + 1)) {
          // Start the snippet near the match, at the enclosing tag when there is one.
          const tag = line.lastIndexOf("<", m.index);
          const from =
            tag >= 0 && m.index - tag < 120 ? tag : line.trimEnd().length <= 120 ? 0 : line.lastIndexOf(" ", Math.max(0, m.index - 40)) + 1;
          out.push({ file, line: i + 1, target: routeLabel(route), snippet: clip(line.slice(from), 120), clientComponent: USE_CLIENT.test(text) });
        }
      });
    }
  }
  return out;
}

const FIELD_RE = /stripe|payment_?intent|checkout_?session|^session_?id$|charge_?id|^customer_?id$|subscription_?id|price_?id/i;

function prismaFields(files: string[], textOf: (rel: string) => string | null): DataField[] {
  const out: DataField[] = [];
  for (const file of files.filter((f) => f.endsWith(".prisma"))) {
    const text = textOf(file);
    if (!text) continue;
    let entity: string | null = null;
    text.split(/\r?\n/).forEach((line, i) => {
      const m = /^\s*model\s+(\w+)\s*\{/.exec(line);
      if (m) entity = m[1];
      else if (/^\s*\}/.test(line)) entity = null;
      else if (entity) {
        const f = /^\s*(\w+)\s+\w+/.exec(line);
        if (f && FIELD_RE.test(f[1])) out.push({ entity, field: f[1], file, line: i + 1, source: "prisma" });
      }
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------

function appIssues(app: AppScan): Issue[] {
  const map = loadMap();
  const issues: Issue[] = [];
  const at = (x: Loc): Loc => ({ file: x.file, line: x.line });
  const live = <T extends { inTest: boolean }>(xs: T[]) => xs.filter((x) => !x.inTest);
  const checkouts = live(app.checkouts);
  const calls = live(app.calls);

  if (!app.framework.supported) {
    issues.push({
      code: "FRAMEWORK_UNSUPPORTED",
      severity: "blocker",
      message: `${app.framework.label} isn't supported yet. Portage supports Next.js (App Router) and Express apps.`,
    });
  } else if (app.framework.id === "next" && app.framework.router === "pages") {
    issues.push({
      code: "PAGES_ROUTER",
      severity: "needs-human",
      message: "This app uses the Next.js Pages Router, which isn't in Portage's tested set yet (the App Router and Express are). The plan is still made; review the changes closely.",
    });
  }

  const connect = [
    ...calls.filter((c) => c.status === "blocker" && map.calls.find((r) => r.blocker === "STRIPE_CONNECT" && c.path.startsWith(r.stripe.replace(/\*$/, "")))),
    ...checkouts.filter((c) => c.connectOption || Object.keys(c.params).some((k) => ruleForParam(k)?.blocker === "STRIPE_CONNECT")),
  ];
  if (connect.length) {
    issues.push({
      code: "STRIPE_CONNECT",
      severity: "blocker",
      message: "Uses Stripe Connect (money flows to connected accounts). Adding PayPal would bypass the platform's payment splits, so Portage stops here.",
      where: connect.slice(0, 6).map(at),
    });
  }

  const paymentCheckouts = checkouts.filter((c) => c.modes.some((m) => m === "payment" || m === "unspecified" || m === "unknown"));
  const subscriptionCheckouts = checkouts.filter((c) => c.modes.includes("subscription"));
  const elements = app.clientSide.filter((c) => c.kind === "elements");
  const subscriptionCalls = calls.filter((c) => c.role === "subscription");
  if (!paymentCheckouts.length) {
    if (elements.length || calls.some((c) => c.path === "paymentIntents.create")) {
      issues.push({
        code: "ELEMENTS_ONLY",
        severity: "blocker",
        message: "Payments go through a custom card form (Stripe Elements and PaymentIntents), not Stripe Checkout. Custom card forms are out of Portage's scope.",
        where: [...elements, ...calls.filter((c) => c.path === "paymentIntents.create")].slice(0, 6).map(at),
      });
    } else if (subscriptionCheckouts.length || subscriptionCalls.length) {
      issues.push({
        code: "SUBSCRIPTIONS_ONLY",
        severity: "blocker",
        message: "Only subscription billing found. Portage migrates one-time Checkout payments; subscriptions are on its roadmap.",
        where: [...subscriptionCheckouts, ...subscriptionCalls].slice(0, 6).map(at),
      });
    } else {
      issues.push({
        code: "NO_ONE_TIME_CHECKOUT",
        severity: "blocker",
        message: "Found Stripe code, but no Checkout session in payment mode, which is what Portage migrates.",
        where: calls.slice(0, 6).map(at),
      });
    }
  } else {
    if (elements.length) {
      issues.push({ code: "ELEMENTS_STAY", severity: "needs-human", message: "Also has a custom card form (Stripe Elements). Portage leaves it on Stripe.", where: elements.slice(0, 4).map(at) });
    }
    if (subscriptionCheckouts.length || subscriptionCalls.length) {
      issues.push({
        code: "SUBSCRIPTIONS_STAY",
        severity: "needs-human",
        message: "Also sells subscriptions. Portage adds PayPal to one-time payments only and leaves subscriptions on Stripe.",
        where: [...subscriptionCheckouts, ...subscriptionCalls].slice(0, 4).map(at),
      });
    }
  }

  const customUi = paymentCheckouts.filter((c) => /^(custom|elements)$/.test(c.params.ui_mode ?? ""));
  if (customUi.length) {
    issues.push({
      code: "CHECKOUT_CUSTOM_UI",
      severity: "needs-human",
      message: "Checkout runs with `ui_mode` custom/elements: the payment form is built from Stripe Elements in the app's own UI. PayPal buttons sit beside that form; find the client code that renders it.",
      where: customUi.map(at),
    });
  }

  for (const co of checkouts.filter((c) => c.modes.includes("unknown"))) {
    issues.push({ code: "MODE_UNKNOWN", severity: "needs-human", message: "A Checkout session's mode is computed at run time; check whether it can be a one-time payment.", where: [at(co)] });
  }

  const webhooks = live(app.webhooks);
  if (paymentCheckouts.length && !webhooks.length) {
    issues.push({
      code: "NO_WEBHOOK",
      severity: "needs-human",
      message: "No Stripe webhook handler found, so orders may be fulfilled from the success page. Portage still adds a verified PayPal webhook; check where fulfilment happens.",
    });
  }
  for (const w of webhooks.filter((x) => !x.route)) {
    issues.push({ code: "WEBHOOK_ROUTE_UNKNOWN", severity: "needs-human", message: "Couldn't work out which URL this webhook handler is served at.", where: [at(w)] });
  }
  for (const co of paymentCheckouts.filter((c) => !c.route)) {
    issues.push({ code: "CHECKOUT_ROUTE_UNKNOWN", severity: "needs-human", message: "Couldn't work out which route creates this Checkout session.", where: [at(co)] });
  }

  // Money: currencies written in the code.
  const currencies = new Map<string, Loc[]>();
  for (const co of paymentCheckouts) for (const c of co.currencies) currencies.set(c, [...(currencies.get(c) ?? []), at(co)]);
  for (const [cur, where] of currencies) {
    let exp: number | null;
    try {
      exp = paypalExponent(cur);
    } catch {
      continue;
    }
    if (exp === null) {
      issues.push({ code: "CURRENCY_UNSUPPORTED", severity: "needs-human", message: `Charges in ${cur.toUpperCase()}, which PayPal doesn't accept. PayPal buttons can't be offered for these payments.`, where });
    } else if (paypalInCountryOnly(cur)) {
      issues.push({ code: "CURRENCY_IN_COUNTRY", severity: "info", message: `PayPal accepts ${cur.toUpperCase()} only for PayPal accounts in that country.`, where });
    } else if (stripeExponent(cur) > exp) {
      // Prices written into the code can be checked now: 1045 HUF-fillér (10.45 HUF) has no PayPal amount.
      const factor = 10 ** (stripeExponent(cur) - exp);
      const C = cur.toUpperCase();
      for (const co of paymentCheckouts) {
        for (const li of co.lineItems) {
          if (li.currency !== cur || !li.unitAmount || !/^\d+$/.test(li.unitAmount) || Number(li.unitAmount) % factor === 0) continue;
          issues.push({
            code: "CURRENCY_PRECISION",
            severity: "needs-human",
            message: `The price ${li.unitAmount} is ${(Number(li.unitAmount) / 10 ** stripeExponent(cur)).toFixed(stripeExponent(cur))} ${C} in Stripe's minor units, but PayPal only takes whole ${C}. Change the price to a whole amount before offering PayPal for it.`,
            where: [at(co)],
          });
        }
      }
      issues.push({
        code: "CURRENCY_WHOLE_UNITS",
        severity: "info",
        message: `PayPal takes ${cur.toUpperCase()} in whole units, but Stripe amounts have ${stripeExponent(cur)} decimals. Amounts that aren't whole ${cur.toUpperCase()} can't be sent to PayPal; the money helper refuses them instead of rounding.`,
        where,
      });
    }
  }

  // Checkout parameters and Stripe calls the map says need a person.
  const params = new Map<string, Loc[]>();
  for (const co of paymentCheckouts) {
    for (const k of Object.keys(co.params)) {
      const rule = ruleForParam(k);
      if (rule?.status === "needs-human") params.set(k, [...(params.get(k) ?? []), at(co)]);
    }
  }
  for (const [k, where] of params) {
    const rule = ruleForParam(k)!;
    issues.push({ code: "PARAM_NEEDS_HUMAN", severity: "needs-human", message: `Checkout sets \`${k}\`. PayPal: ${rule.paypal ?? "no equivalent"}.${rule.notes ? ` ${rule.notes}` : ""}`, where });
  }
  const byPath = new Map<string, Loc[]>();
  for (const c of calls) if (c.status === "needs-human" || c.status === "unknown") byPath.set(c.path, [...(byPath.get(c.path) ?? []), at(c)]);
  for (const [p, where] of byPath) {
    const c = calls.find((x) => x.path === p)!;
    if (c.status === "unknown") {
      issues.push({ code: "CALL_NOT_IN_MAP", severity: "needs-human", message: `\`${p}\` isn't in Portage's Stripe→PayPal map. Check whether it needs a PayPal equivalent.`, where: where.slice(0, 4) });
    } else if (!(c.role === "subscription" && issues.some((i) => i.code.startsWith("SUBSCRIPTIONS")))) {
      const rule = map.calls.find((r) => r.stripe === p || (r.stripe.endsWith("*") && p.startsWith(r.stripe.slice(0, -1))));
      issues.push({ code: "CALL_NEEDS_HUMAN", severity: "needs-human", message: `\`${p}\`: ${(rule?.paypal ?? "no automatic equivalent").replace(/\.$/, "")}.`, where: where.slice(0, 4) });
    }
  }

  const medium = calls.filter((c) => c.confidence === "medium");
  if (medium.length) {
    issues.push({
      code: "NAME_MATCH_ONLY",
      severity: "info",
      message: `${medium.length} call${medium.length > 1 ? "s were" : " was"} matched by the receiver's name only, not traced back to the stripe package.`,
      where: medium.slice(0, 4).map(at),
    });
  }
  const ids = app.hardcodedIds.filter((h) => !isTestPath(h.file));
  if (ids.length) {
    issues.push({ code: "HARDCODED_IDS", severity: "info", message: `${ids.length} Stripe price or product ID${ids.length > 1 ? "s are" : " is"} written into the code.`, where: ids.slice(0, 4).map(at) });
  }
  // The same place can be found twice (a checkout is also a call); list each place once.
  for (const i of issues) {
    if (i.where) i.where = i.where.filter((w, n, all) => all.findIndex((x) => x.file === w.file && x.line === w.line) === n);
  }
  return issues;
}
