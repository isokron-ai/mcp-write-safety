/**
 * A minimal in-process Redis for the wire gate's tests, and a minimal RESP client. The fake keeps
 * string keys and understands GET, SET, DEL, INCR, PING, HELLO (2 or 3, answering a map in 3),
 * MULTI/EXEC/DISCARD, SUBSCRIBE (RESP2 push arrays) and inline commands; anything else is
 * -ERR unknown command. It logs every command that reached it.
 */

import { createServer, connect, type AddressInfo, type Server, type Socket } from 'node:net';

export interface FakeRedis {
  url: string;
  port: number;
  data: Map<string, string>;
  seen: string[];
  close(): Promise<void>;
}

const bulk = (s: string | null) => (s === null ? '$-1\r\n' : `$${Buffer.byteLength(s)}\r\n${s}\r\n`);

export async function fakeRedis(initial: Record<string, string> = {}): Promise<FakeRedis> {
  const data = new Map(Object.entries(initial));
  const seen: string[] = [];
  const socks = new Set<Socket>();
  const server: Server = createServer((s) => {
    socks.add(s);
    s.on('close', () => socks.delete(s));
    s.on('error', () => undefined);
    let buf = Buffer.alloc(0);
    let queue: string[][] | null = null;
    let resp = 2;
    const exec = (a: string[]): string => {
      const c = a[0]!.toUpperCase();
      if (c === 'GET') return bulk(data.get(a[1]!) ?? null);
      if (c === 'SET') return data.set(a[1]!, a[2]!), '+OK\r\n';
      if (c === 'DEL') return `:${a.slice(1).filter((k) => data.delete(k)).length}\r\n`;
      if (c === 'INCR') {
        const n = Number(data.get(a[1]!) ?? '0');
        if (!Number.isInteger(n)) return '-ERR value is not an integer or out of range\r\n';
        data.set(a[1]!, String(n + 1));
        return `:${n + 1}\r\n`;
      }
      if (c === 'PING') return '+PONG\r\n';
      return `-ERR unknown command '${a[0]}'\r\n`;
    };
    s.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      let out = '';
      for (;;) {
        let args: string[] = [];
        if (!buf.length) break;
        if (buf[0] === 0x2a) {
          const text = buf.toString('latin1');
          const nl = text.indexOf('\r\n');
          if (nl < 0) break;
          const n = Number(text.slice(1, nl));
          let p = nl + 2;
          let ok = true;
          for (let i = 0; i < n; i++) {
            const e = text.indexOf('\r\n', p);
            if (e < 0) {
              ok = false;
              break;
            }
            const len = Number(text.slice(p + 1, e));
            if (text.length < e + 2 + len + 2) {
              ok = false;
              break;
            }
            args.push(buf.toString('utf8', e + 2, e + 2 + len));
            p = e + 2 + len + 2;
          }
          if (!ok) break;
          buf = buf.subarray(p);
        } else {
          const nl = buf.indexOf('\n');
          if (nl < 0) break;
          args = buf.toString('utf8', 0, nl).trim().split(/\s+/);
          buf = buf.subarray(nl + 1);
        }
        seen.push(args.join(' '));
        const c = args[0]!.toUpperCase();
        if (c === 'HELLO') {
          resp = Number(args[1] ?? '2');
          out += resp === 3 ? `%2\r\n+server\r\n+fake\r\n+proto\r\n:3\r\n` : `*4\r\n$6\r\nserver\r\n$4\r\nfake\r\n$5\r\nproto\r\n:2\r\n`;
        } else if (c === 'MULTI') {
          queue = [];
          out += '+OK\r\n';
        } else if (c === 'DISCARD') {
          queue = null;
          out += '+OK\r\n';
        } else if (c === 'EXEC') {
          const q = queue ?? [];
          queue = null;
          out += `*${q.length}\r\n${q.map(exec).join('')}`;
        } else if (c === 'SUBSCRIBE') {
          out += `*3\r\n$9\r\nsubscribe\r\n${bulk(args[1]!)}:1\r\n`;
          setTimeout(() => s.write(`*3\r\n$7\r\nmessage\r\n${bulk(args[1]!)}${bulk('hello')}`), 20);
        } else if (queue) {
          queue.push(args);
          out += '+QUEUED\r\n';
        } else out += exec(args);
        void resp;
      }
      if (out) s.write(out);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `redis://:pw@127.0.0.1:${port}/0`,
    port,
    data,
    seen,
    close: async () => {
      for (const s of socks) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** A minimal RESP client: sends commands, collects raw reply text. */
export class RedisClient {
  text = '';
  closed = false;
  private waiters: (() => void)[] = [];
  private constructor(readonly sock: Socket) {
    sock.on('data', (b: Buffer) => {
      this.text += b.toString('utf8');
      this.wake();
    });
    sock.on('close', () => {
      this.closed = true;
      this.wake();
    });
    sock.on('error', () => undefined);
  }
  static async connect(port: number): Promise<RedisClient> {
    const sock = connect({ host: '127.0.0.1', port });
    await new Promise<void>((r, j) => (sock.once('connect', () => r()), sock.once('error', j)));
    return new RedisClient(sock);
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
  static cmd(...a: string[]): string {
    return `*${a.length}\r\n${a.map((x) => `$${Buffer.byteLength(x)}\r\n${x}\r\n`).join('')}`;
  }
  /** Send a command and wait for `wait` (a regex on the new text) or the timeout; returns the new text. */
  async call(a: string[] | string, wait: RegExp = /\r\n$/, ms = 3000): Promise<string> {
    const start = this.text.length;
    this.sock.write(Array.isArray(a) ? RedisClient.cmd(...a) : a);
    await this.until(() => wait.test(this.text.slice(start)), ms);
    return this.text.slice(start);
  }
  close(): void {
    this.sock.destroy();
  }
}
