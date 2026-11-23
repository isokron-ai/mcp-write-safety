/**
 * A minimal in-process Postgres (protocol v3) for the wire gate's tests, and a minimal client.
 * The fake speaks just enough: startup with trust authentication, simple Query, extended
 * Parse/Bind/Describe/Execute/Close/Sync/Flush (with skip-to-Sync after an error), and
 * BEGIN/COMMIT/ROLLBACK over one key/value table `kv(k, v)`. Statements it understands:
 *   UPDATE kv SET v = '<v>' WHERE k = '<k>'      (or $1 / $2 parameters)
 *   INSERT INTO kv (k, v) VALUES ('<k>', '<v>')  (23505 when k exists)
 *   SELECT v FROM kv WHERE k = '<k>'
 *   DELETE FROM kv WHERE k = '<k>'               (outside a transaction only)
 *   SELECT k FROM kv WHERE k LIKE '<prefix>%'    (every key with the prefix, committed rows only)
 *   BEGIN | COMMIT | END | ROLLBACK | SELECT 1 | SAVEPOINT s | ROLLBACK TO s
 *   COPY kv FROM STDIN                            (CopyData lines "k\tv\n", then CopyDone)
 *   SELECT hang()                                 (never answered)
 * Everything else answers 42601. It is not Postgres: it exists to show the gate frames, names,
 * holds and fails the real protocol's messages, and keeps a log of what reached it.
 */

import { createServer, connect, type AddressInfo, type Server, type Socket } from 'node:net';

type State = 'I' | 'T' | 'E';

function msg(type: string, body: Buffer = Buffer.alloc(0)): Buffer {
  const h = Buffer.alloc(5);
  h.write(type, 0, 'latin1');
  h.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([h, body]);
}
const cstr = (s: string) => Buffer.from(`${s}\0`, 'utf8');
const int32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
};
const int16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeInt16BE(n);
  return b;
};
const errorMsg = (code: string, m: string) => msg('E', Buffer.concat([cstr('SERROR'), cstr('VERROR'), cstr(`C${code}`), cstr(`M${m}`), Buffer.from([0])]));
const rowDesc = () => msg('T', Buffer.concat([int16(1), cstr('v'), int32(0), int16(0), int32(25), int16(-1), int32(-1), int16(0)]));
const dataRow = (v: string) => {
  const b = Buffer.from(v, 'utf8');
  return msg('D', Buffer.concat([int16(1), int32(b.length), b]));
};

export interface FakePg {
  url: string;
  port: number;
  table: Map<string, string>;
  /** Every statement executed, in order (after parameters are put in). */
  seen: string[];
  /** Raw startup packets received. */
  startups: number;
  close(): Promise<void>;
}

export async function fakePostgres(initial: Record<string, string> = {}): Promise<FakePg> {
  const table = new Map(Object.entries(initial));
  const seen: string[] = [];
  const socks = new Set<Socket>();
  const st = { startups: 0 };
  const server: Server = createServer((s) => {
    socks.add(s);
    s.on('close', () => socks.delete(s));
    s.on('error', () => undefined);
    let buf = Buffer.alloc(0);
    let started = false;
    let state: State = 'I';
    let pending: [string, string][] = [];
    const stmts = new Map<string, string>();
    const portals = new Map<string, { sql: string; params: string[] }>();
    let skipping = false;
    let copying: number | null = null;
    let savepoint: number | null = null;

    const run = (sqlIn: string, params: string[] = []): Buffer[] => {
      const sql = sqlIn.replace(/\$(\d+)/g, (_, n) => `'${params[Number(n) - 1] ?? ''}'`).trim().replace(/;$/, '');
      seen.push(sql);
      const up = sql.toUpperCase();
      if (state === 'E' && !/^(ROLLBACK|COMMIT|END|ABORT)/.test(up)) return [errorMsg('25P02', 'current transaction is aborted, commands ignored until end of transaction block')];
      if (/^(BEGIN|START TRANSACTION)/.test(up)) {
        state = 'T';
        return [msg('C', cstr('BEGIN'))];
      }
      if (/^(COMMIT|END)/.test(up)) {
        const was = state;
        if (was === 'T') for (const [k, v] of pending) table.set(k, v);
        pending = [];
        state = 'I';
        return [msg('C', cstr(was === 'E' ? 'ROLLBACK' : 'COMMIT'))];
      }
      if (/^SAVEPOINT/.test(up)) {
        savepoint = pending.length;
        return [msg('C', cstr('SAVEPOINT'))];
      }
      if (/^ROLLBACK TO/.test(up)) {
        if (savepoint !== null) pending = pending.slice(0, savepoint);
        if (state === 'E') state = 'T';
        return [msg('C', cstr('ROLLBACK'))];
      }
      if (/^(ROLLBACK|ABORT)/.test(up)) {
        pending = [];
        state = 'I';
        return [msg('C', cstr('ROLLBACK'))];
      }
      if (up === 'SELECT 1') return [rowDesc(), dataRow('1'), msg('C', cstr('SELECT 1'))];
      let m = /^UPDATE kv SET v = '([^']*)' WHERE k = '([^']*)'$/i.exec(sql);
      if (m) {
        const has = table.has(m[2]!) || pending.some(([k]) => k === m![2]);
        if (has) {
          if (state === 'T') pending.push([m[2]!, m[1]!]);
          else table.set(m[2]!, m[1]!);
        }
        return [msg('C', cstr(`UPDATE ${has ? 1 : 0}`))];
      }
      m = /^INSERT INTO kv \(k, v\) VALUES \('([^']*)', '([^']*)'\)$/i.exec(sql);
      if (m) {
        if (table.has(m[1]!)) {
          if (state === 'T') state = 'E';
          return [errorMsg('23505', `duplicate key value violates unique constraint "kv_pkey"`)];
        }
        if (state === 'T') pending.push([m[1]!, m[2]!]);
        else table.set(m[1]!, m[2]!);
        return [msg('C', cstr('INSERT 0 1'))];
      }
      m = /^SELECT k FROM kv WHERE k LIKE '([^'%]*)%'$/i.exec(sql);
      if (m) {
        const keys = [...table.keys()].filter((k) => k.startsWith(m![1]!)).sort();
        return [rowDesc(), ...keys.map((k) => dataRow(k)), msg('C', cstr(`SELECT ${keys.length}`))];
      }
      m = /^DELETE FROM kv WHERE k = '([^']*)'$/i.exec(sql);
      if (m) {
        // A fixture: deletes are autocommit only (no tombstones in a transaction's pending writes).
        if (state !== 'I') {
          state = 'E';
          return [errorMsg('0A000', 'DELETE inside a transaction is not supported by the fake')];
        }
        const had = table.delete(m[1]!);
        return [msg('C', cstr(`DELETE ${had ? 1 : 0}`))];
      }
      m = /^SELECT v FROM kv WHERE k = '([^']*)'$/i.exec(sql);
      if (m) {
        const own = [...pending].reverse().find(([k]) => k === m![1]);
        const v = own ? own[1] : table.get(m[1]!);
        return v === undefined ? [rowDesc(), msg('C', cstr('SELECT 0'))] : [rowDesc(), dataRow(v), msg('C', cstr('SELECT 1'))];
      }
      if (state === 'T') state = 'E';
      return [errorMsg('42601', 'syntax error')];
    };
    const ready = () => msg('Z', Buffer.from(state, 'latin1'));
    const isErr = (b: Buffer[]) => b.some((x) => x[0] === 0x45);

    s.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const out: Buffer[] = [];
      for (;;) {
        if (!started) {
          if (buf.length < 8) break;
          const len = buf.readInt32BE(0);
          if (buf.length < len) break;
          const code = buf.readInt32BE(4);
          buf = buf.subarray(len);
          if (code === 80877103) {
            out.push(Buffer.from('N'));
            continue;
          }
          started = true;
          st.startups++;
          out.push(msg('R', int32(0)), msg('S', Buffer.concat([cstr('server_version'), cstr('16.0-fake')])), msg('K', Buffer.concat([int32(42), int32(7)])), ready());
          continue;
        }
        if (buf.length < 5) break;
        const t = String.fromCharCode(buf[0]!);
        const len = buf.readInt32BE(1);
        if (buf.length < len + 1) break;
        const body = buf.subarray(5, len + 1);
        buf = buf.subarray(len + 1);
        const cs = (at: number): [string, number] => {
          const z = body.indexOf(0, at);
          return [body.toString('utf8', at, z), z + 1];
        };
        if (t === 'X') {
          s.end();
          return;
        }
        if (copying !== null) {
          if (t === 'd') {
            for (const line of body.toString('utf8').split('\n').filter(Boolean)) {
              const [k, v] = line.split('\t');
              table.set(k!, v!);
              copying++;
            }
          } else if (t === 'c') {
            seen.push(`COPY DONE ${copying}`);
            out.push(msg('C', cstr(`COPY ${copying}`)), ready());
            copying = null;
          }
          continue;
        }
        if (t === 'Q') {
          const [sql] = cs(0);
          if (/^COPY kv FROM STDIN$/i.test(sql.trim())) {
            seen.push(sql.trim());
            copying = 0;
            out.push(msg('G', Buffer.concat([Buffer.from([0]), int16(2), int16(0), int16(0)])));
            continue;
          }
          if (sql.trim() === 'SELECT hang()') {
            seen.push('SELECT hang()');
            continue;
          }
          for (const one of sql.split(';').filter((x) => x.trim())) {
            const r = run(one);
            out.push(...r);
            if (isErr(r)) break;
          }
          if (state === 'T' && out.some((x) => x[0] === 0x45)) state = 'E';
          out.push(ready());
          continue;
        }
        if (t === 'S') {
          skipping = false;
          out.push(ready());
          continue;
        }
        if (skipping) continue;
        if (t === 'H') continue;
        if (t === 'P') {
          const [name, at] = cs(0);
          const [sql] = cs(at);
          stmts.set(name, sql);
          out.push(msg('1'));
        } else if (t === 'B') {
          const [portal, a1] = cs(0);
          const [stmt, a2] = cs(a1);
          let i = a2;
          const nf = body.readInt16BE(i);
          i += 2 + nf * 2;
          const np = body.readInt16BE(i);
          i += 2;
          const params: string[] = [];
          for (let k = 0; k < np; k++) {
            const l = body.readInt32BE(i);
            i += 4;
            params.push(l < 0 ? '' : body.toString('utf8', i, i + l));
            i += Math.max(0, l);
          }
          portals.set(portal, { sql: stmts.get(stmt) ?? '', params });
          out.push(msg('2'));
        } else if (t === 'D') {
          out.push(...(body[0] === 0x53 ? [msg('t', int16(0)), msg('n')] : [msg('n')]));
        } else if (t === 'E') {
          const [portal] = cs(0);
          const p = portals.get(portal);
          const r = run(p?.sql ?? '', p?.params ?? []).filter((x) => x[0] !== 0x54);
          out.push(...r);
          if (isErr(r)) {
            skipping = true;
            if (state === 'T') state = 'E';
          }
        } else if (t === 'C') {
          out.push(msg('3'));
        }
      }
      if (out.length) s.write(Buffer.concat(out));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `postgres://mws:secret@127.0.0.1:${port}/mwsc`,
    port,
    table,
    seen,
    get startups() {
      return st.startups;
    },
    close: async () => {
      for (const s of socks) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

export interface PgMsg {
  t: string;
  body: Buffer;
}

export interface Answer {
  tags: string[];
  rows: string[];
  error: string | null;
  state: string | null;
  types: string;
}

/** A minimal client: startup (optionally SSLRequest first), then simple and extended queries. */
export class PgClient {
  private buf = Buffer.alloc(0);
  private waiters: (() => void)[] = [];
  readonly msgs: PgMsg[] = [];
  closed = false;
  sslAnswer: string | null = null;
  private constructor(readonly sock: Socket) {
    sock.on('data', (b: Buffer) => {
      this.buf = Buffer.concat([this.buf, b]);
      this.parse();
    });
    sock.on('close', () => {
      this.closed = true;
      this.wake();
    });
    sock.on('error', () => undefined);
  }

  static async connect(port: number, o: { ssl?: boolean; chunked?: boolean } = {}): Promise<PgClient> {
    const sock = connect({ host: '127.0.0.1', port });
    await new Promise<void>((r, j) => (sock.once('connect', () => r()), sock.once('error', j)));
    const c = new PgClient(sock);
    if (o.ssl) {
      const ssl = Buffer.concat([int32(8), int32(80877103)]);
      sock.write(ssl);
      await c.until(() => c.buf.length >= 1);
      c.sslAnswer = c.buf.toString('latin1', 0, 1);
      c.buf = c.buf.subarray(1);
    }
    const params = Buffer.concat([cstr('user'), cstr('mws'), cstr('database'), cstr('mwsc'), Buffer.from([0])]);
    const startup = Buffer.concat([int32(params.length + 8), int32(196608), params]);
    await c.write(startup, o.chunked);
    await c.untilReady();
    return c;
  }

  private sslPhase = false;
  private parse(): void {
    if (this.sslPhase) return;
    for (;;) {
      if (this.buf.length < 5) break;
      const len = this.buf.readInt32BE(1);
      if (this.buf.length < len + 1) break;
      this.msgs.push({ t: String.fromCharCode(this.buf[0]!), body: this.buf.subarray(5, len + 1) });
      this.buf = this.buf.subarray(len + 1);
    }
    this.wake();
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
  private async untilReady(): Promise<void> {
    await this.until(() => this.msgs.some((m) => m.t === 'Z'));
    this.msgs.length = 0;
  }

  async write(b: Buffer, chunked = false): Promise<void> {
    if (!chunked) {
      this.sock.write(b);
      return;
    }
    for (let i = 0; i < b.length; i++) {
      this.sock.write(b.subarray(i, i + 1));
      await new Promise((r) => setImmediate(r));
    }
  }

  static q(sql: string): Buffer {
    return msg('Q', cstr(sql));
  }
  static ext(sql: string, params: string[], o: { name?: string; end?: 'S' | 'H' } = {}): Buffer {
    const name = o.name ?? '';
    const bind = Buffer.concat([cstr(''), cstr(name), int16(0), int16(params.length), ...params.flatMap((p) => [int32(Buffer.byteLength(p)), Buffer.from(p)]), int16(0)]);
    return Buffer.concat([msg('P', Buffer.concat([cstr(name), cstr(sql), int16(0)])), msg('B', bind), msg('D', Buffer.concat([Buffer.from('P'), cstr('')])), msg('E', Buffer.concat([cstr(''), int32(0)])), msg(o.end ?? 'S')]);
  }

  /** Send bytes and collect the answer up to the n-th ReadyForQuery (null state: the connection closed or timed out first). */
  async send(b: Buffer, o: { readies?: number; ms?: number; chunked?: boolean } = {}): Promise<Answer> {
    const start = this.msgs.length;
    await this.write(b, o.chunked);
    const n = o.readies ?? 1;
    await this.until(() => this.msgs.slice(start).filter((m) => m.t === 'Z').length >= n, o.ms ?? 3000);
    return this.answer(start);
  }

  answer(start = 0): Answer {
    const ms = this.msgs.slice(start);
    const z = [...ms].reverse().find((m) => m.t === 'Z');
    const e = ms.find((m) => m.t === 'E');
    let code: string | null = null;
    if (e) {
      const parts = e.body.toString('utf8').split('\0');
      code = parts.find((p) => p.startsWith('C'))?.slice(1) ?? '?';
    }
    return {
      tags: ms.filter((m) => m.t === 'C').map((m) => m.body.toString('utf8', 0, m.body.length - 1)),
      rows: ms.filter((m) => m.t === 'D').map((m) => m.body.toString('utf8', 6)),
      error: code,
      state: z ? z.body.toString('latin1') : null,
      types: ms.map((m) => m.t).join(''),
    };
  }

  query(sql: string, ms?: number): Promise<Answer> {
    return this.send(PgClient.q(sql), ms ? { ms } : {});
  }

  close(): void {
    this.sock.destroy();
  }
}
