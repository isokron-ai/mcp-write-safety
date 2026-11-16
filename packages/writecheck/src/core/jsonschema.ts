/**
 * A small JSON Schema validator for one question only: do a tool call's arguments validate against the tool's
 * whole input schema (spec MWS-IN-1 and MWS-IN-3, R7-4)? A probe is sent only where they do not. The answer is
 * `true`, `false`, or `unknown` where the schema uses a keyword this validator does not evaluate (a remote
 * `$ref`, `unevaluatedProperties`, `$dynamicRef`): a probe whose invalidity cannot be shown is not sent, so a
 * value that another branch of the schema accepts is never sent as a probe. `format` is an annotation (JSON
 * Schema Validation, section 7) and is not checked.
 */

import { deepEqual, isObj, type Obj } from './util.js';

export type Valid = true | false | 'unknown';

const UNSUPPORTED = ['unevaluatedProperties', 'unevaluatedItems', '$dynamicRef', '$recursiveRef'];

function jsonType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v === 'object' ? 'object' : typeof v;
}

/** All of: false wins, then unknown, then true. */
function all(xs: Valid[]): Valid {
  if (xs.includes(false)) return false;
  if (xs.includes('unknown')) return 'unknown';
  return true;
}

function resolveRef(root: unknown, ref: string): unknown {
  if (ref === '#') return root;
  if (!ref.startsWith('#/')) return undefined;
  let cur: unknown = root;
  for (const raw of ref.slice(2).split('/')) {
    const k = decodeURIComponent(raw.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (!isObj(cur) && !Array.isArray(cur)) return undefined;
    cur = (cur as Obj)[k];
    if (cur === undefined) return undefined;
  }
  return cur;
}

/** Does `v` validate against `s` (a sub-schema of `root`)? */
export function validates(s: unknown, v: unknown, root: unknown = s, depth = 0): Valid {
  if (depth > 64) return 'unknown';
  if (s === true || s === undefined) return true;
  if (s === false) return false;
  if (!isObj(s)) return true;
  for (const k of UNSUPPORTED) if (k in s) return 'unknown';
  const out: Valid[] = [];
  if (typeof s['$ref'] === 'string') {
    const t = resolveRef(root, s['$ref']);
    if (t === undefined) return 'unknown';
    out.push(validates(t, v, root, depth + 1));
  }
  const t = jsonType(v);
  if (s['type'] !== undefined) {
    const types = Array.isArray(s['type']) ? (s['type'] as unknown[]).map(String) : [String(s['type'])];
    if (!types.includes(t) && !(t === 'integer' && types.includes('number'))) return false;
  }
  if (Array.isArray(s['enum']) && !(s['enum'] as unknown[]).some((e) => deepEqual(e, v))) return false;
  if (Object.hasOwn(s, 'const') && !deepEqual(s['const'], v)) return false;
  const n = (k: string): number | null => (typeof s[k] === 'number' ? (s[k] as number) : null);
  if (typeof v === 'number') {
    if (n('minimum') !== null && v < n('minimum')!) return false;
    if (n('maximum') !== null && v > n('maximum')!) return false;
    if (n('exclusiveMinimum') !== null && v <= n('exclusiveMinimum')!) return false;
    if (n('exclusiveMaximum') !== null && v >= n('exclusiveMaximum')!) return false;
    const m = n('multipleOf');
    if (m !== null && m > 0 && Math.abs(v / m - Math.round(v / m)) > 1e-9) return false;
  }
  if (typeof v === 'string') {
    const len = [...v].length;
    if (n('maxLength') !== null && len > n('maxLength')!) return false;
    if (n('minLength') !== null && len < n('minLength')!) return false;
    if (typeof s['pattern'] === 'string') {
      try {
        if (!new RegExp(s['pattern'], 'u').test(v)) return false;
      } catch {
        return 'unknown';
      }
    }
  }
  if (Array.isArray(v)) {
    if (n('minItems') !== null && v.length < n('minItems')!) return false;
    if (n('maxItems') !== null && v.length > n('maxItems')!) return false;
    if (s['uniqueItems'] === true && new Set(v.map((x) => JSON.stringify(x))).size !== v.length) return false;
    const prefix = Array.isArray(s['prefixItems']) ? (s['prefixItems'] as unknown[]) : [];
    prefix.forEach((ps, i) => {
      if (i < v.length) out.push(validates(ps, v[i], root, depth + 1));
    });
    if (s['items'] !== undefined) {
      if (Array.isArray(s['items'])) return 'unknown'; // draft-07 tuple form
      for (let i = prefix.length; i < v.length; i++) out.push(validates(s['items'], v[i], root, depth + 1));
    }
    if (s['contains'] !== undefined) {
      const hits = v.map((x) => validates(s['contains'], x, root, depth + 1));
      const yes = hits.filter((h) => h === true).length;
      const maybe = hits.filter((h) => h === 'unknown').length;
      const min = n('minContains') ?? 1;
      const max = n('maxContains');
      if (yes + maybe < min || (max !== null && yes > max)) return false;
      if (maybe) out.push('unknown');
    }
  }
  if (isObj(v)) {
    const keys = Object.keys(v);
    if (n('minProperties') !== null && keys.length < n('minProperties')!) return false;
    if (n('maxProperties') !== null && keys.length > n('maxProperties')!) return false;
    if (Array.isArray(s['required']) && (s['required'] as unknown[]).some((k) => typeof k === 'string' && !Object.hasOwn(v, k))) return false;
    const props = isObj(s['properties']) ? (s['properties'] as Obj) : {};
    const pats = isObj(s['patternProperties']) ? Object.entries(s['patternProperties'] as Obj) : [];
    for (const k of keys) {
      let matched = false;
      if (Object.hasOwn(props, k)) {
        matched = true;
        out.push(validates(props[k], v[k], root, depth + 1));
      }
      for (const [p, ps] of pats) {
        let re: RegExp;
        try {
          re = new RegExp(p, 'u');
        } catch {
          return 'unknown';
        }
        if (re.test(k)) {
          matched = true;
          out.push(validates(ps, v[k], root, depth + 1));
        }
      }
      if (!matched && s['additionalProperties'] !== undefined) out.push(validates(s['additionalProperties'], v[k], root, depth + 1));
      if (s['propertyNames'] !== undefined) out.push(validates(s['propertyNames'], k, root, depth + 1));
    }
    if (isObj(s['dependentRequired'])) for (const [k, req] of Object.entries(s['dependentRequired'] as Obj)) if (Object.hasOwn(v, k) && Array.isArray(req) && req.some((r) => typeof r === 'string' && !Object.hasOwn(v, r))) return false;
    if (isObj(s['dependentSchemas'])) for (const [k, ds] of Object.entries(s['dependentSchemas'] as Obj)) if (Object.hasOwn(v, k)) out.push(validates(ds, v, root, depth + 1));
  }
  if (Array.isArray(s['allOf'])) out.push(all((s['allOf'] as unknown[]).map((x) => validates(x, v, root, depth + 1))));
  if (Array.isArray(s['anyOf'])) {
    const xs = (s['anyOf'] as unknown[]).map((x) => validates(x, v, root, depth + 1));
    out.push(xs.includes(true) ? true : xs.includes('unknown') ? 'unknown' : false);
  }
  if (Array.isArray(s['oneOf'])) {
    const xs = (s['oneOf'] as unknown[]).map((x) => validates(x, v, root, depth + 1));
    const yes = xs.filter((x) => x === true).length;
    out.push(xs.includes('unknown') ? (yes > 1 ? false : 'unknown') : yes === 1);
  }
  if (s['not'] !== undefined) {
    const x = validates(s['not'], v, root, depth + 1);
    out.push(x === 'unknown' ? 'unknown' : !x);
  }
  if (s['if'] !== undefined) {
    const c = validates(s['if'], v, root, depth + 1);
    if (c === 'unknown') out.push('unknown');
    else if (c && s['then'] !== undefined) out.push(validates(s['then'], v, root, depth + 1));
    else if (!c && s['else'] !== undefined) out.push(validates(s['else'], v, root, depth + 1));
  }
  return all(out);
}
