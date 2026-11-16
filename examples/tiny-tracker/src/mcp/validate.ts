// Input validation for tool arguments, against the same JSON Schema the tool
// advertises in tools/list. Small on purpose: it supports exactly the schema
// keywords tiny-tracker uses.
//
// The four steps are separate functions so that each input defect in
// src/defects replaces exactly one of them:
//   checkType     wrong types are rejected, never coerced        (MWS-IN-1)
//   checkUnknown  arguments the schema does not define are refused (MWS-IN-2)
//   checkLimits   advertised enums and bounds are enforced          (MWS-IN-3)
//   describe      a failure names the field and the reason           (MWS-IN-4)

export interface JsonSchema {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  default?: unknown;
}

export interface Issue {
  path: string[];
  reason: string;
}

type Checked = { value: unknown; issues: Issue[] };

export interface Validation {
  checkType(schema: JsonSchema, value: unknown, path: string[]): Checked;
  checkUnknown(schema: JsonSchema, value: Record<string, unknown>, path: string[]): Checked;
  checkLimits(schema: JsonSchema, value: unknown, path: string[]): Issue[];
  describe(issue: Issue): { message: string; path?: string[] };
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function typeMatches(expected: string, actual: string): boolean {
  return expected === actual || (expected === "number" && actual === "integer");
}

export const correctValidation: Validation = {
  checkType(schema, value, path) {
    if (schema.type === undefined) return { value, issues: [] };
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(value);
    if (allowed.some((t) => typeMatches(t, actual))) return { value, issues: [] };
    return { value, issues: [{ path, reason: `expected ${allowed.join(" or ")}, got ${actual}` }] };
  },

  checkUnknown(schema, value, path) {
    if (schema.additionalProperties !== false) return { value, issues: [] };
    const known = new Set(Object.keys(schema.properties ?? {}));
    const issues = Object.keys(value)
      .filter((k) => !known.has(k))
      .map((k) => ({ path: [...path, k], reason: "is not an argument of this tool" }));
    return { value, issues };
  },

  checkLimits(schema, value, path) {
    const issues: Issue[] = [];
    const add = (reason: string) => issues.push({ path, reason });
    if (schema.enum && !schema.enum.includes(value)) add(`must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`);
    if (typeof value === "number") {
      if (schema.minimum !== undefined && value < schema.minimum) add(`must be at least ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) add(`must be at most ${schema.maximum}`);
    }
    if (typeof value === "string") {
      if (schema.minLength !== undefined && value.length < schema.minLength) add(`must be at least ${schema.minLength} characters`);
      if (schema.maxLength !== undefined && value.length > schema.maxLength) add(`must be at most ${schema.maxLength} characters`);
      if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) add(`must match ${schema.pattern}`);
    }
    if (Array.isArray(value)) {
      if (schema.minItems !== undefined && value.length < schema.minItems) add(`must have at least ${schema.minItems} items`);
      if (schema.maxItems !== undefined && value.length > schema.maxItems) add(`must have at most ${schema.maxItems} items`);
    }
    return issues;
  },

  describe(issue) {
    return { message: issue.reason, path: issue.path };
  },
};

/** Validates `value` against `schema`. Returns the value to hand to the tool, or the issues. */
export function validate(schema: JsonSchema, value: unknown, v: Validation, path: string[] = []): Checked {
  const typed = v.checkType(schema, value, path);
  if (typed.issues.length > 0) return typed;
  value = typed.value;
  const issues: Issue[] = [...v.checkLimits(schema, value, path)];

  if (Array.isArray(value) && schema.items) {
    value = value.map((item, i) => {
      const r = validate(schema.items!, item, v, [...path, String(i)]);
      issues.push(...r.issues);
      return r.value;
    });
  }

  if (typeOf(value) === "object" && schema.properties) {
    const known = v.checkUnknown(schema, value as Record<string, unknown>, path);
    issues.push(...known.issues);
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(known.value as Record<string, unknown>)) {
      const prop = schema.properties[key];
      if (!prop) {
        if (schema.additionalProperties !== false) out[key] = item;
        continue;
      }
      const r = validate(prop, item, v, [...path, key]);
      issues.push(...r.issues);
      out[key] = r.value;
    }
    for (const key of schema.required ?? []) {
      if (!(key in out)) issues.push({ path: [...path, key], reason: "is required" });
    }
    value = out;
  }
  return { value, issues };
}

/**
 * Wraps a JSON Schema as a Standard Schema with JSON Schema output, the form
 * the MCP SDK's McpServer.registerTool accepts. The SDK turns returned issues
 * into a tool execution error (`isError: true`), as the MCP Tools page asks.
 */
export function toolInputSchema(schema: JsonSchema, v: Validation) {
  return {
    "~standard": {
      version: 1 as const,
      vendor: "tiny-tracker",
      validate(input: unknown) {
        const r = validate(schema, input ?? {}, v);
        if (r.issues.length === 0) return { value: r.value as Record<string, unknown> };
        return { issues: r.issues.map((i) => v.describe(i)) };
      },
      jsonSchema: {
        input: () => schema as Record<string, unknown>,
        output: () => schema as Record<string, unknown>,
      },
    },
  };
}
