/**
 * MWS-RES-1 on every declared write call: "A write tool MUST report success only when the state the caller asked for is in
 * effect afterwards." Each call the declaration gives an effect for (a resource's `effects`, and each `input_required` entry
 * with an `effect`) is sent once and the object is read back within the settle window:
 *
 *   on: object   a fresh scratch object of the resource; read; the call ({{object}} and {{version}} as just read); read back
 *                until the declared conditions hold or the window closes. `deleted`: the object must be gone.
 *   on: new      the call creates the object (`created`); it is found by its {{marker}} through the resource's list,
 *                independently of the answer, and read back against the declared conditions.
 *
 * A success (no isError, a complete result, an adopted result shape that reports the write as applied) whose effect is not in
 * effect is `violated`; one whose effect is in effect is `held`. A refusal reports no success, so the trial adds no verdict
 * here (it is MWS-RES-2's). Multi-item tools are judged per item by the multi-item check (multiRes1, below).
 * Spec MWS-RES-1 (Test method: "any case the declaration adds"); spec 8.2, rule 13 combines the trials of one write path.
 */

import { baseVars, deleteArgs, valueAt, type Driver } from '../core/driver.js';
import type { EffectCond, EffectSpec, MultiSpec, ResourceSpec } from '../core/manifest.js';
import { listAll } from '../core/lists.js';
import { createVerified, goneByAnswer, goneFrom } from '../core/objects.js';
import { render, type Env } from '../core/template.js';
import { deepEqual, getPath, isObj, short } from '../core/util.js';
import { result, type Result } from '../report/verdicts.js';
import { saidBy, says } from './says.js';
import { scratch } from './scratch.js';
import { decidedByShape, quoteField, reportsSuccess, shapeOf } from './shape.js';
import { brief, textStatement, toolByName, wp, type CallBrief, type CheckModule, type Observation, type PlanContext, type PlannedCheck, type RunContext } from './types.js';
import type { MultiObs } from './multi.js';

const ID = 'effects';
const VERSION = '1';
const SC = { id: ID, version: VERSION };
/** The multi-item check's scenario (src/checks/multi.ts passes its own; this default is for callers that judge a recorded observation). */
const MULTI_SC = { id: 'multi-item', version: '2' };

/** One effect trial: the call, and what the read-back showed of each declared condition. */
export interface EffectTrial {
  tool: string;
  on: 'object' | 'new';
  /** Where the effect came from in the declaration. */
  from: 'effects' | 'input_required';
  call: CallBrief | null;
  /** The call answered input_required and was retried with the declared answers (the final result is `call`). */
  retried?: boolean;
  /** The object written (on: object) or found by its marker (on: new); null where none. */
  object: unknown;
  /** deleted: whether the object is gone after the call (null: the read-back has an unknown outcome). */
  gone?: boolean | null;
  /** Each declared condition that did not hold after the call: the condition, and what the read-back showed. */
  missing: { cond: string; got: unknown }[];
  /** The declared conditions, as rendered for this trial. */
  expect?: string[];
  /** How many objects carried the call's marker (on: new). */
  found?: number;
  reads?: number;
  skipped?: string;
}

/** The declared effects of a resource: its `effects` entries, and each input_required entry with an effect no entry repeats. */
export function declaredEffects(res: ResourceSpec): (EffectSpec & { from: EffectTrial['from'] })[] {
  const own = (res.effects ?? []).map((e) => ({ ...e, from: 'effects' as const }));
  const ir = res.input_required
    .filter((x) => x.effect && !own.some((e) => e.tool === x.tool))
    .map((x) => ({ tool: x.tool, args: x.args, on: 'object' as const, deleted: false, expect: [{ path: x.effect!.path, value: x.effect!.value, pick: null }], answers: x.answers, client_capabilities: x.client_capabilities, from: 'input_required' as const }));
  return [...own, ...ir];
}

const cleanable = (res: ResourceSpec) => !!res.cleanup && res.cleanup !== 'leave';

/** An element matches: an object pattern on the members it names, any other value by equality. */
const matches = (el: unknown, pat: unknown): boolean => (isObj(pat) ? isObj(el) && Object.entries(pat).every(([k, v]) => deepEqual(getPath(el, k), v)) : deepEqual(el, pat));
/** An empty value reads back as empty if the server stores "", null or drops the key (as readback.ts emptyLike). */
const sameOrEmpty = (got: unknown, sent: unknown): boolean => deepEqual(got, sent) || ((sent === '' || sent === null) && (got === '' || got === null || got === undefined));

/** A value as a record shows it: JSON, clipped. */
export const shown = (v: unknown, n = 80): string => short(JSON.stringify(v) ?? String(v), n);

export function describeCond(c: EffectCond): string {
  if ('contains' in c) return `${c.path} holds ${shown(c.contains, 60)}`;
  if ('lacks' in c) return `${c.path} holds no ${shown(c.lacks, 60)}`;
  return c.pick ? `${c.path}[*].${c.pick} is ${shown(c.value, 60)}` : `${c.path} is ${shown(c.value, 60)}`;
}

/** What the object shows at the condition's path (the picked members for `pick`), and whether the condition holds. */
export function condHolds(obj: unknown, c: EffectCond): { holds: boolean; got: unknown } {
  const at = valueAt(obj, c.path);
  if ('contains' in c) return { holds: Array.isArray(at) && at.some((el) => matches(el, c.contains)), got: at };
  if ('lacks' in c) return { holds: Array.isArray(at) && !at.some((el) => matches(el, c.lacks)), got: at };
  if (c.pick) {
    const got = Array.isArray(at) ? at.map((el) => getPath(el, c.pick!)) : at;
    return { holds: Array.isArray(at) && deepEqual(got, c.value), got };
  }
  return { holds: sameOrEmpty(at, c.value), got: at };
}

const missingOf = (obj: unknown, conds: EffectCond[]) => conds.map((c) => ({ c, r: condHolds(obj, c) })).filter((x) => !x.r.holds).map((x) => ({ cond: describeCond(x.c), got: shown(x.r.got) }));

export const effectsCheck: CheckModule = {
  id: ID,
  version: VERSION,
  requirements: ['MWS-RES-1'],
  plan(_ctx: PlanContext, res: ResourceSpec): PlannedCheck {
    const base: PlannedCheck = { check: ID, version: VERSION, resource: res.name, runs: false, calls: [], writes: 0, creates: 0, notRun: [] };
    const eff = declaredEffects(res);
    if (!eff.length) return base;
    if (!cleanable(res)) return { ...base, notRun: [...new Set(eff.map((e) => e.tool))].map((t) => result('MWS-RES-1', wp(res.name, t), SC, 'not tested', 'the declared effect needs a cleanup policy (each trial creates an object)')) };
    const calls = eff.map((e) => (e.on === 'new' ? `${e.tool} (creates; ${e.expect.map(describeCond).join('; ') || 'the object exists'}): find it by its marker through ${res.list!.tool}; ${res.read.tool}` : `${e.tool}: a scratch object; ${res.read.tool}; ${e.tool}${e.answers ? ' (and the retry with the declared answers, if it answers input_required)' : ''}; ${res.read.tool} until ${e.deleted ? 'it is gone' : e.expect.map(describeCond).join('; ')} or the settle window closes`));
    return { ...base, runs: true, calls, writes: eff.length * 3, creates: eff.length };
  },
  async collect(ctx: RunContext, res: ResourceSpec): Promise<Observation> {
    const trials: EffectTrial[] = [];
    const label = ctx.label('EF');
    for (const e of declaredEffects(res)) trials.push(e.on === 'new' ? await onNew(ctx, res, e, label) : await onObject(ctx, res, e, label));
    return { check: ID, version: VERSION, resource: res.name, data: { trials } };
  },
  evaluate(obs: Observation, ctx: PlanContext): Result[] {
    const res = ctx.manifest.resources.find((r) => r.name === obs.resource)!;
    return effectsVerdicts((obs.data as { trials: EffectTrial[] }).trials, res, ctx.manifest.async_operations ?? []);
  },
};

/** Send the call; where it answers input_required and the declaration gives answers, retry once with them (the final result counts). */
async function send(ctx: RunContext, label: string, e: EffectSpec, args: unknown, step: string): Promise<{ b: CallBrief; retried: boolean }> {
  const meta = e.client_capabilities ? { 'io.modelcontextprotocol/clientCapabilities': e.client_capabilities } : undefined;
  const r = await ctx.session.call(label, e.tool, args, { step, ...(meta ? { meta } : {}) });
  if (r.result_type === 'input_required' && e.answers) {
    const params: Record<string, unknown> = { inputResponses: e.answers, ...(r.input_required?.requestState ? { requestState: r.input_required.requestState } : {}) };
    const r2 = await ctx.session.call(label, e.tool, args, { step: ctx.session.stepId(`${step}.retry`), ...(meta ? { meta } : {}), params });
    return { b: brief(r2), retried: true };
  }
  return { b: brief(r), retried: false };
}

async function onObject(ctx: RunContext, res: ResourceSpec, e: EffectSpec & { from: EffectTrial['from'] }, label: string): Promise<EffectTrial> {
  const t: EffectTrial = { tool: e.tool, on: 'object', from: e.from, call: null, object: null, missing: [] };
  const s = await scratch(ctx, res, { tag: 'ef', purpose: `MWS-RES-1 effect of ${e.tool}`, label });
  if (!s.ok) return { ...t, skipped: `scratch object: ${s.reason}` };
  const d: Driver = s.driver!;
  t.object = s.id;
  const before = await d.readOnce(label, ctx.session.stepId(`effects.${e.tool}.before`));
  if (!before.ok) return { ...t, skipped: 'the scratch object did not read back before the call' };
  const vars: Env = d.vars({ object: before.obj, version: before.version, marker: ctx.marker('ev') });
  const conds = render(e.expect, vars) as EffectCond[];
  t.expect = conds.map(describeCond);
  // why: a trial forces the condition only where the state asked for is not already in effect before the call.
  if (!e.deleted && conds.length && !missingOf(before.obj, conds).length) return { ...t, skipped: `the declared effect (${conds.map(describeCond).join('; ')}) was already in effect before the call, so the trial would show nothing` };
  const args = e.deleted && res.delete?.tool === e.tool ? deleteArgs(res, vars, toolByName(ctx.tools, e.tool)?.inputSchema) : render(e.args, vars);
  const { b, retried } = await send(ctx, label, e, args, ctx.session.stepId(`effects.${e.tool}`));
  t.call = b;
  if (retried) t.retried = true;
  if (e.deleted) {
    const back = await d.readSettled(label, `effects.${e.tool}.after`, b.ok ? () => false : () => false);
    const gone = goneFrom(res, back) ?? ((await goneByAnswer(ctx.session, res, ctx.prefix, label, back.call, s.id)) ? true : null);
    // why: as creates.ts (S5): a server read that no longer shows the object while the platform's own read still returns it is a
    // soft delete or a read that hides it; the outcome is not judged.
    const cr = gone === true && res.control?.read ? await d.controlRead(ctx.session.stepId(`effects.${e.tool}.control_read`)).catch(() => null) : null;
    if (cr && cr.ok) return { ...t, gone: null, skipped: `the server's read no longer shows the object, but the platform's API still returns it (HTTP ${cr.http?.status ?? '?'}): a soft delete, or a read that hides it` };
    t.gone = gone;
    t.reads = back.reads;
    return t;
  }
  const after = await d.readSettled(label, `effects.${e.tool}.after`, b.ok ? (o) => !missingOf(o, conds).length : () => false);
  t.reads = after.reads;
  if (!after.ok) return { ...t, skipped: 'the object did not read back after the call' };
  t.missing = missingOf(after.obj, conds);
  return t;
}

async function onNew(ctx: RunContext, res: ResourceSpec, e: EffectSpec & { from: EffectTrial['from'] }, label: string): Promise<EffectTrial> {
  const t: EffectTrial = { tool: e.tool, on: 'new', from: e.from, call: null, object: null, missing: [] };
  const marker = ctx.marker('en');
  const scope = ctx.driver?.scope ?? null;
  const vars: Env = baseVars(res, ctx.prefix, { scope, marker, key: marker });
  const conds = render(e.expect, vars) as EffectCond[];
  t.expect = conds.map(describeCond);
  const step = ctx.session.stepId(`effects.${e.tool}`);
  // The create goes through the ledger (createVerified) so that what it makes is cleaned up; the object is then found by its
  // marker through the list, never taken from the answer alone.
  const c = await createVerified(ctx.session, ctx.ledger, res, ctx.prefix, { tool: e.tool, args: render(e.args, vars), purpose: `MWS-RES-1 effect of ${e.tool}`, label, step });
  t.call = c.call ? brief(c.call) : null;
  if (!t.call) return { ...t, skipped: 'the create was not sent' };
  const l = res.list!;
  const find = async (): Promise<unknown[] | null> => {
    const r = await listAll(ctx.session, label, l, render(l.args, vars), ctx.session.stepId(`effects.${e.tool}.find`));
    if (!r.ok || r.partial) return null;
    // why: a create with a caller-chosen key (res.key) is also found by that key, which is the marker here, so that a create that
    // stores another name is found and judged on the name, not taken for one that made nothing.
    return r.items.filter((it) => getPath(it, l.name) === marker || (!!res.key && getPath(it, l.id) === marker)).map((it) => getPath(it, l.id));
  };
  // why: the settle window applies to the list as to the read (spec MWS-RES-1: a change not in effect by its end is not in effect).
  const deadline = Date.now() + res.read.settle_ms;
  let found = await find();
  while (t.call.ok && found !== null && !found.length && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, Math.max(20, Math.min(200, res.read.settle_ms / 10))));
    found = await find();
  }
  if (found === null) return { ...t, skipped: 'the objects could not be looked for after the call (the list call failed or was partial)' };
  t.found = found.length;
  if (found.length > 1) return { ...t, skipped: `${found.length} objects carry the call's marker; the object the call made could not be identified` };
  if (!found.length) return t;
  t.object = found[0];
  if (!conds.length) return t;
  const d = ctx.drivers.get(res.name) ?? ctx.driver;
  const read = async () => {
    const deadline2 = Date.now() + res.read.settle_ms;
    let n = 0;
    for (;;) {
      const r = await d.readOnce(label, ctx.session.stepId(`effects.${e.tool}.read`), found![0]);
      n++;
      if ((r.ok && !missingOf(r.obj, conds).length) || Date.now() >= deadline2) return { ...r, reads: n };
      await new Promise((x) => setTimeout(x, Math.max(20, Math.min(200, res.read.settle_ms / 10))));
    }
  };
  const back = await read();
  t.reads = back.reads;
  if (!back.ok) return { ...t, skipped: 'the created object did not read back' };
  t.missing = missingOf(back.obj, conds);
  return t;
}

/**
 * One trial of MWS-RES-1: whether the answer is a report of success, and if so whether what was asked for is in effect.
 * `inEffect`: the read-back shows the declared effect. Returns null where the trial adds no verdict (and why, in `why`).
 */
export function res1Trial(b: CallBrief, inEffect: boolean, tool: string, asyncOps: string[]): { verdict: 'held' | 'violated' | null; why: string; notes: string[] } {
  const async = asyncOps.includes(tool);
  if (b.indeterminate) return { verdict: null, why: b.result_type && b.result_type !== 'complete' ? `the final result is ${b.result_type}, neither a success nor an error` : 'the call has an unknown outcome (a timeout or a broken connection)', notes: [] };
  if (!b.ok) return { verdict: null, why: `the call was refused (${b.rpc_error ? `JSON-RPC error ${b.rpc_error.code}: ` : ''}${JSON.stringify(short(b.text ?? b.rpc_error?.message ?? '', 120))}), so there was no report of success to check (what it says is MWS-RES-2's)`, notes: [] };
  const sh = shapeOf(b);
  const shNote = sh?.outcome ? [decidedByShape([['outcome', sh.outcome], ...(sh.changed ? [['changed', sh.changed] as [string, unknown]] : [])], b)] : [];
  if (sh?.outcome && !reportsSuccess(sh, async)) {
    // why: rule 11, point 13 (R14-5): a text that reports the write done by a declared pattern is a report of success of its own.
    const said = !inEffect ? textStatement(b, 'applied') : null;
    if (said) return { verdict: 'violated', why: `its text reports the write as done (${said}) while its adopted result shape says ${quoteField('outcome', sh.outcome)}, which does not repair the text (rule 11, point 13)`, notes: shNote };
    return { verdict: null, why: `the result has no isError, and its adopted result shape says ${quoteField('outcome', sh.outcome)}: not a report of success (judged under MWS-RES-2)`, notes: shNote };
  }
  // why: NF-19: for an operation the declaration lists as asynchronous, "accepted" or "pending" is not a report of success.
  if (!inEffect && async && says('accepted', b.text ?? '')) return { verdict: null, why: `${tool} said the write was accepted or is pending, and the declaration lists it as completed asynchronously (NF-19)`, notes: [saidBy('accepted', b.text ?? '')] };
  return { verdict: inEffect ? 'held' : 'violated', why: '', notes: shNote };
}

const said = (b: CallBrief | null) => (b ? `${b.ok ? 'success' : b.isError ? 'isError' : b.rpc_error ? `JSON-RPC error ${b.rpc_error.code}` : 'no result'}${b.text ? `: ${JSON.stringify(short(b.text, 100))}` : ''}` : 'not sent');

/** The records of the effect trials, one per write tool (spec 8.2, rule 13: violated if any trial is, held where each judged trial held). */
export function effectsVerdicts(trials: EffectTrial[], res: ResourceSpec, asyncOps: string[] = []): Result[] {
  const out: Result[] = [];
  const settle = `re-read within the settle window of ${res.read.settle_ms} ms`;
  for (const tool of [...new Set(trials.map((t) => t.tool))]) {
    const w = wp(res.name, tool);
    const mine = trials.filter((t) => t.tool === tool);
    const bad: string[] = [];
    const good: string[] = [];
    const none: string[] = [];
    const steps: string[] = [];
    const notes: string[] = [];
    for (const t of mine) {
      const what = t.on === 'new' ? 'the create' : t.from === 'input_required' ? 'the call (after the retry with the declared answers)' : 'the call';
      if (t.skipped && !(t.on === 'new' && t.call && t.found === 0)) {
        none.push(t.skipped);
        continue;
      }
      if (!t.call) {
        none.push('the call was not sent');
        continue;
      }
      if (t.on === 'object' && t.gone === null && t.call.ok) {
        none.push('the read-back after the delete has an unknown outcome');
        continue;
      }
      const deleted = t.gone !== undefined;
      const inEffect = deleted ? t.gone === true : t.on === 'new' ? (t.found ?? 0) === 1 && !t.missing.length : !t.missing.length;
      const j = res1Trial(t.call, inEffect, tool, asyncOps);
      notes.push(...j.notes, `${what} answered ${said(t.call)}${t.retried ? ' (after input_required, retried with the declared answers)' : ''}.`);
      if (j.verdict === null) {
        none.push(j.why);
        continue;
      }
      const shown = deleted ? (t.gone ? 'the object is gone' : `the object ${short(t.object, 40)} still reads back`) : t.on === 'new' && !t.found ? 'no object carries the call\'s marker' : t.missing.length ? t.missing.map((m) => `${m.cond}: read back ${m.got}`).join('; ') : `${t.on === 'new' ? `the object ${short(t.object, 40)} exists${t.expect?.length ? ' and ' : ''}` : ''}${t.expect?.length ? t.expect.join('; ') : ''}`;
      if (j.verdict === 'violated') {
        bad.push(`${j.why ? `${j.why}; ` : ''}${shown}`);
        steps.push(t.call.step);
      } else good.push(shown);
    }
    if (bad.length) out.push(result('MWS-RES-1', w, SC, 'violated', `${tool} reported success but what it was asked for is not in effect (${settle}): ${bad.join('; ')}.`, { steps, notes: [...notes, ...none.map((n) => `Not judged: ${n}`)] }));
    else if (good.length) out.push(result('MWS-RES-1', w, SC, 'held', `${tool} reported success and the declared effect is in effect (${settle}): ${good.join('; ')}.`, { notes: [...notes, ...none.map((n) => `Not judged: ${n}`)] }));
    else out.push(result('MWS-RES-1', w, SC, 'not tested', none.join('; ') || 'no trial ran', { notes }));
  }
  return out;
}

/**
 * MWS-RES-1 for a multi-item tool, from the multi-item check's call on good items only (`clean`): every item it was asked to
 * write must hold the declared effect after a report of success. The ATOM requirements judge the failed calls.
 */
export function multiRes1(o: MultiObs, res: ResourceSpec, m: MultiSpec, asyncOps: string[] = [], sc: { id: string; version: string } = MULTI_SC): Result {
  const w = wp(res.name, o.tool);
  const c = o.clean;
  if (o.skipped) return result('MWS-RES-1', w, sc, 'not tested', `${o.tool} was not called: ${o.skipped}`);
  if (!c) return result('MWS-RES-1', w, sc, 'not tested', `${o.tool} had no call on good items only`);
  if (c.skipped || !c.call || c.applied === null) return result('MWS-RES-1', w, sc, 'not tested', c.skipped ?? (c.call ? 'an item\'s read-back has an unknown outcome' : 'the call was not sent'));
  const all = c.applied.length === c.items.length;
  const j = res1Trial(c.call, all, o.tool, asyncOps);
  const eff = m.effect === 'deleted' ? 'gone' : `${m.effect.path} = ${JSON.stringify(m.effect.value)}`;
  const notes = [...j.notes, `the call on ${c.items.length} good items answered ${said(c.call)}; ${c.applied.length} of ${c.items.length} read back ${eff}.`];
  if (j.verdict === null) return result('MWS-RES-1', w, sc, 'not tested', j.why, { notes });
  if (j.verdict === 'violated') return result('MWS-RES-1', w, sc, 'violated', `${o.tool} reported success on ${c.items.length} items, and ${c.items.length - c.applied.length} of them ${c.items.length - c.applied.length === 1 ? 'does' : 'do'} not read back ${eff} (re-read after the call): ${c.items.filter((i) => !c.applied!.some((a) => deepEqual(a, i))).map((i) => short(i, 30)).join(', ')}.${j.why ? ` ${j.why}.` : ''}`, { steps: [c.call.step], notes });
  return result('MWS-RES-1', w, sc, 'held', `${o.tool} reported success on ${c.items.length} items, and every one reads back ${eff}.`, { notes });
}
