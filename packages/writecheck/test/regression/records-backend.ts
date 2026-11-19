/**
 * A table of records over loopback HTTP, for the fixture-alias regression test (corpus target t14: a server over one SQL
 * table, whose rows have two keys, a text `id` and an integer `rid`). It keeps every write it applied, with the rows the write
 * reached, and a tripwire: a write that reaches a protected row (a row the test seeded and the declaration does not give to
 * the tester) is recorded in `tripped`. Test fixture only.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type Row = Record<string, string | number | boolean | null> & { rid: number };
export interface WriteSeen {
  op: 'insert' | 'update' | 'delete';
  conditions: Record<string, unknown> | null;
  data: Record<string, unknown> | null;
  /** The rids of the rows the write reached. */
  rids: number[];
}

export class RecordsBackend {
  readonly rows = new Map<number, Row>();
  /** Every write applied, in order. */
  readonly writes: WriteSeen[] = [];
  /** Writes that reached a protected row: the tripwire. */
  readonly tripped: WriteSeen[] = [];
  /** Rows no write may reach. */
  readonly protectedRids = new Set<number>();
  private seq = 0;
  private server: Server | null = null;
  url = '';

  /**
   * `alsoTouch`: a server-side defect for the control test: every update that matches a row also sets the same fields on this
   * row (a statement whose WHERE is wider than the conditions it was given).
   */
  constructor(readonly o: { alsoTouch?: number } = {}) {}

  seed(row: Omit<Row, 'rid'>, o: { protect?: boolean } = {}): Row {
    const rid = ++this.seq;
    const r = { rid, ...row } as Row;
    this.rows.set(rid, r);
    if (o.protect) this.protectedRids.add(rid);
    return r;
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', () => r()));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server?.closeAllConnections?.();
  }

  private match(conditions: Record<string, unknown>): Row[] {
    // SQLite's comparison of a bound value with a column: a number matches an INTEGER column whatever form it was bound in.
    const same = (a: unknown, b: unknown) => a === b || (a !== null && b !== null && typeof a !== 'object' && typeof b !== 'object' && String(a) === String(b));
    return [...this.rows.values()].filter((r) => Object.entries(conditions).every(([k, v]) => same(r[k], v)));
  }

  private note(w: WriteSeen): void {
    this.writes.push(w);
    if (w.rids.some((r) => this.protectedRids.has(r))) this.tripped.push(w);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let raw = '';
    for await (const c of req) raw += String(c);
    const b = (raw ? JSON.parse(raw) : {}) as { op?: string; data?: Record<string, unknown>; conditions?: Record<string, unknown> };
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const data = b.data ?? {};
    const conditions = b.conditions ?? {};
    switch (b.op) {
      case 'select':
        return send(200, { rows: this.match(conditions) });
      case 'insert': {
        if (typeof data['id'] === 'string' && [...this.rows.values()].some((r) => r['id'] === data['id'])) return send(409, { error: 'SQLITE_CONSTRAINT: UNIQUE constraint failed: mwsc_items.id' });
        const rid = ++this.seq;
        this.rows.set(rid, { rid, ...(data as Record<string, string | number | boolean | null>) } as Row);
        this.note({ op: 'insert', conditions: null, data, rids: [rid] });
        return send(200, { lastID: rid });
      }
      case 'update': {
        const hit = this.match(conditions);
        const also = hit.length && this.o.alsoTouch !== undefined ? this.rows.get(this.o.alsoTouch) : undefined;
        const reached = [...hit, ...(also && !hit.includes(also) ? [also] : [])];
        for (const r of reached) for (const [k, v] of Object.entries(data)) if (k !== 'rid') r[k] = v as string | number | boolean | null;
        if (reached.length) this.note({ op: 'update', conditions, data, rids: reached.map((r) => r.rid) });
        return send(200, { changes: hit.length });
      }
      case 'delete': {
        const hit = this.match(conditions);
        for (const r of hit) this.rows.delete(r.rid);
        if (hit.length) this.note({ op: 'delete', conditions, data: null, rids: hit.map((r) => r.rid) });
        return send(200, { changes: hit.length });
      }
    }
    send(400, { error: `unknown op ${String(b.op)}` });
  }
}
