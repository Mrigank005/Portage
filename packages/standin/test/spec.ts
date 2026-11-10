// Validates Standin's output against Stripe's public OpenAPI specification (github.com/stripe/openapi).
// The spec is downloaded once into the repo's .cache folder (it is about 5 MB and not committed).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AjvModule from "ajv";

const Ajv = ((AjvModule as any).default ?? AjvModule) as new (opts?: Record<string, unknown>) => any;

const SPEC_URL = "https://raw.githubusercontent.com/stripe/openapi/master/latest/openapi.spec3.json";
const cacheFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.cache/stripe-spec.json");

async function loadSpec(): Promise<any> {
  if (!fs.existsSync(cacheFile)) {
    const res = await fetch(SPEC_URL);
    if (!res.ok) throw new Error(`Could not download Stripe's OpenAPI spec (${res.status}) from ${SPEC_URL}`);
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, Buffer.from(await res.arrayBuffer()));
  }
  return JSON.parse(fs.readFileSync(cacheFile, "utf8"));
}

/**
 * OpenAPI 3.0 allows `nullable: true` on a schema without a `type` (Stripe's spec does this around $ref and
 * anyOf). JSON Schema validators need it spelled out, so rewrite those into an explicit "null or this" form.
 * This changes how `nullable` is written, never what the spec allows.
 */
function normaliseNullable(node: unknown): void {
  if (Array.isArray(node)) {
    node.forEach(normaliseNullable);
    return;
  }
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, any>;
  for (const v of Object.values(obj)) normaliseNullable(v);
  if (obj.nullable !== true) return;
  delete obj.nullable;
  if (typeof obj.type === "string") {
    obj.type = [obj.type, "null"];
    if (Array.isArray(obj.enum) && !obj.enum.includes(null)) obj.enum = [...obj.enum, null];
    return;
  }
  const rest = { ...obj };
  for (const k of Object.keys(obj)) delete obj[k];
  obj.anyOf = [{ type: "null" }, rest];
}

/**
 * Stripe's schemas allow additional properties, so a schema check alone would accept a field we made up.
 * This walks the object and lists every field the spec does not declare.
 */
function undeclaredFields(schemas: Record<string, any>, data: unknown, schema: any, path: string, out: string[]): void {
  const resolve = (s: any): any => {
    while (s?.$ref) s = schemas[s.$ref.split("/").pop()];
    return s;
  };
  // All object-shaped alternatives of a schema, looking through anyOf / oneOf / allOf.
  const objectShapes = (s: any): any[] => {
    s = resolve(s);
    if (!s) return [];
    if (s.properties) return [s];
    return [...(s.anyOf ?? []), ...(s.oneOf ?? []), ...(s.allOf ?? [])].flatMap(objectShapes);
  };
  schema = resolve(schema);
  if (!schema || data === null || typeof data !== "object") return;
  if (Array.isArray(data)) {
    const items = schema.items ?? objectShapes(schema).map((s) => s.items).find(Boolean);
    data.forEach((v, i) => undeclaredFields(schemas, v, items, `${path}[${i}]`, out));
    return;
  }
  const shapes = objectShapes(schema);
  if (shapes.length === 0) return; // free-form object, such as metadata
  const keys = Object.keys(data as object);
  const best = shapes.reduce((a, b) => (keys.filter((k) => k in b.properties).length > keys.filter((k) => k in a.properties).length ? b : a));
  for (const k of keys) {
    if (!(k in best.properties)) out.push(`${path}/${k}`);
    else undeclaredFields(schemas, (data as any)[k], best.properties[k], `${path}/${k}`, out);
  }
}

export async function makeValidator() {
  const spec = await loadSpec();
  normaliseNullable(spec.components);
  const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false, validateSchema: false });
  ajv.addSchema(spec, "stripe");
  return {
    specVersion: spec.info.version as string,
    /**
     * Throws a readable error unless `data` is a valid instance of Stripe's schema `name` AND contains no
     * fields the spec does not declare.
     */
    validate(name: string, data: unknown): void {
      const check = ajv.getSchema(`stripe#/components/schemas/${name}`);
      if (!check) throw new Error(`Stripe's spec has no schema named "${name}"`);
      const extra: string[] = [];
      undeclaredFields(spec.components.schemas, data, spec.components.schemas[name], "", extra);
      if (extra.length) {
        throw new Error(`${name} does not match Stripe's OpenAPI spec:\n${extra.map((f) => `  ${f} is not declared in the spec`).join("\n")}`);
      }
      if (!check(data)) {
        const lines = [
          ...new Set(
            (check.errors ?? []).map(
              (e: any) => `  ${e.instancePath || "/"} ${e.message}${e.params && "allowedValues" in e.params ? ` (${JSON.stringify(e.params.allowedValues)})` : ""}`,
            ),
          ),
        ];
        throw new Error(`${name} does not match Stripe's OpenAPI spec:\n${lines.slice(0, 15).join("\n")}`);
      }
    },
  };
}
