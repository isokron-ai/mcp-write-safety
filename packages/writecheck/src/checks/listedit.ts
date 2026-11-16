/**
 * MWS-UPD-2: a tool that edits one element of a list held inside an object applies the edit to the
 * element the caller identified, or refuses, when the list changed since the caller read it.
 *
 *   1. a scratch object whose list has at least three elements; read it; the target is the second
 *   2. how the tool addresses an element is taken from its input schema: a stable id (address.by_id)
 *      if the schema declares that argument, else a position (address.by_position)
 *   3. a second writer (another connection) changes the list: inserts an element ahead of the target;
 *      then, each from a fresh object, removes the first element, and moves the target to the end
 *   4. the edit, with the address taken from the first read; read back: which element changed?
 *
 * The second writer sends the whole new list through the insert tool ({{names_inserted}}). The control
 * arm (the same change and edit through the platform API) is not built in this preview.
 */

import { valueAt } from '../core/driver.js';
import type { ResourceSpec } from '../core/manifest.js';
import { render } from '../core/template.js';
import { deepEqual, getPath, parsePath, setPath, short } from '../core/util.js';
import { result, type Result } from '../report/verdicts.js';
import { scratch } from './scratch.js';
import { brief, schemaProps, toolByName, wp, type CallBrief, type CheckModule, type Observation, type PlanContext, type PlannedCheck, type RunContext } from './types.js';

const ID = 'list-element';
const VERSION = '1';

type Change = 'insertion' | 'removal' | 'reordering';

interface ListEditObs {
  skipped?: string;
  /** Each forced change, run from a fresh object (the fields below are the first run's, kept for older observations). */
  runs?: (Omit<ListEditObs, 'runs'> & { change: Change })[];
  change?: Change;
  addressed_by: 'id' | 'position' | null;
  target: { id: unknown; name: unknown; position: number } | null;
  inserted: unknown;
  before: unknown[];
  /** For an effect on a field: each element's value of that field just before the edit (after the insertion). */
  before_values?: { name: unknown; value: unknown }[];
  after: unknown[];
  call: CallBrief | null;
  /** The list (names) the second writer set. */
  changed_to?: unknown[];
}

const names = (list: unknown, namePath: string): unknown[] => (Array.isArray(list) ? list.map((e) => getPath(e, namePath)) : []);

export const listEditCheck: CheckModule = {
  id: ID,
  version: VERSION,
  requirements: ['MWS-UPD-2'],
  plan(ctx: PlanContext, res: ResourceSpec): PlannedCheck {
    const base: PlannedCheck = { check: ID, version: VERSION, resource: res.name, runs: false, calls: [], writes: 0, creates: 0, notRun: [] };
    const le = res.list_edit;
    if (!le) return base;
    const w = wp(res.name, le.tool);
    if (!res.create || !res.cleanup || res.cleanup === 'leave') return { ...base, notRun: [result('MWS-UPD-2', w, { id: ID, version: VERSION }, 'not tested', 'needs a create block and a cleanup policy (it uses a scratch object)')] };
    const { props } = schemaProps(toolByName(ctx.tools, le.tool));
    const by = le.address.by_id && topIn(le.address.by_id, props) ? `id (${le.address.by_id})` : le.address.by_position && topIn(le.address.by_position, props) ? `position (${le.address.by_position})` : null;
    if (!by) return { ...base, notRun: [result('MWS-UPD-2', w, { id: ID, version: VERSION }, 'not tested', `${le.tool}'s input schema declares neither ${[le.address.by_id, le.address.by_position].filter(Boolean).join(' nor ')}: how it addresses an element is not known`)] };
    return { ...base, runs: true, calls: [`positive control on a scratch object; then for each of insertion, removal, reordering: a scratch object with a list of 3 or more; ${res.read.tool}; ${le.insert.tool} sets the changed list (second connection); ${le.tool} on the second element by ${by} as first read; ${res.read.tool}`], writes: 7, creates: 4 };
  },
  async collect(ctx: RunContext, res: ResourceSpec): Promise<Observation> {
    const le = res.list_edit!;
    const label = ctx.label('LE');
    const other = ctx.label('LEO');
    const o: ListEditObs = { addressed_by: null, target: null, inserted: null, before: [], after: [], call: null };
    const done = (why: string) => ({ check: ID, version: VERSION, resource: res.name, data: { ...o, skipped: why } });
    const { props } = schemaProps(toolByName(ctx.tools, le.tool));
    o.addressed_by = le.address.by_id && topIn(le.address.by_id, props) ? 'id' : le.address.by_position && topIn(le.address.by_position, props) ? 'position' : null;
    if (!o.addressed_by) return done('the tool declares no addressing argument');
    // Positive control: with no other writer, the edit by the same address must reach the second element.
    {
      const p = await scratch(ctx, res, { tag: 'lep', purpose: 'MWS-UPD-2 positive control', label });
      if (!p.ok) return done(`scratch object: ${p.reason}`);
      const r0 = await p.driver!.readOnce(label, ctx.session.stepId('upd2.pos.read'));
      const l0 = r0.ok ? valueAt(r0.obj, le.list) : null;
      if (!Array.isArray(l0) || l0.length < 2) return done(`the object's list at ${le.list} has fewer than two elements (declare create arguments that fill it)`);
      const want = getPath(l0[1], le.element.name);
      const pr = await ctx.session.call(label, le.tool, withAddress(render(le.args, p.driver!.vars()), o.addressed_by === 'id' ? le.address.by_id! : le.address.by_position!, o.addressed_by === 'id' ? getPath(l0[1], le.element.id) : 1), { step: ctx.session.stepId('upd2.pos.edit') });
      const r1 = await p.driver!.readOnce(label, ctx.session.stepId('upd2.pos.after'));
      const l1 = r1.ok ? valueAt(r1.obj, le.list) : null;
      const reached = Array.isArray(l1) && (le.effect === 'removed' ? !l1.some((e) => deepEqual(getPath(e, le.element.name), want)) && l1.length === l0.length - 1 : deepEqual(getPath(l1.find((e) => deepEqual(getPath(e, le.element.name), want)), (le.effect as { path: string }).path), (le.effect as { value: unknown }).value));
      if (!pr.ok || !reached) return done(`the positive control failed: with no other writer, ${le.tool} by ${o.addressed_by} ${!pr.ok ? 'was refused' : 'did not reach the second element'} (check the address base and the arguments), so the stale edit would show nothing`);
    }
    const addressedBy = o.addressed_by;
    const one = async (change: Change): Promise<Omit<ListEditObs, 'runs'> & { change: Change }> => {
      const o: Omit<ListEditObs, 'runs'> & { change: Change } = { change, addressed_by: addressedBy, target: null, inserted: null, before: [], after: [], call: null };
      const s = await scratch(ctx, res, { tag: `le${change[0]}`, purpose: `MWS-UPD-2 object with a list (${change})`, label });
      if (!s.ok) return { ...o, skipped: `scratch object: ${s.reason}` };
      const d = s.driver!;
      const r0 = await d.readOnce(label, ctx.session.stepId('upd2.read'));
      const list0 = r0.ok ? valueAt(r0.obj, le.list) : null;
      if (!Array.isArray(list0) || list0.length < 3) return { ...o, skipped: `the object's list at ${le.list} has fewer than three elements (declare create arguments that fill it)` };
      const t = list0[1];
      o.target = { id: getPath(t, le.element.id), name: getPath(t, le.element.name), position: 1 };
      o.before = names(list0, le.element.name);
      const inserted = `${ctx.prefix.slice(0, 5)}ins`;
      o.inserted = change === 'insertion' ? inserted : null;
      const namesInserted = change === 'insertion' ? [o.before[0], inserted, ...o.before.slice(1)] : change === 'removal' ? o.before.slice(1) : [o.before[0], ...o.before.slice(2), o.before[1]];
      o.changed_to = namesInserted;
      const ins = await ctx.session.call(other, le.insert.tool, render(le.insert.args, d.vars({ names_inserted: namesInserted })), { step: ctx.session.stepId('upd2.insert') });
      const r1 = await d.readOnce(label, ctx.session.stepId('upd2.read2'));
      const list1 = r1.ok ? valueAt(r1.obj, le.list) : null;
      if (!ins.ok || !Array.isArray(list1) || JSON.stringify(names(list1, le.element.name)) !== JSON.stringify(namesInserted)) return { ...o, skipped: `the second writer's ${change} did not take effect (${short(ins.text ?? ins.rpc_error?.message ?? '', 120)})` };
      if (le.effect !== 'removed') o.before_values = (list1 as unknown[]).map((e) => ({ name: getPath(e, le.element.name), value: getPath(e, (le.effect as { path: string }).path) }));
      const args = withAddress(render(le.args, d.vars({ element_id: o.target.id, position: o.target.position })), o.addressed_by === 'id' ? le.address.by_id! : le.address.by_position!, o.addressed_by === 'id' ? o.target.id : o.target.position);
      const r = await ctx.session.call(label, le.tool, args, { step: ctx.session.stepId(`upd2.${change}.edit`) });
      o.call = brief(r);
      const r2 = await d.readSettled(label, 'upd2.after', () => false);
      if (!r2.ok) return { ...o, skipped: 'the object did not read back after the edit (outcome unknown)' };
      const list2 = valueAt(r2.obj, le.list);
      o.after = Array.isArray(list2) ? (le.effect === 'removed' ? names(list2, le.element.name) : list2.map((e) => ({ name: getPath(e, le.element.name), value: getPath(e, (le.effect as { path: string }).path) }))) : [];
      return o;
    };
    o.runs = [];
    for (const ch of ['insertion', 'removal', 'reordering'] as Change[]) o.runs.push(await one(ch));
    return { check: ID, version: VERSION, resource: res.name, data: o };
  },
  evaluate(obs: Observation, ctx: PlanContext): Result[] {
    const res = ctx.manifest.resources.find((r) => r.name === obs.resource)!;
    return listEditVerdicts(obs.data as ListEditObs, res);
  },
};

export function listEditVerdicts(o: ListEditObs, res: ResourceSpec): Result[] {
  const le = res.list_edit!;
  const w = wp(res.name, le.tool);
  const sc = { id: ID, version: VERSION };
  if (o.skipped) return [result('MWS-UPD-2', w, sc, 'not tested', o.skipped)];
  const runs = o.runs ?? [{ ...o, change: 'insertion' as Change }];
  const judged = runs.map((r) => ({ r, j: judgeRun(r, le) }));
  const forced = judged.filter((x) => x.j.verdict !== 'not tested');
  const which = (xs: typeof judged) => xs.map((x) => x.r.change).join(', ');
  const notes = [...judged.flatMap((x) => x.j.notes.map((n) => `${x.r.change}: ${n}`)), ...judged.filter((x) => x.j.verdict === 'not tested').map((x) => `${x.r.change}: not forced (${x.j.reason})`), 'The control arm (the same change and edit through the platform API) is not built in this preview.'];
  const bad = judged.filter((x) => x.j.verdict === 'violated');
  if (bad.length) return [result('MWS-UPD-2', w, sc, 'violated', bad.map((x) => `After ${x.r.change}: ${x.j.reason}`).join(' '), { steps: bad.flatMap((x) => x.j.steps), notes: [`Changes forced: ${which(forced) || 'none'}.`, ...notes] })];
  if (!forced.length) return [result('MWS-UPD-2', w, sc, 'not tested', `no change to the list could be forced: ${judged.map((x) => `${x.r.change}: ${x.j.reason}`).join('; ')}`, { notes })];
  return [result('MWS-UPD-2', w, sc, 'held', `${le.tool} reached the element the caller identified, or refused, after each forced change (${which(forced)}).`, { notes: [`Changes forced: ${which(forced)}.`, ...notes] })];
}

function judgeRun(o: Omit<ListEditObs, 'runs'> & { change: Change }, le: NonNullable<ResourceSpec['list_edit']>): { verdict: 'violated' | 'held' | 'not tested'; reason: string; steps: string[]; notes: string[] } {
  if (o.skipped) return { verdict: 'not tested', reason: o.skipped, steps: [], notes: [] };
  if (!o.call || o.call.indeterminate) return { verdict: 'not tested', reason: 'the edit\'s outcome is unknown', steps: [], notes: [] };
  const listBefore = o.changed_to ?? [o.before[0], o.inserted, ...o.before.slice(1)];
  const notes = [`addressed by ${o.addressed_by}; target ${short(o.target!.name, 30)} at position ${o.target!.position} in the first read; first read ${JSON.stringify(o.before)}; the second writer set ${JSON.stringify(listBefore)}; after the edit ${JSON.stringify(o.after)}`];
  if (!o.call.ok) return { verdict: 'held', reason: `${le.tool} refused the edit after the list changed`, steps: [o.call.step], notes };
  let changed: unknown[];
  if (le.effect === 'removed') changed = listBefore.filter((n) => !(o.after as unknown[]).some((a) => deepEqual(a, n)));
  else {
    // why: an element that already held the value before the edit was not changed by it.
    const eff = le.effect;
    const had = new Set((o.before_values ?? []).filter((b) => deepEqual(b.value, eff.value)).map((b) => JSON.stringify(b.name)));
    changed = (o.after as { name: unknown; value: unknown }[]).filter((a) => deepEqual(a.value, eff.value) && !had.has(JSON.stringify(a.name))).map((a) => a.name);
  }
  if (changed.length === 1 && deepEqual(changed[0], o.target!.name)) return { verdict: 'held', reason: `the edit reached ${short(o.target!.name, 30)}`, steps: [], notes };
  if (changed.some((n) => !deepEqual(n, o.target!.name))) return { verdict: 'violated', reason: `asked to edit ${short(o.target!.name, 30)} as first read, ${le.tool} reported success and changed ${changed.map((n) => short(n, 30)).join(', ')} instead.`, steps: [o.call.step], notes };
  return { verdict: 'not tested', reason: 'the edit reported success but no element shows its effect', steps: [], notes };
}

/**
 * writesafe self-test T4: the address may be a path into the arguments (`ops[0].row_id`), for a tool that takes its edits as a
 * list of operations; the first segment must be an argument the input schema declares.
 */
function topIn(addr: string, props: Record<string, unknown>): boolean {
  const first = parsePath(addr)[0];
  return typeof first === 'string' && first in props;
}

function withAddress(args: unknown, addr: string, value: unknown): Record<string, unknown> {
  const base = (args && typeof args === 'object' && !Array.isArray(args) ? args : {}) as Record<string, unknown>;
  return parsePath(addr).length > 1 ? (setPath(base, addr, value) as Record<string, unknown>) : { ...base, [addr]: value };
}
