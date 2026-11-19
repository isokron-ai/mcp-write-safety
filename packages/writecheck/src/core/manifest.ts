/**
 * The manifest: a small file the user owns that tells the tester how to reach the server, which
 * target it is, and, per resource, how to read an object, how to update part of it, two parts that
 * are independent, and which object to use. About 15 lines at minimum; every optional block unlocks
 * named requirements, and a missing block makes them `not tested` with the reason.
 *
 *   mws: "0.9"
 *   server:   { stdio: [node, server.js], env_passthrough: [TRACKER_URL], processes: separate }
 *   target:   { environment: test, confirm: "127.0.0.1:4100", guard: { tool: whoami, args: {}, path: tenant, pattern: "^test-" } }
 *   resources:
 *     - name: ticket
 *       create:  { tool: ticket_create, args: { title: "{{prefix}}ticket" }, id: id }
 *       read:    { tool: ticket_get, args: { id: "{{id}}" }, object: ticket, settle_ms: 0, ignore: [updated_at] }
 *       update:  { tool: ticket_update, mode: field_patch, args: { id: "{{id}}", "{{field}}": "{{value}}" } }
 *       fields:  [ { path: status, values: [open, closed] }, { path: assignee, values: [ann, bob] } ]
 *       cleanup: delete
 *       delete:  { tool: ticket_delete, args: { id: "{{id}}" } }
 *
 * A file with any `# guessed` marker left (written by `init`) is refused: removing the markers is
 * the confirmation that a person read it. Unknown keys are refused, so a misspelt block fails here
 * and not as a silent `not tested`.
 */

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import { parsePath, isObj, parseConfigText, sha256, WritecheckError, type Obj } from './util.js';
import { templateRoots } from './template.js';
import { RESULT_SHAPES, type ShapeName } from '../checks/shape.js';
import { parseProvenance } from './identity.js';

export const MANIFEST_VERSIONS = ['0.9'] as const;
export const UPDATE_MODES = ['field_patch', 'full_replace', 'command', 'composite'] as const;
export type UpdateMode = (typeof UPDATE_MODES)[number];
export const CLEANUP_POLICIES = ['delete', 'control_delete', 'archive', 'ephemeral', 'leave'] as const;
export type CleanupPolicy = (typeof CLEANUP_POLICIES)[number];
export const GUESSED = '# guessed';
export const PROTOCOLS = ['auto', '2025-11-25', '2026-07-28'] as const;

export interface ToolTemplate {
  tool: string;
  args: unknown;
}

/**
 * How a tool's wrapped results (structuredContent `{"result": "<a JSON document as a string>"}`) are read, where the declaration
 * says so: `json` decodes them for a tool whose outputSchema does not mark them; `none` never decodes them, even where the
 * outputSchema marks them. Absent unless declared (the outputSchema decides).
 */
export type DecodeMode = 'json' | 'none';
/**
 * Read extraction (`decode: { extract: … }`): a tool whose answer carries its JSON inside markup or prose (the whole answer
 * wrapped in `<insecure-content>…</insecure-content>`, say) has that JSON taken out of the answer's text before it is parsed.
 * `between`: the text after the first `start` and before the first `end` that follows it; `regex`: the one capture group of
 * the first match (dotAll). `refusals`: also extract from an error answer, and let the structured refusal signals read the
 * extracted document; without it a refusal is classified on the answer as received.
 */
export type Extract = ({ between: [string, string] } | { regex: string }) & { refusals: boolean };
export type Decode = { decode?: DecodeMode; extract?: Extract };

const DECODE_WHY = 'json (decode the JSON document a wrapped result carries as a string) or none (never decode it); or an object { mode, extract }';

/** The longest extraction pattern accepted. */
const EXTRACT_MAX = 512;

/**
 * Why a declared extraction regex is refused (null: accepted). It must compile, have exactly one capture group, and be bounded:
 * the group is delimited by something on each side that is more than anchors or a match-anything run (a group that can reach
 * either end of the answer could take the whole of it), and no quantified group holds a quantifier of its own (catastrophic
 * backtracking on a long answer).
 */
export function extractRegexProblem(src: string): string | null {
  if (src.length > EXTRACT_MAX) return `longer than ${EXTRACT_MAX} characters`;
  try {
    void new RegExp(src, 's');
  } catch (e) {
    return `not a valid regular expression: ${(e as Error).message}`;
  }
  const groups = (new RegExp(`${src}|`, 's').exec('') ?? []).length - 1;
  if (groups !== 1) return `${groups} capture groups; exactly one is needed (use (?:…) for any other group)`;
  // Locate the capture group: the first "(" that is not escaped, not in a class, and not followed by "?" (or is "(?<name>").
  let open = -1;
  let close = -1;
  let depth = 0;
  let inClass = false;
  let capDepth = -1;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === '\\') {
      i++;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === '(') {
      depth++;
      const capturing = src[i + 1] !== '?' || (src[i + 2] === '<' && src[i + 3] !== '=' && src[i + 3] !== '!');
      if (capturing && open < 0) {
        open = i;
        capDepth = depth;
      }
    } else if (c === ')') {
      if (depth === capDepth && close < 0 && open >= 0) close = i;
      depth--;
    }
  }
  if (open < 0 || close < 0) return 'the capture group could not be located';
  const before = required(src.slice(0, open));
  const after = required(src.slice(close + 1).replace(/^(?:[*+?]|\{\d*,?\d*\})\??/, ''));
  if (!before || !after) return 'unbounded: the capture group must be delimited on both sides by text the answer must contain (e.g. "<tag>(.*?)</tag>"), or it could take the whole answer; prefer between: [start, end]';
  if (/\((?:[^()\\]|\\.)*[*+](?:[^()\\]|\\.)*\)[*+{]/.test(src)) return 'unbounded: a quantified group holds a quantifier (catastrophic backtracking)';
  return null;
}

/**
 * What a regex fragment requires the text to contain: anchors, optional atoms and groups (`x?`, `x*`, `x{0,n}`, `(?:…)?`), a group
 * with an empty alternative (`(?:<t>|)`) and match-anything runs (`.+`, `[\s\S]+`, `\S+`) taken out. Empty: no delimiter.
 */
function required(s: string): string {
  const G = String.raw`(?:[^()\\]|\\.)*`;
  let x = s.replace(/\\[bBAzZ]|[\^$]/g, '');
  const optGroup = new RegExp(String.raw`\((?:\?:)?${G}\)(?:[?*]|\{0(?:,\d*)?\})\??`, 'g');
  const emptyAlt = new RegExp(String.raw`\((?:\?:)?(?:\|${G}|${G}\||${G}\|\|${G})\)`, 'g');
  for (let prev = ''; prev !== x; ) {
    prev = x;
    x = x.replace(optGroup, '').replace(emptyAlt, '');
  }
  x = x.replace(/(?:\\.|\[(?:[^\]\\]|\\.)*\]|[^\\()|])(?:[?*]|\{0(?:,\d*)?\})\??/g, '');
  x = x.replace(/(?:\.|\[\\s\\S\]|\[\\S\\s\]|\[\^\]\]|\\[sSwWdD])\+\??/g, '');
  return x.replace(/\(\?:|[()|]/g, '').trim();
}

function extractOf(v: unknown, where: string): Extract {
  const o = obj(v, where);
  keys(o, ['between', 'regex', 'refusals'], where);
  if ((o['between'] === undefined) === (o['regex'] === undefined)) throw fail(where, 'give exactly one of between: [start, end] or regex: "<pattern with one capture group>"');
  if (o['refusals'] !== undefined && typeof o['refusals'] !== 'boolean') throw fail(`${where}.refusals`, 'true or false');
  const refusals = o['refusals'] === true;
  if (o['between'] !== undefined) {
    const b = o['between'];
    if (!Array.isArray(b) || b.length !== 2 || b.some((x) => typeof x !== 'string' || !x || x.length > EXTRACT_MAX)) throw fail(`${where}.between`, `[start, end]: two non-empty strings of at most ${EXTRACT_MAX} characters (unbounded otherwise)`);
    return { between: [b[0] as string, b[1] as string], refusals };
  }
  const src = str(o['regex'], `${where}.regex`);
  const why = extractRegexProblem(src);
  if (why) throw fail(`${where}.regex`, why);
  return { regex: src, refusals };
}

/** Parse an optional `decode` member: `json`, `none`, or `{ mode, extract }`. */
function decodeOf(v: unknown, where: string): Decode {
  if (v === undefined) return {};
  if (v === 'json' || v === 'none') return { decode: v };
  if (!isObj(v)) throw fail(`${where}.decode`, DECODE_WHY);
  keys(v, ['mode', 'extract'], `${where}.decode`);
  if (v['mode'] === undefined && v['extract'] === undefined) throw fail(`${where}.decode`, 'mode, extract or both');
  if (v['mode'] !== undefined && v['mode'] !== 'json' && v['mode'] !== 'none') throw fail(`${where}.decode.mode`, 'json or none');
  return { ...(v['mode'] !== undefined ? { decode: v['mode'] as DecodeMode } : {}), ...(v['extract'] !== undefined ? { extract: extractOf(v['extract'], `${where}.decode.extract`) } : {}) };
}

/**
 * Every tool the declaration names an extraction for (server.decode, target.guard, each resource's read and list), one per tool;
 * two different extractions for one tool are refused.
 */
export function declaredExtracts(m: Pick<Manifest, 'server' | 'target' | 'resources'>): Map<string, Extract> {
  const out = new Map<string, Extract>();
  const where = new Map<string, string>();
  const add = (tool: string, x: Extract | undefined, at: string) => {
    if (!x) return;
    const had = out.get(tool);
    if (had && JSON.stringify(had) !== JSON.stringify(x)) throw fail(at, `decode.extract for ${tool} differs from the one ${where.get(tool)} declares (one extraction per tool: it applies to every call of the tool)`);
    out.set(tool, x);
    where.set(tool, at);
  };
  for (const [tool, x] of Object.entries(m.server?.extract ?? {})) add(tool, x, `server.decode.${tool}.extract`);
  if (m.target?.guard) add(m.target.guard.tool, m.target.guard.extract, 'target.guard.decode.extract');
  (m.resources ?? []).forEach((r, i) => {
    add(r.read.tool, r.read.extract, `resources[${i}].read.decode.extract`);
    if (r.list) add(r.list.tool, r.list.extract, `resources[${i}].list.decode.extract`);
  });
  return out;
}

/**
 * Feature: per-session init (`session.init`). Calls made on every MCP session the tester opens, after the handshake and before
 * the session's first other tools/call, for a server that connects to its backend only when a call carries the connection
 * settings. `args` may use `{{env.NAME}}` (the tester's environment; every such value is treated as a secret). `read_only: true`
 * declares the call only reads; otherwise (and where tools/list does not mark it readOnlyHint: true) each call counts as a write.
 */
export interface SessionInit {
  tool: string;
  args: unknown;
  read_only: boolean;
  /** Every environment variable the arguments name (`{{env.NAME}}`). */
  env: string[];
  /** Those given under a secret-like name: their values are secrets however short (from three characters). */
  secret_env: string[];
}

/** Name parts that mark a credential on their own. */
const SECRET_PARTS = new Set(['password', 'passwd', 'passphrase', 'pass', 'pwd', 'secret', 'secrets', 'token', 'tokens', 'credential', 'credentials', 'creds', 'cookie', 'cookies', 'dsn', 'auth', 'authorization', 'bearer', 'oauth', 'apikey', 'connstr']);
/** The password-type parts: a numeric literal is refused only under these. */
const PASSWORD_PARTS = new Set(['password', 'passwd', 'passphrase', 'pass', 'pwd', 'pin']);
/** With `key`, these make it a credential (`api_key`, `privateKey`); `key` alone is one too. Any other `key` (primary, sort, cache) is not. */
const KEY_QUALIFIERS = new Set(['api', 'private', 'access', 'secret', 'client', 'signing', 'encryption', 'master']);
/** A last part that describes a setting rather than holding the credential (`token_type`, `auth_mode`, `secretName`, `password_policy`, `token_url`). */
const DESCRIPTORS = new Set(['type', 'types', 'mode', 'scope', 'scopes', 'name', 'names', 'kind', 'policy', 'field', 'path', 'id', 'ids', 'length', 'len', 'size', 'format', 'url', 'uri', 'endpoint', 'host', 'file', 'dir', 'env', 'var', 'ttl', 'expiry', 'expires', 'lifetime', 'header', 'prefix', 'location', 'method', 'provider', 'version', 'enabled', 'required']);
/** A first part that makes the name a limit or a count (`max_tokens`). */
const COUNTERS = new Set(['max', 'min', 'num', 'count', 'n']);
/** Lowercase compounds written as one word, split into their parts. */
const COMPOUNDS: Record<string, string[]> = {
  apikey: ['api', 'key'],
  accesskey: ['access', 'key'],
  privatekey: ['private', 'key'],
  secretkey: ['secret', 'key'],
  clientsecret: ['client', 'secret'],
  accesstoken: ['access', 'token'],
  authtoken: ['auth', 'token'],
  refreshtoken: ['refresh', 'token'],
  idtoken: ['id', 'token'],
  connectionstring: ['connection', 'string'],
};

/** A name's parts: camelCase, `_`, `-`, `.`, digits; lowercased; known one-word compounds split. */
export function nameParts(name: string): string[] {
  return name
    .replace(/^-+/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_.\-\d]+/)
    .map((p) => p.toLowerCase())
    .filter(Boolean)
    .flatMap((p) => COMPOUNDS[p] ?? [p]);
}

/**
 * Is an argument name (or a command-line flag's name) secret-like, a name whose value is a credential? Matched on whole name
 * parts, case ignored, camelCase and compounds included: a part `password`, `passwd`, `passphrase`, `pass`, `pwd`, `secret`,
 * `token`, `credential(s)`, `creds`, `cookie`, `dsn`, `auth`, `authorization`, `bearer`, `oauth`; `connection` or `conn` with `string` or `str`;
 * `key` alone or with `api`, `private`, `access`, `secret`, `client`, `signing`, `encryption` or `master`. Not secret-like: a name
 * whose last part describes the setting (`token_type`, `auth_mode`, `oauth_scope`, `secretName`, `cookie_name`,
 * `password_policy`, `token_url`), one whose first part makes it a limit (`max_tokens`), and a part that merely contains a
 * marker (`bypass`, `passport`, `tokenizer`, `author`, `keyboard`).
 */
export function secretLikeName(name: string): boolean {
  const parts = nameParts(name);
  if (!parts.length) return false;
  if (parts.length > 1 && DESCRIPTORS.has(parts[parts.length - 1]!)) return false;
  if (COUNTERS.has(parts[0]!) && parts.length > 1) return false;
  if (parts.some((p) => SECRET_PARTS.has(p))) return true;
  if ((parts.includes('connection') || parts.includes('conn')) && (parts.includes('string') || parts.includes('str'))) return true;
  if (parts.includes('key')) return parts.length === 1 || parts.some((p) => KEY_QUALIFIERS.has(p));
  return false;
}

/** A password-type name (`password`, `dbPass`, `pwd`): a numeric literal under it is refused too. */
export const passwordLikeName = (name: string): boolean => secretLikeName(name) && nameParts(name).some((p) => PASSWORD_PARTS.has(p));

/** A literal URL that carries a credential: a user-info password (`user:pass@`) or a query parameter with a secret-like name. */
export function urlCarriesSecret(v: string): boolean {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v.trim())) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/\s@?#]*:[^/\s@?#]*@/i.test(v.trim())) return true;
  const q = /\?([^#]*)/.exec(v);
  if (!q) return false;
  return q[1]!.split('&').some((kv) => {
    const k = decodeURIComponent(kv.split('=')[0] ?? '');
    return !!k && secretLikeName(k) && (kv.split('=')[1] ?? '') !== '' && !/^\{\{/.test(decodeURIComponent(kv.split('=').slice(1).join('=')));
  });
}

const envOnly = (x: string): string | null => /^\{\{\s*\??env\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/.exec(x)?.[1] ?? null;

function sessionOf(v: unknown): { init: SessionInit[] } | null {
  if (v === undefined) return null;
  const o = obj(v, 'session');
  keys(o, ['init'], 'session');
  if (!Array.isArray(o['init']) || o['init'].length === 0 || o['init'].length > 8) throw fail('session.init', 'a list of one to eight { tool, args, read_only } calls');
  const init = (o['init'] as unknown[]).map((x, i) => {
    const w = `session.init[${i}]`;
    const t = tool(x, w, ['read_only']);
    if (t['read_only'] !== undefined && typeof t['read_only'] !== 'boolean') throw fail(`${w}.read_only`, 'true or false');
    if (!isObj(t.args)) throw fail(`${w}.args`, 'an object');
    const roots = templateRoots(t.args);
    for (const r of roots) if (r !== 'env') throw fail(`${w}.args`, `{{${r}}}: session.init arguments may use only {{env.NAME}} (they are sent before any object of the run exists)`);
    const env = new Set<string>();
    const walk = (s: unknown): void => {
      if (typeof s === 'string') {
        for (const m of s.matchAll(/\{\{\s*(?:json:|\?)?env(?:\.([^}\s]*))?\s*\}\}/g)) {
          if (!m[1] || !ENV.test(m[1])) throw fail(`${w}.args`, `${m[0]}: write {{env.NAME}} with one environment variable name`);
          env.add(m[1]);
        }
      } else if (Array.isArray(s)) s.forEach(walk);
      else if (isObj(s)) for (const [k, x] of Object.entries(s)) (walk(k), walk(x));
    };
    walk(t.args);
    // why: review of PR #14 (8) and its follow-up (B, re-review): a credential is never written in the manifest. Under a secret-like
    // name (an object key, a `--flag` or `-p` in a list, `name=value` in a list, a `{ name, value }` header pair) the value must be
    // exactly one {{env.NAME}}, whose value is then a secret however short (secret_env). A literal URL anywhere must not carry a
    // credential (user-info or a secret-like query parameter). A number is refused only under a password-type name.
    const secretEnv = new Set<string>();
    const why = 'a value under a secret-like name is given as {{env.NAME}} (one variable, the whole value), never written in the manifest';
    const check = (x: unknown, at: string, name: string): void => {
      if (x === null || x === undefined || x === '' || typeof x === 'boolean') return;
      if (typeof x === 'number') {
        if (passwordLikeName(name)) throw fail(`${w}.args${at}`, why);
        return;
      }
      if (Array.isArray(x)) return x.forEach((y, j) => (typeof y === 'string' || typeof y === 'number' ? check(y, `${at}[${j}]`, name) : lit(y, `${at}[${j}]`)));
      if (isObj(x)) return lit(x, at);
      const n = typeof x === 'string' ? envOnly(x) : null;
      if (!n) throw fail(`${w}.args${at}`, why);
      secretEnv.add(n);
    };
    const urlOk = (x: unknown, at: string): void => {
      if (typeof x === 'string' && urlCarriesSecret(x)) throw fail(`${w}.args${at}`, 'a literal URL that carries a credential (user-info or a secret-like query parameter) is given as {{env.NAME}}, never written in the manifest');
    };
    const lit = (v: unknown, at: string): void => {
      if (Array.isArray(v)) {
        v.forEach((x, j) => {
          const here = `${at}[${j}]`;
          if (typeof x !== 'string') return lit(x, here);
          urlOk(x, here);
          const kv = /^(-{0,2}[A-Za-z][\w.-]*)=(.*)$/s.exec(x);
          if (kv && secretLikeName(kv[1]!)) return check(kv[2], here, kv[1]!);
          const flag = /^-{1,2}([A-Za-z][\w.-]*)$/.exec(x);
          const next = v[j + 1];
          const isLit = j + 1 < v.length && (typeof next === 'string' || typeof next === 'number') && !/^-{1,2}[A-Za-z]/.test(String(next));
          if (flag && isLit && (secretLikeName(flag[1]!) || (/^-[pP]$/.test(x) && typeof next === 'string' && !/^\d+$/.test(next)))) check(next, `${at}[${j + 1}] (after ${x})`, /^-[pP]$/.test(x) ? 'password' : flag[1]!);
        });
        return;
      }
      if (isObj(v)) {
        // A header pair { name: "Authorization", value: "…" } (also key/header in place of name).
        const pairName = ['name', 'key', 'header'].map((k) => v[k]).find((x): x is string => typeof x === 'string');
        const pair = pairName !== undefined && Object.hasOwn(v, 'value');
        if (pair && secretLikeName(pairName)) check(v['value'], `${at}.value`, pairName);
        for (const [k, x] of Object.entries(v)) {
          if (pair && (k === 'value' || ['name', 'key', 'header'].includes(k))) {
            if (k === 'value' && !secretLikeName(pairName)) lit(x, `${at}.${k}`), urlOk(x, `${at}.${k}`);
            continue;
          }
          if (secretLikeName(k)) check(x, `${at}.${k}`, k);
          else {
            urlOk(x, `${at}.${k}`);
            lit(x, `${at}.${k}`);
          }
        }
      }
    };
    lit(t.args, '');
    return { tool: t.tool, args: t.args, read_only: t['read_only'] === true, env: [...env], secret_env: [...secretEnv] };
  });
  return { init };
}

/**
 * Every tool the declaration names a decode for (server.decode, target.guard, each resource's read and list), one mode per tool;
 * two different modes for one tool are refused.
 */
export function declaredDecodes(m: Pick<Manifest, 'server' | 'target' | 'resources'>): Map<string, DecodeMode> {
  const out = new Map<string, DecodeMode>();
  const where = new Map<string, string>();
  const add = (tool: string, mode: DecodeMode | undefined, at: string) => {
    if (!mode) return;
    const had = out.get(tool);
    if (had && had !== mode) throw fail(at, `decode: ${mode} for ${tool}, which ${where.get(tool)} declares decode: ${had} (one mode per tool: a wrapped result is decoded for every call of the tool or for none)`);
    out.set(tool, mode);
    where.set(tool, at);
  };
  for (const [tool, mode] of Object.entries(m.server?.decode ?? {})) add(tool, mode, `server.decode.${tool}`);
  if (m.target?.guard) add(m.target.guard.tool, m.target.guard.decode, 'target.guard.decode');
  (m.resources ?? []).forEach((r, i) => {
    add(r.read.tool, r.read.decode, `resources[${i}].read.decode`);
    if (r.list) add(r.list.tool, r.list.decode, `resources[${i}].list.decode`);
  });
  return out;
}

export interface FieldSpec {
  /** Where the field is in the object the read returns. */
  path: string;
  /** The argument name an update uses for it (`{{field}}`); defaults to the path. */
  arg: string;
  /** Two distinct values the tester may write. */
  values: [unknown, unknown];
  /** The value an "empty" write uses (null is a value: "unset"); null here means the case is skipped. */
  empty: { value: unknown } | null;
  /** A value of the wrong type for the field; null here means the case is skipped. */
  invalid: { value: unknown } | null;
  /** The key the control's patch body uses for the field (`{{field}}` in control.patch); defaults to the path (writesafe T3). */
  control_key: string | null;
}

export interface HttpTemplate {
  http: [string, string];
  body?: unknown;
  headers?: Record<string, string>;
  /** Where the object is in the response body (read only). */
  object?: string;
}

export interface ControlSpec {
  /** Base URL, literal or from an environment variable (never both). */
  base: string | null;
  base_env: string | null;
  /** Credential by environment variable name only; the value is redacted everywhere. */
  auth: { header: string; env: string; prefix: string } | null;
  read: HttpTemplate | null;
  patch: HttpTemplate | null;
  write: HttpTemplate | null;
  delete: HttpTemplate | null;
  /** Create an object straight through the platform's API (setup for container and multi-item tests); `id` is where its id is in the answer. */
  create: (HttpTemplate & { id: string }) | null;
}

/** A list call and how to pick items out of its result. */
export interface ListSpec extends ToolTemplate, Decode {
  items: string;
  id: string;
  name: string;
  /** Fields of the listed form that change by themselves (an age, the time of the listing): the bystander inventory leaves them out. */
  ignore: string[];
  /** How to ask for the next page: the value at `path` in an answer, sent as the argument `arg`; null: one answer is the list. */
  next: { path: string; arg: string } | null;
}

/** A case the declaration adds to MWS-RES-1: an update with these arguments must leave `expect` in effect. */
export interface UpdateCase {
  name: string;
  args: Record<string, unknown>;
  expect: Record<string, unknown>;
}

/** A tool that writes several objects in one call (MWS-ATOM-1, MWS-ATOM-2). */
export interface MultiSpec extends ToolTemplate {
  /** How an item shows it was applied: a field that holds a value afterwards, or that the item is gone. */
  effect: { path: string; value: unknown } | 'deleted';
  /** An item id the backend will refuse, for the black-box positions (first, middle, last); null: proxy-assisted only. */
  invalid_id: unknown;
  /** Where the result lists the items it says were applied (a path in the result, and the id inside each entry). */
  report: { applied: string; id: string | null } | null;
}

/**
 * One condition of a declared effect, on the object read back after the call: `path` equals `value` (with `pick`: the list at
 * `path`, each element reduced to its `pick` member, equals `value`); the list at `path` holds an element matching `contains`
 * (an object matches on the members it names; any other value matches an equal element); or holds none matching `lacks`.
 */
export type EffectCond = { path: string; value: unknown; pick: string | null } | { path: string; contains: unknown } | { path: string; lacks: unknown };

/**
 * A write call and the state it asks for (MWS-RES-1), judged by reading the object back. `on: object`: the call writes a fresh
 * scratch object of the resource ({{id}}, and {{object}} / {{version}} as read just before the call); `on: new`: the call
 * creates the object, which is found by its {{marker}} through the resource's list. `deleted`: the object is gone afterwards.
 * `answers`: the inputResponses to send where the tool answers input_required (revision 2026-07-28).
 */
export interface EffectSpec extends ToolTemplate {
  on: 'object' | 'new';
  deleted: boolean;
  expect: EffectCond[];
  answers: Record<string, unknown> | null;
  client_capabilities: Record<string, unknown> | null;
}

/** A tool that edits one element of a list held inside the object (MWS-UPD-2). */
export interface ListEditSpec extends ToolTemplate {
  /** Where the list is in the object the read returns, and the id and name inside each element. */
  list: string;
  element: { id: string; name: string };
  /** How the tool addresses an element: the argument for a stable id and/or for a position; the one the tool's schema declares is used. */
  address: { by_id: string | null; by_position: string | null };
  /** The effect of the edit on the addressed element: it is removed, or `path` takes `value`. */
  effect: { path: string; value: unknown } | 'removed';
  /** The second writer: a call that inserts an element ahead of the target ({{names_inserted}}: the names with the new one inserted). */
  insert: ToolTemplate;
}

/** A create tool for objects that live inside the object under test, or beside it (MWS-RES-3, MWS-RES-4, MWS-RETRY-1). */
export interface CreateSpec extends ToolTemplate {
  name: string;
  /** How to find what one call created, independently of its answer: a read or list call, the items, their id, and the field that holds the call's marker. */
  find: ToolTemplate & { items: string; id: string; match: string };
  /** Where the key goes, if the tool takes one. */
  idempotency: { key: { arg: string } | { meta: string } } | null;
}

/**
 * A write tool that accepts an idempotency key (MWS-RETRY-2). The optional fields are the declaration's statements of
 * Annex E: what the backend and the tool do with keys, which the tester cannot see from outside.
 */
export interface IdempotencySpec {
  tool: string;
  args: unknown;
  key: { arg: string } | { meta: string };
  id: string | null;
  replay_marker: string | null;
  replay_text: string | null;
  /** create: the trace is the objects carrying the call's marker; update: the version of a scratch object; append is not built. */
  kind: 'create' | 'update' | 'append';
  /** Annex E: the backend changes the version on every write it applies and on nothing else, in countable steps, and the tool writes the object once per application. */
  version_steps: boolean;
  /** The argument step (c) changes (its type kept); null: the argument carrying the call's marker. */
  vary: string | null;
  /** Annex E: checks the tool makes whatever the key (a refusal by one is a refusal on its own merits in step (b)). */
  own_checks: ('name' | 'version' | 'content')[];
  /** Annex E: the backend offers an idempotency key that answers a repeat with the first result, or a lookup of a write by its key; null: not declared. */
  backend_key: boolean | null;
  /** Annex E (R8-3): whether the tool's key record survives a restart after each kind of stop; null where not declared. */
  key_record_survives: { graceful: boolean | null; kill: boolean | null } | null;
  /** How long a key is remembered, as the tool's description states it (quoted). */
  key_lifetime: { ms: number; quote: string } | null;
}

export interface ResourceSpec {
  name: string;
  vars: Record<string, unknown>;
  create: (ToolTemplate & { id: string | null; id_regex: string | null; name_path: string | null }) | null;
  /** The read tool: `object` is where the object is in the result; with `items` and `match`, the result is a list and the object is the item whose `match` equals the id. */
  read: ToolTemplate & Decode & { object: string; settle_ms: number; ignore: string[]; items: string | null; match: string | null };
  /** Null for a resource the tester only creates and deletes (no update tool declared). */
  /**
   * override: an argument the declared update arguments set that is an explicit override (spec NF-7), such as overwrite: true;
   * apply: the tool sends an apply with field ownership (spec section 4: neither field patch nor full replace).
   */
  update: (ToolTemplate & { mode: UpdateMode; cases: UpdateCase[]; override: string | null; apply: boolean }) | null;
  fields: [FieldSpec, FieldSpec] | null;
  /** `optional`: the update tool works without the version; it is sent only where a test is about stale state. */
  version: { read: string; arg: string | null; optional: boolean; override: string | null } | null;
  /** An id that does not exist (errors are provoked with it). */
  missing_id: unknown;
  /** The caller chooses the object's name or key (MWS-TGT-3); `vary` is a non-key argument whose value a second create changes. */
  key: { arg: string; vary: { arg: string; path: string } | null; class: { as: 'create' | 'upsert'; quote: string } | null } | null;
  /** A scope argument (MWS-TGT-1): the resource that provides scopes, the argument, the server's default scope, and a list call per scope. */
  scope: { resource: string; arg: string; default: string | null; list: ListSpec } | null;
  /**
   * A delete or bulk tool that takes a selector (MWS-TGT-2), and the selector forms to try without opting in. `narrow`:
   * arguments that, added to `args`, limit the call to the objects named with {{marker}}; with it, MWS-TGT-1 is run for
   * this tool, and only where it is `held` are the selector forms sent (spec 7.3, rule 1).
   */
  selector: (ToolTemplate & { forms: { name: string; args: Record<string, unknown> }[]; narrow: Record<string, unknown> | null; send_empty_forms: boolean }) | null;
  multi: MultiSpec[];
  list_edit: ListEditSpec | null;
  creates: CreateSpec[];
  /** Calls the declaration says the backend will refuse (MWS-RES-2). */
  failures: (ToolTemplate & { name: string })[];
  /** Jobs whose round trips are measured (Annex A, A-1). */
  jobs: { name: string; calls: ToolTemplate[] }[];
  /** Other write tools that accept the version the caller read (`{{version}}` in their arguments): each gets the stale-write test (MWS-CONC-2, MWS-CONC-4). */
  versioned: ToolTemplate[];
  /** Tools whose operation the backend cannot version-check (the declaration says so): MWS-CONC-2 does not apply, MWS-CONC-5 does. */
  no_version_check: string[];
  /** MWS-IN-5: values valid by the update tool's schema to try (`length`: a string of that many characters). */
  try_values: { arg: string; value?: unknown; length?: number }[];
  /** MWS-IN-5 (R10-8): refusals of the update tool that rest on a fixed constraint: the argument, a pattern for the text, and why it is fixed. */
  fixed_constraints: { arg: string; pattern: string; reason: string }[];
  /** Fields the server sets itself (a timestamp, a revision): ignoring one of these does not hide a change a caller made. */
  server_managed: string[];
  /**
   * Arguments of the update tool that the operator declares the tester may set and put back to the value it read (spec Annex E,
   * the fields the update tool can set; MWS-IN-1 and MWS-IN-4 counterpart controls): `path` is where the read shows the field.
   */
  restorable: { arg: string; path: string; call_only?: boolean }[];
  /** MWS-RES-1: write calls with the state each asks for, judged by reading the object back (absent in older parsed forms). */
  effects?: EffectSpec[];
  /** MWS-RETRY-3: how to make a tool answer input_required, and the answers to send on the retry. */
  input_required: { tool: string; args: unknown; answers: Record<string, unknown>; client_capabilities: Record<string, unknown>; effect: { path: string; value: unknown } | null }[];
  delete: ToolTemplate | null;
  archive: ToolTemplate | null;
  list: ListSpec | null;
  cleanup: CleanupPolicy | null;
  /** A pre-made object; at run time it must read back carrying `name` (at `name_path`, or anywhere in it). */
  fixture: { id: unknown; name: string; name_path: string | null } | null;
  /** The replay indicator: a result field that is true on a replay, and/or a text the answer contains (MWS-RETRY-2). */
  idempotency: IdempotencySpec | null;
  control: ControlSpec | null;
}

/** Answers to review-only clauses, written down in advance by the person who runs the tests (recorded as self-attested). */
export interface ReviewSpec {
  by: string;
  /** MWS-CONC-4: a conflict says the write was not applied when its text matches. */
  conflict_says_not_applied: string | null;
  /** MWS-IN-4: a rejection gives the reason when its text matches. */
  rejection_gives_reason: string | null;
  /** MWS-CONC-5: a tool description discloses that stale writes are not detected when it matches. */
  stale_writes_disclosed: string | null;
  /** MWS-CONC-6: a conflict without the current state tells the caller to re-read when its text matches. */
  conflict_says_reread: string | null;
  /** Free answers by question id (`mcp-writecheck review` lists the ids). */
  answers: Record<string, { answer: boolean; note: string | null }>;
}

/** F5 (rating method 0.4): the pair budget per probabilistic requirement, 2 repeats of 1500 barrier pairs; used only when declared. */
export const PAIR_BUDGET = { repeats: 2, pairs: 1500 } as const;
export const MAX_WRITE_BUDGET = 250_000;
/**
 * F5: the write budget when none is declared, sized to fit the run: 1000 for everything but the pairs, and for each resource
 * with an update tool and two fields, four writes per barrier pair (two writes and the reset) in each repeat, twice where a
 * control block can run the control arm, plus the RETRY-2 overlapped pairs of a resource with an idempotency block.
 */
export function defaultWriteBudget(resources: ResourceSpec[], pairs: number, repeats: number): number {
  let n = 1000;
  for (const r of resources) {
    if (r.update && r.fields) n += (repeats * (pairs + 1)) * 4 * (r.control ? 2 : 1);
    if (r.idempotency) n += pairs * 4;
  }
  return Math.min(MAX_WRITE_BUDGET, Math.max(500, n));
}

export interface Manifest {
  mws: string;
  /** The first part of every name the run gives its objects (`<prefix>-<run>-…`); default mwsc. */
  prefix: string;
  server: {
    stdio: string[] | null;
    url: string | null;
    /** A streamable HTTP server the tester starts itself; its URL is read from its first stdout line. */
    launch: { command: string[]; url_from: string; ready_timeout_ms: number } | null;
    /** The MCP revision to speak: auto (2026-07-28 if the server offers it, else 2025-11-25) or one of them. */
    protocol: (typeof PROTOCOLS)[number];
    headers_env: Record<string, { env: string; prefix: string }>;
    /** Passed through from the tester's environment; the values are treated as secrets and redacted everywhere. */
    env_passthrough: string[];
    /** Passed through and not redacted (a backend URL, a feature switch): never put a credential here. */
    env_public: string[];
    env: Record<string, string>;
    /** Absolute: a relative server.cwd is taken relative to the manifest file's folder. */
    cwd: string | null;
    processes: 'separate' | 'same';
    /** Annex E (R8-3): the declaration's means to stop and start the server (the tester's own launch command), and the kind of stop. */
    restart: { stop: 'graceful' | 'kill' } | null;
    /** Per tool: how its wrapped results are read (`json` or `none`); absent unless declared. */
    decode?: Record<string, DecodeMode>;
    /** Per tool: the read extraction declared under `server.decode.<tool>.extract`; absent unless declared. */
    extract?: Record<string, Extract>;
  };
  target: {
    environment: string;
    confirm: string;
    allow_hosts: string[];
    /** read_only: the declaration states the guard tool only reads, for a server whose tools carry no readOnlyHint. */
    /**
     * read_only_call: the operator declares that this call (the tool with these exact arguments) only reads, for a server
     * whose only tool is a dispatcher (PostHog `cli` mode: `exec`, readOnlyHint: false). The guard then rests on that
     * declaration, not on an annotation; the run verifies it (three identical answers) and fails closed.
     */
    guard: ({ tool: string; args: unknown; path: string | null; pattern: string; read_only: boolean; read_only_call?: boolean } & Decode) | null;
    refuse_fingerprints: string[];
  };
  limits: {
    write_budget: number;
    writes_per_second: number;
    /** Barrier pairs per repeat (MWS-CONC-3 tier 2). Default 40, or pair_budget.pairs where a pair budget is declared. */
    pairs: number;
    /**
     * Repeats of the barrier pairs. Absent means 1. Present only where declared, or where a pair budget is declared (so the plan
     * hash of a manifest that opts into nothing does not change).
     */
    pair_repeats?: number;
    /**
     * F5 (opt-in): the pair budget a rating asks of a probabilistic requirement (rating method 0.4: 2 × 1500), from
     * `limits.pair_budget` or `--pair-budget`. Absent: no budget; the record states none. A run below it reports "below the pair budget".
     */
    pair_budget?: { repeats: number; pairs: number };
    stale_reps: number;
    gate_reps: number;
    timeout_ms: number;
    max_fuzz_cases: number;
  };
  /** backend.gate: exactly one route (rewrite_env: base-URL rewrite; node_import: the in-process hook). */
  backend: { gate: { rewrite_env: string | null; node_import: boolean; hold_timeout_ms: number } | null } | null;
  /** Arguments for other tools (annotation effects), bound to a resource whose scratch object `{{id}}` names. */
  calls: Record<string, { args: unknown; resource: string | null }>;
  resources: ResourceSpec[];
  /** Start-up settings meant to restrict writes (MWS-CFG-1 to MWS-CFG-3), set through environment variables of a server the tester starts. */
  settings: {
    /** Settings applied with a request (spec 516c4ed, MWS-CFG-1 to CFG-4) are declared with `applied: request`; this preview does not test them. */
    per_request: { name: string; kind: 'read_only' | 'deny' | 'allow' }[];
    /** valid: every value the declaration lists as valid; restrict: those it says restrict writes (Annex E, R7-6). The `on` value restricts. */
    read_only: { env: string; on: string; valid: string[]; restrict: string[]; empty_distinct: boolean } | null;
    tool_filters: { env: string; kind: 'allow' | 'deny'; separator: string }[];
  };
  /** MWS-SEC-1: extra values to look for (environment variable names; never the values) and URL query parameters that carry a token or a signature. */
  /** issuing_tools: tools that exist to issue a credential or a signed link (spec NF-16). */
  secrets: { canaries_env: string[]; token_params: string[]; issuing_tools: string[] };
  /** Read-only calls made before and after the run; their results must not change (untouched state). */
  canaries: { name: string; tool: string; args: unknown; path: string | null; ignore: string[] }[];
  review: ReviewSpec | null;
  /** Spec 7.3, rule 11: patterns (regular expressions, case-insensitive) by which the tester decides what a result says; a kind left out uses the default in src/checks/says.ts. */
  patterns: Partial<Record<'applied_all' | 'not_applied' | 'write_failed' | 'repeat_invited' | 'not_used' | 'outcome_unknown' | 'in_progress' | 'replay' | 'accepted' | 'repeat_refused' | 'unavailable' | 'earlier_failed' | 'applied' | 'no_tools' | 'retry_invited' | 'read_named' | 'version_required' | 'refused_value' | 'conflict', string>>;
  /** Annex E, NF-19: the tools whose operation the backend completes asynchronously (a result that says "accepted" or "pending" is then not a report of success). */
  async_operations: string[];
  /**
   * A declared structured outcome field (rule-11 coverage package): a path in the result's structured content and the
   * values that mean applied, not applied and unknown. Where it is given and the result carries one of the values, the
   * field decides what the result says about the write's outcome, and the record says so.
   */
  outcome_field: OutcomeField | null;
  /**
   * Spec 7.3, rule 11: a result shape adopted by name and version (`results: { shape, tools: { <tool>: { shape } } }`). A tool's
   * own entry overrides the top level; `shape: null` there adopts none for that tool. See src/checks/shape.ts.
   */
  results: { shape: ShapeName | null; tools: Record<string, ShapeName | null> };
  /** `session.init`: calls made on every MCP session before its first other tools/call; absent unless declared. */
  session?: { init: SessionInit[] };
  source: { path: string; sha256: string };
}

const fail = (where: string, why: string) => new WritecheckError(`manifest ${where}: ${why}`, 2);

function keys(o: Obj, allowed: string[], where: string): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw fail(where, `unknown key ${k} (allowed: ${allowed.join(', ')})`);
}
function obj(v: unknown, where: string): Obj {
  if (!isObj(v)) throw fail(where, 'an object');
  return v;
}
function str(v: unknown, where: string, re?: RegExp): string {
  if (typeof v !== 'string' || !v) throw fail(where, 'a non-empty string');
  if (re && !re.test(v)) throw fail(where, `${JSON.stringify(v)} must match ${re}`);
  return v;
}
function optStr(v: unknown, where: string): string | null {
  return v === undefined || v === null ? null : str(v, where);
}
function path(v: unknown, where: string): string {
  const p = str(v, where);
  parsePath(p);
  return p;
}
function num(v: unknown, d: number, min: number, max: number, where: string): number {
  if (v === undefined) return d;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw fail(where, `a number from ${min} to ${max}`);
  return v;
}
function strList(v: unknown, where: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x)) throw fail(where, 'a list of strings');
  return v as string[];
}
const ENV = /^[A-Za-z_][A-Za-z0-9_]*$/;

function tool(v: unknown, where: string, extra: string[] = []): ToolTemplate & Obj {
  const o = obj(v, where);
  keys(o, ['tool', 'args', ...extra], where);
  return { ...o, tool: str(o['tool'], `${where}.tool`), args: o['args'] ?? {} };
}

function http(v: unknown, where: string, extra: string[] = []): HttpTemplate {
  const o = obj(v, where);
  keys(o, ['http', 'body', 'headers', ...extra], where);
  const h = o['http'];
  if (!Array.isArray(h) || h.length !== 2 || typeof h[0] !== 'string' || typeof h[1] !== 'string') throw fail(`${where}.http`, '[METHOD, "/path"]');
  if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE)$/.test(h[0])) throw fail(`${where}.http[0]`, 'GET, HEAD, POST, PUT, PATCH or DELETE');
  if (!h[1].startsWith('/')) throw fail(`${where}.http[1]`, 'a path starting with /');
  const headers = o['headers'] === undefined ? undefined : obj(o['headers'], `${where}.headers`);
  if (headers) for (const k of Object.keys(headers)) if (k.toLowerCase() === 'authorization') throw fail(`${where}.headers`, 'the credential goes in control.auth (by environment variable name), never in a header template');
  return { http: [h[0], h[1]], ...(o['body'] !== undefined ? { body: o['body'] } : {}), ...(headers ? { headers: headers as Record<string, string> } : {}), ...(o['object'] !== undefined ? { object: path(o['object'], `${where}.object`) } : {}) };
}

function field(v: unknown, where: string): FieldSpec {
  const o = obj(v, where);
  keys(o, ['path', 'arg', 'values', 'empty', 'invalid', 'skip', 'control_key'], where);
  const skip = strList(o['skip'], `${where}.skip`);
  for (const s of skip) if (s !== 'empty' && s !== 'invalid') throw fail(`${where}.skip`, 'empty and/or invalid');
  const p = path(o['path'], `${where}.path`);
  const values = o['values'];
  if (!Array.isArray(values) || values.length !== 2 || JSON.stringify(values[0]) === JSON.stringify(values[1])) throw fail(`${where}.values`, 'two different values the tester may write');
  const stringy = typeof values[0] === 'string';
  return {
    path: p,
    arg: o['arg'] === undefined ? p : str(o['arg'], `${where}.arg`),
    control_key: o['control_key'] === undefined ? null : str(o['control_key'], `${where}.control_key`),
    values: [values[0], values[1]],
    // why: an explicit `empty: null` is a real value (unassign); only `skip` or a non-string field without one skips the case.
    empty: skip.includes('empty') ? null : Object.hasOwn(o, 'empty') ? { value: o['empty'] } : stringy ? { value: '' } : null,
    invalid: skip.includes('invalid') ? null : Object.hasOwn(o, 'invalid') ? { value: o['invalid'] } : { value: stringy ? 12345 : 'not-a-valid-value' },
  };
}

function control(v: unknown, where: string): ControlSpec {
  const o = obj(v, where);
  keys(o, ['base', 'base_env', 'auth', 'read', 'patch', 'write', 'delete', 'create'], where);
  const base = optStr(o['base'], `${where}.base`);
  const base_env = o['base_env'] === undefined ? null : str(o['base_env'], `${where}.base_env`, ENV);
  if ((base === null) === (base_env === null)) throw fail(where, 'give exactly one of base (a URL) or base_env (an environment variable name)');
  if (base) {
    try {
      new URL(base);
    } catch {
      throw fail(`${where}.base`, 'a URL');
    }
  }
  let auth: ControlSpec['auth'] = null;
  if (o['auth'] !== undefined) {
    const a = obj(o['auth'], `${where}.auth`);
    keys(a, ['bearer_env', 'header', 'env', 'prefix'], `${where}.auth`);
    if (a['bearer_env'] !== undefined) auth = { header: 'authorization', env: str(a['bearer_env'], `${where}.auth.bearer_env`, ENV), prefix: 'Bearer ' };
    else auth = { header: str(a['header'], `${where}.auth.header`), env: str(a['env'], `${where}.auth.env`, ENV), prefix: typeof a['prefix'] === 'string' ? a['prefix'] : '' };
  }
  return {
    base,
    base_env,
    auth,
    read: o['read'] === undefined ? null : http(o['read'], `${where}.read`, ['object']),
    patch: o['patch'] === undefined ? null : http(o['patch'], `${where}.patch`),
    write: o['write'] === undefined ? null : http(o['write'], `${where}.write`),
    delete: o['delete'] === undefined ? null : http(o['delete'], `${where}.delete`),
    create: o['create'] === undefined ? null : (() => {
      const c = http(o['create'], `${where}.create`, ['id']);
      const raw = obj(o['create'], `${where}.create`);
      return { ...c, id: path(raw['id'] ?? 'id', `${where}.create.id`) };
    })(),
  };
}

export const RESERVED_VARS = ['prefix', 'id', 'field', 'value', 'object', 'version', 'key', 'scope', 'marker', 'ids', 'batch', 'missing_id', 'names_inserted', 'position', 'element_id', 'n'];

function listSpec(v: unknown, where: string): ListSpec {
  const l = tool(v, where, ['items', 'id', 'name', 'ignore', 'next', 'decode']);
  let next: ListSpec['next'] = null;
  if (l['next'] !== undefined) {
    const n = obj(l['next'], `${where}.next`);
    keys(n, ['path', 'arg'], `${where}.next`);
    next = { path: path(n['path'], `${where}.next.path`), arg: str(n['arg'], `${where}.next.arg`) };
  }
  return { tool: l.tool, args: l.args, items: path(l['items'] ?? '$', `${where}.items`), id: path(l['id'] ?? 'id', `${where}.id`), name: path(l['name'] ?? 'name', `${where}.name`), ignore: strList(l['ignore'], `${where}.ignore`).map((p, j) => path(p, `${where}.ignore[${j}]`)), next, ...decodeOf(l['decode'], where) };
}

const optBool = (v: unknown, where: string): boolean | null => {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'boolean') throw fail(where, 'true or false');
  return v;
};

/** The Annex E statements of an idempotency block (MWS-RETRY-2); every one optional. */
function idemDeclaration(d: Obj, w: string): Pick<IdempotencySpec, 'kind' | 'version_steps' | 'vary' | 'own_checks' | 'backend_key' | 'key_record_survives' | 'key_lifetime'> {
  const kind = d['kind'] === undefined ? 'create' : String(d['kind']);
  if (!['create', 'update', 'append'].includes(kind)) throw fail(`${w}.kind`, 'create (the default), update or append');
  const own = strList(d['own_checks'], `${w}.own_checks`);
  for (const c of own) if (!['name', 'version', 'content'].includes(c)) throw fail(`${w}.own_checks`, `${c}: each is name, version or content (a check the tool makes whatever the key)`);
  let survives: IdempotencySpec['key_record_survives'] = null;
  if (d['key_record_survives'] !== undefined) {
    const k = obj(d['key_record_survives'], `${w}.key_record_survives`);
    keys(k, ['graceful', 'kill'], `${w}.key_record_survives`);
    survives = { graceful: optBool(k['graceful'], `${w}.key_record_survives.graceful`), kill: optBool(k['kill'], `${w}.key_record_survives.kill`) };
  }
  let lifetime: IdempotencySpec['key_lifetime'] = null;
  if (d['key_lifetime'] !== undefined) {
    const l = obj(d['key_lifetime'], `${w}.key_lifetime`);
    keys(l, ['ms', 'quote'], `${w}.key_lifetime`);
    lifetime = { ms: num(l['ms'], 0, 1, Number.MAX_SAFE_INTEGER, `${w}.key_lifetime.ms`), quote: str(l['quote'], `${w}.key_lifetime.quote`) };
    if (l['ms'] === undefined) throw fail(`${w}.key_lifetime.ms`, 'the stated lifetime in milliseconds');
  }
  const vs = optBool(d['version_steps'], `${w}.version_steps`);
  return {
    kind: kind as IdempotencySpec['kind'],
    version_steps: vs === true,
    vary: optStr(d['vary'], `${w}.vary`),
    own_checks: [...new Set(own)] as IdempotencySpec['own_checks'],
    backend_key: optBool(d['backend_key'], `${w}.backend_key`),
    key_record_survives: survives,
    key_lifetime: lifetime,
  };
}

function keySpec(v: unknown, where: string): { arg: string } | { meta: string } {
  const k = obj(v, where);
  keys(k, ['arg', 'meta'], where);
  if ((k['arg'] === undefined) === (k['meta'] === undefined)) throw fail(where, 'give arg (an argument name) or meta (a _meta field name)');
  return k['arg'] !== undefined ? { arg: str(k['arg'], `${where}.arg`) } : { meta: str(k['meta'], `${where}.meta`) };
}

function effectOf(v: unknown, where: string, word: 'deleted' | 'removed'): { path: string; value: unknown } | typeof word {
  if (v === word) return word;
  const e = obj(v, where);
  keys(e, ['path', 'value'], where);
  if (!Object.hasOwn(e, 'value')) throw fail(where, `{ path, value } (the field an applied item holds afterwards), or "${word}"`);
  return { path: path(e['path'], `${where}.path`), value: e['value'] };
}

/** A declared MWS-RES-1 effect: "deleted", "created", one condition, or a list of conditions (with "created" in it for a create). */
function effectSpecOf(v: unknown, where: string): { on: 'object' | 'new'; deleted: boolean; expect: EffectCond[] } {
  if (v === 'deleted') return { on: 'object', deleted: true, expect: [] };
  const items = Array.isArray(v) ? v : [v];
  if (!items.length) throw fail(where, '"deleted", "created", a condition, or a list of conditions');
  let created = false;
  const expect: EffectCond[] = [];
  items.forEach((x, k) => {
    const iw = Array.isArray(v) ? `${where}[${k}]` : where;
    if (x === 'created') return void (created = true);
    if (x === 'deleted') throw fail(iw, '"deleted" stands alone');
    const c = obj(x, iw);
    keys(c, ['path', 'value', 'pick', 'contains', 'lacks'], iw);
    const p = path(c['path'], `${iw}.path`);
    const n = ['value', 'contains', 'lacks'].filter((m) => Object.hasOwn(c, m));
    if (n.length !== 1) throw fail(iw, 'give exactly one of value, contains or lacks');
    if (c['pick'] !== undefined && n[0] !== 'value') throw fail(`${iw}.pick`, 'only with value');
    if (n[0] === 'value') expect.push({ path: p, value: c['value'], pick: c['pick'] === undefined ? null : path(c['pick'], `${iw}.pick`) });
    else if (n[0] === 'contains') expect.push({ path: p, contains: c['contains'] });
    else expect.push({ path: p, lacks: c['lacks'] });
  });
  if (!created && !expect.length) throw fail(where, 'a condition, "created" or "deleted"');
  return { on: created ? 'new' : 'object', deleted: false, expect };
}

function resource(v: unknown, i: number): ResourceSpec {
  const w = `resources[${i}]`;
  const o = obj(v, w);
  keys(o, ['name', 'vars', 'create', 'read', 'update', 'fields', 'version', 'delete', 'archive', 'list', 'cleanup', 'fixture', 'idempotency', 'control', 'missing_id', 'key', 'scope', 'selector', 'multi', 'list_edit', 'creates', 'failures', 'jobs', 'versioned', 'no_version_check', 'input_required', 'try_values', 'fixed_constraints', 'server_managed', 'restorable', 'effects'], w);
  const name = str(o['name'], `${w}.name`, /^[a-z][a-z0-9_-]{0,39}$/);
  const vars = o['vars'] === undefined ? {} : obj(o['vars'], `${w}.vars`);
  for (const k of Object.keys(vars)) if (RESERVED_VARS.includes(k)) throw fail(`${w}.vars.${k}`, 'a reserved template name');
  const read = tool(o['read'], `${w}.read`, ['object', 'settle_ms', 'ignore', 'items', 'match', 'decode']);
  if ((read['items'] === undefined) !== (read['match'] === undefined)) throw fail(`${w}.read`, 'items and match go together (a list read: the object is the item whose match field equals the id)');
  let update: ResourceSpec['update'] = null;
  let f: ResourceSpec['fields'] = null;
  if (o['update'] !== undefined) {
    const upd = tool(o['update'], `${w}.update`, ['mode', 'cases', 'override', 'apply']);
    if (upd['apply'] !== undefined && typeof upd['apply'] !== 'boolean') throw fail(`${w}.update.apply`, 'true or false');
    const mode = upd['mode'];
    if (!UPDATE_MODES.includes(mode as UpdateMode)) throw fail(`${w}.update.mode`, `one of ${UPDATE_MODES.join(', ')} (it decides which requirements apply)`);
    const cases: UpdateCase[] = [];
    if (upd['cases'] !== undefined) {
      if (!Array.isArray(upd['cases'])) throw fail(`${w}.update.cases`, 'a list of { name, args, expect }');
      (upd['cases'] as unknown[]).forEach((c, j) => {
        const cc = obj(c, `${w}.update.cases[${j}]`);
        keys(cc, ['name', 'args', 'expect'], `${w}.update.cases[${j}]`);
        const expect = obj(cc['expect'], `${w}.update.cases[${j}].expect`);
        for (const k of Object.keys(expect)) path(k, `${w}.update.cases[${j}].expect`);
        cases.push({ name: str(cc['name'], `${w}.update.cases[${j}].name`, /^[a-z][a-z0-9_]{0,39}$/), args: obj(cc['args'], `${w}.update.cases[${j}].args`), expect });
      });
    }
    const override = optStr(upd['override'], `${w}.update.override`);
    if (override && !(typeof upd.args === 'object' && upd.args !== null && Object.hasOwn(upd.args, override))) throw fail(`${w}.update.override`, `${override} must be one of the declared update arguments (the override they set)`);
    update = { tool: upd.tool, args: upd.args, mode: mode as UpdateMode, cases, override, apply: upd['apply'] === true };
    const fields = o['fields'];
    if (!Array.isArray(fields) || fields.length !== 2) throw fail(`${w}.fields`, 'exactly two independent fields (an update tool needs them)');
    f = [field(fields[0], `${w}.fields[0]`), field(fields[1], `${w}.fields[1]`)];
    if (f[0].path === f[1].path) throw fail(`${w}.fields`, 'two different fields');
  } else if (o['fields'] !== undefined) throw fail(`${w}.fields`, 'fields go with an update block');
  let create: ResourceSpec['create'] = null;
  if (o['create'] !== undefined) {
    const c = tool(o['create'], `${w}.create`, ['id', 'id_regex', 'name_path']);
    const idp = c['id'] === undefined ? null : path(c['id'], `${w}.create.id`);
    const idr = optStr(c['id_regex'], `${w}.create.id_regex`);
    if (idr) {
      const re = new RegExp(idr);
      if (!/\((?!\?)/.test(re.source)) throw fail(`${w}.create.id_regex`, 'a regex with one capture group for the id');
    }
    if (idp === null && idr === null) throw fail(`${w}.create`, 'give id (a path in the result) or id_regex (for ids in prose results)');
    create = { tool: c.tool, args: c.args, id: idp, id_regex: idr, name_path: c['name_path'] === undefined ? null : path(c['name_path'], `${w}.create.name_path`) };
  }
  let version: ResourceSpec['version'] = null;
  if (o['version'] !== undefined) {
    const vv = obj(o['version'], `${w}.version`);
    keys(vv, ['read', 'arg', 'optional', 'override'], `${w}.version`);
    version = { read: path(vv['read'], `${w}.version.read`), arg: optStr(vv['arg'], `${w}.version.arg`), optional: vv['optional'] === true, override: optStr(vv['override'], `${w}.version.override`) };
    if (version.override && !version.optional) throw fail(`${w}.version.override`, 'needs version.optional: true (the override is sent where the version is not)');
    if (version.optional && !version.arg) throw fail(`${w}.version.optional`, 'needs version.arg (the argument that is optional)');
  }
  const cleanup = o['cleanup'] === undefined ? null : (str(o['cleanup'], `${w}.cleanup`) as CleanupPolicy);
  if (cleanup !== null && !CLEANUP_POLICIES.includes(cleanup)) throw fail(`${w}.cleanup`, `one of ${CLEANUP_POLICIES.join(', ')}`);
  const ctl = o['control'] === undefined ? null : control(o['control'], `${w}.control`);
  const del = o['delete'] === undefined ? null : tool(o['delete'], `${w}.delete`);
  const archive = o['archive'] === undefined ? null : tool(o['archive'], `${w}.archive`);
  if (cleanup === 'delete' && !del) throw fail(`${w}.cleanup`, 'delete needs a delete block');
  if (cleanup === 'control_delete' && !ctl?.delete) throw fail(`${w}.cleanup`, 'control_delete needs control.delete');
  if (cleanup === 'archive' && !archive) throw fail(`${w}.cleanup`, 'archive needs an archive block');
  let fixture: ResourceSpec['fixture'] = null;
  if (o['fixture'] !== undefined) {
    const fx = obj(o['fixture'], `${w}.fixture`);
    keys(fx, ['id', 'name', 'name_path'], `${w}.fixture`);
    if (fx['id'] === undefined || fx['id'] === null || fx['id'] === '') throw fail(`${w}.fixture.id`, 'the id of a pre-made object');
    const fname = str(fx['name'], `${w}.fixture.name`);
    if (!/^[a-z][a-z0-9]{1,7}-/.test(fname)) throw fail(`${w}.fixture.name`, 'a pre-made fixture is accepted only if its name starts with the run prefix (mwsc-, or the manifest\'s prefix) and a dash');
    fixture = { id: fx['id'], name: fname, name_path: fx['name_path'] === undefined ? null : path(fx['name_path'], `${w}.fixture.name_path`) };
  }
  if (!create && !fixture) throw fail(w, 'give create (the tester makes its own object) or fixture (a pre-made object named mwsc-…)');
  const list = o['list'] === undefined ? null : listSpec(o['list'], `${w}.list`);
  let idem: ResourceSpec['idempotency'] = null;
  if (o['idempotency'] !== undefined) {
    const d = obj(o['idempotency'], `${w}.idempotency`);
    keys(d, ['tool', 'args', 'key', 'id', 'replay_marker', 'replay_text', 'kind', 'version_steps', 'vary', 'own_checks', 'backend_key', 'key_record_survives', 'key_lifetime'], `${w}.idempotency`);
    const t = d['tool'] === undefined ? create?.tool : str(d['tool'], `${w}.idempotency.tool`);
    if (!t) throw fail(`${w}.idempotency.tool`, 'the tool that takes the key (defaults to create.tool)');
    idem = {
      tool: t,
      args: d['args'] ?? create?.args ?? {},
      key: keySpec(d['key'], `${w}.idempotency.key`),
      id: d['id'] === undefined ? (create?.id ?? null) : path(d['id'], `${w}.idempotency.id`),
      replay_marker: d['replay_marker'] === undefined ? null : path(d['replay_marker'], `${w}.idempotency.replay_marker`),
      replay_text: optStr(d['replay_text'], `${w}.idempotency.replay_text`),
      ...idemDeclaration(d, `${w}.idempotency`),
    };
  }
  let key: ResourceSpec['key'] = null;
  if (o['key'] !== undefined) {
    const k = obj(o['key'], `${w}.key`);
    keys(k, ['arg', 'vary', 'class'], `${w}.key`);
    let vary: { arg: string; path: string } | null = null;
    if (k['vary'] !== undefined) {
      const vv = obj(k['vary'], `${w}.key.vary`);
      keys(vv, ['arg', 'path'], `${w}.key.vary`);
      vary = { arg: str(vv['arg'], `${w}.key.vary.arg`), path: path(vv['path'] ?? vv['arg'], `${w}.key.vary.path`) };
    }
    if (!create) throw fail(`${w}.key`, 'a caller-chosen key needs a create block');
    // R10-1: for a tool that does not call itself a create, upsert or apply (run, start, deploy, …), the class it was put in and
    // the words of its name or description relied on.
    let cls: { as: 'create' | 'upsert'; quote: string } | null = null;
    if (k['class'] !== undefined) {
      const c = obj(k['class'], `${w}.key.class`);
      keys(c, ['as', 'quote'], `${w}.key.class`);
      const as = str(c['as'], `${w}.key.class.as`);
      if (as !== 'create' && as !== 'upsert') throw fail(`${w}.key.class.as`, 'create or upsert');
      cls = { as, quote: str(c['quote'], `${w}.key.class.quote`) };
    }
    key = { arg: str(k['arg'], `${w}.key.arg`), vary, class: cls };
  }
  let scope: ResourceSpec['scope'] = null;
  if (o['scope'] !== undefined) {
    const sc = obj(o['scope'], `${w}.scope`);
    keys(sc, ['resource', 'arg', 'default', 'list'], `${w}.scope`);
    scope = { resource: str(sc['resource'], `${w}.scope.resource`), arg: str(sc['arg'], `${w}.scope.arg`), default: optStr(sc['default'], `${w}.scope.default`), list: listSpec(sc['list'], `${w}.scope.list`) };
  }
  let selector: ResourceSpec['selector'] = null;
  if (o['selector'] !== undefined) {
    const se = tool(o['selector'], `${w}.selector`, ['forms', 'narrow', 'send_empty_forms']);
    let narrow: Record<string, unknown> | null = null;
    if (se['narrow'] !== undefined) {
      narrow = obj(se['narrow'], `${w}.selector.narrow`);
      // why: the MWS-TGT-1 call on a selector tool must name only the tester's marked objects; a narrowing without {{marker}} could match others.
      // why: S3 of the 169b0cb re-run: every narrowing argument must be a string carrying {{marker}}, so none can render empty.
      if (!Object.keys(narrow).length || !Object.values(narrow).every((v) => typeof v === 'string' && /\{\{\s*marker\s*\}\}/.test(v))) throw fail(`${w}.selector.narrow`, 'arguments that limit the call to the objects named with {{marker}}: each value a string carrying {{marker}}, for example { title_prefix: "{{marker}}" }');
    }
    const forms = se['forms'];
    if (!Array.isArray(forms) || !forms.length) throw fail(`${w}.selector.forms`, 'the selector forms to try without opting in: [{ name, args }] (an omitted selector is { name: omitted, args: {} })');
    // why: a selector call outside the tester's container could match objects that are not the run's (spec MWS-TGT-2).
    if (!/\{\{\s*scope\s*\}\}/.test(JSON.stringify(se.args))) throw fail(`${w}.selector.args`, 'must bind the container with {{scope}} (the test runs only inside a container the tester created)');
    if (se['send_empty_forms'] !== undefined && typeof se['send_empty_forms'] !== 'boolean') throw fail(`${w}.selector.send_empty_forms`, 'true or false');
    selector = { tool: se.tool, args: se.args, narrow, send_empty_forms: se['send_empty_forms'] === true, forms: forms.map((x, j) => { const ff = obj(x, `${w}.selector.forms[${j}]`); keys(ff, ['name', 'args'], `${w}.selector.forms[${j}]`); if (ff['args'] !== undefined && Object.keys(obj(ff['args'], `${w}.selector.forms[${j}].args`)).some((k) => JSON.stringify(se.args).includes(`"${k}"`) && /\{\{\s*scope/.test(JSON.stringify((se.args as Record<string, unknown>)[k])))) throw fail(`${w}.selector.forms[${j}].args`, 'must not override the container argument'); return { name: str(ff['name'], `${w}.selector.forms[${j}].name`), args: ff['args'] === undefined ? {} : obj(ff['args'], `${w}.selector.forms[${j}].args`) }; }) };
  }
  const multi: MultiSpec[] = [];
  if (o['multi'] !== undefined) {
    if (!Array.isArray(o['multi'])) throw fail(`${w}.multi`, 'a list of multi-item tools');
    (o['multi'] as unknown[]).forEach((x, j) => {
      const mw = `${w}.multi[${j}]`;
      const m = tool(x, mw, ['effect', 'invalid_id', 'report']);
      let report: MultiSpec['report'] = null;
      if (m['report'] !== undefined) {
        const r = obj(m['report'], `${mw}.report`);
        keys(r, ['applied', 'id'], `${mw}.report`);
        report = { applied: path(r['applied'], `${mw}.report.applied`), id: r['id'] === undefined ? null : path(r['id'], `${mw}.report.id`) };
      }
      // why: note 25, R1 (tester safety): a multi-item tool told neither the run's container ({{scope}}) nor the exact ids
      // ({{ids}}) chooses its objects some other way (a prefix the server may ignore, a default project): it is never called.
      // why: Action CI SH-1: {{ids[n]}} and {{json:ids}} bind exactly the tester's objects too.
      const bind = multiBinding(m.args, null);
      if (!bind.scope && !bind.ids) throw fail(`${mw}.args`, `must bind the objects the call acts on: {{ids}} (the exact objects the tester made) or {{scope}} (the run's own container); ${m.tool} would otherwise choose its objects some other way, which can reach objects the tester did not create`);
      multi.push({ tool: m.tool, args: m.args, effect: effectOf(m['effect'], `${mw}.effect`, 'deleted') as MultiSpec['effect'], invalid_id: m['invalid_id'] ?? null, report });
    });
  }
  let listEdit: ResourceSpec['list_edit'] = null;
  if (o['list_edit'] !== undefined) {
    const lw = `${w}.list_edit`;
    const le = tool(o['list_edit'], lw, ['list', 'element', 'address', 'effect', 'insert']);
    const el = obj(le['element'] ?? {}, `${lw}.element`);
    keys(el, ['id', 'name'], `${lw}.element`);
    const ad = obj(le['address'], `${lw}.address`);
    keys(ad, ['by_id', 'by_position'], `${lw}.address`);
    const byId = optStr(ad['by_id'], `${lw}.address.by_id`);
    const byPos = optStr(ad['by_position'], `${lw}.address.by_position`);
    if (!byId && !byPos) throw fail(`${lw}.address`, 'by_id and/or by_position: the argument the tool addresses an element with');
    const ins = tool(le['insert'], `${lw}.insert`);
    listEdit = { tool: le.tool, args: le.args, list: path(le['list'], `${lw}.list`), element: { id: path(el['id'] ?? 'id', `${lw}.element.id`), name: path(el['name'] ?? 'name', `${lw}.element.name`) }, address: { by_id: byId, by_position: byPos }, effect: effectOf(le['effect'] ?? 'removed', `${lw}.effect`, 'removed') as ListEditSpec['effect'], insert: { tool: ins.tool, args: ins.args } };
  }
  const creates: CreateSpec[] = [];
  if (o['creates'] !== undefined) {
    if (!Array.isArray(o['creates'])) throw fail(`${w}.creates`, 'a list of create tools for objects inside or beside this one');
    (o['creates'] as unknown[]).forEach((x, j) => {
      const cw = `${w}.creates[${j}]`;
      const c = tool(x, cw, ['name', 'find', 'idempotency']);
      const fd = tool(c['find'], `${cw}.find`, ['items', 'id', 'match']);
      let ci: CreateSpec['idempotency'] = null;
      if (c['idempotency'] !== undefined) {
        const d = obj(c['idempotency'], `${cw}.idempotency`);
        keys(d, ['key'], `${cw}.idempotency`);
        ci = { key: keySpec(d['key'], `${cw}.idempotency.key`) };
      }
      creates.push({ name: str(c['name'], `${cw}.name`, /^[a-z][a-z0-9_-]{0,39}$/), tool: c.tool, args: c.args, find: { tool: fd.tool, args: fd.args, items: path(fd['items'] ?? '$', `${cw}.find.items`), id: path(fd['id'] ?? 'id', `${cw}.find.id`), match: path(fd['match'], `${cw}.find.match`) }, idempotency: ci });
    });
  }
  const failures: ResourceSpec['failures'] = [];
  if (o['failures'] !== undefined) {
    if (!Array.isArray(o['failures'])) throw fail(`${w}.failures`, 'a list of { name, tool, args } calls the backend will refuse');
    (o['failures'] as unknown[]).forEach((x, j) => {
      const t = tool(x, `${w}.failures[${j}]`, ['name']);
      failures.push({ name: str(t['name'], `${w}.failures[${j}].name`), tool: t.tool, args: t.args });
    });
  }
  const jobs: ResourceSpec['jobs'] = [];
  if (o['jobs'] !== undefined) {
    if (!Array.isArray(o['jobs'])) throw fail(`${w}.jobs`, 'a list of { name, calls: [{ tool, args }] }');
    (o['jobs'] as unknown[]).forEach((x, j) => {
      const jo = obj(x, `${w}.jobs[${j}]`);
      keys(jo, ['name', 'calls'], `${w}.jobs[${j}]`);
      if (!Array.isArray(jo['calls']) || !jo['calls'].length) throw fail(`${w}.jobs[${j}].calls`, 'a non-empty list of { tool, args }');
      jobs.push({ name: str(jo['name'], `${w}.jobs[${j}].name`), calls: (jo['calls'] as unknown[]).map((c, k) => { const t = tool(c, `${w}.jobs[${j}].calls[${k}]`); return { tool: t.tool, args: t.args }; }) });
    });
  }
  const versioned: ToolTemplate[] = [];
  if (o['versioned'] !== undefined) {
    if (!Array.isArray(o['versioned'])) throw fail(`${w}.versioned`, 'a list of { tool, args } whose args carry {{version}}');
    (o['versioned'] as unknown[]).forEach((x, j) => {
      const t = tool(x, `${w}.versioned[${j}]`);
      if (!/\{\{\s*version\s*\}\}/.test(JSON.stringify(t.args))) throw fail(`${w}.versioned[${j}].args`, 'must carry {{version}} where the tool takes the version the caller read');
      versioned.push({ tool: t.tool, args: t.args });
    });
    if (versioned.length && !version) throw fail(`${w}.versioned`, 'needs a version block (where the version is read)');
  }
  const inputRequired: ResourceSpec['input_required'] = [];
  if (o['input_required'] !== undefined) {
    if (!Array.isArray(o['input_required'])) throw fail(`${w}.input_required`, 'a list of { tool, args, answers, client_capabilities? }');
    (o['input_required'] as unknown[]).forEach((x, j) => {
      const t = tool(x, `${w}.input_required[${j}]`, ['answers', 'client_capabilities', 'effect']);
      let effect: { path: string; value: unknown } | null = null;
      if (t['effect'] !== undefined) {
        const e = obj(t['effect'], `${w}.input_required[${j}].effect`);
        keys(e, ['path', 'value'], `${w}.input_required[${j}].effect`);
        effect = { path: path(e['path'], `${w}.input_required[${j}].effect.path`), value: e['value'] };
      }
      const answers = obj(t['answers'], `${w}.input_required[${j}].answers`);
      const caps = t['client_capabilities'] === undefined ? { elicitation: { form: {} } } : obj(t['client_capabilities'], `${w}.input_required[${j}].client_capabilities`);
      inputRequired.push({ tool: t.tool, args: t.args, answers, client_capabilities: caps, effect });
    });
  }
  const effects: EffectSpec[] = [];
  if (o['effects'] !== undefined) {
    if (!Array.isArray(o['effects'])) throw fail(`${w}.effects`, 'a list of { tool, args, effect, answers?, client_capabilities? }');
    (o['effects'] as unknown[]).forEach((x, j) => {
      const ew = `${w}.effects[${j}]`;
      const t = tool(x, ew, ['effect', 'answers', 'client_capabilities']);
      const e = effectSpecOf(t['effect'], `${ew}.effect`);
      if (e.on === 'new' && (!o['create'] || !o['list'])) throw fail(`${ew}.effect`, 'created needs the resource\'s create and list blocks (the object is found by its {{marker}} through the list)');
      const answers = t['answers'] === undefined ? null : obj(t['answers'], `${ew}.answers`);
      const caps = t['client_capabilities'] === undefined ? (answers ? { elicitation: { form: {} } } : null) : obj(t['client_capabilities'], `${ew}.client_capabilities`);
      effects.push({ tool: t.tool, args: t.args, ...e, answers, client_capabilities: caps });
    });
  }
  const tryValues: ResourceSpec['try_values'] = [];
  if (o['try_values'] !== undefined) {
    if (!Array.isArray(o['try_values'])) throw fail(`${w}.try_values`, 'a list of { arg, value } or { arg, length }');
    if (!o['update']) throw fail(`${w}.try_values`, 'needs an update block (the values are tried through the update tool)');
    (o['try_values'] as unknown[]).forEach((x, j) => {
      const tv = obj(x, `${w}.try_values[${j}]`);
      keys(tv, ['arg', 'value', 'length'], `${w}.try_values[${j}]`);
      if ((tv['value'] === undefined) === (tv['length'] === undefined)) throw fail(`${w}.try_values[${j}]`, 'give exactly one of value or length');
      tryValues.push({ arg: str(tv['arg'], `${w}.try_values[${j}].arg`), ...(tv['value'] !== undefined ? { value: tv['value'] } : { length: num(tv['length'], 0, 1, 100_000, `${w}.try_values[${j}].length`) }) });
    });
  }
  const fixedConstraints: ResourceSpec['fixed_constraints'] = [];
  if (o['fixed_constraints'] !== undefined) {
    if (!Array.isArray(o['fixed_constraints'])) throw fail(`${w}.fixed_constraints`, 'a list of { arg, pattern, reason }');
    (o['fixed_constraints'] as unknown[]).forEach((x, j) => {
      const fc = obj(x, `${w}.fixed_constraints[${j}]`);
      keys(fc, ['arg', 'pattern', 'reason'], `${w}.fixed_constraints[${j}]`);
      const pattern = str(fc['pattern'], `${w}.fixed_constraints[${j}].pattern`);
      try {
        new RegExp(pattern, 'i');
      } catch (e) {
        throw fail(`${w}.fixed_constraints[${j}].pattern`, (e as Error).message);
      }
      fixedConstraints.push({ arg: str(fc['arg'], `${w}.fixed_constraints[${j}].arg`), pattern, reason: str(fc['reason'], `${w}.fixed_constraints[${j}].reason`) });
    });
  }
  return {
    name,
    vars,
    versioned,
    input_required: inputRequired,
    effects,
    try_values: tryValues,
    fixed_constraints: fixedConstraints,
    server_managed: strList(o['server_managed'], `${w}.server_managed`).map((x, j) => path(x, `${w}.server_managed[${j}]`)),
    restorable: restorableOf(o['restorable'], `${w}.restorable`, !!update),
    no_version_check: strList(o['no_version_check'], `${w}.no_version_check`),
    create,
    read: { tool: read.tool, args: read.args, object: read['object'] === undefined ? '$' : path(read['object'], `${w}.read.object`), settle_ms: num(read['settle_ms'], 0, 0, 60_000, `${w}.read.settle_ms`), ignore: strList(read['ignore'], `${w}.read.ignore`).map((p, j) => path(p, `${w}.read.ignore[${j}]`)), items: read['items'] === undefined ? null : path(read['items'], `${w}.read.items`), match: read['match'] === undefined ? null : path(read['match'], `${w}.read.match`), ...decodeOf(read['decode'], `${w}.read`) },
    update,
    fields: f,
    version,
    missing_id: o['missing_id'] ?? null,
    key,
    scope,
    selector,
    multi,
    list_edit: listEdit,
    creates,
    failures,
    jobs,
    delete: del,
    archive,
    list,
    cleanup,
    fixture,
    idempotency: idem,
    control: ctl,
  };
}

/**
 * `restorable: [priority, { arg: note, path: details.note }, { arg: force, call_only: true }]` (spec R15-4, Annex E): arguments the
 * tester may send through the update tool with a value other than the base call's and then put back. `call_only`: an argument that
 * acts on that call alone (an override, a dry run), put back by sending the base call without it; any other must be shown by the read.
 */
function restorableOf(v: unknown, w: string, hasUpdate: boolean): { arg: string; path: string; call_only?: boolean }[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw fail(w, 'a list of argument names, { arg, path } where the read shows the field under another path, or { arg, call_only: true } for an argument that acts on that call alone');
  if (v.length && !hasUpdate) throw fail(w, 'needs an update block (the tool that sets and puts back these arguments)');
  const out = v.map((x, j) => {
    if (typeof x === 'string' && x) return { arg: x, path: x };
    const e = obj(x, `${w}[${j}]`);
    keys(e, ['arg', 'path', 'call_only'], `${w}[${j}]`);
    const arg = str(e['arg'], `${w}[${j}].arg`);
    if (e['call_only'] !== undefined && typeof e['call_only'] !== 'boolean') throw fail(`${w}[${j}].call_only`, 'true or false');
    if (e['call_only'] === true && e['path'] !== undefined) throw fail(`${w}[${j}]`, 'call_only and path exclude each other: an argument that acts on that call alone is not read back');
    return { arg, path: e['path'] === undefined ? arg : path(e['path'], `${w}[${j}].path`), ...(e['call_only'] === true ? { call_only: true } : {}) };
  });
  const dup = out.map((x) => x.arg).find((a, k, all) => all.indexOf(a) !== k);
  if (dup) throw fail(w, `${dup} is listed twice`);
  return out;
}

/**
 * Spec R15-4: why a resource's update tool is not one that updates one object named by its identifier, so no argument of it may be
 * listed as restorable; null where it is. The same tool declared as another resource's delete, selector, multi-item or list-edit
 * tool (a dispatcher) counts too (re-review of 2443620).
 */
export function restorableExclusion(r: ResourceSpec, resources: ResourceSpec[]): string | null {
  if (!r.update) return 'the resource has no update tool';
  const t = r.update.tool;
  const also = resources.flatMap((x) => [x.delete?.tool === t ? 'delete' : '', x.selector?.tool === t ? 'selector' : '', x.multi.some((m) => m.tool === t) ? 'multi' : '', x.list_edit?.tool === t ? 'list_edit' : ''].filter(Boolean).map((k) => (x === r ? `this resource's ${k}` : `${x.name}'s ${k}`)));
  if (also.length) return `${t} is also ${[...new Set(also)].join(' and ')} tool`;
  const roots = templateRoots(r.update.args);
  if (!roots.has('id') && !roots.has('object')) return `update.args do not name the object by {{id}} or {{object}}`;
  return null;
}

const PATTERN_KINDS = ['applied_all', 'not_applied', 'write_failed', 'repeat_invited', 'not_used', 'outcome_unknown', 'in_progress', 'replay', 'accepted', 'repeat_refused', 'unavailable', 'earlier_failed', 'applied', 'no_tools', 'retry_invited', 'read_named', 'version_required', 'refused_value', 'conflict'] as const;

/**
 * What a multi-item tool's arguments bind, from the template's own parsed roots (series v7 BL-4: never a regex on the text, which
 * missed {{ ?scope }}, {{json:scope}}, {{scope.id}}): `scope` where a template refers to the run's container, or (with `scopeArg`)
 * a literal value sits under the scope argument; `ids` where a template refers to the tester's exact objects ({{ids}},
 * {{ids[0]}}, {{json:ids}}).
 */
export function multiBinding(args: unknown, scopeArg: string | null): { scope: boolean; ids: boolean } {
  const roots = templateRoots(args);
  const literal = !!scopeArg && isObj(args) && Object.hasOwn(args, scopeArg);
  return { scope: roots.has('scope') || literal, ids: roots.has('ids') };
}

export interface OutcomeField {
  path: string;
  applied: (string | number | boolean)[];
  not_applied: (string | number | boolean)[];
  unknown: (string | number | boolean)[];
}

function outcomeField(v: unknown): OutcomeField | null {
  if (v === undefined || v === null) return null;
  const o = obj(v, 'outcome_field');
  keys(o, ['path', 'applied', 'not_applied', 'unknown'], 'outcome_field');
  const vals = (k: 'applied' | 'not_applied' | 'unknown'): (string | number | boolean)[] => {
    const x = o[k];
    if (x === undefined) return [];
    const xs = Array.isArray(x) ? x : [x];
    if (xs.some((y) => !['string', 'number', 'boolean'].includes(typeof y))) throw fail(`outcome_field.${k}`, 'a value or a list of values (strings, numbers or booleans)');
    return xs as (string | number | boolean)[];
  };
  const f = { path: path(o['path'], 'outcome_field.path'), applied: vals('applied'), not_applied: vals('not_applied'), unknown: vals('unknown') };
  const all = [...f.applied, ...f.not_applied, ...f.unknown];
  if (!all.length) throw fail('outcome_field', 'at least one of applied, not_applied, unknown');
  if (new Set(all.map((x) => JSON.stringify(x))).size !== all.length) throw fail('outcome_field', 'a value may mean only one outcome');
  return f;
}

function shapeName(v: unknown, where: string): ShapeName | null {
  if (v === null) return null;
  // why: an unknown shape name or version is refused at load: a shape the tester cannot read would decide nothing, silently.
  if (typeof v !== 'string' || !(RESULT_SHAPES as readonly string[]).includes(v)) throw fail(where, `${JSON.stringify(v)} is not a result shape the tester knows (known: ${RESULT_SHAPES.join(', ')}; null adopts none)`);
  return v as ShapeName;
}

function resultsBlock(v: unknown): Manifest['results'] {
  const out: Manifest['results'] = { shape: null, tools: {} };
  if (v === undefined) return out;
  const r = obj(v, 'results');
  keys(r, ['shape', 'tools'], 'results');
  if (r['shape'] !== undefined) out.shape = shapeName(r['shape'], 'results.shape');
  if (r['tools'] !== undefined) {
    for (const [t, x] of Object.entries(obj(r['tools'], 'results.tools'))) {
      const e = obj(x, `results.tools.${t}`);
      keys(e, ['shape'], `results.tools.${t}`);
      if (e['shape'] === undefined) throw fail(`results.tools.${t}.shape`, 'the shape this tool adopts, or null for none');
      out.tools[t] = shapeName(e['shape'], `results.tools.${t}.shape`);
    }
  }
  return out;
}

function topLevel(o: Obj): Pick<Manifest, 'settings' | 'secrets' | 'canaries' | 'review' | 'patterns' | 'async_operations' | 'outcome_field' | 'results'> {
  const settings: Manifest['settings'] = { per_request: [], read_only: null, tool_filters: [] };
  if (o['settings'] !== undefined) {
    const st = obj(o['settings'], 'settings');
    keys(st, ['read_only', 'tool_filters', 'per_request'], 'settings');
    if (st['per_request'] !== undefined) {
      if (!Array.isArray(st['per_request'])) throw fail('settings.per_request', 'a list of { name, kind: read_only | deny | allow }: settings applied with a request');
      settings.per_request = (st['per_request'] as unknown[]).map((x, j) => {
        const pr = obj(x, `settings.per_request[${j}]`);
        keys(pr, ['name', 'kind'], `settings.per_request[${j}]`);
        const kind = String(pr['kind'] ?? '');
        if (kind !== 'read_only' && kind !== 'deny' && kind !== 'allow') throw fail(`settings.per_request[${j}].kind`, 'read_only, deny or allow');
        return { name: str(pr['name'], `settings.per_request[${j}].name`), kind };
      });
    }
    if (st['read_only'] !== undefined) {
      const ro = obj(st['read_only'], 'settings.read_only');
      keys(ro, ['env', 'on', 'valid', 'empty_distinct'], 'settings.read_only');
      // why: R7-6: the declaration says per valid value whether it restricts or permits writes ({ value: restrict | permit });
      // a plain list (the earlier form) does not say, so its values are treated as permitting and are not sent.
      let valid: string[] = [];
      const restrict: string[] = [];
      if (Array.isArray(ro['valid'])) valid = (ro['valid'] as unknown[]).map((x) => String(x));
      else if (ro['valid'] !== undefined) {
        for (const [k, x] of Object.entries(obj(ro['valid'], 'settings.read_only.valid'))) {
          if (x !== 'restrict' && x !== 'permit') throw fail(`settings.read_only.valid.${k}`, 'restrict or permit (whether the value restricts or permits writes)');
          valid.push(k);
          if (x === 'restrict') restrict.push(k);
        }
      }
      const on = String(ro['on'] ?? 'true');
      settings.read_only = { env: str(ro['env'], 'settings.read_only.env', ENV), on, valid, restrict: [...new Set([on, ...restrict])], empty_distinct: ro['empty_distinct'] === true };
    }
    if (st['tool_filters'] !== undefined) {
      if (!Array.isArray(st['tool_filters'])) throw fail('settings.tool_filters', 'a list of { env, kind: allow | deny }');
      settings.tool_filters = (st['tool_filters'] as unknown[]).map((x, j) => {
        const tf = obj(x, `settings.tool_filters[${j}]`);
        keys(tf, ['env', 'kind', 'separator'], `settings.tool_filters[${j}]`);
        const kind = String(tf['kind'] ?? '');
        if (kind !== 'allow' && kind !== 'deny') throw fail(`settings.tool_filters[${j}].kind`, 'allow or deny');
        return { env: str(tf['env'], `settings.tool_filters[${j}].env`, ENV), kind, separator: typeof tf['separator'] === 'string' ? tf['separator'] : ',' };
      });
    }
  }
  const secrets: Manifest['secrets'] = { canaries_env: [], token_params: [], issuing_tools: [] };
  if (o['secrets'] !== undefined) {
    const se = obj(o['secrets'], 'secrets');
    keys(se, ['canaries_env', 'token_params', 'issuing_tools'], 'secrets');
    secrets.issuing_tools = strList(se['issuing_tools'], 'secrets.issuing_tools');
    secrets.canaries_env = strList(se['canaries_env'], 'secrets.canaries_env');
    for (const n of secrets.canaries_env) if (!ENV.test(n)) throw fail('secrets.canaries_env', `${n} is not an environment variable name (canary values are never written in the manifest)`);
    secrets.token_params = strList(se['token_params'], 'secrets.token_params');
  }
  const canaries: Manifest['canaries'] = [];
  if (o['canaries'] !== undefined) {
    if (!Array.isArray(o['canaries'])) throw fail('canaries', 'a list of { name, tool, args, path?, ignore? } read-only calls');
    (o['canaries'] as unknown[]).forEach((x, j) => {
      const t = tool(x, `canaries[${j}]`, ['name', 'path', 'ignore']);
      canaries.push({ name: str(t['name'] ?? t.tool, `canaries[${j}].name`), tool: t.tool, args: t.args, path: t['path'] === undefined ? null : path(t['path'], `canaries[${j}].path`), ignore: strList(t['ignore'], `canaries[${j}].ignore`).map((p, k) => path(p, `canaries[${j}].ignore[${k}]`)) });
    });
  }
  let review: ReviewSpec | null = null;
  if (o['review'] !== undefined) review = reviewSpec(o['review'], 'review');
  const patterns: Manifest['patterns'] = {};
  if (o['patterns'] !== undefined) {
    const pt = obj(o['patterns'], 'patterns');
    keys(pt, [...PATTERN_KINDS], 'patterns');
    for (const k of PATTERN_KINDS) {
      const x = optStr(pt[k], `patterns.${k}`);
      if (x === null) continue;
      try {
        new RegExp(x, 'i');
      } catch (e) {
        throw fail(`patterns.${k}`, (e as Error).message);
      }
      patterns[k] = x;
    }
  }
  const async_operations = strList(o['async_operations'], 'async_operations');
  const results = resultsBlock(o['results']);
  return { settings, secrets, canaries, review, patterns, async_operations, outcome_field: outcomeField(o['outcome_field']), results };
}

/** A review block (in the manifest, or a separate answers file given with --review). */
export function reviewSpec(v: unknown, where: string): ReviewSpec {
  const r = obj(v, where);
  keys(r, ['by', 'conflict_says_not_applied', 'rejection_gives_reason', 'stale_writes_disclosed', 'conflict_says_reread', 'answers'], where);
  const re = (k: string) => {
    const x = optStr(r[k], `${where}.${k}`);
    if (x !== null) {
      try {
        new RegExp(x, 'i');
      } catch (e) {
        throw fail(`${where}.${k}`, (e as Error).message);
      }
    }
    return x;
  };
  const answers: ReviewSpec['answers'] = {};
  if (r['answers'] !== undefined) for (const [k, x] of Object.entries(obj(r['answers'], `${where}.answers`))) {
    if (typeof x === 'boolean') answers[k] = { answer: x, note: null };
    else {
      const a = obj(x, `${where}.answers.${k}`);
      keys(a, ['answer', 'note'], `${where}.answers.${k}`);
      if (typeof a['answer'] !== 'boolean') throw fail(`${where}.answers.${k}.answer`, 'true or false');
      answers[k] = { answer: a['answer'], note: optStr(a['note'], `${where}.answers.${k}.note`) };
    }
  }
  return { by: str(r['by'], `${where}.by`), conflict_says_not_applied: re('conflict_says_not_applied'), rejection_gives_reason: re('rejection_gives_reason'), stale_writes_disclosed: re('stale_writes_disclosed'), conflict_says_reread: re('conflict_says_reread'), answers };
}

/** A relative server.cwd is relative to the manifest's own folder, so a manifest works from any working directory. */
function cwdOf(cwd: string | null, manifestPath: string): string | null {
  if (cwd === null) return null;
  return isAbsolute(cwd) ? cwd : resolve(dirname(resolve(manifestPath)), cwd);
}

export function validateManifest(raw: unknown, source: { path: string; sha256: string }, opts: ManifestOptions = {}): Manifest {
  const o = obj(raw, '(top)');
  keys(o, ['mws', 'prefix', 'server', 'target', 'limits', 'backend', 'calls', 'resources', 'settings', 'secrets', 'canaries', 'review', 'patterns', 'async_operations', 'outcome_field', 'results', 'session'], '(top)');
  const mws = String(o['mws'] ?? '');
  if (!(MANIFEST_VERSIONS as readonly string[]).includes(mws)) throw fail('mws', `the requirements version this manifest is written for (${MANIFEST_VERSIONS.join(', ')})`);
  const s = obj(o['server'], 'server');
  keys(s, ['stdio', 'url', 'launch', 'protocol', 'headers_env', 'env_passthrough', 'env_public', 'env', 'cwd', 'processes', 'restart', 'decode'], 'server');
  let serverDecode: Record<string, DecodeMode> | null = null;
  let serverExtract: Record<string, Extract> | null = null;
  if (s['decode'] !== undefined) {
    const d = obj(s['decode'], 'server.decode');
    for (const [tool, v] of Object.entries(d)) {
      const dd = decodeOf(v, `server.decode.${tool}`);
      if (dd.decode) (serverDecode ??= {})[tool] = dd.decode;
      if (dd.extract) (serverExtract ??= {})[tool] = dd.extract;
    }
  }
  const stdio = s['stdio'] === undefined ? null : strList(s['stdio'], 'server.stdio');
  const url = optStr(s['url'], 'server.url');
  let launch: Manifest['server']['launch'] = null;
  if (s['launch'] !== undefined) {
    const l = obj(s['launch'], 'server.launch');
    keys(l, ['command', 'url_from', 'ready_timeout_ms'], 'server.launch');
    const command = strList(l['command'], 'server.launch.command');
    if (!command.length) throw fail('server.launch.command', 'the command that starts the server, and its arguments');
    const from = l['url_from'] === undefined ? '$' : str(l['url_from'], 'server.launch.url_from');
    if (from !== '$') parsePath(from);
    launch = { command, url_from: from, ready_timeout_ms: num(l['ready_timeout_ms'], 15_000, 100, 300_000, 'server.launch.ready_timeout_ms') };
  }
  if ([stdio !== null && stdio.length > 0, url !== null, launch !== null].filter(Boolean).length !== 1) throw fail('server', 'give exactly one of stdio (a command and its arguments), url (a streamable HTTP endpoint) or launch (a command that starts a streamable HTTP server and prints its URL)');
  const protocol = s['protocol'] === undefined ? 'auto' : String(s['protocol']);
  if (!(PROTOCOLS as readonly string[]).includes(protocol)) throw fail('server.protocol', `one of ${PROTOCOLS.join(', ')}`);
  if (url) {
    try {
      new URL(url);
    } catch {
      throw fail('server.url', 'a URL');
    }
  }
  const headers_env: Manifest['server']['headers_env'] = {};
  if (s['headers_env'] !== undefined) {
    for (const [h, v] of Object.entries(obj(s['headers_env'], 'server.headers_env'))) {
      if (typeof v === 'string') headers_env[h.toLowerCase()] = { env: str(v, `server.headers_env.${h}`, ENV), prefix: '' };
      else {
        const vv = obj(v, `server.headers_env.${h}`);
        keys(vv, ['env', 'prefix'], `server.headers_env.${h}`);
        headers_env[h.toLowerCase()] = { env: str(vv['env'], `server.headers_env.${h}.env`, ENV), prefix: typeof vv['prefix'] === 'string' ? vv['prefix'] : '' };
      }
    }
  }
  const env: Record<string, string> = {};
  if (s['env'] !== undefined) for (const [k, v] of Object.entries(obj(s['env'], 'server.env'))) env[str(k, 'server.env key', ENV)] = String(v);
  const processes = s['processes'] ?? 'separate';
  if (processes !== 'separate' && processes !== 'same') throw fail('server.processes', 'separate (one server process per writer) or same (two requests to one process)');
  let restart: Manifest['server']['restart'] = null;
  if (s['restart'] !== undefined) {
    const rs = obj(s['restart'], 'server.restart');
    keys(rs, ['stop'], 'server.restart');
    if (rs['stop'] !== 'graceful' && rs['stop'] !== 'kill') throw fail('server.restart.stop', 'graceful (SIGTERM, or closing stdin first for stdio) or kill (SIGKILL)');
    if (!stdio && !launch) throw fail('server.restart', 'needs server.stdio or server.launch: the tester restarts only a server it starts itself');
    restart = { stop: rs['stop'] };
  }
  const passthrough = strList(s['env_passthrough'], 'server.env_passthrough');
  for (const n of passthrough) if (!ENV.test(n)) throw fail('server.env_passthrough', `${n} is not an environment variable name`);
  const envPublic = strList(s['env_public'], 'server.env_public');
  for (const n of envPublic) if (!ENV.test(n)) throw fail('server.env_public', `${n} is not an environment variable name`);

  const t = obj(o['target'], 'target');
  keys(t, ['environment', 'confirm', 'allow_hosts', 'guard', 'refuse_fingerprints', 'provenance'], 'target');
  // why: F8: the build under test, for results.identity (core/identity.ts); validated here so plan refuses a bad one too.
  if (t['provenance'] !== undefined) parseProvenance(t['provenance'], 'manifest target.provenance');
  const environment = str(t['environment'], 'target.environment');
  let guard: Manifest['target']['guard'] = null;
  if (t['guard'] !== undefined) {
    const g = tool(t['guard'], 'target.guard', ['path', 'pattern', 'read_only', 'read_only_call', 'decode']);
    if (g['read_only'] !== undefined && typeof g['read_only'] !== 'boolean') throw fail('target.guard.read_only', 'true or false');
    if (g['read_only_call'] !== undefined && typeof g['read_only_call'] !== 'boolean') throw fail('target.guard.read_only_call', 'true or false');
    // why: a declared read-only call is the exact call the operator read; a template could make it another call.
    if (g['read_only_call'] === true && /\{\{/.test(JSON.stringify(g.args ?? {}))) throw fail('target.guard.args', 'with read_only_call: true, the arguments are written out in full (no {{...}} templates)');
    const pattern = str(g['pattern'], 'target.guard.pattern');
    try {
      new RegExp(pattern);
    } catch (e) {
      throw fail('target.guard.pattern', (e as Error).message);
    }
    guard = { tool: g.tool, args: g.args, path: g['path'] === undefined ? null : path(g['path'], 'target.guard.path'), pattern, read_only: g['read_only'] === true, ...(g['read_only_call'] === true ? { read_only_call: true } : {}), ...decodeOf(g['decode'], 'target.guard') };
  }
  const lim = o['limits'] === undefined ? {} : obj(o['limits'], 'limits');
  keys(lim, ['write_budget', 'writes_per_second', 'pairs', 'pair_repeats', 'pair_budget', 'stale_reps', 'gate_reps', 'timeout_ms', 'max_fuzz_cases'], 'limits');
  // why: review S2: the pair budget is opt-in (limits.pair_budget, or --pair-budget through opts); without it the defaults are as before.
  let pairBudget: { repeats: number; pairs: number } | null = null;
  if (opts.pairBudget) pairBudget = { ...opts.pairBudget };
  else if (lim['pair_budget'] !== undefined) {
    const pb = obj(lim['pair_budget'], 'limits.pair_budget');
    keys(pb, ['repeats', 'pairs'], 'limits.pair_budget');
    pairBudget = { repeats: num(pb['repeats'], PAIR_BUDGET.repeats, 1, 10, 'limits.pair_budget.repeats'), pairs: num(pb['pairs'], PAIR_BUDGET.pairs, 1, 5000, 'limits.pair_budget.pairs') };
  }
  const pairsDeclared = lim['pairs'] !== undefined;
  const pairs = num(lim['pairs'], pairBudget ? pairBudget.pairs : 40, 1, 5000, 'limits.pairs');
  const pairRepeats = lim['pair_repeats'] !== undefined ? num(lim['pair_repeats'], 1, 1, 10, 'limits.pair_repeats') : pairBudget && !pairsDeclared ? pairBudget.repeats : null;
  let backend: Manifest['backend'] = null;
  if (o['backend'] !== undefined) {
    const b = obj(o['backend'], 'backend');
    keys(b, ['gate'], 'backend');
    if (b['gate'] !== undefined) {
      const g = obj(b['gate'], 'backend.gate');
      keys(g, ['rewrite_env', 'node_import', 'hold_timeout_ms'], 'backend.gate');
      if (g['node_import'] !== undefined && typeof g['node_import'] !== 'boolean') throw fail('backend.gate.node_import', 'true or false');
      const rewrite = g['rewrite_env'] === undefined ? null : str(g['rewrite_env'], 'backend.gate.rewrite_env', ENV);
      const nodeImport = g['node_import'] === true;
      if ((rewrite !== null) === nodeImport) throw fail('backend.gate', 'give exactly one route: rewrite_env (the variable that holds the backend URL; the tester points it at a loopback gate) or node_import: true (a Node server loads the in-process hook)');
      backend = { gate: { rewrite_env: rewrite, node_import: nodeImport, hold_timeout_ms: num(g['hold_timeout_ms'], 5_000, 100, 120_000, 'backend.gate.hold_timeout_ms') } };
    } else backend = { gate: null };
  }
  const calls: Manifest['calls'] = {};
  if (o['calls'] !== undefined) {
    for (const [name, c] of Object.entries(obj(o['calls'], 'calls'))) {
      const cc = obj(c, `calls.${name}`);
      keys(cc, ['args', 'resource'], `calls.${name}`);
      calls[name] = { args: cc['args'] ?? {}, resource: optStr(cc['resource'], `calls.${name}.resource`) };
    }
  }
  // why: a team may need its own recognisable prefix on the test objects (CLI-BUGS item 14); it must stay short and plain.
  const prefix = o['prefix'] === undefined ? 'mwsc' : str(o['prefix'], 'prefix');
  if (!/^[a-z][a-z0-9]{1,7}$/.test(prefix)) throw fail('prefix', 'two to eight lowercase letters or digits, starting with a letter (default mwsc)');
  if (!Array.isArray(o['resources']) || o['resources'].length === 0) throw fail('resources', 'at least one resource');
  const resources = (o['resources'] as unknown[]).map(resource);
  // why: spec R15-4, review of 3283a69 (5): restorable applies only to a tool that updates one object named by its identifier.
  for (const [i, r] of resources.entries()) {
    if (!r.restorable.length || !r.update) continue;
    const why = restorableExclusion(r, resources);
    if (why) throw fail(`resources[${i}].restorable`, `${why}; arguments may be listed only for a tool that updates one object named by its identifier (spec R15-4)`);
  }
  const names = new Set<string>();
  for (const r of resources) {
    if (names.has(r.name)) throw fail('resources', `${r.name} twice`);
    names.add(r.name);
  }
  // why: a pre-made object is written to; its name must carry the tester's own mark, never only a team prefix that real objects may share (review).
  for (const r of resources) if (r.fixture && !r.fixture.name.startsWith('mwsc-')) throw fail(`resources.${r.name}.fixture.name`, 'a pre-made fixture is accepted only if its name starts with mwsc-');
  for (const r of resources) if (r.scope && !resources.some((x) => x.name === r.scope!.resource && x.create && x.key)) throw fail(`resources.${r.name}.scope.resource`, `${r.scope.resource} must be a resource with create and key (the tester creates the scopes it uses)`);
  const m: Manifest = {
    mws,
    prefix,
    server: { stdio, url, launch, protocol: protocol as Manifest['server']['protocol'], headers_env, env_passthrough: passthrough, env_public: envPublic, env, cwd: cwdOf(optStr(s['cwd'], 'server.cwd'), source.path), processes, restart, ...(serverDecode ? { decode: serverDecode } : {}), ...(serverExtract ? { extract: serverExtract } : {}) },
    target: { environment, confirm: str(t['confirm'], 'target.confirm'), allow_hosts: strList(t['allow_hosts'], 'target.allow_hosts'), guard, refuse_fingerprints: strList(t['refuse_fingerprints'], 'target.refuse_fingerprints') },
    limits: {
      // why: F5: with a declared pair budget the default is sized to fit it (see defaultWriteBudget); a declared write_budget stays a hard cap.
      write_budget: num(lim['write_budget'], pairBudget ? defaultWriteBudget(resources, pairs, pairRepeats ?? 1) : 500, 1, MAX_WRITE_BUDGET, 'limits.write_budget'),
      writes_per_second: num(lim['writes_per_second'], 5, 0.1, 1000, 'limits.writes_per_second'),
      pairs,
      ...(pairRepeats !== null ? { pair_repeats: pairRepeats } : {}),
      ...(pairBudget ? { pair_budget: pairBudget } : {}),
      stale_reps: num(lim['stale_reps'], 3, 1, 100, 'limits.stale_reps'),
      gate_reps: num(lim['gate_reps'], 2, 1, 100, 'limits.gate_reps'),
      timeout_ms: num(lim['timeout_ms'], 30_000, 100, 600_000, 'limits.timeout_ms'),
      max_fuzz_cases: num(lim['max_fuzz_cases'], 200, 0, 1000, 'limits.max_fuzz_cases'),
    },
    backend,
    calls,
    resources,
    ...topLevel(o),
    ...((sess) => (sess ? { session: sess } : {}))(sessionOf(o['session'])),
    source,
  };
  // why: one decode mode per tool, and one extraction per tool (refused here, before anything runs).
  declaredDecodes(m);
  declaredExtracts(m);
  return m;
}

/** Load a manifest file; refused while any `# guessed` marker from `init` is left in it. */
/** Options that act as part of the declaration (they enter the limits, so the plan hash). */
export interface ManifestOptions {
  /** `--pair-budget RxP`: as `limits.pair_budget: { repeats: R, pairs: P }`, overriding it. */
  pairBudget?: { repeats: number; pairs: number } | null;
}

/** Parse `--pair-budget`: `2x1500` (repeats × pairs). */
export function parsePairBudget(v: string): { repeats: number; pairs: number } {
  const m = /^\s*(\d+)\s*[x×*]\s*(\d+)\s*$/i.exec(v);
  const repeats = m ? Number(m[1]) : NaN;
  const pairs = m ? Number(m[2]) : NaN;
  if (!m || repeats < 1 || repeats > 10 || pairs < 1 || pairs > 5000) throw new WritecheckError(`--pair-budget ${JSON.stringify(v)}: give repeats x pairs, e.g. 2x1500 (repeats 1 to 10, pairs 1 to 5000)`, 2);
  return { repeats, pairs };
}

export function loadManifest(file: string, opts: ManifestOptions = {}): Manifest {
  const text = readFileSync(file, 'utf8');
  return parseManifestText(text, file, opts);
}

export function parseManifestText(text: string, file: string, opts: ManifestOptions = {}): Manifest {
  const guessed = text.split('\n').map((l, i) => ({ l, i })).filter(({ l }) => l.includes(GUESSED));
  if (guessed.length) {
    throw new WritecheckError(`manifest ${file}: ${guessed.length} line(s) still marked "${GUESSED}" (first at line ${guessed[0]!.i + 1}). Read each guess, correct it, and remove the marker; that is the confirmation that a person checked it.`, 2);
  }
  return validateManifest(parseConfigText(text, file), { path: file, sha256: sha256(text) }, opts);
}
