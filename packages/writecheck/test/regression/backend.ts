/**
 * The backend behind the regression fixtures (test/regression/server.ts): a small HTTP API over
 * memory, in the style of test/fake/backend.ts. It stores JSON objects in named collections and
 * does nothing clever: the MCP server in front of it carries the shapes under test. Two switches
 * make the API itself show a behaviour, so that a control arm can tell `platform` from `violated`:
 *
 *   putUnchecked      a whole-object PUT is applied whatever version it carries (no precondition),
 *                     while a per-field PATCH stays atomic. The shape of a server-side apply sent
 *                     twice by one field manager (kubernetes/CLI-BUGS.md B3, hand check H3).
 *   fieldManagers     field ownership in the style of a Kubernetes server-side apply. A request names its
 *                     manager in the header x-field-manager (none: "anonymous"); a PATCH or a write takes
 *                     the fields it sends for its manager. A PUT that names a manager and is not forced
 *                     (header x-force) is refused with 409 where it would change a field another manager
 *                     owns; one manager writing twice from one read is applied and loses the first change
 *                     (kubernetes/CLI-BUGS-d3b536f.md B3, hand check HA).
 *   normalizeOnWrite  the first write to an object rewrites a field the write did not name: keys of
 *                     `meta` whose value is null are dropped (grafana/CLI-BUGS.md 12).
 *
 * Test fixture only.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type Doc = Record<string, unknown>;

export interface BackendOptions {
  tenant?: string;
  putUnchecked?: boolean;
  normalizeOnWrite?: boolean;
  fieldManagers?: boolean;
  /** Numeric ids (1, 2, …) instead of T1, T2, … (the Payload shape). */
  numericIds?: boolean;
}

export class ShapeBackend {
  readonly collections = new Map<string, Map<string, Doc>>();
  private seq = 0;
  private server: Server | null = null;
  url = '';
  /** Every request the API answered: method, path and body, in order. */
  readonly requests: { method: string; path: string; body: Doc }[] = [];
  /** fieldManagers: the manager that owns each field, per object (collection/id -> field -> manager). */
  private readonly owners = new Map<string, Map<string, string>>();

  constructor(readonly o: BackendOptions = {}) {}

  coll(name: string): Map<string, Doc> {
    let c = this.collections.get(name);
    if (!c) this.collections.set(name, (c = new Map()));
    return c;
  }

  /** Put an object in place before a run (a bystander, a seeded row). */
  seed(coll: string, doc: Doc): Doc {
    const id = doc['id'] ?? this.nextId();
    // why: a seeded numeric id must not be handed out again by the next create.
    if (typeof id === 'number') this.seq = Math.max(this.seq, id);
    const d = { version: 1, updated_at: new Date().toISOString(), ...doc, id };
    this.coll(coll).set(String(id), d);
    return d;
  }

  all(coll: string): Doc[] {
    return [...this.coll(coll).values()];
  }

  private nextId(): string | number {
    return this.o.numericIds ? ++this.seq : `T${++this.seq}`;
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', () => r()));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections?.();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  private normalize(d: Doc): Doc {
    if (!this.o.normalizeOnWrite) return d;
    const meta = d['meta'];
    if (meta && typeof meta === 'object' && !Array.isArray(meta)) d['meta'] = Object.fromEntries(Object.entries(meta as Doc).filter(([, v]) => v !== null));
    return d;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body: Doc = {};
    try {
      body = raw ? (JSON.parse(raw) as Doc) : {};
    } catch {
      return this.send(res, 400, { error: 'body is not JSON' });
    }
    const u = new URL(req.url ?? '/', 'http://x');
    this.requests.push({ method: req.method ?? '', path: u.pathname + u.search, body });
    if (req.method === 'GET' && u.pathname === '/whoami') return this.send(res, 200, { tenant: this.o.tenant ?? 'mwsc-test-tenant' });
    const m = /^\/c\/([^/]+)(?:\/([^/]+))?$/.exec(u.pathname);
    if (!m) return this.send(res, 404, { error: 'not found' });
    const c = this.coll(m[1]!);
    const ifMatch = req.headers['if-match'];
    const matches = (d: Doc) => ifMatch === undefined || ifMatch === '' || ifMatch === '*' || String(ifMatch).replace(/"/g, '') === String(d['version']);
    if (m[2] === undefined) {
      if (req.method === 'GET') {
        const prefix = u.searchParams.get('prefix') ?? '';
        const scope = u.searchParams.get('scope');
        const field = u.searchParams.get('field') ?? 'title';
        return this.send(res, 200, { items: [...c.values()].filter((d) => String(d[field] ?? '').startsWith(prefix) && (scope === null || d['scope'] === scope)) });
      }
      if (req.method === 'POST') {
        const id = body['id'] ?? this.nextId();
        if (c.has(String(id))) return this.send(res, 409, { error: `${String(id)} already exists` });
        const d: Doc = { ...body, id, version: 1, updated_at: new Date().toISOString() };
        c.set(String(id), d);
        return this.send(res, 201, d);
      }
      return this.send(res, 405, { error: 'method not allowed' });
    }
    if (m[2] === 'delete-where' && req.method === 'POST') {
      // The platform's bulk delete: everything in `scope` whose title starts with `prefix` (an empty prefix matches all).
      const gone = [...c.values()].filter((d) => (body['scope'] === '*' || d['scope'] === body['scope']) && String(d['title'] ?? '').startsWith(String(body['prefix'] ?? '')));
      for (const d of gone) c.delete(String(d['id']));
      return this.send(res, 200, { deleted: gone.map((d) => d['id']) });
    }
    const d = c.get(decodeURIComponent(m[2]));
    if (!d) return this.send(res, 404, { error: `${m[1]!} ${m[2]} not found` });
    const manager = String(req.headers['x-field-manager'] ?? 'anonymous');
    const ownKey = `${m[1]!}/${String(d['id'])}`;
    const own = (keys: string[]) => {
      if (!this.o.fieldManagers) return;
      let o = this.owners.get(ownKey);
      if (!o) this.owners.set(ownKey, (o = new Map()));
      for (const k of keys) o.set(k, manager);
    };
    switch (req.method) {
      case 'GET':
        return this.send(res, 200, d, { etag: `"${String(d['version'])}"` });
      case 'PATCH': {
        if (!matches(d)) return this.send(res, 412, { error: `version mismatch: current ${String(d['version'])}` });
        const { id: _id, version: _v, ...patch } = body;
        own(Object.keys(patch));
        Object.assign(d, patch, { version: Number(d['version']) + 1, updated_at: new Date().toISOString() });
        this.normalize(d);
        return this.send(res, 200, d, { etag: `"${String(d['version'])}"` });
      }
      case 'PUT': {
        if (!this.o.putUnchecked && !matches(d)) return this.send(res, 412, { error: `version mismatch: current ${String(d['version'])}` });
        const { id: _id, version: _v, ...next } = body;
        if (this.o.fieldManagers && req.headers['x-field-manager'] !== undefined && req.headers['x-force'] === undefined) {
          const o = this.owners.get(ownKey);
          const taken = Object.keys(next).filter((k) => k !== 'updated_at' && JSON.stringify(next[k]) !== JSON.stringify(d[k]) && o?.has(k) && o.get(k) !== manager);
          if (taken.length) return this.send(res, 409, { error: `conflict: ${taken.join(', ')} owned by ${taken.map((k) => o!.get(k)).join(', ')}` });
        }
        own(Object.keys(next));
        const stored = this.normalize({ ...next, id: d['id'], version: Number(d['version']) + 1, updated_at: new Date().toISOString() });
        c.set(String(d['id']), stored);
        return this.send(res, 200, stored, { etag: `"${String(stored['version'])}"` });
      }
      case 'DELETE':
        c.delete(String(d['id']));
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
