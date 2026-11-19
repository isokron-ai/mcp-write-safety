/**
 * The resource driver: what a check does to one resource, built from the manifest only. Read an
 * object through the server's read tool (with the settle window and the ignored fields), update one
 * field through the update tool in its declared mode, and the same operations through the control
 * (the platform's own API) when the manifest describes one. It is the generic replacement for a
 * per-platform adapter: no knowledge of any backend beyond the manifest's templates.
 */

import type { ControlSpec, FieldSpec, HttpTemplate, Manifest, ResourceSpec } from './manifest.js';
import type { CallResult, Carried, HttpResult, Session } from './session.js';
import { render, templateRoots, type Env } from './template.js';
import { getPath, isObj, parsePath, setPath, sleep, WritecheckError } from './util.js';

export interface ReadResult {
  ok: boolean;
  obj: unknown;
  version: unknown;
  call: CallResult | null;
  http: HttpResult | null;
  /** How many reads it took (the settle window re-reads until the expectation holds or time is up). */
  reads: number;
  settled: boolean;
}

export class Driver {
  /** The object id under test (from the fixture or the run's own create). */
  id: unknown = null;
  /** Spec R15-4: why the object under test may be used in no later test (it could not be put back after a control); null while it may. */
  unusable: string | null = null;
  /** Spec R15-4: the restorable argument left changed on this object, for clean-up and the fixture put-back report. */
  leftChanged: { arg: string; why: string } | null = null;
  /** The field values the object is reset to between cases. */
  baseline: [unknown, unknown] | null = null;

  constructor(
    readonly session: Session,
    readonly manifest: Manifest,
    readonly res: ResourceSpec,
    readonly prefix: string,
    /** The tester's environment, for the control's base URL and credential. */
    readonly env: NodeJS.ProcessEnv,
  ) {}

  /** Fields put back through the declared control.patch because the tool under test refused the reset (N3). */
  resetViaControl = 0;

  /** The scope (container) this resource's objects are created in, when it declares one. */
  scope: unknown = null;

  vars(extra: Env = {}): Env {
    return baseVars(this.res, this.prefix, { id: this.id, scope: this.scope, ...extra });
  }

  get fields(): [FieldSpec, FieldSpec] {
    return this.res.fields!;
  }

  versionOf(obj: unknown): unknown {
    return this.res.version ? (getPath(obj, this.res.version.read) ?? null) : null;
  }

  /** One read through the read tool. */
  async readOnce(label: string, step: string, id: unknown = this.id): Promise<ReadResult> {
    const r = await this.session.call(label, this.res.read.tool, render(this.res.read.args, this.vars({ id })), { step, write: false });
    const obj = r.ok ? objectFrom(this.res, r.data, id) : null;
    return { ok: r.ok && obj !== null, obj, version: this.versionOf(obj), call: r, http: null, reads: 1, settled: true };
  }

  /**
   * Read until `until(obj)` holds or the settle window has passed; the last read is returned with
   * `settled` saying whether the expectation held. With no window, one read.
   */
  async readSettled(label: string, stepPrefix: string, until?: (obj: unknown) => boolean): Promise<ReadResult> {
    const deadline = Date.now() + this.res.read.settle_ms;
    let n = 0;
    for (;;) {
      const r = await this.readOnce(label, this.session.stepId(`${stepPrefix}.read`));
      n++;
      const holds = !until || (r.ok && until(r.obj));
      if (holds || Date.now() >= deadline) return { ...r, reads: n, settled: holds };
      await sleep(Math.max(20, Math.min(200, this.res.read.settle_ms / 10)));
    }
  }

  /** The arguments an update of one field takes, in the tool's declared mode. */
  updateArgs(field: FieldSpec, value: unknown, base: { obj: unknown; version: unknown } | null): unknown {
    const mode = this.res.update!.mode;
    if (mode === 'full_replace') {
      if (!base) throw new WritecheckError(`${this.res.name}: a full_replace update needs the object it was read from`);
      const object = setPath(base.obj, field.path, value);
      return render(this.res.update!.args, this.vars({ object, version: base.version, field: field.arg, value }));
    }
    return withOverride(this.res, render(this.res.update!.args, this.vars({ field: field.arg, value, version: base?.version ?? null })));
  }

  async update(label: string, field: FieldSpec, value: unknown, o: { step: string; base?: { obj: unknown; version: unknown } | null; paced?: boolean; counted?: boolean }): Promise<CallResult & { sent_args?: unknown }> {
    let base = o.base ?? null;
    if (!base && needsBase(this.res)) {
      const r = await this.readOnce(label, this.session.stepId(`${o.step}.base`));
      if (!r.ok) throw new WritecheckError(`${this.res.name}: could not read the object to build the update from`);
      base = { obj: r.obj, version: r.version };
    }
    const args = this.updateArgs(field, value, base);
    const sent = this.res.update!.mode === 'full_replace' && base ? { version: base.version, object: setPath(base.obj, field.path, value) } : { version: base?.version ?? null };
    const r = await this.session.call(label, this.res.update!.tool, args, { step: o.step, ...(o.paced ? { paced: true } : {}), ...(o.counted ? { counted: true } : {}) });
    // why: B-9 "How a tester uses it": same_key / same_version name the key or the version only where the call carried one; the
    // trial records which it carried, so the reading does not take them as given.
    // why: sent_args: the arguments as sent, for MWS-RES-4's echo filter (src/checks/echo.ts): a value the answer only repeats from them is no receipt.
    return { ...r, carried: carriedBy(this.res, this.res.update!.tool, args, sent), sent_args: args };
  }

  /** Put both fields back to the baseline, and check it took. */
  async reset(label = 'RESET'): Promise<boolean> {
    if (!this.baseline) return true;
    const baseline = this.baseline;
    const atBase = (o: unknown, i: number): boolean => JSON.stringify(getPath(o, this.fields[i]!.path)) === JSON.stringify(baseline[i]);
    const allAtBase = (o: unknown): boolean => this.fields.every((_, i) => atBase(o, i));
    let cur = await this.readOnce(label, this.session.stepId(`reset.${this.res.name}.read`));
    if (!cur.ok) return false;
    // why: a full_replace write carries every field from the read it was built from. Where the server applies an update
    // after answering it, a read taken just after one field's write can still show that field's old value, and the next
    // field's write would send the old value back. So every differing field goes back in one write built from one read.
    if (this.res.update!.mode === 'full_replace') {
      const differ = this.fields.map((_, i) => i).filter((i) => !atBase(cur.obj, i));
      if (!differ.length) return true;
      const last = differ[differ.length - 1]!;
      const obj = differ.slice(0, -1).reduce((o, i) => setPath(o, this.fields[i]!.path, baseline[i]), cur.obj);
      const r = await this.update(label, this.fields[last]!, baseline[last], { step: this.session.stepId(`reset.${this.res.name}.all`), base: { obj, version: cur.version } });
      // why: only a refusal falls back to one field at a time (so a field the tool refuses can go back through the control). A
      // success, or an unknown outcome (timed out, transport error, a result that is not complete), is judged by the settled read:
      // the write may have landed, and sending more writes after it could undo it.
      const refused = !r.ok && !r.timed_out && r.transport_error === null && (!r.result_type || r.result_type === 'complete');
      if (!refused) return (await this.readSettled(label, `reset.${this.res.name}.check`, allAtBase)).settled;
      cur = await this.readSettled(label, `reset.${this.res.name}.reread`);
      if (!cur.ok) return false;
    }
    for (const [i, f] of this.fields.entries()) {
      if (atBase(cur.obj, i)) continue;
      const r = await this.update(label, f, baseline[i], { step: this.session.stepId(`reset.${this.res.name}.${i}`), base: { obj: cur.obj, version: cur.version } });
      if (!r.ok) {
        // why: research builds N3: a server that refuses to take over a field another writer (the control arm) owns cannot be
        // reset through the tool under test; the tester puts its own object back through the declared control.patch instead.
        if (!this.res.control?.patch) return false;
        this.resetViaControl++;
        const c = await this.controlPatch(f, baseline[i], this.session.stepId(`reset.${this.res.name}.${i}.control`)).catch(() => null);
        if (!c?.ok) return false;
      }
      // why: the next field's write is built from this read (its version, and in full_replace mode the whole object), so it
      // waits, within the settle window, until this field shows its baseline value. The check below covers the last field.
      if (i === this.fields.length - 1) break;
      cur = await this.readSettled(label, `reset.${this.res.name}.${i}.after`, (o) => atBase(o, i));
      if (!cur.ok || !cur.settled) return false;
    }
    const after = await this.readSettled(label, `reset.${this.res.name}.check`, allAtBase);
    return after.settled;
  }

  // ───────────────────────────── control ─────────────────────────────

  get control(): ControlSpec | null {
    return this.res.control;
  }

  private controlBase(): string {
    const c = this.res.control;
    if (!c) throw new WritecheckError(`${this.res.name}: no control block`);
    const base = c.base ?? this.env[c.base_env!];
    if (!base) throw new WritecheckError(`${this.res.name}: control.base_env ${c.base_env} is not set`, 2);
    return base.replace(/\/+$/, '');
  }

  controlUrl(): string | null {
    try {
      return this.res.control ? this.controlBase() : null;
    } catch {
      return null;
    }
  }

  private authHeader(): Record<string, string> {
    const a = this.res.control?.auth;
    if (!a) return {};
    const v = this.env[a.env];
    if (v === undefined) throw new WritecheckError(`${this.res.name}: control.auth: environment variable ${a.env} is not set`, 2);
    return { [a.header]: `${a.prefix}${v}` };
  }

  async controlRequest(t: HttpTemplate, extra: Env, step: string, o: { paced?: boolean; counted?: boolean } = {}): Promise<HttpResult> {
    const env = this.vars(extra);
    const path = render(t.http[1], env) as string;
    const headers = { ...((t.headers ? render(t.headers, env) : {}) as Record<string, string>), ...this.authHeader() };
    for (const [k, v] of Object.entries(headers)) {
      if (v === null || v === undefined || v === 'null') delete headers[k];
      else headers[k] = typeof v === 'string' ? v : JSON.stringify(v);
    }
    const body = t.body === undefined ? undefined : render(t.body, env);
    return this.session.http(t.http[0], `${this.controlBase()}${path}`, headers, body, { step, ...o });
  }

  async controlRead(step: string): Promise<ReadResult> {
    const t = this.res.control?.read;
    if (!t) throw new WritecheckError(`${this.res.name}: no control.read`);
    const r = await this.controlRequest(t, {}, step);
    const obj = r.ok ? (getPath(r.body, t.object ?? '$') ?? null) : null;
    const etag = r.headers['etag'] ?? null;
    return { ok: r.ok && obj !== null, obj, version: this.res.version ? this.versionOf(obj) : etag, call: null, http: r, reads: 1, settled: true };
  }

  async controlPatch(field: FieldSpec, value: unknown, step: string, o: { paced?: boolean; counted?: boolean } = {}): Promise<HttpResult> {
    const t = this.res.control?.patch;
    if (!t) throw new WritecheckError(`${this.res.name}: no control.patch`);
    // why: writesafe self-test T3: a platform API may name the field otherwise than the read path (Strapi: summary, not data.summary).
    return this.controlRequest(t, { field: field.control_key ?? field.path, value }, step, o);
  }

  /** Create an object straight through the platform's API; returns its id (null when the answer has none). */
  async controlCreate(extra: Env, step: string): Promise<{ r: HttpResult; id: unknown }> {
    const t = this.res.control?.create;
    if (!t) throw new WritecheckError(`${this.res.name}: no control.create`);
    const r = await this.controlRequest(t, extra, step);
    const id = r.ok ? (getPath(r.body, t.id) ?? null) : null;
    return { r, id };
  }

  async controlWrite(object: unknown, version: unknown, step: string, o: { paced?: boolean; counted?: boolean } = {}): Promise<HttpResult> {
    const t = this.res.control?.write;
    if (!t) throw new WritecheckError(`${this.res.name}: no control.write`);
    return this.controlRequest(t, { object, version }, step, o);
  }
}

/** Is a control result a conflict refusal (409 or 412)? */
/**
 * What an update the driver builds carried (B-9 "How a tester uses it": same_key / same_version name the key or version only
 * where the call carried one). Each is true or false only where the tester knows it from the arguments it rendered; otherwise
 * it is left out (unknown), and the shape then gives neither held nor violated from same_key / same_version.
 *   - version: the declared version argument with a value; or a `{{version}}` anywhere in the template, rendered with a value
 *     (false where it rendered empty); or, for a whole-object write (`{{object}}`), the version at the declared read path of the
 *     object sent (unknown where it is not found there: it may be carried under another name). Where the template has neither,
 *     the call did not carry one.
 *   - key: the declared idempotency key of this tool as an argument (the driver adds none: false where the arguments lack it, and
 *     for a key in _meta); unknown where the declaration names no key for this tool.
 */
export function carriedBy(res: ResourceSpec, tool: string, args: unknown, sent: { version?: unknown; object?: unknown } = {}): Carried {
  const present = (v: unknown): boolean => v !== null && v !== undefined && v !== '';
  const at = (o: unknown, p: string): unknown => {
    try {
      return getPath(o, parsePath(p));
    } catch {
      return undefined;
    }
  };
  const roots = templateRoots(res.update?.args ?? null);
  let version: boolean | undefined;
  if (res.version?.arg && present(at(args, res.version.arg))) version = true;
  else if (roots.has('version')) version = present(sent.version);
  else if (roots.has('object')) version = res.version?.read && present(at(sent.object, res.version.read)) ? true : undefined;
  else version = false;
  const idem = res.idempotency && res.idempotency.tool === tool ? res.idempotency : null;
  const key = !idem ? undefined : 'arg' in idem.key ? present(at(args, idem.key.arg)) : false;
  return { ...(key !== undefined ? { key } : {}), ...(version !== undefined ? { version } : {}) };
}

export const isConflictStatus = (s: number | null): boolean => s === 409 || s === 412;

export const hasControl = (r: ResourceSpec, ...ops: (keyof Pick<ControlSpec, 'read' | 'patch' | 'write' | 'delete'>)[]): boolean => !!r.control && ops.every((op) => r.control![op] !== null);

export const valueAt = (obj: unknown, path: string): unknown => (isObj(obj) || Array.isArray(obj) ? getPath(obj, path) : undefined);

/** The template variables every call for this resource can use. */
export function baseVars(res: ResourceSpec, prefix: string, extra: Env = {}): Env {
  return { prefix, id: null, field: null, value: null, object: null, version: null, key: null, scope: null, marker: null, ids: null, batch: null, missing_id: res.missing_id, names_inserted: null, position: null, element_id: null, n: null, ...res.vars, ...extra };
}

/**
 * What a call of this resource reaches apart from the object it names: the tool, and its arguments rendered with the resource's
 * `vars`, every per-call variable (the id, the scope, the marker, the prefix, ...) rendered as a fixed placeholder instead.
 * Two resources whose calls have the same kind reach the same collection (`get_entry {collection: "{{col}}"}` with
 * `vars: {col: posts}` is not the one with `vars: {col: pages}`, and `{path: "posts/{{id}}"}` is not `{path: "pages/{{id}}"}`).
 * null when the arguments cannot be rendered this way (a reference to an earlier result, say): the caller then cannot tell
 * the resource apart from any other and fails closed.
 */
export function callKind(res: ResourceSpec, call: { tool: string; args: unknown }): string | null {
  // why: review B1: the kind was built from the unrendered arguments with every string holding {{id}} dropped, so two
  // collections that differ only in a vars value, or in the text around the id, were one.
  const hole = (name: string) => `\u0000{{${name}}}\u0000`;
  const env = baseVars(res, hole('prefix'));
  for (const [k, v] of Object.entries(env)) if (v === null && !Object.hasOwn(res.vars, k)) env[k] = hole(k);
  try {
    return `${call.tool}|${JSON.stringify(render(call.args, env))}`;
  } catch {
    return null;
  }
}

/**
 * Do two resources address the same collection? Their read calls, or their list calls, render alike apart from the per-call
 * variables (callKind). A generic create tool (create_item {collection}) shared by two collections does not make them one.
 */
export function sameCollection(a: ResourceSpec, b: ResourceSpec): boolean {
  if (a === b) return true;
  const rk = callKind(a, a.read);
  if (rk !== null && rk === callKind(b, b.read)) return true;
  const lk = a.list ? callKind(a, a.list) : null;
  return lk !== null && !!b.list && lk === callKind(b, b.list);
}

/** Whether every update needs the object read first: a whole-object tool, or one whose version argument is required. */
export const needsBase = (res: ResourceSpec): boolean => res.update?.mode === 'full_replace' || (!!res.version?.arg && !res.version.optional);

/** The object a read result holds: at `read.object`, or for a list read the item whose `read.match` equals the id. */
/** Does a value hold `id` as one of its scalar values (at any depth)? A number and its string form count as the same. */
export function holdsId(v: unknown, id: unknown, depth = 0): boolean {
  if (v === null || v === undefined || depth > 6) return false;
  if (typeof v !== 'object') return v === id || String(v) === String(id);
  return (Array.isArray(v) ? v : Object.values(v as Record<string, unknown>)).some((x) => holdsId(x, id, depth + 1));
}

/**
 * A mapping whose top level is an error (an `error`/`errors` key with a value) or whose message (`message`, `detail`, …) says
 * nothing was found. Other fields are data (a title "Page not found on login" is not a not-found answer).
 */
function saysNoObject(v: unknown): boolean {
  if (!isObj(v)) return false;
  return Object.entries(v).some(
    ([k, x]) =>
      (/^errors?$/i.test(k) && hasValue(x)) ||
      (/^(message|msg|detail|details|reason|result|status_?message)$/i.test(k) && typeof x === 'string' && /not[ _-]?found|no such|does not exist|doesn't exist|could not be found|cannot be found|\bno \w+ (with|for|matching)\b/i.test(x)) ||
      (/^(name|code|type|status|kind)$/i.test(k) && typeof x === 'string' && /^(not[ _-]?found|notfound|404|error)$/i.test(x)),
  );
}

/** A value that says something: not null, an empty string, an empty list or mapping, 0 or false (a skeleton answer has only those). */
function hasValue(x: unknown): boolean {
  if (x === null || x === undefined || x === '' || x === 0 || x === false) return false;
  if (Array.isArray(x)) return x.length > 0;
  if (typeof x === 'object') return Object.keys(x as object).length > 0;
  return true;
}

/** The object paths the declaration names for a resource: its fields, the name the create fills, the version, the key's varied field. */
export const declaredPaths = (res: ResourceSpec): string[] => [...new Set([...(res.fields ?? []).map((f) => f.path), res.create?.name_path, res.version?.read, res.key?.vary?.path].filter((p): p is string => typeof p === 'string' && p !== '' && p !== '$'))];

export function objectFrom(res: ResourceSpec, data: unknown, id: unknown): unknown {
  const at = getPath(data, res.read.object) ?? null;
  // why: gate-2 re-run on 169b0cb (Payload 2, the false MWS-RES-1 rows): a read by id answered with text that is not the
  // object (an empty list, "Collection: tasks / Total: 0 documents") parses as a mapping, which must not be taken for the object.
  // Re-run on 6b028ec (note 14 item 1, Grafana G13): a read by id may answer with the object without echoing the id (a v2
  // dashboard). So an answer that does not carry the id is the object only where it carries a value at one of the paths the
  // declaration names for the resource (its fields, the name, the version); an empty list or a count carries none.
  if (!res.read.items) {
    if (at === null || id === null || id === undefined || typeof at !== 'object' || holdsId(at, id)) return at;
    // why: an error body without isError (`{"error": "not found", "status": 404}`) can carry a field name the declaration uses;
    // a top-level error key or a top-level sentence that says not found is never the object.
    if (saysNoObject(data) || saysNoObject(at)) return null;
    return declaredPaths(res).some((p) => hasValue(valueAt(at, p))) ? at : null;
  }
  const items = getPath(data, res.read.items);
  if (!Array.isArray(items)) return null;
  return items.find((it) => JSON.stringify(getPath(it, res.read.match!)) === JSON.stringify(id)) ?? null;
}

/**
 * A tool whose optional version needs an explicit override where the version is left out (version.override)
 * gets the override only there: every update the tester sends without a version carries it, and the
 * version-left-out run of MWS-CONC-2 is the one call that sends neither.
 */
export function withOverride(res: ResourceSpec, args: unknown): unknown {
  const v = res.version;
  if (v?.override && v.arg && args && typeof args === 'object' && !Array.isArray(args) && (args as Record<string, unknown>)[v.arg] === undefined) return { ...(args as Record<string, unknown>), [v.override]: true };
  return args;
}

/** Does a template use the version (or the object read) a read gives? */
export const needsVersion = (args: unknown): boolean => /\{\{\s*(json:|\?)?\s*(version|object)\b/.test(JSON.stringify(args ?? null));

/**
 * The delete tool's arguments. Where the delete takes the resource's optional version and the declaration names an
 * override, a delete sent without the version carries the override (as the update does); only the version-left-out
 * run of MWS-CONC-2 sends neither.
 */
export function deleteArgs(res: ResourceSpec, vars: Record<string, unknown>, schema?: unknown): unknown {
  const args = render(res.delete!.args, vars);
  const v = res.version;
  // why: the override goes only to a delete whose input schema lists it (review: an unknown argument would be refused, and read as read-only mode working).
  const props = schema && typeof schema === 'object' ? ((schema as Record<string, unknown>)['properties'] as Record<string, unknown> | undefined) : undefined;
  if (v?.arg && v.override && props && Object.hasOwn(props, v.override) && typeof res.delete!.args === 'object' && res.delete!.args !== null && Object.hasOwn(res.delete!.args, v.arg)) return withOverride(res, args);
  return args;
}
