/**
 * Annotation truthfulness: each hint a tool declares is a claim, tested against what a forced call
 * does to the run's own objects. Only an explicit optimistic claim can be wrong; the cautious
 * defaults (readOnlyHint false, destructiveHint true, idempotentHint false) are never a violation
 * (NF-2). These are claims about all of a server's state, so the only verdicts are `violated` and
 * `not observed` (spec 8.2, rule 8): the tester sees only the objects it reads.
 *
 *   MWS-ANN-1  readOnlyHint: true      call it twice; the object read before and after must not change
 *   MWS-ANN-2  destructiveHint: false  update: overwrite an existing value; delete: delete a scratch
 *                                      object; create with a caller-chosen key: create again with the
 *                                      same key; other tools: call on a scratch object. Any value that
 *                                      existed before and is changed or removed is a violation.
 *   MWS-ANN-3  idempotentHint: true    the same call twice; the second must change nothing (version
 *                                      and declared server-managed fields aside); a create twice must
 *                                      not make two objects
 *
 * Tools other than the resource's own (the manifest's `calls`, and `creates` entries) are called on
 * a scratch object of the resource they are bound to, never on the object under test.
 */

import { deleteArgs, valueAt, type Driver, needsVersion } from '../core/driver.js';
import type { ResourceSpec } from '../core/manifest.js';
import { createVerified, definitelyGone, idFromResult } from '../core/objects.js';
import { render } from '../core/template.js';
import { deepEqual, diff, getPath, parsePath, short, withoutIgnored, type DiffEntry } from '../core/util.js';
import type { RequirementId } from '../requirements.js';
import { result, type Result, type Verdict } from '../report/verdicts.js';
import { ignoredPaths } from './readback.js';
import { ruleNote } from './rules.js';
import { scratch } from './scratch.js';
import { annotations, nonAdditive, notRun, toolByName, wp, type CheckModule, type Observation, type PlanContext, type PlannedCheck, type RunContext } from './types.js';

const ID = 'annotation-effects';
const VERSION = '2';

type Role = 'read' | 'list' | 'update' | 'create' | 'delete' | 'call';

interface ToolObs {
  tool: string;
  role: Role;
  annotations: Record<string, unknown>;
  ann1?: { calls: number; changed: DiffEntry[]; steps: string[]; skipped?: string };
  /**
   * replaced: something that existed was changed or removed (MWS-ANN-5, additive only); unnamed: what of that
   * the call's arguments did not name, or the object was deleted (MWS-ANN-2).
   */
  ann2?: { replaced: boolean; detail: string; steps: string[]; skipped?: string; unnamed?: string[] };
  ann3?: { first_ok: boolean; second_ok: boolean; changed: DiffEntry[]; ids?: unknown[]; steps: string[]; skipped?: string };
}

/** The resource the manifest's `calls` are bound to by default: the first one with an update tool. */
const defaultCallsResource = (ctx: PlanContext) => ctx.manifest.resources.find((r) => r.update)?.name ?? ctx.manifest.resources[0]?.name;

function roles(res: ResourceSpec, ctx: PlanContext): { tool: string; role: Role; args: unknown }[] {
  const out: { tool: string; role: Role; args: unknown }[] = [{ tool: res.read.tool, role: 'read', args: res.read.args }];
  if (res.list) out.push({ tool: res.list.tool, role: 'list', args: res.list.args });
  if (res.update) out.push({ tool: res.update.tool, role: 'update', args: res.update.args });
  if (res.create) out.push({ tool: res.create.tool, role: 'create', args: res.create.args });
  if (res.delete) out.push({ tool: res.delete.tool, role: 'delete', args: res.delete.args });
  for (const c of res.creates) out.push({ tool: c.tool, role: 'call', args: c.args });
  // why: only calls whose arguments point at the run's own object or prefix are made; a call aimed elsewhere could change state the run does not own.
  for (const [tool, c] of Object.entries(ctx.manifest.calls)) if ((c.resource ?? defaultCallsResource(ctx)) === res.name && /\{\{\s*(id|prefix|marker|object)[.}\s]/.test(JSON.stringify(c.args))) out.push({ tool, role: 'call', args: c.args });
  const seen = new Set<string>();
  return out.filter((o) => (seen.has(o.tool) ? false : (seen.add(o.tool), true)));
}

const cleanable = (res: ResourceSpec) => !!res.create && !!res.cleanup && res.cleanup !== 'leave';

/**
 * A tool the bystander inventory lists through (a list block, a scope's list, a read through a list). The inventory brackets
 * every check (k1, gate-2 re-run on 0295ed6), so such a tool has already been called on the object under test before this check;
 * a read-only claim that is false in a way that shows once (a "seen" mark) would not show again. MWS-ANN-1 calls it on a scratch
 * object made inside the check instead, where the resource can make one.
 */
const listedByInventory = (ctx: PlanContext, tool: string): boolean =>
  ctx.manifest.resources.some((r) => r.list?.tool === tool || r.scope?.list.tool === tool || (!!r.read.items && r.read.tool === tool));

export const annotationsCheck: CheckModule = {
  id: ID,
  version: VERSION,
  requirements: ['MWS-ANN-1', 'MWS-ANN-2', 'MWS-ANN-3', 'MWS-ANN-5'],
  plan(ctx: PlanContext, res: ResourceSpec): PlannedCheck {
    const calls: string[] = [];
    let writes = 0;
    let creates = 0;
    for (const t of roles(res, ctx)) {
      const a = annotations(toolByName(ctx.tools, t.tool));
      if (!toolByName(ctx.tools, t.tool)) continue;
      const ro = a['readOnlyHint'] === true;
      if (ro && t.role !== 'create' && t.role !== 'delete') (calls.push(`MWS-ANN-1 ${t.tool}: read; call it twice (counted as writes); read again`), (writes += 4), (creates += t.role === 'call' || (listedByInventory(ctx, t.tool) && cleanable(res)) ? 1 : 0));
      if (!ro && a['destructiveHint'] === false) (calls.push(`MWS-ANN-2 ${t.tool}: ${t.role === 'update' ? 'overwrite a value' : t.role === 'delete' ? 'delete a scratch object' : t.role === 'create' ? (res.key ? 'create twice with the same key' : 'create, the object under test must not change') : 'call on a scratch object'}; read back`), (writes += 3), (creates += 2));
      if (!ro && a['idempotentHint'] === true) (calls.push(`MWS-ANN-3 ${t.tool}: the same call twice, read after each`), (writes += 4), (creates += t.role === 'create' ? 2 : 1));
    }
    // why: dogfood C7: a `calls` entry whose arguments name no object of the run is not called, and the plan says so.
    const dropped = Object.entries(ctx.manifest.calls).filter(([tool, c]) => (c.resource ?? defaultCallsResource(ctx)) === res.name && !/\{\{\s*(id|prefix|marker|object)[.}\s]/.test(JSON.stringify(c.args)) && !roles(res, ctx).some((t) => t.tool === tool));
    const nr = dropped.flatMap(([tool]) => notRun(this, ['MWS-ANN-1', 'MWS-ANN-2', 'MWS-ANN-3'], wp(res.name, tool), 'not tested', `calls.${tool}: its arguments name no object of the run ({{id}}, {{prefix}}, {{marker}} or {{object}}), so it is not called: a call aimed elsewhere could change state the run does not own`));
    return { check: ID, version: VERSION, resource: res.name, runs: calls.length > 0, calls, writes, creates, notRun: nr };
  },
  async collect(ctx: RunContext, res: ResourceSpec): Promise<Observation> {
    const d = ctx.driver;
    const label = ctx.label('ANN');
    const ign = ignoredPaths(res);
    const out: ToolObs[] = [];
    const objectOf = async (dd: Driver, tag: string) => dd.readOnce(`${label}.snap`, ctx.session.stepId(`ann.${tag}`));
    /** A scratch object to call a tool on (never the object under test). */
    const target = async (tag: string): Promise<{ d: Driver | null; why: string }> => {
      if (!cleanable(res)) return { d: null, why: 'needs a create block and a cleanup policy (the tool is called on a scratch object)' };
      const s = await scratch(ctx, res, { tag, purpose: `annotation effects (${tag})`, label });
      return s.ok ? { d: s.driver!, why: '' } : { d: null, why: `scratch object: ${s.reason}` };
    };
    // why: research builds N4: a {{version}} in a template is the version just read, never null.
    const callOn = async (dd: Driver, t: { tool: string; args: unknown }, step: string, obj: unknown, version: unknown = null) => ctx.session.call(label, t.tool, render(t.args, dd.vars({ object: obj ?? null, marker: ctx.marker('an'), version })), { step });
    for (const t of roles(res, ctx)) {
      const tool = toolByName(ctx.tools, t.tool);
      if (!tool) continue;
      const a = annotations(tool);
      const o: ToolObs = { tool: t.tool, role: t.role, annotations: a };
      const ro = a['readOnlyHint'] === true;
      // MWS-ANN-1
      if (ro && t.role !== 'create' && t.role !== 'delete') {
        let dd: Driver | null = d;
        let why = '';
        if (t.role === 'call' || d.id === null || d.id === undefined) ({ d: dd, why } = await target('a1'));
        else if (listedByInventory(ctx, t.tool) && cleanable(res)) ({ d: dd, why } = await target('a1'));
        if (!dd || (dd === d && res.update && !(await dd.reset()))) o.ann1 = { calls: 0, changed: [], steps: [], skipped: why || 'the object could not be reset' };
        else {
          const before = await objectOf(dd, `${t.tool}.before`);
          const steps: string[] = [];
          let unknown = false;
          // why: a tool is tested here because it may write despite its claim, so its calls count against the budget and the rate limit.
          for (let i = 0; i < 2; i++) {
            const step = ctx.session.stepId(`ann1.${t.tool}.${i}`);
            steps.push(step);
            const r = t.role === 'update' ? await dd.update(label, res.fields![0], res.fields![0].values[1], { step }) : await callOn(dd, t, step, before.obj, before.version);
            if (r.timed_out || r.transport_error !== null) unknown = true;
          }
          const after = await objectOf(dd, `${t.tool}.after`);
          o.ann1 = unknown ? { calls: 2, changed: [], steps, skipped: 'a call timed out or lost the connection; the outcome is unknown' } : { calls: 2, changed: before.ok && after.ok ? withoutIgnored(diff(before.obj, after.obj), ign).slice(0, 10) : [], steps, ...(before.ok && after.ok ? {} : { skipped: 'the object could not be read around the calls' }) };
          if (dd === d) await d.reset();
        }
      }
      // MWS-ANN-2
      if (!ro && a['destructiveHint'] === false) {
        if (t.role === 'update') o.ann2 = await overwrite(ctx, d, res, label);
        else if (t.role === 'delete') o.ann2 = await scratchDelete(ctx, res, label);
        else if (t.role === 'create') o.ann2 = res.key ? await sameKeyCreate(ctx, res, label) : await createLeavesOthers(ctx, d, res, label, ign);
        else if (t.role === 'call') {
          const { d: dd, why } = await target('a2');
          if (!dd) o.ann2 = { replaced: false, detail: '', steps: [], skipped: why };
          else {
            const before = await objectOf(dd, `${t.tool}.a2.before`);
            const step = ctx.session.stepId(`ann2.${t.tool}`);
            const r = await callOn(dd, t, step, before.obj, before.version);
            const after = await objectOf(dd, `${t.tool}.a2.after`);
            const lost = before.ok && after.ok ? lostPaths(before.obj, after.obj, ign) : [];
            const args = render(t.args, dd.vars({ object: before.obj ?? null, marker: 'x', version: before.version ?? null })) as Record<string, unknown>;
            const unnamed = lost.filter((p) => !namedBy(args, before.obj, p));
            o.ann2 = r.timed_out || r.transport_error !== null || !before.ok || !after.ok ? { replaced: false, detail: '', steps: [step], skipped: 'the call or a read around it has an unknown outcome' } : { replaced: r.ok && lost.length > 0, unnamed: r.ok ? unnamed : [], detail: `it changed or removed ${lost.slice(0, 5).join(', ')}`, steps: [step] };
          }
        }
      }
      // MWS-ANN-3
      if (!ro && a['idempotentHint'] === true) {
        if (t.role === 'update') o.ann3 = await repeatUpdate(ctx, d, res, label, ign);
        else if (t.role === 'create') o.ann3 = await repeatCreate(ctx, res, label);
        else if (t.role === 'delete' || t.role === 'call') {
          const { d: dd, why } = await target('a3');
          if (!dd) o.ann3 = { first_ok: false, second_ok: false, changed: [], steps: [], skipped: why };
          else {
            const before = await objectOf(dd, `${t.tool}.a3.before`);
            const args = t.role === 'delete' ? null : before.obj;
            const s1 = ctx.session.stepId(`ann3.${t.tool}.1`);
            const s2 = ctx.session.stepId(`ann3.${t.tool}.2`);
            const fixed = render(t.args, dd.vars({ object: args ?? null, marker: ctx.marker('an3'), version: before.version ?? null }));
            const r1 = await ctx.session.call(label, t.tool, fixed, { step: s1 });
            const a1 = await objectOf(dd, `${t.tool}.a3.after1`);
            const r2 = await ctx.session.call(label, t.tool, fixed, { step: s2 });
            const a2 = await objectOf(dd, `${t.tool}.a3.after2`);
            const gone = (x: typeof a1) => !!x.call && (definitelyGone(x.call) || (x.call.ok && !!res.read.items && x.obj === null));
            const changed = t.role === 'delete' ? (gone(a1) && !gone(a2) ? [{ path: '(object)', kind: 'added' as const }] : []) : a1.ok && a2.ok ? withoutIgnored(diff(a1.obj, a2.obj), ign).slice(0, 10) : [];
            o.ann3 = [r1, r2].some((r) => r.timed_out || r.transport_error !== null) ? { first_ok: false, second_ok: false, changed: [], steps: [s1, s2], skipped: 'a call timed out; the outcome is unknown' } : { first_ok: r1.ok, second_ok: r2.ok, changed, steps: [s1, s2] };
          }
        }
      }
      out.push(o);
    }
    if (res.update) await d.reset();
    const entries = ctx.ledger.entries();
    const createdIntents = new Set(entries.filter((e) => e.kind === 'created').map((e) => (e as { intent: number }).intent));
    const createdBy = entries.filter((e) => e.kind === 'intent' && createdIntents.has((e as { seq: number }).seq)).map((e) => (e as { tool: string }).tool);
    return { check: ID, version: VERSION, resource: res.name, data: { tools: out, created_with: [...new Set(createdBy)] } };
  },
  evaluate(obs: Observation, ctx: PlanContext): Result[] {
    const res = ctx.manifest.resources.find((r) => r.name === obs.resource)!;
    const data = obs.data as { tools: ToolObs[]; created_with: string[] };
    return annotationVerdicts(data.tools, data.created_with, res);
  },
};

async function overwrite(ctx: RunContext, d: Driver, res: ResourceSpec, label: string): Promise<NonNullable<ToolObs['ann2']>> {
  const f = res.fields![0];
  if (!(await d.reset())) return { replaced: false, detail: '', steps: [], skipped: 'the object could not be reset' };
  const before = await d.readOnce(label, ctx.session.stepId('ann2.before'));
  const prev = valueAt(before.obj, f.path);
  if (prev === undefined || prev === null || prev === '') return { replaced: false, detail: '', steps: [], skipped: `${f.path} holds no value to overwrite` };
  const step = ctx.session.stepId('ann2.write');
  const r = await d.update(label, f, f.values[1], { step, base: { obj: before.obj, version: before.version } });
  const after = await d.readSettled(label, 'ann2.after', (o) => deepEqual(valueAt(o, f.path), f.values[1]));
  const now = valueAt(after.obj, f.path);
  await d.reset();
  if (!after.ok) return { replaced: false, detail: '', steps: [step], skipped: 'the object did not read back after the write' };
  if (r.timed_out || r.transport_error !== null) return { replaced: false, detail: '', steps: [step], skipped: 'the call timed out or lost the connection; the outcome is unknown' };
  // why: the call names the field it overwrites, so this is never MWS-ANN-2; it is not additive (MWS-ANN-5).
  return { replaced: r.ok && !deepEqual(prev, now), unnamed: [], detail: `${f.path}: ${short(prev, 40)} → ${short(now, 40)}`, steps: [step] };
}

async function scratchDelete(ctx: RunContext, res: ResourceSpec, label: string): Promise<NonNullable<ToolObs['ann2']>> {
  if (!cleanable(res) || !res.delete) return { replaced: false, detail: '', steps: [], skipped: 'needs create, delete and a cleanup policy' };
  const s = await scratch(ctx, res, { tag: 'a2d', purpose: 'MWS-ANN-2 scratch object for the delete tool', label });
  if (!s.ok) return { replaced: false, detail: '', steps: [], skipped: `the scratch object could not be created: ${s.reason}` };
  const step = ctx.session.stepId('ann2.delete');
  // why: review (writesafe T2): a delete that takes the version is sent the version just read, never null.
  const cur = needsVersion(res.delete.args) ? await s.driver!.readOnce(label, ctx.session.stepId('ann2.base')) : null;
  const r = await ctx.session.call(label, res.delete.tool, deleteArgs(res, s.driver!.vars(cur?.ok ? { version: cur.version, object: cur.obj } : {}), toolByName(ctx.tools, res.delete.tool)?.inputSchema), { step });
  const back = await s.driver!.readOnce(label, ctx.session.stepId('ann2.readback'));
  if (r.timed_out || r.transport_error !== null) return { replaced: false, detail: '', steps: [step], skipped: 'the delete timed out or lost the connection; the outcome is unknown' };
  // why: only a definite not-found counts as deleted; any other read failure leaves the object in the ledger for cleanup.
  const deleted = r.ok && !!back.call && (definitelyGone(back.call) || (back.call.ok && !!res.read.items && back.obj === null));
  return { replaced: deleted, unnamed: deleted ? ['(the object was deleted)'] : [], detail: 'it deleted the object', steps: [step] };
}

/** A create with a caller-chosen key, called again with the same key (MWS-ANN-2 "an object of the same name"). */
async function sameKeyCreate(ctx: RunContext, res: ResourceSpec, label: string): Promise<NonNullable<ToolObs['ann2']>> {
  if (!cleanable(res)) return { replaced: false, detail: '', steps: [], skipped: 'needs a cleanup policy' };
  const key = ctx.marker('a2k');
  const { baseVars, Driver } = await import('../core/driver.js');
  const args1 = render(res.create!.args, baseVars(res, ctx.prefix, { key, marker: key })) as Record<string, unknown>;
  const c = await createVerified(ctx.session, ctx.ledger, res, ctx.prefix, { tool: res.create!.tool, args: args1, purpose: 'MWS-ANN-2 object to create again by key', label, step: ctx.session.stepId('ann2.key.first') });
  if (!c.ok) return { replaced: false, detail: '', steps: [], skipped: `the first create failed: ${c.reason}` };
  const dd = new Driver(ctx.session, ctx.manifest, res, ctx.prefix, ctx.env);
  dd.id = c.id;
  const before = await dd.readOnce(label, ctx.session.stepId('ann2.key.before'));
  const v = res.key!.vary;
  const args2 = v ? { ...args1, [v.arg]: typeof args1[v.arg] === 'string' ? `${String(args1[v.arg])}-again` : `${ctx.prefix}again` } : args1;
  const intent = ctx.ledger.intent(res.name, res.create!.tool, 'MWS-ANN-2 second create with the same key');
  const step = ctx.session.stepId('ann2.key.second');
  const r = await ctx.session.call(label, res.create!.tool, args2, { step });
  // why: an accepted second create is ledgered by the id its answer gives (the same key dedupes with the first); without one, the outcome is unknown.
  const id2 = r.ok ? idFromResult(res, r) : null;
  ctx.ledger.append(id2 !== null ? { kind: 'created', intent, resource: res.name, id: id2, name: null, via: 'result' } : r.ok || r.timed_out || r.transport_error ? { kind: 'create_unknown', intent, resource: res.name, reason: 'a second create with the same key was accepted without an id in its answer' } : { kind: 'create_failed', intent, resource: res.name, reason: 'refused' });
  const after = await dd.readOnce(label, ctx.session.stepId('ann2.key.after'));
  if (!before.ok || !after.ok) return { replaced: false, detail: '', steps: [step], skipped: 'the object did not read back around the second create' };
  const lost = lostPaths(before.obj, after.obj, ignoredPaths(res));
  // why: a create does not identify the existing object as its target, so every value it replaced counts as not named (spec MWS-ANN-2).
  return { replaced: lost.length > 0, unnamed: lost, detail: `a second create with the same key changed ${lost.join(', ')}`, steps: [step] };
}

/** A create (no caller-chosen key): it must leave the object under test as it was. */
async function createLeavesOthers(ctx: RunContext, d: Driver, res: ResourceSpec, label: string, ign: string[]): Promise<NonNullable<ToolObs['ann2']>> {
  if (!cleanable(res)) return { replaced: false, detail: '', steps: [], skipped: 'needs a cleanup policy' };
  if (d.id === null || d.id === undefined) return { replaced: false, detail: '', steps: [], skipped: 'no existing object to watch' };
  const before = await d.readOnce(label, ctx.session.stepId('ann2.create.before'));
  const s = await scratch(ctx, res, { tag: 'a2c', purpose: 'MWS-ANN-2 a create beside an existing object', label });
  const after = await d.readOnce(label, ctx.session.stepId('ann2.create.after'));
  if (!s.ok) return { replaced: false, detail: '', steps: [], skipped: `the create failed: ${s.reason}` };
  if (!before.ok || !after.ok) return { replaced: false, detail: '', steps: [], skipped: 'the existing object did not read back around the create' };
  const lost = lostPaths(before.obj, after.obj, ign);
  return { replaced: lost.length > 0, unnamed: lost, detail: `the existing object changed: ${lost.join(', ')}`, steps: [] };
}

async function repeatUpdate(ctx: RunContext, d: Driver, res: ResourceSpec, label: string, ign: string[]): Promise<NonNullable<ToolObs['ann3']>> {
  const f = res.fields![0];
  if (!(await d.reset())) return { first_ok: false, second_ok: false, changed: [], steps: [], skipped: 'the object could not be reset' };
  const before = await d.readOnce(label, ctx.session.stepId('ann3.before'));
  const base = { obj: before.obj, version: before.version };
  const s1 = ctx.session.stepId('ann3.first');
  const r1 = await d.update(label, f, f.values[1], { step: s1, base });
  const a1 = await d.readSettled(label, 'ann3.after1', (o) => deepEqual(valueAt(o, f.path), f.values[1]));
  // why: the second call sends the same arguments; for a versioned tool that includes the same (now old) version.
  const s2 = ctx.session.stepId('ann3.second');
  const r2 = await ctx.session.call(label, res.update!.tool, d.updateArgs(f, f.values[1], base), { step: s2 });
  const a2 = await d.readSettled(label, 'ann3.after2', () => false);
  await d.reset();
  if ([r1, r2].some((r) => r.timed_out || r.transport_error !== null)) return { first_ok: false, second_ok: false, changed: [], steps: [s1, s2], skipped: 'a call timed out or lost the connection; the outcome is unknown' };
  return { first_ok: r1.ok, second_ok: r2.ok, changed: a1.ok && a2.ok ? withoutIgnored(diff(a1.obj, a2.obj), ign).slice(0, 10) : [], steps: [s1, s2] };
}

async function repeatCreate(ctx: RunContext, res: ResourceSpec, label: string): Promise<NonNullable<ToolObs['ann3']>> {
  if (!cleanable(res)) return { first_ok: false, second_ok: false, changed: [], steps: [], skipped: 'needs a cleanup policy (it creates objects)' };
  const marker = ctx.marker('a3c');
  const { baseVars } = await import('../core/driver.js');
  const args = render(res.create!.args, baseVars(res, ctx.prefix, { scope: ctx.driver.scope, marker, key: marker }));
  const s1 = ctx.session.stepId('ann3.create1');
  const s2 = ctx.session.stepId('ann3.create2');
  const c1 = await createVerified(ctx.session, ctx.ledger, res, ctx.prefix, { tool: res.create!.tool, args, purpose: 'MWS-ANN-3 repeated create (1)', label, step: s1 });
  const c2 = await createVerified(ctx.session, ctx.ledger, res, ctx.prefix, { tool: res.create!.tool, args, purpose: 'MWS-ANN-3 repeated create (2)', label, step: s2 });
  // why: a second answer whose id cannot be found is no evidence of a second object.
  const id2 = c2.ok ? c2.id : c2.call?.ok ? idFromResult(res, c2.call) : null;
  if (c2.call?.ok && id2 === null) return { first_ok: c1.ok, second_ok: true, changed: [], steps: [s1, s2], skipped: 'the second create succeeded but its answer carries no id the manifest can find' };
  return { first_ok: c1.ok, second_ok: c2.ok || c2.call?.ok === true, changed: [], ids: [c1.id, id2], steps: [s1, s2] };
}

export function annotationVerdicts(tools: ToolObs[], createdWith: string[], res: ResourceSpec): Result[] {
  const sc = { id: ID, version: VERSION };
  const out: Result[] = [];
  const add = (id: RequirementId, tool: string, verdict: Verdict, reason: string, o: { numbers?: Record<string, unknown>; steps?: string[]; notes?: string[] } = {}) => out.push(result(id, wp(res.name, tool), sc, verdict, reason, o));
  const watched = 'Only this run\'s objects were watched, not the whole system (spec 8.2, rule 8).';
  for (const t of tools) {
    const a = t.annotations;
    // MWS-ANN-1
    if (a['readOnlyHint'] !== true) add('MWS-ANN-1', t.tool, 'not applicable', `${t.tool} does not declare readOnlyHint: true`, { notes: [ruleNote('CONSERVATIVE_ANNOTATION', 'no read-only claim to test')] });
    else if (t.role === 'create') {
      if (createdWith.includes(t.tool)) add('MWS-ANN-1', t.tool, 'violated', `${t.tool} declares readOnlyHint: true, but this run created objects with it.`);
      else add('MWS-ANN-1', t.tool, 'not tested', `${t.tool} was not called in this run`);
    } else if (t.role === 'delete') add('MWS-ANN-1', t.tool, 'not tested', `${t.tool} is the resource's delete tool; it is not called only to watch it`);
    else if (t.ann1?.skipped) add('MWS-ANN-1', t.tool, 'not tested', t.ann1.skipped);
    else if (t.ann1 && t.ann1.changed.length) add('MWS-ANN-1', t.tool, 'violated', `${t.tool} declares readOnlyHint: true, but after ${t.ann1.calls} call(s) the object changed: ${t.ann1.changed.map((e) => e.path).join(', ')}.`, { steps: t.ann1.steps });
    else if (t.ann1) add('MWS-ANN-1', t.tool, 'not observed', `No change to this run's object in ${t.ann1.calls} call(s) of ${t.tool}. ${watched}`, { numbers: { calls: t.ann1.calls } });
    // MWS-ANN-2
    if (a['readOnlyHint'] === true) {
      /* a read-only claim is judged by MWS-ANN-1 */
    } else if (a['destructiveHint'] !== false) add('MWS-ANN-2', t.tool, 'not applicable', `${t.tool} does not declare destructiveHint: false`, { notes: [ruleNote('CONSERVATIVE_ANNOTATION', 'the default is destructive')] });
    else if (!t.ann2) add('MWS-ANN-2', t.tool, 'not tested', `${t.tool} has no role in the manifest that lets the tester exercise it`);
    else if (t.ann2.skipped) add('MWS-ANN-2', t.tool, 'not tested', t.ann2.skipped);
    else if (t.ann2.unnamed?.length) add('MWS-ANN-2', t.tool, 'violated', `${t.tool} declares destructiveHint: false, but it ${t.ann2.unnamed.includes('(the object was deleted)') ? 'deleted the object' : `removed or replaced data its arguments did not name: ${t.ann2.unnamed.slice(0, 5).join(', ')}`}.`, { steps: t.ann2.steps });
    else add('MWS-ANN-2', t.tool, 'not observed', `${t.tool} deleted nothing and removed or replaced no data its arguments did not name, in the forced call. ${watched}`, { numbers: { calls: 1 } });
    // MWS-ANN-5 (SHOULD, "at risk"): additive updates only, the schema's own reading.
    if (a['readOnlyHint'] === true || a['destructiveHint'] !== false) {
      if (a['readOnlyHint'] !== true) add('MWS-ANN-5', t.tool, 'not applicable', `${t.tool} does not declare destructiveHint: false`);
    } else if (!t.ann2) add('MWS-ANN-5', t.tool, 'not tested', `${t.tool} has no role in the manifest that lets the tester exercise it`);
    else if (t.ann2.skipped) add('MWS-ANN-5', t.tool, 'not tested', t.ann2.skipped);
    else if (t.ann2.replaced) add('MWS-ANN-5', t.tool, 'violated', `${t.tool} declares destructiveHint: false ("only additive updates"), but ${t.ann2.detail}.`, { steps: t.ann2.steps });
    else add('MWS-ANN-5', t.tool, 'not observed', `${t.tool} changed or removed nothing that was watched in the forced call. ${watched}`, { numbers: { calls: 1 } });
    // MWS-ANN-3
    if (a['readOnlyHint'] === true) {
      /* judged by MWS-ANN-1 */
    } else if (a['idempotentHint'] !== true) add('MWS-ANN-3', t.tool, 'not applicable', `${t.tool} does not declare idempotentHint: true`, { notes: [ruleNote('CONSERVATIVE_ANNOTATION', 'no idempotency claim to test')] });
    else if (!t.ann3) add('MWS-ANN-3', t.tool, 'not tested', `${t.tool} has no role in the manifest that lets the tester repeat it`);
    else if (t.ann3.skipped) add('MWS-ANN-3', t.tool, 'not tested', t.ann3.skipped);
    else if (t.role === 'create') {
      const [i1, i2] = t.ann3.ids ?? [];
      if (!t.ann3.first_ok || !t.ann3.second_ok) add('MWS-ANN-3', t.tool, 'not observed', `The repeated create ${t.ann3.first_ok ? 'was refused the second time' : 'did not succeed'}; no second object was seen. ${watched}`, { numbers: { calls: 2 } });
      else if (!deepEqual(i1, i2)) add('MWS-ANN-3', t.tool, 'violated', `${t.tool} declares idempotentHint: true, but the same call made two objects (${short(i1, 30)}, ${short(i2, 30)}).`, { steps: t.ann3.steps });
      else add('MWS-ANN-3', t.tool, 'not observed', `The same create, called twice, returned the same object. ${watched}`, { numbers: { calls: 2 } });
    } else if (!t.ann3.first_ok) add('MWS-ANN-3', t.tool, 'not tested', 'the first call did not succeed');
    else if (t.ann3.changed.length) add('MWS-ANN-3', t.tool, 'violated', `${t.tool} declares idempotentHint: true, but calling it again with the same arguments changed ${t.ann3.changed.map((e) => e.path).join(', ')}.`, { steps: t.ann3.steps });
    else add('MWS-ANN-3', t.tool, 'not observed', `Calling ${t.tool} again with the same arguments changed nothing watched (ignored: ${ignoredPaths(res).join(', ') || 'none'}). ${watched}`, { numbers: { calls: 2 }, notes: t.ann3.second_ok ? [] : ['The second call was refused; refusing is no further effect.'] });
  }
  return out;
}

/** Non-additive changes (lists as multisets), without the ignored and version paths. */
function lostPaths(before: unknown, after: unknown, ignore: string[]): string[] {
  return nonAdditive(before, after).filter((p) => !ignore.some((i) => p === i || p.startsWith(`${i}.`) || p.startsWith(`${i}[`)));
}

/**
 * Does the call name the data at `path` (spec MWS-ANN-2)? A field is named when the call passes a value for it
 * (by its top-level name); a list element or a key is named when the call passes its identifier.
 */
export function namedBy(args: Record<string, unknown>, before: unknown, path: string): boolean {
  const segs = parsePath(path);
  if (typeof segs[0] === 'string' && Object.hasOwn(args, segs[0])) return true;
  const passed: unknown[] = [];
  const walk = (v: unknown): void => {
    passed.push(v);
    if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
  };
  walk(args);
  const has = (x: unknown): boolean => x !== undefined && passed.some((v) => deepEqual(v, x));
  // why: an element counts as named when the call passes it, or its id or key, for any list element on the path.
  for (let k = 1; k <= segs.length; k++) {
    if (typeof segs[k - 1] !== 'number') continue;
    const el = getPath(before, segs.slice(0, k));
    // A position the caller passed (in an argument named like a position or an index) names the element too.
    if (Object.entries(args).some(([name, v]) => /position|index|^pos$|^idx$/i.test(name) && v === segs[k - 1])) return true;
    if (el !== null && typeof el === 'object') {
      const o = el as Record<string, unknown>;
      if (has(o['id']) || has(o['key']) || has(o['name'])) return true;
    } else if (has(el)) return true;
  }
  return false;
}
