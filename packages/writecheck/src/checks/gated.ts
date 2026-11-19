/**
 * Tier 3, the backend gate (proxy-assisted, forced): the hop between the server and its backend is
 * interposed on, so an interleaving or a failure is brought about by holding or failing one named
 * backend request, never by timing or chance (spec 7.3, 7.4 "held request").
 *
 *   learning pass   one write alone through the gate; its backend requests are recorded, and the
 *                   last mutating one (POST, PUT, PATCH, DELETE) is the one a schedule holds
 *   MWS-CONC-3      hold writer A's last mutating request; run writer B (the other field) to
 *                   completion; release A; read back both fields. Then the mirror (hold B, run A).
 *                   If B does not finish while A is held, A is released and the trial is recorded
 *                   as "serialized by the server". A control arm sends the same forced schedule
 *                   straight to the platform's API: both writers as the declared whole-object write
 *                   (control.write) for a whole-object tool, as control.patch for a field patch.
 *   MWS-CONC-1      for an update tool that takes no version (it reads and writes inside one call):
 *                   hold its last mutating request, change the other field through the platform's
 *                   API, release, and see whether the tool's write went over that change
 *   MWS-RES-2       fail the update's last mutating request (status 500, not forwarded): the answer
 *                   must not be a success, and whatever stayed applied must be named. Then the lost
 *                   answer: the request reaches the backend and its answer is cut (lostAnswerVerdict,
 *                   shared with the write-faults and multi-item checks); where the error names the
 *                   version the call carried, the follow-through repeat with it (R10-11)
 *   MWS-ATOM-1/2    a composite update (several backend writes in one call): fail its second and its
 *                   last mutating request; the answer must not be a success and must name what stayed
 *                   applied (ATOM-1); nothing should stay applied (ATOM-2)
 *
 * Every result states the route (gate.describe()) and, per trial, exactly which request was held
 * or failed and when it was released.
 */

import { hasControl, needsBase, valueAt, type Driver } from '../core/driver.js';
import type { FieldSpec, ResourceSpec } from '../core/manifest.js';
import { deepEqual, diff, setPath, short, sleep, withoutIgnored } from '../core/util.js';
import { lastMutating, nthOf, type GateRequest } from '../gate/gate.js';
import { result, VIOLATED_CAVEAT, type Result, type WritePath } from '../report/verdicts.js';
import { ignoredPaths } from './readback.js';
import { ruleNote } from './rules.js';
import { fromDeclaration, outcomeByField, saidBy, says } from './says.js';
import { conflictSignal } from './signals.js';
import { decidedByShape, quoteField, shapeNamesField, shapeOf, type WriteResult } from './shape.js';
import { appliedAllSaid, appliedAllUnread, brief, failedKind, identifiesChangeText, KNOWN_RESULT_TYPES, mayBeUnknown, notAppliedText, proseOf, readSecondClause, res2Judge, saysUnknownText, valueMentioned, wp, type CallBrief, type CheckModule, type FollowThroughRead, type Observation, type PlanContext, type PlannedCheck, type RunContext } from './types.js';

const ID = 'held-request';
// why: spec 13.6: version 2 adds the follow-through of the lost-answer trial (R10-11: an out-of-band change, the call sent again
// once with the version it carried, a read-back) and counts a success over a failed request as the server's own retry only
// where the gate shows the request sent again; both can change a verdict, and the version enters every record's test_hash.
const VERSION = '2';

type Req = Pick<GateRequest, 'seq' | 'method' | 'path'> & { status?: number | null };
const reqOf = (r: GateRequest): Req => ({ seq: r.seq, method: r.method, path: r.path, status: r.status });
const showReq = (r: Req) => `#${r.seq} ${r.method} ${r.path}`;

export interface HeldTrial {
  schedule: 'hold A, run B' | 'hold B, run A';
  /** The request held (as it arrived at the gate), or null when the holder never reached it. */
  held: Req | null;
  released: 'after the other writer finished' | 'after the hold timeout: serialized by the server' | 'never held';
  holder: CallBrief | null;
  other: CallBrief | null;
  /** The two fields after the trial, and whether each holds the value its writer sent. */
  kept: { holder: boolean; other: boolean } | null;
  steps: string[];
}

interface Learned {
  field: number;
  requests: Req[];
  hold: { method: string; path: string; nth: number; req: Req } | null;
  /** The run without a fault (R9-1): the call's answer and whether the read afterwards shows the value written. */
  call?: CallBrief;
  applied?: boolean | null;
}

export interface GatedObs {
  routing: string;
  independent?: boolean;
  skipped?: string;
  learned: Learned[];
  trials: HeldTrial[];
  control: { pairs: number; lost: number; kind?: 'whole' | 'patch' } | null;
  conc1: { skipped?: string; trials: { held: Req | null; tool: CallBrief | null; overwrote: boolean | null; control_refuses: boolean | null }[] } | null;
  /** changed: null when a read around the call failed; applied: the state asked for is in effect afterwards. */
  res2: { skipped?: string; faulted: Req | null; call: CallBrief | null; changed: string[] | null; applied?: boolean | null; object?: unknown } | null;
  /** MWS-RES-2, unknown outcome: the backend applied the last mutating request and its answer was cut. */
  res2u?: LostAnswerObs | null;
  atom: { skipped?: string; trials: { nth: number; faulted: Req | null; call: CallBrief | null; changed: string[] | null; applied?: boolean | null }[] } | null;
}

async function learn(ctx: RunContext, d: Driver, res: ResourceSpec, fi: number, value: unknown, label: string): Promise<Learned> {
  const f = res.fields![fi]!;
  await d.reset();
  const base = needsBase(res) ? await d.readOnce(label, ctx.session.stepId(`gate.learn.${fi}.base`)) : null;
  const mark = ctx.gate!.mark();
  const call = await d.update(label, f, value, { step: ctx.session.stepId(`gate.learn.${fi}`), ...(base?.ok ? { base: { obj: base.obj, version: base.version } } : {}) });
  const reqs = await ctx.gate!.since(mark);
  const last = lastMutating(reqs);
  // why: R9-1: the run without a fault is a trial of the clause on a settled outcome; the read-back says what took effect.
  const back = await d.readSettled('R', `gate.learn.${fi}.after`, (o) => deepEqual(valueAt(o, f.path), value));
  return { field: fi, requests: reqs.map(reqOf), hold: last ? { method: last.method, path: last.path, nth: nthOf(reqs, last), req: reqOf(last) } : null, call: brief(call), applied: back.ok ? back.settled : null };
}

async function independent(ctx: RunContext, d: Driver, res: ResourceSpec, A: string, B: string): Promise<boolean> {
  const [f0, f1] = res.fields!;
  const both = async (v0: unknown, v1: unknown, tag: string) => {
    const r = await d.readSettled('R', `gate.valid.${tag}`, (o) => deepEqual(valueAt(o, f0.path), v0) && deepEqual(valueAt(o, f1.path), v1));
    return r.settled;
  };
  if (!(await d.reset())) return false;
  if (!(await d.update(A, f0, f0.values[1], { step: ctx.session.stepId('gate.valid.a') })).ok) return false;
  if (!(await d.update(B, f1, f1.values[1], { step: ctx.session.stepId('gate.valid.b') })).ok) return false;
  if (!(await both(f0.values[1], f1.values[1], '1'))) return false;
  if (!(await d.update(B, f1, f1.values[0], { step: ctx.session.stepId('gate.valid.b0') })).ok) return false;
  if (!(await d.update(A, f0, f0.values[0], { step: ctx.session.stepId('gate.valid.a0') })).ok) return false;
  return both(f0.values[0], f1.values[0], '2');
}

async function heldTrial(ctx: RunContext, d: Driver, res: ResourceSpec, holder: { l: Learned; f: FieldSpec; v: unknown; label: string }, other: { f: FieldSpec; v: unknown; label: string }, schedule: HeldTrial['schedule']): Promise<HeldTrial> {
  const gate = ctx.gate!;
  const t: HeldTrial = { schedule, held: null, released: 'never held', holder: null, other: null, kept: null, steps: [] };
  if (!(await d.reset())) return t;
  const base = needsBase(res) ? await d.readOnce(holder.label, ctx.session.stepId('gate.held.base')) : null;
  const hold = gate.hold({ method: holder.l.hold!.method, path: holder.l.hold!.path, nth: holder.l.hold!.nth });
  const s1 = ctx.session.stepId('gate.held.holder');
  const pa = d.update(holder.label, holder.f, holder.v, { step: s1, ...(base?.ok ? { base: { obj: base.obj, version: base.version } } : {}) });
  const held = await hold.waitHeld(Math.min(ctx.manifest.limits.timeout_ms, 10_000));
  t.steps.push(s1);
  if (!held) {
    await hold.release();
    t.holder = brief(await pa);
    return t;
  }
  t.held = reqOf(held);
  const s2 = ctx.session.stepId('gate.held.other');
  t.steps.push(s2);
  const pb = d.update(other.label, other.f, other.v, { step: s2 });
  let done = false;
  try {
    done = await Promise.race([pb.then(() => true), sleep(gate.holdTimeoutMs).then(() => false)]);
  } finally {
    // why: a writer B that throws must not leave A's request held until the gate stops.
    await hold.release();
  }
  t.released = done ? 'after the other writer finished' : 'after the hold timeout: serialized by the server';
  const [ra, rb] = await Promise.all([pa, pb]);
  t.holder = brief(ra);
  t.other = brief(rb);
  const both = (o: unknown) => deepEqual(valueAt(o, holder.f.path), holder.v) && deepEqual(valueAt(o, other.f.path), other.v);
  const fin = await d.readSettled('R', 'gate.held.final', both);
  if (fin.call) t.steps.push(fin.call.step);
  if (fin.ok) t.kept = { holder: deepEqual(valueAt(fin.obj, holder.f.path), holder.v), other: deepEqual(valueAt(fin.obj, other.f.path), other.v) };
  return t;
}

export const gatedCheck: CheckModule = {
  id: ID,
  version: VERSION,
  needsUpdate: true,
  requirements: ['MWS-CONC-3', 'MWS-CONC-1', 'MWS-RES-2', 'MWS-ATOM-1', 'MWS-ATOM-2'],
  plan(ctx: PlanContext, res: ResourceSpec): PlannedCheck {
    const w = wp(res.name, res.update!.tool);
    const base: PlannedCheck = { check: ID, version: VERSION, resource: res.name, runs: false, calls: [], writes: 0, creates: 0, notRun: [] };
    if (!ctx.manifest.backend?.gate) {
      const nr = [result('MWS-CONC-3', w, { id: ID, version: VERSION }, 'not tested', 'the held-request procedure needs backend.gate (the hop between the server and its backend cannot be interposed on without it)')];
      if (res.update!.mode === 'composite') nr.push(...(['MWS-ATOM-1', 'MWS-ATOM-2'] as const).map((id) => result(id, w, { id: ID, version: VERSION }, 'not tested', 'a composite update is tested by failing its backend writes, which needs backend.gate')));
      return { ...base, notRun: nr };
    }
    const n = ctx.manifest.limits.gate_reps;
    const calls = [
      `learning pass: ${res.update!.tool} ${res.fields![0].path}, then ${res.fields![1].path}, each alone through the gate`,
      `held request x${n}: hold A's last mutating backend request, run B (${res.fields![1].path}) to completion, release A, ${res.read.tool}; and the mirror x${n}`,
      ...(res.update!.mode === 'full_replace' && hasControl(res, 'read', 'patch', 'write') ? [`control x${n * 2}: control read; control write ${res.fields![1].path} from it; control write ${res.fields![0].path} from the same read; control read`] : hasControl(res, 'read', 'patch') ? [`control x${n * 2}: control patch ${res.fields![1].path}; control patch ${res.fields![0].path}; control read`] : []),
      ...(!res.version?.arg && hasControl(res, 'read', 'patch', 'write') ? [`MWS-CONC-1 x${n}: hold the tool's last mutating request, change ${res.fields![1].path} through the platform's API, release`] : []),
      `MWS-RES-2: fail ${res.update!.tool}'s last mutating backend request (status 500); ${res.read.tool}`,
      `MWS-RES-2, lost answer: let that request through and cut its answer; ${res.read.tool}; where the error names the version the call carried, change ${res.fields![0].path} out of band${hasControl(res, 'patch') ? ' (control.patch)' : ` (${res.update!.tool})`} and send the call again once with that version (R10-11); ${res.read.tool}`,
      ...(res.update!.mode === 'composite' ? ['MWS-ATOM-1/2: fail the second and the last mutating backend request of the composite update; read back'] : []),
    ];
    // why: every write path the plan lists for MWS-CONC-1 gets a record (gate-2 N3): a field patch with no version is the
    // gated check's alone (the stale-write check defers to it), so a missing control.write is reported here, never dropped.
    const nr = !res.version?.arg && res.update!.mode !== 'full_replace' && !hasControl(res, 'read', 'patch', 'write') ? [result('MWS-CONC-1', w, { id: ID, version: VERSION }, 'not tested', `${res.update!.tool} takes no version, so MWS-CONC-1 is tested by holding its write; the control arm, which shows whether the platform's API refuses a write from outdated state, needs a control block with read, patch and write (missing: ${(['read', 'patch', 'write'] as const).filter((k) => !hasControl(res, k)).map((k) => `control.${k}`).join(', ')})`)] : [];
    return { ...base, runs: true, calls, writes: 4 + n * 2 * 6 + n * 4 + n * 4 + 4 + 6 + 2, notRun: nr };
  },
  async collect(ctx: RunContext, res: ResourceSpec): Promise<Observation> {
    const gate = ctx.gate;
    const obs: GatedObs = { routing: gate?.describe() ?? '', learned: [], trials: [], control: null, conc1: null, res2: null, atom: null };
    if (!gate) return { check: ID, version: VERSION, resource: res.name, data: { ...obs, skipped: 'no gate' } };
    const d = ctx.driver;
    const [f0, f1] = res.fields!;
    const A = ctx.label('GA');
    const B = ctx.label('GB');
    // Spec 7.3: before any concurrent test, the two fields must be shown independent (one after the other, both kept, in both orders).
    obs.independent = await independent(ctx, d, res, A, B);
    if (!obs.independent) obs.skipped = `the two fields are not independent one after the other (writing ${f0.path} and ${f1.path} in sequence, in both orders, did not keep both); see MWS-UPD-1`;
    const la = await learn(ctx, d, res, 0, f0.values[1], A);
    const lb = await learn(ctx, d, res, 1, f1.values[1], B);
    obs.learned.push(la, lb);
    const n = ctx.manifest.limits.gate_reps;
    if (obs.skipped) {
      /* not independent: no concurrent schedule is judged */
    } else if (!la.hold || !lb.hold) obs.skipped = `a writer sent no mutating request to the backend in the learning pass (${!la.hold ? res.fields![0].path : res.fields![1].path})`;
    else {
      for (let i = 0; i < n; i++) obs.trials.push(await heldTrial(ctx, d, res, { l: la, f: f0, v: f0.values[1], label: A }, { f: f1, v: f1.values[1], label: B }, 'hold A, run B'));
      for (let i = 0; i < n; i++) obs.trials.push(await heldTrial(ctx, d, res, { l: lb, f: f1, v: f1.values[1], label: B }, { f: f0, v: f0.values[1], label: A }, 'hold B, run A'));
    }
    // The control arm of the held-request procedure (spec 7.4): A's write, carrying what A read, sent to the platform API after B's
    // write has been applied. The two writers match the tool arm's: there both are calls through the same server, so here both are
    // the same declared write. For a whole-object tool each is control.write from the read before either wrote, with its own change
    // (gate-2 B3: a partial patch for B is another kind of writer, and where the platform's control is field ownership it is
    // refused for a reason the tool arm does not have); for a field patch each is control.patch of its field. Forced like the tool
    // arm, never left to timing. A whole-object tool with no control.write has no like-for-like control: kind 'patch' below, and
    // the verdict keeps the attribution unresolved.
    const whole = res.update!.mode === 'full_replace' && hasControl(res, 'read', 'patch', 'write');
    if (whole || hasControl(res, 'read', 'patch')) {
      let lost = 0;
      let pairs = 0;
      for (let i = 0; i < n * 2; i++) {
        if (!(await d.reset())) continue;
        const r0 = await d.controlRead(ctx.session.stepId('gate.ctl.read0'));
        if (!r0.ok) continue;
        const q = whole ? await d.controlWrite(setPath(r0.obj, f1.path, f1.values[1]), r0.version, ctx.session.stepId('gate.ctl.b')) : await d.controlPatch(f1, f1.values[1], ctx.session.stepId('gate.ctl.b'));
        if (!q.ok) continue;
        const mid = await d.controlRead(ctx.session.stepId('gate.ctl.mid'));
        if (!mid.ok || !deepEqual(valueAt(mid.obj, f1.path), f1.values[1])) continue;
        const p = whole ? await d.controlWrite(setPath(r0.obj, f0.path, f0.values[1]), r0.version, ctx.session.stepId('gate.ctl.a')) : await d.controlPatch(f0, f0.values[1], ctx.session.stepId('gate.ctl.a'));
        // why: only a conflict (409/412) counts as the platform keeping B's change; any other failure says nothing (review).
        if (!p.ok) {
          if (p.status === 409 || p.status === 412) pairs++;
          continue;
        }
        const r = await d.controlRead(ctx.session.stepId('gate.ctl.read'));
        if (!r.ok) continue;
        pairs++;
        if (!deepEqual(valueAt(r.obj, f0.path), f0.values[1]) || !deepEqual(valueAt(r.obj, f1.path), f1.values[1])) lost++;
      }
      obs.control = { pairs, lost, kind: whole ? 'whole' : 'patch' };
    }
    // MWS-CONC-1, proxy-assisted: only for a tool that takes no version from the caller.
    if (obs.independent && !res.version?.arg && hasControl(res, 'read', 'patch', 'write') && la.hold) {
      obs.conc1 = { trials: [] };
      for (let i = 0; i < n; i++) {
        if (!(await d.reset())) continue;
        const hold = gate.hold({ method: la.hold.method, path: la.hold.path, nth: la.hold.nth });
        const s = ctx.session.stepId('gate.conc1.tool');
        const p = d.update(A, f0, f0.values[1], { step: s });
        const held = await hold.waitHeld(10_000);
        if (!held) {
          await hold.release();
          obs.conc1.trials.push({ held: null, tool: brief(await p), overwrote: null, control_refuses: null });
          continue;
        }
        const oob = await d.controlPatch(f1, f1.values[1], ctx.session.stepId('gate.conc1.other'));
        await hold.release();
        const r = await p;
        const fin = await d.readSettled('R', 'gate.conc1.final', () => false);
        // The control: does the platform's API refuse a write made from the state before the other change?
        let refuses: boolean | null = null;
        if (await d.reset()) {
          const r0 = await d.controlRead(ctx.session.stepId('gate.conc1.ctl.read'));
          const p1 = await d.controlPatch(f1, f1.values[1], ctx.session.stepId('gate.conc1.ctl.other'));
          if (r0.ok && p1.ok) {
            const wr = await d.controlWrite({ ...(r0.obj as object) }, r0.version, ctx.session.stepId('gate.conc1.ctl.stale'));
            refuses = wr.status === 409 || wr.status === 412;
          }
        }
        obs.conc1.trials.push({ held: reqOf(held), tool: brief(r), overwrote: oob.ok && fin.ok ? !deepEqual(valueAt(fin.obj, f1.path), f1.values[1]) : null, control_refuses: refuses });
      }
    }
    // MWS-RES-2, proxy-assisted.
    if (la.hold) {
      await d.reset();
      const before = await d.readOnce('R', ctx.session.stepId('gate.res2.before'));
      const f = gate.fault({ method: la.hold.method, path: la.hold.path, nth: la.hold.nth, kind: 'status', status: 500 });
      const r = await d.update(A, f0, f0.values[1], { step: ctx.session.stepId('gate.res2.call') });
      const hit = await f.waitHit(500);
      f.clear();
      const after = await d.readSettled('R', 'gate.res2.after', () => false);
      obs.res2 = { object: d.id, faulted: hit ? reqOf(hit) : null, call: brief(r), changed: before.ok && after.ok ? withoutIgnored(diff(before.obj, after.obj), ignoredPaths(res)).map((e) => e.path) : null, applied: after.ok ? deepEqual(valueAt(after.obj, f0.path), f0.values[1]) : null };
      if (!hit) obs.res2.skipped = 'the fault was not applied (different backend requests than in the learning pass)';
      // Unknown outcome: the backend applies the request, and the connection closes before the server reads the answer.
      await d.reset();
      const b2 = await d.readOnce('R', ctx.session.stepId('gate.res2u.before'));
      const fu = gate.fault({ method: la.hold.method, path: la.hold.path, nth: la.hold.nth, kind: 'commit_then_reset' });
      const markU = gate.mark();
      const ru = await d.update(A, f0, f0.values[1], { step: ctx.session.stepId('gate.res2u.call') });
      const hitu = await fu.waitHit(1000);
      fu.clear();
      const reqsU = await gate.since(markU);
      const a2 = await d.readSettled('R', 'gate.res2u.after', () => false);
      obs.res2u = { object: d.id, faulted: hitu ? reqOf(hitu) : null, call: brief(ru), changed: b2.ok && a2.ok ? withoutIgnored(diff(b2.obj, a2.obj), ignoredPaths(res)).map((e) => e.path) : null, applied: a2.ok ? deepEqual(valueAt(a2.obj, f0.path), f0.values[1]) : null, requests: reqsU.map(reqOf), version_sent: b2.ok && res.version?.arg && !res.version.optional ? b2.version : null };
      if (!hitu) obs.res2u.skipped = 'the fault was not applied (different backend requests than in the learning pass)';
      // R10-11: the error names the version the call carried: send the call again once with that version, with no fault, and read
      // back. The first write was applied, so a repeat that is applied again shows that the version did not guard it.
      else if (a2.ok && obs.res2u.applied && obs.res2u.call && namesCarriedVersion(obs.res2u.call, res.version?.arg ?? null, obs.res2u.version_sent)) {
        // why: review of f4: the object is changed out of band first, so a repeat that the version does not guard shows as applied.
        const oob = await changeOutOfBand(d, res, a2.obj, 'R', ctx.session.stepId('gate.res2u.oob'));
        const mid = await d.readSettled('R', 'gate.res2u.oob.after', () => false);
        if (!oob || !oob.ok || !mid.ok || (deepEqual(mid.version, a2.version) && !withoutIgnored(diff(a2.obj, mid.obj), ignoredPaths(res)).length)) obs.res2u.follow = { applied_again: null, how: `the object could not be changed out of band before the repeat (${oob ? oob.how : 'no control.patch and no declared field'}), so an unguarded repeat would not show` };
        else {
          const rep = await d.update(A, f0, f0.values[1], { step: ctx.session.stepId('gate.res2u.follow'), ...(b2.ok ? { base: { obj: b2.obj, version: b2.version } } : {}) });
          const a3 = await d.readSettled('R', 'gate.res2u.follow.after', () => false);
          const fr = followRead(brief(rep), mid, a3, !!res.version, res.version?.read ?? null, ignoredPaths(res));
          obs.res2u.follow = { ...fr, how: `out of band, ${oob.how}; ${fr.how}` };
        }
      }
    }
    // A composite update: fail its second and its last mutating backend request.
    if (res.update!.mode === 'composite') {
      const muts = la.requests.filter((q) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(q.method));
      obs.atom = { trials: [] };
      if (muts.length < 2) obs.atom.skipped = `${res.update!.tool} made ${muts.length} mutating backend request(s) in the learning pass: there is no later step to fail`;
      else
        for (const k of [...new Set([2, muts.length])]) {
          await d.reset();
          const before = await d.readOnce('R', ctx.session.stepId('gate.atom.before'));
          const f = gate.fault({ method: '*', path: '*', nth: k, kind: 'status', status: 500 });
          const r = await d.update(A, f0, f0.values[1], { step: ctx.session.stepId(`gate.atom.${k}`) });
          const hit = await f.waitHit(500);
          f.clear();
          const after = await d.readSettled('R', `gate.atom.${k}.after`, () => false);
          obs.atom.trials.push({ nth: k, faulted: hit ? reqOf(hit) : null, call: brief(r), changed: before.ok && after.ok ? withoutIgnored(diff(before.obj, after.obj), ignoredPaths(res)).map((e) => e.path) : null, applied: after.ok ? deepEqual(valueAt(after.obj, f0.path), f0.values[1]) : null });
        }
    }
    await d.reset();
    return { check: ID, version: VERSION, resource: res.name, data: obs };
  },
  evaluate(obs: Observation, ctx: PlanContext): Result[] {
    const res = ctx.manifest.resources.find((r) => r.name === obs.resource)!;
    return gatedVerdicts(obs.data as GatedObs, res, ctx.manifest.async_operations ?? []);
  },
};

export function gatedVerdicts(o: GatedObs, res: ResourceSpec, asyncOps: string[] = []): Result[] {
  const w = wp(res.name, res.update!.tool);
  const sc = { id: ID, version: VERSION };
  const out: Result[] = [];
  const route = `Route: ${o.routing}`;
  // MWS-CONC-3
  const valid = o.trials.filter((t) => t.held && t.holder && t.other && !t.holder.indeterminate && !t.other.indeterminate && t.kept);
  const trialNote = (t: HeldTrial) => `${t.schedule}: held ${showReq(t.held!)}, released ${t.released}; holder ${t.holder!.ok ? 'reported success' : 'was refused'}, other ${t.other!.ok ? 'reported success' : 'was refused'}; afterwards holder's change ${t.kept!.holder ? 'present' : 'absent'}, other's ${t.kept!.other ? 'present' : 'absent'}`;
  const learnedNote = o.learned.map((l) => `learning pass (${res.fields![l.field]!.path}): ${l.requests.map(showReq).join(', ') || 'no backend request'}${l.hold ? `; holds the ${l.hold.nth}${l.hold.nth === 1 ? 'st' : l.hold.nth === 2 ? 'nd' : 'th'} ${l.hold.method} ${l.hold.path}` : ''}`);
  if (o.skipped) out.push(result('MWS-CONC-3', w, sc, 'not tested', `held request: ${o.skipped}`, { notes: [route, ...learnedNote] }));
  else if (!valid.length) out.push(result('MWS-CONC-3', w, sc, 'not tested', `held request: no trial could be forced (${o.trials.filter((t) => !t.held).length} never reached the hold; ${o.trials.filter((t) => t.held && (!t.kept || t.holder?.indeterminate || t.other?.indeterminate)).length} had an unknown outcome)`, { notes: [route, ...learnedNote] }));
  else {
    const lost = valid.filter((t) => t.holder!.ok && t.other!.ok && (!t.kept!.holder || !t.kept!.other));
    const schedules = new Set(valid.map((t) => t.schedule));
    const numbers = { trials: valid.length, lost: lost.length, serialized: valid.filter((t) => t.released.startsWith('after the hold timeout')).length, refused: valid.filter((t) => !t.holder!.ok || !t.other!.ok).length, ...(o.control ? { control_pairs: o.control.pairs, control_lost: o.control.lost } : {}) };
    const notes = [route, ...learnedNote, ...valid.map(trialNote)];
    if (lost.length) {
      const steps = lost.flatMap((t) => t.steps);
      // why: platform only from the same forced schedule (spec 7.4); a partial-update control for a whole-object tool is not that (review).
      const sameSchedule = !!o.control?.kind && (o.control.kind === 'whole' || res.update!.mode !== 'full_replace');
      if (o.control && o.control.lost > 0 && sameSchedule) out.push(result('MWS-CONC-3', w, sc, 'platform', `With one writer's backend request held until the other finished, both reported success and a change was lost in ${lost.length} of ${valid.length} forced trials; the platform's API, sent A's write after B's, also lost ${o.control.lost} of ${o.control.pairs}.`, { numbers, steps, notes: [ruleNote('RAW_API_CONTROL', 'the API loses concurrent partial updates too'), VIOLATED_CAVEAT, ...notes] }));
      else {
        // why: server only for a control arm of the same forced schedule (A's write after B's), with enough repetitions to compare.
        const forced = !!o.control?.kind && o.control.pairs >= valid.length && (o.control.kind === 'whole' || res.update!.mode !== 'full_replace');
        out.push(result('MWS-CONC-3', w, sc, 'violated', `With one writer's last backend write held until the other writer finished, both calls reported success and a change was lost in ${lost.length} of ${valid.length} forced trials.${o.control ? ` The platform's API, sent A's write after B's (${o.control.kind === 'whole' ? 'a whole-object write from A\'s read' : 'a partial update'}), lost none of ${o.control.pairs}.` : ' No control was declared, so the backend was not checked.'}`, { numbers, steps, attribution: forced ? 'server' : 'unresolved', notes: [VIOLATED_CAVEAT, ...notes, ...(o.control && !forced ? ['The control arm was not the forced schedule, or ran fewer repetitions than the tool arm, so the attribution stays unresolved (spec 8.2, rule 3).'] : [])] }));
      }
    } else if (schedules.size < 2) out.push(result('MWS-CONC-3', w, sc, 'not tested', `held request: only the schedule "${[...schedules][0]}" could be forced; its mirror never reached the hold, and a held record covers a schedule and its mirror`, { numbers, notes }));
    else out.push(result('MWS-CONC-3', w, sc, 'held', `Both schedules were forced (${valid.length} trials): each time both changes were kept, a writer was told of a conflict, or the server serialized the writers. This covers the schedules forced and their mirrors, not every interleaving.`, { numbers, notes }));
  }
  // MWS-CONC-1 (proxy-assisted)
  if (!o.conc1 && !res.version?.arg && hasControl(res, 'read', 'patch', 'write')) {
    // why: planned but not run: the record says why (gate-2 N3), never dropped.
    const la = o.learned[0];
    const why = o.independent === false ? o.skipped ?? 'the two fields are not independent one after the other; see MWS-UPD-1' : la && !la.hold ? `${res.update!.tool} sent no mutating request to the backend in the learning pass, so its write could not be held` : 'the held-request procedure did not run';
    out.push(result('MWS-CONC-1', w, sc, 'not tested', `held request: ${why}`, { notes: [route] }));
  }
  if (o.conc1) {
    const t = o.conc1.trials.filter((x) => x.held && x.tool && !x.tool.indeterminate && x.overwrote !== null);
    if (!t.length) out.push(result('MWS-CONC-1', w, sc, 'not tested', 'held request: the tool\'s write could not be held, or its outcome is unknown', { notes: [route] }));
    else {
      const refuses = t.some((x) => x.control_refuses === true);
      const over = t.filter((x) => x.tool!.ok && x.overwrote);
      const notes = [route, ...t.map((x) => `held ${showReq(x.held!)} while the platform's API changed ${res.fields![1].path}; released; the tool ${x.tool!.ok ? 'reported success' : 'was refused'}${x.overwrote ? ' and the other change is gone' : ''}`)];
      if (t.every((x) => x.control_refuses === null)) out.push(result('MWS-CONC-1', w, sc, 'not tested', 'the control arm could not establish whether the platform\'s API refuses a write from outdated state', { notes }));
      else if (!refuses) out.push(result('MWS-CONC-1', w, sc, 'not applicable', 'the backend did not apply the declared control (the platform\'s API accepted a write from outdated state).', { notes: [...notes, 'Only a version check sent with the write was declared and tried; another kind of control (such as a lock held by another user) is not staged in this preview.'] }));
      else if (over.length) out.push(result('MWS-CONC-1', w, sc, 'violated', `The platform's API refuses a write from outdated state, but ${res.update!.tool}'s write, held until another writer changed the object and then released, went over that change in ${over.length} of ${t.length} trials.`, { steps: over.map((x) => x.tool!.step), notes: [VIOLATED_CAVEAT, ...notes] }));
      else out.push(result('MWS-CONC-1', w, sc, 'held', `In ${t.length} forced trials the tool's held write did not go over the other writer's change (refused, or re-read).`, { notes }));
    }
  }
  // MWS-RES-2 (proxy-assisted)
  if (o.res2) {
    const r = o.res2;
    if (!r.skipped && r.call && !r.call.indeterminate && (r.changed === null || r.applied === null)) out.push(result('MWS-RES-2', w, sc, 'not tested', 'failed backend request: the object did not read back around the call', { notes: [route] }));
    else if (!r.skipped && r.call?.ok && r.applied) out.push(result('MWS-RES-2', w, sc, 'not tested', 'failed backend request: the server retried the failed request and the write took effect, so no failure was produced', { notes: [route] }));
    else if (r.skipped || !r.call || r.call.indeterminate) out.push(result('MWS-RES-2', w, sc, 'not tested', `failed backend request: ${r.skipped ?? 'the outcome of the call is unknown'}`, { notes: [route] }));
    else {
      const note = `failed ${showReq(r.faulted!)} with status 500 (not forwarded)`;
      // why: gate-2 safety re-run on 0295ed6 (F2): the value written is passed, so a declared applied pattern can credit an error naming it.
      const j = res2Judge(r.call, r.changed, 'backend', `The tester failed the backend request (${note})`, res.fields ? { [f0path(res)]: res.fields[0].values[1] } : {}, { async: asyncOps.includes(res.update!.tool), object: r.object });
      out.push(result('MWS-RES-2', w, sc, j.verdict, j.reason, { steps: j.verdict === 'violated' ? [r.call.step] : [], notes: [route, ...j.notes] }));
    }
  }
  // MWS-RES-2 (proxy-assisted), unknown outcome, and the clause on a settled outcome (spec 96d3691, R9-1, R10-11)
  if (o.res2u)
    out.push(
      lostAnswerVerdict(o.res2u, {
        w,
        sc: { id: `${ID}.unknown-outcome`, version: VERSION },
        route,
        tool: res.update!.tool,
        readTool: res.read.tool,
        versionArg: res.version?.arg ?? null,
        values: res.fields ? { [f0path(res)]: res.fields[0].values[1] } : {},
        fallbackChanged: res.fields ? [f0path(res)] : [],
        async: asyncOps.includes(res.update!.tool),
        learned: o.learned.map((l) => ({ label: res.fields![l.field]!.path, requests: l.requests, call: l.call, applied: l.applied })),
      }),
    );
  // MWS-ATOM-1 and MWS-ATOM-2 for a composite update
  if (o.atom) {
    if (o.atom.skipped) out.push(...(['MWS-ATOM-1', 'MWS-ATOM-2'] as const).map((id) => result(id, w, sc, 'not applicable', o.atom!.skipped!, { notes: [route] })));
    else {
      // why: a trial whose reads failed, or whose fault the server absorbed by retrying, produced no failure to judge.
      const t = o.atom.trials.filter((x) => x.faulted && x.call && !x.call.indeterminate && x.changed !== null && !(x.call.ok && x.applied));
      if (!t.length) out.push(...(['MWS-ATOM-1', 'MWS-ATOM-2'] as const).map((id) => result(id, w, sc, 'not tested', 'no backend write of the composite update could be failed', { notes: [route] })));
      else {
        const notes = [route, ...t.map((x) => `failed the ${x.nth}th mutating request ${showReq(x.faulted!)}: ${x.call!.ok ? 'success reported' : 'error'}; stayed changed: ${x.changed!.join(', ') || 'nothing'}`)];
        // why: note 19 (rule 11): whether an error names what stayed applied is read by declared patterns only.
        // why: review of note 19 (5): MWS-ATOM-1 asks that a partial outcome names what was applied; an unknown outcome is not that.
        type AtomRead = { v: 'held' | 'violated' | 'unread'; why: string; notes: string[] };
        // why: rule 11 (B-9 v2): the adopted result shape read on its own. `unknown` names the step as open (spec R14-4; MWS-RES-2
        // judges that statement); `not_applied` while a part stayed is a false statement; otherwise `changed` must name each part
        // that stayed (a missing changed member says nothing).
        const atomShape = (x: (typeof t)[number], sh: WriteResult): AtomRead => {
          const by = decidedByShape([['outcome', sh.outcome], ['changed', sh.changed], ['items', sh.items]], x.call!);
          if (!sh.outcome) return { v: 'unread', why: 'its adopted result shape has no well-formed outcome', notes: [by] };
          if (sh.outcome === 'unknown') return { v: 'held', why: `it says, in its adopted result shape, that it is not known whether the step was applied (${quoteField('outcome', 'unknown')}; spec R14-4; MWS-RES-2 judges that statement)`, notes: [by] };
          if (sh.outcome === 'not_applied') return { v: 'violated', why: `its adopted result shape says the write was not applied (${quoteField('outcome', 'not_applied')}), while ${x.changed!.join(', ')} stayed applied`, notes: [by] };
          if (sh.outcome === 'accepted' || sh.changed === undefined) return { v: 'unread', why: `its adopted result shape (${quoteField('outcome', sh.outcome)}) does not list the fields changed, so it does not state what stayed applied`, notes: [by] };
          const missing = x.changed!.filter((p) => !shapeNamesField(sh, p));
          return missing.length ? { v: 'violated', why: `by its adopted result shape the error does not name ${missing.join(', ')} (${quoteField('changed', sh.changed)})`, notes: [by] } : { v: 'held', why: `it names what stayed applied (${quoteField('changed', sh.changed)})`, notes: [by] };
        };
        const atomRead = (x: (typeof t)[number]): AtomRead => {
          const tr = atomText(x);
          const sh = shapeOf(x.call!);
          if (!sh) return tr;
          // why: rule 11 (R14-5): the shape and the text are read on their own; a forbidden statement in either gives violated.
          const sr = atomShape(x, sh);
          if (sr.v === 'violated' || tr.v === 'violated') return { v: 'violated', why: [sr.v === 'violated' ? sr.why : '', tr.v === 'violated' ? tr.why : ''].filter(Boolean).join('; and '), notes: [...(sr.v === 'violated' ? sr.notes : []), ...(tr.v === 'violated' ? tr.notes : [])] };
          if (sr.v === 'held') return sr;
          return tr.v === 'held' ? tr : { ...sr, notes: [...sr.notes, ...tr.notes] };
        };
        const atomText = (x: (typeof t)[number]): AtomRead => {
          const text = `${x.call!.text ?? ''} ${x.call!.rpc_error?.message ?? ''}`.trim();
          // why: rule-11 coverage package: a declared outcome field that says not applied, while a part stayed, is a positive match.
          const fo = outcomeByField(x.call!);
          if (fo?.outcome === 'not_applied') return { v: 'violated', why: `the declared outcome field says the write was not applied, while ${x.changed!.join(', ')} stayed applied`, notes: [fo.line] };
          // why: spec R14-4 (owner): a step whose outcome is open for the server (the interposer answered with a failure) is named
          // where the result says it is not known whether it was applied; MWS-RES-2 judges that statement. Read by the declared
          // outcome field or a declared patterns.outcome_unknown only (rule 11).
          if (fo?.outcome === 'unknown') return { v: 'held', why: 'it says, in the declared outcome field, that it is not known whether the step was applied (spec R14-4; MWS-RES-2 judges that statement)', notes: [fo.line] };
          if (fromDeclaration('outcome_unknown') && says('outcome_unknown', text)) return { v: 'held', why: 'it says that it is not known whether the step was applied (spec R14-4; MWS-RES-2 judges that statement)', notes: [saidBy('outcome_unknown', text)] };
          if (!fromDeclaration('applied')) return { v: 'unread', why: `whether the error names what stayed applied (${x.changed!.join(', ')}) is decided by patterns.applied, which the declaration does not give; a default pattern alone decides nothing (spec 7.3, rule 11): ${JSON.stringify(short(text, 200))}. Declare it, or read it`, notes: [saidBy('applied', text)] };
          const missing = x.changed!.filter((p) => !identifiesChangeText(x.call!, p));
          if (!missing.length) return { v: 'held', why: 'it names what stayed applied', notes: [saidBy('applied', text)] };
          // why (declared-carryover): violated only on a positive match of a pattern that means one.
          if (fromDeclaration('not_applied') && says('not_applied', text) && !mayBeUnknown(text)) return { v: 'violated', why: `by the declared patterns.not_applied the error says the write failed or nothing was changed, while ${missing.join(', ')} stayed applied`, notes: [saidBy('not_applied', text), saidBy('applied', text)] };
          return { v: 'unread', why: `${missing.join(', ')} stayed applied and the error needs reading (the declared patterns.applied does not find them named, and no declared pattern says the write failed): ${JSON.stringify(short(text, 200))}`, notes: [saidBy('applied', text)] };
        };
        const rd = new Map(t.map((x) => [x, x.call!.ok || !x.changed!.length ? null : atomRead(x)]));
        // why: spec R15-3: content that says the whole write took effect, by the declared patterns.applied_all, while a step was failed,
        // is violated whether or not the result is an error; the shape or another text beside it does not make up for it.
        const allSaid = new Map(t.map((x) => [x, appliedAllSaid(x.call!)]));
        const bad1 = t.filter((x) => x.call!.ok || rd.get(x)?.v === 'violated' || allSaid.get(x));
        // why: rule 11: the record quotes what it relied on, where the adopted result shape decided it.
        const shapeNotesOf = (xs: typeof t) => [...new Set(xs.filter((x) => shapeOf(x.call!)).flatMap((x) => rd.get(x)?.notes ?? []))];
        const unread = t.filter((x) => rd.get(x)?.v === 'unread');
        out.push(bad1.length ? result('MWS-ATOM-1', w, sc, 'violated', `A failed step of ${res.update!.tool} was ${bad1.some((x) => x.call!.ok) ? 'reported as a success' : 'reported without naming what stayed applied, by the declared patterns or the adopted result shape'} (${bad1.length} of ${t.length} trials).`, { steps: bad1.map((x) => x.call!.step), notes: [...notes, ...shapeNotesOf(bad1), ...bad1.flatMap((x) => (allSaid.get(x) ? [`Its content says the whole write took effect while a step was failed (spec R15-3): ${allSaid.get(x)}`] : []))] }) : unread.length ? result('MWS-ATOM-1', w, sc, 'not tested', `A failed step of ${res.update!.tool} was reported as an error, and whether it named what stayed applied could not be decided in ${unread.length} of ${t.length} trials: ${rd.get(unread[0]!)!.why}`, { notes: [...notes, ...rd.get(unread[0]!)!.notes] }) : result('MWS-ATOM-1', w, sc, 'held', `Every failed step was reported as an error that named what stayed applied, or nothing stayed applied (${t.length} trials).`, { notes: [...notes, ...shapeNotesOf(t), ...(appliedAllUnread() ? [appliedAllUnread()!] : [])] }));
        const partial = t.filter((x) => x.changed!.length > 0);
        out.push(partial.length ? result('MWS-ATOM-2', w, sc, 'violated', `Changes from a failed composite update stayed applied in ${partial.length} of ${t.length} trials: ${partial.map((x) => x.changed!.join(', ')).join('; ')}.`, { steps: partial.map((x) => x.call!.step), notes }) : result('MWS-ATOM-2', w, sc, 'held', `No change stayed applied after any failed step (${t.length} trials, the failure positions tested only).`, { notes }));
      }
    }
  }
  return out;
}

const f0path = (res: ResourceSpec): string => res.fields![0].path;

/** The run without a fault of a write (R9-1): its backend requests, its answer and whether the write read back as in effect. */
export interface SettledRun {
  /** What the run wrote (a field path, or the write call), for the record. */
  label: string;
  requests: Req[];
  call?: CallBrief;
  applied?: boolean | null;
}

/** The lost-answer trial's observation: the backend applied the call's last mutating request and its answer was cut. */
export interface LostAnswerObs {
  skipped?: string;
  faulted: Req | null;
  call: CallBrief | null;
  changed: string[] | null;
  applied: boolean | null;
  object?: unknown;
  requests?: Req[];
  version_sent?: unknown;
  /** R10-11: the repeat sent once with the version the call carried, with no fault, where the error named that version. */
  follow?: FollowThroughRead | null;
}

/**
 * MWS-RES-2, the lost-answer trial (spec 96d3691, R9-1, R10-11), and the clause on a settled outcome read in the runs without a
 * fault: one record for one write path. Used by the update tool's held-request check and by the write-faults check for every
 * other declared write call; the verdict rules are the same for both.
 */
export function lostAnswerVerdict(r: LostAnswerObs, x: { w: WritePath; sc: { id: string; version: string }; route: string; tool: string; readTool: string; versionArg: string | null; values: Record<string, unknown>; fallbackChanged: string[]; async: boolean; learned: SettledRun[] }): Result {
  const su = x.sc;
  const w = x.w;
  const route = x.route;
  const what = r.faulted ? `the backend applied ${showReq(r.faulted)} and the connection closed before the server received the answer` : '';
  const textOf = (c: CallBrief) => `${c.text ?? ''} ${c.rpc_error?.message ?? ''}`.trim();
  const quoteOf = (c: CallBrief) => JSON.stringify(short(textOf(c), 200));
  // why: review (4): what a success says is read in its prose, never in a value of its data (a status "Unknown").
  // why: rule 11 (R14-5): an adopted result shape that says unknown is a statement of its own, beside the text; either one counts.
  const shapeUnknown = (c: CallBrief) => shapeOf(c)?.outcome === 'unknown';
  const textUnknown = (c: CallBrief) => (c.ok ? says('outcome_unknown', proseOf(c.text)) : saysUnknownText(c));
  const unknownIn = (c: CallBrief) => shapeUnknown(c) || textUnknown(c);
  const unknownDecl = (c: CallBrief) => { if (shapeUnknown(c)) return true; const f = outcomeByField(c); return f ? f.outcome === 'unknown' : fromDeclaration('outcome_unknown') && textUnknown(c); };
  const unknownBy = (c: CallBrief) => (shapeUnknown(c) ? decidedByShape([['outcome', 'unknown']], c) : `What the results say (outcome unknown) was decided by the declaration's pattern patterns.outcome_unknown, on the answers quoted above (spec 7.3, rule 11).`);
  let rec: Result;
  const extraNotes: string[] = [];
  if (r.skipped || !r.call) rec = result('MWS-RES-2', w, su, 'not tested', `unknown outcome: ${r.skipped ?? 'the call was not made'}`, { notes: [route] });
  else if (r.call.indeterminate) rec = result('MWS-RES-2', w, su, 'not tested', 'unknown outcome: the tool call itself timed out or lost the connection', { notes: [route] });
  else if (r.call.result_type && !KNOWN_RESULT_TYPES.includes(r.call.result_type)) rec = result('MWS-RES-2', w, su, 'not tested', `unknown outcome: the result has resultType ${JSON.stringify(r.call.result_type)}, which the tester does not recognize; it is invalid under the MCP specification, so the trial is indeterminate (spec 7.3, rule 5)`, { notes: [route] });
  else if (r.applied === null || r.changed === null) rec = result('MWS-RES-2', w, su, 'not tested', 'unknown outcome: the object did not read back after the call, so the condition was not established', { notes: [route] });
  else if (r.applied === false) {
    // why: R6-4: the backend applied the write (the interposer let it through) and the read-back does not show it, so the
    // server undid it; the trial is judged as any failed write: what the answer says is compared with what remains applied.
    const j = res2Judge(r.call, r.changed, 'backend', `Unknown outcome: ${what}; the read-back does not show the write, so the server undid it`, x.values, { async: x.async, object: r.object });
    rec = result('MWS-RES-2', w, su, j.verdict, j.reason, { steps: j.verdict === 'violated' ? [r.call.step] : [], notes: [route, ...j.notes] });
  } else if (r.call.result_type && r.call.result_type !== 'complete') rec = result('MWS-RES-2', w, su, 'not tested', `unknown outcome: the answer was a ${r.call.result_type} result; judging it on its final state is not built in this preview`, { notes: [route] });
  else if (r.call.ok) {
    // why (review of note 8, 4; R9-1 kind no-error-flag): the success's prose is read, never a value of its data, and only a
    // declared pattern decides (rule 11).
    const prose = notAppliedText(r.call);
    const failedD = fromDeclaration('not_applied') && says('not_applied', prose);
    const unknownD = unknownDecl(r.call);
    // why: rule 11 (B-9 v2): a success whose adopted result shape says not_applied, partial or unknown states a failure or an open
    // outcome without isError, as the same words in text would; read on its own beside the text (R14-5).
    const so = shapeOf(r.call)?.outcome;
    const shapeD = so === 'not_applied' || so === 'partial' || so === 'unknown';
    const SAYS: Record<string, string> = { unknown: 'that it is not known whether the write was applied', partial: 'that the write was applied in part', not_applied: 'that the write was not applied' };
    if (shapeD && !failedD) rec = result('MWS-RES-2', w, su, 'violated', `Unknown outcome: ${what}, the write is in effect, and the result has no isError: true while its adopted result shape says ${SAYS[so!]} (${quoteField('outcome', so)}) (third clause; kind no-error-flag).`, { steps: [r.call.step], notes: [route, decidedByShape([['outcome', so]], r.call)] });
    else if (failedD || unknownD) rec = result('MWS-RES-2', w, su, 'violated', `Unknown outcome: ${what}, the write is in effect, and the result has no isError: true while its content says ${failedD ? 'that the write failed or that nothing was changed' : 'that it is not known whether the write was applied'}: ${JSON.stringify(short(prose, 200))} (third clause; kind no-error-flag)${shapeD ? `; its adopted result shape also says ${quoteField('outcome', so)}` : ''}.`, { steps: [r.call.step], notes: [route, failedD ? saidBy('not_applied', prose) : saidBy('outcome_unknown', textOf(r.call)), ...(shapeD ? [decidedByShape([['outcome', so]], r.call)] : [])] });
    else if (says('not_applied', prose) || unknownIn(r.call)) rec = result('MWS-RES-2', w, su, 'not tested', `unknown outcome: ${what}; the write is in effect and the tool answered with a success whose text only the tester's default patterns read as saying the write failed or that the outcome is not known: ${JSON.stringify(short(prose, 200))}. A default pattern alone does not decide (spec 7.3, rule 11): declare patterns.not_applied and patterns.outcome_unknown, or read it`, { notes: [route, saidBy('not_applied', prose), saidBy('outcome_unknown', textOf(r.call))] });
    else rec = result('MWS-RES-2', w, su, 'not tested', `unknown outcome: ${what}; the tool answered with a success${so ? ` (${quoteField('outcome', so)} in its adopted result shape)` : ''}, which reports no failure, so this trial adds no verdict here (whether the success is true is MWS-RES-1)`, { notes: [route, ...(so ? [decidedByShape([['outcome', so]], r.call)] : [])] });
  } else if (r.call.rpc_error) rec = result('MWS-RES-2', w, su, 'violated', `Unknown outcome: ${what}, and ${x.tool} returned a JSON-RPC error (${r.call.rpc_error.code}); the lost answer is a failure of the backend, so it must be a tool execution error (third clause; kind protocol-error).`, { steps: [r.call.step], notes: [route] });
  else {
    // why: gate-2 re-run on 378f32f (note 19, R9, R10; rule 11): only declared patterns decide what the error says.
    const text = textOf(r.call);
    const vals: Record<string, unknown> = x.values;
    // R9-1 (2), R10-11: an invitation to repeat the write whose outcome is open, naming neither a read, nor the key, nor the version
    // the call carried, is retry-invited. A read is named by the read tool or the object; the version by the value the call carried.
    const invites = says('retry_invited', text);
    // why: review (2, 7): a read is named by the read tool's name, or by a declared patterns.read_named; an object id alone may be
    // only the subject of the sentence, so it leaves the question open (no held, no retry-invited violated). The version is named
    // by the value the call carried, or by the version argument's name ("the same expected_version").
    const toolNamed = new RegExp(`(^|[^A-Za-z0-9_])${x.readTool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9_])`).test(text);
    const declaredRead = fromDeclaration('read_named') && says('read_named', text);
    const objectOnly = !toolNamed && !declaredRead && r.object !== undefined && r.object !== null && valueMentioned(r.call, r.object);
    const namesRead = toolNamed || declaredRead;
    const namesVersion = textNamesVersion(r.call, x.versionArg, r.version_sent);
    // why: B-9 v2 ("How a tester uses it"): repeat is read as the tester can check it. The trial sends the declared update
    // arguments and adds no idempotency key; the version it carried is known where the declaration requires one.
    // (what the call carried is recorded by the driver, CallBrief.carried; older evidence leaves it open, and then no held.)
    const rd = readSecondClause(r.call, (r.changed ?? []).length ? r.changed! : x.fallbackChanged, vals, { lostAnswer: true, textNamesRead: namesRead ? true : objectOnly ? 'maybe' : false, followThrough: r.follow ?? null });
    // why: D-2 (owner, 15 Nov): a declared patterns.repeat_invited is the declarer's statement that what it matches invites a
    // repeat without a read first and without the key or version: kind retry-invited, beside a correct shape too (R14-5).
    const prose = proseOf(r.call.text);
    const repInv = fromDeclaration('repeat_invited') && says('repeat_invited', prose);
    let blockHeld: string | null = null;
    let followViolates: string | null = null;
    if (repInv) rec = result('MWS-RES-2', w, su, 'violated', `Unknown outcome: ${what}, the write is in effect, and by the declared patterns.repeat_invited the error invites the caller to send the call again, naming no read to make first and no key or version to repeat it with (second clause; kind retry-invited): ${quoteOf(r.call)}.`, { steps: [r.call.step], notes: [route, saidBy('repeat_invited', prose), ...rd.notes] });
    else if (invites && !namesRead && !namesVersion && objectOnly) {
      blockHeld = `the error invites a repeat and names the object ${short(r.object, 40)}, but whether it names it as a read to make first is decided by patterns.read_named, which the declaration does not give (spec 7.3, rule 11): ${quoteOf(r.call)}`;
      rec = result('MWS-RES-2', w, su, 'not tested', `unknown outcome: ${what}; the write is in effect; ${blockHeld}`, { notes: [route, saidBy('retry_invited', text), ...rd.notes] });
    } else if (invites && !namesRead && !namesVersion && fromDeclaration('retry_invited')) rec = result('MWS-RES-2', w, su, 'violated', `Unknown outcome: ${what}, the write is in effect, and the error tells the caller to repeat the call without naming a read to make first, the idempotency key or the version the call carried (second clause; kind retry-invited): ${quoteOf(r.call)}.`, { steps: [r.call.step], notes: [route, saidBy('retry_invited', text), ...rd.notes] });
    else {
      if (invites && !namesRead && !namesVersion) blockHeld = `only the tester's default pattern reads the error as telling the caller to repeat the call (declare patterns.retry_invited, or read it): ${quoteOf(r.call)}`;
      // why: R10-11: an error that invites a repeat with the version the call carried is decided by the follow-through: the call sent
      // again once with that version, with no fault, and read back. Applied again: retry-invited; a conflict or nothing applied again: met.
      if (invites && namesVersion && !namesRead) {
        if (r.follow?.applied_again === true) followViolates = `the error invites a repeat with the version the call carried, and the follow-through repeat with that version, sent with no fault, was applied again: the version did not guard the repeat (${r.follow.how})`;
        else if (r.follow?.applied_again !== false) blockHeld = `the error invites a repeat with the version the call carried; ${r.follow ? `the follow-through repeat with that version could not show whether it was applied again (${r.follow.how})` : 'the follow-through repeat with that version was not sent in this trial'}, so whether the version guards the repeat is not known`;
      }
      if (followViolates) rec = result('MWS-RES-2', w, su, 'violated', `Unknown outcome: ${what}, the write is in effect; ${followViolates} (second clause; kind retry-invited): ${quoteOf(r.call)}.`, { steps: [r.call.step], notes: [route, saidBy('retry_invited', text), ...rd.notes] });
      else if (rd.v === 'held' && !blockHeld) rec = result('MWS-RES-2', w, su, 'held', `Unknown outcome: ${what}; the error ${rd.why}: ${JSON.stringify(short(r.call.text ?? '', 200))}.`, { notes: [route, ...rd.notes] });
      else if (rd.v === 'violated') {
        // why: review (14): which kind is a reading too; without a declared not_applied pattern it is not decided. Where only the
        // adopted result shape gives the violation, its members give the kind (B-9 v2), where they give one.
        const fk = failedKind(true);
        const textKind = !fromDeclaration(fk) ? 'stated-failure or bare-transport, not decided: declare patterns.write_failed' : says(fk, text) ? 'stated-failure' : 'bare-transport';
        const kind = rd.text?.v === 'violated' ? (rd.shape?.v === 'violated' && rd.shape.kind && rd.shape.kind !== textKind ? `${textKind} (text); ${rd.shape.kind} (shape)` : textKind) : rd.shape?.kind ?? 'not named by the shape';
        rec = result('MWS-RES-2', w, su, 'violated', `Unknown outcome: ${what}, the write is in effect; ${rd.why} (second clause; kind ${kind}): ${JSON.stringify(short(r.call.text ?? '', 200))}.`, { steps: [r.call.step], notes: [route, ...rd.notes] });
      } else rec = result('MWS-RES-2', w, su, 'not tested', `unknown outcome: ${what}; the write is in effect; ${rd.v === 'held' ? `the error ${rd.why}, but ${blockHeld}` : rd.why}${blockHeld && rd.v !== 'held' ? `; also, ${blockHeld}` : ''}`, { notes: [route, ...rd.notes] });
    }
    // why: rule 11 (R14-5): a forbidden statement in the adopted result shape gives its verdict whatever the text reading gave.
    if (rec.verdict !== 'violated' && rd.shape?.v === 'violated') rec = result('MWS-RES-2', w, su, 'violated', `Unknown outcome: ${what}, the write is in effect; by the adopted result shape, ${rd.shape.why} (second clause; kind ${rd.shape.kind ?? 'not named by the shape'}). The text reading gave: ${rec.reason}`, { steps: [r.call.step], notes: [route, ...rd.shape.notes, ...rec.notes.filter((x) => x !== route)] });
  }
  // R9-1 (3): a settled outcome reported as not known, kind unknown-when-settled. These runs add violated or nothing, never held.
  const settled: string[] = [];
  const settledBy: string[] = [];
  const delivered = (q: Req) => typeof q.status === 'number' && q.status !== 202 && ((q.status >= 200 && q.status < 300) || (q.status >= 400 && q.status < 500));
  for (const l of x.learned) {
    // why: review (5): NF-19, an operation the declaration lists as completed asynchronously, is not such a statement.
    if (x.async) continue;
    if (!l.call || l.call.indeterminate || !l.requests.length || !l.requests.every(delivered) || !unknownIn(l.call)) continue;
    const mut = l.requests.filter((q) => !/^(GET|HEAD|OPTIONS)$/i.test(q.method));
    const allDone = mut.length > 0 && mut.every((q) => q.status! < 300);
    const allRefused = mut.length > 0 && mut.every((q) => q.status! >= 400);
    const agrees = (allDone && l.applied === true) || (allRefused && l.applied === false);
    if (!agrees) continue;
    const line = `in the run without a fault (${l.label}), the interposer delivered the backend's own answer to each of ${l.requests.length} request(s) (${l.requests.map((q) => `${q.method} ${q.path} ${q.status}`).join(', ')}), the read-back agrees, and the result says it is not known whether the write was applied: ${quoteOf(l.call)}`;
    if (unknownDecl(l.call!)) settled.push(line), settledBy.push(unknownBy(l.call!));
    else extraNotes.push(`Seen, not judged (rule 11: only the default pattern for outcome unknown reads it): ${line}.`);
  }
  if (r.faulted && r.call && !r.call.indeterminate && r.applied === true && !x.async && unknownIn(r.call)) {
    const again = (r.requests ?? []).filter((q) => q.seq > r.faulted!.seq && q.method === r.faulted!.method && q.path === r.faulted!.path && typeof q.status === 'number' && q.status !== 202 && q.status >= 200 && q.status < 300);
    if (again.length) {
      const line = `in the lost-answer trial the server sent the cut request again (${again.map((q) => `#${q.seq} ${q.method} ${q.path} ${q.status}`).join(', ')}) and received the backend's answer that it was carried out, yet the result says it is not known whether the write was applied: ${quoteOf(r.call)}`;
      if (unknownDecl(r.call)) settled.push(line), settledBy.push(unknownBy(r.call));
      else extraNotes.push(`Seen, not judged (rule 11): ${line}.`);
    }
  }
  if (settled.length) {
    const why = `A settled outcome was reported as not known (second clause; kind unknown-when-settled): ${settled.join('; ')}.`;
    const by = [...new Set(settledBy)];
    rec = rec.verdict === 'violated' ? { ...rec, reason: `${rec.reason} ${why}`, notes: [...rec.notes, ...by] } : { ...rec, verdict: 'violated', reason: `${why} ${rec.verdict === 'held' ? `(The lost-answer trial alone: ${rec.reason})` : ''}`.trim(), notes: [...rec.notes, ...by] };
  }
  if (r.follow) extraNotes.push(/^the object could not be changed out of band/.test(r.follow.how) ? `Follow-through (R10-11): not sent: ${r.follow.how}.` : `Follow-through (R10-11): the object was changed out of band, and the call was sent again once with the version it carried (${short(r.version_sent, 40)}), with no fault; ${r.follow.applied_again === true ? 'it was applied again' : r.follow.applied_again === false ? 'it was not applied again' : 'whether the version guards the repeat could not be read'} (${r.follow.how}).`);
  if (extraNotes.length) rec = { ...rec, notes: [...rec.notes, ...extraNotes] };
  if (r.faulted && r.call && !r.call.indeterminate && r.applied === true && r.call.ok && !(r.requests ?? []).some((q) => q.seq > r.faulted!.seq)) rec = { ...rec, notes: [...rec.notes, 'Observation: unverified-success (the server made no further backend request after the cut, and answered with a success).'] };
  return rec;
}

/** Does the error's text name the version the call carried (its value) or the version argument ("the same expected_version")? */
export function textNamesVersion(c: CallBrief, versionArg: string | null, versionSent: unknown): boolean {
  if (!versionArg) return false;
  const text = `${c.text ?? ''} ${c.rpc_error?.message ?? ''}`.trim();
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // why: review of f4: a bare number is named as the version only beside the version argument's name or the word "version"
  // ("expected_version 3", "version: 3", "3 (the version)"); a number elsewhere in the text (an id, a count) is not.
  const byValue = versionSent !== undefined && versionSent !== null && (typeof versionSent === 'number' || /^\d+$/.test(String(versionSent)) ? new RegExp(`\\b(${esc(versionArg)}|version)\\b[^.\\n\\d]{0,24}(^|[^A-Za-z0-9_-])${esc(String(versionSent))}($|[^A-Za-z0-9_-])|(^|[^A-Za-z0-9_-])${esc(String(versionSent))}\\W{1,4}(the )?(${esc(versionArg)}|version)\\b`, 'i').test(text) : valueMentioned(c, versionSent));
  return byValue || new RegExp(`(^|[^A-Za-z0-9_])${versionArg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9_])`).test(text);
}

/**
 * Whether the lost-answer trial sends the follow-through (R10-11): the call carried a version, the write is in effect, and the
 * error names that version, by its adopted result shape (repeat: same_version) or in its text.
 */
export function namesCarriedVersion(c: CallBrief, versionArg: string | null, versionSent: unknown): boolean {
  if (c.ok || c.indeterminate || versionSent === null || versionSent === undefined) return false;
  return shapeOf(c)?.repeat === 'same_version' || textNamesVersion(c, versionArg, versionSent);
}

/**
 * What the follow-through repeat did (R10-11). The object was changed out of band after the lost-answer trial (`mid` is the read
 * after that change), so a repeat that is applied again shows: the version moved, or the state changed, from `mid` to `after`.
 * A repeat that changed nothing meets the requirement only where it was refused as a conflict (a structured signal, or a declared
 * patterns.conflict) or answered as a replay (an adopted shape's replayed: true); any other answer that changed nothing (a plain
 * success, a refusal of another kind) does not show what the version did, and gives null: not tested. A backend that leaves the
 * version alone for a write that changes nothing would otherwise give an unearned held.
 */
export function followRead(rep: { ok: boolean; text: string | null; rpc_error: { code: number; message: string } | null; data?: unknown; shape?: CallBrief['shape']; tool?: string; timed_out?: boolean; transport_error?: string | null }, mid: { ok: boolean; obj: unknown; version: unknown }, after: { ok: boolean; obj: unknown; version: unknown }, versioned: boolean, versionPath: string | null, ignore: string[]): FollowThroughRead {
  const answer = rep.timed_out || rep.transport_error ? 'the repeat timed out or lost its connection' : rep.ok ? 'the repeat was answered as a success' : `the repeat was refused (${JSON.stringify(short(rep.text ?? rep.rpc_error?.message ?? '', 100))})`;
  if (rep.timed_out || rep.transport_error) return { applied_again: null, how: answer };
  if (!mid.ok || !after.ok) return { applied_again: null, how: `${answer}; the object did not read back around it` };
  const moved = versioned && !deepEqual(mid.version, after.version);
  const changed = withoutIgnored(diff(mid.obj, after.obj), [...ignore, ...(versionPath ? [versionPath] : [])]).map((e) => e.path);
  const seen = `${versioned ? `the version read ${short(mid.version, 30)} before it and ${short(after.version, 30)} after it; ` : ''}the state ${changed.length ? `changed (${changed.join(', ')})` : 'read back unchanged'}`;
  if (moved || changed.length) return { applied_again: true, how: `${answer}; ${seen}` };
  const conflict = !rep.ok ? (conflictSignal(rep as never)?.source ?? (fromDeclaration('conflict') && says('conflict', `${rep.text ?? ''} ${rep.rpc_error?.message ?? ''}`) ? 'the declared patterns.conflict' : null)) : null;
  if (conflict) return { applied_again: false, how: `${answer}, as a conflict (${conflict}); ${seen}` };
  if (rep.ok && shapeOf(rep as never)?.replayed === true) return { applied_again: false, how: `${answer}, as a replay (mws.replayed = true); ${seen}` };
  return { applied_again: null, how: `${answer}; ${seen}; it was neither refused as a conflict nor answered as a replay, so it does not show whether the version guards a repeat` };
}

/**
 * The out-of-band change before the follow-through repeat (R10-11): one declared field set to a value it does not hold, through
 * the platform's API (control.patch) where declared, else through the update tool with the current version. Null where neither is
 * declared or the object has no declared field.
 */
export async function changeOutOfBand(d: Driver, res: ResourceSpec, cur: unknown, label: string, step: string): Promise<{ ok: boolean; how: string } | null> {
  const f = res.fields?.[0];
  if (!f) return null;
  const now = valueAt(cur, f.path);
  const v = f.values.find((x) => !deepEqual(x, now)) ?? f.values[0];
  if (hasControl(res, 'patch')) {
    const r = await d.controlPatch(f, v, step).catch(() => null);
    return { ok: !!r?.ok, how: `${f.path} set to ${short(v, 30)} through control.patch${r?.ok ? '' : ` (refused: HTTP ${r?.status ?? '?'})`}` };
  }
  if (res.update) {
    const r = await d.update(label, f, v, { step });
    return { ok: r.ok, how: `${f.path} set to ${short(v, 30)} through ${res.update.tool}${r.ok ? '' : ' (refused)'}` };
  }
  return null;
}
