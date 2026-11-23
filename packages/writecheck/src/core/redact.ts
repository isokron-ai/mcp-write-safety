/**
 * Redaction for everything the tool writes to disk (capture, history, reports).
 *
 * Two layers: exact known secrets (the values of every environment variable the manifest passes
 * through or names for the control, and the user's own canary values) are replaced wherever they
 * appear, in literal and JSON-escaped form; and well-known credential shapes are masked even when
 * the tool was never told about them. Local path prefixes can be recorded by role (`<WORKSPACE>`).
 * A redaction marker never carries any part or hash of the secret.
 */

import { existsSync, realpathSync } from 'node:fs';

export const REDACTED = '[REDACTED]';

const PATTERNS: RegExp[] = [
  // Common published key shapes: personal and project API keys, source-hosting tokens, chat-platform
  // tokens, cloud access key ids, raw-download URL tokens, and JWTs.
  /\bphx_[A-Za-z0-9]{20,}\b/g,
  /\bph[cs]_[A-Za-z0-9]{20,}\b/g,
  /\bsk-(?:[a-z]{2,8}-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bGHSAT0[A-Z0-9]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
];

const BEARER = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const URL_PASSWORD = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi;

/**
 * Query parameters that carry a signature, a credential or a bearer value in
 * a signed or tokenised URL. Matched by exact name, case-insensitive,
 * so `page_token` or `next_token` (pagination) are not touched.
 *
 * - AWS SigV4 / SigV2 presigned: X-Amz-Signature, X-Amz-Credential, X-Amz-Security-Token, Signature, AWSAccessKeyId
 * - GCS signed URLs: X-Goog-Signature, X-Goog-Credential, GoogleAccessId, Signature
 * - CloudFront: Signature, Policy, Key-Pair-Id
 * - Azure SAS (identified by sv + sig): sig, plus the user-delegation key ids skoid, sktid
 *   (`sv` itself is the service version date and is kept)
 * - raw-download URLs: token, jwt
 * - generic: token, access_token, id_token, refresh_token, auth, api_key, apikey, key, sig, signature, client_secret, password
 */
export const SIGNED_QUERY_PARAMS = [
  'x-amz-signature', 'x-amz-credential', 'x-amz-security-token', 'awsaccesskeyid',
  'x-goog-signature', 'x-goog-credential', 'googleaccessid',
  'signature', 'policy', 'key-pair-id',
  'sig', 'skoid', 'sktid',
  'token', 'jwt', 'access_token', 'id_token', 'refresh_token', 'auth', 'api_key', 'apikey', 'key', 'client_secret', 'password',
];
/**
 * One query parameter: a separator (`?`, `&`, JSON-escaped `\u0026` as Go's
 * encoder writes it, HTML `&amp;`, or percent-encoded `%3F`/`%26` inside a
 * nested URL), the name, `=` or `%3D`, then the value up to the next
 * separator, quote, backslash, whitespace or fragment.
 */
const SIGNED_QUERY = new RegExp(
  `((?:[?&]|\\\\u0026|&amp;|%3[Ff]|%26)(?:${SIGNED_QUERY_PARAMS.map((p) => p.replace(/[-]/g, '\\-')).join('|')})(?:=|%3[Dd]))((?:(?!%26|&amp;|\\\\u0026)[^&\\s"'<>\\\\#])+)`,
  'gi',
);

/** Mask signed-URL query values (signatures, credentials, tokens) wherever a URL appears in text. */
export function maskSignedUrls(s: string): string {
  return s.replace(SIGNED_QUERY, (_m, pre: string) => `${pre}${REDACTED}`);
}

/** A header line in free text (`Cookie: a=b`, `Authorization: ...`), e.g. a curl dump echoed by a tool. */
const HEADER_LINE = /(\b(?:proxy-authorization|authorization|set-cookie|cookie|x-api-key|x-amz-security-token|x-goog-api-key)[ \t]*:[ \t]*)(?!\[REDACTED\])[^\r\n"\\]+/gi;

const SECRET_NAMES = 'proxy-authorization|authorization|cookie|set-cookie|password|passwd|secret|client_secret|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|token|private[_-]?key|x-api-key|x-amz-security-token|x-goog-api-key';
/** A key name in JSON text, unescaped (`"k"`) or once-escaped (`\"k\"`), then the colon. */
const JSON_KEY = new RegExp(`(\\\\?")(${SECRET_NAMES})\\1\\s*:\\s*`, 'gi');

/**
 * Generic `token` keys are also pagination cursors ("next-page-7"); mask
 * them only when the value looks like a credential. Every other secret name
 * is always masked (deliberate over-masking).
 */
export function looksSecret(v: string): boolean {
  return v.length >= 16 && !/\s/.test(v) && /[A-Za-z]/.test(v) && /\d/.test(v);
}

/** End index (exclusive) of a JSON string value starting at `i` (just past its opening quote). */
function stringEnd(t: string, i: number, escaped: boolean): number {
  for (let j = i; j < t.length; j++) {
    if (t[j] !== '\\' && t[j] !== '"') continue;
    if (t[j] === '"') return escaped ? -1 : j; // a bare quote ends a plain string; inside escaped JSON it can't occur
    let n = 0;
    while (t[j + n] === '\\') n++;
    const next = t[j + n];
    if (!escaped) {
      j += n; // plain JSON: each backslash escapes the next char
      if (n % 2 === 0 && next === '"') return j;
      continue;
    }
    // escaped JSON: the terminator is exactly \" ; \\\" (n=3) is an escaped quote inside the value
    if (next === '"' && n === 1) return j;
    j += n;
  }
  return -1;
}

function maskJsonValues(t: string): string {
  let out = '';
  let last = 0;
  JSON_KEY.lastIndex = 0;
  for (let m = JSON_KEY.exec(t); m; m = JSON_KEY.exec(t)) {
    const q = m[1] as string;
    const at = m.index + m[0].length;
    if (!t.startsWith(q, at)) continue; // value is not a string (number, null, object)
    const start = at + q.length;
    const end = stringEnd(t, start, q.length === 2);
    if (end < 0) continue;
    const value = t.slice(start, end);
    if ((m[2] as string).toLowerCase() === 'token' && !looksSecret(value)) continue;
    out += t.slice(last, start) + REDACTED;
    last = end;
    JSON_KEY.lastIndex = end;
  }
  return out + t.slice(last);
}

/** Argument keys whose values are always masked, whatever they contain. */
const SECRET_KEY = new RegExp(`^(${SECRET_NAMES})$`, 'i');

/** Header names whose values are always masked in captured headers. */
const SECRET_HEADER = /^(?:proxy-authorization|authorization|cookie|set-cookie|x-api-key|x-amz-security-token|x-goog-api-key|x-auth-token|x-csrf-token|x-xsrf-token|private-token)$/i;

/**
 * A local path prefix and the role it is recorded as: `/Users/me/project` with role `WORKSPACE`
 * is written `<WORKSPACE>`, so `/Users/me/project/sandbox/a.txt` becomes `<WORKSPACE>/sandbox/a.txt`.
 */
export interface ScrubPath {
  prefix: string;
  role: string;
}

export const SCRUB_ROLE = /^[A-Z][A-Z0-9_]{0,31}$/;

/** Parse `PREFIX=ROLE`; the prefix must be absolute. */
export function parseScrubPath(v: string): ScrubPath {
  const i = v.lastIndexOf('=');
  const prefix = i > 0 ? v.slice(0, i) : '';
  const role = i > 0 ? v.slice(i + 1) : '';
  if (!prefix.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(prefix)) throw new Error(`scrub path ${v}: PREFIX=ROLE with an absolute PREFIX`);
  if (!SCRUB_ROLE.test(role)) throw new Error(`scrub path ${v}: ROLE is 1-32 of [A-Z0-9_], starting with a letter`);
  return { prefix: prefix.length > 1 ? prefix.replace(/[\\/]+$/, '') : prefix, role };
}

/** `ROLE` plus a suffix, within the 32 characters a role may have. */
export const roleWithSuffix = (role: string, suffix: string): string => `${role.slice(0, 32 - suffix.length).replace(/_+$/, '')}${suffix}`;

/**
 * Each prefix, its real path where that differs, and the form without `/private` for macOS's
 * `/private/var`, `/private/tmp` and `/private/etc` (a process may report either for one folder).
 * The other spellings get their own markers, so a reader still sees which one the process reported:
 * the real path (and the `/private/…` form) as `<ROLE_REAL>`, the `/private`-less link form as
 * `<ROLE_LINK>`. A prefix already listed keeps its first role.
 */
export function withRealPaths(paths: readonly ScrubPath[]): ScrubPath[] {
  const out: ScrubPath[] = [];
  // role -> the role it is an alias of (itself for a given prefix): one marker never names two folders.
  const family = new Map<string, string>();
  for (const p of paths) if (!family.has(p.role)) family.set(p.role, p.role);
  const aliasRole = (base: string, kind: 'REAL' | 'LINK'): string => {
    for (let n = 1; ; n++) {
      const r = roleWithSuffix(base, n === 1 ? `_${kind}` : `_${kind}${n}`);
      const f = family.get(r);
      if (f === undefined || f === base) {
        family.set(r, base);
        return r;
      }
    }
  };
  const add = (prefix: string, role: string) => {
    if (!out.some((x) => x.prefix === prefix)) out.push({ prefix, role });
  };
  const real = (p: string): string | null => {
    try {
      return existsSync(p) ? realpathSync(p) : null;
    } catch {
      return null;
    }
  };
  for (const p of paths) add(p.prefix, p.role);
  for (const p of paths) {
    const r = real(p.prefix);
    if (r && r !== p.prefix) add(r, aliasRole(p.role, 'REAL'));
    for (const y of [p.prefix, r]) if (y && /^\/private\/(?:var|tmp|etc)\//.test(y)) add(y.slice('/private'.length), aliasRole(p.role, 'LINK'));
    if (/^\/(?:var|tmp|etc)\//.test(p.prefix)) add(`/private${p.prefix}`, aliasRole(p.role, 'REAL'));
  }
  return out;
}

const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * One regex for every prefix, in each form it is written in: as is, JSON-escaped (`\/`), and, for
 * a Windows path, with doubled backslashes. Longest first, so a workspace inside the home folder is
 * recorded as the workspace. A prefix matches only from and up to a path boundary: `/home/me` never
 * matches inside `/home/meg`, nor inside `/mnt/host/home/me` (another folder that ends the same
 * way). A slash before it is a boundary, so `file:///home/me/x` is still scrubbed.
 */
function scrubPattern(paths: readonly ScrubPath[]): { re: RegExp; roles: Map<string, string> } | undefined {
  const forms = new Map<string, string>();
  for (const p of paths) {
    if (p.prefix.length < 2) continue;
    for (const f of [p.prefix, p.prefix.replace(/\//g, '\\/'), p.prefix.replace(/\\/g, '\\\\')]) if (!forms.has(f)) forms.set(f, p.role);
  }
  if (forms.size === 0) return undefined;
  const alts = [...forms.keys()].sort((a, b) => b.length - a.length).map(reEscape);
  return { re: new RegExp(`(?<![A-Za-z0-9._@+~-])(?:${alts.join('|')})(?![A-Za-z0-9._@+~-])`, 'g'), roles: forms };
}

export class Redactor {
  private readonly secrets: string[];
  private escaped: RegExp[] | undefined;
  private readonly scrub: { re: RegExp; roles: Map<string, string> } | undefined;
  /** The path prefixes this redactor records by role. */
  readonly scrubPaths: readonly ScrubPath[];

  constructor(secrets: Iterable<string> = [], o: { paths?: ScrubPath[]; short?: Iterable<string> } = {}) {
    // why: longest first, so a secret that contains another is replaced whole. `short`: values that are secrets however short
    // (session.init's values given under a secret-like name), kept from three characters (a shorter one would mask parts of every
    // word); every other secret from six.
    this.secrets = [...new Set([...[...secrets].filter((s) => s.length >= 6), ...[...(o.short ?? [])].filter((s) => s.length >= 3)])].sort((a, b) => b.length - a.length);
    this.scrubPaths = (o.paths ?? []).map((p) => ({ ...p }));
    this.scrub = scrubPattern(this.scrubPaths);
  }

  /** Local path prefixes replaced by `<ROLE>`; a no-op without scrub paths. */
  paths(s: string): string {
    if (!this.scrub) return s;
    const { re, roles } = this.scrub;
    re.lastIndex = 0;
    return s.replace(re, (m) => `<${roles.get(m) ?? 'PATH'}>`);
  }

  /** Mask secrets inside a string. */
  text(s: string): string {
    return this.textWith(s, false);
  }

  /**
   * A manifest's text (the copy a run keeps): as text(), except that a header-like key whose value is a YAML flow collection
   * (`authorization: { env: TOKEN, prefix: "Bearer " }`, which names a variable, not a value) is left whole, so the copy stays
   * YAML that recheck can read. Credentials inside it are still masked by every other rule.
   */
  manifestText(s: string): string {
    return this.textWith(s, true);
  }

  private textWith(s: string, flowSafe: boolean): string {
    let out = this.paths(s);
    for (const k of this.secrets) out = out.split(k).join(REDACTED);
    for (const p of PATTERNS) out = out.replace(p, REDACTED);
    out = out.replace(BEARER, (_m, scheme: string) => `${scheme} ${REDACTED}`);
    out = out.replace(URL_PASSWORD, (_m, pre: string) => `${pre}${REDACTED}@`);
    out = maskSignedUrls(out);
    out = out.replace(HEADER_LINE, (m, pre: string) => {
      if (flowSafe && /^[[{]/.test(m.slice(pre.length))) return m;
      const scheme = /^(Bearer|Basic|Token)\s/i.exec(m.slice(pre.length));
      return `${pre}${scheme ? `${scheme[1]} ` : ''}${REDACTED}`;
    });
    // why: tool text often echoes JSON args back; mask secret-named keys inside JSON-looking text too (also \"escaped\" JSON).
    out = maskJsonValues(out);
    return out;
  }

  /**
   * A whole captured body: every literal or JSON-escaped form of each exact
   * secret (`\uXXXX`, `\/`), then the shape, signed-URL, header and
   * secret-key rules of `text`.
   */
  body(s: string): string {
    this.escaped ??= this.secrets.map(escapedPattern);
    return this.text(maskSecretsText(s, this.escaped)[0]);
  }

  /** Captured HTTP headers: secret-named headers masked whole, every other value scrubbed (signed URLs in Location ...). */
  headers(h: Iterable<[string, string]>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of h) {
      const name = k.toLowerCase();
      out[name] = SECRET_HEADER.test(name) ? REDACTED : this.text(v);
    }
    return out;
  }

  /** Deep-copy a JSON value with secret-named keys masked and string leaves scrubbed. */
  value<T>(v: T): T {
    return this.walk(v, false) as T;
  }

  /**
   * A tool catalog (tools/list): as value(), except that a secret-named key is masked only where its value is a string. In a
   * catalog such a key is the name of an argument (`properties.password`), and its value a schema the test hash reads (review
   * S1); a string under it is still masked, and every string leaf is still scrubbed.
   */
  catalogValue<T>(v: T): T {
    return this.walk(v, true) as T;
  }

  private walk(v: unknown, stringsOnly: boolean): unknown {
    if (typeof v === 'string') return this.text(v);
    if (Array.isArray(v)) return v.map((x) => this.walk(x, stringsOnly));
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        const secret = SECRET_KEY.test(k) && x !== null && x !== '' && (!stringsOnly || typeof x === 'string') && (k.toLowerCase() !== 'token' || (typeof x === 'string' && looksSecret(x)));
        if (secret) out[k] = REDACTED;
        else Object.defineProperty(out, k, { value: this.walk(x, stringsOnly), enumerable: true, writable: true, configurable: true });
      }
      return out;
    }
    return v;
  }
}

const reEsc = (c: string) => c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * One pattern per secret that matches it however a JSON encoder may have
 * written it: each character literally, as a \uXXXX escape (either hex
 * case), `/` also as `\/`, `"` as `\"` and `\` as `\\`. Mixed forms match too.
 */
export function escapedPattern(secret: string): RegExp {
  const parts = [...secret].map((c) => {
    const code = c.codePointAt(0) as number;
    const alts = [reEsc(c)];
    if (code <= 0xffff) {
      const hex = code.toString(16).padStart(4, '0');
      alts.push('\\\\u' + [...hex].map((h) => (/[a-f]/.test(h) ? `[${h}${h.toUpperCase()}]` : h)).join(''));
    }
    if (c === '/') alts.push('\\\\/');
    if (c === '"') alts.push('\\\\"');
    if (c === '\\') alts.push('\\\\\\\\');
    return `(?:${alts.join('|')})`;
  });
  return new RegExp(parts.join(''), 'g');
}

/** Raw-text layer: mask every literal or JSON-escaped form of each secret. */
export function maskSecretsText(text: string, patterns: RegExp[]): [string, number] {
  let n = 0;
  let out = text;
  for (const p of patterns) {
    p.lastIndex = 0;
    out = out.replace(p, () => (n++, REDACTED));
  }
  return [out, n];
}

