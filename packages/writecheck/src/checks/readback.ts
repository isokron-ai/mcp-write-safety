/**
 * Read-after-write: after every write, success or error, read the object back through the read tool
 * (within the settle window, with the manifest's ignored fields and the version field left out) and
 * diff it against the state before the write. Cases:
 *
 *   set_field     field 0 gets a new value      expect exactly that field to change
 *   same_value    field 0 gets its current value expect no change
 *   empty_value   field 0 gets the empty value  expect field 0 to change to it, or an error
 *   invalid_type  field 0 gets a wrong-type value expect an error and no change
 *
 * Decides MWS-UPD-1 (only named fields change; field patch and command tools), MWS-RES-1 (success
 * only when the change is in effect) and MWS-RES-2 (an error leaves nothing applied). Each candidate
 * is compared with the same write made straight to the platform's API, from the same state, when
 * the manifest declares a control: what the API also does is `platform`.
 */

import type { Carried } from '../core/session.js';
import { hasControl, valueAt, withOverride } from '../core/driver.js';
import type { ResourceSpec } from '../core/manifest.js';
import { render } from '../core/template.js';
import { deepEqual, diff, short, under, withoutIgnored, type DiffEntry } from '../core/util.js';
import { result, type Result } from '../report/verdicts.js';
import { saidBy, says } from './says.js';
import { decidedByShape, readText, outcomeShape, quoteField, reportsSuccess, shapeFallbackNote, type ShapeCapture } from './shape.js';
import { scratch } from './scratch.js';
import { ruleNote } from './rules.js';
import { notRun, res2Judge, textStatement, wp, type CheckModule, type Observation, type PlanContext, type PlannedCheck, type RunContext } from './types.js';

const ID = 'read-after-write';
const VERSION = '1';

type CaseName = 'set_field' | 'set_field_b' | 'same_value' | 'empty_value' | 'invalid_type' | 'explicit_null' | 'empty_string' | 'empty_list' | 'nested_subfield';

export interface CaseObs {
  case: CaseName;
  value: unknown;
  tool: { ok: boolean; isError: boolean; rpc_error: { code: number; message: string } | null; text: string | null; diff: DiffEntry[]; applied: boolean; settled: boolean; reads: number; steps: string[]; indeterminate?: boolean; shape?: ShapeCapture | null; carried?: Carried } | null;
  /** The control write was not accepted (not 2xx): this case has no attribution. */
  control_failed?: number | null;
  /** ignored: a 2xx control write that changed nothing for a plain set; it cannot tell a platform that drops the value from a patch the platform did not understand. */
  control: { status: number | null; diff: DiffEntry[]; applied: boolean; ignored?: boolean } | null;
  skipped?: string;
  /** The four further MWS-UPD-1 probes: the path the call named (another field than the first declared one). */
  named?: string;
  /** explicit_null: what the tool did with the named field (the spec asks the record to state it). */
  null_effect?: 'cleared' | 'kept' | 'other' | null;
  /** explicit_null: the field was set through the update tool first, so that the first read shows it set. */
  set_first?: boolean;
}

const ID_LIKE_ARG = /(^|_)(id|ids|key|version|expected_version|force|project|scope|parent)$/i;

/**
 * The four further MWS-UPD-1 probes (spec 516c4ed): an argument of the update tool whose schema allows the
 * value, each on a scratch object: explicit null, an empty string, an empty list, one sub-field of a nested
 * object whose schema declares its properties and lets the caller omit some.
 */
export function furtherProbes(schema: unknown, res: ResourceSpec): { name: CaseName; prop: string; value: unknown; named: string; alts: { prop: string; named: string }[] }[] {
  const props = schema && typeof schema === 'object' && (schema as Record<string, unknown>)['properties'] && typeof (schema as Record<string, unknown>)['properties'] === 'object' ? ((schema as Record<string, unknown>)['properties'] as Record<string, Record<string, unknown>>) : {};
  const skip = new Set<string>([...Object.keys((res.update!.args ?? {}) as object).filter((k) => !/\{\{/.test(k)), res.version?.arg ?? '', res.version?.override ?? '', res.create?.name_path?.split('.')[0] ?? '', res.key?.arg ?? '']);
  const types = (s: Record<string, unknown>): string[] => (Array.isArray(s['type']) ? (s['type'] as unknown[]).map(String) : typeof s['type'] === 'string' ? [s['type']] : []);
  const usable = Object.entries(props).filter(([k, s]) => !skip.has(k) && !ID_LIKE_ARG.test(k) && s && typeof s === 'object');
  const pathOf = (k: string) => res.fields?.find((f) => f.arg === k)?.path ?? k;
  const out: { name: CaseName; prop: string; value: unknown; named: string; alts: { prop: string; named: string }[] }[] = [];
  // why: R7-5: the explicit null is sent for a field the first read shows set; every nullable field is a candidate, chosen at the read.
  const nuls = usable.filter(([, s]) => types(s).includes('null')).map(([k]) => ({ prop: k, named: pathOf(k) }));
  if (nuls.length) out.push({ name: 'explicit_null', prop: nuls[0]!.prop, value: null, named: nuls[0]!.named, alts: nuls });
  const str = usable.find(([, s]) => types(s).includes('string') && !Array.isArray(s['enum']) && !(typeof s['minLength'] === 'number' && s['minLength'] > 0) && typeof s['pattern'] !== 'string');
  if (str) out.push({ name: 'empty_string', prop: str[0], value: '', named: pathOf(str[0]), alts: [] });
  const arr = usable.find(([, s]) => types(s).includes('array') && !(typeof s['minItems'] === 'number' && s['minItems'] > 0));
  if (arr) out.push({ name: 'empty_list', prop: arr[0], value: [], named: pathOf(arr[0]), alts: [] });
  const obj = usable.find(([, s]) => types(s).includes('object') && s['properties'] && typeof s['properties'] === 'object' && Object.keys(s['properties'] as object).length > 1 && (!Array.isArray(s['required']) || (s['required'] as unknown[]).length < Object.keys(s['properties'] as object).length));
  if (obj) {
    const sub = Object.entries(obj[1]['properties'] as Record<string, Record<string, unknown>>).find(([k]) => !Array.isArray(obj[1]['required']) || !(obj[1]['required'] as string[]).includes(k)) ?? Object.entries(obj[1]['properties'] as Record<string, Record<string, unknown>>)[0]!;
    const t = types(sub[1])[0];
    const v = Array.isArray(sub[1]['enum']) ? sub[1]['enum'][0] : t === 'integer' || t === 'number' ? 1 : t === 'boolean' ? true : 'mwsc';
    out.push({ name: 'nested_subfield', prop: obj[0], value: { [sub[0]]: v }, named: `${pathOf(obj[0])}.${sub[0]}`, alts: [] });
  }
  return out;
}

const isObjValue = (v: unknown): boolean => !!v && typeof v === 'object' && !Array.isArray(v);
/** N2: an object-typed argument the object read does not carry as an object is a wrapper (or unset), not a nested field. */
export const wrapperArg = (obj: unknown, res: ResourceSpec, prop: string): boolean => !isObjValue(valueAt(obj, res.fields?.find((f) => f.arg === prop)?.path ?? prop));

const clip = (v: unknown): unknown => (v === undefined ? undefined : (JSON.stringify(v)?.length ?? 0) <= 200 ? v : short(v, 120));
const brief = (d: DiffEntry[]): DiffEntry[] => d.slice(0, 20).map((e) => ({ path: e.path, kind: e.kind, before: clip(e.before), after: clip(e.after) }));

/** An empty write reads back as empty if the server stores "", null or drops the key. */
export const emptyLike = (got: unknown, sent: unknown): boolean => deepEqual(got, sent) || ((sent === '' || sent === null) && (got === '' || got === null || got === undefined));

// why: Action CI SH-5: a path in read.ignore that is also the version path is listed once.
export const ignoredPaths = (res: ResourceSpec): string[] => [...new Set([...res.read.ignore, ...(res.version ? [res.version.read] : [])])];

/** A declared MWS-RES-1 case: an update with the case's arguments, and whether what it asks for is in effect afterwards. */
export interface DeclaredCase {
  name: string;
  call: { ok: boolean; isError: boolean; text: string | null; indeterminate: boolean; step: string; shape?: ShapeCapture | null; carried?: Carried } | null;
  /** Each expected path that did not read back as expected (path, expected, got). */
  missing: { path: string; expected: unknown; got: unknown }[];
  /** What the case asked for (path: value), for its MWS-RES-2 trial (validator on 59e3124, finding 7); absent in older evidence. */
  expect?: Record<string, unknown>;
  skipped?: string;
}

/** The update tool's arguments without the {{field}}/{{value}} pair, plus a case's own arguments. */
export function caseArgs(res: ResourceSpec, vars: Record<string, unknown>, extra: Record<string, unknown>): Record<string, unknown> {
  const base: Record<string, unknown> = {};
  for (const [k, v] of Object.entries((res.update!.args ?? {}) as Record<string, unknown>)) if (!/\{\{\s*(field|value)\s*\}\}/.test(k) && !/\{\{\s*(field|value)\s*\}\}/.test(JSON.stringify(v))) base[k] = v;
  return withOverride(res, render({ ...base, ...extra }, vars)) as Record<string, unknown>;
}

export const readbackCheck: CheckModule = {
  id: ID,
  version: VERSION,
  needsUpdate: true,
  requirements: ['MWS-UPD-1', 'MWS-RES-1', 'MWS-RES-2'],
  plan(ctx: PlanContext, res: ResourceSpec): PlannedCheck {
    const w = wp(res.name, res.update!.tool);
    const base: PlannedCheck = { check: ID, version: VERSION, resource: res.name, runs: false, calls: [], writes: 0, creates: 0, notRun: [] };
    const f0 = res.fields![0];
    const cases = ['set_field', 'set_field_b', 'same_value', ...(f0.empty !== null ? ['empty_value'] : []), ...(f0.invalid !== null ? ['invalid_type'] : [])];
    const ctl = hasControl(res, 'read', 'patch');
    const nr: Result[] = [];
    const further4 = res.update!.mode !== 'full_replace' && res.create && res.cleanup && res.cleanup !== 'leave' ? furtherProbes(ctx.tools.find((t) => t.name === res.update!.tool)?.inputSchema, res) : [];
    if (res.update!.mode === 'full_replace') nr.push(...notRun(this, ['MWS-UPD-1'], w, 'not applicable', `${res.update!.tool} is declared full_replace: a whole-object write is judged by MWS-CONC-2, not by "only named fields change"`));
    return {
      ...base,
      runs: true,
      calls: [...cases.map((c) => `${c}: reset; ${res.read.tool}; ${res.update!.tool} ${f0.path}; ${res.read.tool}${ctl && c !== 'invalid_type' ? `; then the same through the control from the same state` : ''}`), ...res.update!.cases.map((c) => `declared case ${c.name}: reset; ${res.update!.tool} with its arguments; ${res.read.tool} (MWS-RES-1)`), ...further4.map((p) => `${p.name} (${p.prop}): a scratch object; ${res.read.tool}; ${res.update!.tool} ${p.prop}=${JSON.stringify(p.value)}; ${res.read.tool}`)],
      writes: cases.length * (3 + (ctl ? 3 : 0)) + res.update!.cases.length * 3 + further4.length * 2,
      creates: further4.length,
      notRun: nr,
    };
  },
  async collect(ctx: RunContext, res: ResourceSpec): Promise<Observation> {
    const d = ctx.driver;
    const f0 = res.fields![0];
    const ign = ignoredPaths(res);
    const ctl = hasControl(res, 'read', 'patch');
    const out: CaseObs[] = [];
    // why: spec MWS-UPD-1 "Repeat for each declared field": the second field is set alone too (gate-2 Grafana item 2).
    const f1 = res.fields![1];
    const cases: { name: CaseName; value: unknown; expectChange: boolean; field?: typeof f0 }[] = [
      { name: 'set_field', value: f0.values[1], expectChange: true },
      { name: 'set_field_b', value: f1.values[1], expectChange: true, field: f1 },
      { name: 'same_value', value: f0.values[0], expectChange: false },
      ...(f0.empty !== null ? [{ name: 'empty_value' as const, value: f0.empty.value, expectChange: true }] : []),
      ...(f0.invalid !== null ? [{ name: 'invalid_type' as const, value: f0.invalid.value, expectChange: false }] : []),
    ];
    const label = ctx.label('RB');
    for (const c of cases) {
      const cf = c.field ?? f0;
      const o: CaseObs = { case: c.name, value: c.value, tool: null, control: null, ...(c.field ? { named: cf.path } : {}) };
      if (!(await d.reset())) {
        o.skipped = 'the object could not be reset to the baseline';
        out.push(o);
        continue;
      }
      const before = await d.readSettled(label, `rb.${c.name}.before`);
      if (!before.ok) {
        o.skipped = 'the object did not read back before the write';
        out.push(o);
        continue;
      }
      const step = ctx.session.stepId(`rb.${res.name}.${c.name}.write`);
      const r = await d.update(label, cf, c.value, { step, base: { obj: before.obj, version: before.version } });
      const isSet = (obj: unknown) => (c.name === 'empty_value' ? emptyLike(valueAt(obj, cf.path), c.value) : deepEqual(valueAt(obj, cf.path), c.value));
      const after = await d.readSettled(label, `rb.${c.name}.after`, r.ok && c.expectChange ? isSet : () => false);
      // why: any failed read-back (not only a timeout) says nothing about the write; the case is set aside, never judged.
      const unknown = r.timed_out || r.transport_error !== null || !after.ok || (!!r.result_type && r.result_type !== 'complete');
      const dd = after.ok ? withoutIgnored(diff(before.obj, after.obj), ign) : [];
      o.tool = { ok: r.ok, isError: r.isError, rpc_error: r.rpc_error, text: readText(r) === null ? null : short(readText(r)!, 4000), diff: brief(dd), applied: after.ok && isSet(after.obj), settled: after.settled, reads: after.reads, steps: [before.call?.step, step, after.call?.step].filter((s): s is string => !!s), ...(unknown ? { indeterminate: true } : {}), ...(r.shape ? { shape: r.shape } : {}), ...(r.carried ? { carried: r.carried } : {}) };
      if (ctl && c.name !== 'invalid_type') {
        if (await d.reset()) {
          const b2 = await d.controlRead(ctx.session.stepId(`rb.${c.name}.ctl.before`));
          const p = await d.controlPatch(cf, c.value, ctx.session.stepId(`rb.${c.name}.ctl.write`));
          const a2 = await d.controlRead(ctx.session.stepId(`rb.${c.name}.ctl.after`));
          const d2 = b2.ok && a2.ok ? withoutIgnored(diff(b2.obj, a2.obj), ign) : [];
          const applied = b2.ok && a2.ok ? (c.name === 'empty_value' ? emptyLike(valueAt(a2.obj, cf.path), c.value) : deepEqual(valueAt(a2.obj, cf.path), c.value)) : false;
          // why: a 2xx control write that changed nothing for a plain set is either the platform dropping the value or a patch it did not
          // understand; it is kept, marked, and used for neither platform nor server (CLI-BUGS item 12; review).
          if (p.ok && b2.ok && a2.ok) o.control = { status: p.status, diff: brief(d2), applied, ...((c.name === 'set_field' || c.name === 'set_field_b') && !applied && d2.length === 0 ? { ignored: true } : {}) };
          else o.control_failed = p.status;
        }
      }
      out.push(o);
    }
    // The cases the declaration adds (MWS-RES-1): each from the baseline, read back within the settle window.
    const declared: DeclaredCase[] = [];
    for (const dc of res.update!.cases) {
      const rec: DeclaredCase = { name: dc.name, call: null, missing: [] };
      declared.push(rec);
      if (!(await d.reset())) {
        rec.skipped = 'the object could not be reset to the baseline';
        continue;
      }
      const vars = d.vars();
      const args = caseArgs(res, vars, dc.args);
      const expect = render(dc.expect, vars) as Record<string, unknown>;
      const step = ctx.session.stepId(`rb.case.${dc.name}`);
      const r = await ctx.session.call(label, res.update!.tool, args, { step });
      rec.call = { ok: r.ok, isError: r.isError, text: readText(r) === null ? null : short(readText(r)!, 4000), indeterminate: r.timed_out || r.transport_error !== null, step, ...(r.shape ? { shape: r.shape } : {}), ...(r.carried ? { carried: r.carried } : {}) };
      const holds = (o: unknown) => Object.entries(expect).every(([p, v]) => emptyLike(valueAt(o, p), v));
      const after = await d.readSettled(label, `rb.case.${dc.name}.after`, r.ok ? holds : () => false);
      if (!after.ok || rec.call.indeterminate) {
        rec.skipped = 'the object did not read back after the call';
        continue;
      }
      rec.expect = Object.fromEntries(Object.entries(expect).map(([p, v]) => [p, clip(v)]));
      rec.missing = Object.entries(expect).filter(([p, v]) => !emptyLike(valueAt(after.obj, p), v)).map(([p, v]) => ({ path: p, expected: clip(v), got: clip(valueAt(after.obj, p)) }));
    }
    // The four further probes, each on a scratch object (they write fields the reset does not put back).
    if (res.update!.mode !== 'full_replace' && res.create && res.cleanup && res.cleanup !== 'leave') {
      const schema = ctx.tools.find((t) => t.name === res.update!.tool)?.inputSchema;
      for (const p of furtherProbes(schema, res)) {
        const o: CaseObs = { case: p.name, value: p.value, tool: null, control: null, named: p.named };
        out.push(o);
        const sc0 = await scratch(ctx, res, { tag: `u1${p.name.slice(0, 2)}`, purpose: `MWS-UPD-1 ${p.name}`, label });
        if (!sc0.ok) {
          o.skipped = `scratch object: ${sc0.reason}`;
          continue;
        }
        const dd0 = sc0.driver!;
        let before = await dd0.readSettled(label, `rb.${p.name}.before`);
        if (!before.ok) {
          o.skipped = 'the object did not read back before the write';
          continue;
        }
        // why: research builds N2: an object-typed argument that the object read does not carry is not a stored field (a wrapper
        // such as `data`, whose members are the document's fields); writing a member through it is not a nested sub-field.
        if (p.name === 'nested_subfield' && wrapperArg(before.obj, res, p.prop)) {
          o.skipped = `${p.prop} is not a field the object read carries as an object (a wrapper argument, or not set), so a sub-field of it cannot be named`;
          continue;
        }
        if (p.name === 'explicit_null') {
          // why: R7-5: the explicit null is sent for a field that the first read shows set. Where no nullable field is set on the
          // scratch object, one that is a declared field is set first through the update tool (its first declared value).
          const isSet = (obj: unknown, path: string) => { const v = valueAt(obj, path); return v !== null && v !== undefined; };
          let pick = p.alts.find((a) => isSet(before.obj, a.named));
          if (!pick) {
            const decl = p.alts.map((a) => ({ a, f: res.fields!.find((f) => f.arg === a.prop) })).find((x) => x.f);
            if (decl) {
              const w0 = await dd0.update(label, decl.f!, decl.f!.values[0], { step: ctx.session.stepId(`rb.${p.name}.set`), base: { obj: before.obj, version: before.version } });
              const b2 = w0.ok ? await dd0.readSettled(label, `rb.${p.name}.before2`, (x) => isSet(x, decl.a.named)) : null;
              if (b2?.ok && isSet(b2.obj, decl.a.named)) {
                before = b2;
                pick = decl.a;
                o.set_first = true;
              }
            }
          }
          if (!pick) {
            o.skipped = `no field the schema lets be null (${p.alts.map((a) => a.prop).join(', ')}) is set on the scratch object, and none could be set first (the explicit null is sent for a field the first read shows set)`;
            continue;
          }
          p.prop = pick.prop;
          p.named = pick.named;
          o.named = pick.named;
        }
        const step = ctx.session.stepId(`rb.${res.name}.${p.name}.write`);
        const r = await ctx.session.call(label, res.update!.tool, caseArgs(res, dd0.vars({ version: before.version }), { [p.prop]: p.value }), { step });
        const after = await dd0.readSettled(label, `rb.${p.name}.after`, () => false);
        const unknown = r.timed_out || r.transport_error !== null || !after.ok || (!!r.result_type && r.result_type !== 'complete');
        const dd = after.ok ? withoutIgnored(diff(before.obj, after.obj), ign) : [];
        o.tool = { ok: r.ok, isError: r.isError, rpc_error: r.rpc_error, text: readText(r) === null ? null : short(readText(r)!, 4000), diff: brief(dd), applied: false, settled: after.settled, reads: after.reads, steps: [before.call?.step, step, after.call?.step].filter((x): x is string => !!x), ...(unknown ? { indeterminate: true } : {}), ...(r.shape ? { shape: r.shape } : {}), ...(r.carried ? { carried: r.carried } : {}) };
        if (p.name === 'explicit_null' && after.ok && r.ok) {
          const now = valueAt(after.obj, p.named);
          o.null_effect = now === null || now === undefined ? 'cleared' : deepEqual(now, valueAt(before.obj, p.named)) ? 'kept' : 'other';
        }
      }
    }
    await d.reset();
    return { check: ID, version: VERSION, resource: res.name, data: { cases: out, declared } };
  },
  evaluate(obs: Observation, ctx: PlanContext): Result[] {
    const res = ctx.manifest.resources.find((r) => r.name === obs.resource)!;
    const data = obs.data as { cases: CaseObs[]; declared?: DeclaredCase[] };
    return readbackVerdicts(data.cases, res, data.declared ?? [], ctx.manifest.async_operations ?? []);
  },
};

export function readbackVerdicts(cases: CaseObs[], res: ResourceSpec, declared: DeclaredCase[] = [], asyncOps: string[] = []): Result[] {
  const w = wp(res.name, res.update!.tool);
  const sc = { id: ID, version: VERSION };
  const f0 = res.fields![0].path;
  /** The update tool's answer as the shape reader takes it (an adopted result shape is per tool). */
  const carrier = (shape: ShapeCapture | null | undefined) => ({ tool: res.update!.tool, shape: shape ?? null, text: null, data: null });
  /** What a case's answer says, for a declared pattern (rule 11, point 13). */
  const said = (t: { text: string | null; shape?: ShapeCapture | null }) => ({ tool: res.update!.tool, text: t.text, data: null, shape: t.shape ?? null });
  const namedIn = (c: CaseObs) => (e: { path: string }) => under(e.path, c.named ?? f0);
  const out: Result[] = [];
  // why: a write whose outcome the client does not know is neither a success nor an error; it is set aside.
  const ran = cases.filter((c) => c.tool && !c.tool.indeterminate);
  const skipped = [...cases.filter((c) => c.skipped).map((c) => `${c.case}: ${c.skipped}`), ...cases.filter((c) => c.tool?.indeterminate).map((c) => `${c.case}: outcome unknown to the client (timeout or broken connection); not judged`), ...cases.filter((c) => c.control_failed !== undefined).map((c) => `${c.case}: the control write was not accepted (HTTP ${c.control_failed ?? 'none'}), so this case has no attribution`)];
  // MWS-UPD-1
  if (res.update!.mode !== 'full_replace') {
    const own: string[] = [];
    const shared: string[] = [];
    const steps: string[] = [];
    let judged = 0;
    let ownCtl = true;
    for (const c of ran) {
      if (!c.tool!.ok || c.case === 'invalid_type') continue;
      judged++;
      const named = namedIn(c);
      const unexpected = c.tool!.diff.filter((e) => !named(e));
      const inApi = (e: { path: string; kind: string }) => !!c.control && c.control.diff.some((f) => f.path === e.path && f.kind === e.kind);
      for (const e of unexpected) (inApi(e) ? shared : own).push(`${c.case}: ${e.path} (${e.kind})`);
      if (unexpected.some((e) => !inApi(e))) {
        steps.push(...c.tool!.steps);
        // why: the attribution is server only where every case that shows the violation had a control arm (rule 3).
        if (!c.control || c.control.ignored) ownCtl = false;
      }
    }
    if (own.length) out.push(result('MWS-UPD-1', w, sc, 'violated', `A successful ${res.update!.tool} changed fields its arguments did not name: ${own.join('; ')}.${ran.some((c) => c.control) ? ' The same write through the platform\'s API does not.' : ''}`, { numbers: { cases_judged: judged }, steps, attribution: ownCtl ? 'server' : 'unresolved' }));
    else if (shared.length) out.push(result('MWS-UPD-1', w, sc, 'platform', `Fields the write did not name changed, and the platform's API changes them too: ${shared.join('; ')}.`, { numbers: { cases_judged: judged }, notes: [ruleNote('PLATFORM_PASSTHROUGH', 'the API does the same')] }));
    else if (judged) out.push(result('MWS-UPD-1', w, sc, 'held', `In ${judged} successful write(s), each changed only the field it named (${[...new Set(ran.filter((c) => c.tool!.ok && c.case !== 'invalid_type').map((c) => c.named ?? f0))].join(', ')}; ignored: ${ignoredPaths(res).join(', ') || 'none'}).`, { numbers: { cases_judged: judged }, notes: [...skipped, ...further(cases, res)] }));
    else out.push(result('MWS-UPD-1', w, sc, 'not tested', `no successful write to judge${skipped.length ? ` (${skipped.join('; ')})` : ''}`));
  }
  // MWS-RES-1
  {
    const bad: string[] = [];
    const plat: string[] = [];
    const steps: string[] = [];
    let judged = 0;
    let res1Unresolved = false;
    const nf19: string[] = [];
    const shapeNotes: string[] = [];
    for (const c of ran) {
      if (!c.tool!.ok || (c.case !== 'set_field' && c.case !== 'set_field_b' && c.case !== 'empty_value')) continue;
      // why: rule 11: a result without isError whose adopted shape says the write was not applied (or not known) does not report
      // success; it is judged under MWS-RES-2 (third clause), not here.
      const sh = outcomeShape(carrier(c.tool!.shape));
      if (sh && sh.outcome === 'accepted' && asyncOps.includes(res.update!.tool) && !c.tool!.applied) {
        nf19.push(`${c.case}: ${decidedByShape([['outcome', 'accepted']], carrier(c.tool!.shape))} The declaration lists ${res.update!.tool} as completed asynchronously (NF-19), so this call adds no verdict.`);
        continue;
      }
      // why: rule 11, point 13 (R14-5): a text that reports success by a declared patterns.applied is a report of success of its
      // own, beside a shape that says otherwise; where the write is not in effect it is judged here, and the shape does not repair it.
      const saysDone = sh && !reportsSuccess(sh, asyncOps.includes(res.update!.tool)) && !c.tool!.applied ? textStatement(said(c.tool!), 'applied') : null;
      if (sh && !reportsSuccess(sh, asyncOps.includes(res.update!.tool)) && !saysDone) {
        shapeNotes.push(`${c.case}: the result has no isError, and its adopted result shape says ${quoteField('outcome', sh.outcome)}: not a report of success, so it is judged under MWS-RES-2.`);
        continue;
      }
      if (saysDone) shapeNotes.push(`${c.case}: its adopted result shape says ${quoteField('outcome', sh!.outcome)}, and its text reports success: ${saysDone} (rule 11, point 13: a false statement in the text gives its verdict beside the shape).`);
      if (sh) shapeNotes.push(`${c.case}: ${decidedByShape([['outcome', sh.outcome], ...(sh.changed ? [['changed', sh.changed] as [string, unknown]] : [])], carrier(c.tool!.shape))}`);
      else if (shapeFallbackNote(carrier(c.tool!.shape))) shapeNotes.push(`${c.case}: ${shapeFallbackNote(carrier(c.tool!.shape))}`);
      // why: NF-19: a declared asynchronous operation that says it was accepted or is pending, and is not in effect, gives no verdict.
      if (!c.tool!.applied && asyncOps.includes(res.update!.tool) && says('accepted', c.tool!.text ?? '')) {
        nf19.push(`${c.case}: ${saidBy('accepted', c.tool!.text ?? '')} The declaration lists ${res.update!.tool} as completed asynchronously (NF-19), so this call adds no verdict.`);
        continue;
      }
      judged++;
      if (c.tool!.applied) continue;
      const claim = sh ? ` (its adopted result shape says ${quoteField('outcome', sh.outcome)}${sh.changed ? `, ${quoteField('changed', sh.changed)}` : ''})` : '';
      // why: R7-5: platform needs the platform API's own answer to say that the change was made, not only that it was accepted (202).
      if (c.control && !c.control.applied && !c.control.ignored && c.control.status !== 202) plat.push(c.case);
      else {
        bad.push(`${c.case} (${short(c.value, 40)})${claim}`);
        steps.push(...c.tool!.steps);
        // why: server only where this case's control arm applied the same write (rule 3).
        if (!(c.control && c.control.applied)) res1Unresolved = true;
      }
    }
    for (const dc of declared) {
      if (!dc.call || dc.skipped || dc.call.indeterminate || !dc.call.ok) continue;
      const sh = outcomeShape(carrier(dc.call.shape));
      const saysDone = sh && !reportsSuccess(sh, asyncOps.includes(res.update!.tool)) && dc.missing.length ? textStatement({ tool: res.update!.tool, text: dc.call.text, data: null, shape: dc.call.shape ?? null }, 'applied') : null;
      if (sh && !reportsSuccess(sh, asyncOps.includes(res.update!.tool)) && !saysDone) {
        shapeNotes.push(`declared case ${dc.name}: the result has no isError, and its adopted result shape says ${quoteField('outcome', sh.outcome)}: not a report of success, so it adds no verdict here.`);
        continue;
      }
      if (saysDone) shapeNotes.push(`declared case ${dc.name}: its adopted result shape says ${quoteField('outcome', sh!.outcome)}, and its text reports success: ${saysDone} (rule 11, point 13).`);
      if (sh) shapeNotes.push(`declared case ${dc.name}: ${decidedByShape([['outcome', sh.outcome], ...(sh.changed ? [['changed', sh.changed] as [string, unknown]] : [])], carrier(dc.call.shape))}`);
      judged++;
      if (dc.missing.length) {
        bad.push(`${dc.name} (${dc.missing.map((m) => `${m.path} is ${short(m.got, 30)}, asked ${short(m.expected, 30)}`).join('; ')})${sh ? ` (its adopted result shape says ${quoteField('outcome', sh.outcome)}${sh.changed ? `, ${quoteField('changed', sh.changed)}` : ''})` : ''}`);
        steps.push(dc.call.step);
        res1Unresolved = true;
      }
    }
    if (bad.length) out.push(result('MWS-RES-1', w, sc, 'violated', `${res.update!.tool} reported success but what it was asked for is not in effect (re-read within the settle window of ${res.read.settle_ms} ms): ${bad.join(', ')}.`, { numbers: { cases_judged: judged }, steps, attribution: res1Unresolved ? 'unresolved' : 'server', notes: [ruleNote('SETTLE_WINDOW', 'reads were repeated until the window closed'), ...shapeNotes, ...(ran.some((c) => c.control?.ignored) ? ['A control write answered 2xx and changed nothing; it cannot tell a platform that drops the value from a patch the platform did not understand, so it decides neither platform nor server.'] : [])] }));
    else if (plat.length) out.push(result('MWS-RES-1', w, sc, 'platform', `Success without the change for ${plat.join(', ')}, and the platform's API also ignores it.`, { numbers: { cases_judged: judged }, notes: [ruleNote(plat.includes('empty_value') ? 'EMPTY_NOOP_CONTROL' : 'PLATFORM_PASSTHROUGH', 'the API does the same')] }));
    else if (judged) out.push(result('MWS-RES-1', w, sc, 'held', `Every write that reported success (${judged}) was in effect on re-read.`, { numbers: { cases_judged: judged }, notes: [...skipped, ...nf19, ...shapeNotes] }));
    else out.push(result('MWS-RES-1', w, sc, 'not tested', nf19.length ? 'every write that reported success was a declared asynchronous operation said to be accepted or pending (NF-19)' : 'no write reported success', { notes: [...nf19, ...shapeNotes] }));
  }
  // MWS-RES-2
  {
    // why: rule 11: a result without isError whose adopted shape says the write was not applied, or not known, is a trial of the third clause.
    // why: rule 11, point 13 (R14-5): beside a shape that reports success, a text that says by a declared patterns.not_applied that
    // the write failed, while a change stayed, is a trial too; the text is read on its own and the shape does not repair it.
    const saysFailed = (c: CaseObs): boolean => { const sh = outcomeShape(carrier(c.tool!.shape)); return !!sh && (['not_applied', 'partial', 'unknown'].includes(sh.outcome) || (c.tool!.diff.length > 0 && textStatement(said(c.tool!), 'not_applied', { trial: true }) !== null)); };
    const errs = ran.filter((c) => !c.tool!.ok || (!c.tool!.indeterminate && saysFailed(c)));
    // why: the cause of these failures is not known to the tester (a refusal of the value, or a fault), so a JSON-RPC error is judged on the first two clauses only.
    const js = errs.map((c) => ({ c, j: res2Judge({ step: c.tool!.steps[1] ?? '', ok: c.tool!.ok, isError: c.tool!.isError, rpc_error: c.tool!.rpc_error, text: c.tool!.text, data: null, indeterminate: !!c.tool!.indeterminate, tool: res.update!.tool, ...(c.tool!.shape ? { shape: c.tool!.shape } : {}), ...(c.tool!.carried ? { carried: c.tool!.carried } : {}) }, c.tool!.diff.map((e) => e.path), 'unknown', `${res.update!.tool} failed (${c.case})`, Object.fromEntries(c.tool!.diff.map((e) => [e.path, e.after])), { async: asyncOps.includes(res.update!.tool) }) }));
    // why: validator on 59e3124 (finding 7; rule 11, point 13): a declared MWS-RES-1 case whose success says, by its adopted shape or
    // a declared patterns.not_applied, that it failed, while what it asked for is in effect, is a trial of the third clause too.
    const dTrials = declared.filter((dc) => dc.call && dc.call.ok && !dc.call.indeterminate && !dc.skipped && dc.expect && !dc.missing.length).flatMap((dc) => {
      const call = dc.call!;
      const b = { step: call.step, ok: true, isError: false, rpc_error: null, text: call.text, data: null, indeterminate: false, tool: res.update!.tool, ...(call.shape ? { shape: call.shape } : {}), ...(call.carried ? { carried: call.carried } : {}) };
      const sh = outcomeShape(carrier(call.shape));
      const failed = (!!sh && ['not_applied', 'partial', 'unknown'].includes(sh.outcome)) || textStatement(b, 'not_applied', { trial: true }) !== null;
      return failed ? [{ name: `declared case ${dc.name}`, steps: [call.step], j: res2Judge(b, Object.keys(dc.expect!), 'unknown', `${res.update!.tool} (declared case ${dc.name})`, dc.expect!, { async: asyncOps.includes(res.update!.tool) }) }] : [];
    });
    const trials = [...js.map((x) => ({ name: x.c.case, steps: x.c.tool!.steps, j: x.j })), ...dTrials];
    const seen = errs.length + dTrials.length;
    const bad = trials.filter((x) => x.j.verdict === 'violated');
    const judgedErr = trials.filter((x) => x.j.verdict === 'held');
    const open = trials.filter((x) => x.j.verdict === 'not tested');
    if (bad.length) out.push(result('MWS-RES-2', w, sc, 'violated', bad.map((x) => x.j.reason).join(' '), { numbers: { errors_seen: seen }, steps: bad.flatMap((x) => x.steps), notes: [...new Set(bad.flatMap((x) => x.j.notes))] }));
    else if (judgedErr.length) out.push(result('MWS-RES-2', w, sc, 'held', `${judgedErr.length} failing write(s) were errors and left nothing applied that the error does not identify (${judgedErr.map((x) => x.name).join(', ')}).`, { numbers: { errors_seen: seen }, notes: [...new Set(judgedErr.flatMap((x) => x.j.notes)), ...open.map((x) => `Not judged, ${x.name}: ${x.j.reason}`)] }));
    // why: validator on 59e3124 (finding 5): a trial its judge could not decide is said on record, never left silent.
    else if (open.length) out.push(result('MWS-RES-2', w, sc, 'not tested', open.map((x) => `${x.name}: ${x.j.reason}`).join(' '), { numbers: { errors_seen: seen }, notes: [...new Set(open.flatMap((x) => x.j.notes))] }));
    else out.push(result('MWS-RES-2', w, sc, 'not tested', 'no write failed in this check, so an error result could not be examined (a wrong-type value that was accepted is reported under MWS-IN-1)'));
  }
  // why: spec 8.2, rule 13 (R7-2): one verdict per record from several calls; the record states what each call showed.
  for (const r of out) {
    if (r.requirement === 'MWS-UPD-1') r.notes.unshift(upd1Calls(cases, f0));
    if (r.requirement === 'MWS-RES-1') r.notes.unshift(res1Calls(cases, declared));
  }
  return out;
}

const showCase = (c: CaseObs, f0: string) => `${c.case}${c.named && c.named !== f0 ? ` on ${c.named}` : ` (${f0})`}`;

/** What each call of MWS-UPD-1 showed (rule 13). */
export function upd1Calls(cases: CaseObs[], f0: string): string {
  return `Each call: ${cases.map((c) => {
    const head = showCase(c, c.named ?? f0);
    if (!c.tool) return `${head}: not run (${c.skipped ?? 'no call'})`;
    if (c.tool.indeterminate) return `${head}: outcome unknown, not judged`;
    if (!c.tool.ok) return `${head}: refused${c.tool.diff.length ? ` (changed ${c.tool.diff.map((e) => e.path).join(', ')}; judged by MWS-RES-2)` : ''}, adds no verdict here`;
    if (c.case === 'invalid_type') return `${head}: accepted (judged by MWS-IN-1)`;
    const named = c.named ?? f0;
    const other = c.tool.diff.filter((e) => !under(e.path, named)).map((e) => e.path);
    const nul = c.case === 'explicit_null' && c.null_effect ? `; the named field was ${c.null_effect === 'cleared' ? 'cleared' : c.null_effect === 'kept' ? 'left as it was' : 'given another value'}${c.set_first ? ' (set first so that the first read showed it set)' : ''}` : '';
    return `${head}: success; ${other.length ? `also changed ${other.join(', ')}` : c.tool.diff.length ? 'only the named field changed' : 'nothing changed'}${nul}`;
  }).join('; ')}.`;
}

/** What each call of MWS-RES-1 showed (rule 13). */
export function res1Calls(cases: CaseObs[], declared: DeclaredCase[]): string {
  const judged = cases.filter((c) => c.case === 'set_field' || c.case === 'set_field_b' || c.case === 'empty_value');
  const lines = judged.map((c) => {
    if (!c.tool) return `${c.case}: not run (${c.skipped ?? 'no call'})`;
    if (c.tool.indeterminate) return `${c.case}: outcome unknown, not judged`;
    if (!c.tool.ok) return `${c.case}: refused, adds no verdict here`;
    return `${c.case}: success, ${c.tool.applied ? 'in effect' : `not in effect${c.control ? ` (the platform API: HTTP ${c.control.status ?? 'none'}, ${c.control.applied ? 'applied' : c.control.ignored ? 'changed nothing' : 'not applied'})` : ''}`}`;
  });
  for (const d of declared) lines.push(d.skipped || !d.call ? `declared case ${d.name}: not run (${d.skipped ?? 'no call'})` : d.call.indeterminate ? `declared case ${d.name}: outcome unknown, not judged` : !d.call.ok ? `declared case ${d.name}: refused, adds no verdict here` : `declared case ${d.name}: success, ${d.missing.length ? 'not in effect' : 'in effect'}`);
  lines.push('the explicit null probe of MWS-UPD-1 gives no verdict here (the spec does not say whether null clears a field)');
  return `Each call: ${lines.join('; ')}.`;
}

/** Notes for the four further probes: which ran, which the schema did not allow, and what explicit null did. */
function further(cases: CaseObs[], res: ResourceSpec): string[] {
  const all: CaseName[] = ['explicit_null', 'empty_string', 'empty_list', 'nested_subfield'];
  const ran = cases.filter((c) => all.includes(c.case));
  const out = [`Further probes: ${ran.length ? ran.map((c) => `${c.case} on ${c.named}${c.tool ? (c.tool.ok ? '' : ' (refused)') : ` (${c.skipped ?? 'not run'})`}`).join('; ') : 'none'}; not allowed by ${res.update!.tool}'s schema for any field the tester may write: ${all.filter((n) => !ran.some((c) => c.case === n)).join(', ') || 'none'}.`];
  const n = ran.find((c) => c.case === 'explicit_null' && c.null_effect);
  if (n) out.push(`Explicit null on ${n.named}: the tool ${n.null_effect === 'cleared' ? 'cleared the field' : n.null_effect === 'kept' ? 'left the field as it was' : 'stored another value'} (the spec does not say which; the named field itself is judged by MWS-RES-1).`);
  return out;
}
