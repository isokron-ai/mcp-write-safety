/**
 * A minimal in-repo stand-in for the tiny-tracker backend: a small HTTP API over memory with
 * ETag and If-Match, per-field PATCH, idempotency keys, and validation. It is deliberately correct;
 * `lostUpdate: true` makes the API itself lose concurrent writes, so the `platform` verdict can be
 * shown. Test fixture only.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Ticket {
  id: string;
  title: string;
  status: string;
  assignee: string;
  priority: number;
  labels: string[];
  version: number;
  updated_at: string;
  seen?: boolean;
}

const STATUS = ['open', 'closed', 'blocked'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class TrackerBackend {
  readonly tickets = new Map<string, Ticket>();
  private seq = 0;
  private readonly idem = new Map<string, { body: string; id: string }>();
  private server: Server | null = null;
  url = '';
  requests = 0;
  /** review B2: how many times the tenant read was asked for. */
  whoamiCalls = 0;

  constructor(readonly o: { lostUpdate?: boolean; tenant?: string } = {}) {}

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

  private validate(b: Record<string, unknown>, partial: boolean): string | null {
    if (!partial && (typeof b['title'] !== 'string' || !b['title'])) return 'title: required string';
    if (b['title'] !== undefined && typeof b['title'] !== 'string') return 'title: must be a string';
    if (b['status'] !== undefined && !STATUS.includes(String(b['status']))) return `status: must be one of ${STATUS.join(', ')}`;
    if (b['assignee'] !== undefined && typeof b['assignee'] !== 'string') return 'assignee: must be a string';
    if (b['priority'] !== undefined && (!Number.isInteger(b['priority']) || (b['priority'] as number) < 1 || (b['priority'] as number) > 5)) return 'priority: an integer from 1 to 5';
    return null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.requests++;
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body: Record<string, unknown> = {};
    try {
      body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      return this.send(res, 400, { error: 'body is not JSON' });
    }
    const u = new URL(req.url ?? '/', 'http://x');
    const m = /^\/tickets\/([^/]+)(\/seen)?$/.exec(u.pathname);
    const ifMatch = req.headers['if-match'];
    const matches = (t: Ticket) => ifMatch === undefined || ifMatch === '*' || String(ifMatch).replace(/"/g, '') === String(t.version);
    if (req.method === 'GET' && u.pathname === '/whoami') this.whoamiCalls++;
    if (req.method === 'GET' && u.pathname === '/whoami') return this.send(res, 200, { tenant: this.o.tenant ?? 'mwsc-test-tenant' });
    if (req.method === 'GET' && u.pathname === '/tickets') {
      const p = u.searchParams.get('prefix') ?? '';
      return this.send(res, 200, { items: [...this.tickets.values()].filter((t) => t.title.startsWith(p)) });
    }
    if (req.method === 'POST' && u.pathname === '/tickets') {
      const err = this.validate(body, false);
      if (err) return this.send(res, 400, { error: err });
      const key = req.headers['idempotency-key'];
      if (typeof key === 'string') {
        const prev = this.idem.get(key);
        if (prev) {
          if (prev.body !== raw) return this.send(res, 422, { error: 'idempotency key reused with a different body' });
          return this.send(res, 200, this.tickets.get(prev.id), { 'idempotent-replayed': 'true' });
        }
      }
      const id = `T${++this.seq}`;
      const t: Ticket = { id, title: String(body['title']), status: String(body['status'] ?? 'open'), assignee: String(body['assignee'] ?? ''), priority: Number(body['priority'] ?? 3), labels: [], version: 1, updated_at: new Date().toISOString() };
      this.tickets.set(id, t);
      if (typeof key === 'string') this.idem.set(key, { body: raw, id });
      return this.send(res, 201, t);
    }
    if (!m) return this.send(res, 404, { error: 'not found' });
    const t = this.tickets.get(decodeURIComponent(m[1]!));
    if (!t) return this.send(res, 404, { error: 'ticket not found' });
    if (m[2]) {
      if (req.method !== 'POST') return this.send(res, 405, { error: 'POST only' });
      t.seen = true;
      return this.send(res, 200, t);
    }
    switch (req.method) {
      case 'GET':
        return this.send(res, 200, t, { etag: `"${t.version}"` });
      case 'PATCH': {
        const err = this.validate(body, true);
        if (err) return this.send(res, 400, { error: err });
        if (!this.o.lostUpdate && !matches(t)) return this.send(res, 412, { error: `version mismatch: current ${t.version}` });
        const patch = Object.fromEntries(Object.entries(body).filter(([k]) => ['title', 'status', 'assignee', 'priority', 'labels'].includes(k)));
        if (this.o.lostUpdate) {
          // why: the platform defect: a read-modify-write with no lock, so concurrent patches overwrite each other.
          const copy = { ...t };
          await sleep(30);
          this.tickets.set(t.id, { ...copy, ...patch, version: copy.version + 1, updated_at: new Date().toISOString() });
          return this.send(res, 200, this.tickets.get(t.id));
        }
        Object.assign(t, patch, { version: t.version + 1, updated_at: new Date().toISOString() });
        return this.send(res, 200, t, { etag: `"${t.version}"` });
      }
      case 'PUT': {
        const err = this.validate(body, false);
        if (err) return this.send(res, 400, { error: err });
        if (!this.o.lostUpdate && !matches(t)) return this.send(res, 412, { error: `version mismatch: current ${t.version}` });
        const next: Ticket = { ...t, title: String(body['title']), status: String(body['status'] ?? 'open'), assignee: String(body['assignee'] ?? ''), priority: Number(body['priority'] ?? 3), labels: Array.isArray(body['labels']) ? (body['labels'] as string[]) : [], version: t.version + 1, updated_at: new Date().toISOString() };
        this.tickets.set(t.id, next);
        return this.send(res, 200, next, { etag: `"${next.version}"` });
      }
      case 'DELETE':
        this.tickets.delete(t.id);
        res.writeHead(204).end();
        return;
      default:
        return this.send(res, 405, { error: 'method not allowed' });
    }
  }

  private send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
  }
}
