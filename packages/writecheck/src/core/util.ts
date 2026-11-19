/**
 * Small shared helpers: hashing, canonical JSON (RFC 8785), JSON paths (`a.b[0]["x.y"]`),
 * whole-object diff, deep equality, and the tool's error type.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { parse as parseYaml } from 'yaml';

/** A refusal or failure reported as one `error:` line. `code` is the exit status (2 usage, 3 refused, 4 failed). */
export class WritecheckError extends Error {
  constructor(
    message: string,
    readonly code: 2 | 3 | 4 = 4,
  ) {
    super(message);
  }
}

export type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export const sha256 = (b: string | Uint8Array): string => createHash('sha256').update(b).digest('hex');

/**
 * RFC 8785 (JCS) canonical JSON: object keys sorted by UTF-16 code units, no whitespace, numbers in
 * the ECMAScript shortest form (which `JSON.stringify` already produces). Undefined members are
 * dropped as in JSON; a value that is not JSON (a function, a bigint, a non-finite number) is refused.
 */
export function canonical(v: unknown): string {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new WritecheckError('canonical JSON: a non-finite number');
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonical(x))).join(',')}]`;
  if (isObj(v)) {
    const keys = Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  throw new WritecheckError(`canonical JSON: a ${typeof v} is not JSON`);
}

export const hashJson = (v: unknown): string => sha256(canonical(v));

/** The deepest nesting (objects and arrays) a signed or compared document may have. */
export const MAX_JSON_DEPTH = 512;

/** A JSON path short enough for one error line. */
const clipPath = (path: string): string => (path.length > 120 ? `${path.slice(0, 60)}…${path.slice(-50)}` : path);

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** True when the string holds a UTF-16 surrogate without its pair: not Unicode text, so not I-JSON (RFC 7493) and refused by RFC 8785. */
export const hasLoneSurrogate = (s: string): boolean => LONE_SURROGATE.test(s);

/**
 * RFC 8785 (JCS) canonical JSON for signatures. The output is byte-identical to `canonical` for every value it accepts, but
 * it refuses (WritecheckError, exit 3) what RFC 8785 or I-JSON excludes or what cannot be canonicalised safely, never a crash:
 * a string or member name with a lone surrogate, nesting deeper than `maxDepth`, a non-finite number, a value that is not JSON.
 * Iterative, so the depth check, not the call stack, is the limit.
 */
export function canonicalStrict(value: unknown, maxDepth = MAX_JSON_DEPTH): string {
  const out: string[] = [];
  const stack: [unknown, number, string][] = [[value, 0, '$']];
  const refuse = (path: string, what: string) => new WritecheckError(`canonical JSON: ${clipPath(path)}: ${what}`, 3);
  while (stack.length > 0) {
    const [v, depth, path] = stack.pop()!;
    if (v instanceof Lit) {
      out.push(v.s);
      continue;
    }
    if (v === null || typeof v === 'boolean') out.push(JSON.stringify(v));
    else if (typeof v === 'string') {
      if (hasLoneSurrogate(v)) throw refuse(path, 'a string with a lone surrogate (not Unicode text; RFC 8785 refuses it)');
      out.push(JSON.stringify(v));
    } else if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw refuse(path, 'a non-finite number');
      out.push(JSON.stringify(v));
    } else if (Array.isArray(v) || isObj(v)) {
      if (depth >= maxDepth) throw refuse(path, `nesting deeper than ${maxDepth} levels`);
      if (Array.isArray(v)) {
        out.push('[');
        stack.push([new Lit(']'), 0, path]);
        for (let i = v.length - 1; i >= 0; i--) {
          const x = v[i] as unknown;
          stack.push([x === undefined ? null : x, depth + 1, `${path}[${i}]`]);
          if (i > 0) stack.push([new Lit(','), 0, path]);
        }
      } else {
        const keys = Object.keys(v)
          .filter((k) => v[k] !== undefined)
          .sort();
        out.push('{');
        stack.push([new Lit('}'), 0, path]);
        for (let i = keys.length - 1; i >= 0; i--) {
          const k = keys[i]!;
          if (hasLoneSurrogate(k)) throw refuse(path, 'a member name with a lone surrogate (not Unicode text; RFC 8785 refuses it)');
          stack.push([v[k], depth + 1, `${path}.${k}`]);
          stack.push([new Lit(`${i > 0 ? ',' : ''}${JSON.stringify(k)}:`), 0, path]);
        }
      }
    } else throw refuse(path, `a ${typeof v} is not JSON`);
  }
  return out.join('');
}

/** What makes a JSON text unfit to be signed or compared, found by `jsonTextProblem`. */
export interface JsonTextProblem {
  kind: 'syntax' | 'duplicate' | 'number' | 'string' | 'depth';
  /** Where (`$.a.b[0]`). */
  path: string;
  message: string;
}

const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const clip = (s: string) => (s.length > 40 ? `${s.slice(0, 40)}…` : s);

/**
 * One iterative pass over a JSON text (no recursion, so any nesting is safe) that finds the first thing that would make two
 * different texts verify under one signature, or a text that RFC 8785 refuses:
 * - a syntax error or text after the document (`syntax`);
 * - an object that repeats a member name (`duplicate`: JSON readers disagree on which copy counts);
 * - a number not written as RFC 8785 writes it (`number`: `1.0`, `1e0`, `-0`, or digits beyond double precision such as
 *   `9007199254740993`, which a JavaScript reader rounds and a reader with exact integers does not; and numbers beyond the
 *   double range). With every number in that form, the number text is a function of the value, so the canonical form, and with
 *   it the signature, covers the text itself;
 * - a string or member name holding a lone surrogate, escaped (`"\ud800"`) or raw (`string`);
 * - nesting deeper than `maxDepth` (`depth`).
 * Null when the text has none of these.
 */
export function jsonTextProblem(text: string, maxDepth = MAX_JSON_DEPTH): JsonTextProblem | null {
  const n = text.length;
  let i = 0;
  const p = (kind: JsonTextProblem['kind'], path: string, message: string): JsonTextProblem => ({ kind, path, message: `${clipPath(path)}: ${message}` });
  const syntax = (path: string) => p('syntax', path, i >= n ? 'the text ends early' : `unexpected ${JSON.stringify(text[i])} at offset ${i}`);
  const ws = () => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++;
      else break;
    }
  };
  /** The string token at i (text[i] is '"'), decoded; null if it is not a JSON string. */
  const str = (): string | null => {
    const start = i;
    i++;
    while (i < n && text.charCodeAt(i) !== 0x22) i += text.charCodeAt(i) === 0x5c ? 2 : 1;
    if (i >= n) return null;
    i++;
    try {
      return JSON.parse(text.slice(start, i)) as string;
    } catch {
      return null;
    }
  };
  interface Frame {
    obj: boolean;
    path: string;
    seen: Set<string>;
    count: number;
  }
  const stack: Frame[] = [];
  let path = '$';
  /** Read `"name":` of the next member of f, setting path to it. */
  const member = (f: Frame): JsonTextProblem | null => {
    ws();
    if (text[i] !== '"') return syntax(f.path);
    const k = str();
    if (k === null) return syntax(f.path);
    if (hasLoneSurrogate(k)) return p('string', f.path, 'a member name with a lone surrogate (not Unicode text; RFC 8785 refuses it)');
    path = `${f.path}.${k}`;
    if (f.seen.has(k)) return p('duplicate', path, 'the member appears twice');
    f.seen.add(k);
    ws();
    if (text[i] !== ':') return syntax(path);
    i++;
    return null;
  };
  for (;;) {
    // A value at i, at `path`.
    ws();
    const c = text[i];
    let opened = false;
    if (c === '{' || c === '[') {
      if (stack.length >= maxDepth) return p('depth', path, `nesting deeper than ${maxDepth} levels`);
      i++;
      const f: Frame = { obj: c === '{', path, seen: new Set(), count: 0 };
      stack.push(f);
      ws();
      if (text[i] === (f.obj ? '}' : ']')) {
        i++;
        stack.pop();
      } else {
        if (f.obj) {
          const e = member(f);
          if (e) return e;
        } else path = `${f.path}[0]`;
        opened = true;
      }
    } else if (c === '"') {
      const s = str();
      if (s === null) return syntax(path);
      if (hasLoneSurrogate(s)) return p('string', path, 'a string with a lone surrogate (not Unicode text; RFC 8785 refuses it)');
    } else if (c === 't' || c === 'f' || c === 'n') {
      const lit = c === 't' ? 'true' : c === 'f' ? 'false' : 'null';
      if (text.startsWith(lit, i)) i += lit.length;
      else return syntax(path);
    } else if (c === '-' || (c !== undefined && c >= '0' && c <= '9')) {
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(text);
      if (!m) return syntax(path);
      const lex = m[0];
      i += lex.length;
      const v = Number(lex);
      if (!Number.isFinite(v)) return p('number', path, `the number ${clip(lex)} is beyond the range of a double (RFC 8785 numbers are IEEE 754 doubles)`);
      const canon = JSON.stringify(v);
      if (canon !== lex) return p('number', path, `the number ${clip(lex)} is not written as RFC 8785 writes its value (${canon}); readers can disagree on what it is`);
    } else return syntax(path);
    if (opened) continue;
    // After a value: the next member or item, or close containers.
    for (;;) {
      ws();
      const f = stack[stack.length - 1];
      if (!f) return i === n ? null : p('syntax', '$', `text after the document at offset ${i}`);
      const d = text[i];
      if (d === ',') {
        i++;
        f.count++;
        if (f.obj) {
          const e = member(f);
          if (e) return e;
        } else path = `${f.path}[${f.count}]`;
        break;
      }
      if (d === (f.obj ? '}' : ']')) {
        i++;
        stack.pop();
        continue;
      }
      return syntax(f.path);
    }
  }
}

/** A literal output fragment on canonicalJson's work stack. */
class Lit {
  readonly s: string;
  constructor(s: string) {
    this.s = s;
  }
}

/**
 * Compact RFC 8785 (JCS) serialization, iterative so that any nesting depth from an untrusted server
 * is safe, and byte-identical to mcp-catalog-snap's canonical form (keys in UTF-16 code-unit order,
 * undefined members dropped, undefined array items as null, toJSON honoured, NaN and Infinity refused).
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) throw new WritecheckError('canonical JSON: undefined is not JSON');
  const out: string[] = [];
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    let v = stack.pop();
    if (v instanceof Lit) {
      out.push(v.s);
      continue;
    }
    while (v !== null && typeof v === 'object' && typeof (v as { toJSON?: unknown }).toJSON === 'function') v = (v as { toJSON: () => unknown }).toJSON();
    if (v === null || typeof v !== 'object') {
      if (typeof v === 'number' && !Number.isFinite(v)) throw new WritecheckError('canonical JSON: a non-finite number');
      if (v !== null && typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') throw new WritecheckError(`canonical JSON: a ${typeof v} is not JSON`);
      out.push(JSON.stringify(v));
    } else if (Array.isArray(v)) {
      out.push('[');
      stack.push(new Lit(']'));
      for (let i = v.length - 1; i >= 0; i--) {
        const x = v[i] as unknown;
        stack.push(x === undefined || typeof x === 'symbol' ? null : x);
        if (i > 0) stack.push(new Lit(','));
      }
    } else {
      const o = v as Record<string, unknown>;
      const entries = Object.keys(o)
        .sort()
        .filter((k) => o[k] !== undefined && typeof o[k] !== 'symbol');
      out.push('{');
      stack.push(new Lit('}'));
      for (let i = entries.length - 1; i >= 0; i--) {
        const k = entries[i]!;
        stack.push(o[k]);
        stack.push(new Lit(`${i > 0 ? ',' : ''}${JSON.stringify(k)}:`));
      }
    }
  }
  return out.join('');
}

/** Read a JSON or YAML file (`.json` strictly as JSON). */
export function readConfigFile(path: string): unknown {
  const text = readFileSync(path, 'utf8');
  return parseConfigText(text, path);
}

export function parseConfigText(text: string, where: string): unknown {
  try {
    return where.endsWith('.json') ? JSON.parse(text) : parseYaml(text, { strict: true, uniqueKeys: true });
  } catch (e) {
    throw new WritecheckError(`${where}: ${(e as Error).message}`, 2);
  }
}

/** Parse tool text output as JSON, then YAML; null when it is neither (plain text). */
export function parseStructured(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // why: many servers answer with a sentence and then the JSON, plain or in a fenced block (CLI-BUGS item 2).
    const fenced = /```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```/.exec(text);
    if (fenced) {
      try {
        const v = JSON.parse(fenced[1]!) as unknown;
        if (isObj(v) || Array.isArray(v)) return v;
      } catch {
        /* not JSON */
      }
    }
    const start = text.search(/^[ \t]*[{[]/m);
    if (start > 0) {
      try {
        const v = JSON.parse(text.slice(start)) as unknown;
        if (isObj(v) || Array.isArray(v)) return v;
      } catch {
        /* not JSON */
      }
    }
    // why: a one-line sentence such as `Error: Document with ID "4" not found` parses as a YAML mapping and was taken for
    // the object (a false MWS-RES-1 violated on delete). YAML is read only where the text has two or more lines that are
    // mapping entries or list items, as a YAML document from a server does.
    const yamlLines = text.split(/\r?\n/).filter((l) => /^\s*(?:-\s+\S|[A-Za-z_][\w.-]*:(?:\s|$))/.test(l)).length;
    if (yamlLines < 2) return null;
    try {
      const y = parseYaml(text) as unknown;
      return isObj(y) || Array.isArray(y) ? y : null;
    } catch {
      return null;
    }
  }
}

// ───────────────────────────── JSON paths ─────────────────────────────

export type PathSeg = string | number;

/** `a.b[0].c`, `labels["x.y"]`, `data['x.y']`; a leading `$` or `$.` is accepted and ignored. */
export function parsePath(p: string): PathSeg[] {
  const out: PathSeg[] = [];
  let i = 0;
  const bad = (why: string) => new WritecheckError(`bad path ${JSON.stringify(p)}: ${why}`, 2);
  if (p === '' || p === '$') return out;
  if (p.startsWith('$.')) i = 2;
  else if (p.startsWith('$[')) i = 1;
  while (i < p.length) {
    const c = p[i]!;
    if (c === '.') {
      i++;
      continue;
    }
    if (c === '[') {
      const q = p[i + 1];
      if (q === '"' || q === "'") {
        const end = p.indexOf(q + ']', i + 2);
        if (end < 0) throw bad('unterminated quoted key');
        out.push(p.slice(i + 2, end));
        i = end + 2;
      } else {
        const end = p.indexOf(']', i);
        if (end < 0) throw bad('unterminated index');
        const n = p.slice(i + 1, end);
        if (!/^\d+$/.test(n)) throw bad(`index ${n} is not a whole number`);
        out.push(Number(n));
        i = end + 1;
      }
      continue;
    }
    let j = i;
    while (j < p.length && p[j] !== '.' && p[j] !== '[') j++;
    const key = p.slice(i, j);
    if (!/^[A-Za-z0-9_$-]+$/.test(key)) throw bad(`segment ${JSON.stringify(key)} needs ["…"] quoting`);
    out.push(key);
    i = j;
  }
  return out;
}

export function formatPath(segs: PathSeg[]): string {
  let s = '';
  for (const g of segs) {
    if (typeof g === 'number') s += `[${g}]`;
    else if (/^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(g)) s += s ? `.${g}` : g;
    else s += `[${JSON.stringify(g)}]`;
  }
  return s;
}

export function getPath(v: unknown, path: string | PathSeg[]): unknown {
  let cur = v;
  for (const g of typeof path === 'string' ? parsePath(path) : path) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof g === 'number') cur = Array.isArray(cur) ? cur[g] : undefined;
    else cur = isObj(cur) && Object.hasOwn(cur, g) ? cur[g] : undefined;
  }
  return cur;
}

/** Set a path on a deep copy and return the copy (missing objects are created). */
export function setPath<T>(v: T, path: string | PathSeg[], value: unknown): T {
  const segs = typeof path === 'string' ? parsePath(path) : path;
  if (segs.length === 0) return structuredClone(value) as T;
  const root = (v === undefined || v === null ? {} : structuredClone(v)) as unknown;
  let cur = root as Record<string | number, unknown>;
  for (const [i, g] of segs.entries()) {
    if (i === segs.length - 1) {
      cur[g] = structuredClone(value);
      break;
    }
    const nxt = cur[g];
    if (nxt === null || typeof nxt !== 'object') cur[g] = typeof segs[i + 1] === 'number' ? [] : {};
    cur = cur[g] as Record<string | number, unknown>;
  }
  return root as T;
}

/** Remove a path on a deep copy and return the copy. */
export function unsetPath<T>(v: T, path: string | PathSeg[]): T {
  const segs = typeof path === 'string' ? parsePath(path) : path;
  const root = structuredClone(v) as unknown;
  let cur = root as unknown;
  for (const [i, g] of segs.entries()) {
    if (cur === null || typeof cur !== 'object') return root as T;
    if (i === segs.length - 1) {
      if (Array.isArray(cur) && typeof g === 'number') cur.splice(g, 1);
      else delete (cur as Obj)[g as string];
      break;
    }
    cur = (cur as Record<string | number, unknown>)[g];
  }
  return root as T;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((x, i) => deepEqual(x, (b as unknown[])[i]));
  const ka = Object.keys(a as Obj);
  const kb = Object.keys(b as Obj);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b as Obj, k) && deepEqual((a as Obj)[k], (b as Obj)[k]));
}

export interface DiffEntry {
  path: string;
  kind: 'added' | 'removed' | 'changed';
  before?: unknown;
  after?: unknown;
}

/** Leaf-level diff of two JSON values (objects recurse; arrays compare by index). */
export function diff(before: unknown, after: unknown, prefix: PathSeg[] = []): DiffEntry[] {
  if (deepEqual(before, after)) return [];
  const both = (x: unknown) => x !== null && typeof x === 'object';
  if (both(before) && both(after) && Array.isArray(before) === Array.isArray(after)) {
    const out: DiffEntry[] = [];
    if (Array.isArray(before)) {
      const a = after as unknown[];
      for (let i = 0; i < Math.max(before.length, a.length); i++) {
        if (i >= before.length) out.push({ path: formatPath([...prefix, i]), kind: 'added', after: a[i] });
        else if (i >= a.length) out.push({ path: formatPath([...prefix, i]), kind: 'removed', before: before[i] });
        else out.push(...diff(before[i], a[i], [...prefix, i]));
      }
      return out;
    }
    const b = before as Obj;
    const a = after as Obj;
    for (const k of [...new Set([...Object.keys(b), ...Object.keys(a)])].sort()) {
      if (!Object.hasOwn(a, k)) out.push({ path: formatPath([...prefix, k]), kind: 'removed', before: b[k] });
      else if (!Object.hasOwn(b, k)) out.push({ path: formatPath([...prefix, k]), kind: 'added', after: a[k] });
      else out.push(...diff(b[k], a[k], [...prefix, k]));
    }
    return out;
  }
  return [{ path: formatPath(prefix), kind: 'changed', before, after }];
}

/** True when `path` is `prefix` or below it (`labels` covers `labels.x`). */
export function under(path: string, prefix: string): boolean {
  if (prefix === '' || prefix === '$') return true;
  const p = parsePath(path);
  const q = parsePath(prefix);
  return q.length <= p.length && q.every((g, i) => g === p[i]);
}

/** Drop diff entries under any ignored path. */
export const withoutIgnored = (d: DiffEntry[], ignore: string[]): DiffEntry[] => d.filter((e) => !ignore.some((i) => under(e.path, i)));

/** Epoch milliseconds with sub-millisecond resolution. */
export const nowMs = (): number => performance.timeOrigin + performance.now();
export const iso = (ms: number): string => new Date(ms).toISOString();
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function short(v: unknown, n = 400): string {
  const s = typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v));
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export const round3 = (n: number | null): number | null => (n === null ? null : Math.round(n * 1000) / 1000);
