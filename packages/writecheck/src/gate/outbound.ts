/**
 * The in-process route to the backend gate for Node servers: wraps globalThis.fetch in the server's
 * own process, so every request the server makes to its backend is logged (redacted) to JSONL and
 * the gate's rules apply to it: faults on the k-th matching request, and `hold`, which keeps a
 * request back until the tester releases it (a file appears) — the hold-and-release a forced
 * interleaving needs. Load it with `node --import mcp-writecheck/register`.
 */

import { appendFileSync } from 'node:fs';

import { existsSync } from 'node:fs';

import { assertEgressResolved, type EgressPolicy } from '../core/egress.js';
import { Redactor } from '../core/redact.js';
import { CHALLENGE_HTML, FaultStore, statusResponse, type FaultHit } from './faults.js';

export interface OutboundOptions {
  faults?: FaultStore;
  log?: string;
  secrets?: string[];
  /** Constrain where the server may connect. */
  egress?: EgressPolicy;
}

type FetchFn = typeof globalThis.fetch;

function fetchFailed(message: string, code?: string): TypeError {
  const cause = Object.assign(new Error(message), code ? { code } : {});
  return Object.assign(new TypeError('fetch failed'), { cause });
}

const sleep = (ms: number, signal?: AbortSignal | null) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), rej(signal.reason)), { once: true });
  });

/** Never resolves; rejects with the abort reason the way fetch does. */
const waitAbort = (signal?: AbortSignal | null) =>
  new Promise<never>((_, rej) => {
    if (signal?.aborted) return rej(signal.reason);
    signal?.addEventListener('abort', () => rej(signal.reason), { once: true });
  });

export function installOutbound(opts: OutboundOptions = {}): () => void {
  const original: FetchFn = globalThis.fetch;
  const real: FetchFn = opts.egress
    ? async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        // why: by name and by resolved address (a listed name that resolves to a metadata endpoint is refused).
        await assertEgressResolved(new URL(url), opts.egress!);
        return original(input, { ...(init ?? {}), redirect: 'manual' });
      }
    : original;
  const faults = opts.faults ?? new FaultStore();
  const red = new Redactor(opts.secrets ?? []);
  let seq = 0;
  const log = (o: Record<string, unknown>) => opts.log && appendFileSync(opts.log, red.text(JSON.stringify(o)) + '\n');

  const pid = process.pid;
  async function apply(rule: FaultHit, doFetch: () => Promise<Response>, signal: AbortSignal | null | undefined, url: string, method: string, rid: number): Promise<Response> {
    const commit = async () => {
      const r = await doFetch();
      const text = await r.text();
      log({ kind: 'commit', pid, rid, rule: rule.id, hit: rule.hit, method, url, status: r.status, bytes: text.length });
      return { r, text };
    };
    const ct = (r: Response) => ({ 'content-type': r.headers.get('content-type') ?? 'application/json' });
    switch (rule.fault) {
      case 'delay':
        await sleep(rule.delay_ms ?? 1000, signal);
        return doFetch();
      case 'connect_timeout':
        await sleep(rule.delay_ms ?? 10000, signal);
        throw fetchFailed('Connect Timeout Error', 'UND_ERR_CONNECT_TIMEOUT');
      case 'reset':
        throw fetchFailed('connect ECONNREFUSED', 'ECONNREFUSED');
      case 'hang':
        return waitAbort(signal);
      case 'commit_then_hang':
        await commit();
        return waitAbort(signal);
      case 'commit_then_reset':
        await commit();
        throw fetchFailed('other side closed', 'UND_ERR_SOCKET');
      case 'status':
      case 'commit_then_status':
      case 'rate_limit':
      case 'unauthorized':
      case 'forbidden':
      case 'server_error': {
        if (rule.fault === 'commit_then_status') await commit();
        const s = statusResponse(rule);
        return new Response(s.body || null, { status: s.status, headers: s.headers });
      }
      case 'truncate': {
        const src = rule.forward === false ? { r: null, text: rule.body ?? '' } : await commit();
        const cut = src.text.slice(0, Math.floor(src.text.length * (rule.frac ?? 0.5)));
        return new Response(cut, { status: src.r?.status ?? 200, headers: src.r ? ct(src.r) : {} });
      }
      case 'stream_cut': {
        const { r, text } = await commit();
        const half = new TextEncoder().encode(text.slice(0, Math.floor(text.length * (rule.frac ?? 0.5))));
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(half);
            setTimeout(() => c.error(Object.assign(new TypeError('terminated'), { cause: new Error('other side closed') })), 20);
          },
        });
        return new Response(body, { status: r.status, headers: ct(r) });
      }
      case 'malformed':
        return new Response(rule.body ?? CHALLENGE_HTML, { status: 200, headers: { 'content-type': 'text/html; charset=UTF-8' } });
      case 'empty':
        if (rule.forward) await commit();
        return new Response('', { status: rule.status ?? 200, headers: { 'content-type': 'application/json' } });
      case 'drip': {
        const { r, text } = await commit();
        const bytes = new TextEncoder().encode(text);
        const chunk = rule.chunk ?? 64;
        const every = rule.every_ms ?? 1000;
        let i = 0;
        let timer: NodeJS.Timeout | undefined;
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            signal?.addEventListener('abort', () => (clearTimeout(timer), c.error(signal.reason)), { once: true });
            const tick = () => {
              if (i >= bytes.length) return c.close();
              c.enqueue(bytes.slice(i, i + chunk));
              i += chunk;
              timer = setTimeout(tick, every);
            };
            tick();
          },
        });
        return new Response(body, { status: r.status, headers: ct(r) });
      }
      case 'duplicate': {
        const first = await commit();
        const second = await commit();
        const use = rule.return === 'first' ? first : second;
        return new Response(use.text, { status: use.r.status, headers: ct(use.r) });
      }
      case 'jsonrpc_error':
        return new Response(JSON.stringify({ error: rule.message ?? 'Internal error' }), { status: rule.status ?? 500 });
      case 'hold': {
        // why: a forced interleaving holds one writer's request until the other writer has finished.
        const until = Date.now() + (rule.delay_ms ?? 30_000);
        log({ kind: 'hold', pid, rid, rule: rule.id, hit: rule.hit, method, url });
        while (!(rule.release_file && existsSync(rule.release_file)) && Date.now() < until) await sleep(5, signal);
        log({ kind: 'release', pid, rid, rule: rule.id, hit: rule.hit, method, url, released_by: rule.release_file && existsSync(rule.release_file) ? 'file' : 'timeout' });
        return doFetch();
      }
    }
  }

  const wrapped: FetchFn = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const path = (() => {
      try {
        return new URL(url).pathname;
      } catch {
        return url;
      }
    })();
    const t0 = Date.now();
    const id = ++seq;
    // why: the arrival line gives the gate the order requests arrived in (completion lines come in finishing order).
    log({ kind: 'begin', pid, rid: id, t: t0, method, path });
    const rule = faults.match({ http_method: method, path });
    let status = 0;
    let err: string | undefined;
    try {
      const res = rule ? await apply(rule, () => real(input, init), init.signal, url, method, id) : await real(input, init);
      status = res.status;
      return res;
    } catch (e) {
      const c = (e as { cause?: { message?: string } }).cause;
      err = `${(e as Error).message}${c ? ` <- ${c.message ?? String(c)}` : ''}`;
      throw e;
    } finally {
      log({ kind: 'end', pid, rid: id, id, t: t0, ms: Date.now() - t0, method, path, url, status, err: err ?? null, rule: rule?.id ?? null, fault: rule?.fault ?? null, hit: rule?.hit ?? null });
    }
  };
  globalThis.fetch = wrapped;
  return () => {
    if (globalThis.fetch === wrapped) globalThis.fetch = original;
  };
}
