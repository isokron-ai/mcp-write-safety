/**
 * The wire gate: a loopback TCP listener the server is pointed at in place of its database
 * (Postgres, Redis, MongoDB). Each client connection gets its own upstream connection and a codec
 * session (codec.ts) that frames both directions into units and answers. Units are forwarded in
 * order per connection; a held unit, and a unit whose answer a fault needs whole (a barrier), block
 * only their own connection. Every unit with a request is logged (order of arrival, verb, target,
 * write or not, the backend's answer class) and matched against armed holds and faults, the nth
 * match counted from when each was armed, never at random (docs/WIRE-GATE.md).
 */

import { createServer, connect as netConnect, type AddressInfo, type Server, type Socket } from 'node:net';

import { assertEgress, egressFor, vettedLookup, type EgressPolicy } from '../../core/egress.js';
import { nowMs } from '../../core/util.js';
import type { FaultHandle, FaultSpec, Gate, GateRequest, HoldHandle, HoldSpec } from '../gate.js';
import { INJECTED, WireDesync, type ClientUnit, type CodecSession, type Intercept, type Outcome, type WireProtocol } from './codec.js';
import { defaultPort, rewriteUrl } from './url.js';

/** A held unit is let go after this long whatever happens, so a run can never hang on the gate. */
const HOLD_CEILING_MS = 120_000;
/** How long a unit waits for earlier answers on its connection (a barrier, or an answer the gate writes) before the gate closes the connection. */
const DEFAULT_BARRIER_MS = 60_000;

export type CodecFactory = (key: string) => CodecSession;

interface Armed<T> {
  spec: { method: string; path: string; nth: number };
  count: number;
  hit: GateRequest | null;
  waiters: ((r: GateRequest) => void)[];
  done: boolean;
  extra: T;
}
type HoldExtra = { release: () => void; released: Promise<void>; releasedAt: number | null };
type FaultExtra = { kind: FaultSpec['kind']; status: number; why: string | null };

interface QUnit {
  u: ClientUnit;
  rec: GateRequest | null;
  hold: Armed<HoldExtra> | null;
  fault: Armed<FaultExtra> | null;
}

interface Pending {
  q: QUnit;
  /** Pieces of the answer kept back (a fault or a deferred fault may replace them); null: streamed to the client. */
  buffer: Buffer[] | null;
  ic: Extract<Intercept, { forward: ClientUnit }> | null;
  done: () => void;
  finished: Promise<void>;
}

interface Deferred {
  fault: Armed<FaultExtra>;
  rec: GateRequest;
  conn: Conn;
  /** Redis: the write's position in the EXEC answer. */
  queuedIndex?: number;
  /** A ROLLBACK TO SAVEPOINT came after the write: whether the write was kept is not known. */
  savepoint?: boolean;
}

class Conn {
  readonly queue: QUnit[] = [];
  pumping = false;
  closed = false;
  /** commit_then_hang: everything from the backend is dropped from now on. */
  hung = false;
  /** A barrier unit is waiting for its answer: pass-through units (COPY data) go straight on. */
  inBarrier = false;
  readonly pending = new Map<number, Pending>();
  constructor(
    readonly id: number,
    readonly client: Socket,
    readonly upstream: Socket,
    public codec: CodecSession,
  ) {}
}

export class WireGate implements Gate {
  readonly route = 'wire' as const;
  private server: Server | null = null;
  private port = 0;
  private seq = 0;
  private unitIds = 0;
  private connIds = 0;
  private readonly log: GateRequest[] = [];
  private holds: Armed<HoldExtra>[] = [];
  private faults: Armed<FaultExtra>[] = [];
  private readonly conns = new Set<Conn>();
  /** commit_then_* faults that hit a write inside a transaction, by transaction key: applied at the commit. */
  private readonly deferred = new Map<string, Deferred>();
  private readonly upstream: URL;
  /** The gate's own egress list: the shared one plus its upstream (the tester's own HTTP client never gets the database host). */
  private readonly egress: EgressPolicy;
  private readonly barrierMs: number;

  constructor(
    readonly protocol: WireProtocol,
    private readonly envName: string,
    private readonly upstreamUrl: string,
    egress: EgressPolicy,
    readonly holdTimeoutMs: number,
    private readonly codec: CodecFactory,
    o: { barrierMs?: number } = {},
  ) {
    this.upstream = new URL(upstreamUrl);
    // why: the gate's upstream is the manifest's backend, a host the gate may reach; it is not added to the shared list, so no HTTP request of the tester can go there.
    this.egress = { allow: [...new Set([...egress.allow, ...egressFor([upstreamUrl]).allow])] };
    assertEgress(this.upstream, this.egress, { wire: true });
    this.barrierMs = o.barrierMs ?? DEFAULT_BARRIER_MS;
  }

  /** The hosts the gate itself may reach. */
  egressAllow(): string[] {
    return [...this.egress.allow];
  }

  private get upstreamHost(): string {
    return this.upstream.hostname.replace(/^\[|\]$/g, '');
  }
  private get upstreamPort(): number {
    return Number(this.upstream.port || defaultPort(this.upstream.protocol));
  }

  describe(): string {
    const name = { postgres: 'the Postgres v3 protocol', redis: 'RESP', mongodb: 'OP_MSG' }[this.protocol];
    return `${this.envName} is set, for the server, to the loopback wire gate at 127.0.0.1:${this.port || '(not started)'} (the same URL with only the host and port replaced${this.protocol === 'mongodb' ? ', and directConnection=true' : ''}), which forwards every connection to ${this.upstreamHost}:${this.upstreamPort} and reads ${name} to name, hold and fail requests; the tester's own value of ${this.envName} is the upstream`;
  }

  serverEnv(): Record<string, string> {
    return { [this.envName]: rewriteUrl(this.upstreamUrl, '127.0.0.1', this.port) };
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.server = createServer((s) => this.accept(s));
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as AddressInfo).port;
  }

  mark(): number {
    return this.seq;
  }

  async since(mark: number, settleMs = 50): Promise<GateRequest[]> {
    if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));
    return this.log.filter((r) => r.seq > mark).map(copy);
  }

  hold(spec: HoldSpec): HoldHandle {
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    const a: Armed<HoldExtra> = { spec, count: 0, hit: null, waiters: [], done: false, extra: { release, released, releasedAt: null } };
    this.holds.push(a);
    return {
      waitHeld: (ms) => waitFor(a, ms),
      release: async () => {
        a.done = true;
        if (a.extra.releasedAt === null && a.hit) a.extra.releasedAt = nowMs();
        a.extra.release();
      },
      get heldRequest() {
        return a.hit ? copy(a.hit) : null;
      },
      get releasedAt() {
        return a.extra.releasedAt;
      },
    };
  }

  fault(spec: FaultSpec): FaultHandle {
    const a: Armed<FaultExtra> = { spec, count: 0, hit: null, waiters: [], done: false, extra: { kind: spec.kind, status: spec.status ?? 500, why: null } };
    this.faults.push(a);
    return {
      waitHit: (ms) => waitFor(a, ms),
      clear: () => void (a.done = true),
      get why() {
        return a.extra.why;
      },
    };
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
    this.deferred.clear();
  }

  async stop(): Promise<void> {
    this.clear();
    for (const c of this.conns) this.close(c);
    const s = this.server;
    this.server = null;
    if (!s) return;
    await new Promise<void>((r) => s.close(() => r()));
  }

  private accept(client: Socket): void {
    const id = ++this.connIds;
    let upstream: Socket;
    try {
      upstream = netConnect({ host: this.upstreamHost, port: this.upstreamPort, lookup: vettedLookup as never });
    } catch {
      client.destroy();
      return;
    }
    const c = new Conn(id, client, upstream, this.codec(`conn:${id}`));
    this.conns.add(c);
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    client.on('data', (b: Buffer) => this.onClient(c, b));
    upstream.on('data', (b: Buffer) => this.onServer(c, b));
    const end = () => this.close(c);
    client.on('close', end);
    upstream.on('close', end);
    client.on('error', end);
    upstream.on('error', end);
  }

  private close(c: Conn): void {
    if (c.closed) return;
    c.closed = true;
    this.conns.delete(c);
    c.client.destroy();
    c.upstream.destroy();
    for (const p of c.pending.values()) p.done();
    // why: a Mongo session (lsid) outlives one pooled connection; a connection's own transaction ends with it.
    for (const [k, d] of this.deferred)
      if (d.conn === c && k.startsWith('conn:')) {
        this.deferred.delete(k);
        this.skip(d.fault, d.rec, 'the connection closed before the transaction ended');
      }
  }

  /** Framing lost, an answer that never came, or an internal error: record an uncertain write and close the connection (bytes already taken by the codec cannot be replayed faithfully). */
  private desync(c: Conn, e: Error): void {
    const rec: GateRequest = { seq: ++this.seq, method: '?', path: '', t_ms: nowMs(), mutating: true, status: null, wire: { protocol: this.protocol, statement: '', uncertain: `the gate closed the connection: ${e.message}` } };
    this.log.push(rec);
    this.close(c);
  }

  private onClient(c: Conn, b: Buffer): void {
    if (c.hung || c.closed) return;
    let units: ClientUnit[];
    try {
      units = c.codec.client(b);
    } catch (e) {
      // why: any error while reading the stream (not only a WireDesync) closes this connection, never the CLI.
      this.desync(c, e instanceof Error ? e : new WireDesync(String(e)));
      return;
    }
    for (const u of units) {
      let rec: GateRequest | null = null;
      let hold: Armed<HoldExtra> | null = null;
      let fault: Armed<FaultExtra> | null = null;
      if (u.req) {
        rec = { seq: ++this.seq, method: u.req.verb, path: u.req.path, t_ms: nowMs(), mutating: u.req.mutating, status: null, wire: { protocol: this.protocol, statement: u.req.statement, ...(u.req.uncertain ? { uncertain: u.req.uncertain } : {}), ...(u.req.statements ? { statements: u.req.statements } : {}) } };
        this.log.push(rec);
        hold = take(this.holds, rec);
        if (hold) {
          hold.hit = rec;
          for (const w of hold.waiters.splice(0)) w(copy(rec));
        }
        fault = take(this.faults, rec);
      }
      c.queue.push({ u, rec, hold, fault });
    }
    if (c.inBarrier) this.passThrough(c);
    this.pump(c).catch((e: unknown) => this.desync(c, e instanceof Error ? e : new Error(String(e))));
  }

  /** While a barrier waits: pass-through units at the head of the queue (COPY data the backend needs to answer it) go on. */
  private passThrough(c: Conn): void {
    while (c.queue[0] && !c.queue[0].rec && !c.queue[0].u.localReply && !c.closed) c.upstream.write(c.queue.shift()!.u.bytes);
  }

  /** Wait until every unit already forwarded on this connection is answered, so an answer the gate writes comes after theirs. False: the connection closed or timed out. */
  private async drain(c: Conn): Promise<boolean> {
    const ps = [...c.pending.values()].map((p) => p.finished);
    if (ps.length) {
      let t: NodeJS.Timeout | undefined;
      const ok = await Promise.race([Promise.all(ps).then(() => true), new Promise<boolean>((r) => (t = setTimeout(() => r(false), this.barrierMs)))]);
      clearTimeout(t);
      if (!ok) {
        this.desync(c, new Error(`earlier answers did not arrive within ${this.barrierMs} ms`));
        return false;
      }
    }
    return !c.closed;
  }

  /** The fault matched this request but is not applied (the request goes on as it is); the check sees no hit, and `why`. */
  private skip(fault: Armed<FaultExtra>, rec: GateRequest, why: string): void {
    fault.done = true;
    fault.extra.why = why;
    rec.wire = { ...rec.wire!, note: `fault not applied: ${why}` };
  }

  private async pump(c: Conn): Promise<void> {
    if (c.pumping) return;
    c.pumping = true;
    try {
      while (c.queue.length && !c.closed) {
        const q = c.queue[0]!;
        if (q.hold) {
          const h = q.hold;
          const ceiling = setTimeout(() => h.extra.release(), HOLD_CEILING_MS);
          await h.extra.released;
          clearTimeout(ceiling);
          if (h.extra.releasedAt === null) h.extra.releasedAt = nowMs();
          q.hold = null;
          if (c.closed) break;
        }
        c.queue.shift();
        await this.dispatch(c, q);
      }
    } finally {
      c.pumping = false;
    }
  }

  private async dispatch(c: Conn, q: QUnit): Promise<void> {
    const { u, rec } = q;
    if (u.localReply) {
      c.client.write(u.localReply);
      return;
    }
    if (!rec) {
      c.upstream.write(u.bytes);
      return;
    }
    const ic = c.codec.intercept(u);
    if (ic && 'synth' in ic) {
      // why: the gate's answer must come after the answers to everything sent before it (pipelining).
      if (!(await this.drain(c))) return;
      if (ic.synth.length) c.client.write(ic.synth);
      this.finishRec(rec, ic.outcome, true);
      if (q.fault) q.fault.count--; // why: an answer the gate wrote for its own emulation is not the backend request a fault names.
      return;
    }
    let fault = q.fault;
    if (fault && fault.extra.kind === 'status') {
      // why: the injected answer is ordered after earlier answers, and the transaction state it is judged by is the backend's after them.
      if (!(await this.drain(c))) return;
      const realTxn = c.codec.txn(u.txnKey);
      const cannot = c.codec.cannotInject?.(u, realTxn) ?? null;
      if (cannot) {
        this.skip(fault, rec, cannot);
        fault = null;
      } else {
        const inj = c.codec.injectError(u, INJECTED, realTxn);
        if (inj.bytes.length) c.client.write(inj.bytes);
        rec.status = fault.extra.status;
        rec.wire = { ...rec.wire!, synthetic: true, reply: 'injected error (not forwarded)', ...(inj.note ? { note: inj.note } : {}) };
        return this.hit(fault, rec);
      }
    }
    const deferredHere = u.txnKey ? this.deferred.get(u.txnKey) : undefined;
    const barrier = !!(fault && fault.extra.kind !== 'status') || !!deferredHere || !!(ic && 'forward' in ic);
    const id = ++this.unitIds;
    let done!: () => void;
    const finished = new Promise<void>((r) => (done = r));
    const p: Pending = { q, buffer: barrier ? [] : null, ic: ic && 'forward' in ic ? ic : null, done, finished };
    const fwd = p.ic ? p.ic.forward : u;
    if (u.noReply) {
      c.upstream.write(fwd.bytes);
      rec.wire = { ...rec.wire!, reply: 'no answer expected (moreToCome)' };
      // why: with no answer there is nothing to lose, and no way to know the write was applied.
      if (fault) this.skip(fault, rec, 'the request expects no answer, so whether it was applied is not known');
      return;
    }
    c.pending.set(id, p);
    c.codec.sent(id, fwd);
    c.upstream.write(fwd.bytes);
    if (barrier) {
      c.inBarrier = true;
      this.passThrough(c);
      let t: NodeJS.Timeout | undefined;
      const ok = await Promise.race([finished.then(() => true), new Promise<boolean>((r) => (t = setTimeout(() => r(false), this.barrierMs)))]);
      clearTimeout(t);
      c.inBarrier = false;
      if (!ok) this.desync(c, new Error(`the answer to #${rec.seq} did not arrive within ${this.barrierMs} ms`));
    }
  }

  private onServer(c: Conn, b: Buffer): void {
    if (c.hung || c.closed) return;
    let pieces;
    try {
      pieces = c.codec.server(b);
    } catch (e) {
      this.desync(c, e instanceof Error ? e : new WireDesync(String(e)));
      return;
    }
    const direct: Buffer[] = [];
    const flush = () => {
      if (direct.length) c.client.write(direct.length === 1 ? direct[0]! : Buffer.concat(direct));
      direct.length = 0;
    };
    for (const piece of pieces) {
      if (c.hung || c.closed) return;
      const p = piece.unit === null ? undefined : c.pending.get(piece.unit);
      if (!p) {
        if (piece.bytes.length) direct.push(piece.bytes);
        continue;
      }
      if (p.buffer) p.buffer.push(piece.bytes);
      else if (piece.bytes.length) direct.push(piece.bytes);
      if (piece.end) {
        flush();
        c.pending.delete(piece.unit!);
        this.finish(c, p, piece.end);
      }
    }
    flush();
  }

  private finishRec(rec: GateRequest, o: Outcome, synthetic = false): void {
    rec.status = o.status;
    rec.wire = { ...rec.wire!, reply: o.reply, txn: o.txn, ...(synthetic ? { synthetic: true } : {}) };
  }

  private finish(c: Conn, p: Pending, o: Outcome): void {
    const { q } = p;
    const rec = q.rec!;
    const send = () => {
      if (p.buffer?.length) c.client.write(Buffer.concat(p.buffer));
      p.buffer = null;
    };
    if (p.ic) {
      // The gate sent other bytes in the unit's place (emulation): their answer is swallowed and the gate's own is given.
      c.client.write(p.ic.answer);
      this.finishRec(rec, p.ic.outcome, true);
      p.done();
      return;
    }
    this.finishRec(rec, o);
    const key = q.u.txnKey;
    const d = key ? this.deferred.get(key) : undefined;
    const pass = () => (send(), p.done());
    if (q.fault && q.fault.extra.kind !== 'status') {
      // why: a lost answer is a trial only of a write that was carried out and kept (docs/WIRE-GATE.md §5.3).
      const notKept = o.status >= 400 ? `the write itself was refused (${o.reply})` : o.rolledBack ? `the request undid what it changed (${o.reply})` : null;
      if (notKept) return (this.skip(q.fault, rec, notKept), pass());
      if (o.txn === 'in' && key) {
        // why: inside a transaction the write is not committed yet; the answer to lose is the commit's.
        this.deferred.set(key, { fault: q.fault, rec, conn: c, ...(o.queuedIndex !== undefined ? { queuedIndex: o.queuedIndex } : {}) });
        rec.wire = { ...rec.wire!, deferred: { to: null, outcome: 'pending' } };
        return pass();
      }
      this.apply(c, q.fault, rec, o, p);
      return;
    }
    if (d && d.rec !== rec && /\bROLLBACK TO\b/i.test(rec.wire?.statement ?? '')) d.savepoint = true;
    if (d && o.ended) {
      this.deferred.delete(key!);
      const why = !o.committed
        ? `the transaction was not committed (${o.reply})`
        : d.savepoint
          ? 'a ROLLBACK TO SAVEPOINT came after the write: whether the write was kept is not known'
          : d.queuedIndex !== undefined && o.failedItems?.includes(d.queuedIndex)
            ? 'the write failed inside EXEC'
            : null;
      if (why) {
        d.rec.wire = { ...d.rec.wire!, deferred: { to: rec.seq, outcome: 'not committed' } };
        this.skip(d.fault, d.rec, why);
        return pass();
      }
      d.rec.wire = { ...d.rec.wire!, deferred: { to: rec.seq, outcome: 'committed' } };
      this.apply(c, d.fault, d.rec, o, p, rec);
      return;
    }
    pass();
  }

  /** Apply a commit_then_* fault to a unit whose answer is complete (and kept back). `rec` is the faulted request; `at` the unit answered (the commit, when deferred). */
  private apply(c: Conn, fault: Armed<FaultExtra>, rec: GateRequest, o: Outcome, p: Pending, at: GateRequest = rec): void {
    p.buffer = null;
    const kind = fault.extra.kind;
    if (kind === 'commit_then_status') {
      const inj = c.codec.injectError(p.q.u, INJECTED, o.txn);
      if (inj.bytes.length) c.client.write(inj.bytes);
      for (const r of new Set([rec, at])) {
        r.status = fault.extra.status;
        r.wire = { ...r.wire!, synthetic: true, ...(inj.note ? { note: inj.note } : {}) };
      }
      p.done();
      this.hit(fault, rec);
      return;
    }
    for (const r of new Set([rec, at])) {
      r.status = null;
      r.wire = { ...r.wire!, synthetic: true, reply: `${r.wire?.reply ?? ''} (answer ${kind === 'commit_then_reset' ? 'cut' : 'withheld'} by the gate)`.trim() };
    }
    if (kind === 'commit_then_reset') {
      this.hit(fault, rec);
      p.done();
      this.close(c);
      return;
    }
    // commit_then_hang: the server hears nothing more on this connection until it goes away (or the ceiling).
    c.hung = true;
    this.hit(fault, rec);
    p.done();
    const t = setTimeout(() => this.close(c), HOLD_CEILING_MS);
    c.client.once('close', () => clearTimeout(t));
  }

  private hit(fault: Armed<FaultExtra>, rec: GateRequest): void {
    fault.hit = rec;
    for (const w of fault.waiters.splice(0)) w(copy(rec));
  }
}

/** The first armed rule whose nth match this request is (counting this request for every armed rule it matches). */
function take<T>(list: Armed<T>[], rec: GateRequest): Armed<T> | null {
  let hit: Armed<T> | null = null;
  for (const a of list) {
    if (a.done || a.hit) continue;
    if (a.spec.method === '*' ? !rec.mutating : a.spec.method.toUpperCase() !== rec.method.toUpperCase()) continue;
    if (a.spec.path !== '*' && a.spec.path !== rec.path) continue;
    a.count++;
    if (a.count === a.spec.nth && !hit) hit = a;
  }
  return hit;
}

function waitFor<T>(a: Armed<T>, ms: number): Promise<GateRequest | null> {
  if (a.hit) return Promise.resolve(copy(a.hit));
  return new Promise((r) => {
    const t = setTimeout(() => r(null), ms);
    a.waiters.push((x) => (clearTimeout(t), r(x)));
  });
}

function copy(r: GateRequest): GateRequest {
  return { ...r, ...(r.wire ? { wire: { ...r.wire, ...(r.wire.deferred ? { deferred: { ...r.wire.deferred } } : {}) } } : {}) };
}
