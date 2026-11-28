/**
 * Min mode: read an OpenAPI 3.x description into the small model the mock serves from. Only local `$ref`s are followed
 * (`#/...`); a remote one leaves that schema unknown, and anything the model cannot express is listed in `unexpressed`
 * so that a check touching it is `not tested`, never judged (the server is never blamed for our limit).
 *
 * The model: operations (method, path template, parameters, request and response schemas), collections inferred from
 * the paths (`/tickets` with `/tickets/{id}`, a nested `/tickets/{id}/labels/{labelId}` embedded in the parent's array
 * of the same name), and action endpoints (everything else, such as `POST /batch`).
 */

import { readFileSync } from 'node:fs';

import { parse as parseYaml } from 'yaml';

import { isObj, sha256, type Obj } from '../core/util.js';

export const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

export interface Param {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required: boolean;
  schema: unknown;
  description: string;
}

export interface Response {
  status: string;
  schema: unknown;
  headers: string[];
  description: string;
}

export interface Operation {
  key: string;
  method: string;
  template: string;
  segments: string[];
  params: Param[];
  requestSchema: unknown;
  responses: Response[];
  description: string;
}

export interface Collection {
  /** The collection path template, e.g. `/tickets` or `/tickets/{id}/labels`. */
  path: string;
  /** The item path template, e.g. `/tickets/{id}`, or null where the collection has no item path (comments). */
  itemPath: string | null;
  /** Its last literal segment (`tickets`, `labels`). */
  segment: string;
  /** The singular used for wrapper members (`ticket`, `label`). */
  singular: string;
  /** The resource schema (dereferenced), or null when the description gives none. */
  schema: Obj | null;
  /** The member that holds the identifier (`id`, `key`). */
  idField: string;
  /** The parent collection for a nested one, and the parent's array member that holds the children. */
  parent: { path: string; field: string } | null;
}

export interface ApiModel {
  title: string;
  version: string;
  sha256: string;
  operations: Operation[];
  collections: Collection[];
  /** What the model could not express, in words (each is a reason for `not tested` where a check needs it). */
  unexpressed: string[];
}

export function singular(s: string): string {
  if (/ies$/.test(s)) return s.replace(/ies$/, 'y');
  if (/(ss|sh|ch|x)es$/.test(s)) return s.replace(/es$/, '');
  if (/s$/.test(s) && !/ss$/.test(s)) return s.replace(/s$/, '');
  return s;
}

/** Dereferences local `$ref`s and merges `allOf` (object members only). Same target, same object (identity is kept). */
export class Deref {
  private cache = new Map<string, unknown>();
  readonly unknownRefs = new Set<string>();
  constructor(private readonly root: Obj) {}

  ref(ref: string): unknown {
    if (this.cache.has(ref)) return this.cache.get(ref);
    if (!ref.startsWith('#/')) {
      this.unknownRefs.add(ref);
      return undefined;
    }
    let cur: unknown = this.root;
    for (const raw of ref.slice(2).split('/')) {
      const k = decodeURIComponent(raw.replace(/~1/g, '/').replace(/~0/g, '~'));
      cur = isObj(cur) ? cur[k] : undefined;
      if (cur === undefined) break;
    }
    if (cur === undefined) {
      this.unknownRefs.add(ref);
      return undefined;
    }
    const placeholder: Obj = {};
    this.cache.set(ref, placeholder);
    const out = this.schema(cur, 0);
    // why: keep identity for recursive and repeated references (a Ticket referenced twice is the same object).
    if (isObj(out)) Object.assign(placeholder, out);
    else this.cache.set(ref, out);
    return this.cache.get(ref);
  }

  schema(s: unknown, depth: number): unknown {
    if (depth > 40 || !isObj(s)) return s;
    if (typeof s['$ref'] === 'string') return this.ref(s['$ref']);
    const out: Obj = {};
    for (const [k, v] of Object.entries(s)) {
      if (k === 'properties' && isObj(v)) out[k] = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, this.schema(pv, depth + 1)]));
      else if (k === 'items' || k === 'additionalProperties' || k === 'not') out[k] = this.schema(v, depth + 1);
      else if ((k === 'oneOf' || k === 'anyOf' || k === 'allOf') && Array.isArray(v)) out[k] = v.map((x) => this.schema(x, depth + 1));
      else out[k] = v;
    }
    if (Array.isArray(out['allOf'])) {
      const parts = out['allOf'] as unknown[];
      delete out['allOf'];
      for (const p of parts) {
        if (!isObj(p)) continue;
        for (const [k, v] of Object.entries(p)) {
          if (k === 'properties' && isObj(v)) out['properties'] = { ...(isObj(out['properties']) ? out['properties'] : {}), ...v };
          else if (k === 'required' && Array.isArray(v)) out['required'] = [...new Set([...(Array.isArray(out['required']) ? (out['required'] as string[]) : []), ...(v as string[])])];
          else if (!(k in out)) out[k] = v;
        }
      }
    }
    return out;
  }
}

const propsOf = (s: unknown): Obj => (isObj(s) && isObj(s['properties']) ? s['properties'] : {});

/** Reads a description file (JSON or YAML). */
export function loadDescription(file: string): { doc: Obj; bytes: Buffer } {
  const bytes = readFileSync(file);
  const text = bytes.toString('utf8');
  const doc = text.trimStart().startsWith('{') ? JSON.parse(text) : parseYaml(text);
  if (!isObj(doc)) throw new Error(`${file} is not an OpenAPI description (not an object)`);
  return { doc, bytes };
}

export function buildModel(doc: Obj, bytes: Buffer | string): ApiModel {
  const unexpressed: string[] = [];
  const ver = typeof doc['openapi'] === 'string' ? doc['openapi'] : typeof doc['swagger'] === 'string' ? `swagger ${doc['swagger']}` : '';
  if (!/^3\./.test(ver)) unexpressed.push(`the description is ${ver ? `version ${ver}` : 'of no stated version'}; min mode reads OpenAPI 3.x only`);
  const d = new Deref(doc);
  const info = isObj(doc['info']) ? doc['info'] : {};
  const ops: Operation[] = [];
  const paths = isObj(doc['paths']) ? doc['paths'] : {};
  const param = (p: unknown): Param | null => {
    const q = d.schema(p, 0);
    if (!isObj(q) || typeof q['name'] !== 'string') return null;
    return { name: q['name'], in: q['in'] as Param['in'], required: q['required'] === true, schema: d.schema(q['schema'], 0), description: typeof q['description'] === 'string' ? q['description'] : '' };
  };
  for (const [template, item0] of Object.entries(paths)) {
    const item = d.schema(item0, 0);
    if (!isObj(item)) continue;
    const shared = (Array.isArray(item['parameters']) ? item['parameters'] : []).map(param).filter((x): x is Param => x !== null);
    for (const m of METHODS) {
      const op = d.schema(item[m], 0);
      if (!isObj(op)) continue;
      const own = (Array.isArray(op['parameters']) ? op['parameters'] : []).map(param).filter((x): x is Param => x !== null);
      const params = [...shared.filter((s) => !own.some((o) => o.name === s.name && o.in === s.in)), ...own];
      const rb = d.schema(op['requestBody'], 0);
      const rbJson = isObj(rb) && isObj(rb['content']) ? (rb['content'] as Obj)['application/json'] : undefined;
      const requestSchema = isObj(rbJson) ? d.schema(rbJson['schema'], 0) : undefined;
      const responses: Response[] = [];
      for (const [status, r0] of Object.entries(isObj(op['responses']) ? op['responses'] : {})) {
        const r = d.schema(r0, 0);
        if (!isObj(r)) continue;
        const json = isObj(r['content']) ? (r['content'] as Obj)['application/json'] : undefined;
        responses.push({ status, schema: isObj(json) ? d.schema(json['schema'], 0) : undefined, headers: Object.keys(isObj(r['headers']) ? r['headers'] : {}), description: typeof r['description'] === 'string' ? r['description'] : '' });
      }
      ops.push({ key: `${m.toUpperCase()} ${template}`, method: m.toUpperCase(), template, segments: template.split('/').filter(Boolean), params, requestSchema, responses, description: typeof op['description'] === 'string' ? op['description'] : '' });
    }
  }
  const collections = inferCollections(ops, unexpressed);
  for (const r of d.unknownRefs) unexpressed.push(`a $ref the model cannot follow: ${r}`);
  return { title: typeof info['title'] === 'string' ? info['title'] : '', version: typeof info['version'] === 'string' ? info['version'] : '', sha256: sha256(typeof bytes === 'string' ? bytes : new Uint8Array(bytes)), operations: ops, collections, unexpressed };
}

const isParam = (s: string): boolean => /^\{[^}]+\}$/.test(s);
export const paramName = (s: string): string => s.slice(1, -1);

/** The resource schema an item or create response carries: the body itself, or its member named for the resource. */
export function resourceIn(schema: unknown, singularName: string, idCandidates: string[]): { schema: Obj; wrapper: string | null } | null {
  if (!isObj(schema)) return null;
  const props = propsOf(schema);
  for (const [k, v] of Object.entries(props)) if (k === singularName && isObj(v) && isObj(v['properties'])) return { schema: v, wrapper: k };
  // The body itself is the resource where it has a scalar identifier member (not a wrapper object of that name).
  const scalar = (c: string) => isObj(props[c]) && ['string', 'integer', 'number'].includes(String((props[c] as Obj)['type']));
  if (idCandidates.some(scalar) && Object.keys(props).length > 2) return { schema, wrapper: null };
  return null;
}

function inferCollections(ops: Operation[], unexpressed: string[]): Collection[] {
  const templates = [...new Set(ops.map((o) => o.template))];
  const byPath = new Map<string, Collection>();
  const opsAt = (t: string) => ops.filter((o) => o.template === t);
  // Collections with an item path.
  for (const t of templates) {
    const segs = t.split('/').filter(Boolean);
    const last = segs[segs.length - 1];
    if (!last || !isParam(last) || segs.length < 2) continue;
    const seg = segs[segs.length - 2]!;
    if (isParam(seg)) continue;
    const path = '/' + segs.slice(0, -1).join('/');
    const idParam = paramName(last);
    const sing = singular(seg);
    const idCandidates = [idParam, idParam.replace(/(_id|Id|ID)$/, ''), 'id'].filter(Boolean);
    let res: { schema: Obj; wrapper: string | null } | null = null;
    for (const o of [...opsAt(t), ...opsAt(path)]) {
      for (const r of o.responses) {
        if (!/^2/.test(r.status)) continue;
        res = resourceIn(r.schema, sing, idCandidates);
        if (res) break;
      }
      if (res) break;
    }
    const props = propsOf(res?.schema);
    const idField = idCandidates.find((c) => c in props) ?? (/(_id|Id)$/.test(idParam) ? 'id' : idParam);
    byPath.set(path, { path, itemPath: t, segment: seg, singular: sing, schema: res?.schema ?? null, idField, parent: null });
  }
  // Collections with no item path (POST or GET only), such as /tickets/{id}/comments.
  for (const t of templates) {
    if (byPath.has(t)) continue;
    const segs = t.split('/').filter(Boolean);
    const last = segs[segs.length - 1];
    if (!last || isParam(last) || segs.length < 3 || !isParam(segs[segs.length - 2]!)) continue;
    const sing = singular(last);
    let res: { schema: Obj; wrapper: string | null } | null = null;
    for (const o of opsAt(t)) for (const r of o.responses) if (!res && /^2/.test(r.status)) res = resourceIn(r.schema, sing, ['id']);
    byPath.set(t, { path: t, itemPath: null, segment: last, singular: sing, schema: res?.schema ?? null, idField: 'id', parent: null });
  }
  // Nesting: /tickets/{id}/labels sits in the parent collection's array member `labels`.
  for (const c of byPath.values()) {
    const segs = c.path.split('/').filter(Boolean);
    if (segs.length < 3 || !isParam(segs[segs.length - 2]!)) continue;
    const parentPath = '/' + segs.slice(0, -2).join('/');
    const parent = byPath.get(parentPath);
    if (!parent) {
      unexpressed.push(`${c.path}: nested under ${parentPath}, which is not a collection the description gives`);
      continue;
    }
    const pprops = propsOf(parent.schema);
    const f = pprops[c.segment];
    if (isObj(f) && f['type'] === 'array') {
      c.parent = { path: parentPath, field: c.segment };
      if (!c.schema && isObj(f['items'])) c.schema = f['items'] as Obj;
    } else unexpressed.push(`${c.path}: the parent resource has no array member "${c.segment}" to hold it`);
  }
  for (const c of byPath.values()) if (!c.schema) unexpressed.push(`${c.path}: no resource schema in its responses`);
  return [...byPath.values()];
}

/** Matches a concrete path against the operations; returns the operation and the path parameters. */
export function matchOperation(model: ApiModel, method: string, pathname: string): { op: Operation; params: Record<string, string> } | null {
  const segs = pathname.split('/').filter(Boolean).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  let best: { op: Operation; params: Record<string, string>; literal: number } | null = null;
  for (const op of model.operations) {
    if (op.method !== method || op.segments.length !== segs.length) continue;
    const params: Record<string, string> = {};
    let literal = 0;
    let ok = true;
    op.segments.forEach((s, i) => {
      if (!ok) return;
      if (isParam(s)) params[paramName(s)] = segs[i]!;
      else if (s === segs[i]) literal++;
      else ok = false;
    });
    if (ok && (!best || literal > best.literal)) best = { op, params, literal };
  }
  return best ? { op: best.op, params: best.params } : null;
}
