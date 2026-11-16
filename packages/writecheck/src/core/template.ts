/**
 * Templates in manifests and experiment specs. `{{name}}` is a variable (prefix, id, field, value,
 * REP, ARM, the manifest's `vars` and the experiment's own) or a reference to an earlier result in
 * the same repetition (`{{read.obj.version}}`). A string that is exactly one token takes the value
 * itself (an object stays an object); `{{json:ref}}` inserts the JSON text of a value (tools that
 * take the resource as a string). An unknown name fails loudly: a typo never becomes an empty value.
 * `{{?name}}`, as a whole value, is optional: when the variable is null or unset the key (or the
 * list element) is left out of the arguments, so an optional argument is sent only when it has a value.
 */

import { getPath, isObj, WritecheckError } from './util.js';

export type Env = Record<string, unknown>;

/** What an optional `{{?name}}` renders to when it has no value: the enclosing key or element is dropped. */
export const OMIT: unique symbol = Symbol('omit');

const OPTIONAL = /^\{\{\s*\?([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_$-]+)*)\s*\}\}$/;

const TOKEN = /\{\{\s*(json:)?([A-Za-z_][A-Za-z0-9_]*(?:(?:\.[A-Za-z0-9_$-]+)|(?:\[(?:\d+|"[^"]*"|'[^']*')\]))*)\s*\}\}/g;

function lookup(name: string, env: Env): unknown {
  const root = /^[A-Za-z_][A-Za-z0-9_]*/.exec(name)![0];
  if (!Object.hasOwn(env, root)) throw new WritecheckError(`template {{${name}}}: no variable or earlier result named ${root}`, 2);
  const rest = name.slice(root.length);
  const v = rest ? getPath(env[root], rest.replace(/^\./, '')) : env[root];
  if (v === undefined) throw new WritecheckError(`template {{${name}}}: ${rest ? `no value at ${rest.replace(/^\./, '')} of ${root}` : 'undefined'}`, 2);
  return v;
}

function renderString(s: string, env: Env): unknown {
  const opt = OPTIONAL.exec(s);
  if (opt) {
    const name = opt[1]!;
    const root = /^[A-Za-z_][A-Za-z0-9_]*/.exec(name)![0];
    const rest = name.slice(root.length);
    const v = Object.hasOwn(env, root) ? (rest ? getPath(env[root], rest.replace(/^\./, '')) : env[root]) : undefined;
    return v === undefined || v === null ? OMIT : structuredClone(v);
  }
  TOKEN.lastIndex = 0;
  const whole = /^\{\{\s*(json:)?([^}]+?)\s*\}\}$/.exec(s);
  if (whole && !whole[1] && s.match(TOKEN)?.length === 1) return structuredClone(lookup(whole[2]!, env));
  return s.replace(TOKEN, (_m, json: string | undefined, name: string) => {
    const v = lookup(name, env);
    if (json) return JSON.stringify(v);
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    throw new WritecheckError(`template {{${name}}} inside a longer string is not a scalar; use {{json:${name}}}`, 2);
  });
}

/** Render every string in a JSON value (keys too). */
export function render<T = unknown>(v: T, env: Env): T {
  const r = renderAny(v, env);
  return (r === OMIT ? null : r) as T;
}

function renderAny(v: unknown, env: Env): unknown {
  if (typeof v === 'string') return renderString(v, env);
  if (Array.isArray(v)) return v.map((x) => renderAny(x, env)).filter((x) => x !== OMIT);
  if (isObj(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const val = renderAny(x, env);
      if (val !== OMIT) out[renderString(k, env) as string] = val;
    }
    return out;
  }
  return v;
}

/** Every root name a value's templates refer to (for load-time validation). */
export function templateRoots(v: unknown, out = new Set<string>()): Set<string> {
  if (typeof v === 'string') {
    for (const m of v.matchAll(TOKEN)) out.add(/^[A-Za-z_][A-Za-z0-9_]*/.exec(m[2]!)![0]);
    const opt = OPTIONAL.exec(v);
    if (opt) out.add(/^[A-Za-z_][A-Za-z0-9_]*/.exec(opt[1]!)![0]);
  } else if (Array.isArray(v)) v.forEach((x) => templateRoots(x, out));
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) (templateRoots(k, out), templateRoots(x, out));
  return out;
}
