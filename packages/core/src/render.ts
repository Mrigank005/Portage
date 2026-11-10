// Markdown versions of a scan and a plan: what the developer reads before approving anything.
import { routeLabel, type AppScan, type Issue, type Loc, type Plan, type ScanResult } from "./types.ts";

const loc = (l: Loc) => `${l.file}:${l.line}`;
const code = (s: string) => `\`${s.replace(/`/g, "'")}\``;
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

function issueList(issues: Issue[]): string[] {
  return issues.map((i) => `- **${i.code}**: ${i.message}${i.where?.length ? ` (${i.where.map(loc).join(", ")})` : ""}`);
}

export function renderScan(scan: ScanResult): string {
  const out: string[] = [];
  out.push(`# Portage scan: ${scan.repo.name}`, "");
  const blocker = [...scan.issues, ...scan.apps.flatMap((a) => a.issues)].find((i) => i.severity === "blocker");
  out.push(scan.supported ? "**Result: supported.** Portage can plan this migration." : `**Result: not supported.** ${blocker?.message ?? ""}`, "");
  const langs = Object.entries(scan.languages).sort((a, b) => b[1] - a[1]);
  if (langs.length) out.push(`Files by language: ${langs.map(([l, n]) => `${l} ${n}`).join(" · ")}`, "");
  if (scan.issues.length) out.push(...issueList(scan.issues), "");
  if (scan.otherLanguages.length && !scan.apps.length) {
    out.push("## Stripe code found", "", "| Where | What |", "|---|---|");
    for (const o of scan.otherLanguages.slice(0, 20)) out.push(`| ${loc(o)} | ${o.language}: ${o.what} |`);
    out.push("", "Nothing was changed.", "");
  }
  for (const app of scan.apps) out.push(...renderApp(app));
  // Timing is left out when it's zeroed, so published reports are byte-for-byte reproducible.
  const timing = scan.stats.ms > 0 ? `, in ${scan.stats.ms} ms` : "";
  out.push(`_Scanned ${scan.stats.filesSeen} files, parsed ${scan.stats.filesParsed}${timing}. The scan only reads files; it never changes the repository, and it never reads real env files._`);
  return out.join("\n");
}

function renderApp(app: AppScan): string[] {
  const out: string[] = [];
  const live = <T extends { inTest: boolean }>(xs: T[]) => xs.filter((x) => !x.inTest);
  out.push(`## ${app.name}${app.root !== "." ? ` (${app.root})` : ""}`, "");
  out.push(
    `${app.framework.label} · ${app.language === "typescript" ? "TypeScript" : "JavaScript"}${app.stripeVersion ? ` · stripe ${app.stripeVersion}` : ""} · ${app.supported ? "**supported**" : "**not supported**"}`,
    "",
  );
  const rows: [string, string, string][] = [];
  for (const c of app.clients) {
    rows.push(["Stripe client", loc(c), [c.keyEnv ? `key from ${code(c.keyEnv)}` : "", c.customHost ? "custom API host (for example Standin or stripe-mock)" : "", c.apiVersion ? `API version ${c.apiVersion}` : ""].filter(Boolean).join("; ")]);
  }
  for (const co of live(app.checkouts)) {
    const items = co.lineItems.map((l) => (l.kind === "price" ? `price ${l.priceId ?? code(l.expr ?? "?")}` : l.kind === "price_data" ? `inline price ${l.unitAmount ?? "?"} ${l.currency?.toUpperCase() ?? ""}`.trim() : `dynamic ${code(l.expr ?? "")}`));
    rows.push([
      `Checkout${co.route ? ` ${code(`${routeLabel(co.route)}`)}` : ""}`,
      loc(co),
      [
        `mode ${co.modes.join(" or ")}`,
        items.join(", "),
        co.params.client_reference_id ? `reference ${code(co.params.client_reference_id)}` : "",
        co.usesSessionIdPlaceholder ? "success URL uses {CHECKOUT_SESSION_ID}" : "",
        co.response !== "unknown" ? `responds with ${co.response}` : "",
        co.sessionIdStoredAs.length ? `session ID stored as ${co.sessionIdStoredAs.map((s) => code(s.field)).join(", ")}` : "",
      ].filter(Boolean).join("; "),
    ]);
  }
  for (const w of live(app.webhooks)) {
    const evs = w.events.map((e) => `${code(e.type)}${e.appCalls.length ? ` → ${e.appCalls.map((c) => c.name + (c.definedIn ? ` (${loc(c.definedIn)})` : "")).join(", ")}` : ""}`);
    rows.push([
      `Webhook${w.route ? ` ${code(`${routeLabel(w.route)}`)}` : ""}`,
      loc(w),
      [`verified with ${w.verify}`, `raw body via ${w.rawBody}`, w.secretEnv ? `secret ${code(w.secretEnv)}` : "", evs.length ? `handles ${evs.join("; ")}` : "no event branches found"].filter(Boolean).join("; "),
    ]);
  }
  for (const r of live(app.refunds)) {
    rows.push([`Refund${r.route ? ` ${code(`${routeLabel(r.route)}`)}` : ""}`, loc(r), `by ${r.by}${r.source ? ` from ${code(r.source)}` : ""}${r.partial ? "; partial amounts" : ""}`]);
  }
  for (const t of app.triggers) rows.push(["Checkout button", loc(t), `${code(t.target)}: ${code(t.snippet)}`]);
  for (const c of app.clientSide) rows.push(["Browser", loc(c), c.detail]);
  const seenEntity = new Set<string>();
  for (const d of app.dataModel) {
    const key = `${d.file}#${d.entity}`;
    if (seenEntity.has(key)) continue;
    seenEntity.add(key);
    const fields = app.dataModel.filter((x) => x.file === d.file && x.entity === d.entity).map((x) => code(x.field));
    rows.push(["Stored Stripe IDs", loc(d), `${d.entity}: ${fields.join(", ")}`]);
  }
  if (app.envVars.length) rows.push(["Settings", "", app.envVars.map((e) => code(e.name)).join(", ")]);
  if (rows.length) {
    out.push("| What | Where | Details |", "|---|---|---|");
    for (const [a, b, c] of rows) out.push(`| ${cell(a)} | ${cell(b)} | ${cell(c)} |`);
    out.push("");
  }
  const calls = live(app.calls);
  if (calls.length) {
    const byPath = new Map<string, typeof calls>();
    for (const c of calls) byPath.set(c.path, [...(byPath.get(c.path) ?? []), c]);
    out.push(`### Stripe calls (${calls.length})`, "", "| Call | Where | Portage |", "|---|---|---|");
    for (const [p, cs] of byPath) {
      out.push(`| ${code(p)} | ${cs.slice(0, 3).map(loc).join(", ")}${cs.length > 3 ? ` +${cs.length - 3}` : ""} | ${cs[0].status}${cs.some((c) => c.confidence === "medium") ? " (name match)" : ""} |`);
    }
    out.push("");
  }
  const blockers = app.issues.filter((i) => i.severity === "blocker");
  const human = app.issues.filter((i) => i.severity === "needs-human");
  const info = app.issues.filter((i) => i.severity === "info");
  if (blockers.length) out.push("### Blockers", "", ...issueList(blockers), "");
  if (human.length) out.push("### Needs a person", "", ...issueList(human), "");
  if (info.length) out.push("### Notes", "", ...issueList(info), "");
  return out;
}

export function renderPlan(plan: Plan): string {
  const out: string[] = [];
  const modeText = plan.mode === "add" ? "add PayPal alongside Stripe" : "replace Stripe with PayPal";
  out.push(`# Portage plan: ${plan.mode === "add" ? "add PayPal to" : "move to PayPal:"} ${plan.app.name}`, "");
  out.push(`**Mode:** ${modeText} · **App:** ${plan.app.root === "." ? plan.app.name : plan.app.root} (${plan.app.framework}) · **Status:** ${plan.status === "ready" ? "ready for approval" : "blocked"}`, "");
  out.push(plan.headline, "");
  if (plan.status === "blocked") {
    out.push("## Why Portage stopped", "", ...issueList(plan.blockers), "");
    if (plan.notes.length) out.push("## Notes", "", ...issueList(plan.notes), "");
    out.push("Nothing was changed.");
    return out.join("\n");
  }
  out.push("## Steps", "");
  plan.steps.forEach((s, i) => {
    out.push(`${i + 1}. **${s.title}**${s.files.length ? ` (${s.files.map(code).join(", ")})` : ""}`);
    for (const d of s.details) out.push(`   - ${d}`);
    if (s.reference?.length) out.push(`   - Start from Portage's reference code: ${s.reference.map((r) => `get_reference_code ${code(r)}`).join(", ")}`);
    if (s.contextmatic.length) out.push(`   - ContextMatic first: ${s.contextmatic.map((l) => `${l.tool} ${code(l.query)}`).join("; ")}`);
  });
  out.push("");
  const files = [
    ...plan.files.create.map((f) => ["create", f] as const),
    ...plan.files.edit.map((f) => ["change", f] as const),
    ...plan.files.remove.map((f) => ["remove", f] as const),
  ];
  out.push("## Files", "", "| Change | File | Why |", "|---|---|---|", ...files.map(([k, f]) => `| ${k} | ${code(f.file)} | ${cell(f.why)} |`), "");
  out.push("## New routes", "", "| Route | File | Purpose |", "|---|---|---|", ...plan.routes.map((r) => `| ${code(`${r.method} ${r.path}`)} | ${code(r.file)} | ${cell(r.purpose)} |`), "");
  if (plan.events.length) {
    out.push("## Webhook events", "", "| Stripe | PayPal | Reuses | Notes |", "|---|---|---|---|");
    for (const e of plan.events) {
      out.push(`| ${e.stripe === "(none)" ? "(new)" : code(e.stripe)} | ${e.paypal ? code(e.paypal) : "none"} | ${e.reuse.map(code).join(", ") || "-"} | ${cell(e.notes.join(" "))} |`);
    }
    out.push("");
  }
  if (plan.dataModel.length) {
    out.push("## Order records", "");
    for (const d of plan.dataModel) out.push(`- ${code(d.entity)} (${d.file}:${d.line}): add ${d.add.map(code).join(", ")}. ${d.note}`);
    out.push("");
  }
  if (plan.money.length) {
    out.push("## Money", "", "| Currency | PayPal | Note |", "|---|---|---|", ...plan.money.map((m) => `| ${m.currency} | ${m.paypal} | ${cell(m.note)} |`), "");
  }
  out.push("## Settings", "", ...plan.env.add.map((e) => `- ${code(e.name)}: ${e.note}`), ...(plan.env.remove.length ? [`- Remove: ${plan.env.remove.map(code).join(", ")}`] : []), "");
  out.push(`**Catalog:** ${plan.catalog.reason}`, "");
  if (plan.needsHuman.length) out.push("## Needs a person", "", ...issueList(plan.needsHuman), "");
  if (plan.untouched.length) out.push("## Stays as it is", "", ...plan.untouched.map((u) => `- ${u}`), "");
  if (plan.notes.length) out.push("## Notes", "", ...issueList(plan.notes), "");
  out.push("## ContextMatic lookups to make while editing", "", ...plan.contextmatic.map((l) => `- ${l.tool} ${code(l.query)}: ${l.why}`), "");
  out.push("Nothing has been changed yet. Approve this plan to continue.");
  return out.join("\n");
}
