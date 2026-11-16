/**
 * The loopback gate for the base-URL route: an HTTP forwarder on 127.0.0.1 that the server is
 * pointed at instead of its backend. Every request is logged (order of arrival, method, path,
 * status) and sent on to the real backend unchanged (hop-by-hop headers aside), with normal TLS
 * verification and without following redirects, through the tester's egress list and the vetted
 * resolver (no cloud metadata address, by name or by resolved address). An armed hold keeps one
 * request back until it is released; an armed fault fails one request. Nothing is random: each is
 * the nth request matching a method and an exact path, counted from when it was armed.
 */

import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';

import { assertEgress, egressFor, vettedLookup, type EgressPolicy } from '../core/egress.js';
import { nowMs } from '../core/util.js';
import { MUTATING, type FaultHandle, type FaultSpec, type Gate, type GateRequest, type HoldHandle, type HoldSpec } from './gate.js';

const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length']);
/** A held request is let go after this long whatever happens, so a run can never hang on the gate. */
const HOLD_CEILING_MS = 120_000;

interface Armed<T> {
  spec: { method: string; path: string; nth: number };
  count: number;
  hit: GateRequest | null;
  waiters: ((r: GateRequest) => void)[];
  done: boolean;
  extra: T;
}

export class Forwarder implements Gate {
  readonly route = 'base_url' as const;
  private server: Server | null = null;
  private url = '';
  private seq = 0;
  private readonly log: GateRequest[] = [];
  private holds: Armed<{ release: () => void; released: Promise<void>; releasedAt: number | null }>[] = [];
  private faults: Armed<{ kind: FaultSpec['kind']; status: number }>[] = [];
  private readonly upstream: URL;

  constructor(
    private readonly envName: string,
    upstream: string,
    private readonly egress: EgressPolicy,
    readonly holdTimeoutMs: number,
  ) {
    this.upstream = new URL(upstream);
    // why: the gate's upstream is the manifest's backend, a host the tester is allowed to reach.
    for (const h of egressFor([upstream]).allow) if (!egress.allow.includes(h)) egress.allow.push(h);
    assertEgress(this.upstream, egress);
  }

  describe(): string {
    return `${this.envName} is set, for the server, to the loopback gate ${this.url || '(not started)'}, which forwards every request to ${this.upstream.origin}${this.upstream.protocol === 'https:' ? ' with normal TLS verification' : ''}; the tester's own value of ${this.envName} is the upstream`;
  }

  serverEnv(): Record<string, string> {
    const prefix = this.upstream.pathname === '/' ? '' : this.upstream.pathname.replace(/\/+$/, '');
    return { [this.envName]: `${this.url}${prefix}${this.upstream.search}` };
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  mark(): number {
    return this.seq;
  }

  async since(mark: number, settleMs = 50): Promise<GateRequest[]> {
    if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));
    return this.log.filter((r) => r.seq > mark).map((r) => ({ ...r }));
  }

  hold(spec: HoldSpec): HoldHandle {
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    const a: Armed<{ release: () => void; released: Promise<void>; releasedAt: number | null }> = { spec, count: 0, hit: null, waiters: [], done: false, extra: { release, released, releasedAt: null } };
    this.holds.push(a);
    return {
      waitHeld: (ms) => waitFor(a, ms),
      release: async () => {
        a.done = true;
        if (a.extra.releasedAt === null && a.hit) a.extra.releasedAt = nowMs();
        a.extra.release();
      },
      get heldRequest() {
        return a.hit ? { ...a.hit } : null;
      },
      get releasedAt() {
        return a.extra.releasedAt;
      },
    };
  }

  fault(spec: FaultSpec): FaultHandle {
    const a: Armed<{ kind: FaultSpec['kind']; status: number }> = { spec, count: 0, hit: null, waiters: [], done: false, extra: { kind: spec.kind, status: spec.status ?? 500 } };
    this.faults.push(a);
    return { waitHit: (ms) => waitFor(a, ms), clear: () => void (a.done = true) };
  }

  clear(): void {
    for (const h of this.holds) {
      h.done = true;
      if (h.hit && h.extra.releasedAt === null) h.extra.releasedAt = nowMs();
      h.extra.release();
    }
    for (const f of this.faults) f.done = true;
    this.holds = [];
    this.faults = [];
  }

  async stop(): Promise<void> {
    this.clear();
    const s = this.server;
    this.server = null;
    if (!s) return;
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }

  /** The first armed rule whose nth match this request is (counting this request for every armed rule it matches). */
  private take<T>(list: Armed<T>[], rec: GateRequest): Armed<T> | null {
    let hit: Armed<T> | null = null;
    for (const a of list) {
      if (a.done || a.hit) continue;
      // why: '*' as the method means "any mutating request", '*' as the path any path (the k-th write of a call whose paths are not known in advance).
      if (a.spec.method === '*' ? !rec.mutating : a.spec.method.toUpperCase() !== rec.method) continue;
      if (a.spec.path !== '*' && a.spec.path !== rec.path) continue;
      a.count++;
      if (a.count === a.spec.nth && !hit) hit = a;
    }
    return hit;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase();
    const target = new URL(req.url ?? '/', this.upstream.origin);
    const rec: GateRequest = { seq: ++this.seq, method, path: target.pathname, t_ms: nowMs(), mutating: MUTATING.has(method), status: null };
    this.log.push(rec);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const hold = this.take(this.holds, rec);
    if (hold) {
      hold.hit = rec;
      for (const w of hold.waiters.splice(0)) w({ ...rec });
      const ceiling = setTimeout(() => hold.extra.release(), HOLD_CEILING_MS);
      await hold.extra.released;
      clearTimeout(ceiling);
    }
    const fault = this.take(this.faults, rec);
    const mark = (status: number | null) => {
      rec.status = status;
      if (fault) {
        fault.hit = rec;
        for (const w of fault.waiters.splice(0)) w({ ...rec });
      }
    };
    if (fault && fault.extra.kind === 'status') {
      const status = fault.extra.status;
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'injected by the mcp-writecheck gate', status }));
      return mark(status);
    }
    let up: { status: number; headers: Record<string, string | string[]>; body: Buffer };
    try {
      up = await this.forward(method, target, req.headers, body);
    } catch (e) {
      res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: `gate: the backend could not be reached (${(e as Error).message})` }));
      return mark(502);
    }
    if (fault && fault.extra.kind === 'commit_then_hang') {
      // why: the backend has applied the request; its answer is held until the server goes away (or the ceiling), never delivered.
      mark(null);
      await new Promise<void>((r) => {
        const t = setTimeout(r, HOLD_CEILING_MS);
        req.socket.once('close', () => (clearTimeout(t), r()));
      });
      if (!req.socket.destroyed) req.socket.destroy();
      return;
    }
    if (fault && fault.extra.kind === 'commit_then_reset') {
      // why: the backend has applied the request; the server never hears back (a cut response).
      req.socket.destroy();
      return mark(null);
    }
    if (fault && fault.extra.kind === 'commit_then_status') {
      const status = fault.extra.status;
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'injected by the mcp-writecheck gate after the backend applied the request', status }));
      return mark(status);
    }
    res.writeHead(up.status, up.headers).end(up.body);
    mark(up.status);
  }

  private forward(method: string, target: URL, given: IncomingMessage['headers'], body: Buffer): Promise<{ status: number; headers: Record<string, string | string[]>; body: Buffer }> {
    assertEgress(target, this.egress);
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(given)) if (v !== undefined && !HOP.has(k.toLowerCase())) headers[k] = v;
    headers['host'] = target.host;
    if (body.length || !['GET', 'HEAD', 'DELETE', 'OPTIONS'].includes(method)) headers['content-length'] = String(body.length);
    return new Promise((resolve, reject) => {
      const r = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, { method, headers, agent: false, lookup: vettedLookup as never }, (res) => {
        const out: Buffer[] = [];
        res.on('data', (c: Buffer) => out.push(c));
        res.on('end', () => {
          const h: Record<string, string | string[]> = {};
          for (const [k, v] of Object.entries(res.headers)) if (v !== undefined && !HOP.has(k.toLowerCase())) h[k] = v;
          resolve({ status: res.statusCode ?? 502, headers: h, body: Buffer.concat(out) });
        });
        res.on('error', reject);
      });
      r.setTimeout(60_000, () => r.destroy(new Error('upstream timeout')));
      r.on('error', reject);
      r.end(body.length ? body : undefined);
    });
  }
}

function waitFor<T>(a: Armed<T>, ms: number): Promise<GateRequest | null> {
  if (a.hit) return Promise.resolve({ ...a.hit });
  return new Promise((r) => {
    const t = setTimeout(() => r(null), ms);
    a.waiters.push((x) => (clearTimeout(t), r(x)));
  });
}
