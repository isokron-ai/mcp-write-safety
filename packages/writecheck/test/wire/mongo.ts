/**
 * A minimal in-process MongoDB (OP_MSG) for the wire gate's tests, and a minimal client. The fake
 * keeps one collection map per namespace and understands hello/isMaster (also by legacy OP_QUERY,
 * and streaming with exhaustAllowed), ping, find by _id, insert (11000 on a duplicate _id), update
 * with $set by _id, delete by _id, aggregate (logs a $merge), and multi-statement transactions by
 * lsid (autocommit: false; commitTransaction / abortTransaction). Anything else: ok 0, code 59.
 * It reuses the gate's BSON writer; the BSON reader is checked separately against spec vectors.
 */

import { createServer, connect, type AddressInfo, type Server, type Socket } from 'node:net';

import { decode, encode, type Bson } from '../../src/gate/wire/bson.js';
import { msgBody, OP, opMsg } from '../../src/gate/wire/mongodb.js';

type Doc = Record<string, Bson>;

export interface FakeMongo {
  url: string;
  port: number;
  coll: (ns: string) => Map<string, Doc>;
  seen: string[];
  close(): Promise<void>;
}

export async function fakeMongo(): Promise<FakeMongo> {
  const colls = new Map<string, Map<string, Doc>>();
  const coll = (ns: string) => colls.get(ns) ?? (colls.set(ns, new Map()), colls.get(ns)!);
  const seen: string[] = [];
  const txns = new Map<string, (() => void)[]>();
  const socks = new Set<Socket>();
  let ids = 1000;
  const server: Server = createServer((s) => {
    socks.add(s);
    s.on('close', () => socks.delete(s));
    s.on('error', () => undefined);
    let buf = Buffer.alloc(0);
    const run = (b: Doc, cmd: string): Doc => {
      const db = String(b['$db'] ?? 'test');
      const ns = `${db}.${String(b[cmd] ?? '')}`;
      const lsid = (b['lsid'] as Doc | undefined)?.['id'] as { hex?: string } | undefined;
      const inTxn = b['autocommit'] === false && lsid?.hex;
      const later = (f: () => void) => (inTxn ? (txns.get(lsid!.hex!) ?? (txns.set(lsid!.hex!, []), txns.get(lsid!.hex!)!)).push(f) : f());
      seen.push(`${cmd} ${ns}`);
      switch (cmd) {
        case 'hello':
        case 'isMaster':
        case 'ismaster':
          return { isWritablePrimary: true, ismaster: true, maxWireVersion: 21, minWireVersion: 0, ok: 1 };
        case 'ping':
          return { ok: 1 };
        case 'find': {
          const id = String(((b['filter'] as Doc) ?? {})['_id']);
          const d = coll(ns).get(id);
          return { cursor: { firstBatch: d ? [d] : [], id: 0, ns }, ok: 1 };
        }
        case 'insert': {
          const docs = (b['documents'] as Doc[]) ?? [];
          for (const [i, d] of docs.entries()) if (coll(ns).has(String(d['_id']))) return { n: i, writeErrors: [{ index: i, code: 11000, errmsg: 'E11000 duplicate key' }], ok: 1 };
          later(() => docs.forEach((d) => coll(ns).set(String(d['_id']), d)));
          return { n: docs.length, ok: 1 };
        }
        case 'update': {
          let n = 0;
          for (const u of (b['updates'] as Doc[]) ?? []) {
            const id = String(((u['q'] as Doc) ?? {})['_id']);
            const cur = coll(ns).get(id);
            if (!cur) continue;
            n++;
            later(() => coll(ns).set(id, { ...coll(ns).get(id)!, ...(((u['u'] as Doc) ?? {})['$set'] as Doc) }));
          }
          return { n, nModified: n, ok: 1 };
        }
        case 'delete': {
          let n = 0;
          for (const d of (b['deletes'] as Doc[]) ?? []) {
            const id = String(((d['q'] as Doc) ?? {})['_id']);
            if (coll(ns).has(id)) (n++, later(() => coll(ns).delete(id)));
          }
          return { n, ok: 1 };
        }
        case 'aggregate':
          return { cursor: { firstBatch: [], id: 0, ns }, ok: 1 };
        case 'commitTransaction': {
          const fs = txns.get(lsid?.hex ?? '') ?? [];
          txns.delete(lsid?.hex ?? '');
          fs.forEach((f) => f());
          return { ok: 1 };
        }
        case 'abortTransaction':
          txns.delete(lsid?.hex ?? '');
          return { ok: 1 };
        default:
          return { ok: 0, errmsg: `no such command: '${cmd}'`, code: 59, codeName: 'CommandNotFound' };
      }
    };
    s.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 16 && buf.length >= buf.readInt32LE(0)) {
        const len = buf.readInt32LE(0);
        const m = buf.subarray(0, len);
        buf = buf.subarray(len);
        const reqId = m.readInt32LE(4);
        const op = m.readInt32LE(12);
        if (op === OP.QUERY) {
          const z = m.indexOf(0, 20);
          const [q] = decode(m, z + 1 + 8);
          const doc = encode(run({ ...q, $db: 'admin' }, Object.keys(q)[0]!));
          const head = Buffer.alloc(36);
          head.writeInt32LE(36 + doc.length, 0);
          head.writeInt32LE(++ids, 4);
          head.writeInt32LE(reqId, 8);
          head.writeInt32LE(OP.REPLY, 12);
          head.writeInt32LE(1, 32);
          s.write(Buffer.concat([head, doc]));
          continue;
        }
        const { flags, body, first } = msgBody(m);
        const reply = run(body, first);
        if (flags & 2) continue; // moreToCome: no answer
        if (flags & (1 << 16) && first === 'hello') {
          // Streaming hello: a reply with moreToCome, then one that answers it, not the request.
          const r1 = ++ids;
          s.write(opMsg(r1, reqId, reply, 2));
          setTimeout(() => s.write(opMsg(++ids, r1, reply, 0)), 10);
          continue;
        }
        s.write(opMsg(++ids, reqId, reply));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `mongodb://mws:pw@127.0.0.1:${port}/mwsc?authSource=admin`,
    port,
    coll,
    seen,
    close: async () => {
      for (const s of socks) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

export class MongoClient {
  private buf = Buffer.alloc(0);
  readonly replies: { responseTo: number; requestId: number; flags: number; body: Doc }[] = [];
  closed = false;
  private waiters: (() => void)[] = [];
  private next = 1;
  private constructor(readonly sock: Socket) {
    sock.on('data', (b: Buffer) => {
      this.buf = Buffer.concat([this.buf, b]);
      while (this.buf.length >= 16 && this.buf.length >= this.buf.readInt32LE(0)) {
        const len = this.buf.readInt32LE(0);
        const m = this.buf.subarray(0, len);
        this.buf = this.buf.subarray(len);
        const op = m.readInt32LE(12);
        const body = op === OP.REPLY ? decode(m, 36)[0] : msgBody(m).body;
        this.replies.push({ responseTo: m.readInt32LE(8), requestId: m.readInt32LE(4), flags: op === OP.MSG ? m.readUInt32LE(16) : 0, body });
      }
      this.wake();
    });
    sock.on('close', () => ((this.closed = true), this.wake()));
    sock.on('error', () => undefined);
  }
  static async connect(port: number): Promise<MongoClient> {
    const sock = connect({ host: '127.0.0.1', port });
    await new Promise<void>((r, j) => (sock.once('connect', () => r()), sock.once('error', j)));
    return new MongoClient(sock);
  }
  private wake(): void {
    for (const w of this.waiters.splice(0)) w();
  }
  until(pred: () => boolean, ms = 3000): Promise<boolean> {
    return new Promise((r) => {
      const check = () => {
        if (pred()) return r(true);
        if (this.closed) return r(false);
        this.waiters.push(check);
      };
      setTimeout(() => r(pred()), ms);
      check();
    });
  }
  /** Send a command; resolve with the reply body, or null if the connection closed or the time ran out. */
  async cmd(body: Doc, o: { flags?: number; ms?: number; raw?: (id: number) => Buffer } = {}): Promise<Doc | null> {
    const id = this.next++;
    this.sock.write(o.raw ? o.raw(id) : opMsg(id, 0, body, o.flags ?? 0));
    const ok = await this.until(() => this.replies.some((r) => r.responseTo === id), o.ms ?? 3000);
    return ok ? this.replies.find((r) => r.responseTo === id)!.body : null;
  }
  /** A legacy OP_QUERY to admin.$cmd (the driver handshake form). */
  static opQuery(id: number, q: Doc): Buffer {
    const ns = Buffer.from('admin.$cmd\0');
    const doc = encode(q);
    const head = Buffer.alloc(20);
    const tail = Buffer.alloc(8);
    tail.writeInt32LE(-1, 4);
    head.writeInt32LE(20 + ns.length + 8 + doc.length, 0);
    head.writeInt32LE(id, 4);
    head.writeInt32LE(OP.QUERY, 12);
    return Buffer.concat([head, ns, tail, doc]);
  }
  close(): void {
    this.sock.destroy();
  }
}

export const lsid = (hex: string) => ({ id: { _bson: 'binary' as const, sub: 4, hex } });
