/**
 * Min mode: the built-in stateful mock of a server's backend, served from its OpenAPI description (no third-party mock
 * server, so nothing to pin or fetch). It keeps the objects a create made so that they can be read back, records every
 * request the server sends (with the step of the run that was in progress), honours a declared `Idempotency-Key`
 * header, and fails a chosen request deterministically when the tester arms a fault (spec 7.3, rule 6: a named request,
 * never a probability). Every fault it injects is recorded.
 *
 * It listens on the address the tester gives (loopback by default). It never makes a request of its own, and it
 * accepts any credential: the server is given dummy canaries, never a real one.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { validates } from '../core/jsonschema.js';
import { canonical, deepEqual, isObj, sha256, type Obj } from '../core/util.js';
import { matchOperation, MUTATING, paramName, type ApiModel, type Collection, type Operation } from './openapi.js';
import { defaultOf, fromPattern, mainType } from './values.js';

export type FaultKind =
  | { kind: 'status'; status: number; code: string }
  | { kind: 'conflict' }
  | { kind: 'drop' }
  | { kind: 'apply_then_drop' }
  | { kind: 'delay_then_drop'; ms: number };

export interface FaultSpec {
  id: string;
  /** Which requests count: mutating ones only (POST, PUT, PATCH, DELETE), or every request. */
  mutating: boolean;
  /** The nth matching request after arming (1-based) gets the fault. */
  nth: number;
  fault: FaultKind;
}

export interface InjectedFault {
  id: string;
  step: string | null;
  seq: number;
  method: string;
  template: string | null;
  kind: FaultKind['kind'];
  status: number | null;
}

export interface Ref {
  collection: string;
  id: string;
}

export interface MockRecord {
  seq: number;
  step: string | null;
  method: string;
  path: string;
  query: Record<string, string>;
  template: string | null;
  kind: 'list' | 'create' | 'read' | 'update' | 'replace' | 'delete' | 'action' | 'unmatched';
  mutating: boolean;
  headers: { 'if-match'?: string; 'idempotency-key'?: string; authorization_present: boolean };
  body: unknown;
  status: number | null;
  fault: string | null;
  replayed: boolean;
  /** What the request did to the mock's state. */
  effect: { created: Ref[]; changed: Ref[]; deleted: Ref[] };
  /** The mock answered without modelling the effect (an action endpoint it cannot read). */
  unmodelled: boolean;
  /** Members of the body the resource schema does not define (kept, and listed). */
  unknown_members: string[];
  /** The members of the object that the request changed, by name (managed members such as version left out). */
  changed_fields: string[];
  /** The mock applied the request (answered 2xx, or applied it and then cut the answer). A replay applied nothing. */
  applied: boolean;
}

interface Keyed {
  fingerprint: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}

const MANAGED = new Set(['version', 'created_at', 'updated_at', 'createdAt', 'updatedAt', 'etag']);
const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));
const propsOf = (s: unknown): Obj => (isObj(s) && isObj(s['properties']) ? s['properties'] : {});

export class Mock {
  readonly records: MockRecord[] = [];
  readonly injected: InjectedFault[] = [];
  /** Requests the mock could not express (each answered 501 and marked unmatched). */
  readonly problems: string[] = [];
  /** The step of the run in progress; every request is attributed to it. */
  step: string | null = null;
  private server: Server | null = null;
  private store = new Map<string, Map<string, Obj>>();
  private keyed = new Map<string, Keyed>();
  private armed: (FaultSpec & { seen: number })[] = [];
  private seq = 0;
  private idSeq = 100;
  private readonly versioned = new Set<Collection>();
  url = '';

  constructor(readonly model: ApiModel) {
    for (const c of model.collections) if (!c.parent) this.store.set(c.path, new Map());
    for (const c of model.collections) {
      const v = propsOf(c.schema)['version'];
      if (isObj(v) && (mainType(v) === 'integer' || mainType(v) === 'number')) this.versioned.add(c);
    }
  }

  async listen(host = '127.0.0.1', port = 0, advertised?: string): Promise<string> {
    this.server = createServer((req, res) => {
      const at = this.records.length;
      this.handle(req, res).catch((e: unknown) => {
        // The mock could not express this request (our limit): answered 501, and the request is marked so that no check judges it.
        const rec = this.records[at];
        if (rec) {
          rec.kind = 'unmatched';
          rec.unmodelled = true;
          rec.applied = false;
        }
        this.problems.push(`${req.method} ${req.url}: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
        try {
          if (!res.headersSent) res.writeHead(501, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'mock_incomplete', message: 'the min-mode mock cannot express this request' }));
        } catch {
          /* the socket is gone */
        }
      });
    });
    this.server.keepAliveTimeout = 1000;
    await new Promise<void>((r, j) => {
      this.server!.once('error', j);
      this.server!.listen(port, host, () => r());
    });
    const a = this.server.address() as AddressInfo;
    this.url = advertised ?? `http://${host.includes(':') ? `[${host}]` : host === '0.0.0.0' ? '127.0.0.1' : host}:${a.port}`;
    return this.url;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections?.();
    await new Promise<void>((r) => this.server!.close(() => r()));
    this.server = null;
  }

  arm(f: FaultSpec): void {
    this.armed.push({ ...f, seen: 0 });
  }

  disarm(): void {
    this.armed = [];
  }

  collection(path: string): Collection | undefined {
    return this.model.collections.find((c) => c.path === path);
  }

  /** Every object of a top-level collection (copies). */
  objects(path: string): Obj[] {
    return [...(this.store.get(path)?.values() ?? [])].map(clone);
  }

  get(path: string, id: string): Obj | undefined {
    const o = this.store.get(path)?.get(id);
    return o ? clone(o) : undefined;
  }

  /** The whole state, for before/after comparisons (copies). */
  snapshot(): Record<string, Record<string, Obj>> {
    const out: Record<string, Record<string, Obj>> = {};
    for (const [p, m] of this.store) out[p] = Object.fromEntries([...m].map(([k, v]) => [k, clone(v)]));
    return out;
  }

  recordsOf(step: string): MockRecord[] {
    return this.records.filter((r) => r.step === step);
  }

  /** A fresh identifier for a collection, from its id schema (pattern, integer, or a readable stem). */
  newId(c: Collection): string {
    const s = propsOf(c.schema)[c.idField];
    const taken = (id: string) => (c.parent ? false : this.store.get(c.path)?.has(id)) || this.allIds.has(id);
    for (let k = 0; k < 50; k++) {
      const n = this.idSeq++;
      let id: string | null = null;
      if (isObj(s) && typeof s['pattern'] === 'string') id = fromPattern(s['pattern'], n);
      else if (isObj(s) && (mainType(s) === 'integer' || mainType(s) === 'number')) id = String(n);
      if (id === null) id = `mm-${c.singular.toLowerCase().replace(/[^a-z0-9]/g, '')}-${n}`;
      if (!taken(id)) {
        this.allIds.add(id);
        return id;
      }
    }
    throw new Error(`min mock: could not make a fresh identifier for ${c.path}`);
  }
  private allIds = new Set<string>();

  /** Seeds every top-level collection with `n` objects, references between them, and nested children. */
  seed(n = 12, children = 3): void {
    const now = new Date().toISOString();
    const tops = this.model.collections.filter((c) => !c.parent && c.schema);
    for (const c of tops) {
      for (let i = 0; i < n; i++) {
        const o = defaultOf(c.schema, 0, now) as Obj;
        o[c.idField] = this.newIdTyped(c);
        for (const [k, ps] of Object.entries(propsOf(c.schema))) {
          if (k === c.idField || MANAGED.has(k)) continue;
          if (mainType(ps) === 'string' && !(isObj(ps) && (Array.isArray(ps['enum']) || ps['format']))) o[k] = `seeded ${c.singular} ${i} ${k}`;
        }
        if (this.versioned.has(c)) o['version'] = 1;
        this.store.get(c.path)!.set(String(o[c.idField]), o);
      }
    }
    // References: a member named for another collection's singular holds one of its identifiers.
    for (const c of tops) {
      const objs = [...this.store.get(c.path)!.values()];
      for (const [k, ps] of Object.entries(propsOf(c.schema))) {
        const other = tops.find((t) => t !== c && t.singular === k);
        if (!other || mainType(ps) !== 'string') continue;
        const ids = [...this.store.get(other.path)!.keys()];
        objs.forEach((o, i) => (o[k] = ids[i % ids.length]));
      }
    }
    // Nested children: a few in each parent's array (labels a, b, c).
    for (const c of this.model.collections.filter((x) => x.parent && x.schema)) {
      const parent = this.collection(c.parent!.path);
      if (!parent || parent.parent) continue;
      const nameKey = nameKeyOf(c);
      for (const p of this.store.get(parent.path)!.values()) {
        const arr: Obj[] = [];
        const k = c.itemPath ? children : 0; // children that can be addressed (labels) get a few; append-only ones (comments) none
        for (let i = 0; i < k; i++) {
          const ch = defaultOf(c.schema, 0, now) as Obj;
          ch[c.idField] = this.newIdTyped(c);
          if (nameKey) ch[nameKey] = String.fromCharCode(97 + i);
          arr.push(ch);
        }
        p[c.parent!.field] = arr;
      }
    }
  }

  /** Adds one object to a top-level collection (as seeded), with the members given. */
  addObject(c: Collection, where: Obj = {}): Obj {
    const o = defaultOf(c.schema, 0) as Obj;
    o[c.idField] = this.newIdTyped(c);
    for (const [k, ps] of Object.entries(propsOf(c.schema))) if (!(k in where) && k !== c.idField && !MANAGED.has(k) && mainType(ps) === 'string' && !(isObj(ps) && (Array.isArray(ps['enum']) || ps['format']))) o[k] = `added ${c.singular} ${k}`;
    Object.assign(o, clone(where));
    if (this.versioned.has(c)) o['version'] = 1;
    for (const ch of this.model.collections.filter((x) => x.parent?.path === c.path && x.schema)) {
      const nameKey = nameKeyOf(ch);
      o[ch.parent!.field] = ch.itemPath ? [0, 1, 2].map((i) => ({ ...(defaultOf(ch.schema, 0) as Obj), [ch.idField]: this.newIdTyped(ch), ...(nameKey ? { [nameKey]: String.fromCharCode(97 + i) } : {}) })) : [];
    }
    this.store.get(c.path)!.set(String(o[c.idField]), o);
    return clone(o);
  }

  private newIdTyped(c: Collection): string | number {
    const id = this.newId(c);
    const s = propsOf(c.schema)[c.idField];
    return isObj(s) && (mainType(s) === 'integer' || mainType(s) === 'number') ? Number(id) : id;
  }

  // ---- request handling ----

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) {
      chunks.push(c as Buffer);
      if (chunks.reduce((a, b) => a + b.length, 0) > 4 * 1024 * 1024) break;
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    let body: unknown = undefined;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    const method = (req.method ?? 'GET').toUpperCase();
    const u = new URL(req.url ?? '/', 'http://mock.invalid');
    const query = Object.fromEntries(u.searchParams.entries());
    const m = matchOperation(this.model, method, u.pathname);
    const h = (n: string) => (typeof req.headers[n] === 'string' ? (req.headers[n] as string) : undefined);
    const rec: MockRecord = {
      seq: ++this.seq,
      step: this.step,
      method,
      path: u.pathname,
      query,
      template: m?.op.template ?? null,
      kind: 'unmatched',
      mutating: MUTATING.has(method),
      headers: { ...(h('if-match') !== undefined ? { 'if-match': h('if-match')! } : {}), ...(h('idempotency-key') !== undefined ? { 'idempotency-key': h('idempotency-key')! } : {}), authorization_present: !!h('authorization') },
      body,
      status: null,
      fault: null,
      replayed: false,
      effect: { created: [], changed: [], deleted: [] },
      unmodelled: false,
      unknown_members: [],
      applied: false,
      changed_fields: [],
    };
    this.records.push(rec);
    if (!m) return this.send(res, rec, 404, { error: 'no_route', message: `the description has no ${method} ${u.pathname}` });
    const { op, params } = m;
    const kind = this.kindOf(op);
    rec.kind = kind.kind;

    // A fault armed for this request.
    const f = this.armed.find((a) => (!a.mutating || rec.mutating) && ++a.seen === a.nth);
    if (f) this.armed = this.armed.filter((a) => a !== f);
    const fault = f?.fault;
    if (fault) {
      rec.fault = f!.id;
      this.injected.push({ id: f!.id, step: this.step, seq: rec.seq, method, template: op.template, kind: fault.kind, status: fault.kind === 'status' ? fault.status : fault.kind === 'conflict' ? this.conflictStatus(op) : null });
      if (fault.kind === 'drop') return this.drop(res, rec);
      if (fault.kind === 'delay_then_drop') {
        await new Promise((r) => setTimeout(r, fault.ms));
        return this.drop(res, rec);
      }
      if (fault.kind === 'status') return this.refuse(res, rec, op, fault.status, fault.code, body, params, kind);
      if (fault.kind === 'conflict') {
        const cur = kind.collection && kind.item ? this.item(kind.collection, params) : undefined;
        const st = this.conflictStatus(op);
        return this.send(res, rec, st, this.fill(this.responseFor(op, String(st)), { bind: this.bindings(kind.collection, cur), error: { error: st === 412 ? 'precondition_failed' : 'conflict', message: 'the object changed since the version the request carried (injected by the min-mode mock)' } }));
      }
    }

    // A declared Idempotency-Key header: the same key and request replays, a different request is refused.
    const keyParam = op.params.find((p) => p.in === 'header' && p.name.toLowerCase() === 'idempotency-key');
    const key = h('idempotency-key');
    if (keyParam && key !== undefined) {
      const k = `${op.key} ${key}`;
      const fp = sha256(`${method} ${u.pathname} ${canonical(body ?? null)}`);
      const seen = this.keyed.get(k);
      if (seen) {
        if (seen.fingerprint !== fp) {
          const code = /422[^`]*`([a-z_]+)`/.exec(keyParam.description)?.[1] ?? 'idempotency_key_reused';
          return this.send(res, rec, 422, { error: code, message: 'this idempotency key was used with a different request' });
        }
        rec.replayed = true;
        rec.status = seen.status;
        const replayHeader = op.responses.some((r) => r.headers.some((x) => x.toLowerCase() === 'idempotent-replayed'));
        res.writeHead(seen.status, { ...seen.headers, ...(replayHeader ? { 'idempotent-replayed': 'true' } : {}) });
        return void res.end(seen.body);
      }
    }

    const out = this.apply(rec, op, params, kind, body);
    const text = out.body === undefined ? '' : JSON.stringify(out.body);
    const headers: Record<string, string> = { ...(text ? { 'content-type': 'application/json' } : {}), ...out.headers };
    if (keyParam && key !== undefined && out.status < 300) this.keyed.set(`${op.key} ${key}`, { fingerprint: sha256(`${method} ${u.pathname} ${canonical(body ?? null)}`), status: out.status, headers, body: text });
    rec.status = out.status;
    rec.applied = out.status >= 200 && out.status < 300 && rec.mutating;
    if (fault?.kind === 'apply_then_drop') {
      rec.status = null;
      return this.drop(res, rec);
    }
    res.writeHead(out.status, headers);
    res.end(text);
  }

  private drop(res: ServerResponse, rec: MockRecord): void {
    rec.status = null;
    res.socket?.destroy();
  }

  private send(res: ServerResponse, rec: MockRecord, status: number, body: unknown, headers: Record<string, string> = {}): void {
    rec.status = status;
    const text = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, { ...(text ? { 'content-type': 'application/json' } : {}), ...headers });
    res.end(text);
  }

  private conflictStatus(op: Operation): number {
    if (op.responses.some((r) => r.status === '412')) return 412;
    if (op.responses.some((r) => r.status === '409')) return 409;
    return 412;
  }

  private refuse(res: ServerResponse, rec: MockRecord, op: Operation, status: number, code: string, body: unknown, params: Record<string, string>, kind: OpKind): void {
    const extra: Obj = {};
    // A batch refused as a whole names the operation that stopped it: the second one (the "partial" schedule).
    const ops = batchOps(body);
    if (ops && ops.length > 1) {
      extra['index'] = 1;
      if (ops[1]!['id'] !== undefined) extra['id'] = ops[1]!['id'];
    }
    const cur = kind.collection && kind.item ? this.item(kind.collection, params) : undefined;
    this.send(res, rec, status, { ...(this.fill(this.responseFor(op, String(status)), { bind: this.bindings(kind.collection, cur), error: { error: code, message: `refused by the min-mode mock (injected ${status})` } }) as Obj), ...extra });
  }

  private responseFor(op: Operation, status: string): unknown {
    return (op.responses.find((r) => r.status === status) ?? op.responses.find((r) => r.status === 'default') ?? op.responses.find((r) => /^[45]/.test(r.status)))?.schema ?? { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } }, required: ['error', 'message'] };
  }

  private successStatus(op: Operation, create: boolean): { status: number; schema: unknown; headers: string[] } {
    const ok = op.responses.filter((r) => /^2\d\d$/.test(r.status));
    const r = (create ? ok.find((x) => x.status === '201') : undefined) ?? ok.find((x) => x.status === '200') ?? ok[0];
    return { status: r ? Number(r.status) : 200, schema: r?.schema, headers: r?.headers ?? [] };
  }

  private kindOf(op: Operation): OpKind {
    const item = this.model.collections.find((c) => c.itemPath === op.template && c.schema);
    if (item) return { kind: op.method === 'GET' ? 'read' : op.method === 'PUT' ? 'replace' : op.method === 'DELETE' ? 'delete' : op.method === 'PATCH' || op.method === 'POST' ? 'update' : 'action', collection: item, item: true };
    const coll = this.model.collections.find((c) => c.path === op.template && c.schema);
    if (coll) return { kind: op.method === 'GET' ? 'list' : op.method === 'POST' ? 'create' : 'action', collection: coll, item: false };
    return { kind: 'action', collection: null, item: false };
  }

  /** The object an item path names (nested ones through their parent). */
  private item(c: Collection, params: Record<string, string>): Obj | undefined {
    const idParam = c.itemPath ? paramName(c.itemPath.split('/').filter(Boolean).pop()!) : null;
    if (!c.parent) return idParam ? this.store.get(c.path)?.get(params[idParam]!) : undefined;
    const parent = this.parentOf(c, params);
    const arr = parent ? parent[c.parent.field] : undefined;
    return Array.isArray(arr) && idParam ? (arr as Obj[]).find((x) => String(x[c.idField]) === params[idParam]) : undefined;
  }

  private parentOf(c: Collection, params: Record<string, string>): Obj | undefined {
    const pc = c.parent ? this.collection(c.parent.path) : undefined;
    return pc ? this.item(pc, params) : undefined;
  }

  private bindings(c: Collection | null, o: Obj | undefined, extra: [Collection | null | undefined, Obj | undefined][] = []): Map<unknown, Obj> {
    const m = new Map<unknown, Obj>();
    for (const [cc, oo] of [[c, o] as [Collection | null | undefined, Obj | undefined], ...extra]) if (cc?.schema && oo) m.set(cc.schema, oo);
    return m;
  }

  private bump(c: Collection, o: Obj, before: Obj): string[] {
    const changed = Object.keys({ ...before, ...o }).filter((k) => !MANAGED.has(k) && !deepEqual(before[k], o[k]));
    if (changed.length) {
      if (this.versioned.has(c)) o['version'] = (typeof o['version'] === 'number' ? o['version'] : 0) + 1;
      for (const k of ['updated_at', 'updatedAt']) if (k in propsOf(c.schema)) o[k] = new Date().toISOString();
    }
    return changed;
  }

  /** Puts the members of a request body on an object, in the shape its schema gives (a list of names becomes children). */
  private assign(c: Collection, o: Obj, body: Obj, rec: MockRecord, create: boolean): void {
    const props = propsOf(c.schema);
    for (const [k, v] of Object.entries(body)) {
      if (MANAGED.has(k) || (k === c.idField && !create)) continue;
      const ps = props[k];
      if (!isObj(ps)) {
        rec.unknown_members.push(k);
        o[k] = clone(v);
        continue;
      }
      const child = this.model.collections.find((x) => x.parent?.path === c.path && x.parent.field === k);
      if (mainType(ps) === 'array' && Array.isArray(v) && child?.schema) {
        const nameKey = nameKeyOf(child);
        const old = Array.isArray(o[k]) ? (o[k] as Obj[]) : [];
        o[k] = v.map((x) => {
          if (isObj(x)) return { ...x, [child.idField]: x[child.idField] ?? this.newIdTyped(child) };
          const same = nameKey ? old.find((e) => e[nameKey] === x) : undefined;
          return same ?? { ...(defaultOf(child.schema) as Obj), [child.idField]: this.newIdTyped(child), ...(nameKey ? { [nameKey]: x } : {}) };
        });
      } else if (mainType(ps) === 'object' && isObj(v) && isObj(o[k])) o[k] = { ...(o[k] as Obj), ...clone(v) };
      else o[k] = clone(v);
    }
  }

  private apply(rec: MockRecord, op: Operation, params: Record<string, string>, k: OpKind, body: unknown): { status: number; body: unknown; headers: Record<string, string> } {
    const c = k.collection;
    const notFound = () => ({ status: op.responses.some((r) => r.status === '404') || !c ? 404 : 404, body: this.fill(this.responseFor(op, '404'), { error: { error: 'not_found', message: `not found: ${rec.path}` } }), headers: {} });
    const etag = (succ: { headers: string[] }, o: Obj | undefined): Record<string, string> => (o && succ.headers.some((x) => x.toLowerCase() === 'etag') && o['version'] !== undefined ? { etag: `"${String(o['version'])}"` } : {});
    if (!c || k.kind === 'action') return this.action(rec, op, body);
    const now = new Date().toISOString();
    if (k.kind === 'list') {
      let objs = c.parent ? ((this.parentOf(c, params)?.[c.parent.field] as Obj[] | undefined) ?? []) : [...(this.store.get(c.path)?.values() ?? [])];
      const props = propsOf(c.schema);
      for (const [q, v] of Object.entries(rec.query)) {
        if (q in props) objs = objs.filter((o) => String(o[q]) === v);
        else if (/_prefix$/.test(q) && q.replace(/_prefix$/, '') in props) objs = objs.filter((o) => String(o[q.replace(/_prefix$/, '')] ?? '').startsWith(v));
      }
      const succ = this.successStatus(op, false);
      return { status: succ.status, body: this.fill(succ.schema, { lists: new Map([[c.schema, objs]]) }), headers: {} };
    }
    if (k.kind === 'create') {
      if (!isObj(body)) return { status: 400, body: { error: 'bad_json', message: 'a create needs a JSON object' }, headers: {} };
      const parent = c.parent ? this.parentOf(c, params) : undefined;
      if (c.parent && !parent) return notFound();
      const requested = body[c.idField];
      if (!c.parent && requested !== undefined && this.store.get(c.path)!.has(String(requested))) {
        return { status: 409, body: this.fill(this.responseFor(op, '409'), { error: { error: 'exists', message: `${String(requested)} already exists` } }), headers: {} };
      }
      const o = defaultOf(c.schema, 0, now) as Obj;
      this.assign(c, o, body, rec, true);
      o[c.idField] = requested !== undefined && !c.parent ? requested : this.newIdTyped(c);
      if (this.versioned.has(c)) o['version'] = 1;
      const ref = { collection: c.path, id: String(o[c.idField]) };
      if (parent) {
        const before = clone(parent);
        (parent[c.parent!.field] = Array.isArray(parent[c.parent!.field]) ? parent[c.parent!.field] : []);
        (parent[c.parent!.field] as Obj[]).push(o);
        const pc = this.collection(c.parent!.path)!;
        rec.changed_fields.push(...this.bump(pc, parent, before));
        rec.effect.changed.push({ collection: pc.path, id: String(parent[pc.idField]) });
      } else this.store.get(c.path)!.set(ref.id, o);
      rec.effect.created.push(ref);
      const succ = this.successStatus(op, true);
      const pc = c.parent ? this.collection(c.parent.path) : null;
      return { status: succ.status, body: this.fill(succ.schema, { bind: this.bindings(c, o, [[pc, parent]]), created: true, changed: Object.keys(body) }), headers: etag(succ, parent ?? o) };
    }
    const o = this.item(c, params);
    if (!o) {
      if (k.kind === 'replace' && !c.parent && op.responses.some((r) => r.status === '201') && isObj(body)) {
        const n = defaultOf(c.schema, 0, now) as Obj;
        this.assign(c, n, body, rec, true);
        const idParam = paramName(c.itemPath!.split('/').filter(Boolean).pop()!);
        n[c.idField] = params[idParam]!;
        if (this.versioned.has(c)) n['version'] = 1;
        this.store.get(c.path)!.set(String(n[c.idField]), n);
        rec.effect.created.push({ collection: c.path, id: String(n[c.idField]) });
        const succ = this.successStatus(op, true);
        return { status: 201, body: this.fill(succ.schema, { bind: this.bindings(c, n), created: true }), headers: etag(succ, n) };
      }
      return notFound();
    }
    // A declared precondition header: the version it carries must be the object's (the only writer is the server).
    const ifMatch = rec.headers['if-match'];
    if (ifMatch !== undefined && ifMatch !== '*' && o['version'] !== undefined && op.responses.some((r) => r.status === '412' || r.status === '409') && ifMatch.replace(/^W\//, '').replace(/"/g, '') !== String(o['version'])) {
      const st = this.conflictStatus(op);
      return { status: st, body: this.fill(this.responseFor(op, String(st)), { bind: this.bindings(c, o), error: { error: 'precondition_failed', message: 'the version given does not match' } }), headers: {} };
    }
    const top = c.parent ? this.parentOf(c, params)! : o;
    const topC = c.parent ? this.collection(c.parent.path)! : c;
    if (k.kind === 'read') {
      const succ = this.successStatus(op, false);
      return { status: succ.status, body: this.fill(succ.schema, { bind: this.bindings(c, o, c.parent ? [[topC, top]] : []) }), headers: etag(succ, o) };
    }
    const before = clone(top);
    let changed: string[] = [];
    if (k.kind === 'delete') {
      if (c.parent) {
        top[c.parent.field] = (top[c.parent.field] as Obj[]).filter((x) => x !== o);
        changed = this.bump(topC, top, before);
        rec.changed_fields.push(...changed);
        rec.effect.changed.push({ collection: topC.path, id: String(top[topC.idField]) });
      } else this.store.get(c.path)!.delete(String(o[c.idField]));
      rec.effect.deleted.push({ collection: c.path, id: String(o[c.idField]) });
      const succ = this.successStatus(op, false);
      return { status: succ.status, body: succ.status === 204 ? undefined : this.fill(succ.schema, { bind: this.bindings(topC, top) }), headers: etag(succ, top) };
    }
    if (isObj(body)) this.assign(c, o, body, rec, false);
    changed = this.bump(topC, top, before);
    rec.changed_fields.push(...changed);
    if (changed.length) rec.effect.changed.push({ collection: topC.path, id: String(top[topC.idField]) });
    const succ = this.successStatus(op, false);
    return { status: succ.status, body: this.fill(succ.schema, { bind: this.bindings(c, o, c.parent ? [[topC, top]] : []), changed }), headers: etag(succ, top) };
  }

  /**
   * An endpoint that is not a collection. A batch (an array of operations, each with an `op` and an `id`) is applied
   * all-or-nothing to the objects it names; anything else is answered with the declared success and marked unmodelled.
   */
  private action(rec: MockRecord, op: Operation, body: unknown): { status: number; body: unknown; headers: Record<string, string> } {
    const ops = batchOps(body);
    const succ = this.successStatus(op, false);
    if (!ops) {
      rec.unmodelled = rec.mutating;
      return { status: succ.status, body: this.fill(succ.schema, {}), headers: {} };
    }
    const found: { c: Collection; o: Obj; op: Obj }[] = [];
    for (const [index, x] of ops.entries()) {
      const id = String(x['id']);
      const c = this.model.collections.find((cc) => !cc.parent && this.store.get(cc.path)?.has(id));
      if (!c) return { status: 404, body: this.fill(this.responseFor(op, '404'), { error: { error: 'not_found', message: `no object ${id}` } }) && { error: 'not_found', message: `no object ${id}`, index, id }, headers: {} };
      const o = this.store.get(c.path)!.get(id)!;
      const want = x['if_match'] ?? x['expected_version'] ?? x['version'];
      if (want !== undefined && o['version'] !== undefined && String(want) !== String(o['version'])) return { status: 412, body: { error: 'precondition_failed', message: `${id} changed`, index, id, current: clone(o) }, headers: {} };
      found.push({ c, o, op: x });
    }
    const results: Obj[] = [];
    for (const f of found) {
      const verb = String(f.op['op'] ?? f.op['action'] ?? f.op['method'] ?? '').toLowerCase();
      const id = String(f.o[f.c.idField]);
      if (/^(delete|remove|destroy)$/.test(verb)) {
        this.store.get(f.c.path)!.delete(id);
        rec.effect.deleted.push({ collection: f.c.path, id });
        results.push({ id, op: verb });
      } else {
        const set = [f.op['set'], f.op['fields'], f.op['changes'], f.op['patch'], f.op['data']].find(isObj) as Obj | undefined;
        const before = clone(f.o);
        if (set) this.assign(f.c, f.o, set, rec, false);
        const changed = this.bump(f.c, f.o, before);
        rec.changed_fields.push(...changed.filter((x) => !rec.changed_fields.includes(x)));
        if (changed.length) rec.effect.changed.push({ collection: f.c.path, id });
        results.push({ id, op: verb, version: f.o['version'], changed });
      }
    }
    const filled = this.fill(succ.schema, {}) as Obj;
    const resultsKey = Object.entries(propsOf(succ.schema)).find(([, v]) => mainType(v) === 'array')?.[0] ?? 'results';
    return { status: succ.status, body: { ...(isObj(filled) ? filled : {}), [resultsKey]: results }, headers: {} };
  }

  /** A response body from its schema, with the objects of the call bound where the schema names them. */
  fill(schema: unknown, ctx: { bind?: Map<unknown, Obj>; lists?: Map<unknown, Obj[]>; changed?: string[]; created?: boolean; error?: Obj }, depth = 0): unknown {
    if (!isObj(schema) || depth > 6) return schema === undefined ? undefined : null;
    const b = ctx.bind?.get(schema);
    if (b) return clone(b);
    const t = mainType(schema);
    const props = propsOf(schema);
    if (t === 'object' || Object.keys(props).length) {
      const req = Array.isArray(schema['required']) ? (schema['required'] as string[]) : [];
      const out: Obj = {};
      for (const [k, ps] of Object.entries(props)) {
        const bound = ctx.bind?.get(ps);
        if (bound) out[k] = clone(bound);
        else if (ctx.error && k in ctx.error) out[k] = ctx.error[k];
        else if (k === 'changed' && mainType(ps) === 'array') out[k] = ctx.changed ?? [];
        else if (k === 'created' && mainType(ps) === 'boolean') out[k] = ctx.created ?? false;
        else if (mainType(ps) === 'array' && isObj(ps) && ctx.lists?.has(ps['items'])) out[k] = clone(ctx.lists.get(ps['items']));
        else if (req.includes(k)) out[k] = mainType(ps) === 'object' ? this.fill(ps, ctx, depth + 1) : defaultOf(ps);
      }
      if (ctx.error) for (const [k, v] of Object.entries(ctx.error)) if (!(k in out)) out[k] = v;
      return out;
    }
    return defaultOf(schema);
  }

  /** Is a forwarded body valid by the description's own request schema? (`unknown` where the schema cannot be evaluated.) */
  requestValid(rec: MockRecord): true | false | 'unknown' {
    const op = this.model.operations.find((o) => o.template === rec.template && o.method === rec.method);
    if (!op || op.requestSchema === undefined) return 'unknown';
    return validates(op.requestSchema, rec.body);
  }
}

interface OpKind {
  kind: MockRecord['kind'];
  collection: Collection | null;
  item: boolean;
}

/** The array of operations in a batch body ({ops: [{op, id, ...}]}), or null. */
export function batchOps(body: unknown): Obj[] | null {
  if (!isObj(body)) return null;
  for (const v of Object.values(body)) {
    if (Array.isArray(v) && v.length && v.every((x) => isObj(x) && x['id'] !== undefined && ['op', 'action', 'method'].some((k) => typeof (x as Obj)[k] === 'string'))) return v as Obj[];
  }
  return null;
}

/** The member that names a child (a label's `name`): its first required string member that is not the identifier. */
export function nameKeyOf(c: Collection): string | null {
  const props = propsOf(c.schema);
  const req = Array.isArray(c.schema?.['required']) ? (c.schema!['required'] as string[]) : Object.keys(props);
  return req.find((k) => k !== c.idField && mainType(props[k]) === 'string' && !(isObj(props[k]) && (props[k] as Obj)['format'])) ?? null;
}
