/**
 * MWS-IN-5, the probe generator (lane F7): values that are VALID by a tool's input schema and that commonly hit a limit the
 * schema does not declare. Deterministic and schema-driven; no network, no model. Each value is checked against the
 * argument's own schema and against the tool's whole input schema with the tester's validator (core/jsonschema.ts): a value
 * that is not valid by the schema is never a probe (it would be MWS-IN-3, not IN-5).
 *
 * The classes (state of practice: boundary values as in Schemathesis's coverage phase; the length and range grid that
 * backends commonly enforce without saying so):
 *
 *   strings   lengths 0, 1, 255, 256, 1024, 4096, 65536 (each kept within minLength..maxLength; a length above maxLength is
 *             replaced by maxLength itself), capped at the payload cap; character classes at a short length: non-ASCII
 *             letters, astral emoji, right-to-left text, control characters other than NUL, leading and trailing space,
 *             path-like and URL-like characters, markup and quotes; each with a plain ASCII neighbour of the same length
 *   formats   date-time, date, time, email, uri, uuid: extremes that are valid by the format (the generic classes are not
 *             sent, because they are not valid by the format)
 *   numbers   0, 1, -1, 2^31-1, 2^31, -2^31, 2^53-1, and 0.5 and 1.5 where the type is number
 *   arrays    0, 1, 100 and 1000 items (within minItems..maxItems, capped by the payload), of an item valid by `items`
 *   skipped   enum, const and boolean arguments (every value is declared), objects (nested levels are not built), and an
 *             argument for which no valid value of a class can be made
 *
 * Hints (static): bounds a description or a document the declaration names states in words ("up to 100 characters",
 * "between 1 and 50") add probes at N and N+1. The extractor is an interface, so a model-based extractor can be plugged in
 * later without a dependency here (HintExtractor).
 */

import { validates } from '../core/jsonschema.js';
import { isObj, type Obj } from '../core/util.js';

/** The order a class of probes lies on: a string's length, a number's value, an array's item count. None for character classes. */
export type Dim = 'length' | 'value' | 'items';

export interface In5Probe {
  arg: string;
  /** The class, e.g. `length`, `chars.emoji`, `plain`, `number`, `items`, `format.date-time`, `hint`, `declared`. */
  cls: string;
  value: unknown;
  /** Position on the order of its class (length, value or item count), for the boundary search. */
  dim?: Dim;
  n?: number;
  /** For a character class: the length of the plain neighbour it is compared with. */
  plain_len?: number;
  /** Where the probe came from: the generator, a hint (with its source), or the declaration (try_values). */
  source: 'generator' | 'hint' | 'declared';
  why: string;
}

/** A bound a text states for one argument (a description or a document). */
export interface Hint {
  arg: string;
  kind: 'max' | 'min' | 'charset' | 'pattern';
  /** For max and min: the number; the unit says what it counts. */
  n?: number;
  unit?: 'characters' | 'items' | 'bytes' | 'value';
  /** For charset and pattern: the words or the expression quoted. */
  text?: string;
  /** Where the words are: `description of <tool>`, `description of <tool>.<arg>`, or a document path. */
  source: string;
  quote: string;
}

/** Plug-in point: a source of hints for one tool. The built-in one is regexHints; a model-based one may be added later. */
export interface HintExtractor {
  name: string;
  hints(tool: { name: string; description?: string; inputSchema?: unknown }, docs: { path: string; text: string }[]): Hint[];
}

export const STRING_LENGTHS = [0, 1, 255, 256, 1024, 4096, 65536] as const;
export const NUMBERS = [0, 1, -1, 2 ** 31 - 1, 2 ** 31, -(2 ** 31), Number.MAX_SAFE_INTEGER] as const;
export const FRACTIONS = [0.5, 1.5] as const;
export const ARRAY_SIZES = [0, 1, 100, 1000] as const;
export const DEFAULT_PAYLOAD_BYTES = 64 * 1024;

/** Character classes, at a short length; NUL is never sent (a transport may cut a string there). */
export const CHAR_CLASSES: [string, string][] = [
  ['chars.non_ascii', 'ünïcødé çà'],
  ['chars.emoji', '🙂🚀 ok 🎉'],
  ['chars.rtl', 'مرحبا שלום'],
  ['chars.control', 'a\tb\u0001c\u001fd'],
  ['chars.edge_space', '  padded  '],
  ['chars.path', '../a/b\\c:d'],
  ['chars.url', 'https://example.invalid/a?b=c&d=%20#e'],
  ['chars.markup', '<b>"q\'</b>&amp;'],
];

const FORMATS: Record<string, string[]> = {
  'date-time': ['1970-01-01T00:00:00Z', '0001-01-01T00:00:00Z', '9999-12-31T23:59:59Z', '2026-02-28T23:59:59.999+14:00'],
  date: ['1970-01-01', '0001-01-01', '9999-12-31'],
  time: ['00:00:00Z', '23:59:59.999Z'],
  email: ['a@b.co', `${'a'.repeat(64)}@example.com`],
  uri: ['https://example.invalid/', `https://example.invalid/${'a'.repeat(2000)}`],
  uuid: ['00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff'],
};

const typesOf = (s: Obj): string[] => (Array.isArray(s['type']) ? (s['type'] as unknown[]).map(String) : typeof s['type'] === 'string' ? [s['type']] : []);
const num = (s: Obj, k: string): number | null => (typeof s[k] === 'number' ? (s[k] as number) : null);
/** A value's size against the payload cap: a string's UTF-8 bytes, otherwise the bytes of its JSON form. */
const bytes = (v: unknown): number => Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v ?? null), 'utf8');

export interface GenOptions {
  /** The largest value that is sent, in bytes (a string's UTF-8 bytes, otherwise its JSON form; default 64 KB). */
  payload_bytes?: number;
  /** The run prefix, for an argument whose value names the object for cleanup: every string sent there starts with it. */
  keep_prefix?: string | null;
  hints?: Hint[];
  /**
   * Whether the tool reads or writes (default write). Safety defaults (review M8): on a read tool a number above 1 is sent only
   * up to a declared maximum (a huge `limit`, `per_page` or `depth` is a load on the backend, not a probe); on a write tool an
   * array has 0, 1 or 2 items, plus the declared maxItems (each item may be a write of its own).
   */
  role?: 'read' | 'write';
}

/** The integer range a `format` declares (int32, int64), or null (review S2: a value outside it is not valid by the format). */
function intRange(s: Obj): [number, number] | null {
  if (s['format'] === 'int32') return [-(2 ** 31), 2 ** 31 - 1];
  if (s['format'] === 'int64') return [-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
  if (s['format'] === 'uint32') return [0, 2 ** 32 - 1];
  return null;
}

/** An items schema whose values the tester's validator cannot check in full (a format, an encoding, a media type). */
const opaqueItems = (it: Obj): boolean => ['format', 'contentEncoding', 'contentMediaType', 'contentSchema'].some((k) => Object.hasOwn(it, k));

/** The most items an array probe has, whatever a schema or a text states (review M6). */
export const MAX_ITEMS = 100_000;

/**
 * The probes for one argument, each valid by the argument's schema and by the whole input schema with `base` as the other
 * arguments. `skipped` says why an argument gives none; `rule` is set where it is not searched by rule (an enum or const, a
 * boolean, an object, an opaque format), so the record can count the arguments that are searchable.
 */
export function in5Probes(schema: unknown, base: Obj | null, arg: string, o: GenOptions = {}): { probes: In5Probe[]; skipped: string | null; rule?: string } {
  const props = isObj(schema) && isObj(schema['properties']) ? (schema['properties'] as Obj) : {};
  const s = props[arg];
  if (!isObj(s)) return { probes: [], skipped: 'the input schema gives no schema for it', rule: 'no schema' };
  const cap = o.payload_bytes ?? DEFAULT_PAYLOAD_BYTES;
  const pre = o.keep_prefix ?? null;
  const read = o.role === 'read';
  const types = typesOf(s);
  if (Array.isArray(s['enum']) || Object.hasOwn(s, 'const')) return { probes: [], skipped: 'every value it may take is declared (enum or const)', rule: 'enum or const' };
  const t = types.find((x) => x !== 'null') ?? '';
  const out: In5Probe[] = [];
  const hints = (o.hints ?? []).filter((h) => h.arg === arg);
  const add = (p: Omit<In5Probe, 'arg'>) => {
    if (bytes(p.value) > cap) return;
    if (validates(s, p.value, schema) !== true) return;
    // why: at plan time there is no base call yet (null): only the argument's own schema is checked there.
    if (base !== null && validates(schema, { ...base, [arg]: p.value }) !== true) return;
    if (out.some((x) => JSON.stringify(x.value) === JSON.stringify(p.value))) return;
    out.push({ arg, ...p });
  };
  if (t === 'string') {
    const fmt = typeof s['format'] === 'string' ? (s['format'] as string) : null;
    if (fmt) {
      const vals = FORMATS[fmt];
      if (!vals) return { probes: [], skipped: `its format ${fmt} has no probe values valid by that format in this release`, rule: 'format' };
      for (const v of vals) add({ cls: `format.${fmt}`, value: v, source: 'generator', why: `an extreme valid by format ${fmt}` });
      return { probes: out, skipped: out.length ? null : 'no value of its format is valid by the rest of its schema' };
    }
    if (opaqueItems(s)) return { probes: [], skipped: 'its content has an encoding or media type the tester does not check', rule: 'format' };
    const min = num(s, 'minLength') ?? 0;
    const max = num(s, 'maxLength');
    // why: review M6: a length is checked against the payload cap before any string is built (the run prefix is ASCII).
    const str = (n: number): string | null => {
      if (!Number.isSafeInteger(n) || n < 0 || n > cap) return null;
      if (pre) return n >= pre.length ? `${pre}${'x'.repeat(n - pre.length)}` : null;
      return 'x'.repeat(n);
    };
    const lengths = new Set<number>();
    for (const L of STRING_LENGTHS) lengths.add(Math.max(min, max !== null ? Math.min(L, max) : L));
    for (const h of hints) if (h.n !== undefined && (h.kind === 'max' || h.kind === 'min') && h.unit !== 'items' && h.unit !== 'value') for (const L of h.kind === 'max' ? [h.n, h.n + 1] : [h.n - 1, h.n]) if (L >= 0) lengths.add(L);
    for (const L of [...lengths].sort((a, b) => a - b)) {
      const v = str(L);
      if (v === null) continue;
      const fromHint = hints.find((h) => h.n !== undefined && (L === h.n || L === h.n + 1 || L === h.n - 1));
      const hinted = !!fromHint && !STRING_LENGTHS.includes(L as (typeof STRING_LENGTHS)[number]);
      add({ cls: hinted ? 'hint' : 'length', value: v, dim: 'length', n: L, source: hinted ? 'hint' : 'generator', why: hinted ? `${L} characters, at a bound stated in ${fromHint!.source} (${JSON.stringify(fromHint!.quote)})` : `${L} characters` });
    }
    for (const [cls, chars] of CHAR_CLASSES) {
      const v = pre ? `${pre}${chars}` : chars;
      // why: review S3: JSON Schema counts code points, many validators count UTF-16 units. A class whose two counts would fall
      // on either side of a declared maxLength is not sent, and its plain neighbour has the larger count (the UTF-16 length), so
      // that a refusal of the class cannot be a refusal of its length under either count.
      const units = v.length;
      if (max !== null && units > max) continue;
      const plain = str(units);
      if (plain === null) continue;
      const before = out.length;
      add({ cls, value: v, plain_len: units, source: 'generator', why: `${cls.slice(6).replace('_', ' ')} characters` });
      // why: a character class is judged only beside a plain value of the same length (its neighbour, differential rule (a)).
      if (out.length > before) add({ cls: 'plain', value: plain, dim: 'length', n: units, source: 'generator', why: `${units} plain characters (the neighbour of the character classes)` });
    }
    return { probes: out, skipped: out.length ? null : 'no probe value is valid by its schema (a pattern, or a length the run prefix cannot meet)' };
  }
  if (t === 'integer' || t === 'number') {
    const declMax = num(s, 'maximum') ?? (num(s, 'exclusiveMaximum') !== null ? num(s, 'exclusiveMaximum')! - (t === 'integer' ? 1 : 0.5) : null);
    const declMin = num(s, 'minimum') ?? (num(s, 'exclusiveMinimum') !== null ? num(s, 'exclusiveMinimum')! + (t === 'integer' ? 1 : 0.5) : null);
    const vals: number[] = read ? [0, 1, -1, ...(declMax !== null ? [declMax] : []), ...(declMin !== null ? [declMin] : [])] : [...NUMBERS, ...(t === 'number' ? FRACTIONS : [])];
    if (!read && declMax !== null) vals.push(declMax);
    if (t === 'number') vals.push(...FRACTIONS);
    for (const h of hints) if (h.n !== undefined && h.unit === 'value') vals.push(...(h.kind === 'max' ? [h.n, h.n + 1] : [h.n - 1, h.n]));
    const range = intRange(s);
    for (const v of [...new Set(vals)].sort((a, b) => a - b)) {
      if (range && (v < range[0] || v > range[1])) continue;
      // why: review M8: on a read tool nothing above a declared maximum, and nothing above 1 where none is declared.
      if (read && v > 1 && (declMax === null || v > declMax)) continue;
      const fromHint = hints.some((h) => h.n !== undefined && h.unit === 'value' && Math.abs(h.n - v) <= 1) && !(NUMBERS as readonly number[]).includes(v);
      add({ cls: fromHint ? 'hint' : 'number', value: v, dim: 'value', n: v, source: fromHint ? 'hint' : 'generator', why: fromHint ? `${v}, at a bound a text states` : String(v) });
    }
    return { probes: out, skipped: out.length ? null : 'no probe value is valid by its schema' };
  }
  if (t === 'array') {
    const items = isObj(s['items']) ? (s['items'] as Obj) : {};
    const it = itemMaker(items);
    if (!it) return { probes: [], skipped: opaqueItems(items) ? 'its items have a format or an encoding the tester does not check, so an item valid by the schema cannot be made' : 'no item valid by its items schema could be made', ...(opaqueItems(items) ? { rule: 'format' } : {}) };
    const min = num(s, 'minItems') ?? 0;
    const max = num(s, 'maxItems');
    const sizes = new Set<number>();
    const grid = read ? ARRAY_SIZES : ([0, 1, 2] as const);
    for (const n of grid) sizes.add(Math.max(min, max !== null ? Math.min(n, max) : n));
    if (!read && max !== null) sizes.add(max);
    for (const h of hints) if (h.n !== undefined && h.unit === 'items') for (const n of h.kind === 'max' ? [h.n, h.n + 1] : [h.n - 1, h.n]) if (n >= 0) sizes.add(n);
    // why: review M6: the size of an array is estimated from one item before it is built.
    const per = bytes(it(0)) + 1;
    for (const n of [...sizes].sort((a, b) => a - b)) {
      if (!Number.isSafeInteger(n) || n > MAX_ITEMS || n * per + 2 > cap) continue;
      add({ cls: 'items', value: Array.from({ length: n }, (_, i) => it(i)), dim: 'items', n, source: 'generator', why: `${n} items` });
    }
    return { probes: out, skipped: out.length ? null : 'no probe value is valid by its schema' };
  }
  if (t === 'boolean') return { probes: [], skipped: 'a boolean: both values are declared', rule: 'boolean' };
  if (t === 'object') return { probes: [], skipped: 'an object: nested levels are not searched in this release', rule: 'object' };
  return { probes: [], skipped: t ? `type ${t} is not searched` : 'its schema declares no type', rule: t ? `type ${t}` : 'no type' };
}

/**
 * The value at position `n` of an order, for the bisection: a string of n characters (starting with the run prefix where the
 * argument must keep it), the number n, or an array of n items. Null where none can be made, or where it would be larger than
 * the payload cap (checked before it is built); the caller checks validity.
 */
export function orderedValue(argSchema: unknown, dim: Dim, n: number, keepPrefix: string | null = null, cap = DEFAULT_PAYLOAD_BYTES): unknown {
  if (dim === 'value') return n;
  if (!Number.isSafeInteger(n) || n < 0) return null;
  if (dim === 'length') {
    if (n > cap) return null;
    if (keepPrefix) return n >= keepPrefix.length ? `${keepPrefix}${'x'.repeat(n - keepPrefix.length)}` : null;
    return 'x'.repeat(n);
  }
  const it = itemMaker(isObj(argSchema) && isObj(argSchema['items']) ? (argSchema['items'] as Obj) : {});
  if (!it || n > MAX_ITEMS || n * (bytes(it(0)) + 1) + 2 > cap) return null;
  return Array.from({ length: n }, (_, i) => it(i));
}

/** A maker of distinct items valid by an items schema (strings, numbers, enums), or null. */
function itemMaker(items: Obj): ((i: number) => unknown) | null {
  // why: review M2: the tester's validator does not check `format` or an encoding, so a plain item could pass it and still be
  // refused by the server for its format: such items are not made, and the array is not searched.
  if (opaqueItems(items)) return null;
  const types = typesOf(items);
  if (Array.isArray(items['enum']) && items['enum'].length) {
    const e = items['enum'] as unknown[];
    return items['uniqueItems'] ? null : (i) => e[i % e.length];
  }
  const t = types.find((x) => x !== 'null') ?? 'string';
  if (t === 'object' || t === 'array') return null;
  const cand = (i: number): unknown => (t === 'integer' || t === 'number' ? i + 1 : `i${i.toString(36)}`);
  // why: only a maker whose first items are valid is used; a pattern the plain items do not meet gives no array probe.
  for (const i of [0, 1, 999]) if (validates(items, cand(i)) !== true) return null;
  return cand;
}

// ───────────────────────────── hints ─────────────────────────────

const NUMW = '(\\d{1,7}(?:[,_]\\d{3})*)';
const UNIT = '(characters?|chars?|letters|symbols|items?|entries|elements|values|bytes)?';
const MAX_RE = new RegExp(`\\b(?:up to|at most|maximum(?: length)?(?: of| is)?|max(?:imum)?\\.?(?: length)?(?: of| is)?|no (?:more|longer) than|not (?:exceed|longer than)(?:ing)?|limited to|cannot exceed|must not exceed)\\s+${NUMW}\\s*${UNIT}`, 'gi');
const MIN_RE = new RegExp(`\\b(?:at least|minimum(?: length)?(?: of| is)?|min(?:imum)?\\.?(?: length)?(?: of| is)?|no (?:fewer|shorter) than)\\s+${NUMW}\\s*${UNIT}`, 'gi');
const RANGE_RE = new RegExp(`\\b(?:between\\s+${NUMW}\\s+and\\s+${NUMW}|${NUMW}\\s*(?:to|-|–)\\s*${NUMW})\\s*${UNIT}`, 'gi');
const CHARSET_RE = /\b(?:only|must (?:contain|consist of|be)(?: only)?|may (?:only )?contain|allowed characters?(?: are)?:?)\s+((?:lower(?:case)?|upper(?:case)?|ascii|alphanumeric|letters?|digits?|numbers?|hyphens?|dashes?|underscores?|dots?|periods?|spaces?|and|or|,|\s)+)/gi;
const REGEX_RE = /(?:match(?:es|ing)?|pattern|regex(?:p)?)\s*:?\s*[`/]([^`/\n]{2,200})[`/]/gi;

const toN = (s: string): number => Number(s.replace(/[,_]/g, ''));
const unitOf = (u: string | undefined, fallback: Hint['unit']): Hint['unit'] => {
  if (!u) return fallback;
  if (/^char|letters|symbols/i.test(u)) return 'characters';
  if (/^(item|entr|element|value)/i.test(u)) return 'items';
  if (/^byte/i.test(u)) return 'bytes';
  return fallback;
};

/** The default unit for an argument: characters for a string, items for an array, the value for a number. */
function unitFor(s: unknown): Hint['unit'] {
  const t = isObj(s) ? typesOf(s).find((x) => x !== 'null') : undefined;
  return t === 'array' ? 'items' : t === 'integer' || t === 'number' ? 'value' : 'characters';
}

/** Hints from one passage of text about one argument. */
export function hintsIn(text: string, arg: string, argSchema: unknown, source: string): Hint[] {
  const out: Hint[] = [];
  const fb = unitFor(argSchema);
  for (const m of text.matchAll(MAX_RE)) out.push({ arg, kind: 'max', n: toN(m[1]!), unit: unitOf(m[2], fb), source, quote: m[0].trim() });
  for (const m of text.matchAll(MIN_RE)) out.push({ arg, kind: 'min', n: toN(m[1]!), unit: unitOf(m[2], fb), source, quote: m[0].trim() });
  for (const m of text.matchAll(RANGE_RE)) {
    const a = toN(m[1] ?? m[3]!);
    const b = toN(m[2] ?? m[4]!);
    if (!(b > a)) continue;
    // why: "1 to 5" of a priority is a range of the value; "1 to 200 characters" of a title is a range of the length.
    const u = unitOf(m[5], fb);
    out.push({ arg, kind: 'min', n: a, unit: u, source, quote: m[0].trim() }, { arg, kind: 'max', n: b, unit: u, source, quote: m[0].trim() });
  }
  for (const m of text.matchAll(CHARSET_RE)) out.push({ arg, kind: 'charset', text: m[1]!.trim(), source, quote: m[0].trim() });
  for (const m of text.matchAll(REGEX_RE)) out.push({ arg, kind: 'pattern', text: m[1]!, source, quote: m[0].trim() });
  return out;
}

/** The sentences of a text that name an argument as a whole word. */
function sentencesNaming(text: string, arg: string): string[] {
  const esc = arg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^A-Za-z0-9_])${esc}($|[^A-Za-z0-9_])`);
  return text.split(/(?<=[.;!?])\s+|\n+/).filter((x) => re.test(x));
}

/**
 * The built-in extractor: regular expressions over the tool's description, each argument's description, and the documents
 * the declaration names. A sentence of the tool's description or of a document counts for an argument only where it names
 * the argument as a whole word. Static: no network, no model.
 */
export const regexHints: HintExtractor = {
  name: 'regex',
  hints(tool, docs) {
    const props = isObj(tool.inputSchema) && isObj(tool.inputSchema['properties']) ? (tool.inputSchema['properties'] as Obj) : {};
    const out: Hint[] = [];
    for (const [arg, s] of Object.entries(props)) {
      if (isObj(s) && typeof s['description'] === 'string') out.push(...hintsIn(s['description'], arg, s, `the description of ${tool.name}.${arg}`));
      if (typeof tool.description === 'string') for (const sen of sentencesNaming(tool.description, arg)) out.push(...hintsIn(sen, arg, s, `the description of ${tool.name}`));
      for (const d of docs) {
        // why: a document speaks of many tools; a sentence counts only where it names both the tool and the argument.
        for (const sen of sentencesNaming(d.text, arg)) if (sentencesNaming(sen, tool.name).length) out.push(...hintsIn(sen, arg, s, d.path));
      }
    }
    // why: one bound per (argument, kind, number, unit) is enough; the first source is kept.
    const seen = new Set<string>();
    return out.filter((h) => {
      const k = `${h.arg}|${h.kind}|${h.n ?? h.text}|${h.unit ?? ''}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  },
};
