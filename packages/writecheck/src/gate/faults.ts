/**
 * Backend fault rules for the gate: the outbound fetch hook (and, when it is built, the loopback
 * gate) apply them to the server's requests to its backend. Every fault is the k-th matching
 * request, never a probability, so a run is reproducible.
 *
 * A rules file is a JSON array re-read whenever its mtime changes, so a
 * harness can add a rule, make one call, and drop the rule again without
 * restarting the proxy. Matching is first-match in file order; each rule
 * applies to its first `n` matching calls (default 1, -1 = unlimited).
 *
 * A rule can target later matches: `nth: k` faults the k-th matching
 * call (the same as `skip: k-1`), `skip: s` lets the first s through, and
 * `every: m` then faults every m-th match from there (k, k+m, k+2m, ...),
 * still at most `n` times. A match is counted for a rule when the request
 * reaches it in file order, i.e. no earlier rule faulted that request; a match
 * the rule lets through is passed on to the rules after it.
 */

import { readFileSync, statSync } from 'node:fs';

export const FAULT_KINDS = [
  'delay', // slow upstream: wait delay_ms, then forward normally
  'hang', // never answer (until the client gives up)
  'connect_timeout', // wait delay_ms, then drop the connection without a response
  'reset', // drop the connection immediately
  'commit_then_hang', // forward (the write lands), then never answer
  'commit_then_reset', // forward, then drop the connection
  'status', // answer with `status`/`headers`/`body` without forwarding
  'commit_then_status', // forward, then answer with `status` (e.g. a 504 after the write landed)
  'rate_limit', // 429, with Retry-After only if `retry_after` is set
  'unauthorized', // 401 + WWW-Authenticate
  'forbidden', // 403
  'server_error', // 5xx (default 503)
  'truncate', // well-formed HTTP, body cut at `frac` (bad JSON)
  'stream_cut', // forward, send part of the body, then drop the connection
  'malformed', // 200 with an HTML challenge page instead of JSON
  'empty', // 200 with an empty body (forward first if `forward: true`)
  'drip', // forward, then send the body `chunk` bytes every `every_ms`
  'duplicate', // deliver the request upstream twice; return the `return` one (default second)
  'jsonrpc_error', // stdio: answer with a JSON-RPC error
  'hold', // hold the request until `release_file` exists (or delay_ms passes), then forward it
] as const;

export type FaultKind = (typeof FAULT_KINDS)[number];

export interface FaultRule {
  id: string;
  fault: FaultKind;
  /** Tool name for tools/call; exact, or a regex written as /.../ */
  tool?: string;
  /** JSON-RPC method (tools/call, tools/list, initialize ...). */
  rpc_method?: string;
  /** HTTP method of the upstream request. */
  http_method?: string;
  /** Regex over the upstream URL pathname. */
  path?: string;
  /** Only requests with a mutating method (POST, PUT, PATCH, DELETE). */
  mutating?: boolean;
  /** Matching calls to fault: default 1, -1 = unlimited. */
  n?: number;
  /** Let this many matching calls through before the first fault (default 0). */
  skip?: number;
  /** Fault the k-th matching call (1-based): the same as `skip: k-1`. */
  nth?: number;
  /** After the first faulted match, fault every m-th match (default: consecutive matches). */
  every?: number;
  delay_ms?: number;
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  retry_after?: number | string;
  frac?: number;
  chunk?: number;
  every_ms?: number;
  forward?: boolean;
  return?: 'first' | 'second';
  code?: number;
  message?: string;
  /** hold: the request is released when this file exists. */
  release_file?: string;
}

export interface FaultContext {
  tool?: string | undefined;
  rpc_method?: string | undefined;
  http_method?: string | undefined;
  path?: string | undefined;
}

export interface FaultHit extends FaultRule {
  /** How many times this rule has faulted, this one included (1-based). */
  hit: number;
  /** Which matching call this was for the rule (1-based), counting the ones it let through. */
  match: number;
}

function matches(pattern: string | undefined, value: string | undefined): boolean {
  if (pattern === undefined) return true;
  if (value === undefined) return false;
  const re = /^\/(.*)\/([a-z]*)$/.exec(pattern);
  return re ? new RegExp(re[1] as string, re[2]).test(value) : pattern === value;
}

export function validateFaultRules(input: unknown): FaultRule[] {
  if (!Array.isArray(input)) throw new Error('fault rules must be a JSON array');
  const seen = new Set<string>();
  return input.map((r: unknown, i) => {
    if (!r || typeof r !== 'object') throw new Error(`fault rule ${i} is not an object`);
    const rule = { ...(r as Record<string, unknown>) };
    if (typeof rule['id'] !== 'string' || !rule['id']) throw new Error(`fault rule ${i} needs an id`);
    if (seen.has(rule['id'])) throw new Error(`duplicate fault rule id ${rule['id']}`);
    seen.add(rule['id']);
    if (!FAULT_KINDS.includes(rule['fault'] as FaultKind)) throw new Error(`fault rule ${rule['id']}: unknown fault ${String(rule['fault'])}`);
    if (typeof rule['path'] === 'string') new RegExp(rule['path']); // throws on a bad regex
    const int = (k: string, min: number) => {
      const v = rule[k];
      if (v !== undefined && (typeof v !== 'number' || !Number.isInteger(v) || v < min)) throw new Error(`fault rule ${rule['id']}: ${k} must be a whole number >= ${min}`);
    };
    int('skip', 0);
    int('nth', 1);
    int('every', 1);
    if (rule['n'] !== undefined && (typeof rule['n'] !== 'number' || !Number.isInteger(rule['n']) || (rule['n'] < 0 && rule['n'] !== -1))) throw new Error(`fault rule ${rule['id']}: n must be a whole number >= 0, or -1 for unlimited`);
    if (rule['nth'] !== undefined && rule['skip'] !== undefined) throw new Error(`fault rule ${rule['id']}: give nth or skip, not both`);
    return rule as unknown as FaultRule;
  });
}

/** Fault rules from a file (hot-reloaded) and/or set programmatically. */
export class FaultStore {
  private fileRules: FaultRule[] = [];
  private sig = '';
  private extra: FaultRule[] = [];
  private readonly hits = new Map<string, number>();
  private readonly seen = new Map<string, number>();

  constructor(private readonly file?: string) {}

  set(rules: FaultRule[]): void {
    this.extra = validateFaultRules(rules);
  }

  rules(): FaultRule[] {
    if (this.file) {
      try {
        // why: a rules file rewritten within one clock tick keeps its mtime; inode and size tell it apart (writers replace it by rename).
        const st = statSync(this.file);
        const sig = `${st.ino}:${st.size}:${st.mtimeMs}`;
        if (sig !== this.sig) {
          this.sig = sig;
          this.fileRules = validateFaultRules(JSON.parse(readFileSync(this.file, 'utf8')));
        }
      } catch (e) {
        // why: a missing or half-written rules file means "no faults", never a crash mid-run.
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') this.fileRules = [];
      }
    }
    return [...this.fileRules, ...this.extra];
  }

  match(ctx: FaultContext): FaultHit | null {
    for (const r of this.rules()) {
      if (!matches(r.tool, ctx.tool)) continue;
      if (!matches(r.rpc_method, ctx.rpc_method)) continue;
      if (r.http_method && r.http_method.toUpperCase() !== ctx.http_method?.toUpperCase()) continue;
      if (r.mutating && !['POST', 'PUT', 'PATCH', 'DELETE'].includes(ctx.http_method?.toUpperCase() ?? '')) continue;
      if (r.path !== undefined && (ctx.path === undefined || !new RegExp(r.path).test(ctx.path))) continue;
      const h = this.hits.get(r.id) ?? 0;
      const n = r.n ?? 1;
      if (n !== -1 && h >= n) continue;
      const m = (this.seen.get(r.id) ?? 0) + 1;
      this.seen.set(r.id, m);
      const skip = r.nth !== undefined ? r.nth - 1 : (r.skip ?? 0);
      if (m <= skip) continue;
      if (r.every !== undefined && (m - skip - 1) % r.every !== 0) continue;
      this.hits.set(r.id, h + 1);
      return { ...r, hit: h + 1, match: m };
    }
    return null;
  }
}

/** Status-style faults resolved to status + headers + body. */
export function statusResponse(rule: FaultRule): { status: number; headers: Record<string, string>; body: string } {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(rule.headers ?? {}) };
  const retry: Record<string, string> = rule.retry_after !== undefined ? { 'retry-after': String(rule.retry_after) } : {};
  const err = (status: number, message: string) => ({
    status: rule.status ?? status,
    headers: { ...headers, ...retry },
    body: rule.body ?? JSON.stringify({ error: message }),
  });
  switch (rule.fault) {
    case 'rate_limit':
      return err(429, 'Too Many Requests');
    case 'unauthorized':
      return { ...err(401, 'Unauthorized'), headers: { ...headers, ...retry, 'www-authenticate': 'Bearer error="invalid_token"' } };
    case 'forbidden':
      return err(403, 'Forbidden');
    case 'server_error':
      return err(503, 'Service Unavailable');
    default:
      return { status: rule.status ?? 500, headers: { ...headers, ...retry }, body: rule.body ?? '' };
  }
}

export const CHALLENGE_HTML =
  '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>';
