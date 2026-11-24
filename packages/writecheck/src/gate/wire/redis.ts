/**
 * RESP2/RESP3 for the wire gate (docs/WIRE-GATE.md §3, §4.2, §5).
 *
 * Client side: one unit per command, a RESP array of bulk strings or an inline line. Server side:
 * one reply value per command (an attribute `|` belongs to the value after it; a RESP3 push `>` is
 * out of band). After SUBSCRIBE/PSUBSCRIBE/SSUBSCRIBE on RESP2, or MONITOR, replies are no longer
 * one per command and the connection is passed through unread.
 *
 * Transactions: MULTI … EXEC. A command queued inside MULTI is answered +QUEUED and applied at EXEC,
 * so EXEC is the commit point; an injected error while queuing makes the gate turn the EXEC into a
 * DISCARD and answer EXECABORT, as Redis does after a queuing error.
 */

import { cut, INJECTED, WireDesync, type Classified, type ClientUnit, type CodecSession, type Intercept, type Outcome, type ServerPiece, type TxnState } from './codec.js';

const MAX_BULK = 512 * 1024 * 1024;

const words = (s: string) => new Set(s.trim().split(/\s+/));

/** Commands that write (Redis command flag `write`), by name. */
export const REDIS_WRITES = words(`
SET SETNX SETEX PSETEX MSET MSETNX APPEND INCR INCRBY INCRBYFLOAT DECR DECRBY GETSET GETDEL GETEX SETRANGE LCS_STORE
DEL UNLINK EXPIRE EXPIREAT PEXPIRE PEXPIREAT PERSIST RENAME RENAMENX MOVE COPY RESTORE RESTORE-ASKING MIGRATE
HSET HSETNX HMSET HDEL HINCRBY HINCRBYFLOAT HEXPIRE HPEXPIRE HEXPIREAT HPEXPIREAT HPERSIST HGETDEL HGETEX HSETEX
LPUSH RPUSH LPUSHX RPUSHX LPOP RPOP LINSERT LSET LREM LTRIM RPOPLPUSH LMOVE BLPOP BRPOP BRPOPLPUSH BLMOVE LMPOP BLMPOP
SADD SREM SPOP SMOVE SINTERSTORE SUNIONSTORE SDIFFSTORE
ZADD ZINCRBY ZREM ZREMRANGEBYSCORE ZREMRANGEBYRANK ZREMRANGEBYLEX ZPOPMIN ZPOPMAX BZPOPMIN BZPOPMAX ZMPOP BZMPOP ZUNIONSTORE ZINTERSTORE ZDIFFSTORE ZRANGESTORE
PFADD PFMERGE PFDEBUG XADD XDEL XTRIM XGROUP XACK XCLAIM XAUTOCLAIM XSETID XREADGROUP XDELEX XACKDEL
GEOADD GEOSEARCHSTORE SETBIT BITOP BITFIELD FLUSHDB FLUSHALL SWAPDB
JSON.SET JSON.DEL JSON.FORGET JSON.ARRAPPEND JSON.ARRINSERT JSON.ARRPOP JSON.ARRTRIM JSON.CLEAR JSON.MERGE JSON.MSET JSON.NUMINCRBY JSON.NUMMULTBY JSON.STRAPPEND JSON.TOGGLE
`);
/** Commands that only read, by name. */
export const REDIS_READS = words(`
GET MGET EXISTS TYPE TTL PTTL EXPIRETIME PEXPIRETIME STRLEN GETRANGE SUBSTR LCS
HGET HMGET HGETALL HKEYS HVALS HLEN HEXISTS HSTRLEN HSCAN HRANDFIELD HTTL HPTTL HEXPIRETIME HPEXPIRETIME
LRANGE LLEN LINDEX LPOS SMEMBERS SISMEMBER SMISMEMBER SCARD SRANDMEMBER SINTER SUNION SDIFF SSCAN SINTERCARD
ZRANGE ZRANGEBYSCORE ZRANGEBYLEX ZREVRANGE ZREVRANGEBYSCORE ZREVRANGEBYLEX ZSCORE ZMSCORE ZRANK ZREVRANK ZCARD ZCOUNT ZLEXCOUNT ZSCAN ZRANDMEMBER ZINTER ZUNION ZDIFF ZINTERCARD
PFCOUNT XRANGE XREVRANGE XLEN XREAD XINFO XPENDING GEOPOS GEODIST GEOHASH GEOSEARCH GEORADIUS_RO GEORADIUSBYMEMBER_RO
GETBIT BITCOUNT BITPOS BITFIELD_RO SORT_RO KEYS SCAN RANDOMKEY DBSIZE DUMP TOUCH OBJECT MEMORY
EVAL_RO EVALSHA_RO FCALL_RO JSON.GET JSON.MGET JSON.TYPE JSON.STRLEN JSON.ARRLEN JSON.ARRINDEX JSON.OBJKEYS JSON.OBJLEN JSON.RESP JSON.DEBUG
`);
/** Connection, transaction and server commands that change no data. */
export const REDIS_CONTROL = words(`
PING ECHO AUTH HELLO SELECT CLIENT INFO TIME COMMAND LASTSAVE ROLE QUIT RESET READONLY READWRITE WAIT WAITAOF
MULTI EXEC DISCARD WATCH UNWATCH SUBSCRIBE UNSUBSCRIBE PSUBSCRIBE PUNSUBSCRIBE SSUBSCRIBE SUNSUBSCRIBE PUBLISH SPUBLISH PUBSUB MONITOR
SLOWLOG LATENCY ASKING
`);
/** Never record arguments of these (credentials). */
const SECRET_ARGS = new Set(['AUTH', 'HELLO', 'MIGRATE', 'CONFIG', 'ACL']);
const PASSTHROUGH_AFTER = new Set(['SUBSCRIBE', 'PSUBSCRIBE', 'SSUBSCRIBE', 'MONITOR']);
const UNAVAILABLE = /^(LOADING|BUSY|READONLY|MASTERDOWN|CLUSTERDOWN|TRYAGAIN|NOREPLICAS|NOTREADY)$/;

/** Classify a command (name and arguments as strings). */
export function classifyRedis(args: string[]): Classified {
  const cmd = (args[0] ?? '').toUpperCase();
  const sub = (args[1] ?? '').toUpperCase();
  const statement = (verb: string, key: string) => cut(key ? `${verb} ${key}` : verb);
  if (!cmd) return { verb: '', path: '', mutating: true, uncertain: 'an empty command', statement: '' };
  // Two-word admin commands read by subcommand.
  if (cmd === 'CONFIG') return sub === 'GET' ? { verb: 'CONFIG GET', path: '', mutating: false, statement: 'CONFIG GET' } : { verb: `CONFIG ${sub}`, path: '', mutating: true, uncertain: `CONFIG ${sub} changes server settings`, statement: `CONFIG ${sub}` };
  if (cmd === 'SCRIPT' || cmd === 'FUNCTION') {
    const ro = ['EXISTS', 'LIST', 'DUMP', 'STATS', 'KILL', 'LOAD'].includes(sub) && !(cmd === 'FUNCTION' && sub === 'LOAD');
    return ro ? { verb: `${cmd} ${sub}`, path: '', mutating: false, statement: `${cmd} ${sub}` } : { verb: `${cmd} ${sub}`, path: '', mutating: true, uncertain: `${cmd} ${sub} changes server-side code`, statement: `${cmd} ${sub}` };
  }
  if (/^(EVAL|EVALSHA|FCALL)(_RO)?$/.test(cmd)) {
    const n = Number(args[2]);
    const key = Number.isInteger(n) && n > 0 ? (args[3] ?? '') : '';
    // why: the _RO forms are refused by Redis if the script writes; the others may write anything.
    if (cmd.endsWith('_RO')) return { verb: cmd, path: key, mutating: false, statement: statement(cmd, key) };
    return { verb: cmd, path: key, mutating: true, uncertain: 'a script whose body is not inspected', statement: statement(cmd, key) };
  }
  if (cmd === 'SORT' || cmd === 'GEORADIUS' || cmd === 'GEORADIUSBYMEMBER') {
    const stores = args.slice(2).some((a) => /^(STORE|STOREDIST)$/i.test(a));
    return { verb: cmd, path: args[1] ?? '', mutating: stores, statement: statement(cmd, args[1] ?? '') };
  }
  if (cmd === 'BITOP') return { verb: cmd, path: args[2] ?? '', mutating: true, statement: statement(`BITOP ${sub}`, args[2] ?? '') };
  if (cmd === 'XREADGROUP') {
    const i = args.findIndex((a) => a.toUpperCase() === 'STREAMS');
    const key = i >= 0 ? (args[i + 1] ?? '') : '';
    return { verb: cmd, path: key, mutating: true, statement: statement(cmd, key) };
  }
  if (REDIS_WRITES.has(cmd)) {
    const key = cmd === 'FLUSHDB' || cmd === 'FLUSHALL' || cmd === 'SWAPDB' ? '' : cmd === 'XGROUP' ? (args[2] ?? '') : (args[1] ?? '');
    return { verb: cmd, path: key, mutating: true, statement: statement(cmd, key) };
  }
  if (REDIS_READS.has(cmd)) {
    const key = cmd === 'OBJECT' || cmd === 'XINFO' || cmd === 'MEMORY' ? (args[2] ?? '') : ['KEYS', 'SCAN', 'RANDOMKEY', 'DBSIZE'].includes(cmd) ? '' : (args[1] ?? '');
    return { verb: cmd, path: key, mutating: false, statement: statement(cmd, key) };
  }
  if (REDIS_CONTROL.has(cmd)) return { verb: cmd, path: '', mutating: false, statement: SECRET_ARGS.has(cmd) ? cmd : cmd === 'CLIENT' ? `CLIENT ${sub}` : cmd };
  // why: an unknown command's arguments are not known to be keys; none is recorded.
  return { verb: cmd, path: '', mutating: true, uncertain: `unknown command ${cmd}`, statement: cmd };
}

/** A complete RESP value at `at`: [end offset, summary], or null when more bytes are needed. `items` collects the summaries of a top-level aggregate's elements. */
function value(b: Buffer, at: number, depth = 0, items?: string[]): [number, string] | null {
  if (depth > 64) throw new WireDesync('redis: reply nested too deep');
  if (at >= b.length) return null;
  const t = String.fromCharCode(b[at]!);
  const nl = b.indexOf('\r\n', at, 'latin1');
  if (nl < 0) return null;
  const line = b.toString('latin1', at + 1, nl);
  const after = nl + 2;
  switch (t) {
    case '+':
      return [after, `+${line.length <= 16 ? line : 'status'}`];
    case '-':
    case '!': {
      if (t === '!') {
        const n = Number(line);
        if (b.length < after + n + 2) return null;
        const code = b.toString('latin1', after, Math.min(after + n, after + 40)).split(' ')[0]!;
        return [after + n + 2, `-${code}`];
      }
      return [after, `-${line.split(' ')[0]}`];
    }
    case ':':
      return [after, `:${line}`];
    case '_':
      return [after, 'nil'];
    case ',':
    case '#':
    case '(':
      return [after, t === '#' ? `#${line}` : `${t}number`];
    case '$':
    case '=': {
      const n = Number(line);
      if (!Number.isInteger(n) || n > MAX_BULK) throw new WireDesync(`redis: bulk length ${line}`);
      if (n < 0) return [after, 'nil'];
      if (b.length < after + n + 2) return null;
      return [after + n + 2, `$${n}`];
    }
    case '*':
    case '~':
    case '>':
    case '%':
    case '|': {
      const n = Number(line);
      if (!Number.isInteger(n)) throw new WireDesync(`redis: aggregate length ${line}`);
      if (n < 0) return [after, 'nil'];
      const count = t === '%' || t === '|' ? n * 2 : n;
      let p = after;
      for (let i = 0; i < count; i++) {
        const v = value(b, p, depth + 1);
        if (!v) return null;
        p = v[0];
        items?.push(v[1]);
      }
      if (t === '|') {
        // An attribute: the reply is the value after it.
        if (items) items.length = 0;
        const v = value(b, p, depth, items);
        if (!v) return null;
        return [v[0], v[1]];
      }
      return [p, `${t}${n}`];
    }
    default:
      throw new WireDesync(`redis: unknown reply type ${JSON.stringify(t)}`);
  }
}

interface Meta {
  verb: string;
  /** HELLO: the protocol version asked for. */
  hello?: number;
}

export class RedisSession implements CodecSession {
  readonly protocol = 'redis' as const;
  private cbuf: Buffer = Buffer.alloc(0);
  private sbuf: Buffer = Buffer.alloc(0);
  private readonly inflight: { id: number; verb: string; hello?: number }[] = [];
  private passthrough = false;
  private resp = 2;
  /** The backend's MULTI state, from its answers (never from what the client sent: a pipelined MULTI may not be answered yet). */
  private multiReal = false;
  /** Commands queued since MULTI was answered: the next one's position in the EXEC answer. */
  private queued = 0;
  /** An error was injected while queuing: EXEC must be answered EXECABORT. */
  private execAbort = false;

  constructor(private readonly key: string) {}

  txn(): TxnState {
    return this.multiReal ? 'in' : 'idle';
  }

  client(chunk: Buffer): ClientUnit[] {
    this.cbuf = this.cbuf.length ? Buffer.concat([this.cbuf, chunk]) : chunk;
    const out: ClientUnit[] = [];
    if (this.passthrough) {
      const b = this.cbuf;
      this.cbuf = Buffer.alloc(0);
      return b.length ? [{ bytes: b, req: null }] : [];
    }
    for (;;) {
      if (!this.cbuf.length) break;
      const parsed = this.cbuf[0] === 0x2a ? this.array() : this.inline();
      if (!parsed) break;
      const [end, args] = parsed;
      const bytes = this.cbuf.subarray(0, end);
      this.cbuf = this.cbuf.subarray(end);
      if (!args.length) {
        out.push({ bytes, req: null });
        continue;
      }
      const req = classifyRedis(args);
      const cmd = req.verb.split(' ')[0]!;
      const hello = cmd === 'HELLO' && args[1] ? Number(args[1]) || undefined : undefined;
      out.push({ bytes, req, txnKey: this.key, meta: { verb: cmd, ...(hello ? { hello } : {}) } satisfies Meta });
      if (cmd === 'MONITOR' || (PASSTHROUGH_AFTER.has(cmd) && this.resp < 3)) {
        // why: replies are no longer one per command; the rest of the connection is passed through unread.
        this.passthrough = true;
        if (this.cbuf.length) out.push({ bytes: this.cbuf, req: null }), (this.cbuf = Buffer.alloc(0));
        break;
      }
    }
    return out;
  }

  private array(): [number, string[]] | null {
    const b = this.cbuf;
    const nl = b.indexOf('\r\n', 0, 'latin1');
    if (nl < 0) return null;
    const n = Number(b.toString('latin1', 1, nl));
    if (!Number.isInteger(n) || n > 1024 * 1024) throw new WireDesync(`redis: command array length ${b.toString('latin1', 1, Math.min(nl, 20))}`);
    let p = nl + 2;
    const args: string[] = [];
    for (let i = 0; i < n; i++) {
      if (p >= b.length) return null;
      if (b[p] !== 0x24) throw new WireDesync('redis: a command argument is not a bulk string');
      const e = b.indexOf('\r\n', p, 'latin1');
      if (e < 0) return null;
      const len = Number(b.toString('latin1', p + 1, e));
      if (!Number.isInteger(len) || len < 0 || len > MAX_BULK) throw new WireDesync('redis: argument length');
      if (b.length < e + 2 + len + 2) return null;
      // why: only the command name, keys and option words (STORE) are ever read; a large value is not decoded past what classification needs.
      args.push(b.toString('utf8', e + 2, e + 2 + Math.min(len, i < 16 ? 1024 : 16)));
      p = e + 2 + len + 2;
    }
    return [p, args];
  }

  private inline(): [number, string[]] | null {
    const nl = this.cbuf.indexOf('\n');
    if (nl < 0) {
      if (this.cbuf.length > 64 * 1024) throw new WireDesync('redis: inline command too long');
      return null;
    }
    const line = this.cbuf.toString('utf8', 0, nl).replace(/\r$/, '');
    return [nl + 1, line.trim() ? line.trim().split(/\s+/) : []];
  }

  sent(id: number, u: ClientUnit): void {
    const m = u.meta as Meta | undefined;
    if (m) this.inflight.push({ id, verb: m.verb, ...(m.hello ? { hello: m.hello } : {}) });
  }

  server(chunk: Buffer): ServerPiece[] {
    this.sbuf = this.sbuf.length ? Buffer.concat([this.sbuf, chunk]) : chunk;
    const out: ServerPiece[] = [];
    for (;;) {
      if (!this.sbuf.length) break;
      if (this.passthrough && !this.inflight.length) {
        out.push({ bytes: this.sbuf, unit: null });
        this.sbuf = Buffer.alloc(0);
        break;
      }
      const items: string[] = [];
      const v = value(this.sbuf, 0, 0, items);
      if (!v) break;
      const [end, summary] = v;
      const bytes = this.sbuf.subarray(0, end);
      this.sbuf = this.sbuf.subarray(end);
      if (bytes[0] === 0x3e) {
        // A RESP3 push is out of band, except that (P|S)(UN)SUBSCRIBE are answered by one.
        const head = this.inflight[0];
        if (head && /^[PS]?(UN)?SUBSCRIBE$/.test(head.verb)) {
          this.inflight.shift();
          out.push({ bytes, unit: head.id, end: this.outcome(head, summary, []) });
        } else out.push({ bytes, unit: null });
        continue;
      }
      const f = this.inflight.shift();
      if (!f) {
        out.push({ bytes, unit: null });
        continue;
      }
      out.push({ bytes, unit: f.id, end: this.outcome(f, summary, items) });
    }
    return out;
  }

  private outcome(f: { verb: string; hello?: number }, summary: string, items: string[]): Outcome {
    const verb = f.verb;
    const err = summary.startsWith('-') ? summary.slice(1) : null;
    let ended = false;
    let committed = false;
    let queuedIndex: number | undefined;
    let failedItems: number[] | undefined;
    if (verb === 'MULTI' && !err) {
      this.multiReal = true;
      this.queued = 0;
    } else if (verb === 'EXEC' || verb === 'DISCARD') {
      ended = this.multiReal;
      committed = this.multiReal && verb === 'EXEC' && /^[*~]/.test(summary);
      if (committed) failedItems = items.flatMap((x, i) => (x.startsWith('-') ? [i] : []));
      this.multiReal = false;
    } else if (verb === 'RESET' && !err) {
      this.multiReal = false;
      this.resp = 2;
      this.execAbort = false;
    } else if (verb === 'HELLO' && !err && f.hello) this.resp = f.hello;
    else if (this.multiReal && summary === '+QUEUED') queuedIndex = this.queued++;
    return { status: err ? (UNAVAILABLE.test(err) ? 503 : 400) : 200, reply: summary, txn: this.txn(), ...(ended ? { ended } : {}), ...(committed ? { committed } : {}), ...(queuedIndex !== undefined ? { queuedIndex } : {}), ...(failedItems?.length ? { failedItems } : {}) };
  }

  intercept(u: ClientUnit): Intercept | null {
    const m = u.meta as Meta | undefined;
    if (!m || !this.execAbort) return null;
    if (m.verb === 'DISCARD') {
      this.execAbort = false;
      return null;
    }
    if (m.verb === 'EXEC') {
      // why: Redis discards a transaction at EXEC after an error while queuing; the backend queued everything else, so it is discarded the same way.
      this.execAbort = false;
      const fwd: ClientUnit = { bytes: Buffer.from('*1\r\n$7\r\nDISCARD\r\n', 'latin1'), req: u.req, txnKey: this.key, meta: { verb: 'DISCARD' } satisfies Meta };
      return { forward: fwd, answer: Buffer.from('-EXECABORT Transaction discarded because of previous errors.\r\n', 'latin1'), outcome: { status: 400, reply: '-EXECABORT (emulated after an injected error)', txn: 'idle', ended: true } };
    }
    return null;
  }

  injectError(_u: ClientUnit, message: string, realTxn: TxnState): { bytes: Buffer; note?: string } {
    if (realTxn === 'in') this.execAbort = true;
    return { bytes: Buffer.from(`-ERR ${(message || INJECTED).replace(/[\r\n]/g, ' ')}\r\n`, 'utf8'), ...(this.execAbort ? { note: 'inside MULTI: the EXEC is answered EXECABORT and the backend transaction discarded' } : {}) };
  }
}
