// Structural analysis of TypeScript and JavaScript with ts-morph. Finds Stripe clients, the calls made through them,
// Checkout sessions, webhook handlers, refunds and the app code they hand off to. Nothing here guesses from names
// alone without saying so: a call is "high" confidence when its receiver provably comes from the stripe package
// (directly or through the app's own client module), and "medium" when only the receiver's name suggests Stripe.
import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";
import { Node, Project, SyntaxKind, ts } from "ts-morph";
import type { CallExpression, SourceFile } from "ts-morph";
import { ruleForCall } from "../map.ts";
import type {
  AppCall,
  CheckoutSession,
  ClientSetup,
  Confidence,
  DataField,
  HandledEvent,
  LineItem,
  Loc,
  RefundCall,
  Route,
  StripeCall,
  WebhookHandler,
} from "../types.ts";
import { clip, isTestPath, toPosix } from "./files.ts";

export interface TsFindings {
  clients: ClientSetup[];
  calls: StripeCall[];
  checkouts: CheckoutSession[];
  webhooks: WebhookHandler[];
  refunds: RefundCall[];
  dataModel: DataField[];
  envVars: Map<string, Loc[]>;
  hardcodedIds: (Loc & { id: string })[];
  stripeFiles: Set<string>;
  parsed: number;
}

/** Top-level Stripe resources, used to keep name-only ("medium") matches honest. */
const RESOURCES = new Set(
  (
    "accountLinks accountSessions accounts applePayDomains applicationFees apps balance balanceTransactions billing billingPortal " +
    "charges checkout climate confirmationTokens countrySpecs coupons creditNotes customerSessions customers disputes entitlements " +
    "ephemeralKeys events exchangeRates fileLinks files financialConnections forwarding identity invoiceItems invoices issuing " +
    "mandates paymentIntents paymentLinks paymentMethodConfigurations paymentMethodDomains paymentMethods payouts plans prices " +
    "products promotionCodes quotes radar refunds reporting reviews setupAttempts setupIntents shippingRates sigma sources " +
    "subscriptionItems subscriptionSchedules subscriptions tax taxCodes taxIds taxRates terminal testHelpers tokens topups " +
    "transfers treasury webhookEndpoints webhooks v2"
  ).split(" "),
);

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const ROUTE_METHODS = new Set(["get", "post", "put", "patch", "delete", "all", "use"]);
const FIELD_RE = /stripe|payment_?intent|checkout_?session|^session_?id$|charge_?id|^customer_?id$|subscription_?id|price_?id/i;
const ID_RE = /^(price|prod|plan)_[A-Za-z0-9]{8,}$/;
const BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

const WRAPPERS = new Set([
  SyntaxKind.AwaitExpression,
  SyntaxKind.ParenthesizedExpression,
  SyntaxKind.AsExpression,
  SyntaxKind.NonNullExpression,
  SyntaxKind.TypeAssertionExpression,
  SyntaxKind.SatisfiesExpression,
]);

function unwrap(n: Node): Node {
  while (WRAPPERS.has(n.getKind())) n = (n as unknown as { getExpression(): Node }).getExpression();
  return n;
}

/**
 * `export default function` by syntax alone. ts-morph's isDefaultExport() asks the type checker, which builds a whole
 * program and loads every imported package's types (seconds per scan for a Next.js app).
 */
function isDefaultExported(fd: Node): boolean {
  if (!Node.isFunctionDeclaration(fd)) return false;
  return fd.hasModifier(SyntaxKind.ExportKeyword) && fd.hasModifier(SyntaxKind.DefaultKeyword);
}

/** True when `inner` is `outer` or sits inside it (same file, nested source range). */
function contains(outer: Node, inner: Node): boolean {
  return outer.getSourceFile() === inner.getSourceFile() && outer.getStart() <= inner.getStart() && inner.getEnd() <= outer.getEnd();
}

function chainOf(expr: Node): { root: Node; names: string[] } {
  const names: string[] = [];
  let n = unwrap(expr);
  while (Node.isPropertyAccessExpression(n)) {
    names.unshift(n.getName());
    n = unwrap(n.getExpression());
  }
  return { root: n, names };
}

const literal = (n: Node | undefined): string | undefined => {
  if (!n) return undefined;
  const u = unwrap(n);
  return Node.isStringLiteral(u) || Node.isNoSubstitutionTemplateLiteral(u) ? u.getLiteralText() : undefined;
};

function requireSpec(n: Node): string | undefined {
  const u = unwrap(n);
  if (!Node.isCallExpression(u)) return undefined;
  const callee = u.getExpression();
  if (!Node.isIdentifier(callee) || callee.getText() !== "require") return undefined;
  return literal(u.getArguments()[0]);
}

function props(obj: Node | undefined): Map<string, Node> {
  const out = new Map<string, Node>();
  if (!obj || !Node.isObjectLiteralExpression(obj)) return out;
  for (const p of obj.getProperties()) {
    if (Node.isPropertyAssignment(p)) {
      const init = p.getInitializer();
      if (init) out.set(p.getNameNode().getText().replace(/^["'`]|["'`]$/g, ""), init);
    } else if (Node.isShorthandPropertyAssignment(p)) {
      out.set(p.getName(), p.getNameNode());
    }
  }
  return out;
}

function localInitializer(id: Node): Node | undefined {
  const name = id.getText();
  const decls = id
    .getSourceFile()
    .getDescendantsOfKind(SyntaxKind.VariableDeclaration)
    .filter((d) => d.getName() === name && d.getStart() < id.getStart());
  return decls.at(-1)?.getInitializer();
}

/**
 * Every object literal an identifier is given before `use`: its initializer and any later `name = {...}` assignments
 * (real code builds Checkout params like `params = { ...params, mode: "payment" }` in branches).
 */
function objectsFor(n: Node | undefined, use: Node): Node[] {
  if (!n) return [];
  const u = unwrap(n);
  if (Node.isObjectLiteralExpression(u)) return [u];
  if (!Node.isIdentifier(u)) return [];
  const name = u.getText();
  const scope = enclosingFunction(use) ?? use.getSourceFile();
  const out: Node[] = [];
  const init = localInitializer(u);
  if (init && Node.isObjectLiteralExpression(unwrap(init))) out.push(unwrap(init));
  for (const be of scope.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    if (be.getOperatorToken().getKind() !== SyntaxKind.EqualsToken || be.getLeft().getText() !== name || be.getStart() > use.getStart()) continue;
    const right = unwrap(be.getRight());
    if (Node.isObjectLiteralExpression(right)) out.push(right);
  }
  return out;
}

/** Resolve an identifier argument to the object literal it was declared with, if it was. */
function objectOf(n: Node | undefined): Node | undefined {
  if (!n) return undefined;
  let u = unwrap(n);
  if (Node.isIdentifier(u)) {
    const init = localInitializer(u);
    if (init) u = unwrap(init);
  }
  return Node.isObjectLiteralExpression(u) ? u : undefined;
}

/** Keys of the object literal(s) an expression can evaluate to: follows `a ? {...} : {...}`, `a ?? {...}` and local constants. */
function objectKeys(n: Node | undefined, depth = 0): Map<string, Node> {
  if (!n || depth > 3) return new Map();
  const u = unwrap(n);
  if (Node.isObjectLiteralExpression(u)) return props(u);
  if (Node.isConditionalExpression(u)) return new Map([...objectKeys(u.getWhenTrue(), depth + 1), ...objectKeys(u.getWhenFalse(), depth + 1)]);
  if (Node.isBinaryExpression(u)) return new Map([...objectKeys(u.getLeft(), depth + 1), ...objectKeys(u.getRight(), depth + 1)]);
  if (Node.isIdentifier(u)) return objectKeys(localInitializer(u), depth + 1);
  return new Map();
}

function literalStrings(n: Node | undefined, depth = 0): string[] {
  if (!n || depth > 3) return [];
  const u = unwrap(n);
  const lit = literal(u);
  if (lit !== undefined) return [lit];
  if (Node.isConditionalExpression(u)) return [...literalStrings(u.getWhenTrue(), depth + 1), ...literalStrings(u.getWhenFalse(), depth + 1)];
  if (Node.isIdentifier(u)) return literalStrings(localInitializer(u), depth + 1);
  return [];
}

const valueText = (n: Node | undefined): string => {
  if (!n) return "";
  const lit = literal(n);
  if (lit !== undefined) return lit;
  const u = unwrap(n);
  // A template literal is shown without its backticks: `${origin}/done` reads as ${origin}/done.
  return clip(Node.isTemplateExpression(u) ? u.getText().slice(1, -1) : u.getText(), 100);
};

const envName = (n: Node | undefined): string | undefined => {
  if (!n) return undefined;
  const m = /(?:process\.env|import\.meta\.env|\benv)\.([A-Za-z_][A-Za-z0-9_]*)|process\.env\[\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]\s*\]/.exec(n.getText());
  return m ? (m[1] ?? m[2]) : undefined;
};

type FnNode = Node;

function enclosingFunction(n: Node): FnNode | undefined {
  return n.getFirstAncestor(
    (a) => Node.isFunctionDeclaration(a) || Node.isArrowFunction(a) || Node.isFunctionExpression(a) || Node.isMethodDeclaration(a),
  );
}

function functionName(fn: FnNode | undefined): string | undefined {
  if (!fn) return undefined;
  if (Node.isFunctionDeclaration(fn) || Node.isMethodDeclaration(fn)) return fn.getName();
  const parent = fn.getParent();
  if (parent && Node.isVariableDeclaration(parent)) return parent.getName();
  if (parent && Node.isPropertyAssignment(parent)) return parent.getName();
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// Module resolution, following each file's own tsconfig/jsconfig (so "@/lib/stripe" style aliases resolve).

class Resolver {
  private byDir = new Map<string, ts.CompilerOptions>();
  constructor(private repoRoot: string) {}

  private optionsFor(fileAbs: string): ts.CompilerOptions {
    const visited: string[] = [];
    let dir = path.dirname(fileAbs);
    let found: ts.CompilerOptions | undefined;
    for (;;) {
      const cached = this.byDir.get(dir);
      if (cached) {
        found = cached;
        break;
      }
      visited.push(dir);
      const cfg = ["tsconfig.json", "jsconfig.json"].map((n) => path.join(dir, n)).find((p) => fs.existsSync(p));
      if (cfg) {
        found = parseConfig(cfg);
        break;
      }
      const parent = path.dirname(dir);
      const inside = parent === this.repoRoot || parent.startsWith(this.repoRoot + path.sep);
      if (dir === this.repoRoot || parent === dir || !inside) break;
      dir = parent;
    }
    const opts = found ?? defaultOptions();
    for (const d of visited) this.byDir.set(d, opts);
    return opts;
  }

  /** Absolute path of a local module, or undefined for packages, built-ins and anything unresolvable. */
  resolve(spec: string, fromAbs: string): string | undefined {
    if (BUILTINS.has(spec)) return undefined;
    try {
      const r = ts.resolveModuleName(spec, fromAbs, this.optionsFor(fromAbs), ts.sys).resolvedModule;
      if (r && !r.isExternalLibraryImport && !/[\\/]node_modules[\\/]/.test(r.resolvedFileName) && !/\.d\.[cm]?ts$/.test(r.resolvedFileName)) {
        return path.resolve(r.resolvedFileName);
      }
    } catch {
      /* fall through to the manual resolver */
    }
    if (!spec.startsWith(".")) return undefined;
    const base = path.resolve(path.dirname(fromAbs), spec);
    const candidates = [
      base,
      base.replace(/\.(m|c)?js$/, ".$1ts"),
      base.replace(/\.jsx$/, ".tsx"),
      ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].map((e) => base + e),
      ...[".ts", ".tsx", ".js", ".jsx"].map((e) => path.join(base, `index${e}`)),
    ];
    return candidates.find((c) => {
      try {
        return fs.statSync(c).isFile();
      } catch {
        return false;
      }
    });
  }
}

function defaultOptions(): ts.CompilerOptions {
  return { allowJs: true, moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve };
}

function parseConfig(file: string): ts.CompilerOptions {
  try {
    const read = ts.readConfigFile(file, ts.sys.readFile);
    // readDirectory returns nothing: we only want compiler options, not the file list (slow on big repos).
    const host: ts.ParseConfigHost = { ...ts.sys, useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames, readDirectory: () => [] };
    const parsed = ts.parseJsonConfigFileContent(read.config ?? {}, host, path.dirname(file), undefined, file);
    const opts: ts.CompilerOptions = { ...parsed.options, allowJs: true };
    if (opts.moduleResolution === undefined) {
      opts.moduleResolution = ts.ModuleResolutionKind.Bundler;
      opts.module = ts.ModuleKind.ESNext;
    }
    return opts;
  } catch {
    return defaultOptions();
  }
}

// ---------------------------------------------------------------------------------------------------------------

interface ModuleInfo {
  vars: Set<string>; // top-level bindings holding a Stripe client
  factories: Set<string>; // functions that create (and return) a client
  defaultIsClient: boolean;
  defaultIsFactory: boolean;
}

interface RootInfo {
  confidence: Confidence;
}

interface Found {
  call: CallExpression;
  path: string;
  confidence: Confidence;
}

export function analyzeTypeScript(opts: {
  repoRoot: string;
  candidates: { rel: string; text: string }[];
  appRootOf: (rel: string) => string;
}): TsFindings {
  const { repoRoot, appRootOf } = opts;
  const resolver = new Resolver(repoRoot);
  const project = new Project({
    compilerOptions: { allowJs: true, jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ES2022 },
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    skipLoadingLibFiles: true,
  });
  const relOf = (sf: SourceFile) => toPosix(path.relative(repoRoot, path.resolve(sf.getFilePath())));
  const absOf = (sf: SourceFile) => path.resolve(sf.getFilePath());

  const out: TsFindings = {
    clients: [],
    calls: [],
    checkouts: [],
    webhooks: [],
    refunds: [],
    dataModel: [],
    envVars: new Map(),
    hardcodedIds: [],
    stripeFiles: new Set(),
    parsed: 0,
  };

  const files: SourceFile[] = [];
  for (const c of opts.candidates) {
    files.push(project.createSourceFile(path.join(repoRoot, c.rel), c.text, { overwrite: true }));
  }
  out.parsed = files.length;

  const getFile = (abs: string): SourceFile | undefined => {
    const existing = project.getSourceFile(abs);
    if (existing) return existing;
    try {
      const st = fs.statSync(abs);
      if (st.size > 1_500_000) return undefined;
      out.parsed++;
      return project.createSourceFile(abs, fs.readFileSync(abs, "utf8"), { overwrite: true });
    } catch {
      return undefined;
    }
  };

  // ---- Pass 1: where Stripe clients are created, and which modules export them.
  const stripeNamesOf = new Map<SourceFile, Set<string>>();
  const moduleInfo = new Map<string, ModuleInfo>();

  for (const sf of files) {
    const names = new Set<string>();
    for (const imp of sf.getImportDeclarations()) {
      if (imp.getModuleSpecifierValue() !== "stripe") continue;
      const d = imp.getDefaultImport();
      if (d) names.add(d.getText());
      const ns = imp.getNamespaceImport();
      if (ns) names.add(ns.getText());
    }
    for (const ie of sf.getDescendantsOfKind(SyntaxKind.ImportEqualsDeclaration)) {
      if (/require\(\s*["']stripe["']\s*\)/.test(ie.getModuleReference().getText())) names.add(ie.getName());
    }
    for (const vd of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
      const init = vd.getInitializer();
      if (init && requireSpec(init) === "stripe" && Node.isIdentifier(vd.getNameNode())) names.add(vd.getName());
    }
    stripeNamesOf.set(sf, names);

    const isCreation = (n: Node): boolean => {
      const u = unwrap(n);
      if (Node.isNewExpression(u)) {
        const e = u.getExpression();
        return Node.isIdentifier(e) && (names.has(e.getText()) || e.getText() === "Stripe");
      }
      if (Node.isCallExpression(u)) {
        const e = unwrap(u.getExpression());
        if (Node.isIdentifier(e) && names.has(e.getText())) return true;
        return requireSpec(e) === "stripe";
      }
      return false;
    };
    const containsCreation = (n: Node | undefined): boolean =>
      !!n && (isCreation(n) || n.getDescendants().some((d) => (Node.isNewExpression(d) || Node.isCallExpression(d)) && isCreation(d)));

    const creations = [...sf.getDescendantsOfKind(SyntaxKind.NewExpression), ...sf.getDescendantsOfKind(SyntaxKind.CallExpression)].filter(isCreation);
    if (!creations.length && !names.size) continue;
    out.stripeFiles.add(relOf(sf));

    const info: ModuleInfo = { vars: new Set(), factories: new Set(), defaultIsClient: false, defaultIsFactory: false };
    for (const c of creations) {
      const args = (c as unknown as { getArguments(): Node[] }).getArguments();
      const options = objectKeys(args[1]);
      const bound: string[] = [];
      const holder = c.getFirstAncestor((a) => Node.isVariableDeclaration(a) || Node.isBinaryExpression(a));
      if (holder && Node.isVariableDeclaration(holder) && Node.isIdentifier(holder.getNameNode())) bound.push(holder.getName());
      if (holder && Node.isBinaryExpression(holder) && holder.getOperatorToken().getKind() === SyntaxKind.EqualsToken) {
        const left = holder.getLeft().getText();
        if (/^[A-Za-z_$][\w$]*$/.test(left)) bound.push(left);
      }
      out.clients.push({
        file: relOf(sf),
        line: c.getStartLineNumber(),
        keyEnv: envName(args[0]),
        customHost: options.has("host") || options.has("port") || options.has("protocol"),
        apiVersion: literal(options.get("apiVersion")),
        names: bound,
      });
    }

    for (const vd of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
      const init = vd.getInitializer();
      if (!init || !Node.isIdentifier(vd.getNameNode())) continue;
      const u = unwrap(init);
      if (Node.isArrowFunction(u) || Node.isFunctionExpression(u)) {
        if (containsCreation(u.getBody())) info.factories.add(vd.getName());
      } else if (containsCreation(init)) {
        info.vars.add(vd.getName());
      }
    }
    for (const be of sf.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
      if (be.getOperatorToken().getKind() !== SyntaxKind.EqualsToken || !containsCreation(be.getRight())) continue;
      const left = be.getLeft().getText();
      if (/^[A-Za-z_$][\w$]*$/.test(left)) info.vars.add(left);
      const m = /^(?:module\.)?exports\.([A-Za-z_$][\w$]*)$/.exec(left);
      if (m) info.vars.add(m[1]);
      if (left === "module.exports") info.defaultIsClient = true;
    }
    for (const fd of sf.getFunctions()) {
      const name = fd.getName();
      if (name && containsCreation(fd.getBody())) {
        info.factories.add(name);
        if (isDefaultExported(fd)) info.defaultIsFactory = true;
      }
    }
    for (const ea of sf.getExportAssignments()) {
      const e = unwrap(ea.getExpression());
      if (isCreation(e) || (Node.isIdentifier(e) && info.vars.has(e.getText()))) info.defaultIsClient = true;
      if (Node.isIdentifier(e) && info.factories.has(e.getText())) info.defaultIsFactory = true;
    }
    for (const be of sf.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
      if (be.getLeft().getText() !== "module.exports") continue;
      const right = unwrap(be.getRight());
      if (Node.isIdentifier(right) && info.vars.has(right.getText())) info.defaultIsClient = true;
      if (Node.isIdentifier(right) && info.factories.has(right.getText())) info.defaultIsFactory = true;
    }
    moduleInfo.set(absOf(sf), info);
  }

  // ---- Pass 2 and 3, per file: which identifiers are Stripe clients, then every call made through them.
  for (const sf of files) {
    const rel = relOf(sf);
    const abs = absOf(sf);
    const inTest = isTestPath(rel);
    const appRoot = appRootOf(rel);
    const roots = new Map<string, RootInfo>(); // "v:name" for client values, "f:name" for client factories
    const nsImports = new Map<string, ModuleInfo>();
    const local = moduleInfo.get(abs);
    for (const n of stripeNamesOf.get(sf) ?? []) roots.set(`v:${n}`, { confidence: "high" });
    if (local) {
      for (const v of local.vars) roots.set(`v:${v}`, { confidence: "high" });
      for (const f of local.factories) roots.set(`f:${f}`, { confidence: "high" });
    }
    for (const imp of sf.getImportDeclarations()) {
      const spec = imp.getModuleSpecifierValue();
      if (spec === "stripe") continue;
      const resolved = resolver.resolve(spec, abs);
      const info = resolved ? moduleInfo.get(resolved) : undefined;
      if (!info) continue;
      const d = imp.getDefaultImport()?.getText();
      if (d && info.defaultIsClient) roots.set(`v:${d}`, { confidence: "high" });
      if (d && info.defaultIsFactory) roots.set(`f:${d}`, { confidence: "high" });
      const ns = imp.getNamespaceImport()?.getText();
      if (ns) nsImports.set(ns, info);
      for (const ni of imp.getNamedImports()) {
        const name = ni.getName();
        const as = ni.getAliasNode()?.getText() ?? name;
        if (info.vars.has(name)) roots.set(`v:${as}`, { confidence: "high" });
        if (info.factories.has(name)) roots.set(`f:${as}`, { confidence: "high" });
      }
    }
    for (const vd of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
      const init = vd.getInitializer();
      const spec = init ? requireSpec(init) : undefined;
      if (!spec || spec === "stripe") continue;
      const resolved = resolver.resolve(spec, abs);
      const info = resolved ? moduleInfo.get(resolved) : undefined;
      if (!info) continue;
      const nameNode = vd.getNameNode();
      if (Node.isIdentifier(nameNode)) {
        if (info.defaultIsClient) roots.set(`v:${vd.getName()}`, { confidence: "high" });
        else if (info.defaultIsFactory) roots.set(`f:${vd.getName()}`, { confidence: "high" });
        else nsImports.set(vd.getName(), info);
      } else if (Node.isObjectBindingPattern(nameNode)) {
        for (const el of nameNode.getElements()) {
          const prop = el.getPropertyNameNode()?.getText() ?? el.getName();
          if (info.vars.has(prop)) roots.set(`v:${el.getName()}`, { confidence: "high" });
          if (info.factories.has(prop)) roots.set(`f:${el.getName()}`, { confidence: "high" });
        }
      }
    }

    const classify = (expr: Node): { path: string; confidence: Confidence } | undefined => {
      const { root, names } = chainOf(expr);
      let key: string | undefined;
      let rest = names;
      if (Node.isIdentifier(root)) {
        const ns = nsImports.get(root.getText());
        if (ns && names.length && ns.vars.has(names[0])) {
          return names.length >= 3 ? { path: names.slice(1).join("."), confidence: "high" } : undefined;
        }
        key = `v:${root.getText()}`;
      } else if (Node.isCallExpression(root) && Node.isIdentifier(unwrap(root.getExpression()))) {
        key = `f:${unwrap(root.getExpression()).getText()}`;
      } else if (root.getKind() === SyntaxKind.ThisKeyword && names.length > 1) {
        key = `v:this.${names[0]}`;
        rest = names.slice(1);
      }
      if (!key || rest.length < 2) return undefined;
      const known = roots.get(key);
      if (known) return { path: rest.join("."), confidence: known.confidence };
      const bare = key.slice(2);
      const nameLooksStripe = key.startsWith("v:")
        ? /^(this\.)?_?stripe(Client|Api|Instance|Sdk|Service)?$/i.test(bare)
        : /^(get|create|init|use|make)?Stripe(Client|Instance|Server|Api)?$/i.test(bare);
      if (nameLooksStripe && RESOURCES.has(rest[0])) return { path: rest.join("."), confidence: "medium" };
      return undefined;
    };

    const found: Found[] = [];
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expr = call.getExpression();
      if (!Node.isPropertyAccessExpression(expr)) continue;
      const c = classify(expr);
      if (c) found.push({ call, ...c });
    }
    if (found.length) out.stripeFiles.add(rel);

    const isStripeRoot = (n: Node): boolean => {
      const { root } = chainOf(n);
      if (Node.isIdentifier(root)) return roots.has(`v:${root.getText()}`) || /^stripe$/i.test(root.getText());
      if (Node.isCallExpression(root)) return roots.has(`f:${unwrap(root.getExpression()).getText()}`);
      return false;
    };

    const ctx: FileCtx = { repoRoot, sf, rel, abs, appRoot, resolver, getFile, isStripeRoot, found };

    for (const f of found) {
      const enclosing = functionName(enclosingFunction(f.call));
      let mode: string | undefined;
      let checkout: CheckoutSession | undefined;
      if (f.path === "checkout.sessions.create") {
        checkout = analyzeCheckout(ctx, f.call, inTest);
        mode = checkout.modes.length === 1 ? checkout.modes[0] : undefined;
        out.checkouts.push(checkout);
      }
      const rule = ruleForCall(f.path, mode === "unspecified" ? "payment" : mode);
      out.calls.push({
        file: rel,
        line: f.call.getStartLineNumber(),
        path: f.path,
        snippet: clip(f.call.getText(), 120),
        confidence: f.confidence,
        status: rule?.status ?? "unknown",
        role: rule?.role ?? "other",
        inTest,
        ...(enclosing ? { enclosing } : {}),
      });
      if (f.path === "webhooks.constructEvent" || f.path === "webhooks.constructEventAsync") {
        out.webhooks.push(analyzeWebhook(ctx, f.call, f.path.split(".")[1], inTest));
      }
      if (f.path === "refunds.create") out.refunds.push(analyzeRefund(ctx, f.call, inTest));
    }

    // Environment variables and hard-coded Stripe IDs in this file.
    for (const pa of sf.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
      const t = pa.getExpression().getText();
      if (t !== "process.env" && t !== "import.meta.env") continue;
      addEnv(out.envVars, pa.getName(), { file: rel, line: pa.getStartLineNumber() });
    }
    for (const ea of sf.getDescendantsOfKind(SyntaxKind.ElementAccessExpression)) {
      if (ea.getExpression().getText() !== "process.env") continue;
      const name = literal(ea.getArgumentExpression());
      if (name) addEnv(out.envVars, name, { file: rel, line: ea.getStartLineNumber() });
    }
    for (const lit of [...sf.getDescendantsOfKind(SyntaxKind.StringLiteral), ...sf.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral)]) {
      const v = lit.getLiteralText();
      if (ID_RE.test(v)) out.hardcodedIds.push({ id: v, file: rel, line: lit.getStartLineNumber() });
    }
  }

  // ---- Data model: fields that hold Stripe IDs, in every file we parsed (including the app modules we followed).
  for (const sf of project.getSourceFiles()) {
    const rel = relOf(sf);
    if (isTestPath(rel)) continue;
    const add = (entity: string, field: string, node: Node) => {
      if (FIELD_RE.test(field)) out.dataModel.push({ entity, field, file: rel, line: node.getStartLineNumber(), source: "typescript" });
    };
    for (const i of sf.getInterfaces()) for (const p of i.getProperties()) add(i.getName(), p.getName(), p);
    for (const c of sf.getClasses()) for (const p of c.getProperties()) add(c.getName() ?? "class", p.getName(), p);
    for (const t of sf.getTypeAliases()) {
      const tn = t.getTypeNode();
      if (tn && Node.isTypeLiteral(tn)) for (const p of tn.getProperties()) add(t.getName(), p.getName(), p);
    }
    // Drizzle tables (pgTable("orders", {...})) and Mongoose schemas (new Schema({...})).
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression().getText();
      if (!/^(pg|mysql|sqlite)Table$/.test(callee)) continue;
      const holder = call.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
      const entity = holder?.getName() ?? literal(call.getArguments()[0]) ?? "table";
      for (const [k, v] of props(objectOf(call.getArguments()[1]))) add(entity, k, v);
    }
    for (const ne of sf.getDescendantsOfKind(SyntaxKind.NewExpression)) {
      if (!/(^|\.)Schema$/.test(ne.getExpression().getText())) continue;
      const holder = ne.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
      for (const [k, v] of props(objectOf(ne.getArguments()?.[0]))) add(holder?.getName() ?? "schema", k, v);
    }
  }

  return out;
}

function addEnv(map: Map<string, Loc[]>, name: string, loc: Loc) {
  const list = map.get(name) ?? [];
  if (!list.some((l) => l.file === loc.file && l.line === loc.line)) list.push(loc);
  map.set(name, list);
}

interface FileCtx {
  repoRoot: string;
  sf: SourceFile;
  rel: string;
  abs: string;
  appRoot: string;
  resolver: Resolver;
  getFile: (abs: string) => SourceFile | undefined;
  isStripeRoot: (n: Node) => boolean;
  found: Found[];
}

// ---------------------------------------------------------------------------------------------------------------
// Routes

export function routeFor(node: Node, rel: string, appRoot: string): Route | undefined {
  const inApp = appRoot ? rel.slice(appRoot.length + 1) : rel;
  const line = node.getStartLineNumber();
  let m = /^(?:src\/)?app\/(?:(.*)\/)?route\.[cm]?[jt]sx?$/.exec(inApp);
  if (m) {
    const segs = (m[1] ?? "").split("/").filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith("@"));
    let method = "POST";
    for (const a of node.getAncestors()) {
      const name = Node.isFunctionDeclaration(a) ? a.getName() : Node.isVariableDeclaration(a) ? a.getName() : undefined;
      if (name && HTTP_METHODS.has(name)) {
        method = name;
        break;
      }
    }
    return { kind: "next-app", method, path: `/${segs.join("/")}`, file: rel, line };
  }
  m = /^(?:src\/)?pages\/(api\/.*?)(?:\/index)?\.[cm]?[jt]sx?$/.exec(inApp);
  if (m) {
    const text = node.getSourceFile().getText();
    const method = /method\s*[!=]==?\s*["'`]POST["'`]/.test(text) ? "POST" : "ANY";
    return { kind: "next-pages", method, path: `/${m[1]}`, file: rel, line };
  }
  const action = serverActionName(node);
  if (action) return { kind: "next-action", method: "ACTION", path: action, file: rel, line };
  const reg = expressRegistration(node);
  return reg ? { kind: "express", method: reg.method, path: reg.path, file: rel, line: reg.line } : undefined;
}

const isUseServer = (stmt: Node | undefined) => !!stmt && Node.isExpressionStatement(stmt) && /^["']use server["']$/.test(stmt.getExpression().getText());

/** The exported function a node sits in, when that function is a Next.js server action ("use server"). */
function serverActionName(node: Node): string | undefined {
  const sf = node.getSourceFile();
  const fileLevel = isUseServer(sf.getStatements()[0]);
  let top: Node | undefined;
  for (const a of node.getAncestors()) {
    if (Node.isFunctionDeclaration(a) || Node.isVariableDeclaration(a)) {
      const parent = Node.isVariableDeclaration(a) ? a.getVariableStatement()?.getParent() : a.getParent();
      if (parent === sf) top = a;
    }
  }
  if (!top) return undefined;
  const fn = Node.isVariableDeclaration(top) ? top.getInitializer() : top;
  const body = fn && (Node.isFunctionDeclaration(fn) || Node.isArrowFunction(fn) || Node.isFunctionExpression(fn)) ? fn.getBody() : undefined;
  const inlineDirective = !!body && Node.isBlock(body) && isUseServer(body.getStatements()[0]);
  if (!fileLevel && !inlineDirective) return undefined;
  return (top as Node & { getName(): string | undefined }).getName() ?? undefined;
}

function expressRegistration(node: Node): { method: string; path: string; line: number; call: CallExpression } | undefined {
  const fromCall = (call: CallExpression) => {
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee) || !ROUTE_METHODS.has(callee.getName())) return undefined;
    let p = literal(call.getArguments()[0]);
    if (p === undefined) {
      // router.route("/x").post(handler)
      const inner = unwrap(callee.getExpression());
      if (Node.isCallExpression(inner)) {
        const ie = inner.getExpression();
        if (Node.isPropertyAccessExpression(ie) && ie.getName() === "route") p = literal(inner.getArguments()[0]);
      }
    }
    if (p === undefined || !p.startsWith("/")) return undefined;
    const verb = callee.getName();
    return { method: verb === "use" ? "USE" : verb === "all" ? "ANY" : verb.toUpperCase(), path: p, line: call.getStartLineNumber(), call };
  };
  for (const a of node.getAncestors()) {
    if (Node.isCallExpression(a)) {
      const r = fromCall(a);
      if (r && a.getArguments().some((arg) => contains(arg, node))) return r;
    }
  }
  const name = functionName(enclosingFunction(node));
  if (!name) return undefined;
  for (const call of node.getSourceFile().getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (!call.getArguments().some((a) => Node.isIdentifier(a) && a.getText() === name)) continue;
    const r = fromCall(call);
    if (r) return r;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// Calls into the app's own code (local modules and functions in the same file).

function appCalls(ctx: FileCtx, scope: Node | Node[]): AppCall[] {
  const { sf, abs } = ctx;
  const imports = new Map<string, { spec: string; imported: string }>();
  for (const imp of sf.getImportDeclarations()) {
    const spec = imp.getModuleSpecifierValue();
    const d = imp.getDefaultImport();
    if (d) imports.set(d.getText(), { spec, imported: "default" });
    const ns = imp.getNamespaceImport();
    if (ns) imports.set(ns.getText(), { spec, imported: "*" });
    for (const ni of imp.getNamedImports()) imports.set(ni.getAliasNode()?.getText() ?? ni.getName(), { spec, imported: ni.getName() });
  }
  for (const vd of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const init = vd.getInitializer();
    const spec = init ? requireSpec(init) : undefined;
    if (!spec) continue;
    const nn = vd.getNameNode();
    if (Node.isIdentifier(nn)) imports.set(vd.getName(), { spec, imported: "*" });
    else if (Node.isObjectBindingPattern(nn)) for (const el of nn.getElements()) imports.set(el.getName(), { spec, imported: el.getPropertyNameNode()?.getText() ?? el.getName() });
  }
  const localFns = new Set<string>();
  for (const fd of sf.getFunctions()) if (fd.getName()) localFns.add(fd.getName()!);
  for (const vs of sf.getVariableStatements()) {
    for (const vd of vs.getDeclarations()) {
      const init = vd.getInitializer();
      if (init && (Node.isArrowFunction(unwrap(init)) || Node.isFunctionExpression(unwrap(init)))) localFns.add(vd.getName());
    }
  }

  const scopes = Array.isArray(scope) ? scope : [scope];
  const calls: CallExpression[] = [];
  for (const s of scopes) {
    if (Node.isCallExpression(s)) calls.push(s);
    calls.push(...s.getDescendantsOfKind(SyntaxKind.CallExpression));
  }
  const out: AppCall[] = [];
  for (const call of calls) {
    const e = unwrap(call.getExpression());
    if (ctx.isStripeRoot(e)) continue;
    let name: string | undefined;
    let target: { spec: string; imported: string } | undefined;
    let member: string | undefined;
    if (Node.isIdentifier(e)) {
      name = e.getText();
      target = imports.get(name);
      if (!target && !localFns.has(name)) continue;
    } else if (Node.isPropertyAccessExpression(e) && Node.isIdentifier(e.getExpression())) {
      const imp = imports.get(e.getExpression().getText());
      if (!imp || (imp.imported !== "*" && imp.imported !== "default")) continue;
      name = e.getText();
      target = imp;
      member = e.getName();
    } else continue;
    if (out.some((o) => o.name === name)) continue;

    if (!target) {
      out.push({ name, line: call.getStartLineNumber(), definedIn: definitionIn(sf, name), params: paramsIn(sf, name) });
      continue;
    }
    const resolved = ctx.resolver.resolve(target.spec, abs);
    if (!resolved) continue; // a package, not the app's own code
    const file = ctx.getFile(resolved);
    const lookup = member ?? target.imported;
    out.push({
      name,
      line: call.getStartLineNumber(),
      module: target.spec,
      ...(file ? { definedIn: definitionIn(file, lookup), params: paramsIn(file, lookup) } : {}),
    });
  }
  return fixDefs(ctx, out);
}

function declOf(sf: SourceFile, name: string): Node | undefined {
  if (name === "default") return sf.getFunctions().find(isDefaultExported);
  const fn = sf.getFunction(name);
  if (fn) return fn;
  const vd = sf.getVariableDeclaration(name);
  if (vd) return vd;
  return undefined;
}

function definitionIn(sf: SourceFile, name: string): Loc | undefined {
  const d = declOf(sf, name);
  if (!d) return undefined;
  const repoRel = sf.getFilePath();
  return { file: repoRel, line: d.getStartLineNumber() };
}

function paramsIn(sf: SourceFile, name: string): string | undefined {
  const d = declOf(sf, name);
  if (!d) return undefined;
  let fn: Node | undefined = d;
  if (Node.isVariableDeclaration(d)) fn = d.getInitializer() ? unwrap(d.getInitializer()!) : undefined;
  if (fn && (Node.isFunctionDeclaration(fn) || Node.isArrowFunction(fn) || Node.isFunctionExpression(fn))) {
    return clip(fn.getParameters().map((p) => p.getText()).join(", "), 200);
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// Checkout sessions

function lineItemsOf(node: Node | undefined): LineItem[] {
  if (!node) return [];
  let n = unwrap(node);
  if (Node.isIdentifier(n)) {
    const init = localInitializer(n);
    if (init) n = unwrap(init);
  }
  const itemOf = (el: Node, dynamic: boolean): LineItem => {
    const o = objectOf(el);
    if (!o) return { kind: "dynamic", expr: clip(el.getText(), 80) };
    const p = props(o);
    const quantity = p.has("quantity") ? valueText(p.get("quantity")) : undefined;
    const pd = p.get("price_data");
    if (pd) {
      const d = props(objectOf(pd));
      const product = props(objectOf(d.get("product_data")));
      return {
        kind: "price_data",
        currency: literal(d.get("currency"))?.toLowerCase(),
        unitAmount: d.has("unit_amount") ? valueText(d.get("unit_amount")) : d.has("unit_amount_decimal") ? valueText(d.get("unit_amount_decimal")) : undefined,
        productName: product.has("name") ? valueText(product.get("name")) : undefined,
        quantity,
        ...(dynamic ? { expr: "built dynamically" } : {}),
      };
    }
    if (p.has("price")) {
      const lit = literal(p.get("price"));
      return { kind: "price", ...(lit ? { priceId: lit } : { expr: valueText(p.get("price")) }), quantity };
    }
    return { kind: "dynamic", expr: clip(el.getText(), 80) };
  };
  if (Node.isArrayLiteralExpression(n)) return n.getElements().map((el) => itemOf(el, false));
  const objs = n
    .getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)
    .filter((o) => props(o).has("price") || props(o).has("price_data"));
  if (objs.length) return objs.slice(0, 3).map((o) => itemOf(o, true));
  return [{ kind: "dynamic", expr: clip(n.getText(), 80) }];
}

function resultVar(call: Node): string | undefined {
  let n: Node = call;
  let parent = n.getParent();
  while (parent && WRAPPERS.has(parent.getKind())) {
    n = parent;
    parent = n.getParent();
  }
  if (parent && Node.isVariableDeclaration(parent) && Node.isIdentifier(parent.getNameNode())) return parent.getName();
  if (parent && Node.isBinaryExpression(parent) && parent.getOperatorToken().getKind() === SyntaxKind.EqualsToken) return parent.getLeft().getText();
  return undefined;
}

function analyzeCheckout(ctx: FileCtx, call: CallExpression, inTest: boolean): CheckoutSession {
  const args = call.getArguments();
  const objects = objectsFor(args[0], call);
  // Later assignments add to (or override) earlier ones; every literal mode any of them sets is possible.
  const p = new Map<string, Node>();
  for (const o of objects) for (const [k, v] of props(o)) p.set(k, v);
  const modeValues = objects.flatMap((o) => (props(o).has("mode") ? literalStrings(props(o).get("mode")) : []));
  const modeSet = objects.some((o) => props(o).has("mode"));
  const params: Record<string, string> = {};
  for (const [k, v] of p) {
    if (k === "line_items") continue;
    params[k] = valueText(v);
    if (k === "payment_intent_data" || k === "subscription_data") {
      for (const [k2, v2] of props(objectOf(v))) params[`${k}.${k2}`] = valueText(v2);
    }
  }
  const modes = modeSet ? (modeValues.length ? modeValues : ["unknown"]) : ["unspecified"];
  const lineItems = lineItemsOf(p.get("line_items"));
  const reqOpts = props(objectOf(args[1]));
  const fn = enclosingFunction(call);
  const scope: Node = fn ?? ctx.sf;
  const sessionVar = resultVar(call);

  let response: CheckoutSession["response"] = "unknown";
  const stored: CheckoutSession["sessionIdStoredAs"] = [];
  if (sessionVar) {
    const uses = scope.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression).filter((pa) => pa.getExpression().getText() === sessionVar);
    const inCall = (n: Node, re: RegExp) => n.getAncestors().some((a) => Node.isCallExpression(a) && re.test(a.getExpression().getText()));
    if (uses.some((u) => u.getName() === "client_secret")) response = "client-secret";
    else if (uses.some((u) => u.getName() === "url")) response = uses.some((u) => u.getName() === "url" && inCall(u, /redirect/i)) ? "redirect" : uses.some((u) => u.getName() === "url" && inCall(u, /json|send/i)) ? "json-url" : "redirect";
    else if (uses.some((u) => u.getName() === "id" && inCall(u, /json|send/i))) response = "json-id";
    for (const pa of scope.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
      const init = pa.getInitializer();
      if (!init || unwrap(init).getText() !== `${sessionVar}.id`) continue;
      const holder = pa.getFirstAncestorByKind(SyntaxKind.CallExpression);
      stored.push({ call: holder ? clip(holder.getExpression().getText(), 60) : "object", field: pa.getName(), line: pa.getStartLineNumber() });
    }
  }
  const successUrl = p.has("success_url") ? valueText(p.get("success_url")) : undefined;
  const currencies = new Set<string>();
  for (const li of lineItems) if (li.currency) currencies.add(li.currency);
  const cur = literal(p.get("currency"));
  if (cur) currencies.add(cur.toLowerCase());

  return {
    file: ctx.rel,
    line: call.getStartLineNumber(),
    route: routeFor(call, ctx.rel, ctx.appRoot),
    modes: modes.length ? [...new Set(modes)] : ["unknown"],
    lineItems,
    params,
    idempotencyKey: reqOpts.has("idempotencyKey"),
    connectOption: reqOpts.has("stripeAccount"),
    successUrl,
    cancelUrl: p.has("cancel_url") ? valueText(p.get("cancel_url")) : undefined,
    usesSessionIdPlaceholder: !!successUrl?.includes("{CHECKOUT_SESSION_ID}"),
    response,
    ...(sessionVar ? { sessionVar } : {}),
    sessionIdStoredAs: stored,
    appCalls: fixDefs(ctx, appCalls(ctx, scope)),
    currencies: [...currencies],
    inTest,
  };
}

/** definedIn paths come back absolute from ts-morph; make them repo-relative like everything else. */
function fixDefs(ctx: FileCtx, calls: AppCall[]): AppCall[] {
  return calls.map((c) =>
    c.definedIn && path.isAbsolute(c.definedIn.file)
      ? { ...c, definedIn: { file: toPosix(path.relative(ctx.repoRoot, path.resolve(c.definedIn.file))), line: c.definedIn.line } }
      : c,
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Webhooks

function analyzeWebhook(ctx: FileCtx, call: CallExpression, verify: string, inTest: boolean): WebhookHandler {
  const args = call.getArguments();
  const fn = enclosingFunction(call);
  const scope: Node = fn ?? ctx.sf;
  const fnText = scope.getText();
  const fileText = ctx.sf.getText();
  const route = routeFor(call, ctx.rel, ctx.appRoot);

  let rawBody = "unknown";
  if (/\.text\(\)/.test(fnText)) rawBody = "request.text()";
  else if (/\.arrayBuffer\(\)/.test(fnText)) rawBody = "request.arrayBuffer()";
  else if (/\bbuffer\(\s*req\b/.test(fnText) || /\braw-body\b|getRawBody\(/.test(fileText)) rawBody = "raw body helper";
  else if (/rawBody/.test(fnText)) rawBody = "req.rawBody";
  if (rawBody === "unknown" || rawBody === "req.rawBody") {
    const reg = expressRegistration(call);
    if (reg && /\b(express|bodyParser)\.raw\(/.test(reg.call.getText())) rawBody = "express.raw()";
    else if (/\b(express|bodyParser)\.raw\(/.test(fileText)) rawBody = "express.raw()";
    else if (/bodyParser\s*:\s*false/.test(fileText)) rawBody = "bodyParser: false";
  }

  // Which event types the handler branches on, and what each branch does.
  const events: HandledEvent[] = [];
  const objVars = new Set<string>();
  for (const vd of scope.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const init = vd.getInitializer();
    if (init && /\.data\.object\b/.test(init.getText()) && Node.isIdentifier(vd.getNameNode())) objVars.add(vd.getName());
  }
  const fieldsIn = (nodes: Node[]): string[] => {
    const fields = new Set<string>();
    const localObj = new Set(objVars);
    for (const n of nodes) {
      for (const vd of n.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
        const init = vd.getInitializer();
        if (init && /\.data\.object\b/.test(init.getText()) && Node.isIdentifier(vd.getNameNode())) localObj.add(vd.getName());
      }
    }
    for (const n of nodes) {
      for (const pa of n.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
        const parent = pa.getParent();
        if (parent && Node.isPropertyAccessExpression(parent) && parent.getExpression() === pa) continue;
        const { root, names } = chainOf(pa);
        if (!Node.isIdentifier(root)) continue;
        if (localObj.has(root.getText())) fields.add(names.join("."));
        else if (names[0] === "data" && names[1] === "object" && names.length > 2) fields.add(names.slice(2).join("."));
      }
    }
    return [...fields].sort();
  };
  const stripeCallsIn = (nodes: Node[]): string[] =>
    ctx.found.filter((f) => nodes.some((n) => contains(n, f.call))).map((f) => f.path);
  const addEvent = (type: string, line: number, nodes: Node[]) => {
    if (!/^[a-z_]+(\.[a-z_]+)+$/.test(type) || events.some((e) => e.type === type)) return;
    events.push({ type, line, appCalls: fixDefs(ctx, appCalls(ctx, nodes)), stripeCalls: stripeCallsIn(nodes), fieldsRead: fieldsIn(nodes) });
  };
  // `event.type`, or a variable copied from it (`const eventType = event.type`), as Stripe's own samples do.
  const isTypeExpr = (n: Node) => {
    const u = unwrap(n);
    if (/(^|\.)type$/.test(u.getText())) return true;
    if (!Node.isIdentifier(u)) return false;
    const init = localInitializer(u);
    if (init && /\.type$/.test(unwrap(init).getText())) return true;
    // `let eventType; ... eventType = event.type;`
    return scope
      .getDescendantsOfKind(SyntaxKind.BinaryExpression)
      .some((be) => be.getOperatorToken().getKind() === SyntaxKind.EqualsToken && be.getLeft().getText() === u.getText() && /\.type$/.test(unwrap(be.getRight()).getText()));
  };

  for (const sw of scope.getDescendantsOfKind(SyntaxKind.SwitchStatement)) {
    if (!isTypeExpr(sw.getExpression())) continue;
    let pending: { type: string; line: number }[] = [];
    for (const clause of sw.getClauses()) {
      if (Node.isCaseClause(clause)) {
        const t = literal(clause.getExpression());
        if (t) pending.push({ type: t, line: clause.getStartLineNumber() });
        const stmts = clause.getStatements();
        if (stmts.length) {
          for (const p of pending) addEvent(p.type, p.line, stmts);
          pending = [];
        }
      } else pending = [];
    }
  }
  for (const ifs of scope.getDescendantsOfKind(SyntaxKind.IfStatement)) {
    const types: string[] = [];
    const cond = ifs.getExpression();
    for (const be of [cond, ...cond.getDescendantsOfKind(SyntaxKind.BinaryExpression)]) {
      if (!Node.isBinaryExpression(be)) continue;
      const op = be.getOperatorToken().getKind();
      if (op !== SyntaxKind.EqualsEqualsEqualsToken && op !== SyntaxKind.EqualsEqualsToken) continue;
      const [l, r] = [be.getLeft(), be.getRight()];
      const t = isTypeExpr(l) ? literal(r) : isTypeExpr(r) ? literal(l) : undefined;
      if (t) types.push(t);
    }
    for (const t of types) addEvent(t, ifs.getStartLineNumber(), [ifs.getThenStatement()]);
  }
  // Handler tables: { "checkout.session.completed": handleCompleted, ... }
  for (const pa of ctx.sf.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
    const key = pa.getNameNode().getText().replace(/^["'`]|["'`]$/g, "");
    if (!/^[a-z_]+(\.[a-z_]+)+$/.test(key) || !/^["'`]/.test(pa.getNameNode().getText())) continue;
    const init = pa.getInitializer();
    if (!init) continue;
    let body: Node = init;
    if (Node.isIdentifier(init)) body = (declOf(ctx.sf, init.getText()) as Node | undefined) ?? init;
    addEvent(key, pa.getStartLineNumber(), [body]);
  }

  return {
    file: ctx.rel,
    line: call.getStartLineNumber(),
    route,
    verify,
    rawBody,
    secretEnv: envName(args[2]),
    events: events.sort((a, b) => a.line - b.line),
    inTest,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Refunds

function analyzeRefund(ctx: FileCtx, call: CallExpression, inTest: boolean): RefundCall {
  const obj = objectOf(call.getArguments()[0]);
  const p = props(obj);
  const by: RefundCall["by"] = p.has("payment_intent") ? "payment_intent" : p.has("charge") ? "charge" : "unknown";
  const src = by === "unknown" ? undefined : unwrap(p.get(by)!).getText();
  const spreadsAmount = !!obj && Node.isObjectLiteralExpression(obj) && obj.getProperties().some((pr) => Node.isSpreadAssignment(pr) && /\bamount\b/.test(pr.getText()));
  const field = src ? /\.([A-Za-z_$][\w$]*)$/.exec(src)?.[1] : undefined;
  return {
    file: ctx.rel,
    line: call.getStartLineNumber(),
    route: routeFor(call, ctx.rel, ctx.appRoot),
    by,
    ...(src ? { source: clip(src, 80) } : {}),
    ...(field ? { sourceField: field } : {}),
    partial: p.has("amount") || spreadsAmount,
    inTest,
  };
}
