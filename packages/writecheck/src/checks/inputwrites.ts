/**
 * MWS-IN-1 to MWS-IN-4 (with MWS-IN-6 and MWS-IN-7) on every declared write tool that is not an update tool (B-GAP F2, B3).
 * schema.ts probes each resource's read and update tools; this check probes every other write tool the declaration names, from
 * the call the declaration gives for it, with the same probe list, the same controls and the same verdicts (schemaVerdicts).
 *
 * The base call (spec MWS-IN-1: each probe is sent in a call that is otherwise valid, after a base call that succeeded) is the
 * tool's declared call, found in this order: the resource's create, a `creates` entry, its delete, its selector (with `narrow`),
 * a `multi` entry, an `input_required` entry, the top-level `calls` entry, a `versioned` entry. Nothing is specific to a server.
 *
 *   create      a fresh name or key for every call; an accepted probe's object is read back by the id its result gives
 *   append      a scratch parent object; the created element is found by the call's marker (`creates[].find`)
 *   object      a scratch object; after any call that may have written it, the next call gets a fresh scratch object
 *   confirm     as object; an input_required answer is the tool's answer to a call it accepted (nothing is retried here)
 *   delete      a scratch object, made again whenever a call removed it
 *   multi       items of the tester's own in a container the tester created (multiGate decides whether the tool may be sent)
 *   selector    only under the operator's disposable-backend declaration (selector.send_empty_forms), with selector.narrow, and
 *               only where MWS-TGT-1 is held for the tool in this run; every call is bracketed by the bystander inventory
 *
 * Arguments never probed: the scope argument (spec 7.3, rule 1: a probe that replaces, removes or misspells it is sent only where
 * the default scope is the tester's own container), and the version argument (as on the update tool). An identifier, an element
 * id or a selector (a property whose declared value names the fixture: {{id}}, {{ids}}, {{object…}}, {{batch}}, or an id-like
 * name) is probed only under the disposable-backend declaration; on a tool that deletes or acts on several objects each such
 * call is bracketed by the bystander inventory (spec 7.3, rule 1), and a loss keeps every record of the tool from `held`.
 *
 * The counterpart control of MWS-IN-4 (spec R15-4): on a create or an append it is sent (it writes no object that existed). On a
 * tool that writes an existing object it is sent only where it equals the base call, which the declaration allows by listing the
 * argument under `inputs.<tool>.counterpart_args`: the tester then makes its base call with the counterpart's value, so the
 * counterpart control is that base call. Otherwise the probe is not judged, and the record says why.
 */

import { baseVars, Driver } from '../core/driver.js';
import { validates } from '../core/jsonschema.js';
import type { Manifest, MultiSpec, ResourceSpec } from '../core/manifest.js';
import { createVerified, idFromResult } from '../core/objects.js';
import type { CallResult } from '../core/session.js';
import { render, templateRoots, type Env } from '../core/template.js';
import { deepEqual, diff, getPath, isObj, short, withoutIgnored, type Obj } from '../core/util.js';
import type { RequirementId } from '../requirements.js';
import { result, type Result } from '../report/verdicts.js';
import { compare, inventory, type Loss } from './bystanders.js';
import { declaredWriteTools } from './coverage.js';
import { multiGate } from './multi.js';
import { carries, counterpart, ID_LIKE, in4NoCounterpart, meaningOf, probeCases, refusedBy, sameAnswer, schemaVerdicts, sendableProbe, type ProbeCase, type ProbeObs } from './schema.js';
import { listScope, newScope, scratch } from './scratch.js';
import { tgt1HeldFor, withLoss } from './targeting.js';
import { toolByName, wp, type CheckModule, type Observation, type PlanContext, type PlannedCheck, type RunContext, type Tool } from './types.js';

const ID = 'input-probes-writes';
const VERSION = '1';
const SC = { id: ID, version: VERSION };
export const IN_REQS: RequirementId[] = ['MWS-IN-1', 'MWS-IN-2', 'MWS-IN-3', 'MWS-IN-4', 'MWS-IN-6', 'MWS-IN-7'];

export type WriteKind = 'create' | 'append' | 'object' | 'confirm' | 'delete' | 'multi' | 'selector';
export interface WriteCall {
  tool: string;
  kind: WriteKind;
  args: Obj;
  /** Where in the declaration the base call comes from (stated in every record). */
  source: string;
  meta?: Record<string, unknown>;
  multi?: MultiSpec;
}

/** Template variables this check fills; a declared call that needs another is not used as a base call. */
const FILLED = new Set(['id', 'object', 'version', 'scope', 'ids', 'batch', 'marker', 'key', 'prefix', 'missing_id']);

/** A kind that writes an object that exists before the call (spec R15-4). */
export const writesExisting = (k: WriteKind): boolean => k !== 'create' && k !== 'append';
/** A kind that deletes or acts on more than one object (spec 7.3, rule 1). */
export const deletesOrBulk = (k: WriteKind): boolean => k === 'delete' || k === 'multi' || k === 'selector';

/** Spec 7.3, rule 1 and Annex E: the operator's statement that every object the server's identity can change is disposable. */
export const disposableDeclared = (m: Manifest): boolean => m.resources.some((r) => !!r.selector?.send_empty_forms);

/** The tools schema.ts probes already: each resource's read and update tools. */
function probedBySchema(m: Manifest): Set<string> {
  const s = new Set<string>();
  for (const r of m.resources) {
    s.add(r.read.tool);
    if (r.update) s.add(r.update.tool);
  }
  return s;
}

/** The write tools this check probes for a resource: the declared write tools bound to it, other than the read and update tools. */
export function writeToolsOf(m: Manifest, tools: Tool[], res: ResourceSpec): string[] {
  const first = m.resources.find((r) => r.update)?.name ?? m.resources[0]?.name;
  const skip = probedBySchema(m);
  return [...declaredWriteTools(m, tools)].filter(([t, r]) => (r === res.name || (r === '(manifest)' && res.name === first)) && !skip.has(t)).map(([t]) => t);
}

const asObj = (x: unknown): Obj => (isObj(x) ? (x as Obj) : {});

/** The declared call a write tool's probes start from (see the header for the order), or null where the declaration gives none. */
export function writeCallFor(m: Manifest, res: ResourceSpec, tool: string): WriteCall | null {
  if (res.create?.tool === tool) return { tool, kind: 'create', args: asObj(res.create.args), source: `${res.name}.create` };
  const cr = res.creates.find((c) => c.tool === tool);
  if (cr) return { tool, kind: 'append', args: asObj(cr.args), source: `${res.name}.creates (${cr.name})` };
  if (res.delete?.tool === tool) return { tool, kind: 'delete', args: asObj(res.delete.args), source: `${res.name}.delete` };
  if (res.selector?.tool === tool && res.selector.narrow) return { tool, kind: 'selector', args: { ...asObj(res.selector.args), ...asObj(res.selector.narrow) }, source: `${res.name}.selector with selector.narrow` };
  const mu = res.multi.find((x) => x.tool === tool);
  if (mu) return { tool, kind: 'multi', args: asObj(mu.args), source: `${res.name}.multi (${tool})`, multi: mu };
  const ir = res.input_required.find((x) => x.tool === tool);
  if (ir) return { tool, kind: 'confirm', args: asObj(ir.args), source: `${res.name}.input_required (${tool})`, meta: { 'io.modelcontextprotocol/clientCapabilities': ir.client_capabilities } };
  if (m.calls[tool]) return { tool, kind: 'object', args: asObj(m.calls[tool]!.args), source: `calls.${tool}` };
  const v = res.versioned.find((x) => x.tool === tool);
  if (v) return { tool, kind: 'object', args: asObj(v.args), source: `${res.name}.versioned (${tool})` };
  return null;
}

/** Why the probes of a declared call cannot be sent, or null where they may (checked at plan time and again at run time). */
export function writeCallGate(ctx: Pick<PlanContext, 'manifest' | 'tools'> & { session?: object }, res: ResourceSpec, c: WriteCall | null, tool: string): string | null {
  if (!toolByName(ctx.tools, tool)) return `${tool} is not in tools/list`;
  // why: the tenant guard and the canaries are calls the operator vouches for exactly as declared (a read, or a declared read-only
  // call that the run sends a fixed number of times); a probe would be another call, which nothing vouches for.
  if (ctx.manifest.target.guard?.tool === tool) return `${tool} is the tenant guard (target.guard); the declaration vouches only for the guard call itself, so no other call is sent to it`;
  if ((ctx.manifest.canaries ?? []).some((x) => x.tool === tool)) return `${tool} is a canary (canaries); the declaration vouches only for the canary call itself, so no other call is sent to it`;
  if (!c) return `the declaration gives no call of ${tool} that succeeds to start the probes from (a create, creates, delete, selector with narrow, multi, input_required, calls or versioned entry); spec MWS-IN-1 sends each probe in a call that is otherwise valid, after a base call that succeeded`;
  const roots = [...templateRoots(c.args)].filter((r) => !FILLED.has(r) && !Object.hasOwn(res.vars, r));
  if (roots.length) return `the declared call of ${tool} (${c.source}) uses {{${roots.join('}}, {{')}}}, which this check does not fill, so no base call was made`;
  if (!res.cleanup || res.cleanup === 'leave') return 'needs a cleanup policy (the probes create objects of the run)';
  if (c.kind !== 'create' && !res.create) return `needs a create block for ${res.name} (the probes of ${tool} act on objects of the run's own)`;
  if (c.kind === 'selector') {
    if (!res.selector!.send_empty_forms) return `${tool} chooses its objects by a selector, so every call of the test is sent only under the operator's declaration that every object is disposable (spec 7.3, rule 1; selector.send_empty_forms), which is not given`;
    if (!res.scope) return `${tool} chooses its objects by a selector and there is no container the tester can create for its objects (declare scope)`;
    if (ctx.session && !tgt1HeldFor(ctx as unknown as Pick<RunContext, 'session'>, tool)) return `MWS-TGT-1 has not been run for ${tool} with the verdict held in this run, so it is not called (spec 7.3, rule 1)`;
  }
  if (c.kind === 'multi' && ctx.session) {
    const g = multiGate(ctx as unknown as Pick<RunContext, 'session'>, res, c.multi!, 'atom');
    if (g) return g;
    if (c.multi!.effect === 'deleted' && !res.scope) return `${tool} deletes several objects, and there is no container the tester can create for them (declare scope)`;
  }
  return null;
}

/** Arguments whose declared value names the objects the call acts on (spec 7.3, rule 1: an identifier, a scope argument or a selector). */
function targetProps(c: WriteCall, res: ResourceSpec, schema: unknown): Set<string> {
  const out = new Set<string>();
  const props = isObj(schema) && isObj(schema['properties']) ? Object.keys(schema['properties'] as Obj) : [];
  for (const [k, v] of Object.entries(c.args)) {
    const r = templateRoots(v);
    if (['id', 'ids', 'object', 'batch', 'scope'].some((x) => r.has(x))) out.add(k);
    if (c.kind === 'selector' && res.selector?.narrow && Object.hasOwn(res.selector.narrow, k)) out.add(k);
  }
  for (const k of props) if (ID_LIKE.test(k) && c.kind !== 'create' && c.kind !== 'append') out.add(k);
  return out;
}

/** The arguments never probed: the scope argument and the version argument (and any argument the declaration fills with {{version}}). */
function neverProbed(c: WriteCall, res: ResourceSpec): Map<string, string> {
  const out = new Map<string, string>();
  if (res.scope) out.set(res.scope.arg, 'the scope argument (spec 7.3, rule 1: a probe that replaces, removes or misspells it is sent only where the server\'s default scope is a container the tester created)');
  if (res.version?.arg) out.set(res.version.arg, 'the version argument (as on the update tool: a probe never replaces the version)');
  for (const [k, v] of Object.entries(c.args)) if (templateRoots(v).has('version') || /\{\{\s*object\.version/.test(JSON.stringify(v))) out.set(k, 'the version argument (as on the update tool: a probe never replaces the version)');
  return out;
}

interface Fixture {
  ds: Driver[];
  scope: unknown;
  batch: string | null;
  dirty: boolean;
}

export interface WriteToolObs {
  tool: string;
  kind: WriteKind;
  source: string;
  not_probed?: string;
  protected: string[];
  /** Arguments not probed and why (scope, version, identifiers without the declaration). */
  unprobed: { arg: string; why: string }[];
  counterpart_base: string[];
  losses: Loss[];
  cut?: { sent: number; total: number };
  inventory_calls: number;
}

export const inputWritesCheck: CheckModule = {
  id: ID,
  version: VERSION,
  requirements: IN_REQS,
  plan(ctx: PlanContext, res: ResourceSpec): PlannedCheck {
    const base: PlannedCheck = { check: ID, version: VERSION, resource: res.name, runs: false, calls: [], writes: 0, creates: 0, notRun: [] };
    const calls: string[] = [];
    const nr: Result[] = [];
    let writes = 0;
    let creates = 0;
    for (const tool of writeToolsOf(ctx.manifest, ctx.tools, res)) {
      const c = writeCallFor(ctx.manifest, res, tool);
      const g = writeCallGate(ctx, res, c, tool);
      if (g) {
        nr.push(...IN_REQS.map((id) => result(id, wp(res.name, tool), SC, 'not tested', `${tool} was not probed: ${g}`)));
        continue;
      }
      const t = toolByName(ctx.tools, tool)!;
      const n = Math.min(probeCases(t.inputSchema, new Set()).length, ctx.manifest.limits.max_fuzz_cases);
      calls.push(`${tool} (${c!.kind}, from ${c!.source}): the base call, then up to ${n} probe call(s), each with its controls`);
      // the base call; per probe: a base call with the counterpart's value, the probe, the base again, the probe again, the counterpart; fixtures.
      writes += 4 + n * 7;
      creates += 2 + n * 3;
    }
    return { ...base, runs: calls.length > 0, calls, writes, creates, notRun: nr };
  },
  async collect(ctx: RunContext, res: ResourceSpec): Promise<Observation> {
    const out: ProbeObs[] = [];
    const tools: WriteToolObs[] = [];
    const label = ctx.label('INW');
    for (const tool of writeToolsOf(ctx.manifest, ctx.tools, res)) {
      const c = writeCallFor(ctx.manifest, res, tool);
      const o: WriteToolObs = { tool, kind: c?.kind ?? 'object', source: c?.source ?? '(none)', protected: [], unprobed: [], counterpart_base: [], losses: [], inventory_calls: 0 };
      tools.push(o);
      const g = writeCallGate({ ...ctx, session: ctx.session }, res, c, tool);
      if (g) {
        o.not_probed = g;
        continue;
      }
      await probeTool(ctx, res, c!, label, o, out);
    }
    return { check: ID, version: VERSION, resource: res.name, data: { probes: out, tools } };
  },
  evaluate(obs: Observation, ctx: PlanContext): Result[] {
    const res = ctx.manifest.resources.find((r) => r.name === obs.resource)!;
    const data = obs.data as { probes: ProbeObs[]; tools: WriteToolObs[] };
    return inputWritesVerdicts(data.probes ?? [], data.tools ?? [], res, ctx);
  },
};

export function inputWritesVerdicts(probes: ProbeObs[], tools: WriteToolObs[], res: ResourceSpec, ctx: PlanContext | null): Result[] {
  const out: Result[] = [];
  for (const o of tools) {
    const w = wp(res.name, o.tool);
    if (o.not_probed) {
      out.push(...IN_REQS.map((id) => result(id, w, SC, 'not tested', `${o.tool} was not probed: ${o.not_probed}`)));
      continue;
    }
    const cut = o.cut ? { [o.tool]: o.cut } : {};
    const rs = schemaVerdicts(probes.filter((p) => p.tool === o.tool), res, ctx?.tools ?? [], ctx, cut, { [o.tool]: o.protected }, [o.tool], SC);
    const notes = [
      `Base call: the declared call ${o.source} (${o.kind}); each probe was sent in a call otherwise equal to a base call that succeeded (spec MWS-IN-1).`,
      ...(o.unprobed.length ? [`Arguments not probed: ${o.unprobed.map((u) => `${u.arg} (${u.why})`).join('; ')}.`] : []),
      ...(o.counterpart_base.length ? [`Counterpart controls on ${o.counterpart_base.join(', ')}: the base call of the probe sent the counterpart's value, which the declaration allows (inputs.${o.tool}.counterpart_args), so each control equals a base call (spec R15-4).`] : []),
      ...(o.inventory_calls ? [`${o.inventory_calls} call(s) covered by spec 7.3, rule 1 were each bracketed by the bystander inventory.`] : []),
    ];
    for (const r of rs) {
      const withNotes: Result = { ...r, notes: [...r.notes, ...notes] };
      out.push(o.losses.length ? withLoss(withNotes, o.losses, false) : withNotes);
    }
  }
  return out;
}

/** Where the object shows the value an argument sets: a declared field, or a top-level member of the same name. */
function fieldPath(res: ResourceSpec, prop: string, obj: unknown): string | null {
  return res.fields?.find((f) => f.arg === prop)?.path ?? (isObj(obj) && Object.hasOwn(obj, prop) ? prop : null);
}

async function probeTool(ctx: RunContext, res: ResourceSpec, c: WriteCall, label: string, o: WriteToolObs, out: ProbeObs[]): Promise<void> {
  const tool = c.tool;
  const t = toolByName(ctx.tools, tool)!;
  const schema = t.inputSchema;
  const propsSchema = isObj(schema) && isObj(schema['properties']) ? (schema['properties'] as Obj) : {};
  const disposable = disposableDeclared(ctx.manifest);
  const declaredCp = new Set(ctx.manifest.inputs?.[tool]?.counterpart_args ?? []);
  const ign = [...res.read.ignore, ...res.server_managed, ...(res.version ? [res.version.read] : [])];
  const reader = (id: unknown): Driver => {
    const d = new Driver(ctx.session, ctx.manifest, res, ctx.prefix, ctx.env);
    d.id = id;
    d.scope = ctx.driver.scope;
    return d;
  };

  // --- fixtures -------------------------------------------------------------------------------------------------------
  const fx: Fixture = { ds: [], scope: ctx.driver.scope, batch: null, dirty: false };
  const n = c.kind === 'multi' || c.kind === 'selector' ? 2 : c.kind === 'create' ? 0 : 1;
  const own = c.kind === 'multi' || c.kind === 'selector';
  const deletes = c.kind === 'delete' || c.kind === 'selector' || (c.kind === 'multi' && c.multi!.effect === 'deleted');
  const via: 'tool' | 'control' = own && res.control?.create ? 'control' : 'tool';
  const item = async (i: number): Promise<Driver | null> => {
    const s = await scratch(ctx, res, { tag: 'iw', purpose: `MWS-IN probes of ${tool}`, label, via, scope: fx.scope, ...(fx.batch ? { marker: `${fx.batch}-${i}` } : {}) });
    return s.ok ? s.driver : null;
  };
  if (own && res.scope) {
    const s = await newScope(ctx, res, 'iwc', label);
    if (!s.ok) return void (o.not_probed = `the container for its objects could not be created (${s.reason})`);
    fx.scope = s.key;
    if (deletes) {
      const empty = await listScope(ctx, res, fx.scope, label);
      if (empty === null || empty.length) return void (o.not_probed = empty === null ? 'the new container could not be listed' : `the new container already holds ${empty.length} object(s); a tool that deletes is called only in a container that holds nothing but the tester's own objects (spec 7.3, rule 1)`);
    }
  }
  if (own) fx.batch = ctx.marker('iwb');
  for (let i = 0; i < n; i++) {
    const d = await item(i);
    if (!d) return void (o.not_probed = 'an object for the probes could not be created');
    fx.ds.push(d);
  }

  /** Read every fixture object (null: it does not read back). */
  const readAll = async (tag: string): Promise<unknown[]> => {
    const objs: unknown[] = [];
    for (const d of fx.ds) {
      const r = await d.readOnce(label, ctx.session.stepId(`inw.${tool}.${tag}`));
      objs.push(r.ok ? r.obj : null);
    }
    return objs;
  };
  /** The fixtures as the next call needs them, and the base arguments rendered from them. */
  const ensure = async (again = true): Promise<{ ok: true; base: Obj; before: unknown[]; marker: string } | { ok: false; why: string }> => {
    if (fx.dirty && (c.kind === 'object' || c.kind === 'confirm' || c.kind === 'append')) {
      const d = await item(0);
      if (!d) return { ok: false, why: 'a fresh object for the next call could not be created' };
      fx.ds[0] = d;
    }
    fx.dirty = false;
    let before = await readAll('fx');
    for (const [i, b] of before.entries()) {
      if (b !== null) continue;
      const d = await item(i);
      if (!d) return { ok: false, why: 'an object the call names could not be created again' };
      fx.ds[i] = d;
    }
    if (before.some((b) => b === null)) before = await readAll('fx2');
    if (before.some((b) => b === null)) return { ok: false, why: 'an object the call names does not read back' };
    const marker = c.kind === 'selector' ? fx.batch! : ctx.marker('iw');
    const env: Env = baseVars(res, ctx.prefix, { id: fx.ds[0]?.id ?? null, scope: fx.scope, object: before[0] ?? null, version: fx.ds[0] ? fx.ds[0].versionOf(before[0]) : null, ids: fx.ds.map((d) => d.id), batch: fx.batch, marker, key: c.kind === 'create' ? ctx.marker('iwk') : marker });
    let base: unknown;
    try {
      base = render(c.args, env);
    } catch {
      base = undefined;
    }
    if (!isObj(base) || Object.values(base).some((v) => v === undefined)) {
      // why: earlier calls can use up what the arguments name (remove_label's {{object.labels[0].id}}); a fresh object gives it back.
      if (again && n > 0 && !own) {
        fx.dirty = true;
        return ensure(false);
      }
      return { ok: false, why: `the declared arguments did not render to a complete mapping (${short(JSON.stringify(base ?? null), 120)})` };
    }
    return { ok: true, base: base as Obj, before, marker };
  };

  // --- one call ---------------------------------------------------------------------------------------------------------
  const unknownOutcome = (r: CallResult) => r.timed_out || r.transport_error !== null || (!!r.result_type && r.result_type !== 'complete');
  let lastCreated: unknown = null;
  /** Whether the next send is covered by spec 7.3, rule 1 (bracketed by the bystander inventory). */
  let covered = false;
  const send = async (args: Obj, tag: string, o2: { base?: boolean } = {}): Promise<CallResult> => {
    const step = ctx.session.stepId(`inw.${tool}.${tag}`);
    const inv0 = covered ? await inventory(ctx, res, label, { readById: true }) : null;
    let r: CallResult;
    lastCreated = null;
    if (c.kind === 'create') {
      const cr = await createVerified(ctx.session, ctx.ledger, res, ctx.prefix, { tool, args, purpose: `MWS-IN probe of ${tool} (${tag})`, label, step, ...(c.meta ? { meta: c.meta } : {}) });
      r = cr.call ?? ({ ok: false, isError: false, rpc_error: null, text: cr.reason, timed_out: false, transport_error: 'not sent', step } as unknown as CallResult);
      lastCreated = cr.id ?? (r.ok ? idFromResult(res, r) : null);
    } else r = await ctx.session.call(label, tool, args, { step, write: true, ...(c.meta ? { meta: c.meta } : {}) });
    // why: a tool that asks for a confirmation before it writes answers a call it accepted with input_required; that answer is
    // known (nothing is retried here, so nothing is written), and is the tool's acceptance of the arguments.
    if (c.kind === 'confirm' && r.result_type === 'input_required') r = { ...r, ok: true, result_type: null };
    if (inv0) {
      o.inventory_calls++;
      o.losses.push(await compare(ctx, res, label, inv0, await inventory(ctx, res, label, { readById: true }), { selector: c.kind === 'selector' }));
    }
    // why: a base call may be repeated on the same object (control (a) is sent to the object the probe went to); any other call that
    // may have written gives the next call a fresh object.
    if (!o2.base && (r.ok || unknownOutcome(r))) fx.dirty = true;
    return r;
  };
  /** Paths the call changed, per fixture object (`i:path`; `i:(gone)` for an object that no longer reads back). */
  const changed = (pre: unknown[], post: unknown[]): Set<string> => {
    const s = new Set<string>();
    pre.forEach((p, i) => {
      if (post[i] === null || post[i] === undefined) s.add(`${i}:(gone)`);
      else for (const e of withoutIgnored(diff(p, post[i]), ign)) s.add(`${i}:${e.path}`);
    });
    return s;
  };
  /** The element an append created, found by its marker through the declared find call. */
  const appended = async (marker: string): Promise<unknown> => {
    const cr = res.creates.find((x) => x.tool === tool);
    if (!cr || !fx.ds[0]) return null;
    const r = await ctx.session.call(label, cr.find.tool, render(cr.find.args, baseVars(res, ctx.prefix, { id: fx.ds[0].id, scope: fx.scope })), { step: ctx.session.stepId(`inw.${tool}.find`), write: false });
    const items = r.ok ? getPath(r.data, cr.find.items) : null;
    return Array.isArray(items) ? (items.find((x) => getPath(x, cr.find.match) === marker) ?? null) : null;
  };
  /** The object or element one create-like call made, read back (null where it cannot be found). */
  const madeBy = async (marker: string): Promise<unknown> => {
    if (c.kind === 'append') return appended(marker);
    if (lastCreated === null) return null;
    const r = await reader(lastCreated).readOnce(label, ctx.session.stepId(`inw.${tool}.made`));
    return r.ok ? r.obj : null;
  };
  /** What an accepted extra argument did, beside what the base call does (spec MWS-IN-2: the read-back). */
  const createdDiff = (a: unknown, b: unknown): string[] => withoutIgnored(diff(a, b), [...ign, ...(res.create?.name_path ? [res.create.name_path] : [])]).filter((e) => !carries(e.before, [ctx.prefix]) && !carries(e.after, [ctx.prefix]) && !(res.create?.id && (e.path === res.create.id || e.path.startsWith(`${res.create.id}.`))) && !/(^|\.)id$/.test(e.path)).map((e) => e.path);

  // --- the base call ----------------------------------------------------------------------------------------------------
  const targets = targetProps(c, res, schema);
  const never = neverProbed(c, res);
  for (const [arg, why] of never) if (Object.hasOwn(propsSchema, arg)) o.unprobed.push({ arg, why });
  if (!disposable) for (const k of targets) if (!never.has(k) && Object.hasOwn(propsSchema, k)) o.unprobed.push({ arg: k, why: 'it names the objects the call acts on (an identifier or a selector), and such a probe is sent only under the operator\'s declaration that every object is disposable (spec 7.3, rule 1)' });
  covered = c.kind === 'selector';
  const st0 = await ensure();
  if (!st0.ok) return void (o.not_probed = st0.why);
  const r0 = await send({ ...st0.base }, 'base_call', { base: true });
  if (!r0.ok) return void (o.not_probed = `the base call (the declared call with no probe) did not succeed (${short(r0.text ?? r0.rpc_error?.message ?? r0.transport_error ?? (r0.timed_out ? 'timed out' : 'error'), 160)}), so no probe would be sent in an otherwise valid call (spec R10-3)`);
  const baseMade = c.kind === 'create' || c.kind === 'append' ? await madeBy(st0.marker) : null;
  // why: two objects that the same call makes differ in fields the server sets by itself (a creation time); a second base call shows
  // which, and an extra argument's effect is judged beside them only (spec MWS-IN-2: the read-back).
  let volatile = new Set<string>();
  if (baseMade !== null) {
    const st1 = await ensure();
    if (st1.ok && (await send({ ...st1.base }, 'base_call.2', { base: true })).ok) {
      const second = await madeBy(st1.marker);
      volatile = second === null ? volatile : new Set(createdDiff(baseMade, second));
    }
  }
  const baseChange = writesExisting(c.kind) ? changed(st0.before, await readAll('base.after')) : new Set<string>();

  // --- the probes -------------------------------------------------------------------------------------------------------
  const skip = new Set<string>([...never.keys(), ...(disposable ? [] : [...targets])]);
  o.protected = [...skip].filter((k) => Object.hasOwn(propsSchema, k));
  // why: a property whose value carries the run prefix is how cleanup recognises the object a create makes (and the selector of the
  // tester's own objects): a probe sends it only a value that keeps the prefix. An identifier of an existing object is not such a name.
  const named = new Set(Object.entries(st0.base).filter(([k, v]) => carries(v, [ctx.prefix]) && (c.kind === 'create' || !targets.has(k) || c.kind === 'selector')).map(([k]) => k));
  const all = probeCases(schema, skip)
    .filter((p) => !named.has(p.prop) || (p.name === 'too_long' && typeof p.value === 'string' && p.value.length > ctx.prefix.length))
    .map((p) => (named.has(p.prop) ? { ...p, value: `${ctx.prefix}${'x'.repeat((p.value as string).length - ctx.prefix.length)}` } : p));
  const max = ctx.manifest.limits.max_fuzz_cases;
  if (all.length > max) o.cut = { sent: max, total: all.length };
  const cpSeen = new Set<string>();
  for (const p of all.slice(0, max)) {
    const value = p.drop ? '(missing)' : short(p.value, 60);
    const blank = (why: string, extra: Partial<ProbeObs> = {}): ProbeObs => ({ tool, role: 'write', prop: p.prop, name: p.name, requirement: p.requirement, value, ok: false, isError: false, rpc_error: null, text: null, step: '', not_sent: why, ...extra });
    // spec 7.3, rule 1: on a tool that deletes or acts on several objects, a probe that replaces, removes or misspells an identifier
    // or a selector is covered by the rule on a disposable backend (bracketed); on a selector tool every call is.
    covered = c.kind === 'selector' || (deletesOrBulk(c.kind) && targets.has(p.prop));
    let st = await ensure();
    if (!st.ok) {
      out.push(blank(`not sent: ${st.why}`));
      continue;
    }
    if (p.requirement !== 'MWS-IN-2') {
      const ok = sendableProbe(schema, st.base, p.prop, p.value, !!p.drop);
      if (!ok.send) {
        out.push(blank(ok.why!));
        continue;
      }
    }
    // The counterpart of the same meaning (MWS-IN-4), where the probe has one that the argument's own schema allows.
    const ps = propsSchema[p.prop];
    const cp0 = p.requirement === 'MWS-IN-1' ? counterpart(p.value, p.type, !!p.required) : null;
    const cp = cp0 && (cp0.omit || validates(ps, cp0.value) === true) ? cp0 : null;
    const trigger = !!cp && !cp.omit && writesExisting(c.kind) && !(Object.hasOwn(st.base, p.prop) && deepEqual(st.base[p.prop], cp.value));
    let viaBase = false;
    let baseNote: string | null = null;
    if (trigger && declaredCp.has(p.prop) && !targets.has(p.prop)) {
      const bp = { ...st.base, [p.prop]: cp!.value };
      if (validates(schema, bp) !== true) baseNote = `the base call with ${p.prop} = ${short(JSON.stringify(cp!.value), 40)} (the counterpart's value) does not validate against the tool's input schema`;
      else {
        const rb = await send(bp, `${p.prop}.${p.name}.base_cp`, { base: true });
        if (!rb.ok) baseNote = `the base call with ${p.prop} = ${short(JSON.stringify(cp!.value), 40)} (the counterpart's value, inputs.${tool}.counterpart_args) did not succeed (${short(rb.text ?? rb.rpc_error?.message ?? '', 120)})`;
        else {
          st = await ensure();
          if (!st.ok) {
            out.push(blank(`not sent: ${st.why}`));
            continue;
          }
          st.base[p.prop] = cp!.value;
          viaBase = true;
          if (!cpSeen.has(p.prop)) (cpSeen.add(p.prop), o.counterpart_base.push(p.prop));
        }
      }
    }
    const args: Obj = { ...st.base };
    if (p.drop) delete args[p.prop];
    else args[p.prop] = p.value;
    const r = await send(args, `${p.prop}.${p.name}`);
    const po: ProbeObs = { tool, role: 'write', prop: p.prop, name: p.name, requirement: p.requirement, value, ok: r.ok, isError: r.isError, rpc_error: r.rpc_error, text: r.text === null ? null : short(r.text, 400), step: r.step, ...(unknownOutcome(r) ? { indeterminate: true } : {}) };
    if (p.requirement === 'MWS-IN-1') Object.assign(po, { sent: p.value, type: p.type, required: !!p.required });
    if (r.ok && !po.indeterminate) await accepted(p, po, st.before, st.marker);
    if (!r.ok && !po.indeterminate) await controls(p, po, r, cp, trigger && !viaBase, baseNote, viaBase);
    out.push(po);
  }

  /** An accepted probe: the value MWS-IN-1 asks about, and the effect MWS-IN-2 asks about, from the read-back. */
  async function accepted(p: ProbeCase, po: ProbeObs, before: unknown[], marker: string): Promise<void> {
    if (p.requirement !== 'MWS-IN-1' && p.requirement !== 'MWS-IN-2') return;
    if (c.kind === 'create' || c.kind === 'append') {
      const made = await madeBy(marker);
      if (p.requirement === 'MWS-IN-2') po.effect = made === null || baseMade === null ? null : createdDiff(baseMade, made).filter((x) => !volatile.has(x));
      else {
        const path = made === null ? null : fieldPath(res, p.prop, made);
        po.meaning = path ? meaningOf(p.value, getPath(made, path), p.type ?? '', !!p.required, { known: false }) : null;
        po.meaning_steps = [po.step];
      }
      if (po.text !== null) po.text = short(po.text, 1000);
      return;
    }
    const after = await readAll(`${p.prop}.${p.name}.readback`);
    if (p.requirement === 'MWS-IN-2') {
      const ch = changed(before, after);
      po.effect = [...ch].filter((x) => !baseChange.has(x));
      if (po.text !== null) po.text = short(po.text, 1000);
      return;
    }
    const obj = after[0] ?? null;
    const path = obj === null ? null : fieldPath(res, p.prop, obj);
    po.meaning = path ? meaningOf(p.value, getPath(obj, path), p.type ?? '', !!p.required, { known: true, value: getPath(before[0], path) }) : null;
    po.meaning_steps = [po.step];
  }

  /** K9 / spec R14-6, R15-4: whether an error refuses the probed value, by the two controls. */
  async function controls(p: ProbeCase, po: ProbeObs, r: CallResult, cp: ReturnType<typeof counterpart>, blocked: boolean, baseNote: string | null, viaBase: boolean): Promise<void> {
    const by = refusedBy(r, p.prop);
    const control = async (set: { value?: unknown; omit?: boolean }, tag: string): Promise<CallResult | null> => {
      const st = await ensure();
      if (!st.ok) return null;
      const a: Obj = { ...st.base };
      if (viaBase && cp && !cp.omit) a[p.prop] = cp.value;
      if (set.omit) delete a[p.prop];
      else if ('value' in set) a[p.prop] = set.value;
      const x = await send(a, `${p.prop}.${p.name}.${tag}`, { base: tag === 'base' });
      return unknownOutcome(x) ? null : x;
    };
    const b = await control({}, 'base');
    if (!b || !b.ok) {
      po.cannot_tell = true;
      po.control = b ? 'the base call, sent again at once with its valid value, did not succeed: the call was not otherwise valid' : 'the base call could not be sent again';
      return;
    }
    if (cp && blocked) {
      po.cannot_tell = true;
      po.control = baseNote
        ? `the control with the counterpart of the same meaning (${cp.what}) was not sent: ${baseNote}`
        : `the control with the counterpart of the same meaning (${cp.what}) was not sent: ${c.tool} ${deletesOrBulk(c.kind) ? 'deletes or acts on more than one object' : 'writes an object that exists before the call'}, the counterpart would send ${p.prop} = ${short(JSON.stringify(cp.value), 40)}, a value the base call does not send, and ${targets.has(p.prop) ? `${p.prop} names the object the call acts on` : `the declaration does not list ${p.prop} under inputs.${c.tool}.counterpart_args`} (spec R15-4)`;
      return;
    }
    if (cp) {
      const r2 = await control(p.drop ? { omit: true } : { value: p.value }, 'again');
      const u = r2 ? await control(cp.omit ? { omit: true } : { value: cp.value }, 'use') : null;
      const same = r2 && u ? sameAnswer(r, u, [p.value, cp.omit ? undefined : cp.value], r2) : null;
      if (!r2 || !u || same === null) {
        po.cannot_tell = true;
        po.control = !r2 ? 'the probe could not be sent again' : !u ? 'the call with the counterpart of the same meaning could not be made' : 'two sends of the probe differed in a way the comparison cannot set aside';
      } else if (same) Object.assign(po, { ok: true, isError: false, meaning: { kind: 'keeps', why: `${cp.what} gave the same answer as the probe, so the error follows from a use the spec permits (R10-3, NF-21)` }, control: `used as ${cp.what}: the same answer` });
      else po.refused_by = by ?? `caused by the value: the base call succeeded at once, and ${cp.what} was answered differently`;
      return;
    }
    if (by) po.refused_by = by;
    else if (in4NoCounterpart() === 'rejection') po.refused_by = 'caused by the value: the base call succeeded at once; no use that keeps the meaning';
    else {
      po.cannot_tell = true;
      po.control = 'the base call succeeded at once, the probe has no counterpart of the same meaning, and the error neither names the argument nor matches a declared pattern';
    }
  }
}

