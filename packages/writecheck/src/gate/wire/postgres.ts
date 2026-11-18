/**
 * Postgres frontend/backend protocol v3 for the wire gate (docs/WIRE-GATE.md §3, §4.1, §5).
 *
 * Client side: the untyped startup packet (SSLRequest and GSSENCRequest are answered N by the gate,
 * CancelRequest is passed through), then typed messages. A unit is a simple Query, a FunctionCall,
 * or the extended messages (Parse/Bind/Describe/Execute/Close) up to and including Sync or Flush.
 * Authentication, COPY data and Terminate are passthrough.
 *
 * Server side: messages before the first ReadyForQuery belong to no unit; NoticeResponse,
 * ParameterStatus and NotificationResponse never do. A Sync, Query or FunctionCall unit ends at
 * ReadyForQuery; a Flush unit when each of its messages is answered, or at the first ErrorResponse
 * (the backend then skips to the next Sync, and the Flush units in between end with it).
 */

import { cut, INJECTED, WireDesync, type Classified, type ClientUnit, type CodecSession, type Intercept, type Outcome, type ServerPiece, type TxnState } from './codec.js';
import { classifySql, combine, type Prepared, type StatementClass } from './sql.js';

const SSL_REQUEST = 80877103;
const GSSENC_REQUEST = 80877104;
const CANCEL_REQUEST = 80877102;
/** Largest message the gate frames (the backend's own limit for a query is 1 GB). */
const MAX_MESSAGE = 1 << 30;

interface Msg {
  t: string;
  /** Describe and Close: 'S' (statement) or 'P' (portal). */
  sub?: string;
}

interface Meta {
  kind: 'query' | 'call' | 'sync' | 'flush';
  msgs: Msg[];
  verbs: string[];
}

interface Inflight {
  id: number;
  meta: Meta;
  /** Answers still expected (flush units): parse, bind, close, describe, execute. */
  left: number;
  error: string | null;
  tags: string[];
  before: TxnState;
}

function msg(type: string, body: Buffer): Buffer {
  const h = Buffer.alloc(5);
  h.write(type, 0, 'latin1');
  h.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([h, body]);
}
const cstr = (s: string) => Buffer.from(`${s}\0`, 'utf8');
export const pg = {
  query: (sql: string) => msg('Q', cstr(sql)),
  ready: (s: TxnState) => msg('Z', Buffer.from(s === 'idle' ? 'I' : s === 'in' ? 'T' : 'E', 'latin1')),
  complete: (tag: string) => msg('C', cstr(tag)),
  error: (code: string, message: string) => msg('E', Buffer.concat([cstr(`SERROR`), cstr(`VERROR`), cstr(`C${code}`), cstr(`M${message}`), Buffer.from([0])])),
  msg,
  cstr,
};

function readCstr(b: Buffer, at: number): [string, number] {
  const z = b.indexOf(0, at);
  if (z < 0) throw new WireDesync('postgres: unterminated string in a message');
  return [b.toString('utf8', at, z), z + 1];
}

const txnOf = (z: number): TxnState => (z === 0x54 ? 'in' : z === 0x45 ? 'failed' : 'idle');

/** HTTP-equivalent status of a SQLSTATE (docs/WIRE-GATE.md §5.4). */
export function pgStatus(code: string | null): number {
  if (!code) return 200;
  return /^(08|53|57|58|XX)/.test(code) ? 503 : 400;
}

export class PostgresSession implements CodecSession {
  readonly protocol = 'postgres' as const;
  private cbuf: Buffer = Buffer.alloc(0);
  private sbuf: Buffer = Buffer.alloc(0);
  private started = false;
  /** The backend has sent its first ReadyForQuery. */
  private ready = false;
  /** Raw passthrough (a cancel connection, or framing lost). */
  private raw = false;
  private state: TxnState = 'idle';
  private readonly stmts = new Map<string, StatementClass[]>();
  private readonly portals = new Map<string, string>();
  private readonly prepared: Prepared = new Map();
  private group: { bytes: Buffer[]; msgs: Msg[]; classes: StatementClass[]; unknown: string[] } | null = null;
  private readonly inflight: Inflight[] = [];
  /** After an error in a flush unit the backend skips to the next Sync. */
  private skipping = false;
  /** Emulation after an injected error: the client was told the transaction failed, the backend was not. */
  private emulFailed = false;
  /** Emulation after an injected error in a flush unit: answer flush units with nothing until the next Sync. */
  private emulSkip = false;

  constructor(private readonly key: string) {}

  txn(_key?: string): TxnState {
    return this.emulFailed ? 'failed' : this.state;
  }

  client(chunk: Buffer): ClientUnit[] {
    this.cbuf = this.cbuf.length ? Buffer.concat([this.cbuf, chunk]) : chunk;
    const out: ClientUnit[] = [];
    if (this.raw) {
      const b = this.cbuf;
      this.cbuf = Buffer.alloc(0);
      return b.length ? [{ bytes: b, req: null }] : [];
    }
    for (;;) {
      if (!this.started) {
        if (this.cbuf.length < 8) break;
        const len = this.cbuf.readInt32BE(0);
        if (len < 8 || len > 10_000) throw new WireDesync(`postgres: startup packet length ${len}`);
        if (this.cbuf.length < len) break;
        const bytes = this.cbuf.subarray(0, len);
        this.cbuf = this.cbuf.subarray(len);
        const code = bytes.readInt32BE(4);
        if (code === SSL_REQUEST || code === GSSENC_REQUEST) {
          // why: the gate speaks plaintext to the client; libpq (sslmode=prefer) and node-postgres go on without TLS.
          out.push({ bytes, req: null, localReply: Buffer.from('N', 'latin1') });
          continue;
        }
        this.started = true;
        out.push({ bytes, req: null });
        if (code === CANCEL_REQUEST) {
          this.raw = true;
          if (this.cbuf.length) out.push({ bytes: this.cbuf, req: null }), (this.cbuf = Buffer.alloc(0));
          break;
        }
        continue;
      }
      if (this.cbuf.length < 5) break;
      const t = String.fromCharCode(this.cbuf[0]!);
      const len = this.cbuf.readInt32BE(1);
      if (len < 4 || len > MAX_MESSAGE) throw new WireDesync(`postgres: message ${t} length ${len}`);
      if (this.cbuf.length < len + 1) break;
      const bytes = this.cbuf.subarray(0, len + 1);
      this.cbuf = this.cbuf.subarray(len + 1);
      const body = bytes.subarray(5);
      out.push(...this.clientMessage(t, body, bytes));
    }
    return out;
  }

  private clientMessage(t: string, body: Buffer, bytes: Buffer): ClientUnit[] {
    const out: ClientUnit[] = [];
    const g = () => (this.group ??= { bytes: [], msgs: [], classes: [], unknown: [] });
    switch (t) {
      case 'Q': {
        const [sql] = readCstr(body, 0);
        const classes = classifySql(sql, this.prepared);
        const pre = this.takeGroup('flush');
        if (pre) out.push(pre);
        out.push(this.unit({ kind: 'query', msgs: [{ t }], verbs: classes.map((c) => c.verb) }, [bytes], combine(classes)));
        return out;
      }
      case 'F': {
        const pre = this.takeGroup('flush');
        if (pre) out.push(pre);
        out.push(this.unit({ kind: 'call', msgs: [{ t }], verbs: ['FUNCTION CALL'] }, [bytes], { verb: 'FUNCTION CALL', path: `oid ${body.length >= 4 ? body.readInt32BE(0) : '?'}`, mutating: true, uncertain: 'a fastpath function call whose body is not inspected', statement: 'FunctionCall' }));
        return out;
      }
      case 'P': {
        const [name, at] = readCstr(body, 0);
        const [sql] = readCstr(body, at);
        this.stmts.set(name, classifySql(sql, this.prepared));
        g().bytes.push(bytes);
        g().msgs.push({ t });
        return out;
      }
      case 'B': {
        const [portal, at] = readCstr(body, 0);
        const [stmt] = readCstr(body, at);
        this.portals.set(portal, stmt);
        g().bytes.push(bytes);
        g().msgs.push({ t });
        return out;
      }
      case 'E': {
        const [portal] = readCstr(body, 0);
        const stmt = this.portals.get(portal);
        const cs = stmt === undefined ? undefined : this.stmts.get(stmt);
        if (cs) g().classes.push(...cs);
        else g().unknown.push(portal ? `portal ${portal}` : 'the unnamed portal');
        g().bytes.push(bytes);
        g().msgs.push({ t });
        return out;
      }
      case 'D':
      case 'C': {
        const sub = String.fromCharCode(body[0] ?? 0x53);
        if (t === 'C') {
          const [name] = readCstr(body, 1);
          if (sub === 'S') this.stmts.delete(name);
          else this.portals.delete(name);
        }
        g().bytes.push(bytes);
        g().msgs.push({ t, sub });
        return out;
      }
      case 'S':
      case 'H': {
        if (!this.group) return t === 'S' ? [this.unit({ kind: 'sync', msgs: [{ t }], verbs: [] }, [bytes], { verb: 'SYNC', path: '', mutating: false, statement: 'Sync' })] : [{ bytes, req: null }];
        this.group.bytes.push(bytes);
        this.group.msgs.push({ t });
        return [this.takeGroup(t === 'S' ? 'sync' : 'flush')!];
      }
      default: {
        // Authentication (p), COPY data (d, c, f), Terminate (X): passthrough, after any open group.
        const pre = this.takeGroup('flush');
        if (pre) out.push(pre);
        out.push({ bytes, req: null });
        return out;
      }
    }
  }

  private takeGroup(kind: 'sync' | 'flush'): ClientUnit | null {
    const g = this.group;
    if (!g) return null;
    this.group = null;
    const unknown = g.unknown.map((p) => ({ verb: 'EXECUTE', path: '', mutating: true, uncertain: `executes ${p}, whose statement was not seen`, statement: 'Execute' }) as StatementClass);
    const all = [...g.classes, ...unknown];
    const c: Classified = all.length ? combine(all) : { verb: 'PREPARE', path: '', mutating: false, statement: 'Parse/Bind/Describe without Execute' };
    return this.unit({ kind, msgs: g.msgs, verbs: all.map((x) => x.verb) }, g.bytes, c);
  }

  private unit(meta: Meta, bytes: Buffer[], req: Classified): ClientUnit {
    return { bytes: Buffer.concat(bytes), req, txnKey: this.key, meta };
  }

  sent(id: number, u: ClientUnit): void {
    const meta = u.meta as Meta | undefined;
    if (!meta) return;
    const left = meta.kind === 'flush' ? meta.msgs.filter((m) => 'PBCDE'.includes(m.t)).length : 0;
    const f: Inflight = { id, meta, left, error: null, tags: [], before: this.state };
    this.inflight.push(f);
  }

  server(chunk: Buffer): ServerPiece[] {
    this.sbuf = this.sbuf.length ? Buffer.concat([this.sbuf, chunk]) : chunk;
    const out: ServerPiece[] = [];
    if (this.raw) {
      const b = this.sbuf;
      this.sbuf = Buffer.alloc(0);
      return b.length ? [{ bytes: b, unit: null }] : [];
    }
    for (;;) {
      if (this.sbuf.length < 5) break;
      const t = String.fromCharCode(this.sbuf[0]!);
      const len = this.sbuf.readInt32BE(1);
      if (len < 4 || len > MAX_MESSAGE) throw new WireDesync(`postgres: backend message ${t} length ${len}`);
      if (this.sbuf.length < len + 1) break;
      const bytes = this.sbuf.subarray(0, len + 1);
      this.sbuf = this.sbuf.subarray(len + 1);
      this.serverMessage(t, bytes, out);
    }
    return out;
  }

  private serverMessage(t: string, bytes: Buffer, out: ServerPiece[]): void {
    const body = bytes.subarray(5);
    if (!this.ready) {
      if (t === 'Z') {
        this.ready = true;
        this.state = txnOf(body[0] ?? 0x49);
      }
      out.push({ bytes, unit: null });
      return;
    }
    if (t === 'N' || t === 'S' || t === 'A') {
      out.push({ bytes, unit: null });
      return;
    }
    if (t === 'Z')
      // why: flush units sent while the backend skips to the next Sync get no answer of their own; the Sync's ReadyForQuery ends them.
      while (this.inflight[0] && this.inflight[0].meta.kind === 'flush') {
        const s = this.inflight.shift()!;
        out.push({ bytes: Buffer.alloc(0), unit: s.id, end: { status: 400, reply: 'skipped by the backend after an earlier error', txn: this.state } });
      }
    const f = this.inflight[0];
    if (!f) {
      if (t === 'Z') this.state = txnOf(body[0] ?? 0x49);
      out.push({ bytes, unit: null });
      return;
    }
    const piece: ServerPiece = { bytes, unit: f.id };
    out.push(piece);
    if (t === 'E') f.error ??= errorCode(body);
    if (t === 'C') f.tags.push(readCstr(body, 0)[0]);
    if (f.meta.kind !== 'flush') {
      if (t === 'Z') {
        this.state = txnOf(body[0] ?? 0x49);
        this.skipping = false;
        this.inflight.shift();
        piece.end = this.outcome(f);
      }
      return;
    }
    // A flush unit: count the answers.
    if (t === 'E') {
      this.inflight.shift();
      piece.end = this.outcome(f);
      // why: the backend now discards everything up to the next Sync; the flush units already sent end with no answer.
      this.skipping = true;
      while (this.inflight[0] && this.inflight[0].meta.kind === 'flush') {
        const s = this.inflight.shift()!;
        out.push({ bytes: Buffer.alloc(0), unit: s.id, end: { status: 400, reply: 'skipped by the backend after an earlier error', txn: this.state } });
      }
      return;
    }
    // why: ParseComplete, BindComplete, CloseComplete; RowDescription or NoData for a Describe (its 't' is not counted);
    // CommandComplete, EmptyQueryResponse or PortalSuspended for an Execute.
    if ('123nTICs'.includes(t)) f.left--;
    if (f.left <= 0) {
      this.inflight.shift();
      piece.end = this.outcome(f);
    }
  }

  private outcome(f: Inflight): Outcome {
    const after = this.state;
    const ended = (f.before === 'in' || f.before === 'failed') && after === 'idle';
    const last = f.tags[f.tags.length - 1] ?? '';
    const committed = ended && f.before === 'in' && !/^ROLLBACK/.test(last) && !f.error;
    const reply = f.error ? `ErrorResponse ${f.error}` : f.tags.length ? `CommandComplete ${f.tags.map(tagClass).join(', ')}` : f.meta.kind === 'flush' ? 'answered (flush)' : 'ReadyForQuery';
    return { status: pgStatus(f.error), reply: cut(reply), txn: after, ...(ended ? { ended: true } : {}), ...(committed ? { committed: true } : {}) };
  }

  intercept(u: ClientUnit): Intercept | null {
    const meta = u.meta as Meta | undefined;
    if (!meta) return null;
    if (this.emulSkip) {
      if (meta.kind === 'flush') return { synth: Buffer.alloc(0), outcome: { status: 400, reply: 'skipped after an injected error (emulated)', txn: this.txn() } };
      this.emulSkip = false;
      if (meta.kind === 'sync') return { synth: pg.ready(this.txn()), outcome: { status: 400, reply: 'skipped after an injected error (emulated)', txn: this.txn() } };
    }
    if (!this.emulFailed) return null;
    const verbs = meta.verbs;
    if (verbs.length && verbs.every((v) => v === 'ROLLBACK' || v === 'ROLLBACK TO')) {
      // why: the backend rolls back (or back to the savepoint) for real; client and backend agree again.
      this.emulFailed = false;
      return null;
    }
    if (verbs.length === 1 && verbs[0] === 'COMMIT') {
      // why: a COMMIT of a failed transaction rolls it back and answers ROLLBACK; the backend's transaction is rolled back the same way.
      this.emulFailed = false;
      const answer: Buffer[] = [];
      if (meta.kind === 'query') answer.push(pg.complete('ROLLBACK'));
      else
        for (const m of meta.msgs) {
          if (m.t === 'P') answer.push(msg('1', Buffer.alloc(0)));
          else if (m.t === 'B') answer.push(msg('2', Buffer.alloc(0)));
          else if (m.t === 'C') answer.push(msg('3', Buffer.alloc(0)));
          else if (m.t === 'D') answer.push(...(m.sub === 'S' ? [msg('t', Buffer.from([0, 0])), msg('n', Buffer.alloc(0))] : [msg('n', Buffer.alloc(0))]));
          else if (m.t === 'E') answer.push(pg.complete('ROLLBACK'));
        }
      if (meta.kind !== 'flush') answer.push(pg.ready('idle'));
      const fwd: ClientUnit = { bytes: pg.query('ROLLBACK'), req: u.req, txnKey: this.key, meta: { kind: 'query', msgs: [{ t: 'Q' }], verbs: ['ROLLBACK'] } satisfies Meta };
      return { forward: fwd, answer: Buffer.concat(answer), outcome: { status: 200, reply: 'CommandComplete ROLLBACK (COMMIT of a transaction failed by an injected error; emulated)', txn: 'idle', ended: true } };
    }
    const e = pg.error('25P02', 'current transaction is aborted, commands ignored until end of transaction block');
    if (meta.kind === 'flush') this.emulSkip = true;
    return { synth: meta.kind === 'flush' ? e : Buffer.concat([e, pg.ready('failed')]), outcome: { status: 400, reply: 'ErrorResponse 25P02 (emulated after an injected error)', txn: 'failed' } };
  }

  injectError(u: ClientUnit, message: string, realTxn: TxnState): { bytes: Buffer; note?: string } {
    const meta = u.meta as Meta | undefined;
    const e = pg.error('XX000', message || INJECTED);
    const told: TxnState = realTxn === 'idle' ? 'idle' : 'failed';
    if (realTxn === 'in') this.emulFailed = true;
    if (meta?.kind === 'flush') {
      this.emulSkip = true;
      return { bytes: e };
    }
    return { bytes: Buffer.concat([e, pg.ready(told)]), ...(realTxn === 'in' ? { note: 'inside a transaction: the gate answers the rest of it as Postgres answers a failed transaction until ROLLBACK or COMMIT' } : {}) };
  }

  /** Testing aid: framing state. */
  debug(): { ready: boolean; state: TxnState; inflight: number; skipping: boolean; emulFailed: boolean } {
    return { ready: this.ready, state: this.state, inflight: this.inflight.length, skipping: this.skipping, emulFailed: this.emulFailed };
  }
}

/** The SQLSTATE of an ErrorResponse body (field C), never its message (which can carry values). */
function errorCode(body: Buffer): string {
  let i = 0;
  while (i < body.length && body[i] !== 0) {
    const f = String.fromCharCode(body[i]!);
    const z = body.indexOf(0, i + 1);
    if (z < 0) break;
    if (f === 'C') return body.toString('latin1', i + 1, z);
    i = z + 1;
  }
  return '?????';
}

/** A CommandComplete tag without the OID of INSERT: "INSERT 0 1" → "INSERT 1". */
function tagClass(tag: string): string {
  const m = /^INSERT \d+ (\d+)$/.exec(tag);
  return m ? `INSERT ${m[1]}` : tag;
}
