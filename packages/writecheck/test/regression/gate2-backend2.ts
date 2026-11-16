// @ts-nocheck
/* eslint-disable */
// Vendored test fixture: backend2.mjs of the gate-2 safety re-run on 378f32f, unchanged below this header.
/**
 * In-memory HTTP backend for fake2.mjs (gate-2 re-run on mcp-writecheck 378f32f, MWS-RETRY-2 and rule 11).
 * Written for this run; it is not a copy of the tool's own fixtures. Loopback only, test fixture only.
 *
 *   GET    /whoami
 *   GET    /c/<coll>?prefix=&field=&per=&page=      {items, total, page, pages}
 *   POST   /c/<coll>                                 create; header idempotency-key: applied once, a repeat with the
 *                                                    same body gets the first answer (header idempotent-replayed: true),
 *                                                    a repeat with another body gets 422
 *   GET | PATCH | DELETE /c/<coll>/<id>              PATCH adds 1 to version on every write, honours if-match and
 *                                                    idempotency-key as POST does
 *   POST   /c/<coll>/<id>/close                      always 409 (a step the backend refuses)
 *   GET    /keys/<key>                               the lookup of a write by its idempotency key
 *   POST   /admin/wipe                               deletes every object that was not seeded (a backend that lost state)
 *   POST   /admin/reid                               gives every object that was not seeded a new id
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

export class Backend2 {
  constructor(o = {}) {
    this.o = o;
    this.colls = new Map();
    this.seq = 0;
    this.keys = new Map();
    this.requests = [];
    /** Every write the backend really applied (a replay by its own key is not one). */
    this.applied = [];
    this.seededIds = new Set();
    this.server = null;
  }
  coll(n) {
    let c = this.colls.get(n);
    if (!c) this.colls.set(n, (c = new Map()));
    return c;
  }
  seed(coll, doc) {
    const d = { version: 1, updated_at: new Date().toISOString(), ...doc };
    this.coll(coll).set(String(d.id), d);
    this.seededIds.add(`${coll}/${d.id}`);
    return d;
  }
  all(coll) {
    return [...this.coll(coll).values()];
  }
  async start() {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise((r) => this.server.listen(0, '127.0.0.1', () => r()));
    this.url = `http://127.0.0.1:${this.server.address().port}`;
    return this.url;
  }
  async stop() {
    this.server?.closeAllConnections?.();
    await new Promise((r) => (this.server ? this.server.close(() => r()) : r()));
  }
  send(res, status, body, headers = {}) {
    if (status === 204) return void res.writeHead(204, headers).end();
    res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
  }
  async handle(req, res) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return this.send(res, 400, { error: 'body is not JSON' });
    }
    const u = new URL(req.url ?? '/', 'http://x');
    const key = req.headers['idempotency-key'];
    this.requests.push({ t: Date.now(), method: req.method, path: u.pathname + u.search, body, key: key ?? null });
    if (req.method === 'GET' && u.pathname === '/whoami') return this.send(res, 200, { tenant: this.o.tenant ?? 'mwsv-test-tenant' });
    if (req.method === 'POST' && u.pathname === '/admin/wipe') {
      for (const [n, c] of this.colls) for (const id of [...c.keys()]) if (!this.seededIds.has(`${n}/${id}`)) c.delete(id);
      return this.send(res, 200, { wiped: true });
    }
    if (req.method === 'POST' && u.pathname === '/admin/reid') {
      for (const [n, c] of this.colls) for (const [id, d] of [...c.entries()]) if (!this.seededIds.has(`${n}/${id}`)) {
        c.delete(id);
        const nid = `X${++this.seq}`;
        c.set(nid, { ...d, id: nid });
      }
      return this.send(res, 200, { reid: true });
    }
    const k = /^\/keys\/([^/]+)$/.exec(u.pathname);
    if (k && req.method === 'GET') {
      const rec = this.keys.get(decodeURIComponent(k[1]));
      return rec ? this.send(res, 200, { status: rec.status, body: rec.body }) : this.send(res, 404, { error: 'no write with this key' });
    }
    const m = /^\/c\/([^/]+)(?:\/([^/]+))?(\/close)?$/.exec(u.pathname);
    if (!m) return this.send(res, 404, { error: 'not found' });
    const c = this.coll(m[1]);
    // The idempotency key of the platform: decided and recorded in one turn of the event loop, so two requests cannot both apply.
    const keyed = (apply) => {
      if (key === undefined || key === '') return apply();
      const hash = createHash('sha256').update(`${req.method} ${u.pathname} ${JSON.stringify(body)}`).digest('hex');
      const rec = this.keys.get(String(key));
      if (rec) {
        if (rec.hash !== hash) return this.send(res, 422, { error: 'this idempotency key was already used with a different request; nothing was written' });
        return this.send(res, rec.status, rec.body, { 'idempotent-replayed': 'true' });
      }
      const out = apply(true);
      if (out) this.keys.set(String(key), { hash, status: out.status, body: out.body });
    };
    if (m[2] === undefined) {
      if (req.method === 'GET') {
        const prefix = u.searchParams.get('prefix') ?? '';
        const field = u.searchParams.get('field') ?? 'title';
        let items = [...c.values()].filter((d) => String(d[field] ?? '').startsWith(prefix));
        const total = items.length;
        const per = Number(u.searchParams.get('per') ?? 0);
        const page = Number(u.searchParams.get('page') ?? 1);
        if (per > 0) items = items.slice((page - 1) * per, page * per);
        return this.send(res, 200, { items, total, page, pages: per > 0 ? Math.max(1, Math.ceil(total / per)) : 1 });
      }
      if (req.method === 'POST')
        return keyed(() => {
          const id = body.id ?? `T${++this.seq}`;
          if (c.has(String(id))) {
            this.send(res, 409, { error: `${String(id)} already exists` });
            return null;
          }
          const d = { ...body, id, version: 1, updated_at: new Date().toISOString() };
          c.set(String(id), d);
          this.applied.push({ t: Date.now(), op: 'create', coll: m[1], id: String(id), body });
          this.send(res, 201, d);
          return { status: 201, body: d };
        });
      return this.send(res, 405, { error: 'method not allowed' });
    }
    const d = c.get(decodeURIComponent(m[2]));
    if (!d) return this.send(res, 404, { error: `${m[1]} ${m[2]} not found` });
    if (m[3]) return this.send(res, 409, { error: `${m[2]} is locked and cannot be closed` });
    const ifMatch = req.headers['if-match'];
    const matches = ifMatch === undefined || ifMatch === '' || ifMatch === '*' || String(ifMatch).replace(/"/g, '') === String(d.version);
    switch (req.method) {
      case 'GET':
        return this.send(res, 200, d);
      case 'PATCH':
        return keyed(() => {
          if (!matches) {
            this.send(res, 412, { error: `version mismatch: current ${String(d.version)}` });
            return null;
          }
          const { id: _i, version: _v, ...patch } = body;
          Object.assign(d, patch, { version: Number(d.version) + 1, updated_at: new Date().toISOString() });
          const copy = { ...d };
          this.applied.push({ t: Date.now(), op: 'patch', coll: m[1], id: String(d.id), body });
          this.send(res, 200, copy);
          return { status: 200, body: copy };
        });
      case 'DELETE':
        c.delete(String(d.id));
        return this.send(res, 204, {});
      default:
        return this.send(res, 405, { error: 'method not allowed' });
    }
  }
}
