/**
 * Min mode: values made from a JSON Schema, deterministically. Used for the mock's own objects (defaults, identifiers)
 * and for the tester's base calls (a value of the declared type, inside the declared limits, unique per call where it
 * can be, so that the value can be found again in the request the server sends to the mock).
 */

import { isObj, type Obj } from '../core/util.js';

export const typesOf = (s: unknown): string[] => (isObj(s) ? (Array.isArray(s['type']) ? (s['type'] as unknown[]).map(String) : typeof s['type'] === 'string' ? [s['type']] : []) : []);
export const mainType = (s: unknown): string | null => {
  const t = typesOf(s).filter((x) => x !== 'null');
  if (t.length) return t[0]!;
  if (isObj(s) && Array.isArray(s['enum'])) {
    const v = (s['enum'] as unknown[]).find((x) => x !== null);
    return v === undefined ? null : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v;
  }
  if (isObj(s) && isObj(s['properties'])) return 'object';
  return null;
};
export const nullable = (s: unknown): boolean => typesOf(s).includes('null') || (isObj(s) && Array.isArray(s['enum']) && (s['enum'] as unknown[]).includes(null));

/** Matches a string against a schema pattern; a pattern JavaScript cannot compile matches nothing. */
export function matches(pattern: unknown, v: string): boolean {
  if (typeof pattern !== 'string') return true;
  try {
    return new RegExp(pattern, 'u').test(v);
  } catch {
    return false;
  }
}

/**
 * A string for a simple pattern: anchors, literals, escapes, character classes with ranges, groups without alternation,
 * and the quantifiers ? * + {m} {m,n}. `seed` varies the characters chosen. Returns null for anything else.
 */
export function fromPattern(pattern: string, seed: number, maxLen = 64): string | null {
  let i = 0;
  const p = pattern;
  const digits = String(1000 + (seed % 9000));
  let counter = 0;
  const pick = (chars: string[]): string => {
    // why: prefer digits from the seed for a digit class, so ids like T-1042 differ per seed and look like ids.
    if (chars.every((c) => /[0-9]/.test(c))) return digits[counter++ % digits.length]!;
    const lower = chars.filter((c) => /[a-z]/.test(c));
    const pool = lower.length ? lower : chars;
    return pool[(seed + counter++) % pool.length]!;
  };
  const classChars = (body: string): string[] | null => {
    const out: string[] = [];
    let neg = false;
    let j = 0;
    if (body[0] === '^') {
      neg = true;
      j = 1;
    }
    while (j < body.length) {
      let c = body[j]!;
      if (c === '\\') {
        const e = body[j + 1];
        j += 2;
        if (e === 'd') out.push(...'0123456789');
        else if (e === 'w') out.push(...'abcdefghijklmnopqrstuvwxyz0123456789_');
        else if (e === 's') out.push(' ');
        else if (e) out.push(e);
        continue;
      }
      if (body[j + 1] === '-' && j + 2 < body.length) {
        const a = c.charCodeAt(0);
        const b = body.charCodeAt(j + 2);
        for (let k = a; k <= b && out.length < 200; k++) out.push(String.fromCharCode(k));
        j += 3;
        continue;
      }
      out.push(c);
      j++;
      c = '';
    }
    if (neg) {
      const all = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('').filter((x) => !out.includes(x));
      return all.length ? all : null;
    }
    return out.length ? out : null;
  };
  const atom = (): { gen: () => string } | null => {
    const c = p[i];
    if (c === undefined) return null;
    if (c === '[') {
      const end = p.indexOf(']', i + 2);
      if (end < 0) return null;
      const chars = classChars(p.slice(i + 1, end));
      i = end + 1;
      if (!chars) return null;
      return { gen: () => pick(chars) };
    }
    if (c === '(') {
      let depth = 1;
      let j = i + 1;
      while (j < p.length && depth) {
        if (p[j] === '\\') j++;
        else if (p[j] === '(') depth++;
        else if (p[j] === ')') depth--;
        j++;
      }
      let inner = p.slice(i + 1, j - 1);
      if (inner.startsWith('?:')) inner = inner.slice(2);
      if (inner.includes('|')) return null;
      i = j;
      return { gen: () => fromPattern(`^${inner}$`, seed + counter++, maxLen) ?? '' };
    }
    if (c === '\\') {
      const e = p[i + 1];
      i += 2;
      if (e === 'd') return { gen: () => pick('0123456789'.split('')) };
      if (e === 'w') return { gen: () => pick('abcdefghijklmnopqrstuvwxyz'.split('')) };
      if (e === undefined) return null;
      return { gen: () => e };
    }
    if (c === '.') {
      i++;
      return { gen: () => pick('abcdefghijklmnopqrstuvwxyz'.split('')) };
    }
    if ('|)'.includes(c)) return null;
    i++;
    return { gen: () => c };
  };
  let out = '';
  if (p[i] === '^') i++;
  while (i < p.length) {
    if (p[i] === '$' && i === p.length - 1) {
      i++;
      break;
    }
    const a = atom();
    if (!a) return null;
    let min = 1;
    let max = 1;
    const q = p[i];
    if (q === '?') {
      min = 0;
      max = 1;
      i++;
    } else if (q === '*') {
      min = 0;
      max = 3;
      i++;
    } else if (q === '+') {
      min = 1;
      max = 4;
      i++;
    } else if (q === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(p.slice(i));
      if (!m) return null;
      min = Number(m[1]);
      max = m[2] ? (m[3] ? Number(m[3]) : min + 4) : min;
      i += m[0].length;
    }
    const n = Math.max(min, Math.min(max, min + 3));
    for (let k = 0; k < n; k++) out += a.gen();
    if (out.length > maxLen) return null;
  }
  try {
    return new RegExp(pattern, 'u').test(out) ? out : null;
  } catch {
    return null;
  }
}

/** A string that meets the schema's limits, built around `stem` where the pattern allows. */
export function stringFor(s: Obj, stem: string, seed: number): string | null {
  const min = typeof s['minLength'] === 'number' ? s['minLength'] : 0;
  const max = typeof s['maxLength'] === 'number' ? s['maxLength'] : 200;
  const fits = (v: string) => v.length >= min && v.length <= max && matches(s['pattern'], v);
  for (const v of [stem, stem.replace(/[^a-z0-9]/gi, ''), stem.toLowerCase().replace(/[^a-z0-9-]/g, '-'), `${stem}${'x'.repeat(Math.max(0, min - stem.length))}`]) if (fits(v)) return v;
  if (typeof s['pattern'] === 'string') {
    for (let k = 0; k < 5; k++) {
      const v = fromPattern(s['pattern'], seed + k * 7, Math.max(max, 1));
      if (v !== null && fits(v)) return v;
    }
    return null;
  }
  const v = stem.slice(0, max);
  return fits(v) ? v : null;
}

/**
 * A default value for a schema, as a backend would fill a member the request did not give: the declared default or
 * const, the first enum value, null where null is allowed, else the type's zero (an integer at its minimum).
 */
export function defaultOf(s: unknown, depth = 0, now = new Date().toISOString()): unknown {
  if (!isObj(s) || depth > 8) return null;
  if ('default' in s) return s['default'];
  if ('const' in s) return s['const'];
  if (Array.isArray(s['enum'])) return (s['enum'] as unknown[])[0] ?? null;
  if (nullable(s)) return null;
  const t = mainType(s);
  if (t === 'string') return s['format'] === 'date-time' ? now : '';
  if (t === 'integer' || t === 'number') return typeof s['minimum'] === 'number' ? s['minimum'] : 0;
  if (t === 'boolean') return false;
  if (t === 'array') return [];
  if (t === 'object') {
    const props = isObj(s['properties']) ? s['properties'] : {};
    const req = Array.isArray(s['required']) ? (s['required'] as string[]) : [];
    const out: Obj = {};
    for (const k of req) if (k in props) out[k] = defaultOf(props[k], depth + 1, now);
    return out;
  }
  return null;
}
