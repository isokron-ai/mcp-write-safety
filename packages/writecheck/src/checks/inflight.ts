/**
 * The in-flight scenarios of a keyed create (tiny-tracker 0.4.0 review B1 and B9; spec MWS-RES-1, MWS-RES-2, Annex B-9 "A repeat
 * with a key"): two conditions that need a write held while the server answers, which no other check brings about.
 *
 *   lost answer,      (proxy-assisted, forced) MWS-RES-1. A learning pass sends the keyed create alone through the gate and
 *   request held      records its backend requests. Then, on a fresh marker and key, the gate takes the create's last mutating
 *   (lost-held)       backend request off the wire, closes the server's connection at once with no answer, and holds the
 *                     request. The server answers its caller with the request still on its way. The tester then releases the
 *                     request, waits for the backend's answer to it, and reads back by the marker. A result that reported the
 *                     write as not applied (or a success) is judged against the state in effect afterwards: a "not applied"
 *                     followed by the held request creating the object is `violated`. A server that answers "not known", or
 *                     closes the key before it reports "not applied" (a fence), holds.
 *   same key while    (target-assisted, forced) MWS-RES-2. The first keyed create is held inside the backend after the backend
 *   the first is      has taken its key and before it commits, through the hold the declaration names (backend.inflight_hold,
 *   in flight         fixture-api/1: backend/before-commit/delay). While it is held, the same call with the same key is sent.
 *   (same-key)        After the first has finished, the tester reads back by the marker. Under B-9 a keyed call's outcome and
 *                     code describe the write the key identifies, so a second answer that says "not applied" while that write
 *                     is in effect afterwards is `violated` (second clause); "in progress", "not known" or a replay hold.
 *
 * Where the tester cannot bring a condition about, the record is `not tested` with the reason, never a verdict on the target:
 * no gate, a gate route that cannot cut and hold (the in-process hook and the wire gate), no declared in-flight hold, a hold the
 * target's control refused or that did not fire, a request that matched other backend requests than the learning pass.
 */

import { baseVars } from '../core/driver.js';
import type { InflightHold, ResourceSpec } from '../core/manifest.js';
import { createVerified } from '../core/objects.js';
import { listAll } from '../core/lists.js';
import type { CallResult, HttpResult } from '../core/session.js';
import { render } from '../core/template.js';
import { getPath, isObj, nowMs, short, sleep, type Obj } from '../core/util.js';
import { lastMutating, nthOf, type GateRequest } from '../gate/gate.js';
import { result, type Result } from '../report/verdicts.js';
import { shapeOf } from './shape.js';
import { brief, readSecondClause, res2Judge, toolByName, wp, type CallBrief, type CheckModule, type Observation, type PlanContext, type PlannedCheck, type RunContext } from './types.js';

const ID = 'inflight';
const VERSION = '1';
export const INFLIGHT_SCENARIOS = { lostHeld: `${ID}.lost-held`, sameKey: `${ID}.same-key` } as const;
/** How long the tester waits for the backend's answer to a released request, and for a target's hold to fire. */
const LAND_WAIT_MS = 10_000;
const FIRE_WAIT_MS = 5_000;

/**
 * Tests only: a mutation of the forced schedule, so a test can show that the schedule is what finds a defect (with it changed,
 * the defect build reads clean). `release-before-answer`: the lost-held trial lets the held request through as soon as it is
 * held, before the server answers. `second-after-first`: the same-key trial sends the second call only after the first answered.
 */
export const INFLIGHT_SCHEDULE: { mutation: null | 'release-before-answer' | 'second-after-first' } = { mutation: null };

type Req = { seq: number; method: string; path: string; status: number | null };
const reqOf = (r: GateRequest): Req => ({ seq: r.seq, method: r.method, path: r.path, status: r.status });
const showReq = (r: Pick<Req, 'seq' | 'method' | 'path'>) => `#${r.seq} ${r.method} ${r.path}`;

/** What the trace by marker read: the objects that carry the call's marker. */
export interface MarkerTrace {
  step: string;
  ok: boolean;
  count: number | null;
  ids: unknown[];
  reason?: string;
}

export interface LostHeldObs {
  skipped?: string;
  routing: string | null;
  learned: { method: string; path: string; nth: number; requests: Req[] } | null;
  key: string;
  before: MarkerTrace | null;
  call: CallBrief | null;
  held: Req | null;
  /** The backend's status for the released request; null where it gave none. */
  landed: number | null;
  /** The requests of the trial at the gate (the held one, and any the server sent after the cut: a lookup, a fence, a retry). */
  requests: Req[];
  after: MarkerTrace | null;
}

export interface SameKeyObs {
  skipped?: string;
  hold: string | null;
  key: string;
  before: MarkerTrace | null;
  /** The target's answer to the arming. */
  armed: { status: number | null; id: string | null } | null;
  first: (CallBrief & { t_end_ms: number }) | null;
  second: (CallBrief & { t_end_ms: number }) | null;
  /** The second call was answered before the first one. */
  overlapped: boolean | null;
  after: MarkerTrace | null;
}

export interface InflightObs {
  tool: string;
  lostHeld: LostHeldObs | null;
  sameKey: SameKeyObs | null;
}

/** Why the in-flight scenarios cannot run on this resource at all, or null. */
function cannotRun(ctx: PlanContext, res: ResourceSpec): string | null {
  const idem = res.idempotency;
  if (!idem) return null;
  if (!toolByName(ctx.tools, idem.tool)) return `${idem.tool} is not in tools/list`;
  if (idem.kind !== 'create') return `${idem.tool} is a keyed ${idem.kind}; the in-flight scenarios are built for a keyed create, read back by its marker`;
  if (!('arg' in idem.key)) return `${idem.tool} takes its idempotency key in _meta; the in-flight scenarios send it as an argument, the form this preview builds`;
  if (!res.list) return `${res.name} declares no list block, so the objects a held request creates cannot be found by their marker`;
  if (!res.cleanup || res.cleanup === 'leave') return `${res.name} has no cleanup policy, and every trial makes objects`;
  return null;
}

/** Why the lost-held scenario cannot run, from the declaration alone (the gate route is known only once it exists). */
function lostHeldNotRun(ctx: PlanContext): string | null {
  const g = ctx.manifest.backend?.gate;
  if (!g) return 'the lost answer with the request held on its way is brought about through backend.gate, which the declaration does not configure (the hop between the server and its backend cannot be interposed on without it); a limitation of this run, not a finding about the server';
  if (g.node_import) return 'the in-process hook route (backend.gate.node_import) cannot close the server\'s connection and keep its request back; only the base-URL forwarder (backend.gate.rewrite_env) can, so this condition was not brought about. A limitation of the tester, not a finding about the server';
  return null;
}

/** Why the same-key scenario cannot run, from the declaration alone. */
function sameKeyNotRun(ctx: PlanContext): string | null {
  if (!ctx.manifest.backend?.inflight_hold) return 'a same-key call while the first is still in flight needs the first write held inside the backend after the backend has taken its key; the declaration names no such hold (backend.inflight_hold), and the loopback gate holds a request before the backend sees it, so the backend never holds a pending key for the second call to meet. Not brought about; a limitation of this run, not a finding about the server';
  return null;
}

export const inflightCheck: CheckModule = {
  id: ID,
  version: VERSION,
  requirements: ['MWS-RES-1', 'MWS-RES-2'],
  plan(ctx: PlanContext, res: ResourceSpec): PlannedCheck {
    const base: PlannedCheck = { check: ID, version: VERSION, resource: res.name, runs: false, calls: [], writes: 0, creates: 0, notRun: [] };
    const idem = res.idempotency;
    if (!idem) return base;
    const w = wp(res.name, idem.tool);
    const no = cannotRun(ctx, res);
    if (no) return { ...base, notRun: [result('MWS-RES-1', w, { id: INFLIGHT_SCENARIOS.lostHeld, version: VERSION }, 'not tested', no), result('MWS-RES-2', w, { id: INFLIGHT_SCENARIOS.sameKey, version: VERSION }, 'not tested', no)] };
    const calls: string[] = [];
    const nr: Result[] = [];
    let writes = 0;
    let creates = 0;
    const lh = lostHeldNotRun(ctx);
    if (lh) nr.push(result('MWS-RES-1', w, { id: INFLIGHT_SCENARIOS.lostHeld, version: VERSION }, 'not tested', lh));
    else {
      calls.push(`MWS-RES-1 ${idem.tool}: learning pass (one keyed create through the gate); then a keyed create whose last mutating backend request is taken off the wire, the server's connection closed with no answer and the request held until the server has answered; release it, wait for the backend's answer, read back by the marker`);
      writes += 2;
      creates += 2;
    }
    const sk = sameKeyNotRun(ctx);
    if (sk) nr.push(result('MWS-RES-2', w, { id: INFLIGHT_SCENARIOS.sameKey, version: VERSION }, 'not tested', sk));
    else {
      calls.push(`MWS-RES-2 ${idem.tool}: arm the target's in-flight hold (backend.inflight_hold, ${ctx.manifest.backend!.inflight_hold!.fixture}); a keyed create held inside the backend; the same call with the same key while it is held; read back by the marker once both have answered`);
      // The arming (a POST to the target's control), and the two calls.
      writes += 3;
      creates += 1;
    }
    return { ...base, runs: calls.length > 0, calls, writes, creates, notRun: nr };
  },
  async collect(ctx: RunContext, res: ResourceSpec): Promise<Observation> {
    const idem = res.idempotency!;
    const obs: InflightObs = { tool: idem.tool, lostHeld: null, sameKey: null };
    if (!cannotRun(ctx, res)) {
      if (!lostHeldNotRun(ctx)) obs.lostHeld = await runLostHeld(ctx, res);
      if (!sameKeyNotRun(ctx)) obs.sameKey = await runSameKey(ctx, res, ctx.manifest.backend!.inflight_hold!);
    }
    return { check: ID, version: VERSION, resource: res.name, data: obs };
  },
  evaluate(obs: Observation): Result[] {
    const o = obs.data as InflightObs;
    const w = wp(obs.resource, o.tool);
    const out: Result[] = [];
    if (o.lostHeld) out.push(lostHeldVerdict(o.lostHeld, w));
    if (o.sameKey) out.push(sameKeyVerdict(o.sameKey, w));
    return out;
  },
};

// ---------------------------------------------------------------- collection

/** The keyed call, its trace by marker, and a fresh marker and key: shared by both scenarios. */
function keyedCalls(ctx: RunContext, res: ResourceSpec) {
  const idem = res.idempotency!;
  const keyArg = (idem.key as { arg: string }).arg;
  const scope = ctx.driver.scope ?? null;
  const known = new Set<string>();
  const L = ctx.label('INFL');
  const fresh = (tag: string) => {
    const marker = ctx.marker(tag);
    const base = render(idem.args, baseVars(res, ctx.prefix, { scope, marker, key: marker }));
    const key = ctx.marker(`k${tag}`);
    return { marker, key, args: { ...(isObj(base) ? base : {}), [keyArg]: key } as Obj };
  };
  const send = async (label: string, args: Obj, purpose: string): Promise<CallResult> => {
    const step = ctx.session.stepId(`inflight.${purpose}`);
    const c = await createVerified(ctx.session, ctx.ledger, res, ctx.prefix, { tool: idem.tool, args, purpose: `in-flight scenario: ${purpose}`, label, step, idPath: idem.id });
    if (c.ok) known.add(JSON.stringify(c.id));
    return c.call!;
  };
  const trace = async (marker: string, tag: string, wait: boolean): Promise<MarkerTrace> => {
    if (wait && res.read.settle_ms > 0) await sleep(res.read.settle_ms);
    const step = ctx.session.stepId(`inflight.trace.${tag}`);
    const lr = await listAll(ctx.session, L, res.list!, render(res.list!.args, baseVars(res, ctx.prefix, { scope, marker })), step);
    if (!lr.ok) return { step, ok: false, count: null, ids: [], reason: lr.reason ?? 'the list call failed' };
    const found = lr.items.filter((it) => String(getPath(it, res.list!.name) ?? '').includes(marker));
    const ids = found.map((it) => getPath(it, res.list!.id));
    // why: an object found by this run's marker is ours, whether or not an answer named it (a held request lands later); it is
    // cleaned up like the others.
    for (const id of ids) {
      if (id === null || id === undefined || known.has(JSON.stringify(id))) continue;
      known.add(JSON.stringify(id));
      const intent = ctx.ledger.intent(res.name, idem.tool, 'in-flight scenario: an object found by its marker');
      ctx.ledger.append({ kind: 'created', intent, resource: res.name, id, name: marker, via: 'sweep' });
    }
    if (lr.partial) return { step, ok: false, count: null, ids, reason: `the trace is partial: ${lr.partial}` };
    return { step, ok: true, count: found.length, ids };
  };
  return { L, fresh, send, trace };
}

async function runLostHeld(ctx: RunContext, res: ResourceSpec): Promise<LostHeldObs> {
  const gate = ctx.gate;
  const o: LostHeldObs = { routing: gate?.describe() ?? null, learned: null, key: '', before: null, call: null, held: null, landed: null, requests: [], after: null };
  if (!gate) return { ...o, skipped: 'no backend gate was started' };
  if (!gate.dropAndHold) return { ...o, skipped: `the gate route ${gate.route} cannot close the server's connection and keep its request back (only the base-URL forwarder can); a limitation of the tester, not a finding about the server` };
  const k = keyedCalls(ctx, res);
  // The learning pass: which backend request commits the keyed create.
  const l = k.fresh('ifl');
  const mark0 = gate.mark();
  const lc = await k.send(k.L, l.args, 'lost-held.learn');
  const reqs = await gate.since(mark0);
  const lt = await k.trace(l.marker, 'lost-held.learn', true);
  const last = lastMutating(reqs);
  if (!lc.ok || !lt.ok || lt.count !== 1) return { ...o, skipped: `the learning pass did not show a working keyed create (${!lc.ok ? `it was refused: ${JSON.stringify(short(lc.text ?? lc.rpc_error?.message ?? '', 120))}` : !lt.ok ? `the trace failed: ${lt.reason}` : `the trace found ${lt.count} object(s) with its marker`})` };
  if (!last) return { ...o, skipped: `the keyed create sent no mutating request to the backend in the learning pass (${reqs.length ? reqs.map(showReq).join(', ') : 'no backend request'})` };
  o.learned = { method: last.method, path: last.path, nth: nthOf(reqs, last), requests: reqs.map(reqOf) };
  // The trial.
  const t = k.fresh('ifh');
  o.key = t.key;
  o.before = await k.trace(t.marker, 'lost-held.before', false);
  if (!o.before.ok || o.before.count !== 0) return { ...o, skipped: `before the call: ${o.before.ok ? `${o.before.count} object(s) already carry the marker` : o.before.reason}` };
  const mark = gate.mark();
  const h = gate.dropAndHold({ method: o.learned.method, path: o.learned.path, nth: o.learned.nth });
  let r: CallResult;
  try {
    const call = k.send(k.L, t.args, 'lost-held.call');
    if (INFLIGHT_SCHEDULE.mutation === 'release-before-answer') {
      call.catch(() => undefined);
      if (await h.waitHeld(FIRE_WAIT_MS)) {
        await h.release();
        await h.landed(LAND_WAIT_MS);
      }
    }
    r = await call;
  } finally {
    const held = await h.waitHeld(0);
    o.held = held ? reqOf(held) : null;
    // why: the request is sent on only once the server has answered its caller: the answer was given with the request on its way.
    await h.release();
  }
  o.call = brief({ ...r, carried: { key: true } });
  o.landed = o.held ? await h.landed(LAND_WAIT_MS) : null;
  o.requests = (await gate.since(mark)).map(reqOf);
  o.after = await k.trace(t.marker, 'lost-held.after', true);
  if (!o.held) o.skipped = `the hold was not applied (the call sent other backend requests than in the learning pass: ${o.requests.map(showReq).join(', ') || 'none'})`;
  return o;
}

/** One request to the target's control (fixture-api/1), through the egress list; the token goes in the header, redacted. */
async function control(ctx: RunContext, hold: InflightHold, method: string, path: string, body: unknown, tag: string): Promise<HttpResult | { unreachable: string }> {
  const base = ctx.env[hold.control_env];
  const token = ctx.env[hold.token_env];
  if (!base) return { unreachable: `${hold.control_env} is not set in the tester's environment, so the declared in-flight hold cannot be reached (a target started without its control listener offers none)` };
  if (!token) return { unreachable: `${hold.token_env} is not set in the tester's environment, so the declared in-flight hold cannot be armed` };
  return ctx.session.http(method, `${base.replace(/\/+$/, '')}${path}`, { authorization: `Bearer ${token}` }, body, { step: ctx.session.stepId(`inflight.control.${tag}`), write: method !== 'GET' });
}

/** Whether the arming `id` has fired, by the target's own list of armed and spent faults (fixture-api/1 GET /_fixture/faults). */
function firedOf(body: unknown, id: string): boolean {
  if (!isObj(body)) return false;
  const all = [...(Array.isArray(body['armed']) ? body['armed'] : []), ...(Array.isArray(body['spent']) ? body['spent'] : [])];
  return all.some((a) => isObj(a) && a['id'] === id && typeof a['fired'] === 'number' && a['fired'] >= 1);
}

const answerOf = (r: HttpResult): string => {
  const b = r.body;
  const said = isObj(b) ? [b['error'], b['message']].filter((x) => typeof x === 'string').join(': ') : typeof b === 'string' ? b : '';
  return `${r.status ?? 'no answer'}${said ? ` ${JSON.stringify(short(said, 200))}` : ''}${r.error ? ` (${r.error})` : ''}`;
};

async function runSameKey(ctx: RunContext, res: ResourceSpec, hold: InflightHold): Promise<SameKeyObs> {
  const o: SameKeyObs = { hold: `${hold.fixture}: backend/before-commit/delay, once, ${hold.hold_ms} ms, on the control listener named by ${hold.control_env}`, key: '', before: null, armed: null, first: null, second: null, overlapped: null, after: null };
  const k = keyedCalls(ctx, res);
  const L2 = ctx.label('INFL2');
  const t = k.fresh('ifs');
  o.key = t.key;
  o.before = await k.trace(t.marker, 'same-key.before', false);
  if (!o.before.ok || o.before.count !== 0) return { ...o, skipped: `before the call: ${o.before.ok ? `${o.before.count} object(s) already carry the marker` : o.before.reason}` };
  const arm = await control(ctx, hold, 'POST', '/_fixture/faults', { point: 'backend/before-commit/delay', selector: { once: true, hold_ms: hold.hold_ms } }, 'arm');
  if ('unreachable' in arm) return { ...o, skipped: arm.unreachable };
  // fixture-api/1: 201 {"fault": {"id": "F-<n>", ...}}.
  const f = isObj(arm.body) && isObj(arm.body['fault']) ? arm.body['fault'] : null;
  const id = f && typeof f['id'] === 'string' ? f['id'] : null;
  o.armed = { status: arm.status, id };
  if (!arm.ok || !id) return { ...o, skipped: `the target's control did not arm the in-flight hold: it answered ${answerOf(arm)}. The target offers no such hold in this build, so the condition was not brought about; not a finding about the server` };
  const first = k.send(k.L, t.args, 'same-key.first').then((r) => ({ ...brief({ ...r, carried: { key: true } }), t_end_ms: r.t_end_ms ?? nowMs() }));
  // why: the first call is awaited below on every path; a throw while the second is sent must not go unhandled meanwhile.
  first.catch(() => undefined);
  // why: the second call is sent only once the target says its hold fired on the first: the first is then inside the backend,
  // its key taken, not yet committed.
  let fired = false;
  const until = nowMs() + Math.min(FIRE_WAIT_MS, hold.hold_ms);
  while (!fired && nowMs() < until) {
    await sleep(25);
    const g = await control(ctx, hold, 'GET', '/_fixture/faults', undefined, 'fired');
    fired = !('unreachable' in g) && g.ok && firedOf(g.body, id);
  }
  if (!fired) {
    o.first = await first;
    return { ...o, skipped: `the target's in-flight hold (${id}) did not fire on the first call within ${Math.min(FIRE_WAIT_MS, hold.hold_ms)} ms, so no second call was sent while it was held` };
  }
  if (INFLIGHT_SCHEDULE.mutation === 'second-after-first') await first;
  const second = await k.send(L2, t.args, 'same-key.second');
  o.second = { ...brief({ ...second, carried: { key: true } }), t_end_ms: second.t_end_ms ?? nowMs() };
  o.first = await first;
  o.overlapped = o.second.t_end_ms < o.first.t_end_ms;
  o.after = await k.trace(t.marker, 'same-key.after', true);
  return o;
}

// ---------------------------------------------------------------- verdicts

const quoteCall = (b: CallBrief): string => JSON.stringify(short(b.text ?? b.rpc_error?.message ?? '', 200));

/** MWS-RES-1 from the lost answer with the request held on its way. */
export function lostHeldVerdict(o: LostHeldObs, w: ReturnType<typeof wp>): Result {
  const sc = { id: INFLIGHT_SCENARIOS.lostHeld, version: VERSION };
  const notes = [
    `Method: proxy-assisted (forced). Route: ${o.routing ?? 'no gate'}.`,
    ...(o.learned ? [`Learning pass: ${o.learned.requests.map(showReq).join(', ')}; the trial holds the ${o.learned.nth === 1 ? 'first' : `#${o.learned.nth}`} ${o.learned.method} ${o.learned.path} of the call.`] : []),
    ...(o.held ? [`Schedule: ${showReq(o.held)} was taken off the wire with the server's connection closed and no answer; it was released after the server answered, and the backend answered it ${o.landed ?? 'nothing'}. Requests of the trial at the gate: ${o.requests.map((q) => `${showReq(q)}${q.status !== null ? ` ${q.status}` : ''}`).join(', ')}.`] : []),
  ];
  const nt = (why: string) => result('MWS-RES-1', w, sc, 'not tested', why, { notes });
  if (o.skipped) return nt(`Lost answer with the request held: ${o.skipped}`);
  const b = o.call;
  if (!b) return nt('Lost answer with the request held: the call was not made');
  if (b.indeterminate) return nt('Lost answer with the request held: the call itself timed out or lost its connection, so the server\'s answer is not known (spec 7.3, rule 5)');
  if (b.result_type && b.result_type !== 'complete') return nt(`Lost answer with the request held: the answer was a ${b.result_type} result, which is neither a success nor an error; judging the final result is not built in this preview`);
  if (o.landed === null) return nt('Lost answer with the request held: the held request was released but the backend gave no answer to it, so the state afterwards does not show what it did');
  if (!o.after || !o.after.ok || o.after.count === null) return nt(`Lost answer with the request held: the trace after the release failed (${o.after?.reason ?? 'not made'})`);
  const n = o.after.count;
  const steps = [b.step, o.after.step];
  const landed = `the held request was then let through and the backend answered it ${o.landed}`;
  if (b.ok) {
    if (n >= 1) return result('MWS-RES-1', w, sc, 'held', `Lost answer with the request held: the result reported success, and after ${landed} the write is in effect (${n} object(s) with the call's marker).`, { notes });
    return result('MWS-RES-1', w, sc, 'violated', `Lost answer with the request held: the result reported success (${quoteCall(b)}), and after ${landed} no object carries the call's marker: the state the caller asked for is not in effect.`, { notes, steps });
  }
  if (n === 0) return result('MWS-RES-1', w, sc, 'held', `Lost answer with the request held: the call answered with an error (${quoteCall(b)}), and after ${landed} nothing is in effect, as it said or left open.`, { notes });
  // why: B-9: on a call that carried an idempotency key, outcome and code are statements about the write the key identifies;
  // `not_applied` says no change made by the call is in effect and the outcome is settled. The held request then made the change:
  // the result's statement about the state is not the state in effect afterwards (MWS-RES-1). The same reader decides as for the
  // lost-answer trial of MWS-RES-2 (the declared patterns, write_failed in a lost answer; the adopted shape).
  const values = Object.fromEntries(o.after.ids.map((id) => [String(id), id]));
  const sec = readSecondClause(b, o.after.ids.map((id) => String(id)), values, { lostAnswer: true, carriedKey: true });
  // why: MWS-RES-1 is about what the result says is in effect: only a statement that the write is not applied (the adopted shape's
  // not_applied, or the declared patterns reading the text as "failed" or "nothing was written") is judged here. Another kind of
  // second-clause finding (an invitation to repeat, a bare transport error) says nothing about the state; MWS-RES-2's lost-answer
  // trial judges those.
  const statesNotApplied = (sec.shape?.v === 'violated' && shapeOf(b)?.outcome === 'not_applied') || sec.text?.v === 'violated';
  if (sec.v === 'violated' && !statesNotApplied) return result('MWS-RES-1', w, sc, 'held', `Lost answer with the request held: the call answered with an error that does not say the write is not in effect, and after ${landed} the write is in effect (${n} object(s) with the call's marker). The error ${sec.why}, which is a matter for MWS-RES-2's lost-answer trial, not for this record.`, { notes: [...notes, ...sec.notes] });
  if (sec.v === 'violated') return result('MWS-RES-1', w, sc, 'violated', `Lost answer with the request held: the server answered while its request was still on its way, reporting the write as settled and not in effect (${quoteCall(b)}): ${sec.why}; and after ${landed}, ${n} object(s) carry the call's marker (${o.after.ids.map((x) => JSON.stringify(x)).join(', ')}). What the result said was in effect is not what is in effect afterwards. A miss found with no fence is final only once the original request can no longer arrive.`, { notes: [...notes, ...sec.notes], steps });
  if (sec.v === 'unread') return result('MWS-RES-1', w, sc, 'not tested', `Lost answer with the request held: after ${landed} the write is in effect, and ${sec.why}`, { notes: [...notes, ...sec.notes] });
  return result('MWS-RES-1', w, sc, 'held', `Lost answer with the request held: the call answered with an error that ${sec.why}, and after ${landed} the write is in effect (${n} object(s) with the call's marker), which the error left open.`, { notes: [...notes, ...sec.notes] });
}

/** MWS-RES-2 from the same-key call while the first is held inside the backend. */
export function sameKeyVerdict(o: SameKeyObs, w: ReturnType<typeof wp>): Result {
  const sc = { id: INFLIGHT_SCENARIOS.sameKey, version: VERSION };
  const notes = [
    `Method: target-assisted (forced): the first call was held inside the backend by the declared hold (${o.hold ?? 'none'}), after the backend took its key and before it committed.`,
    ...(o.armed ? [`Arming: the target answered ${o.armed.status}${o.armed.id ? `, arming ${o.armed.id}` : ''}.`] : []),
    ...(o.second && o.first ? [`Order: the second call was answered ${o.overlapped ? 'before' : 'after'} the first.`] : []),
  ];
  const nt = (why: string) => result('MWS-RES-2', w, sc, 'not tested', why, { notes });
  if (o.skipped) return nt(`Same key while the first is in flight: ${o.skipped}`);
  const b = o.second;
  if (!b || !o.first) return nt('Same key while the first is in flight: the calls were not made');
  if (!o.after || !o.after.ok || o.after.count === null) return nt(`Same key while the first is in flight: the trace afterwards failed (${o.after?.reason ?? 'not made'})`);
  const n = o.after.count;
  if (n === 0) return nt(`Same key while the first is in flight: after both calls no object carries the marker (the first answered ${quoteCall(o.first)}), so there is no keyed write to hold the second answer against`);
  const what = `Same key while the first is in flight: the same call with the same key ${o.key} was sent while the first was held inside the backend; after both answered, ${n} object(s) carry the call's marker (${o.after.ids.map((x) => JSON.stringify(x)).join(', ')})`;
  if (b.ok) return result('MWS-RES-2', w, sc, 'held', `${what}; the second call answered as a success (${quoteCall(b)}), not as a failure.`, { notes });
  // why: B-9 "A repeat with a key": the second answer's outcome describes the write the key identifies; that write is in effect.
  const j = res2Judge(b, o.after.ids.map((id) => String(id)), 'backend', `${what}; the second call answered with an error (${quoteCall(b)})`, Object.fromEntries(o.after.ids.map((id) => [String(id), id])));
  return result('MWS-RES-2', w, sc, j.verdict, j.reason, { notes: [...notes, ...j.notes], steps: j.verdict === 'violated' ? [o.first.step, b.step, o.after.step] : [] });
}
