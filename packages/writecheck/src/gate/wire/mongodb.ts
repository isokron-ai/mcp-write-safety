/**
 * MongoDB OP_MSG for the wire gate (docs/WIRE-GATE.md §3, §4.3, §5).
 *
 * Client side: one unit per message (OP_MSG; the legacy OP_QUERY a driver sends for its first
 * hello; OP_COMPRESSED, counted as a write it cannot read). The command is the first key of the
 * body (kind-0 section); the target is `<$db>.<collection>`. A request with moreToCome expects no
 * answer.
 *
 * Server side: a reply is matched to its unit by responseTo; a reply that matches none (exhaust
 * continuations of a streaming hello) belongs to no unit.
 *
 * Transactions are per session (lsid), not per connection: a driver may send the statements of one
 * transaction over different pooled connections. The state is shared by every session of one gate.
 * commitTransaction is the commit point.
 */

import { cut, INJECTED, WireDesync, type Classified, type ClientUnit, type CodecSession, type Intercept, type Outcome, type ServerPiece, type TxnState } from './codec.js';
import { decode, encode, firstKey, isTagged, type Bson } from './bson.js';

export const OP = { REPLY: 1, UPDATE: 2001, INSERT: 2002, QUERY: 2004, GET_MORE: 2005, DELETE: 2006, KILL_CURSORS: 2007, COMPRESSED: 2012, MSG: 2013 } as const;
const MAX_MESSAGE = 48 * 1000 * 1000;
const MORE_TO_COME = 1 << 1;
const CHECKSUM = 1 << 0;

const set = (s: string) => new Set(s.trim().split(/\s+/).map((x) => x.toLowerCase()));
/** Commands that write, by name (lower case). */
export const MONGO_WRITES = set(`
insert update delete findAndModify bulkWrite create drop dropDatabase createIndexes dropIndexes renameCollection collMod
applyOps cloneCollectionAsCapped convertToCapped compact createUser updateUser dropUser dropAllUsersFromDatabase createRole updateRole dropRole
grantRolesToUser revokeRolesFromUser grantPrivilegesToRole revokePrivilegesFromRole createView clearJumboFlag
`);
/** Commands that only read, by name (lower case). */
export const MONGO_READS = set(`
find getMore count distinct listCollections listIndexes listDatabases hello isMaster ping buildInfo saslStart saslContinue authenticate
endSessions killCursors explain dbStats collStats dataSize serverStatus getParameter connectionStatus hostInfo listCommands whatsmyuri
getLog getCmdLineOpts getLastError getnonce logout features usersInfo rolesInfo validate currentOp top replSetGetStatus isdbgrid
`);
const TXN_CONTROL = set('commitTransaction abortTransaction startSession refreshSessions');
/** Error codes after which the outcome is not known or the server is not taking writes. */
const UNAVAILABLE = new Set([6, 7, 89, 91, 189, 262, 9001, 10107, 11600, 11602, 13435, 13436]);

export interface TxnShared {
  /** lsid → the backend's transaction state for that session. */
  state: Map<string, TxnState>;
  /** The gate's own request ids, counted down from the top of the range so they never meet a driver's. */
  nextId: number;
}

export function sharedMongo(): TxnShared {
  return { state: new Map(), nextId: 0x7fff0000 };
}

const lower = (s: string) => s.toLowerCase();

/** Classify a command body. */
export function classifyMongo(body: Record<string, Bson>, cmd: string): Classified {
  const db = typeof body['$db'] === 'string' ? body['$db'] : '';
  const v = body[cmd];
  const coll = typeof v === 'string' ? v : cmd === 'getMore' && typeof body['collection'] === 'string' ? body['collection'] : '';
  const path = coll ? `${db}.${coll}` : db;
  const k = lower(cmd);
  const statement = cut(`${cmd} ${path}`.trim());
  if (k === 'aggregate') {
    const stages = Array.isArray(body['pipeline']) ? (body['pipeline'] as Bson[]).map((s) => (s && typeof s === 'object' && !Array.isArray(s) && !isTagged(s) ? (Object.keys(s)[0] ?? '?') : '?')) : [];
    const writes = stages.some((s) => s === '$out' || s === '$merge');
    return { verb: cmd, path, mutating: writes, statement: cut(`${statement} [${stages.join(',')}]`) };
  }
  if (k === 'mapreduce') {
    const out = body['out'];
    const inline = !!out && typeof out === 'object' && !Array.isArray(out) && 'inline' in (out as object);
    return { verb: cmd, path, mutating: !inline, statement };
  }
  if (MONGO_WRITES.has(k)) return { verb: cmd, path, mutating: true, statement };
  if (MONGO_READS.has(k)) return { verb: cmd, path, mutating: false, statement };
  if (TXN_CONTROL.has(k)) return { verb: cmd, path: db, mutating: false, statement: cmd };
  return { verb: cmd || '?', path, mutating: true, uncertain: `unknown command ${cmd || '(empty body)'}`, statement };
}

interface Meta {
  requestId: number;
  cmd: string;
  txnKey: string;
  /** Part of a multi-statement transaction (autocommit: false). */
  inTxn: boolean;
}

function header(len: number, requestId: number, responseTo: number, op: number): Buffer {
  const h = Buffer.alloc(16);
  h.writeInt32LE(len, 0);
  h.writeInt32LE(requestId, 4);
  h.writeInt32LE(responseTo, 8);
  h.writeInt32LE(op, 12);
  return h;
}

/** An OP_MSG with one body section. */
export function opMsg(requestId: number, responseTo: number, body: Record<string, Bson>, flags = 0): Buffer {
  const doc = encode(body);
  const f = Buffer.alloc(4);
  f.writeUInt32LE(flags);
  const payload = Buffer.concat([f, Buffer.from([0]), doc]);
  return Buffer.concat([header(16 + payload.length, requestId, responseTo, OP.MSG), payload]);
}

/** The body (kind-0 section) of an OP_MSG, and its flags. Kind-1 sections are skipped. */
export function msgBody(m: Buffer): { flags: number; body: Record<string, Bson>; first: string } {
  if (m.length < 21) throw new WireDesync('mongodb: OP_MSG too short');
  const flags = m.readUInt32LE(16);
  const end = m.length - (flags & CHECKSUM ? 4 : 0);
  let p = 20;
  let body: Record<string, Bson> | null = null;
  let first = '';
  while (p < end) {
    const kind = m[p]!;
    p++;
    if (kind === 0) {
      first = firstKey(m, p);
      const [d, e] = decode(m, p);
      body = d;
      p = e;
    } else if (kind === 1) {
      if (p + 4 > end) throw new WireDesync('mongodb: section runs past the message');
      const size = m.readInt32LE(p);
      if (size < 4 || p + size > end) throw new WireDesync('mongodb: bad document sequence size');
      p += size;
    } else throw new WireDesync(`mongodb: unknown section kind ${kind}`);
  }
  if (!body) throw new WireDesync('mongodb: OP_MSG without a body section');
  return { flags, body, first };
}

function lsidKey(body: Record<string, Bson>): string | null {
  const l = body['lsid'];
  if (!l || typeof l !== 'object' || Array.isArray(l) || isTagged(l)) return null;
  const id = (l as Record<string, Bson>)['id'];
  return isTagged(id) && id.hex ? `lsid:${id.hex}` : null;
}

export class MongoSession implements CodecSession {
  readonly protocol = 'mongodb' as const;
  private cbuf: Buffer = Buffer.alloc(0);
  private sbuf: Buffer = Buffer.alloc(0);
  /** requestID of a forwarded unit → its id and meta. */
  private readonly inflight = new Map<number, { id: number; meta: Meta }>();

  constructor(
    private readonly key: string,
    private readonly shared: TxnShared = sharedMongo(),
  ) {}

  txn(key: string | undefined): TxnState {
    return this.shared.state.get(key ?? this.key) ?? 'idle';
  }

  private frames(which: 'c' | 's'): Buffer[] {
    const out: Buffer[] = [];
    for (;;) {
      const b = which === 'c' ? this.cbuf : this.sbuf;
      if (b.length < 16) break;
      const len = b.readInt32LE(0);
      if (len < 16 || len > MAX_MESSAGE) throw new WireDesync(`mongodb: message length ${len}`);
      if (b.length < len) break;
      out.push(b.subarray(0, len));
      if (which === 'c') this.cbuf = b.subarray(len);
      else this.sbuf = b.subarray(len);
    }
    return out;
  }

  client(chunk: Buffer): ClientUnit[] {
    this.cbuf = this.cbuf.length ? Buffer.concat([this.cbuf, chunk]) : chunk;
    return this.frames('c').map((m) => this.unit(m));
  }

  private unit(m: Buffer): ClientUnit {
    const requestId = m.readInt32LE(4);
    const op = m.readInt32LE(12);
    const meta = (cmd: string, txnKey = this.key, inTxn = false): Meta => ({ requestId, cmd, txnKey, inTxn });
    if (op === OP.MSG) {
      const { flags, body, first } = msgBody(m);
      const txnKey = lsidKey(body) ?? this.key;
      const inTxn = body['autocommit'] === false;
      const req = classifyMongo(body, first);
      return { bytes: m, req, txnKey, meta: meta(first, txnKey, inTxn), ...(flags & MORE_TO_COME ? { noReply: true } : {}) };
    }
    if (op === OP.QUERY) {
      // flags, fullCollectionName, numberToSkip, numberToReturn, query
      const z = m.indexOf(0, 20);
      if (z < 0) throw new WireDesync('mongodb: OP_QUERY without a collection name');
      const ns = m.toString('utf8', 20, z);
      const qAt = z + 1 + 8;
      const first = firstKey(m, qAt);
      if (ns.endsWith('.$cmd')) {
        const [q] = decode(m, qAt);
        const db = ns.slice(0, -5);
        const req = classifyMongo({ ...q, $db: db }, first);
        return { bytes: m, req, txnKey: this.key, meta: meta(first) };
      }
      return { bytes: m, req: { verb: 'find', path: ns, mutating: false, statement: cut(`find ${ns} (OP_QUERY)`) }, txnKey: this.key, meta: meta('find') };
    }
    if (op === OP.COMPRESSED) return { bytes: m, req: { verb: 'OP_COMPRESSED', path: '', mutating: true, uncertain: 'a compressed message, not inspected (run the database without wire compression)', statement: 'OP_COMPRESSED' }, txnKey: this.key, meta: meta('OP_COMPRESSED') };
    if (op === OP.INSERT || op === OP.UPDATE || op === OP.DELETE) {
      const z = m.indexOf(0, 20);
      const ns = z > 20 ? m.toString('utf8', 20, z) : '';
      const verb = op === OP.INSERT ? 'OP_INSERT' : op === OP.UPDATE ? 'OP_UPDATE' : 'OP_DELETE';
      return { bytes: m, req: { verb, path: ns, mutating: true, statement: `${verb} ${ns}` }, txnKey: this.key, noReply: true, meta: meta(verb) };
    }
    if (op === OP.GET_MORE || op === OP.KILL_CURSORS) return { bytes: m, req: { verb: op === OP.GET_MORE ? 'OP_GET_MORE' : 'OP_KILL_CURSORS', path: '', mutating: false, statement: 'legacy cursor message' }, txnKey: this.key, meta: meta('cursor'), ...(op === OP.KILL_CURSORS ? { noReply: true } : {}) };
    return { bytes: m, req: { verb: `opcode ${op}`, path: '', mutating: true, uncertain: `unknown opcode ${op}`, statement: `opcode ${op}` }, txnKey: this.key, meta: meta(`opcode ${op}`) };
  }

  sent(id: number, u: ClientUnit): void {
    const meta = u.meta as Meta | undefined;
    if (!meta || u.noReply) return;
    this.inflight.set(meta.requestId, { id, meta });
  }

  server(chunk: Buffer): ServerPiece[] {
    this.sbuf = this.sbuf.length ? Buffer.concat([this.sbuf, chunk]) : chunk;
    return this.frames('s').map((m) => {
      const responseTo = m.readInt32LE(8);
      const f = this.inflight.get(responseTo);
      if (!f) return { bytes: m, unit: null };
      this.inflight.delete(responseTo);
      return { bytes: m, unit: f.id, end: this.outcome(f.meta, m) };
    });
  }

  private outcome(meta: Meta, m: Buffer): Outcome {
    let doc: Record<string, Bson> = {};
    const op = m.readInt32LE(12);
    try {
      if (op === OP.MSG) doc = msgBody(m).body;
      else if (op === OP.REPLY && m.length >= 36 + 5) doc = decode(m, 36)[0];
    } catch {
      /* a reply that cannot be read: its outcome is unknown */
    }
    const ok = doc['ok'] === 1 || doc['ok'] === true;
    const code = typeof doc['code'] === 'number' ? doc['code'] : null;
    const wErr = Array.isArray(doc['writeErrors']) && doc['writeErrors'].length ? (doc['writeErrors'][0] as Record<string, Bson>) : null;
    const wce = doc['writeConcernError'] ? (doc['writeConcernError'] as Record<string, Bson>) : null;
    const labels = Array.isArray(doc['errorLabels']) ? (doc['errorLabels'] as Bson[]) : [];
    const n = (k: string) => (typeof doc[k] === 'number' ? ` ${k}:${doc[k]}` : '');
    let status: number;
    let reply: string;
    if (!('ok' in doc)) {
      status = 503;
      reply = op === OP.MSG || op === OP.REPLY ? 'unreadable reply' : `opcode ${op}`;
    } else if (!ok) {
      status = code !== null && UNAVAILABLE.has(code) ? 503 : 400;
      reply = `ok:0 code:${code ?? '?'}${typeof doc['codeName'] === 'string' ? ` ${doc['codeName']}` : ''}`;
    } else if (wErr) {
      status = 400;
      reply = `ok:1 writeErrors ${typeof wErr['code'] === 'number' ? wErr['code'] : '?'}${n('n')}`;
    } else if (wce) {
      status = 202;
      reply = `ok:1 writeConcernError ${typeof wce['code'] === 'number' ? wce['code'] : '?'}${n('n')}`;
    } else {
      status = 200;
      reply = `ok:1${n('n')}${n('nModified')}`;
    }
    // Transaction state for the session.
    const k = lower(meta.cmd);
    const key = meta.txnKey;
    const before = this.txn(key);
    let after: TxnState = before;
    let ended = false;
    let committed = false;
    if (k === 'committransaction') {
      after = 'idle';
      ended = before !== 'idle' || ok;
      committed = ok && !wErr;
    } else if (k === 'aborttransaction') {
      after = 'idle';
      ended = true;
    } else if (meta.inTxn) {
      after = !ok && labels.includes('TransientTransactionError') ? 'idle' : 'in';
      ended = after === 'idle';
    }
    if (after === 'idle') this.shared.state.delete(key);
    else this.shared.state.set(key, after);
    return { status, reply: cut(reply), txn: after, ...(ended ? { ended } : {}), ...(committed ? { committed } : {}) };
  }

  intercept(): Intercept | null {
    return null;
  }

  injectError(u: ClientUnit, message: string, realTxn: TxnState): { bytes: Buffer; note?: string } {
    const meta = u.meta as Meta | undefined;
    if (!meta || u.noReply) return { bytes: Buffer.alloc(0), note: 'the request expects no answer (moreToCome): nothing was sent back' };
    const id = this.shared.nextId--;
    const bytes = opMsg(id, meta.requestId, { ok: 0, errmsg: message || INJECTED, code: 1, codeName: 'InternalError' });
    return { bytes, ...(realTxn === 'in' || meta.inTxn ? { note: 'inside a transaction: the backend transaction is not aborted by the gate (not emulated in this preview)' } : {}) };
  }
}
