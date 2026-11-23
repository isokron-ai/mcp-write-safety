/**
 * Schema and coercion probes: real calls, in the test tenant, on the run's own object, never in
 * `plan` (a wrong-type value is a write whenever the server has the coercion defect being tested
 * for). For each top-level input property of the read and update tools, one valid base call with
 * that one property replaced by a value the schema does not allow, plus one call with an argument
 * the schema does not define.
 *
 *   MWS-IN-1  the spec's probe list (version 1) of values of another type; violated only where an accepted
 *             probe's value was used with another meaning (the meaning rule), never for a conversion that
 *             keeps the meaning (spec NF-21); where the value used cannot be established, not tested
 *   MWS-IN-6  the same probes: any accepted probe is violated (SHOULD)
 *   MWS-IN-2  an undefined argument (a misspelling of a real one, and an unrelated name): accepted = violated
 *   MWS-IN-3  each declared constraint keyword: just outside and far outside, required missing
 *   MWS-IN-4  every refusal: a server error, a runtime internal in the text, a protocol error
 *             instead of a tool execution error, or a message that does not name the field
 *
 * On a write tool the properties that carry the object's id or the manifest's scope variables are
 * never changed, so a probe cannot reach an object outside the run. The object is reset after any
 * probe the update tool accepted.
 */

import type { ResourceSpec } from '../core/manifest.js';
import { validates } from '../core/jsonschema.js';
import { render, templateRoots } from '../core/template.js';
import { deepEqual, diff, getPath, isObj, short, withoutIgnored, type Obj } from '../core/util.js';
import { result, type Result } from '../report/verdicts.js';
import { answerOf, questionId, reviewResult, type Question } from './review.js';
import { ruleNote } from './rules.js';
import { fromDeclaration, saidBy, says, withoutEcho } from './says.js';
import { rejectSignal } from './signals.js';
import { searchesUpdate } from './in5search.js';
import { mcpDefinedError, notRun, toolByName, wp, type CheckModule, type Observation, type PlanContext, type PlannedCheck, type RunContext, type Tool } from './types.js';

const ID = 'schema-probes';
// why: version 2: the MWS-IN-2 misspelled argument is chosen from the sorted names, not from the schema's property order.
const VERSION = '2';

export const RAW_ERROR = /(panic:|goroutine \d+|runtime error|json: cannot unmarshal|unexpected end of JSON input|invalid character '.' looking for|Traceback \(most recent call last\)|TypeError:|ReferenceError:|\bat Object\.|\bat async |NullPointerException|SyntaxError: Unexpected token|undefined method)/;
const STATUS_IN_TEXT = /("status"\s*:\s*(4|5)\d\d\b|"code"\s*:\s*(4|5)\d\d\b|\bHTTP (4|5)\d\d\b|\b(4|5)\d\d (Not Found|Bad Request|Conflict|Unprocessable|Forbidden|Unauthorized)\b)/;
export const UNKNOWN_ARG = 'mwsc_undefined_argument';

export interface ProbeCase {
  prop: string;
  name: string;
  value?: unknown;
  drop?: boolean;
  requirement: 'MWS-IN-1' | 'MWS-IN-2' | 'MWS-IN-3';
  /** MWS-IN-1 probes: the type the schema declares, and whether the argument is required. */
  type?: string;
  required?: boolean;
}

/** The probe list of MWS-IN-1, version 1 (spec section 9.7). */
export const PROBE_LIST_VERSION = '1';
const SCALAR_PROBES: [string, unknown][] = [['object', { a: 1 }], ['list', [1]]];
const PROBES: Record<string, [string, unknown][]> = {
  boolean: [['string_false', 'false'], ['string_true', 'true'], ['string_yes', 'yes'], ['zero', 0], ['one', 1], ['null', null]],
  number: [['numeric_string', '5'], ['non_numeric_string', 'abc'], ['empty_string', ''], ['null', null], ['boolean', true]],
  integer: [['numeric_string', '5'], ['non_numeric_string', 'abc'], ['empty_string', ''], ['null', null], ['boolean', true], ['fraction', 0.5]],
  string: [['number', 5], ['boolean', true], ['null', null]],
};

function jsonType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v === 'object' ? 'object' : typeof v;
}

/** Is a value of a type the schema declares (an integer is also a number)? */
function ofDeclaredType(v: unknown, types: string[]): boolean {
  const t = jsonType(v);
  return types.includes(t) || (t === 'integer' && types.includes('number'));
}

/** The value of `sent` that keeps its meaning for an argument of type `t` (spec MWS-IN-1), or undefined. */
export function keptValue(sent: unknown, t: string): unknown {
  if ((t === 'number' || t === 'integer') && typeof sent === 'string' && /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(sent)) return Number(sent);
  if (t === 'boolean' && (sent === 'true' || sent === 'false')) return sent === 'true';
  if (t === 'string' && (typeof sent === 'number' || typeof sent === 'boolean')) return JSON.stringify(sent);
  return undefined;
}

export type Meaning = { kind: 'keeps' | 'changes' | 'observation' | 'unknown'; why: string };

/**
 * The meaning rule of MWS-IN-1: does the value the tool used keep the meaning of the value sent? Only the
 * cases the spec lists change the meaning; any other conversion is an observation, never violated.
 * `before` is the stored value before the call (for "treated as not sent" and "dropped"), when known.
 */
export function meaningOf(sent: unknown, used: unknown, t: string, required: boolean, before: { known: boolean; value?: unknown }): Meaning {
  const kv = keptValue(sent, t);
  const S = short(sent, 30);
  const U = short(used, 30);
  if (deepEqual(used, sent)) return { kind: 'keeps', why: `${S} was used as sent` };
  if (kv !== undefined && deepEqual(used, kv)) return { kind: 'keeps', why: `${S} was used as ${U}, which keeps its meaning` };
  if (sent === null) {
    if (!required && before.known && deepEqual(used, before.value)) return { kind: 'keeps', why: 'null was treated as if the argument had not been sent' };
    if (required && before.known && deepEqual(used, before.value)) return { kind: 'observation', why: 'null, sent for a required argument, left the stored value as it was' };
    if (required) return { kind: 'changes', why: `null, sent for a required argument, was replaced by ${U}` };
    if (typeof used === 'number' || used === false || used === '' || (Array.isArray(used) && !used.length) || (isObj(used) && !Object.keys(used).length)) return { kind: 'changes', why: `null was used as ${U}` };
    return { kind: 'observation', why: `null was used as ${U}` };
  }
  if (sent === '' && (typeof used === 'number' || used === false)) return { kind: 'changes', why: `"" was used as ${U}` };
  if (t === 'boolean' && sent === 'false' && used === true) return { kind: 'changes', why: '"false" was used as true' };
  if ((t === 'number' || t === 'integer') && typeof sent === 'string' && kv === undefined && typeof used === 'number') return { kind: 'changes', why: `the string ${S}, not a number, was used as the number ${U}` };
  if (t === 'integer' && typeof sent === 'number' && !Number.isInteger(sent) && typeof used === 'number' && used !== sent) return { kind: 'changes', why: `the fraction ${S} was rounded or truncated to ${U}` };
  if ((isObj(sent) || Array.isArray(sent)) && typeof used === 'string') return { kind: 'changes', why: `${S} was flattened to the string ${U}` };
  if (before.known && deepEqual(used, before.value) && !deepEqual(kv ?? sent, before.value)) {
    // why: a conversion that lands on the stored value (0 to false when false is stored) looks like a drop; it cannot be told apart.
    const conv = [Boolean(sent), Number(sent), String(sent), typeof sent === 'object' ? JSON.stringify(sent) : undefined];
    if (conv.some((x) => x !== undefined && deepEqual(x, before.value))) return { kind: 'unknown', why: `${S} left the stored value ${U}, which a conversion of ${S} would also give` };
    return { kind: 'changes', why: `${S} was dropped (the stored value stayed ${U})` };
  }
  return { kind: 'observation', why: `${S} was used as ${U}` };
}

/** Is a value valid for one property's schema, by the keywords MWS-IN-3 lists that the tester checks (type, bounds, length, pattern, enum, const)? */
export function validFor(s: unknown, v: unknown): boolean {
  if (!isObj(s)) return true;
  const types = Array.isArray(s['type']) ? (s['type'] as unknown[]).map(String) : typeof s['type'] === 'string' ? [s['type']] : [];
  if (types.length && !ofDeclaredType(v, types)) return false;
  const n = (k: string): number | null => (typeof s[k] === 'number' ? (s[k] as number) : null);
  if (typeof v === 'number') {
    if (n('minimum') !== null && v < n('minimum')!) return false;
    if (n('maximum') !== null && v > n('maximum')!) return false;
    if (n('exclusiveMinimum') !== null && v <= n('exclusiveMinimum')!) return false;
    if (n('exclusiveMaximum') !== null && v >= n('exclusiveMaximum')!) return false;
  }
  if (typeof v === 'string') {
    if (n('maxLength') !== null && [...v].length > n('maxLength')!) return false;
    if (n('minLength') !== null && [...v].length < n('minLength')!) return false;
    if (typeof s['pattern'] === 'string') {
      try {
        if (!new RegExp(s['pattern'], 'u').test(v)) return false;
      } catch {
        return false;
      }
    }
  }
  if (typeof v === 'number' && n('multipleOf') !== null && n('multipleOf')! > 0 && Math.abs(v / n('multipleOf')! - Math.round(v / n('multipleOf')!)) > 1e-9) return false;
  if (Array.isArray(v)) {
    if (n('minItems') !== null && v.length < n('minItems')!) return false;
    if (n('maxItems') !== null && v.length > n('maxItems')!) return false;
    if (s['uniqueItems'] === true && new Set(v.map((x) => JSON.stringify(x))).size !== v.length) return false;
    if (isObj(s['items']) && !v.every((x) => validFor(s['items'], x))) return false;
  }
  if (isObj(v)) {
    if (n('minProperties') !== null && Object.keys(v).length < n('minProperties')!) return false;
    if (n('maxProperties') !== null && Object.keys(v).length > n('maxProperties')!) return false;
  }
  if (Array.isArray(s['enum']) && !(s['enum'] as unknown[]).some((e) => deepEqual(e, v))) return false;
  if (Object.hasOwn(s, 'const') && !deepEqual(s['const'], v)) return false;
  return true;
}

function itemFor(s: unknown, i: number): unknown {
  const it = isObj(s) ? s : {};
  if (Array.isArray(it['enum']) && it['enum'].length) return it['enum'][i % it['enum'].length];
  const t = String(Array.isArray(it['type']) ? it['type'][0] : it['type'] ?? 'string');
  return t === 'integer' || t === 'number' ? i + 1 : t === 'boolean' ? i % 2 === 0 : `mwsc${i}`;
}

/**
 * The argument MWS-IN-2 misspells, and the misspelling: a name one letter away from the first non-id argument in sorted order (the
 * order of the schema's properties is not part of the test, so it must not choose the target). Null where none is long enough.
 */
export function misspelledArgument(props: string[]): { arg: string; as: string } | null {
  const sorted = [...props].sort();
  const p = sorted.find((x) => x.length > 3 && !ID_LIKE.test(x)) ?? sorted.find((x) => x.length > 3);
  if (!p) return null;
  const m = p.slice(0, 1) + p.slice(2);
  return props.includes(m) ? null : { arg: p, as: m };
}

const misspelling = (props: string[]): string | null => misspelledArgument(props)?.as ?? null;

/** The invalid cases a tool's input schema implies (one property at a time), plus the undefined arguments. */
export function probeCases(schema: unknown, skip: Set<string>): ProbeCase[] {
  const out: ProbeCase[] = [];
  const props = isObj(schema) && isObj(schema['properties']) ? (schema['properties'] as Record<string, Obj>) : {};
  const required = isObj(schema) && Array.isArray(schema['required']) ? (schema['required'] as string[]) : [];
  for (const [p, s] of Object.entries(props)) {
    if (skip.has(p) || !isObj(s)) continue;
    const types = Array.isArray(s['type']) ? (s['type'] as unknown[]).map(String) : typeof s['type'] === 'string' ? [s['type']] : [];
    const t = types.find((x) => x !== 'null') ?? '';
    // MWS-IN-1 (and IN-6): the probe list, skipping a probe whose type the schema declares.
    // why: for a union type (["string", "number"]) the probes of each declared type are sent, and a probe of any declared type is skipped (CLI-BUGS item 3).
    const seen = new Set<string>();
    for (const tt of types.filter((x) => PROBES[x])) {
      for (const [name, value] of [...PROBES[tt]!, ...SCALAR_PROBES]) {
        const key = JSON.stringify(value);
        if (ofDeclaredType(value, types) || seen.has(key)) continue;
        seen.add(key);
        out.push({ prop: p, name, value, requirement: 'MWS-IN-1', type: tt, required: required.includes(p) });
      }
    }
    // MWS-IN-3: each declared constraint keyword, just outside and far outside.
    const n = (k: string): number | null => (typeof s[k] === 'number' ? (s[k] as number) : null);
    const step = t === 'integer' ? 1 : 0.5;
    if (t === 'integer' || t === 'number') {
      if (n('minimum') !== null) out.push({ prop: p, name: 'below_minimum', value: n('minimum')! - step, requirement: 'MWS-IN-3' }, { prop: p, name: 'far_below_minimum', value: Math.min(n('minimum')! - 1e9, -1e12), requirement: 'MWS-IN-3' });
      if (n('maximum') !== null) out.push({ prop: p, name: 'above_maximum', value: n('maximum')! + step, requirement: 'MWS-IN-3' }, { prop: p, name: 'far_above_maximum', value: Math.max(n('maximum')! + 1e9, 1e12), requirement: 'MWS-IN-3' });
      if (n('exclusiveMinimum') !== null) out.push({ prop: p, name: 'at_exclusive_minimum', value: n('exclusiveMinimum')!, requirement: 'MWS-IN-3' }, { prop: p, name: 'far_below_minimum', value: -1e12, requirement: 'MWS-IN-3' });
      if (n('exclusiveMaximum') !== null) out.push({ prop: p, name: 'at_exclusive_maximum', value: n('exclusiveMaximum')!, requirement: 'MWS-IN-3' }, { prop: p, name: 'far_above_maximum', value: 1e12, requirement: 'MWS-IN-3' });
      if (n('multipleOf') !== null && n('multipleOf')! > 0) {
        const m = n('multipleOf')!;
        const base = n('minimum') ?? n('exclusiveMinimum') ?? 0;
        const start = Math.ceil(base / m) * m;
        // why: a value that is truly not a multiple; for an integer argument only a multipleOf above 1 leaves one.
        const v = t === 'integer' ? (Number.isInteger(m) && m > 1 ? start + 1 : null) : start + m / 2;
        if (v !== null) out.push({ prop: p, name: 'not_multiple', value: v, requirement: 'MWS-IN-3' });
      }
    }
    if (Array.isArray(s['enum'])) out.push({ prop: p, name: 'not_in_enum', value: t === 'integer' || t === 'number' ? Math.max(0, ...(s['enum'] as unknown[]).filter((x): x is number => typeof x === 'number')) + 1001 : '__mwsc_not_in_enum__', requirement: 'MWS-IN-3' });
    if (Object.hasOwn(s, 'const')) out.push({ prop: p, name: 'not_const', value: typeof s['const'] === 'number' ? s['const'] + 1 : typeof s['const'] === 'boolean' ? !s['const'] : `${String(s['const'])}_mwsc`, requirement: 'MWS-IN-3' });
    if (t === 'string') {
      if (n('maxLength') !== null && n('maxLength')! < 10_000) out.push({ prop: p, name: 'too_long', value: 'x'.repeat(n('maxLength')! + 1), requirement: 'MWS-IN-3' }, { prop: p, name: 'far_too_long', value: 'x'.repeat(Math.min(n('maxLength')! * 10 + 10, 20_000)), requirement: 'MWS-IN-3' });
      if (n('minLength') !== null && n('minLength')! > 0) out.push({ prop: p, name: 'too_short', value: 'x'.repeat(n('minLength')! - 1), requirement: 'MWS-IN-3' });
      if (typeof s['pattern'] === 'string') {
        let re: RegExp | null = null;
        try {
          re = new RegExp(s['pattern'], 'u');
        } catch {
          re = null;
        }
        const v = ' mwsc ~!\u0000 does not match ';
        if (re && !re.test(v)) out.push({ prop: p, name: 'pattern_mismatch', value: v, requirement: 'MWS-IN-3' });
      }
    }
    if (t === 'array') {
      if (n('maxItems') !== null && n('maxItems')! < 1000) out.push({ prop: p, name: 'too_many_items', value: Array.from({ length: n('maxItems')! + 1 }, (_, i) => itemFor(s['items'], i)), requirement: 'MWS-IN-3' });
      if (n('minItems') !== null && n('minItems')! > 0) out.push({ prop: p, name: 'too_few_items', value: Array.from({ length: n('minItems')! - 1 }, (_, i) => itemFor(s['items'], i)), requirement: 'MWS-IN-3' });
      if (s['uniqueItems'] === true) out.push({ prop: p, name: 'repeated_item', value: [itemFor(s['items'], 0), itemFor(s['items'], 0)], requirement: 'MWS-IN-3' });
    }
    if (t === 'object') {
      if (n('maxProperties') !== null && n('maxProperties')! < 1000) out.push({ prop: p, name: 'too_many_properties', value: Object.fromEntries(Array.from({ length: n('maxProperties')! + 1 }, (_, i) => [`mwsc${i}`, 'x'])), requirement: 'MWS-IN-3' });
      if (n('minProperties') !== null && n('minProperties')! > 0) out.push({ prop: p, name: 'too_few_properties', value: Object.fromEntries(Array.from({ length: n('minProperties')! - 1 }, (_, i) => [`mwsc${i}`, 'x'])), requirement: 'MWS-IN-3' });
    }
    if (required.includes(p)) out.push({ prop: p, name: 'missing_required', drop: true, requirement: 'MWS-IN-3' });
  }
  // MWS-IN-2: only where the schema does not allow additional properties; first, so a cut list never drops them.
  const extra: ProbeCase[] = [];
  if (!(isObj(schema) && (schema['additionalProperties'] === true || isObj(schema['additionalProperties'])))) {
    // why: spec 7.3, rule 1 (R6-3): an identifier, a scope argument or a selector of a write tool is never misspelled either.
    const miss = misspelling(Object.keys(props).filter((k) => !skip.has(k)));
    if (miss) extra.push({ prop: miss, name: 'misspelled_argument', value: 'mwsc', requirement: 'MWS-IN-2' });
    extra.push({ prop: UNKNOWN_ARG, name: 'undefined_argument', value: 'mwsc', requirement: 'MWS-IN-2' });
  }
  return [...extra, ...out];
}

/**
 * May a probe of MWS-IN-1 or MWS-IN-3 be sent (spec R7-4 and R6-2)? Only where the arguments, with the probe in them,
 * do not validate against the tool's whole input schema (a value another branch accepts is not a probe), and only
 * as a conforming request: an object or a list is not sent for a parameter the transport mirrors into a header.
 */
export function sendableProbe(schema: unknown, base: Obj, prop: string, value: unknown, drop: boolean): { send: boolean; why: string | null } {
  const ps = isObj(schema) && isObj(schema['properties']) ? (schema['properties'] as Obj)[prop] : undefined;
  if (!drop && isObj(ps) && Object.hasOwn(ps, 'x-mcp-header') && (isObj(value) || Array.isArray(value))) return { send: false, why: `${prop} is mirrored into a header by the transport (x-mcp-header), and an object or a list cannot be sent there in a conforming request (spec 7.3, rule 9; MWS-IN-4)` };
  const args: Obj = { ...base };
  if (drop) delete args[prop];
  else args[prop] = value;
  const v = validates(schema, args);
  const what = drop ? `without ${prop}` : `with ${prop}=${short(value, 40)}`;
  if (v === true) return { send: false, why: `the arguments ${what} validate against the tool's whole input schema, so it is not a probe (spec MWS-IN-1, MWS-IN-3: a value another branch accepts breaks no constraint)` };
  if (v === 'unknown') return { send: false, why: `the tester could not establish that the arguments ${what} do not validate against the tool's whole input schema (it uses a keyword the tester does not evaluate), so it was not sent` };
  return { send: true, why: null };
}

export interface In5Obs {
  tool: string;
  arg: string;
  value: string;
  /** Valid by the tool's input schema (a value that is not is reported and not sent). */
  valid: boolean;
  ok: boolean;
  isError: boolean;
  names_arg: boolean;
  step: string | null;
  text: string | null;
  indeterminate?: boolean;
  /** R10-8: an accepted value of the list: whether the read afterwards shows it stored (false counts as refused). */
  stored?: boolean | null;
}

/**
 * MWS-IN-5 (SHOULD, a search): a value valid by the schema refused under a constraint the schema does not
 * declare. Only the declared values to try are searched in this preview (not every call of the run).
 */
export function in5Verdicts(obs: In5Obs[], res: ResourceSpec, tools: Tool[]): Result[] {
  const sc = { id: `${ID}.in5`, version: VERSION };
  const tool = res.update?.tool;
  if (!tool || !toolByName(tools, tool)) return [];
  const w = wp(res.name, tool);
  const scope = 'Only the values the declaration lists (try_values) were tried, on the object under test: the MWS-IN-5 search (scenario in5-search) does not search this update tool, and its record says why.';
  if (!res.try_values.length) return [result('MWS-IN-5', w, sc, 'not tested', `the declaration lists no values to try for ${tool} (try_values), and the run-wide search is not built in this preview`)];
  const sent = obs.filter((o) => o.valid && !o.indeterminate);
  // why: spec 96d3691 (R10-8): a call was refused when its result is an error, or, for a listed value, a success after which the
  // value is not stored (its form is judged by MWS-RES-2). violated only where the declaration states the constraint is fixed.
  const refused = sent.filter((o) => !o.ok || o.stored === false);
  const fixed = (fc: { arg: string; pattern: string }, o: In5Obs) => fc.arg === o.arg && new RegExp(fc.pattern, 'i').test(o.text ?? '');
  const bad = refused.map((o) => ({ o, fc: (res.fixed_constraints ?? []).find((fc) => fixed(fc, o)) })).filter((x) => !!x.fc);
  const seen = refused.filter((o) => !bad.some((x) => x.o === o));
  const notes = [scope, ...obs.filter((o) => !o.valid).map((o) => `${o.arg}=${o.value}: not valid by the schema, so not sent (it would be MWS-IN-3).`), ...seen.map((o) => `Seen, not judged: ${o.arg}=${o.value} was refused${o.ok ? ' (answered as a success, and the value is not stored)' : ''}: ${JSON.stringify(o.text ?? '')}. Neither the declaration (fixed_constraints) nor a recorded reading states that the constraint is fixed.`)];
  if (bad.length) return [result('MWS-IN-5', w, sc, 'violated', `${tool} refused ${bad.length} value(s) valid by its input schema, under a fixed constraint the schema does not declare (the declaration states it is fixed): ${bad.map((x) => `${x.o.arg}=${x.o.value} (${short(x.o.text ?? '', 100)}; ${x.fc!.reason})`).join('; ')}.`, { steps: bad.map((x) => x.o.step!).filter(Boolean), notes })];
  if (!sent.length) return [result('MWS-IN-5', w, sc, 'not tested', 'no declared value to try was valid by the schema, or every call had an unknown outcome', { notes })];
  return [result('MWS-IN-5', w, sc, 'not observed', seen.length ? `${tool} refused ${seen.length} of the ${sent.length} declared value(s) valid by its schema; each refusal is listed, seen, not judged (no declared fixed constraint). This is a search (spec 8.2, rule 8).` : `${tool} accepted the ${sent.length} declared value(s) valid by its schema. This is a search (spec 8.2, rule 8).`, { notes })];
}

/**
 * MWS-IN-5 for an update tool this check halted (spec R15-4): the IN-5 search (src/checks/in5search.ts) runs after this check
 * and sends nothing to a halted tool, and where the object under test is unusable it does not run for the resource at all, so
 * the record that says why comes from here. Evidence from before the search recorded `in5` and is judged by in5Verdicts.
 */
function in5Halted(halted: Record<string, string>, res: ResourceSpec, tools: Tool[]): Result[] {
  const tool = res.update?.tool;
  if (!tool || !toolByName(tools, tool) || !halted[tool]) return [];
  return [result('MWS-IN-5', wp(res.name, tool), { id: `${ID}.in5`, version: VERSION }, 'not tested', `${tool} was not probed further after a failed put-back (spec R15-4): ${short(halted[tool]!, 300)}. The MWS-IN-5 search sends nothing to it.`)];
}

/** The note on an extra-argument probe answered only with input_required (an intermediate result, not retried or asked again). */
export const INTERMEDIATE = 'not judged: intermediate input_required result';

export interface ProbeObs {
  tool: string;
  /** write: a write tool other than an update tool (src/checks/inputwrites.ts), probed from a declared base call. */
  role: 'read' | 'update' | 'write';
  prop: string;
  name: string;
  requirement: ProbeCase['requirement'];
  value: string;
  ok: boolean;
  isError: boolean;
  rpc_error: { code: number; message: string } | null;
  text: string | null;
  step: string;
  /** Timed out or the connection broke: the outcome is unknown, so the probe is not judged. */
  indeterminate?: boolean;
  /**
   * A probe answered with input_required and no final result (the declaration gives no answers to retry with, or the retry asked
   * again): whether the tool takes the value or the argument is not known, so MWS-IN-1, IN-2, IN-3, IN-6 and IN-7 do not judge it.
   * Only a taken call is so marked; a refusal is final.
   */
  intermediate?: boolean;
  /** MWS-IN-1 probes. */
  sent?: unknown;
  type?: string;
  required?: boolean;
  /** An accepted MWS-IN-1 probe: what the tool used, where it could be established, and how (step). */
  meaning?: Meaning | null;
  meaning_steps?: string[];
  /** A refused null probe whose answer equals the answer without the argument: null was treated as not sent; not judged. */
  as_omitted?: boolean;
  /** An accepted MWS-IN-2 probe on a write tool: the read-back shows the extra argument had an effect. */
  effect?: string[] | null;
  /** Not sent, and why (valid against the whole input schema, not a conforming request, or a tester-safety rule). */
  not_sent?: string;
  /** Spec R15-4: not sent because a put-back on this tool failed; the record it belongs to is never held. */
  halted?: boolean;
  /**
   * R10-3: an error that neither refuses the probed value (it names the argument, or a declared patterns.refused_value reads it)
   * nor follows from its use, after one resend: the tester cannot tell; no verdict under IN-1, IN-4, IN-6 or IN-7, and no held.
   */
  cannot_tell?: boolean;
  /** How the refusal was known to refuse the probed value (a structured signal, the argument named, a declared pattern, a control). */
  refused_by?: string;
  /** K9: what the controls showed (the base call sent again; the counterpart of the same meaning). */
  control?: string;
}

/** R10-3: does an error refuse the probed value itself? It names the argument, or a declared patterns.refused_value reads it (rule 11). */
function rejects(r: { text: string | null; data?: unknown; rpc_error: { code: number; message: string } | null; isError?: boolean }, prop: string): boolean {
  return refusedBy(r, prop) !== null;
}

/**
 * How an error is known to refuse the probed value: a structured signal first (JSON-RPC -32602, an SDK validation message,
 * a validation code; rule-11 coverage package), then the argument named, then a declared patterns.refused_value; null when
 * none applies (the tester cannot tell).
 */
export function refusedBy(r: { text: string | null; data?: unknown; rpc_error: { code: number; message: string } | null; isError?: boolean }, prop: string): string | null {
  const t = `${r.text ?? ''} ${r.rpc_error?.message ?? ''}`;
  // why: an error that follows from the tool having used the value (a not-found) is not a refusal, even with JSON-RPC -32602
  // or a code; otherwise a structured signal decides first (S1: never a string in the text).
  const sig = rejectSignal(r);
  if (/not[ _-]?found|no such|does not exist|doesn't exist|\bno \w+ (with|for|matching)\b/i.test(t)) return null;
  if (sig) return `${sig.source} (${JSON.stringify(sig.quote)})`;
  // why: review (9): an error that follows from the tool having used the value (a not-found for the id it looked up) is not a
  // rejection of the value; the argument is matched as a whole word, never inside another (id in "invalid", status in "HTTP status").
  if (/not[ _-]?found|no such|does not exist|doesn't exist|\bno \w+ (with|for|matching)\b/i.test(t)) return null;
  const esc = prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`(^|[^A-Za-z0-9_])${esc}($|[^A-Za-z0-9_])`).test(t)) return 'the error names the argument';
  return fromDeclaration('refused_value') && says('refused_value', t) ? 'the declared patterns.refused_value' : null;
}

/** Does a result name the extra argument and say that it was not used (spec MWS-IN-2)? */
/** The text around the last place it names `word` (for quoting the passage a verdict rests on, rule 11). */
export function around(text: string, word: string, before = 80, after = 120): string {
  const i = text.lastIndexOf(word);
  if (i < 0) return short(text, before + after);
  return `${i > before ? '…' : ''}${text.slice(Math.max(0, i - before), i + word.length + after)}${i + word.length + after < text.length ? '…' : ''}`;
}

export function saysNotUsed(text: string, prop: string): boolean {
  // why: gate-2 safety re-run on 0295ed6 (F3): the argument and the "not used" reading must meet in one clause outside echoed
  // data ("Request echo: {...}. Remaining unused quota" names the argument only in the echo, and "unused" is about a quota).
  const esc = prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const named = new RegExp(`(^|[^A-Za-z0-9_])${esc}($|[^A-Za-z0-9_])`);
  return withoutEcho(text).split(/[.;!?\n]\s|[.;!?\n]$/).some((c) => named.test(c) && says('not_used', c));
}

/** Does a value carry any of the markers anywhere (deep; strings by substring)? */
export function carries(v: unknown, marks: unknown[]): boolean {
  if (marks.some((m) => deepEqual(m, v))) return true;
  if (typeof v === 'string') return marks.some((m) => (typeof m === 'string' || typeof m === 'number') && String(m).length > 0 && v.includes(String(m)));
  if (Array.isArray(v)) return v.some((x) => carries(x, marks));
  if (isObj(v)) return Object.values(v).some((x) => carries(x, marks));
  return false;
}

export const ID_LIKE = /(^|_)(id|ids|uid|uuid|key|parent|project|owner|org|organization|workspace|tenant|namespace|scope|path|where|filter|selector|query|target)$|Id$/i;

/**
 * Properties a probe on a write tool must never change: every property of the base call except the
 * field under test (so the selector, the id, the version and the scope always go as configured), and
 * any property whose value carries the object id, the run prefix or a scope variable anywhere. A
 * property outside the base call is probed only if its name does not look like an id or a selector.
 */
export function protectedProps(base: Obj, fieldArg: string, marks: unknown[], schema: unknown): Set<string> {
  const out = new Set<string>();
  for (const [k, v] of Object.entries(base)) if (k !== fieldArg || carries(v, marks)) out.add(k);
  const props = isObj(schema) && isObj(schema['properties']) ? Object.keys(schema['properties'] as Obj) : [];
  for (const k of props) if (!(k in base) && ID_LIKE.test(k)) out.add(k);
  return out;
}

function toolsOf(res: ResourceSpec): { tool: string; role: 'read' | 'update' }[] {
  return [
    { tool: res.read.tool, role: 'read' },
    ...(res.update ? [{ tool: res.update.tool, role: 'update' as const }] : []),
  ];
}

export const schemaCheck: CheckModule = {
  id: ID,
  version: VERSION,
  requirements: ['MWS-IN-1', 'MWS-IN-2', 'MWS-IN-3', 'MWS-IN-4', 'MWS-IN-5', 'MWS-IN-6', 'MWS-IN-7'],
  plan(ctx: PlanContext, res: ResourceSpec): PlannedCheck {
    const base: PlannedCheck = { check: ID, version: VERSION, resource: res.name, runs: false, calls: [], writes: 0, creates: 0, notRun: [] };
    const calls: string[] = [];
    const nr: Result[] = [];
    let writes = 0;
    const max = ctx.manifest.limits.max_fuzz_cases;
    for (const { tool, role } of toolsOf(res)) {
      const t = toolByName(ctx.tools, tool);
      if (!t) {
        nr.push(...notRun(this, ['MWS-IN-1', 'MWS-IN-2', 'MWS-IN-3', 'MWS-IN-4', 'MWS-IN-6', 'MWS-IN-7'], wp(res.name, tool), 'not tested', `${tool} is not in tools/list`));
        continue;
      }
      // why: id and scope properties are protected on writes; at plan time the id is not known, so count by name.
      const base = role === 'update' && isObj(res.update!.args) ? (res.update!.args as Obj) : {};
      const fieldArgs = Object.keys(base).filter((k) => k.includes('{{field}}'));
      const skip = role === 'update' ? new Set([...Object.keys(base).filter((k) => !fieldArgs.includes(k)), ...(isObj(t.inputSchema) && isObj(t.inputSchema['properties']) ? Object.keys(t.inputSchema['properties'] as Obj).filter((k) => ID_LIKE.test(k)) : [])]) : new Set<string>();
      const cases = probeCases(t.inputSchema, skip).slice(0, max);
      calls.push(`${tool}: ${cases.length} probe call(s): ${[...new Set(cases.map((c) => c.name))].join(', ')}`);
      // the base call (R10-3), and per probe the probe, its resend where it cannot be told, and the resets after each.
      if (role === 'update') writes += 2 + cases.length * 5;
    }
    return { ...base, runs: calls.length > 0, calls, writes, notRun: nr };
  },
  async collect(ctx: RunContext, res: ResourceSpec): Promise<Observation> {
    const d = ctx.driver;
    const out: ProbeObs[] = [];
    let in5: In5Obs[] | undefined;
    const cut: Record<string, { sent: number; total: number }> = {};
    const noObject: string[] = [];
    // why: writesafe self-test T1: a tool whose probes could not start (the reset or the read before them failed) is not tested
    // with that reason, never `not applicable` with a reason about its schema.
    const notProbed: Record<string, string> = {};
    const protectedBy: Record<string, string[]> = {};
    const max = ctx.manifest.limits.max_fuzz_cases;
    const label = ctx.label('IN');
    for (const { tool, role } of toolsOf(res)) {
      const t = toolByName(ctx.tools, tool);
      if (!t) continue;
      // why: re-review of 2443620 (A): a tool a failed put-back halted earlier in this run (any resource) gets no further MWS-IN call,
      // not even the base call or the resets around it.
      const inherited = role === 'update' ? haltedIn(ctx.session).get(tool) : undefined;
      if (inherited) {
        notProbed[tool] = `a put-back on it failed earlier in this run, so no further MWS-IN probe, control or value is sent to it (spec R15-4): ${inherited}`;
        continue;
      }
      let base: Obj;
      let curObj: unknown = null;
      if (role === 'read') {
        // why: a resource with no object under test (no update tool) has no id to read; the read tool is not probed (CLI-BUGS item 11).
        if ((d.id === null || d.id === undefined) && /\{\{\s*(json:)?\??id\s*\}\}/.test(JSON.stringify(res.read.args))) {
          noObject.push(tool);
          continue;
        }
        base = render(res.read.args, d.vars()) as Obj;
      }
      else {
        if (!(await d.reset())) {
          notProbed[tool] = 'the object under test could not be put back to its baseline before the probes, so none was sent';
          continue;
        }
        const cur = await d.readOnce(label, ctx.session.stepId(`in.${tool}.base`));
        if (!cur.ok) {
          notProbed[tool] = 'the object under test did not read back before the probes, so none was sent';
          continue;
        }
        curObj = cur.obj;
        base = d.updateArgs(res.fields![0], d.baseline?.[0] ?? res.fields![0].values[0], { obj: cur.obj, version: cur.version }) as Obj;
      }
      if (!isObj(base)) {
        notProbed[tool] = 'the arguments the probes start from did not render to a mapping, so none was sent';
        continue;
      }
      // why: spec 96d3691 (R10-3): each probe is sent in a call that is otherwise valid, after a base call that succeeded.
      {
        const b0 = await ctx.session.call(label, tool, { ...base }, { step: ctx.session.stepId(`in.${tool}.base_call`), write: role === 'update' });
        if (!b0.ok) {
          notProbed[tool] = `the base call (the arguments every probe starts from, with no probe) did not succeed (${short(b0.text ?? b0.rpc_error?.message ?? b0.transport_error ?? (b0.timed_out ? 'timed out' : 'error'), 160)}), so no probe would be sent in an otherwise valid call (spec R10-3)`;
          continue;
        }
        if (role === 'update') {
          if (!(await d.reset())) {
            notProbed[tool] = 'the object under test could not be put back to its baseline after the base call, so no probe was sent';
            continue;
          }
          const cur2 = await d.readOnce(label, ctx.session.stepId(`in.${tool}.base2`));
          if (!cur2.ok) {
            notProbed[tool] = 'the object under test did not read back after the base call, so no probe was sent';
            continue;
          }
          curObj = cur2.obj;
          base = d.updateArgs(res.fields![0], d.baseline?.[0] ?? res.fields![0].values[0], { obj: cur2.obj, version: cur2.version }) as Obj;
        }
      }
      const marks = [d.id, ctx.prefix, ...Object.values(res.vars)].filter((v) => v !== null && v !== undefined && v !== '');
      const skip = role === 'update' ? protectedProps(base, res.fields![0].arg, marks, t.inputSchema) : new Set<string>();
      if (skip.size) protectedBy[tool] = [...skip].filter((k) => isObj(t.inputSchema) && isObj(t.inputSchema['properties']) && Object.hasOwn(t.inputSchema['properties'] as Obj, k));
      // why: a property of the object that carries the run prefix is how cleanup recognises it. A probe may
      // only send it a value that keeps the prefix (an over-long name that starts with it), never another type.
      const named = new Set<string>();
      if (role === 'update' && isObj(curObj)) {
        for (const [k, v] of Object.entries(curObj)) if (carries(v, [ctx.prefix])) named.add(k);
        if (res.create?.name_path) named.add(String(res.create.name_path.split('.')[0]).replace(/^\$\.?/, ''));
      }
      const cases = probeCases(t.inputSchema, skip)
        .filter((c) => !named.has(c.prop) || (c.name === 'too_long' && typeof c.value === 'string' && c.value.length > ctx.prefix.length))
        .map((c) => (named.has(c.prop) ? { ...c, value: `${ctx.prefix}${'x'.repeat((c.value as string).length - ctx.prefix.length)}` } : c));
      // why: after an accepted probe the object is reset, which moves its version on; the next probe must carry the
      // current version, or it is refused as a conflict and read as a rejection of the probe.
      const fresh = async (): Promise<boolean> => {
        if (role !== 'update') return true;
        const cur = await d.readOnce(label, ctx.session.stepId(`in.${tool}.rebase`));
        if (!cur.ok) return false;
        curObj = cur.obj;
        base = d.updateArgs(res.fields![0], d.baseline?.[0] ?? res.fields![0].values[0], { obj: cur.obj, version: cur.version }) as Obj;
        return isObj(base);
      };
      let stale = false;
      /** Set where a restorable argument could not be put back: no further probe or control of the tool is sent (run-wide, spec R15-4). */
      let halted: string | null = haltedIn(ctx.session).get(tool) ?? null;
      /**
       * Spec R15-4: put the object back to its state before the probe, through the same tool with the base call's other arguments and
       * scope (the argument's value read before the probe, or the base call without it where the read does not show it), and read it
       * back leaving out the ignored and server-managed fields. True where the read-back shows the object as it was.
       */
      const restore = async (c: { prop: string; name: string }, entry: { path: string; call_only?: boolean }, before: unknown): Promise<true | string> => {
        if (!isObj(before)) return 'the object was not read before the probe';
        if (!(await fresh())) return 'the object did not read back before the put-back';
        // why: review of 3283a69 (3): only an argument declared per call (call_only) is put back by the base call without it; any other
        // must be shown by the read, or there is nothing to put back to.
        const shown = entry.call_only ? undefined : getPath(before, entry.path);
        if (!entry.call_only && shown === undefined) return `the read before the probe does not show ${entry.path}, so there was no value to put back`;
        const a: Obj = { ...base };
        if (shown !== undefined) a[c.prop] = shown;
        else delete a[c.prop];
        const x = await ctx.session.call(label, tool, a, { step: ctx.session.stepId(`in.${tool}.${c.prop}.${c.name}.restore`), write: true });
        stale = true;
        if (x.timed_out || x.transport_error !== null || (!!x.result_type && x.result_type !== 'complete')) return `the put-back${shown !== undefined ? ` of ${c.prop} = ${short(JSON.stringify(shown), 40)}` : ''} has an unknown outcome`;
        if (!x.ok) return `the put-back${shown !== undefined ? ` of ${c.prop} = ${short(JSON.stringify(shown), 40)}` : ''} was refused (${short(x.text ?? x.rpc_error?.message ?? '', 120)})`;
        const ign = [...res.read.ignore, ...res.server_managed, ...(res.version ? [res.version.read] : [])];
        // why: a server may apply the put-back after answering it; the read-back waits, within the settle window, for it to show.
        const back = await d.readSettled(label, `in.${tool}.${c.prop}.${c.name}.restore`, (o) => withoutIgnored(diff(before, o), ign).length === 0);
        if (!back.ok) return 'the object did not read back after the put-back';
        const left = withoutIgnored(diff(before, back.obj), ign).map((e) => e.path);
        if (left.length) return `after the put-back the object does not read as it was before the probe (at ${left.slice(0, 4).join(', ')})`;
        return true;
      };
      if (cases.length > max) cut[tool] = { sent: max, total: cases.length };
      for (const c of cases.slice(0, max)) {
        if (halted) {
          out.push({ tool, role, prop: c.prop, name: c.name, requirement: c.requirement, value: c.drop ? '(missing)' : short(c.value, 60), ok: false, isError: false, rpc_error: null, text: null, step: '', not_sent: `not sent: ${halted}`, halted: true });
          continue;
        }
        if (stale && !(await fresh())) break;
        stale = false;
        // spec R15-4: the object as read before the probe (curObj is current: every write since the last read set stale).
        const beforeProbe = curObj;
        const args: Obj = { ...base };
        if (c.drop) delete args[c.prop];
        else args[c.prop] = c.value;
        if (c.requirement !== 'MWS-IN-2') {
          const ok = sendableProbe(t.inputSchema, base, c.prop, c.value, !!c.drop);
          if (!ok.send) {
            out.push({ tool, role, prop: c.prop, name: c.name, requirement: c.requirement, value: c.drop ? '(missing)' : short(c.value, 60), ok: false, isError: false, rpc_error: null, text: null, step: '', not_sent: ok.why! });
            continue;
          }
        }
        const step = ctx.session.stepId(`in.${tool}.${c.prop}.${c.name}`);
        const r = await ctx.session.call(label, tool, args, { step, write: role === 'update' });
        // why: the verdicts read the whole result (spec 7.3, rule 11); a notice after a long answer ("Ignored argument x" after a
        // list of 400+ characters) was cut before saysNotUsed saw it, and a told argument read as dropped silently. Quotes are cut
        // where they are made (short, around, saidBy, the review evidence).
        const o: ProbeObs = { tool, role, prop: c.prop, name: c.name, requirement: c.requirement, value: c.drop ? '(missing)' : short(c.value, 60), ok: r.ok, isError: r.isError, rpc_error: r.rpc_error, text: r.text, step, ...(r.timed_out || r.transport_error !== null || (r.result_type && r.result_type !== 'complete') ? { indeterminate: true } : {}) };
        if (c.requirement === 'MWS-IN-1') Object.assign(o, { sent: c.value, type: c.type, required: !!c.required });
        // MWS-IN-2: an accepted extra argument on a write tool: did it have an effect? (read back, compared with the read before)
        if (c.requirement === 'MWS-IN-2' && role === 'update' && r.ok && !o.indeterminate) {
          const back = await d.readOnce(label, ctx.session.stepId(`in.${tool}.${c.prop}.effect`));
          const ign = [...res.read.ignore, ...(res.version ? [res.version.read] : [])];
          o.effect = back.ok ? withoutIgnored(diff(curObj, back.obj), ign).map((e) => e.path) : null;
        }
        // MWS-IN-1: establish the value an accepted probe was used as.
        if (c.requirement === 'MWS-IN-1' && r.ok && !o.indeterminate) {
          const t = c.type ?? '';
          if (role === 'update') {
            const path = res.fields?.find((f) => f.arg === c.prop)?.path ?? (isObj(curObj) && Object.hasOwn(curObj, c.prop) ? c.prop : null);
            const back = path ? await d.readOnce(label, ctx.session.stepId(`in.${tool}.${c.prop}.${c.name}.readback`)) : null;
            if (path && back?.ok) {
              const used = getPath(back.obj, path);
              o.meaning = meaningOf(c.value, used, t, !!c.required, { known: true, value: getPath(curObj, path) });
              o.meaning_steps = [step];
            } else o.meaning = null;
          } else {
            // why: a read tool stores nothing, so the value used is established by comparing its result with calls that send candidate values.
            const same = async (v: unknown, omit = false): Promise<boolean | null> => {
              const a: Obj = { ...base };
              if (omit) delete a[c.prop];
              else a[c.prop] = v;
              const q = await ctx.session.call(label, tool, a, { step: ctx.session.stepId(`in.${tool}.${c.prop}.${c.name}.compare`), write: false });
              if (q.timed_out || q.transport_error !== null) return null;
              return JSON.stringify([q.isError, q.data ?? null, q.text]) === JSON.stringify([r.isError, r.data ?? null, r.text]);
            };
            const kv = keptValue(c.value, t);
            o.meaning = null;
            if (kv !== undefined && (await same(kv))) o.meaning = { kind: 'keeps', why: `${short(c.value, 30)} gave the same result as ${short(kv, 30)}` };
            else if (c.value === null && !c.required && (await same(undefined, true))) o.meaning = { kind: 'keeps', why: 'null gave the same result as not sending the argument' };
            else if (t === 'boolean' && c.value === 'false' && (await same(true)) && (await same(false)) === false) o.meaning = { kind: 'changes', why: '"false" gave the result of true' };
            // why: a fraction for an integer: the result of the rounded-down or rounded-up value, or of no value, shows it was not used as sent (gate-2 K8s B19).
            else if (t === 'integer' && typeof c.value === 'number' && !Number.isInteger(c.value)) {
              const lo = await same(Math.floor(c.value));
              const hi = await same(Math.ceil(c.value));
              const none = c.required ? false : await same(undefined, true);
              if ((lo || none) && hi === false) o.meaning = { kind: 'changes', why: `${c.value} gave the result of ${lo ? Math.floor(c.value) : 'no value'} (the fraction was ${lo ? 'rounded down' : 'dropped'})` };
              else if (hi && lo === false && none === false) o.meaning = { kind: 'changes', why: `${c.value} gave the result of ${Math.ceil(c.value)} (the fraction was rounded up)` };
            }
            o.meaning_steps = [step];
          }
        }
        // why: a refusal after null was treated as "not sent" (a not-found in a default scope, say) is not a refusal of the probe: on a
        // read tool the same call without the argument is compared, and an identical answer sets the probe aside (gate-2 K8s B2).
        if (role === 'read' && c.requirement === 'MWS-IN-1' && c.value === null && !c.required && !r.ok && !o.indeterminate) {
          const a: Obj = { ...base };
          delete a[c.prop];
          const q = await ctx.session.call(label, tool, a, { step: ctx.session.stepId(`in.${tool}.${c.prop}.null.omitted`), write: false });
          // why: the shared answer must not name the argument (a not-found, say); a shared refusal that names it may be a type rejection (review).
          const txt = r.text ?? r.rpc_error?.message ?? '';
          if (!q.ok && q.isError === r.isError && (q.text ?? q.rpc_error?.message ?? '') === txt && !txt.includes(c.prop)) o.as_omitted = true;
        }
        // why: K9 (spec review K9-IN4-OPTIONS, option C / B): whether an error answer refuses the probed value is decided by two
        // controls, never by reading its text. (a) The base call, sent again at once with its valid value: where it does not succeed
        // the call was not otherwise valid, and the probe cannot be told. (b) Where the probe has a counterpart of the declared type
        // with the same meaning (MWS-IN-1), the call with the counterpart: the same answer means the error follows from a use the
        // spec permits (the probe was accepted; MWS-IN-1 and IN-6 judge it); a different answer means the tool told the value apart.
        // With no counterpart, in4NoCounterpart() decides (option C: a rejection; option B: only a named, declared or structured one).
        if (!r.ok && !o.indeterminate && !o.as_omitted) {
          const by = refusedBy(r, c.prop);
          /** Whether the last control() call went out (it may still have an unknown outcome); false where it stopped before the call. */
          let lastSent = false;
          const control = async (set: { value?: unknown; omit?: boolean }, tag: string) => {
            lastSent = false;
            if (role === 'update') {
              await d.reset();
              if (!(await fresh())) return null;
            }
            const a: Obj = { ...base };
            if (set.omit) delete a[c.prop];
            else if ('value' in set) a[c.prop] = set.value;
            lastSent = true;
            const x = await ctx.session.call(label, tool, a, { step: ctx.session.stepId(`in.${tool}.${c.prop}.${c.name}.${tag}`), write: role === 'update' });
            if (role === 'update') {
              await d.reset();
              stale = true;
            }
            // why: review of 3283a69 (1): a task or input_required result is an unknown outcome too.
            return x.timed_out || x.transport_error !== null || (!!x.result_type && x.result_type !== 'complete') ? null : x;
          };
          const b = await control({}, 'base');
          if (!b || !b.ok) {
            o.cannot_tell = true;
            o.control = b ? 'the base call, sent again at once with its valid value, did not succeed: the call was not otherwise valid' : 'the base call could not be sent again';
          } else {
            // why: a counterpart that the argument's own schema does not allow (a string not in the enum) is no use the spec permits;
            // the same refusal of both shows nothing, so such a probe has no counterpart.
            const ps = isObj(t.inputSchema) && isObj(t.inputSchema['properties']) ? (t.inputSchema['properties'] as Obj)[c.prop] : undefined;
            const cp0 = counterpart(c.value, o.type, !!o.required);
            const cp = cp0 && (cp0.omit || validates(ps, cp0.value) === true) ? cp0 : null;
            // why: spec R15-4 (15f71e5; action dogfood SH-6): on a tool that writes an object that exists before the call, a counterpart
            // that sends the probed argument with a value other than the base call's, or sends it where the base call did not, or, on a
            // tool that replaces or applies the whole object, leaves out an argument the base call sent, can change state the base call
            // would not (archived: true, draft: true, disable_provenance, whatever the value). It is sent only where the declaration lists
            // the argument as one the tester may send and put back (restorable; a declared field, which the tester writes and resets, counts
            // as listed); the object is then put back to its state before the probe and read back. Otherwise it is not sent, and the probe
            // is not judged (a control that cannot be sent). Read tools are unchanged (R14-6).
            const wholeObject = res.update?.mode === 'full_replace' || res.update?.apply === true;
            const trigger = !!cp && role === 'update' && (cp.omit ? wholeObject && Object.hasOwn(base, c.prop) : !(Object.hasOwn(base, c.prop) && deepEqual(base[c.prop], cp.value)));
            // why: review of 3283a69 (4, 5): only an argument the declaration lists explicitly (the tester does not infer it), and only on a
            // tool that updates one object named by its identifier.
            const listed = trigger && restorableTool(res, ctx.manifest.resources) ? (res.restorable ?? []).find((x) => x.arg === c.prop) ?? null : null;
            const hidden = !!listed && !listed.call_only && getPath(beforeProbe, listed.path) === undefined;
            if (cp && trigger && listed && hidden) {
              o.cannot_tell = true;
              o.control = `the control with the counterpart of the same meaning (${cp.what}) was not sent: ${c.prop} is declared restorable, but the read before the probe does not show ${listed.path}, so it could not be put back (declare it { arg: ${c.prop}, call_only: true } only if it acts on that call alone)`;
            } else if (cp && trigger && !listed) {
              o.cannot_tell = true;
              o.control = `the control with the counterpart of the same meaning (${cp.what}) was not sent: on ${tool} it would ${cp.omit ? `leave out ${c.prop}, which the base call sends, from a write of the whole object` : `send ${c.prop} = ${short(JSON.stringify(cp.value), 40)}, a value the base call does not send`}, and the declaration does not list ${c.prop} as an argument the tester may send and put back (spec R15-4; restorable)`;
            } else if (cp) {
              // spec R14-6: the comparison is apart from the value's own text and anything that differed between two sends of the probe.
              const r2 = await control(c.drop ? { omit: true } : { value: c.value }, 'again');
              lastSent = false;
              const u = r2 ? await control(cp.omit ? { omit: true } : { value: cp.value }, 'use') : null;
              const uSent = lastSent;
              // spec R15-4: put the object back to its state before the probe and read it back, wherever the counterpart went out, its
              // outcome known or not (review of 3283a69, 1); not where the control stopped before the call.
              const putBack = trigger && listed && uSent ? await restore(c, listed, beforeProbe) : null;
              const same = r2 && u ? sameAnswer(r, u, [c.value, cp.omit ? undefined : cp.value], r2) : null;
              if (putBack !== null && putBack !== true) {
                const obj = short(JSON.stringify(d.id), 40);
                o.cannot_tell = true;
                o.control = `the control with the counterpart of the same meaning (${cp.what}) was sent to ${c.prop}, which the declaration lists as an argument the tester may send and put back, but ${putBack}; for clean-up: object ${obj}, argument ${c.prop}. The probe is not judged, no further probe or control is sent to ${tool}, and the object is used in no later test (spec R15-4)`;
                halted = `the declared restorable ${c.prop} could not be put back after a control (${putBack}; object ${obj})`;
                haltedIn(ctx.session).set(tool, halted);
                d.unusable = `object ${obj} could not be put back after an MWS-IN-4 control on ${c.prop} through ${tool} (${putBack}); spec R15-4: it is used in no later test`;
                d.leftChanged = { arg: c.prop, why: putBack };
              } else if (!r2 || !u || same === null) {
                o.cannot_tell = true;
                o.control = !r2 ? 'the probe could not be sent again' : !u ? 'the call with the counterpart of the same meaning could not be made' : 'two sends of the probe differed in a way the comparison cannot set aside';
              } else if (same) {
                Object.assign(o, { ok: true, isError: false, meaning: { kind: 'keeps', why: `${cp.what} gave the same answer as the probe, so the error follows from a use the spec permits (R10-3, NF-21)` } as Meaning, control: `used as ${cp.what}: the same answer` });
              } else o.refused_by = by ?? `caused by the value: the base call succeeded at once, and ${cp.what} was answered differently`;
            } else if (by) o.refused_by = by;
            else if (in4NoCounterpart() === 'rejection') o.refused_by = 'caused by the value: the base call succeeded at once; no use that keeps the meaning';
            else {
              o.cannot_tell = true;
              o.control = 'the base call succeeded at once, the probe has no counterpart of the same meaning, and the error neither names the argument nor matches a declared pattern';
            }
          }
        }
        out.push(o);
        if (role === 'update' && (r.timed_out || r.transport_error !== null || r.ok)) {
          await d.reset();
          stale = true;
        }
      }
      // MWS-IN-5: the declared values to try (try_values) are sent by the IN-5 search (src/checks/in5search.ts), on a scratch
      // object of the tester's. Where the search does not search this update tool (a resource with a fixture only, or a cleanup
      // policy of leave), they are sent here, on the object under test, as before (review of lane F7, S5).
      // spec R15-4: after a put-back that failed, nothing more is sent to the tool.
      if (role === 'update' && !halted && res.try_values.length && !searchesUpdate(ctx.manifest, ctx.tools, res)) {
        in5 ??= [];
        const props = isObj(t.inputSchema) && isObj(t.inputSchema['properties']) ? (t.inputSchema['properties'] as Obj) : {};
        for (const tv of res.try_values) {
          const value = tv.value !== undefined ? render(tv.value, d.vars()) : named.has(tv.arg) ? `${ctx.prefix}${'x'.repeat(Math.max(0, tv.length! - ctx.prefix.length))}` : 'x'.repeat(tv.length!);
          const step = ctx.session.stepId(`in5.${tool}.${tv.arg}`);
          if (!validFor(props[tv.arg], value)) {
            in5.push({ tool, arg: tv.arg, value: short(value, 60), valid: false, ok: false, isError: false, names_arg: false, step: null, text: null });
            continue;
          }
          if (!(await fresh())) break;
          const r = await ctx.session.call(label, tool, { ...base, [tv.arg]: value }, { step, write: true });
          // why: R10-8: a success after which the listed value is not stored counts as refused.
          let stored: boolean | null = null;
          if (r.ok && !r.timed_out && r.transport_error === null) {
            const path = res.fields?.find((f) => f.arg === tv.arg)?.path ?? tv.arg;
            const back = await d.readSettled(label, `in5.${tool}.${tv.arg}.read`, (o) => deepEqual(getPath(o, path), value));
            stored = back.ok ? back.settled : null;
            await d.reset();
          }
          in5.push({ tool, arg: tv.arg, value: short(value, 60), valid: true, ok: r.ok, isError: r.isError, names_arg: !r.ok && `${r.text ?? ''} ${r.rpc_error?.message ?? ''} ${JSON.stringify(r.data ?? null)}`.includes(tv.arg), step, text: ((t) => (t !== null && t.length > 2000 ? short(t, 2000) : t))(r.text ?? r.rpc_error?.message ?? null), stored, ...(r.timed_out || r.transport_error !== null ? { indeterminate: true } : {}) });
          await d.reset();
        }
      }
    }
    return { check: ID, version: VERSION, resource: res.name, data: { probes: out, ...(in5 ? { in5 } : {}), cut, no_object: noObject, protected: protectedBy, not_probed: notProbed, halted: Object.fromEntries([...haltedIn(ctx.session)].filter(([k]) => toolsOf(res).some((x) => x.tool === k))) } };
  },
  evaluate(obs: Observation, ctx: PlanContext): Result[] {
    const res = ctx.manifest.resources.find((r) => r.name === obs.resource)!;
    const data = obs.data as { probes: ProbeObs[]; in5?: In5Obs[]; cut?: Record<string, { sent: number; total: number }>; no_object?: string[]; protected?: Record<string, string[]>; not_probed?: Record<string, string>; halted?: Record<string, string> };
    const np = data.not_probed ?? {};
    const none = [...(data.no_object ?? []), ...Object.keys(np)];
    const skipped = none.flatMap((tool) => (['MWS-IN-1', 'MWS-IN-2', 'MWS-IN-3', 'MWS-IN-4', 'MWS-IN-6', 'MWS-IN-7'] as const).map((id) => result(id, wp(res.name, tool), { id: ID, version: VERSION }, 'not tested', `${tool} was not probed: ${np[tool] ?? 'the resource has no object of the run to read (no update tool declared)'}`)));
    const all = [...schemaVerdicts(data.probes, res, ctx.tools, ctx, data.cut ?? {}, data.protected ?? {}).filter((r) => !none.includes(r.write_path.tool)), ...skipped, ...(data.in5 !== undefined ? in5Verdicts(data.in5, res, ctx.tools) : in5Halted(data.halted ?? {}, res, ctx.tools))];
    // why: spec R15-4, review of 3283a69 (2): after a failed put-back no further probe, control or value goes to the tool, and each
    // probe not sent for that reason is treated as one not judged: no record of the tool's MWS-IN-1 to IN-7 is held or not observed.
    const halted = { ...(data.halted ?? {}), ...Object.fromEntries((data.probes ?? []).filter((p) => p.halted).map((p) => [p.tool, p.not_sent ?? 'a put-back failed'])) };
    return all.map((r) => {
      const why = halted[r.write_path.tool];
      if (!why || !/^MWS-IN-[1-7]$/.test(r.requirement) || r.verdict === 'violated' || r.verdict === 'self-attested' || r.verdict === 'not applicable' || (r.verdict === 'not tested' && r.requirement !== 'MWS-IN-5') || /review-only/.test(r.reason)) return r;
      return result(r.requirement, r.write_path, r.scenario, 'not tested', `${r.write_path.tool} was not probed further after a failed put-back (spec R15-4): ${short(why, 300)}. The probes and values not sent are not judged, so this record is not ${r.verdict}. ${r.reason}`, { notes: r.notes });
    });
  },
};

/** How each refusal was known to refuse the probed value, counted by source (rule 11: the record says what decided it). */
export function refusedByNote(ps: ProbeObs[]): string[] {
  const by = new Map<string, number>();
  for (const p of ps) {
    const k = (p.refused_by ?? 'the error names the argument').replace(/ \(".*$/, '');
    by.set(k, (by.get(k) ?? 0) + 1);
  }
  return by.size ? [`Each refusal was known to refuse the probed value by: ${[...by].map(([k, n]) => `${k} (${n})`).join('; ')}.`] : [];
}

/** Why a refusal falls short of MWS-IN-4, or null when it is a clean tool execution error that names the field. */
/**
 * Why a refusal falls short of MWS-IN-4, or null. The requirement's two black-box clauses only: a
 * tool execution error (isError: true, not a JSON-RPC error) whose content contains the argument's
 * name. Runtime internals in the text are the requirement's guidance, not the requirement, so they
 * are noted (internalsIn) and never make a refusal violated.
 */
export function refusalProblem(p: ProbeObs): string | null {
  const text = p.rpc_error?.message ?? p.text ?? '';
  if (p.rpc_error) return `a JSON-RPC error (${p.rpc_error.code}) instead of a tool execution error (isError: true)`;
  if (!namesWhole(text, p.prop)) return `the error does not name the argument ${p.prop}`;
  return null;
}

/** K9 case 8: the argument named as a whole token (also inside a JSON Pointer or quotes), never inside another word ("id" in "Invalid"). */
export function namesWhole(text: string, prop: string): boolean {
  const esc = prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_])${esc}($|[^A-Za-z0-9_])`).test(text);
}

/**
 * K9: the one switch between the owner's options for a refusal with no counterpart of the same meaning, after the base call
 * succeeded at once: option C counts it as a rejection (no text read), option B leaves it to the name, a declared pattern or a
 * structured signal, otherwise "cannot tell".
 */
export const IN4_OPTION: { value: 'B' | 'C' } = { value: 'C' };
/**
 * Spec R15-4: a tool that updates one object named by its identifier: the resource's update tool, named by {{id}} or {{object}} in its
 * arguments, and not also its delete, selector, multi-item or list-edit tool. Checked at manifest load; checked again here.
 */
export function restorableTool(res: ResourceSpec, all: ResourceSpec[] = [res]): boolean {
  if (!res.update) return false;
  const roots = templateRoots(res.update.args);
  const t = res.update.tool;
  return (roots.has('id') || roots.has('object')) && all.every((x) => x.delete?.tool !== t && x.selector?.tool !== t && !x.multi.some((m) => m.tool === t) && x.list_edit?.tool !== t);
}

/** Spec R15-4: the update tools a failed put-back halted, run-wide (by session), with the reason: no further probe or control goes to them. */
const haltedTools = new WeakMap<object, Map<string, string>>();
export const haltedIn = (session: object): Map<string, string> => {
  let m = haltedTools.get(session);
  if (!m) haltedTools.set(session, (m = new Map()));
  return m;
};

export const in4NoCounterpart = (): 'rejection' | 'cannot_tell' => (IN4_OPTION.value === 'C' ? 'rejection' : 'cannot_tell');

/** The value of the declared type with the same meaning (MWS-IN-1's meaning-keeping uses), or null where there is none. */
export function counterpart(v: unknown, type: string | undefined, required: boolean): { value?: unknown; omit?: boolean; what: string } | null {
  if (v === null && !required) return { omit: true, what: 'the call without the argument' };
  if ((type === 'integer' || type === 'number') && typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) && (type === 'number' || Number.isInteger(Number(v)))) return { value: Number(v), what: `the number ${Number(v)}` };
  if (type === 'boolean' && (v === 'true' || v === 'false')) return { value: v === 'true', what: `the boolean ${v}` };
  if (type === 'string' && (typeof v === 'number' || typeof v === 'boolean')) return { value: String(v), what: `the string ${JSON.stringify(String(v))}` };
  return null;
}

/** Two answers alike, apart from the text of the two values (an exact comparison, not a reading). */
type Answer4 = { ok: boolean; isError: boolean; text: string | null; rpc_error: { code: number; message: string } | null };
/**
 * Two answers alike (spec R14-6), apart from the text of the two values and any word that differed between two sends of the probe
 * (`again`, the second send): an exact comparison, not a reading. Null where the two sends differ in a way that cannot be set aside
 * (a different form, or a different number of words).
 */
export function sameAnswer(a: Answer4, b: Answer4, vals: unknown[], again?: Answer4): boolean | null {
  const form = (x: Answer4) => `${x.ok}|${x.isError}|${x.rpc_error?.code ?? ''}`;
  const norm = (t: string | null) => {
    let x = t ?? '';
    for (const v of vals) if (v !== undefined && v !== null && String(v) !== '') x = x.split(JSON.stringify(v)).join('§').split(String(v)).join('§');
    return x.split(/\s+/).filter(Boolean);
  };
  const ta = norm(a.text ?? a.rpc_error?.message ?? null);
  let mask = new Set<number>();
  if (again) {
    if (form(again) !== form(a)) return null;
    const tg = norm(again.text ?? again.rpc_error?.message ?? null);
    if (tg.length !== ta.length) return null;
    mask = new Set(ta.map((w, i) => (w === tg[i] ? -1 : i)).filter((i) => i >= 0));
  }
  if (form(a) !== form(b)) return false;
  const tb = norm(b.text ?? b.rpc_error?.message ?? null);
  if (tb.length !== ta.length) return false;
  return ta.every((w, i) => mask.has(i) || w === tb[i]);
}

export const internalsIn = (p: ProbeObs): boolean => RAW_ERROR.test(p.rpc_error?.message ?? p.text ?? '');

export function schemaVerdicts(probes: ProbeObs[], res: ResourceSpec, tools: Tool[], ctx: PlanContext | null = null, cut: Record<string, { sent: number; total: number }> = {}, protectedBy: Record<string, string[]> = {}, only: string[] | null = null, scenario: { id: string; version: string } = { id: ID, version: VERSION }): Result[] {
  const sc = scenario;
  const out: Result[] = [];
  // why: B3 (lane F2): the write tools other than the update tool are judged here too, from the probes src/checks/inputwrites.ts made.
  for (const tool of only ?? toolsOf(res).map((x) => x.tool)) {
    if (!toolByName(tools, tool)) continue;
    const w = wp(res.name, tool);
    const all = probes.filter((p) => p.tool === tool);
    // why: a probe that was not sent (valid against the whole schema, not conforming, or a safety rule) is stated in the record and never judged.
    const notSent = all.filter((p) => p.not_sent);
    const mine = all.filter((p) => !p.not_sent);
    // why: spec 7.3, rule 1 (R6-3): probes that would replace, remove or misspell an identifier, a scope argument or a selector
    // of a write tool are not sent (on a tool that deletes or bulk-updates the rule requires it; this tester applies it to every write tool).
    const prot = protectedBy[tool] ?? [];
    const protNote = prot.length ? [`Not probed (spec 7.3, rule 1, and the run's own objects): ${prot.join(', ')}; a probe that replaces, removes or misspells an identifier, a scope argument, a selector or the version is not sent on a write tool.`] : [];
    const unsent = (req: string): string[] => {
      const xs = notSent.filter((p) => p.requirement === req);
      return [...protNote, ...(xs.length ? [`Not sent (${xs.length}): ${xs.slice(0, 6).map((p) => `${p.prop}=${p.value} (${p.name}): ${p.not_sent}`).join('; ')}${xs.length > 6 ? '; …' : ''}.`] : [])];
    };
    const setAside = mine.filter((p) => p.ok && STATUS_IN_TEXT.test(p.text ?? ''));
    const unknown = mine.filter((p) => p.indeterminate);
    const asOmitted = mine.filter((p) => p.as_omitted);
    const judged = mine.filter((p) => !setAside.includes(p) && !p.indeterminate && !p.as_omitted && !p.cannot_tell && !p.intermediate);
    const interimOf = (req: string): ProbeObs[] => mine.filter((p) => p.intermediate && p.requirement === req);
    // why: an input_required answer is intermediate: what the tool does with a value or an argument shows only in a final result.
    const interimWhyOf = (xs: ProbeObs[]): string => `${INTERMEDIATE} (${tool} answered ${xs.slice(0, 4).map((p) => `${p.prop}=${p.value} (${p.name})`).join(', ')}${xs.length > 4 ? ', …' : ''} with input_required, and no final result was seen: the declaration gives no answers for the input request, or the retry asked again)`;
    /** Records from `from` on: a held one becomes not tested (not every probe was judged); any other gets the note. */
    const interimApply = (from: number, xs: ProbeObs[]): void => {
      if (!xs.length) return;
      const why = interimWhyOf(xs);
      for (let i = from; i < out.length; i++) {
        const r = out[i]!;
        if (r.verdict === 'held') out[i] = result(r.requirement, w, sc, 'not tested', why, { steps: xs.map((p) => p.step), notes: r.notes });
        else if (r.verdict === 'violated') r.notes.push(`${why}.`);
      }
    };
    const interim = interimOf('MWS-IN-2');
    const cannot = mine.filter((p) => p.cannot_tell);
    const firstOut = out.length;
    // MWS-IN-1 (meaning rule) and MWS-IN-6 (any accepted probe), on the same probes.
    {
      const firstIn1 = out.length;
      const interim1 = interimOf('MWS-IN-1');
      const built = mine.filter((p) => p.requirement === 'MWS-IN-1');
      const cases = judged.filter((p) => p.requirement === 'MWS-IN-1');
      const accepted = cases.filter((p) => p.ok);
      const listed = `probe list version ${PROBE_LIST_VERSION}`;
      const notes = [...unsent('MWS-IN-1'), ...setAside.filter((p) => p.requirement === 'MWS-IN-1').map((p) => ruleNote('STATUS_IN_RESULT', `${p.prop}=${p.value} (${p.name}) returned success carrying an HTTP error status`)), ...unknown.filter((p) => p.requirement === 'MWS-IN-1').map((p) => `${p.prop}=${p.value} (${p.name}): the outcome is unknown (timeout or broken connection); not judged`), ...asOmitted.map((p) => `${p.prop}=null: the answer was the same as without the argument (null treated as not sent, which keeps the meaning); not judged as a refusal`)];
      const ms = accepted.map((p) => ({ p, m: p.meaning && p.meaning.kind !== 'unknown' ? p.meaning : null }));
      const changes = ms.filter((x) => x.m?.kind === 'changes');
      const unsure = ms.filter((x) => !x.m);
      const obsv = ms.filter((x) => x.m?.kind === 'observation');
      const obsNotes = obsv.map((x) => `Observation: ${x.p.prop}: ${x.m!.why} (not a change of meaning by the cases the spec lists).`);
      const kept = ms.filter((x) => x.m?.kind === 'keeps').map((x) => `${x.p.prop}: ${x.m!.why} (spec NF-21: judged by MWS-IN-6).`);
      if (!built.length && cut[tool]) {
        for (const r of ['MWS-IN-1', 'MWS-IN-6'] as const) out.push(result(r, w, sc, 'not tested', `the probe list for ${tool} was cut at limits.max_fuzz_cases (${cut[tool]!.sent} of ${cut[tool]!.total} sent) before any type probe (raise the limit)`, { notes }));
      } else if (!built.length && (notSent.some((p) => p.requirement === 'MWS-IN-1') || prot.length)) {
        for (const r of ['MWS-IN-1', 'MWS-IN-6'] as const) out.push(result(r, w, sc, 'not tested', `no type probe of ${tool} could be sent`, { notes }));
      } else if (!built.length) {
        out.push(result('MWS-IN-1', w, sc, 'not applicable', `the input schema of ${tool} declares no typed argument that the tester may probe`, { notes }));
        out.push(result('MWS-IN-6', w, sc, 'not applicable', `the input schema of ${tool} declares no typed argument that the tester may probe`, { notes }));
      } else if (!cases.length && interim1.length) {
        for (const r of ['MWS-IN-1', 'MWS-IN-6'] as const) out.push(result(r, w, sc, 'not tested', interimWhyOf(interim1), { steps: interim1.map((p) => p.step), notes }));
      } else if (!cases.length) {
        for (const r of ['MWS-IN-1', 'MWS-IN-6'] as const) out.push(result(r, w, sc, 'not tested', `every probe of ${tool} was set aside or had an unknown outcome`, { notes }));
      } else {
        if (changes.length) out.push(result('MWS-IN-1', w, sc, 'violated', `${tool} accepted a value of another type and used it with another meaning: ${changes.slice(0, 5).map((x) => `${x.p.prop}: ${x.m!.why}`).join('; ')}${changes.length > 5 ? '; …' : ''} (${listed}).`, { numbers: { probes: cases.length, accepted: accepted.length, meaning_changed: changes.length }, steps: changes.flatMap((x) => x.p.meaning_steps ?? [x.p.step]), notes: [...notes, ...obsNotes] }));
        else if (unsure.length) out.push(result('MWS-IN-1', w, sc, 'not tested', `${tool} accepted ${unsure.length} probe(s) whose value as used could not be established: ${unsure.slice(0, 5).map((x) => `${x.p.prop}=${x.p.value} (${x.p.name})`).join('; ')} (${listed}).`, { numbers: { probes: cases.length, accepted: accepted.length }, steps: unsure.map((x) => x.p.step), notes: [...notes, ...obsNotes, ...kept] }));
        else out.push(result('MWS-IN-1', w, sc, 'held', `No probe accepted by ${tool} changed the meaning of the value sent (${cases.length} probe(s), ${accepted.length} accepted; ${listed}).`, { numbers: { probes: cases.length, accepted: accepted.length }, notes: [...notes, ...obsNotes, ...kept] }));
        const dropped = asOmitted.filter((p) => p.requirement === 'MWS-IN-1');
        // why: a null treated as not sent was dropped, not rejected: it counts against MWS-IN-6 (review).
        if (accepted.length + dropped.length) out.push(result('MWS-IN-6', w, sc, 'violated', `${tool} accepted or dropped ${accepted.length + dropped.length} of ${cases.length + dropped.length} value(s) of a type its schema does not declare, instead of rejecting them: ${[...accepted, ...dropped].slice(0, 6).map((p) => `${p.prop}=${p.value} (${p.name})`).join('; ')}${accepted.length + dropped.length > 6 ? '; …' : ''} (${listed}).`, { numbers: { probes: cases.length + dropped.length, accepted: accepted.length, dropped: dropped.length }, steps: [...accepted, ...dropped].map((p) => p.step), notes }));
        else out.push(result('MWS-IN-6', w, sc, 'held', `${tool} rejected all ${cases.length} value(s) of another type (${listed}).`, { numbers: { probes: cases.length }, notes }));
        interimApply(firstIn1, interim1);
      }
    }
    // MWS-IN-2 (MUST: not dropped silently) and MWS-IN-7 (SHOULD: rejected), on the same two probes.
    {
      const built = mine.filter((p) => p.requirement === 'MWS-IN-2');
      const cases = judged.filter((p) => p.requirement === 'MWS-IN-2');
      // why: spec MWS-IN-2 (R7-5): the record states the name and the value of each extra argument sent.
      const sentLine = built.length ? [`Extra arguments sent: ${built.map((p) => `${p.name === 'misspelled_argument' ? 'a misspelling' : 'an unrelated name'}, ${p.prop}=${p.value}`).join('; ')}${built.some((p) => p.name === 'misspelled_argument') ? '' : ' (no argument long enough to misspell, so only the unrelated probe)'}.`] : [];
      // why: an input_required answer is intermediate: what the tool does with the argument shows only in a final result.
      const firstIn2 = out.length;
      if (!built.length) {
        for (const r of ['MWS-IN-2', 'MWS-IN-7'] as const) out.push(result(r, w, sc, 'not applicable', `the input schema of ${tool} allows additional properties`));
      } else if (!cases.length && interim.length) {
        for (const r of ['MWS-IN-2', 'MWS-IN-7'] as const) out.push(result(r, w, sc, 'not tested', interimWhyOf(interim), { steps: interim.map((p) => p.step), notes: sentLine }));
      } else if (!cases.length) {
        for (const r of ['MWS-IN-2', 'MWS-IN-7'] as const) out.push(result(r, w, sc, 'not tested', `every extra-argument probe of ${tool} had an unknown outcome`, { notes: sentLine }));
      } else {
        const had = cases.filter((p) => p.ok && p.effect && p.effect.length);
        const unknownEffect = cases.filter((p) => p.ok && p.role !== 'read' && p.effect === null);
        const rest = cases.filter((p) => !had.includes(p) && !unknownEffect.includes(p));
        // why: spec 7.3 rule 11: what a result says is decided by the declaration's pattern or a person's reading. Where only the
        // default pattern is in effect and the answer names the argument without matching it, the tester cannot decide: the
        // record is not tested with the text quoted, never violated. An answer that does not name the argument at all does not
        // say it was not used, whatever the pattern.
        // why (declared-carryover): a notice that names the argument and that the declared pattern does not read either
        // way needs reading; only an answer that does not name the argument at all is silent.
        const unclear = rest.filter((p) => p.ok && !saysNotUsed(p.text ?? '', p.prop) && (p.text ?? '').includes(p.prop));
        const silent = rest.filter((p) => p.ok && !saysNotUsed(p.text ?? '', p.prop) && !unclear.includes(p));
        const told = rest.filter((p) => p.ok && saysNotUsed(p.text ?? '', p.prop));
        const notes = [...sentLine, ...had.map((p) => `Observation: ${p.prop} (${p.name}) had an effect (${p.effect!.join(', ')}), so it was not dropped; not judged here (see MWS-IN-7).`), ...unknownEffect.map((p) => `${p.prop} (${p.name}): accepted, and the object did not read back; not judged.`), ...told.map((p) => `${p.prop} (${p.name}): accepted. ${saidBy('not_used', p.text ?? '')}`), ...rest.filter((p) => p.ok && !told.includes(p) && p.text).map((p) => `${p.prop} (${p.name}): accepted; the result was not read as saying the argument was not used. ${saidBy('not_used', p.text ?? '')}`)];
        if (silent.length) out.push(result('MWS-IN-2', w, sc, 'violated', `${tool} accepted ${silent.map((p) => `${p.prop} (${p.name})`).join(' and ')}, an argument its schema does not define; the result does not say it was not used${silent[0]!.text ? ` (it says: ${JSON.stringify(short(silent[0]!.text, 160))})` : ''}${silent[0]!.role !== 'read' ? ', and the read-back shows no effect' : ''}.`, { steps: silent.map((p) => p.step), notes }));
        else if (unclear.length) out.push(result('MWS-IN-2', w, sc, 'not tested', `${tool} accepted ${unclear.map((p) => `${p.prop} (${p.name})`).join(' and ')} and its answer names the argument, but whether it says the argument was not used needs reading: it does not match the ${fromDeclaration('not_used') ? 'declared patterns.not_used' : 'default pattern for "not used", and the declaration gives none'} (spec 7.3, rule 11). The answer, where it names ${unclear[0]!.prop}: ${JSON.stringify(around(unclear[0]!.text ?? '', unclear[0]!.prop))}. Declare patterns.not_used, or read it.`, { notes }));
        // why: gate-2 re-run on 378f32f (note 19, R11; rule 11): a notice read as "not used" by the default pattern alone ("was not
        // ignored", "unused quota") decides nothing either way; only a declared patterns.not_used gives held.
        else if (told.length && !fromDeclaration('not_used')) out.push(result('MWS-IN-2', w, sc, 'not tested', `${tool} accepted ${told.map((p) => `${p.prop} (${p.name})`).join(' and ')} and its answer names the argument; only the tester's default pattern for "not used" reads it as saying the argument was not used, and a default pattern alone decides nothing (spec 7.3, rule 11). The answer, where it names ${told[0]!.prop}: ${JSON.stringify(around(told[0]!.text ?? '', told[0]!.prop))}. Declare patterns.not_used, or read it.`, { notes }));
        else if (!rest.length) out.push(result('MWS-IN-2', w, sc, 'not tested', `every extra argument sent to ${tool} had an effect or an unknown effect, so none was dropped to judge`, { notes }));
        else out.push(result('MWS-IN-2', w, sc, 'held', `${tool} rejected ${rest.filter((p) => !p.ok).length} and named as not used ${told.length} of the ${rest.length} extra argument(s) judged.`, { notes }));
        const acc = cases.filter((p) => p.ok);
        if (acc.length) out.push(result('MWS-IN-7', w, sc, 'violated', `${tool} accepted ${acc.map((p) => `${p.prop} (${p.name})`).join(' and ')}, an argument its schema does not define, instead of rejecting it.`, { steps: acc.map((p) => p.step), notes: sentLine }));
        else out.push(result('MWS-IN-7', w, sc, 'held', `${tool} rejected each of the ${cases.length} extra argument(s).`, { notes: sentLine }));
        // why: "held" needs every extra argument judged; one with only an intermediate answer leaves the record not tested.
        interimApply(firstIn2, interim);
      }
    }
    for (const req of ['MWS-IN-3'] as const) {
      const cases = judged.filter((p) => p.requirement === req);
      const accepted = cases.filter((p) => p.ok);
      const notes = [...unsent(req), ...setAside.filter((p) => p.requirement === req).map((p) => ruleNote('STATUS_IN_RESULT', `${p.prop}=${p.value} (${p.name}) returned success carrying an HTTP error status`)), ...unknown.filter((p) => p.requirement === req).map((p) => `${p.prop}=${p.value} (${p.name}): the outcome is unknown (timeout or broken connection); not judged`)];
      // why: IN-1 applies to a declared type and IN-3 to a declared bound or enumeration; a schema with none makes the condition false.
      const built = mine.filter((p) => p.requirement === req);
      const interim3 = interimOf(req);
      const firstIn3 = out.length;
      if (!built.length && cut[tool]) out.push(result(req, w, sc, 'not tested', `the probe list for ${tool} was cut at limits.max_fuzz_cases (${cut[tool]!.sent} of ${cut[tool]!.total} sent) before any ${req} probe (raise the limit)`, { notes }));
      else if (!built.length && (notSent.some((p) => p.requirement === req) || prot.length)) out.push(result(req, w, sc, 'not tested', `no constraint probe of ${tool} could be sent`, { notes }));
      else if (!built.length) out.push(result(req, w, sc, 'not applicable', `the input schema of ${tool} declares no constraint keyword (that the tester may probe)`, { notes }));
      else if (!cases.length && interim3.length) out.push(result(req, w, sc, 'not tested', interimWhyOf(interim3), { steps: interim3.map((p) => p.step), notes }));
      else if (!cases.length) out.push(result(req, w, sc, 'not tested', `every probe of ${tool} for ${req} was set aside or had an unknown outcome`, { notes }));
      else if (accepted.length) out.push(result(req, w, sc, 'violated', `${tool} accepted ${accepted.length} of ${cases.length} value(s) its schema does not allow: ${accepted.slice(0, 6).map((p) => `${p.prop}=${p.value} (${p.name})`).join('; ')}${accepted.length > 6 ? '; …' : ''}.`, { numbers: { cases: cases.length, accepted: accepted.length }, steps: accepted.map((p) => p.step), notes }));
      else out.push(result(req, w, sc, 'held', `${tool} refused all ${cases.length} invalid value(s).`, { numbers: { cases: cases.length }, notes }));
      interimApply(firstIn3, interim3);
    }
    // why: R6-2: a rejection that MCP itself requires or defines as a JSON-RPC error is not judged by MWS-IN-4.
    const defined = judged.filter((p) => !p.ok && mcpDefinedError(p.rpc_error));
    const definedNote = defined.length ? [`Not judged (${defined.length}): a JSON-RPC error that the MCP specification defines for the case: ${defined.slice(0, 4).map((p) => `${p.prop} (${p.name}): ${mcpDefinedError(p.rpc_error)}, ${JSON.stringify(short(p.rpc_error!.message, 100))}`).join('; ')}.`] : [];
    const refusals = judged.filter((p) => !p.ok && !defined.includes(p));
    const bad = refusals.map((p) => ({ p, why: refusalProblem(p) })).filter((x) => x.why !== null);
    if (!refusals.length) out.push(result('MWS-IN-4', w, sc, 'not tested', `${tool} refused nothing in this check that MWS-IN-4 judges, so no validation error could be examined`, { notes: definedNote }));
    else if (bad.length) out.push(result('MWS-IN-4', w, sc, 'violated', `${bad.length} of ${refusals.length} refusal(s) by ${tool} fall short: ${bad.slice(0, 4).map((x) => `${x.p.prop} (${x.p.name}): ${x.why}`).join('; ')}${bad.length > 4 ? '; …' : ''}.`, { numbers: { refusals: refusals.length, short_of_requirement: bad.length }, steps: bad.map((x) => x.p.step), notes: definedNote }));
    else out.push(result('MWS-IN-4', w, sc, 'held', `All ${refusals.length} refusal(s) by ${tool} were tool execution errors naming the argument.`, { numbers: { refusals: refusals.length }, notes: [...definedNote, ...refusedByNote(refusals), 'Whether each also gives the reason is a separate, review-only record.', 'Only the refusals of the schema probes (MWS-IN-1 to IN-3) were judged, as the test method says. A refusal by the backend of a value the schema allows is not provoked here; a call declared under failures is judged under MWS-RES-2.'] }));
    const internals = refusals.filter(internalsIn);
    if (internals.length) out[out.length - 1]!.notes.push(`Guidance, not judged: ${internals.length} refusal(s) expose runtime internals (${internals.slice(0, 3).map((p) => `${p.prop} (${p.name})`).join(', ')}).`);
    // why: R10-3: a record with a probe the tester could not tell is never held; the probe is quoted.
    for (let i = firstOut; i < out.length; i++) {
      const r = out[i]!;
      if (r.write_path.tool !== tool || r.verdict !== 'held') continue;
      const rel = cannot.filter((p) => (r.requirement === 'MWS-IN-4' ? true : r.requirement === 'MWS-IN-6' ? p.requirement === 'MWS-IN-1' : r.requirement === 'MWS-IN-7' ? p.requirement === 'MWS-IN-2' : p.requirement === r.requirement));
      if (rel.length) out[i] = result(r.requirement, w, sc, 'not tested', `${rel.length} probe(s) of ${tool} were answered with an error that was not judged, because a control of spec R14-6 failed or could not be sent, so this record is not held: ${[...rel].sort((a, b) => Number(!/for clean-up|does not show/.test(a.control ?? '')) - Number(!/for clean-up|does not show/.test(b.control ?? ''))).slice(0, 3).map((p) => `${p.prop}=${p.value} (${p.name}): ${p.control ?? 'a control failed'}; the error: ${JSON.stringify(short(p.text ?? p.rpc_error?.message ?? '', 120))}`).join('; ')}${rel.length > 3 ? '; …' : ''}`, { notes: r.notes });
    }
    // MWS-IN-4, review-only: does each rejection give the reason?
    // why: "every probe in the list" is needed for held; a list cut at max_fuzz_cases cannot give it.
    if (cut[tool]) for (const [i, r] of out.entries()) if (r.write_path.tool === tool && r.verdict === 'held' && ['MWS-IN-1', 'MWS-IN-3', 'MWS-IN-6', 'MWS-IN-7', 'MWS-IN-2'].includes(r.requirement)) out[i] = result(r.requirement, w, sc, 'not tested', `the probe list for ${tool} was cut at limits.max_fuzz_cases (${cut[tool]!.sent} of ${cut[tool]!.total} sent), so "every probe" was not sent (raise the limit)`, { notes: r.notes });
    const tooled = refusals.filter((p) => !p.rpc_error && p.isError);
    if (tooled.length && ctx) {
      const q: Question = { id: questionId('MWS-IN-4', w, 'reason'), requirement: 'MWS-IN-4', write_path: w, question: `Does each rejection by ${tool} give the reason the argument was refused?`, evidence: tooled.slice(0, 20).map((p) => ({ step: p.step, text: short(p.text ?? '', 400) })) };
      out.push(reviewResult(sc, q, answerOf(ctx, q, ctx.review?.rejection_gives_reason ?? null)));
    }
  }
  return out;
}
