/**
 * Multi-item writes (MWS-ATOM-1, MWS-ATOM-2): a tool that writes several objects in one call.
 *
 *   black-box      (when the declaration names an item the backend will refuse) three calls, the
 *                  refused item first, in the middle and last among two good ones
 *   proxy-assisted (with the backend gate) a learning pass counts the call's mutating backend
 *                  requests; then the second and the last of them are failed (status 500, not
 *                  forwarded) on a fresh set of three items
 *
 * Every item is read back after each call and compared with the answer: a call that did not apply
 * every item must not report success (ATOM-1), an item that stayed applied must be named in the
 * answer (ATOM-1), the items the answer lists as applied (at the declared report path) must be the
 * ones that were (ATOM-1), and a failed call should leave none of its changes applied (ATOM-2).
 * Items are created through the platform's API when control.create is declared, so their setup
 * does not depend on the tool under test.
 */

import { multiBinding } from '../core/manifest.js';
import { baseVars, valueAt, type Driver } from '../core/driver.js';
import type { MultiSpec, ResourceSpec } from '../core/manifest.js';
import { goneFrom } from '../core/objects.js';
import { render, templateRoots } from '../core/template.js';
import { deepEqual, getPath, isObj, short } from '../core/util.js';
import { lastMutating, MUTATING } from '../gate/gate.js';
import { result, type Result } from '../report/verdicts.js';
import { listScope, newScope, scratch } from './scratch.js';
import { tgt1HeldFor } from './targeting.js';
import { multiRes1 } from './effects.js';
import { decidedByShape, itemStatus, quoteField, shapeFallbackNote, shapeOf } from './shape.js';
import { lostAnswerVerdict, type LostAnswerObs } from './gated.js';
import { SYNTHETIC_FAULT } from './writefaults.js';
import { appliedAllSaid, appliedAllUnread, brief, forPatterns, mentions, res2Judge, textStatement, wp, type CallBrief, type CheckModule, type Observation, type PlanContext, type PlannedCheck, type RunContext } from './types.js';

const ID = 'multi-item';
// why: 3: both lanes changed what the scenario sends, and the version enters every record's test_hash. From 2 (spec 13.6): with the gate,
// the learning pass is read back (the settled outcome, R9-1) and a lost-answer trial follows the failed-request trials (MWS-RES-2).
// From this lane: the check also sends a call on good items only where there is no gate (MWS-RES-1, effects.ts multiRes1), and the
// learning pass is that call where the gate runs one.
const VERSION = '3';

export interface MultiTrial {
  kind: 'invalid item' | 'failed backend write';
  /** Where the refused item was (black-box), or which mutating request failed (proxy). */
  position: string;
  call: CallBrief | null;
  items: unknown[];
  /** Items that hold the declared effect after the call. */
  applied: unknown[];
  /** Items the answer lists as applied (at the declared report path), when declared and present. */
  reported: unknown[] | null;
  skipped?: string;
  /** The item list the call sent, in order (B-9 v2 items[].index is a position in it); absent in older evidence. */
  order?: unknown[];
}

export interface MultiObs {
  tool: string;
  /** The tool was not called at all, and why (a multi-item delete with no container of the tester's own). */
  skipped?: string;
  routing: string | null;
  mutating_in_learning: number | null;
  trials: MultiTrial[];
  /** The items sit in a container the tester created (applied_count is compared there, and where the call names only the trial's own items). */
  own_container?: boolean;
  /** MWS-RES-1: a call on good items only (the learning pass where the gate runs one), and the items that hold the effect after it (null: a read-back with an unknown outcome). */
  clean?: { call: CallBrief | null; items: unknown[]; applied: unknown[] | null; skipped?: string };
  /** MWS-RES-2, the lost answer (with the gate): the last mutating request of the learning pass applied and its answer cut; absent in older evidence. */
  lost?: MultiTrial & { requests: { seq: number; method: string; path: string; status: number | null }[]; faulted: { seq: number; method: string; path: string; status: number | null } | null };
  /** The learning pass, for the clause on a settled outcome (R9-1); absent in older evidence. */
  learn?: { call: CallBrief; requests: { seq: number; method: string; path: string; status: number | null }[]; applied: boolean | null };
}

const cleanable = (res: ResourceSpec) => !!res.cleanup && res.cleanup !== 'leave';

export const multiCheck: CheckModule = {
  id: ID,
  version: VERSION,
  requirements: ['MWS-ATOM-1', 'MWS-ATOM-2', 'MWS-RES-1', 'MWS-RES-2'],
  plan(ctx: PlanContext, res: ResourceSpec): PlannedCheck {
    const base: PlannedCheck = { check: ID, version: VERSION, resource: res.name, runs: false, calls: [], writes: 0, creates: 0, notRun: [] };
    const sc = { id: ID, version: VERSION };
    const calls: string[] = [];
    const nr: Result[] = [];
    let writes = 0;
    let creates = 0;
    for (const m of res.multi) {
      const w = wp(res.name, m.tool);
      if (!cleanable(res)) {
        nr.push(...(['MWS-ATOM-1', 'MWS-ATOM-2', 'MWS-RES-1', 'MWS-RES-2'] as const).map((id) => result(id, w, id === 'MWS-RES-2' ? { id: `${ID}.res2`, version: VERSION } : sc, 'not tested', 'needs a cleanup policy (it creates the items)')));
        continue;
      }
      const bb = m.invalid_id !== null;
      const px = !!ctx.manifest.backend?.gate;
      // why: B-GAP F4: a multi-item tool's failed request and lost answer are brought about through the gate; without it, say so.
      if (!px) nr.push(result('MWS-RES-2', w, { id: `${ID}.res2`, version: VERSION }, 'not tested', `a failed or lost backend answer for ${m.tool} is brought about through backend.gate, which the declaration does not configure`));
      // why: the call on good items only (MWS-RES-1) needs neither invalid_id nor the gate; only the ATOM trials do (multiVerdicts says so).
      if (!px) calls.push(`${m.tool}: 2 good items only; read every item back (MWS-RES-1)`);
      if (bb) calls.push(`${m.tool}: 2 good items and the refused item ${JSON.stringify(m.invalid_id)} first, in the middle, last; read every item back`);
      if (px) calls.push(`${m.tool}: learning pass on 3 items, read back (MWS-RES-1); then fail the 2nd and the last mutating backend request, each on 3 fresh items (MWS-ATOM-1/2 and MWS-RES-2); let the last one through and cut its answer, on 3 fresh items (MWS-RES-2, lost answer); read every item back`);
      writes += (bb ? 3 * 3 : 0) + (px ? 5 * 4 : 0) + (px ? 0 : 3);
      creates += (bb ? 2 : 0) + (px ? 12 : 2) + (res.scope ? 1 : 0);
    }
    return { ...base, runs: calls.length > 0, calls, writes, creates, notRun: nr };
  },
  async collect(ctx: RunContext, res: ResourceSpec): Promise<Observation> {
    const out: MultiObs[] = [];
    if (cleanable(res)) for (const m of res.multi) out.push(await runMulti(ctx, res, m));
    return { check: ID, version: VERSION, resource: res.name, data: { tools: out } };
  },
  evaluate(obs: Observation, ctx: PlanContext): Result[] {
    const res = ctx.manifest.resources.find((r) => r.name === obs.resource)!;
    return (obs.data as { tools: MultiObs[] }).tools.flatMap((m) => {
      const spec = res.multi.find((x) => x.tool === m.tool)!;
      return [...multiVerdicts(m, res, spec), multiRes1(m, res, spec, ctx.manifest.async_operations ?? [], { id: ID, version: VERSION }), ...multiRes2Verdicts(m, res, ctx.manifest.async_operations ?? [])];
    });
  },
};

async function items(ctx: RunContext, res: ResourceSpec, scope: unknown, batch: string, n: number, label: string, mine: unknown[] = []): Promise<Driver[]> {
  const out: Driver[] = [];
  for (let i = 1; i <= n; i++) {
    const s = await scratch(ctx, res, { tag: 'mi', purpose: 'MWS-ATOM item', label, via: 'control', scope, marker: `${batch}-${i}` });
    if (s.id !== null && s.id !== undefined) mine.push(s.id);
    if (s.ok) out.push(s.driver!);
  }
  return out;
}

/** The items that hold the effect; null when an item's read-back has an unknown outcome (the trial is then not judged). */
async function appliedOf(ctx: RunContext, m: MultiSpec, ds: Driver[], label: string): Promise<unknown[] | null> {
  const applied: unknown[] = [];
  for (const d of ds) {
    const r = await d.readOnce(label, ctx.session.stepId('multi.readback'));
    if (m.effect === 'deleted') {
      const g = goneFrom(d.res, r);
      if (g === null) return null;
      if (g) applied.push(d.id);
    } else {
      if (!r.ok) return null;
      if (deepEqual(valueAt(r.obj, m.effect.path), m.effect.value)) applied.push(d.id);
    }
  }
  return applied;
}

function reportedOf(m: MultiSpec, b: CallBrief): unknown[] | null {
  if (!m.report) return null;
  const list = getPath(b.data, m.report.applied);
  if (!Array.isArray(list)) return null;
  return list.map((x) => (m.report!.id ? getPath(x, m.report!.id) : x));
}

/** A value under the scope argument's name inside a nested object of the call that is not {{scope}} (owners' safety item 2). */
function nestedScope(args: unknown, arg: string, path = '', depth = 0): { path: string; value: unknown } | null {
  if (Array.isArray(args)) {
    for (const [i, v] of args.entries()) {
      const f = nestedScope(v, arg, `${path}[${i}]`, depth + 1);
      if (f) return f;
    }
    return null;
  }
  if (!isObj(args)) return null;
  for (const [k, v] of Object.entries(args)) {
    const p = path ? `${path}.${k}` : k;
    if (depth > 0 && k === arg && !templateRoots(v ?? null).has('scope')) return { path: p, value: v };
    const f = nestedScope(v, arg, p, depth + 1);
    if (f) return f;
  }
  return null;
}

/**
 * May this multi-item tool be sent here? The one gate for every caller (note 27: the CFG-3 read-only check and the CFG-2
 * deny filters called every multi-item tool with its declared arguments, outside the gates of the multi-item check, and a bulk
 * delete reached bystanders). Null where it may, else why not. A tool bound to neither {{ids}} nor {{scope}} is never sent; a
 * scope-bound delete (and, outside the multi-item check, a tool bound by scope alone) only where MWS-TGT-1 is held for it.
 */
export function multiGate(ctx: Pick<RunContext, 'session'>, res: ResourceSpec, m: MultiSpec, where: 'atom' | 'cfg3'): string | null {
  const args = JSON.stringify(m.args ?? null);
  const bind = multiBinding(m.args, res.scope?.arg ?? null);
  const byScope = bind.scope;
  const byIds = bind.ids;
  const deletes = m.effect === 'deleted';
  if (!byScope && !byIds) return `${m.tool} binds neither {{ids}} nor {{scope}}, so it would choose its objects some other way; it is not called (spec 7.3, rule 1)`;
  // why: exact ids (the tester's own objects) bound the call; a scope alone does not. A bulk update that the scope alone bounds acts
  // on every object in the scope it is given, as a delete does (spec 7.3, rule 1; owners' safety item 1): the same gates for both.
  const scoped = byScope && (deletes || !byIds);
  if (scoped && !tgt1HeldFor(ctx, m.tool)) return `${m.tool} is told its container by the scope argument${res.scope ? ` ${res.scope.arg}` : ''}, and MWS-TGT-1 has not been run for ${m.tool} with the verdict held in this run${res.selector?.tool === m.tool ? ' (it is run for the selector tool only with selector.narrow and selector.send_empty_forms, and only where MWS-TGT-1 is held for the create tool)' : ' (MWS-TGT-1 is built only for the selector tool)'}, so it is not called (spec 7.3, rule 1)`;
  // why: review of v8 (BL-5, note 31): MWS-TGT-1 held shows the tool keeps to the container it is told, not that the
  // container holds only the tester's objects. Only {{scope}} under the scope argument itself tells it the container the tester
  // created and confirmed; a literal there, or {{scope}} under another key with the scope argument left out, names another one.
  const told = res.scope && isObj(m.args) && Object.hasOwn(m.args, res.scope.arg) ? (m.args as Record<string, unknown>)[res.scope.arg] : undefined;
  if (scoped && !templateRoots(told ?? null).has('scope')) return `${m.tool} is told its container by the scope argument${res.scope ? ` ${res.scope.arg}` : ''}, and its multi-item arguments do not give that argument the tester's container ({{scope}}): ${told === undefined ? `${res.scope?.arg ?? 'the scope argument'} is not sent, so the tool acts in its default container` : `${res.scope!.arg} is ${JSON.stringify(short(told, 60))}, a container the tester did not create`}. MWS-TGT-1 held for ${m.tool} shows that it keeps to the container it is told, not that this container holds only the tester's objects, so it is not called (spec 7.3, rule 1)`;
  // why: owners' safety item 2: a scope named inside a nested object ({ filter: { project: "inbox" } }) names a container the tester
  // did not create, whatever the top-level scope argument says; only {{scope}} may stand under the scope argument's name.
  const nested = res.scope ? nestedScope(m.args, res.scope.arg) : null;
  if (nested) return `${m.tool}'s multi-item arguments name a container inside a nested object (${nested.path} = ${JSON.stringify(short(nested.value, 60))}), not the tester's container ({{scope}}); a server that reads it acts in a container the tester did not create, so it is not called (spec 7.3, rule 1)`;
  return null;
}

async function runMulti(ctx: RunContext, res: ResourceSpec, m: MultiSpec): Promise<MultiObs> {
  const label = ctx.label('ATOM');
  const o: MultiObs = { tool: m.tool, routing: ctx.gate?.describe() ?? null, mutating_in_learning: null, trials: [] };
  // why (review of note 8, 12; spec 7.3, first rule): a tool whose effect deletes is called only inside a container the tester
  // created and confirmed holds nothing but its own objects. Never in the run scope as a fallback, which is the server's
  // default (holding objects the tester did not create) where the run scope could not be created.
  const deletes = m.effect === 'deleted';
  const rule = `${m.tool} deletes, and a multi-item delete is called only inside a container the tester created and confirmed holds nothing but its own objects (spec 7.3)`;
  // why (re-review 1; spec 7.3, rule 1): where the container is named to a deleting tool by a scope argument, a server that
  // ignores the argument deletes in its default scope; the tool is called only where MWS-TGT-1 was run for it with the verdict
  // held in this run (the selector tool's MWS-TGT-1, run with selector.narrow and selector.send_empty_forms).
  const gate = multiGate(ctx, res, m, 'atom');
  if (gate) return { ...o, skipped: gate };
  const bound = multiBinding(m.args, res.scope?.arg ?? null);
  const scopeOnly = bound.scope && !bound.ids;
  let scope: unknown = ctx.driver.scope;
  if (res.scope) {
    const s = await newScope(ctx, res, 'ma', label);
    if (s.ok) (scope = s.key), (o.own_container = true);
    else if (deletes || scopeOnly) return { ...o, skipped: `the container for its items could not be created (${s.reason}); ${scopeOnly && !deletes ? `${m.tool} is bounded by its container alone, and is called only inside a container the tester created and confirmed holds nothing but its own objects (spec 7.3, rule 1)` : rule}` };
  } else if (deletes || scopeOnly) return { ...o, skipped: `the resource declares no scope (a container the tester can create for the items); ${scopeOnly && !deletes ? `${m.tool} is bounded by its container alone, and is called only inside a container the tester created and confirmed holds nothing but its own objects (spec 7.3, rule 1)` : rule}` };
  const mine: unknown[] = [];
  if (deletes) {
    const empty = await listScope(ctx, res, scope, label);
    if (empty === null || empty.length) return { ...o, skipped: `${empty === null ? 'the new container could not be listed' : `the new container already holds ${empty.length} object(s)`}; ${rule}` };
  }
  /** Before a call that deletes: the container lists only objects the tester created in it. Null where it does, else why not. */
  const unconfirmed = async (): Promise<string | null> => {
    if (!deletes) return null;
    const listed = await listScope(ctx, res, scope, label);
    if (listed === null) return `the container could not be listed before the call; ${rule}`;
    const other = listed.filter((it) => !mine.some((id) => deepEqual(id, it.id)));
    return other.length ? `the container lists ${other.length} object(s) the tester did not create in it; ${rule}` : null;
  };
  const call = async (ds: Driver[], ids: unknown[], batch: string, tag: string): Promise<CallBrief> => {
    const args = render(m.args, baseVars(res, ctx.prefix, { scope, ids, batch }));
    return brief(await ctx.session.call(label, m.tool, args, { step: ctx.session.stepId(`multi.${tag}`) }));
  };
  // MWS-RES-1: without the gate's learning pass, one call on good items only (with the gate, the learning pass is that call).
  if (!ctx.gate) {
    const batch = ctx.marker('mc');
    const ds = await items(ctx, res, scope, batch, 2, label, mine);
    const no = ds.length === 2 ? await unconfirmed() : 'the items could not be created';
    if (no) o.clean = { call: null, items: ds.map((d) => d.id), applied: [], skipped: no };
    else {
      const b = await call(ds, ds.map((d) => d.id), batch, 'clean');
      o.clean = { call: b, items: ds.map((d) => d.id), applied: await appliedOf(ctx, m, ds, label) };
    }
  }
  if (m.invalid_id !== null) {
    const batch = ctx.marker('mb');
    const ds = await items(ctx, res, scope, batch, 2, label, mine);
    if (ds.length < 2) o.trials.push({ kind: 'invalid item', position: 'all', call: null, items: [], applied: [], reported: null, skipped: 'the items could not be created' });
    else
      for (const pos of ['first', 'middle', 'last'] as const) {
        const good = ds.map((d) => d.id);
        const ids = pos === 'first' ? [m.invalid_id, ...good] : pos === 'middle' ? [good[0], m.invalid_id, good[1]] : [...good, m.invalid_id];
        const before = await appliedOf(ctx, m, ds, label);
        if (before === null || before.length) {
          o.trials.push({ kind: 'invalid item', position: pos, call: null, items: good, applied: before ?? [], reported: null, skipped: before === null ? 'an item could not be read before the call' : 'an item already held the effect before the call (an earlier position applied it)' });
          break;
        }
        const no = await unconfirmed();
        if (no) {
          o.trials.push({ kind: 'invalid item', position: pos, call: null, items: good, applied: [], reported: null, skipped: no });
          break;
        }
        const b = await call(ds, ids, batch, `invalid.${pos}`);
        const applied = await appliedOf(ctx, m, ds, label);
        o.trials.push({ kind: 'invalid item', position: pos, call: b, items: good, applied: applied ?? [], reported: reportedOf(m, b), order: ids, ...(applied === null ? { skipped: 'an item\'s read-back has an unknown outcome' } : {}) });
        if (applied === null || applied.length) break;
      }
  }
  if (ctx.gate) {
    const gate = ctx.gate;
    const batch = ctx.marker('ml');
    const ds = await items(ctx, res, scope, batch, 3, label, mine);
    const no = ds.length === 3 ? await unconfirmed() : null;
    if (no || ds.length !== 3) o.clean = { call: null, items: ds.map((d) => d.id), applied: [], skipped: no ?? 'the items could not be created' };
    if (no) o.trials.push({ kind: 'failed backend write', position: 'learning pass', call: null, items: ds.map((d) => d.id), applied: [], reported: null, skipped: no });
    else if (ds.length === 3) {
      const mark = gate.mark();
      const lc = await call(ds, ds.map((d) => d.id), batch, 'learn');
      const reqs = await gate.since(mark);
      const muts = reqs.filter((r) => MUTATING.has(r.method));
      o.mutating_in_learning = muts.length;
      const la = await appliedOf(ctx, m, ds, label);
      o.clean = { call: lc, items: ds.map((d) => d.id), applied: la };
      o.learn = { call: lc, requests: reqs.map((q) => ({ seq: q.seq, method: q.method, path: q.path, status: q.status })), applied: la === null ? null : la.length === ds.length };
      if (lastMutating(reqs))
        for (const k of [...new Set([2, muts.length])].filter((k) => k <= muts.length)) {
          const b2 = ctx.marker('mf');
          const fresh = await items(ctx, res, scope, b2, 3, label, mine);
          if (fresh.length !== 3) continue;
          const no2 = await unconfirmed();
          if (no2) {
            o.trials.push({ kind: 'failed backend write', position: `mutating request ${k}`, call: null, items: fresh.map((d) => d.id), applied: [], reported: null, skipped: no2 });
            break;
          }
          const f = gate.fault({ method: '*', path: '*', nth: k, kind: 'status', status: 500 });
          const b = await call(fresh, fresh.map((d) => d.id), b2, `fault.${k}`);
          const hit = await f.waitHit(500);
          f.clear();
          const applied = await appliedOf(ctx, m, fresh, label);
          o.trials.push({ kind: 'failed backend write', position: hit ? `mutating request ${k} of ${muts.length} (${hit.method} ${hit.path}) failed with status 500, not forwarded` : `mutating request ${k}: the fault was not applied`, call: b, items: fresh.map((d) => d.id), applied: applied ?? [], reported: reportedOf(m, b), order: fresh.map((d) => d.id), ...(!hit ? { skipped: 'the fault was not applied' } : applied === null ? { skipped: 'an item\'s read-back has an unknown outcome' } : {}) });
        }
      // MWS-RES-2, the lost answer: the last mutating request of the learning pass reaches the backend, which applies it, and the
      // connection is closed before the server receives the answer; read every item back (spec MWS-RES-2, proxy-assisted).
      if (muts.length) {
        const b3 = ctx.marker('mu');
        const fresh = await items(ctx, res, scope, b3, 3, label, mine);
        const no3 = fresh.length === 3 ? await unconfirmed() : null;
        if (fresh.length !== 3 || no3) o.lost = { kind: 'failed backend write', position: 'lost answer', call: null, items: fresh.map((d) => d.id), applied: [], reported: null, skipped: no3 ?? 'the items could not be created', requests: [], faulted: null };
        else {
          const f = gate.fault({ method: '*', path: '*', nth: muts.length, kind: 'commit_then_reset' });
          const mk = gate.mark();
          const b = await call(fresh, fresh.map((d) => d.id), b3, 'lost');
          const hit = await f.waitHit(1000);
          f.clear();
          const rq = (await gate.since(mk)).map((q) => ({ seq: q.seq, method: q.method, path: q.path, status: q.status }));
          const applied = await appliedOf(ctx, m, fresh, label);
          o.lost = { kind: 'failed backend write', position: hit ? `mutating request ${muts.length} of ${muts.length} (${hit.method} ${hit.path}) applied by the backend, its answer cut` : 'lost answer: the fault was not applied', call: b, items: fresh.map((d) => d.id), applied: applied ?? [], reported: reportedOf(m, b), order: fresh.map((d) => d.id), requests: rq, faulted: hit ? { seq: hit.seq, method: hit.method, path: hit.path, status: hit.status } : null, ...(!hit ? { skipped: 'the fault was not applied (different backend requests than in the learning pass)' } : applied === null ? { skipped: "an item's read-back has an unknown outcome" } : {}) };
        }
      }
    }
  }
  return o;
}

export function multiVerdicts(o: MultiObs, res: ResourceSpec, m: MultiSpec): Result[] {
  const w = wp(res.name, o.tool);
  const sc = { id: ID, version: VERSION };
  if (o.skipped) return (['MWS-ATOM-1', 'MWS-ATOM-2'] as const).map((id) => result(id, w, sc, 'not tested', `${o.tool} was not called: ${o.skipped}`));
  if (!o.trials.length && m.invalid_id === null && o.routing === null) return (['MWS-ATOM-1', 'MWS-ATOM-2'] as const).map((id) => result(id, w, sc, 'not tested', 'declare invalid_id (an item the backend refuses) for the black-box positions, or configure backend.gate to fail a backend write'));
  const t = o.trials.filter((x) => !x.skipped && x.call && !x.call.indeterminate);
  const notes = [...(o.routing && o.trials.some((x) => x.kind === 'failed backend write') ? [`Route: ${o.routing}`] : []), ...(o.mutating_in_learning !== null ? [`learning pass: ${o.mutating_in_learning} mutating backend request(s)`] : []), ...o.trials.map((x) => `${x.kind} (${x.position}): ${x.skipped ? `skipped: ${x.skipped}` : `${x.call!.ok ? 'success reported' : 'error'}; applied ${x.applied.length} of ${x.items.length}${x.reported ? `; reported applied ${x.reported.length}` : ''}`}`)];
  // A trial in which the call did not apply every item it was asked to (the refused item, or the failed write).
  const failed = t.filter((x) => x.kind === 'failed backend write' ? x.applied.length < x.items.length : true);
  const unsafe = o.trials.find((x) => x.skipped && x.call === null && /spec 7\.3/.test(x.skipped));
  if (!failed.length) return (['MWS-ATOM-1', 'MWS-ATOM-2'] as const).map((id) => result(id, w, sc, 'not tested', `no call failed in part (every item was applied, or no trial ran)${unsafe ? `; a trial was not sent: ${unsafe.skipped}` : ''}`, { notes }));
  const out: Result[] = [];
  const problems: string[] = [];
  const steps: string[] = [];
  const shapeNotes: string[] = [];
  const countable = countsOwnSet(o, m);
  for (const x of failed) {
    const b = x.call!;
    const sh = shapeOf(b);
    const fb = shapeFallbackNote(b);
    if (fb) shapeNotes.push(`${x.kind} (${x.position}): ${fb}`);
    // why: spec R15-3: content that says the whole write took effect, by the declared patterns.applied_all, reports success; every
    // trial here left an item not applied (the refused item, or a failed write), so it is violated whether or not the result is an
    // error, and a shape or another text that names the items correctly does not make up for it.
    const all = appliedAllSaid(b);
    if (all) (problems.push(`${x.kind} (${x.position}): its content says the whole write took effect (by the declared patterns.applied_all), while ${x.applied.length} of the ${x.items.length + (x.kind === 'invalid item' ? 1 : 0)} items sent were applied (spec R15-3: a shape or another text that names them does not make up for it)`), steps.push(b.step), shapeNotes.push(`${x.kind} (${x.position}): ${all}`));
    // why: MWS-ATOM-1: a call that could not apply every item and answered without isError is a success; that is decided by the
    // form of the answer, never by a shape it carries (f573a24's rule kept).
    if (b.ok) {
      problems.push(`${x.kind} (${x.position}): the call reported success${sh?.outcome ? ` (no isError; its adopted result shape says ${quoteField('outcome', sh.outcome)})` : ''}, and ${x.applied.length} of ${x.items.length} items were applied`), steps.push(b.step);
      if (sh) shapeNotes.push(`${x.kind} (${x.position}): ${decidedByShape([['outcome', sh.outcome]], b)}`);
    } else if (sh?.outcome) {
      // why: rule 11, B-9: the adopted result shape gives each item an outcome (its entry in items; for a write by selector with
      // applied_count, an unlisted item is applied; else the whole write's applied or not_applied). The read-back decides which
      // items were applied. ATOM-1 asks that the caller can tell, for each item, whether it was applied.
      const fields: [string, unknown][] = [['outcome', sh.outcome], ['items', sh.items], ['applied_count', sh.applied_count]];
      shapeNotes.push(`${x.kind} (${x.position}): ${decidedByShape(fields, b)}`);
      const wrong: string[] = [];
      for (const id of x.items) {
        // why: B-9 v2: an item of a list is found by its index, the position in the list the call sent, where the trial recorded it.
        const at = x.order ? x.order.findIndex((v) => deepEqual(v, id)) : -1;
        const said = itemStatus(sh, id, at >= 0 ? at : undefined);
        const was = x.applied.some((a) => deepEqual(a, id));
        const listed = (sh.items ?? []).some((it) => (it.id !== undefined && String(it.id) === String(id)) || (at >= 0 && it.index === at));
        const how = listed ? 'in items' : sh.applied_count !== undefined && sh.applied_count > 0 ? `not in items, so ${quoteField('applied_count', sh.applied_count)} covers it` : sh.outcome === 'applied' || sh.outcome === 'not_applied' ? `not in items, so ${quoteField('outcome', sh.outcome)} covers it` : 'not in items, and the result does not state its outcome';
        if (was && said !== 'applied') wrong.push(`${short(id, 20)} was applied and the shape gives it as ${said === 'unknown' ? 'of unknown outcome' : said.replace('_', ' ')} (${how})`);
        if (!was && said === 'applied') wrong.push(`${short(id, 20)} was not applied and the shape gives it as applied (${how})`);
      }
      // why: B-9: applied_count is compared only where the tester can count every object the call matched: in a container it
      // created, or where the call names only the tester's own objects of the trial (its list of ids, or the marker it gave them).
      if (sh.applied_count !== undefined && countable && sh.applied_count !== x.applied.length) wrong.push(`${quoteField('applied_count', sh.applied_count)} where ${x.applied.length} of the tester's items were applied`);
      if (x.reported !== null && !sameSet(x.reported, x.applied)) wrong.push(`the declared report path lists ${x.reported.length ? x.reported.map((v) => short(v, 20)).join(', ') : 'nothing'} as applied`);
      // why: rule 11, point 13 (R14-5): a text that says by a declared pattern that nothing was applied, while items were, gives
      // its verdict beside the shape, however correct the shape is.
      const tfail = x.applied.length ? textStatement(b, 'not_applied') : null;
      if (wrong.length) (problems.push(`${x.kind} (${x.position}): by its adopted result shape, ${wrong.join('; ')}`), steps.push(b.step));
      if (tfail) (problems.push(`${x.kind} (${x.position}): its text says the write failed or nothing was changed (${tfail}) while ${x.applied.length} of ${x.items.length} items were applied; the adopted result shape beside it does not repair it (rule 11, point 13)`), steps.push(b.step));
    } else {
      if (x.reported !== null && !sameSet(x.reported, x.applied)) (problems.push(`${x.kind} (${x.position}): the answer lists ${x.reported.length ? x.reported.map((v) => short(v, 20)).join(', ') : 'nothing'} as applied; actually applied: ${x.applied.length ? x.applied.map((v) => short(v, 20)).join(', ') : 'nothing'}`), steps.push(b.step));
      // why: R7-5: the result must let the caller tell for each item whether it was applied. It names the applied items; or it
      // names the items not applied and says all others were applied; or, for a write by selector, it gives the count applied
      // with the ids not applied. A result that says nothing was applied names every item as not applied.
      // why: B-9 v2: where a shape is carried but decides nothing here, its members are not read as text either (only its free words).
      const bb = forPatterns(b);
      const notApplied = x.items.filter((id) => !x.applied.some((a) => deepEqual(a, id)));
      const hay = `${bb.hay ?? `${bb.text ?? ''} ${JSON.stringify(bb.data ?? null)}`} ${bb.rpc_error?.message ?? ''}`;
      const failedNamed = notApplied.length > 0 && notApplied.every((id) => mentions(bb, id));
      const othersApplied = failedNamed && /\b(all )?(the )?(others?|rest|remaining)( \w+)? (were|was|have been|are) (applied|updated|deleted|written|saved|closed|changed|processed)\b/i.test(hay);
      const bySelector = !JSON.stringify(m.args).includes('{{ids}}');
      const counted = failedNamed && bySelector && mentions(bb, x.applied.length);
      const unnamed = othersApplied || counted ? [] : x.applied.filter((id) => !mentions(bb, id));
      if (unnamed.length) (problems.push(`${x.kind} (${x.position}): ${unnamed.map((v) => short(v, 20)).join(', ')} stayed applied and the error does not name ${unnamed.length > 1 ? 'them' : 'it'}`), steps.push(b.step));
    }
  }
  out.push(problems.length ? result('MWS-ATOM-1', w, sc, 'violated', `${problems.join('; ')}.`, { numbers: { trials: failed.length }, steps, notes: [...notes, ...shapeNotes] }) : result('MWS-ATOM-1', w, sc, 'held', `In ${failed.length} call(s) that could not apply every item, the answer was an error${m.report ? ', its list of applied items matched what was applied,' : ''} and every item that stayed applied was named${failed.some((x) => shapeOf(x.call)) ? ' (by its adopted result shape, which gave each item as it was)' : ''}.`, { numbers: { trials: failed.length }, notes: [...notes, ...shapeNotes, ...(appliedAllUnread() ? [appliedAllUnread()!] : [])] }));
  const partial = failed.filter((x) => x.applied.length > 0);
  out.push(partial.length ? result('MWS-ATOM-2', w, sc, 'violated', `${partial.length} of ${failed.length} failed call(s) left part of their changes applied (${partial.map((x) => `${x.applied.length} of ${x.items.length}, ${x.position}`).join('; ')}).`, { numbers: { trials: failed.length }, steps: partial.map((x) => x.call!.step), notes }) : result('MWS-ATOM-2', w, sc, 'held', `No failed call left any of its changes applied (${failed.length} trials; the failure positions tested only).`, { numbers: { trials: failed.length }, notes }));
  return out;
}

/**
 * Can the tester count every object the call matched (B-9, *Items*: applied_count)? In a container it created, or where the
 * call's arguments name only the trial's own items: the list of their ids (`{{ids}}`), or the marker the tester gave that
 * trial's items alone (`{{batch}}`). A selector by anything else may match objects the tester did not create.
 */
export function countsOwnSet(o: Pick<MultiObs, 'own_container'>, m: Pick<MultiSpec, 'args'>): boolean {
  return !!o.own_container || /\{\{\s*(ids|batch)\s*\}\}/.test(JSON.stringify(m.args ?? null));
}

const sameSet = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((x) => b.some((y) => deepEqual(x, y)));

/**
 * MWS-RES-2 for a multi-item tool (with the gate): the failed-request trials of the ATOM check (status 500, not forwarded) judged
 * as a failed write, what stayed applied being the items read back with the effect; and the lost-answer trial, judged by the same
 * rules as the update tool's (gated.ts lostAnswerVerdict), the learning pass being the run without a fault.
 */
export function multiRes2Verdicts(o: MultiObs, res: ResourceSpec, asyncOps: string[] = []): Result[] {
  if (!o.routing) return [];
  const w = wp(res.name, o.tool);
  const sc = { id: `${ID}.res2`, version: VERSION };
  const su = { id: `${ID}.res2.unknown-outcome`, version: VERSION };
  const route = `Route: ${o.routing}`;
  if (o.skipped) return [result('MWS-RES-2', w, sc, 'not tested', `${o.tool} was not called: ${o.skipped}`, { notes: [route] }), result('MWS-RES-2', w, su, 'not tested', `${o.tool} was not called: ${o.skipped}`, { notes: [route] })];
  // why: review of f4: the trials fail a write the learning pass showed working; without that, neither RES-2 record is judged.
  if (o.learn && (!o.learn.call.ok || o.learn.applied !== true)) {
    const why = `the learning pass did not show a working write (${o.learn.call.indeterminate ? 'its outcome is unknown' : !o.learn.call.ok ? `it was refused: ${JSON.stringify(short(o.learn.call.text ?? o.learn.call.rpc_error?.message ?? '', 120))}` : o.learn.applied === null ? 'an item did not read back' : 'it answered success and not every item read back with the effect'}), so there is no write to fail`;
    return [result('MWS-RES-2', w, sc, 'not tested', `failed backend request: ${why}`, { notes: [route] }), result('MWS-RES-2', w, su, 'not tested', `unknown outcome: ${why}`, { notes: [route] })];
  }
  const asyncOp = asyncOps.includes(o.tool);
  const ids = (xs: unknown[]) => Object.fromEntries(xs.map((id) => [String(id), id]));
  const out: Result[] = [];
  const failed = o.trials.filter((x) => x.kind === 'failed backend write' && !x.skipped && x.call && !x.call.indeterminate);
  // why: a trial whose fault the server absorbed (it retried, and every item took effect with a success) produced no failure.
  const judged = failed.filter((x) => !(x.call!.ok && x.applied.length === x.items.length));
  if (!judged.length) out.push(result('MWS-RES-2', w, sc, 'not tested', `failed backend request: ${failed.length ? 'the server retried each failed request and the write took effect, so no failure was produced' : o.trials.find((x) => x.kind === 'failed backend write' && x.skipped)?.skipped ?? 'no backend request of the call could be failed'}`, { notes: [route] }));
  else {
    const js = judged.map((x) => ({ x, j: res2Judge(x.call!, x.applied.map(String), 'backend', `The tester failed the backend request (${x.position})`, ids(x.applied), { async: asyncOp }) }));
    const bad = js.filter((y) => y.j.verdict === 'violated');
    const open = js.filter((y) => y.j.verdict === 'not tested');
    if (bad.length) out.push(result('MWS-RES-2', w, sc, 'violated', bad.map((y) => y.j.reason).join(' '), { steps: bad.map((y) => y.x.call!.step), notes: [route, ...new Set(bad.flatMap((y) => y.j.notes))], ...SYNTHETIC_FAULT }));
    else if (open.length) out.push(result('MWS-RES-2', w, sc, 'not tested', open.map((y) => y.j.reason).join(' '), { notes: [route, ...new Set(open.flatMap((y) => y.j.notes))] }));
    else out.push(result('MWS-RES-2', w, sc, 'held', `${js.length} failed backend request(s): ${js.map((y) => y.j.reason).join(' ')}`, { notes: [route, ...new Set(js.flatMap((y) => y.j.notes))] }));
  }
  const l = o.lost;
  const lost: LostAnswerObs = l ? { ...(l.skipped ? { skipped: l.skipped } : {}), faulted: l.faulted, call: l.call, changed: l.call && !l.skipped ? l.applied.map(String) : null, applied: l.call && !l.skipped ? l.applied.length > 0 : null, object: null, requests: l.requests } : { skipped: o.mutating_in_learning === 0 ? `${o.tool} sent no mutating request to the backend in the learning pass` : 'the trial was not made', faulted: null, call: null, changed: null, applied: null };
  out.push(lostAnswerVerdict(lost, { w, sc: su, route, tool: o.tool, readTool: res.read.tool, versionArg: null, values: l ? ids(l.applied) : {}, fallbackChanged: l ? l.items.map(String) : [], async: asyncOp, learned: o.learn ? [{ label: `${o.tool} on 3 items`, requests: o.learn.requests, call: o.learn.call, applied: o.learn.applied }] : [] }));
  return out;
}
