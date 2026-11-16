/**
 * Conditions: the only logic an experiment file may contain. Used for per-repetition counters
 * (over step results) and for the pre-registered verdict (over the arms' counts).
 *
 *   Cond  = Atom | { all: Cond[] } | { any: Cond[] } | { not: Cond }
 *   Atom  = "<operand> <op> <operand>"   or   "<operand>" (truthy)
 *   op    = == != >= <= > < contains
 *   operand = a reference (`race.a.ok`, `final.obj.data.a`, `test.silent_loss`), a number,
 *             'quoted text' (templates allowed: 'A1-{{N12}}'), true, false or null
 *
 * References reach keys with `.` or `/` through bracket quoting, as in the JSON paths elsewhere:
 * `final.obj.labels["a.b/c"]` or `…labels['a.b/c']`.
 *
 * A missing key reads as null: `x == null` holds when x is absent or null, `x != null` holds
 * only when x has a value, and a truthiness atom (`x`, `{not: x}`) is false for both. So a rule
 * written against null can always hold. Ordering operators (> >= < <=) compare numbers only; one
 * with a literal that is not a number is refused when the file loads, since it could never hold.
 *
 * No arithmetic beyond comparing two operands, no functions, no side effects: the file states the
 * rule, the evaluator only applies it. Every reference is checked against the known names when
 * the experiment loads, so a misspelt counter fails before run 1 instead of reading as zero.
 */

import { render, type Env } from './template.js';
import { deepEqual, getPath, isObj, parsePath, WritecheckError, type PathSeg } from './util.js';

export type Cond = string | { all: Cond[] } | { any: Cond[] } | { not: Cond };

const OPS = ['==', '!=', '>=', '<=', '>', '<', 'contains'] as const;
type Op = (typeof OPS)[number];

type Operand = { ref: string } | { lit: unknown };
interface Atom {
  left: Operand;
  op?: Op;
  right?: Operand;
}

function tokens(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    if (/\s/.test(s[i]!)) {
      i++;
      continue;
    }
    if (s[i] === "'") {
      let j = i + 1;
      let t = '';
      while (j < s.length && s[j] !== "'") {
        if (s[j] === '\\' && j + 1 < s.length) j++;
        t += s[j];
        j++;
      }
      if (j >= s.length) throw new WritecheckError(`condition ${JSON.stringify(s)}: unterminated quote`, 2);
      out.push(`'${t}`);
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < s.length && !/\s/.test(s[j]!)) {
      // why: a bracket-quoted key (`labels["a b"]`) is part of the reference even if it holds a space.
      if (s[j] === '[' && (s[j + 1] === '"' || s[j + 1] === "'")) {
        const end = s.indexOf(`${s[j + 1]}]`, j + 2);
        if (end < 0) throw new WritecheckError(`condition ${JSON.stringify(s)}: unterminated quoted key`, 2);
        j = end + 2;
        continue;
      }
      j++;
    }
    out.push(s.slice(i, j));
    i = j;
  }
  return out;
}

function operand(t: string, src: string): Operand {
  if (t.startsWith("'")) return { lit: t.slice(1) };
  if (t === 'true') return { lit: true };
  if (t === 'false') return { lit: false };
  if (t === 'null') return { lit: null };
  if (/^-?\d+(\.\d+)?$/.test(t)) return { lit: Number(t) };
  if (/^[A-Za-z_][A-Za-z0-9_]*((\.[A-Za-z0-9_$-]+)|(\[\d+\])|(\["[^"]*"\])|(\['[^']*'\]))*$/.test(t)) return { ref: t };
  throw new WritecheckError(`condition ${JSON.stringify(src)}: ${JSON.stringify(t)} is not a reference, number, 'text', true, false or null`, 2);
}

const ORDERING = new Set<Op>(['>=', '<=', '>', '<']);

export function parseAtom(s: string): Atom {
  const t = tokens(s);
  if (t.length === 1) return { left: operand(t[0]!, s) };
  if (t.length === 3 && (OPS as readonly string[]).includes(t[1]!)) {
    const a: Atom = { left: operand(t[0]!, s), op: t[1] as Op, right: operand(t[2]!, s) };
    // why: ordering compares numbers only; against text, true, false or null it could never hold.
    for (const o of [a.left, a.right!]) if (ORDERING.has(a.op!) && 'lit' in o && typeof o.lit !== 'number') throw new WritecheckError(`condition ${JSON.stringify(s)}: ${a.op} compares numbers; ${JSON.stringify(o.lit)} is not a number, so the rule could never hold`, 2);
    return a;
  }
  throw new WritecheckError(`condition ${JSON.stringify(s)}: expected "<a> <op> <b>" with op one of ${OPS.join(' ')}`, 2);
}

/** Validate a condition's shape and return every reference it uses. */
export function condRefs(c: Cond, where: string, out: string[] = []): string[] {
  if (typeof c === 'string') {
    const a = parseAtom(c);
    for (const o of [a.left, a.right]) if (o && 'ref' in o) out.push(o.ref);
    return out;
  }
  if (!isObj(c)) throw new WritecheckError(`${where}: a condition is a string or {all|any|not}`, 2);
  const keys = Object.keys(c);
  if (keys.length !== 1 || !['all', 'any', 'not'].includes(keys[0]!)) throw new WritecheckError(`${where}: a condition object has exactly one of all, any, not`, 2);
  if ('not' in c) return condRefs(c.not, `${where}.not`, out);
  const list = 'all' in c ? c.all : (c as { any: Cond[] }).any;
  if (!Array.isArray(list) || list.length === 0) throw new WritecheckError(`${where}: ${keys[0]} needs a non-empty list`, 2);
  list.forEach((x, i) => condRefs(x, `${where}.${keys[0]}[${i}]`, out));
  return out;
}

/** A reference split into its root name and the path below it (`a.b["c.d"]` → `a`, [`b`, `c.d`]). */
export function refParts(ref: string): { root: string; path: PathSeg[] } {
  const root = /^[A-Za-z_][A-Za-z0-9_]*/.exec(ref)![0];
  const rest = ref.slice(root.length).replace(/^\./, '');
  return { root, path: rest ? parsePath(rest) : [] };
}

/** What a reference reads; a missing key (or step) reads as null. */
export function readRef(ref: string, env: Env): unknown {
  const { root, path } = refParts(ref);
  const v = path.length ? getPath(env[root], path) : env[root];
  return v === undefined ? null : v;
}

function value(o: Operand, env: Env): unknown {
  if ('lit' in o) return typeof o.lit === 'string' ? render(o.lit, env) : o.lit;
  return readRef(o.ref, env);
}

const truthy = (v: unknown) => v !== undefined && v !== null && v !== false && v !== 0 && v !== '';

export function evalAtom(a: Atom, env: Env): boolean {
  const l = value(a.left, env);
  if (!a.op) return truthy(l);
  const r = value(a.right!, env);
  switch (a.op) {
    case '==':
      return deepEqual(l, r);
    case '!=':
      return !deepEqual(l, r);
    case 'contains':
      if (typeof l === 'string') return typeof r === 'string' && l.includes(r);
      if (Array.isArray(l)) return l.some((x) => deepEqual(x, r));
      return false;
    default: {
      if (typeof l !== 'number' || typeof r !== 'number') return false;
      return a.op === '>=' ? l >= r : a.op === '<=' ? l <= r : a.op === '>' ? l > r : l < r;
    }
  }
}

export function evaluate(c: Cond, env: Env): boolean {
  if (typeof c === 'string') return evalAtom(parseAtom(c), env);
  if ('all' in c) return c.all.every((x) => evaluate(x, env));
  if ('any' in c) return c.any.some((x) => evaluate(x, env));
  return !evaluate(c.not, env);
}

/** The values a condition read, for the result file (so a reader sees why the verdict came out). */
export function explain(c: Cond, env: Env): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const r of condRefs(c, 'explain')) out[r] = readRef(r, env);
  return out;
}
