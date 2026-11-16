/**
 * Retries and replays with an idempotency key (MWS-RETRY-2, spec 098621b; DECISIONS R8-1 to R8-3). The tester is the
 * client, so it re-issues the same tools/call with a new JSON-RPC id, as revision 2026-07-28 requires of a client
 * after a broken stream. Every step uses a write whose repeat leaves a trace the tester can read (a create, counted by
 * the objects carrying the call's own marker; an update of a scratch object whose declared version steps once per
 * applied write), each with its own fresh key and marker, and reads the trace before the first call and after each
 * answer:
 *
 *   (a) A1 with key K, then A2 with K and the same arguments            record idempotency-replay (with (b), (c))
 *   (b) the same arguments with a new key K2
 *   (c) K again with an argument changed
 *   (d) pairs, one fresh key each, sent at once on two connections       record idempotency-replay.concurrent
 *   proxy-assisted: the backend commits A1, its answer is cut; A2 with K  record idempotency-replay.proxy
 *   (e) A1 answered; the tester restarts the server; A2 with K           record idempotency-replay.restart
 *   crash form: A1 committed, its answer held; restart; A2 with K         record idempotency-replay.restart-crash
 *
 * Step (e) and the crash form can also give an MWS-RES-2 record for the same write path. The verdicts are pure
 * functions in retry2.ts. Every object goes through the ledger and the cleanup policy; an object the trace finds by
 * its marker that no answer named is adopted into the ledger, so it is cleaned up too.
 */

import { baseVars, type Driver, sameCollection } from '../core/driver.js';
import type { ResourceSpec } from '../core/manifest.js';
import { createVerified, idFromResult } from '../core/objects.js';
import { BudgetExhausted, Interrupted, RateLimited, type CallResult } from '../core/session.js';
import { validates } from '../core/jsonschema.js';
import { listAll } from '../core/lists.js';
import { render } from '../core/template.js';
import { deepEqual, getPath, hashJson, isObj, nowMs, setPath, sleep, type Obj } from '../core/util.js';
import { lastMutating, nthOf } from '../gate/gate.js';
import { result, type Result } from '../report/verdicts.js';
import { readText } from './shape.js';
import { combineABC, judgeA, judgeB, judgeC, judgeCrash, judgeD, judgePair, judgeProxy, judgeRestart, MIN_OVERLAPPED_PAIRS, res2Cross, res2CrossNote, type CallObs, type CrashObs, type Decl, type PairObs, type ProxyObs, type RestartObs, type StepAObs, type StepBObs, type StepCObs, type StepDObs, type StepVerdict, type TraceRead } from './retry2.js';
import { scratch } from './scratch.js';
import { brief, notRun, offeredKeys, wp, type CheckModule, type Observation, type PlanContext, type PlannedCheck, type RunContext } from './types.js';

const ID = 'idempotency-replay';
const VERSION = '2';
export const RETRY2_SCENARIOS = { abc: ID, concurrent: `${ID}.concurrent`, proxy: `${ID}.proxy`, restart: `${ID}.restart`, crash: `${ID}.restart-crash`, res2Restart: `${ID}.restart.res2`, res2Crash: `${ID}.restart-crash.res2` } as const;
/** How long the crash form waits for the backend to commit the held first write. */
const HANG_WAIT_MS = 15_000;

export interface IdemObs {
  a?: StepAObs;
  b?: StepBObs;
  c?: StepCObs;
  d?: StepDObs;
  proxy?: ProxyObs;
  restart?: RestartObs;
  crash?: CrashObs;
  /** update: the changed fields and values of step (a)'s call, to tell whether an error identifies the applied change. */
  update_fields?: Record<string, unknown>;
  /** The run stopped (rate limit, budget, interruption): the steps after it were not run. */
  stopped?: string | null;
}

/**
 * The replay indicator the declaration names (spec MWS-RETRY-2 Guidance): a result field that is true, or a stated
 * text in the answer. Null where neither is declared.
 */
export function replayIndicated(idem: { replay_marker: string | null; replay_text: string | null }, data: unknown, text: string | null): boolean | null {
  if (!idem.replay_marker && !idem.replay_text) return null;
  if (idem.replay_marker) {
    const v = getPath(data, idem.replay_marker);
    if (v === true || v === 'true') return true;
  }
  if (idem.replay_text && new RegExp(idem.replay_text, 'i').test(text ?? '')) return true;
  return false;
}

/** What the verdicts need from the declaration of one resource (the declaration is trusted, spec 12). */
export function declOf(res: ResourceSpec, updateFields: Record<string, unknown> = {}, versionWasSent = false): Decl {
  const idem = res.idempotency!;
  const kind = idem.kind === 'update' ? 'update' : 'create';
  return {
    kind,
    countable: kind === 'create' ? !!res.list : idem.version_steps && !!res.version,
    caller_named: kind === 'create' && !!res.key,
    // why (review of note 8, 6): a version check is credited only where the call carried a version, never from the template alone.
    carries_version: kind === 'update' && !!res.version?.arg && versionWasSent,
    own_checks: idem.own_checks,
    backend_key: idem.backend_key,
    key_record_survives: idem.key_record_survives,
    key_lifetime: idem.key_lifetime,
    update_fields: updateFields,
    version_path: res.version?.read ?? null,
    replay_declared: !!(idem.replay_marker || idem.replay_text),
  };
}

/** A keyed update's arguments on a scratch object, rendered with the object's current version (the declaration's {{version}}). */
export function keyedUpdateArgs(res: ResourceSpec, d: Driver, marker: string, version: unknown): unknown {
  return render(res.idempotency!.args, d.vars({ marker, key: marker, version: version ?? null }));
}

/** Did the arguments carry a version (a value in the resource's version argument)? */
export function versionSent(res: ResourceSpec, args: unknown): boolean {
  const a = res.version?.arg;
  return !!a && isObj(args) && args[a] !== null && args[a] !== undefined && args[a] !== '';
}

/**
 * The arguments step (c) sends: the declared `vary` argument, else the argument that carries the call's marker (else
 * the first one carrying the run prefix that is not the scope), changed with its type kept. Changing the scope would
 * test whether the scope is honoured (MWS-TGT-1), not the key.
 */
export function variedArgs(args: unknown, o: { vary: string | null; marker: unknown; scope: unknown; prefix: string }): { arg: string; from: unknown; to: unknown; args: Obj } | null {
  if (!isObj(args)) return null;
  let arg: string | undefined = o.vary ?? undefined;
  if (!arg) {
    const entries = Object.entries(args).filter(([, v]) => typeof v === 'string');
    arg = (entries.find(([, v]) => typeof o.marker === 'string' && (v as string).includes(o.marker)) ?? entries.find(([, v]) => (v as string).startsWith(o.prefix) && v !== o.scope))?.[0];
  }
  if (!arg || !Object.hasOwn(args, arg)) return null;
  const was = args[arg];
  const to = typeof was === 'string' ? `${was}-changed` : typeof was === 'number' ? was + 1 : typeof was === 'boolean' ? !was : undefined;
  return to === undefined ? null : { arg, from: was, to, args: { ...args, [arg]: to } };
}

/** The last segment of a request path, decoded, without the query or a trailing slash. */
const lastPathSegment = (p: string): string => {
  const q = (p.split(/[?#]/)[0] ?? '').replace(/\/+$/, '');
  const seg = q.slice(q.lastIndexOf('/') + 1);
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
};

/**
 * The backend requests that undid a created object: a DELETE whose path ends in the object's id, exactly (review of note 8,
 * 7: "T-1" does not match "/tickets/T-12").
 */
export function undoneBy(reqs: { method: string; path: string }[], ids: unknown[]): { method: string; path: string }[] {
  const want = new Set(ids.filter((x) => x !== null && x !== undefined && x !== '').map((x) => String(x)));
  return reqs.filter((r) => r.method === 'DELETE' && want.has(lastPathSegment(r.path))).map((r) => ({ method: r.method, path: r.path }));
}

const stopping = (e: unknown): boolean => e instanceof RateLimited || e instanceof BudgetExhausted || e instanceof Interrupted;

export const idempotencyCheck: CheckModule = {
  id: ID,
  version: VERSION,
  requirements: ['MWS-RETRY-2'],
  plan(ctx: PlanContext, res: ResourceSpec): PlannedCheck {
    const base: PlannedCheck = { check: ID, version: VERSION, resource: res.name, runs: false, calls: [], writes: 0, creates: 0, notRun: [] };
    const idem = res.idempotency;
    const tool = idem?.tool ?? res.create?.tool ?? '(create)';
    const w = wp(res.name, tool);
    if (!idem) {
      // why: a create tool shared with a resource that declares its key is judged there, once.
      if (ctx.manifest.resources.some((r) => r.idempotency && r.idempotency.tool === res.create?.tool && sameCollection(r, res))) return base;
      // why: Action CI SH-3 (C4's rule): a key declared for this tool on another resource, or offered by its input schema, is a declaration gap here, not a false condition.
      const elsewhere = ctx.manifest.resources.filter((r) => r.name !== res.name && r.idempotency && r.idempotency.tool === tool).map((r) => r.name);
      const offered = offeredKeys(ctx.tools, tool);
      if (elsewhere.length || offered.length) return { ...base, notRun: notRun(this, ['MWS-RETRY-2'], w, 'not tested', `${tool} takes an idempotency key (${[...(elsewhere.length ? [`declared on ${elsewhere.join(', ')}`] : []), ...(offered.length ? [`its input schema offers ${offered.join(', ')}`] : [])].join('; ')}), but this resource declares no idempotency block; declare one here so that the replay steps run for ${res.name}`) };
      // why: the declaration is trusted (spec 12): with no key declared, the tool accepts none and MWS-RETRY-2's condition is false.
      return { ...base, notRun: notRun(this, ['MWS-RETRY-2'], w, 'not applicable', `the declaration names no idempotency key for ${tool} (if it accepts one, declare an idempotency block: where the key goes and the replay indicator)`) };
    }
    if (idem.kind === 'append') return { ...base, notRun: notRun(this, ['MWS-RETRY-2'], w, 'not tested', 'idempotency.kind: append (an append, counted by its applied changes) is not built in this preview; declare a create, or an update with version_steps') };
    if (!res.cleanup) return { ...base, notRun: notRun(this, ['MWS-RETRY-2'], w, 'not tested', 'the replay steps create objects and the resource has no cleanup policy') };
    if (res.cleanup === 'leave') return { ...base, notRun: notRun(this, ['MWS-RETRY-2'], w, 'not tested', 'cleanup: leave — the replay steps are not run where objects would be left behind on purpose; choose delete, control_delete, archive or ephemeral') };
    if (idem.kind === 'create' && !JSON.stringify(idem.args ?? null).includes('{{marker}}')) return { ...base, notRun: notRun(this, ['MWS-RETRY-2'], w, 'not tested', 'the trace of a keyed create is the objects carrying the call\'s own marker: put {{marker}} in idempotency.args, in the argument the list block\'s name field shows') };
    if (idem.kind === 'create' && !res.list) return { ...base, notRun: notRun(this, ['MWS-RETRY-2'], w, 'not tested', 'the trace of a keyed create is the objects carrying the call\'s marker: declare a list block whose name field holds the {{marker}}') };
    if (idem.kind === 'update' && (!res.create || !res.version)) return { ...base, notRun: notRun(this, ['MWS-RETRY-2'], w, 'not tested', 'a keyed update is tried on a scratch object the tester creates, and its trace is the version: declare create and version (and idempotency.version_steps where the backend steps the version once per applied write)') };
    const pairs = ctx.manifest.limits.pairs;
    const gated = !!ctx.gated || !!ctx.manifest.backend?.gate;
    const restart = ctx.manifest.server.restart;
    const calls = [
      `(a) ${tool} with key K, twice in sequence; (b) the same with a new key; (c) K again with an argument changed`,
      `(d) up to ${pairs} pairs, one fresh key each, sent at once on two connections (stops at ${MIN_OVERLAPPED_PAIRS} overlapped pairs)`,
      gated ? 'proxy-assisted: a learning pass, then the first call\'s last backend write is committed and its answer cut, then the repeat with the same key' : 'proxy-assisted step: not run (no backend.gate)',
      restart ? `(e) a dedicated server: the first call answered, a ${restart.stop} stop and a start, the repeat with the same key` : '(e) restart: not run (no server.restart)',
      restart && gated ? 'crash form of (e): a learning pass, then the first call\'s last backend write committed and its answer held, the server stopped and started, the repeat with the same key' : '(e) crash form: not run (needs server.restart and backend.gate)',
    ];
    const writes = 4 + 2 * pairs + (gated ? 3 : 0) + (restart ? 2 : 0) + (restart && gated ? 3 : 0) + (idem.kind === 'update' ? 5 : 0);
    return { ...base, runs: true, calls, writes, creates: idem.kind === 'create' ? writes : 5 };
  },
  async collect(ctx: RunContext, res: ResourceSpec): Promise<Observation> {
    const obs: IdemObs = {};
    try {
      await collectAll(ctx, res, obs);
    } catch (e) {
      // why: a rate limit, the budget or an interruption stops the run; the steps already observed keep their evidence.
      if (!stopping(e)) throw e;
      obs.stopped = `stopped: ${(e as Error).message.replace(/^stopped: /, '')}`;
    }
    return { check: ID, version: VERSION, resource: res.name, data: obs };
  },
  evaluate(obs: Observation, ctx: PlanContext): Result[] {
    const res = ctx.manifest.resources.find((r) => r.name === obs.resource)!;
    return idempotencyVerdicts(obs.data as IdemObs, res, { gated: !!ctx.gated || !!ctx.manifest.backend?.gate, restart: ctx.manifest.server.restart, launchable: !!(ctx.manifest.server.stdio || ctx.manifest.server.launch), description: (ctx.tools.find((t) => t.name === res.idempotency!.tool) as { description?: unknown } | undefined)?.description ?? null });
  },
};

/** The records of one write path: steps (a) to (c), step (d), the proxy-assisted step, step (e) and its crash form, and any MWS-RES-2 trial. */
export function idempotencyVerdicts(o: IdemObs, res: ResourceSpec, env: { gated: boolean; restart: { stop: 'graceful' | 'kill' } | null; launchable: boolean; description?: unknown } = { gated: false, restart: null, launchable: false }): Result[] {
  const idem = res.idempotency!;
  const w = wp(res.name, idem.tool);
  let d = declOf(res, o.update_fields ?? {}, o.b?.version_sent === true);
  // why: gate-2 re-run on 378f32f (note 19; spec R8-3): a key lifetime counts only where the tool's description states it; the
  // declaration's quote must be in the description, or the line is ignored (one manifest line must not switch step (e) off).
  const norm = (x: string) => x.toLowerCase().replace(/\s+/g, ' ').trim();
  const lifetimeNote = d.key_lifetime && !(typeof env.description === 'string' && norm(env.description).includes(norm(d.key_lifetime.quote))) ? `idempotency.key_lifetime was ignored: its quote ${JSON.stringify(d.key_lifetime.quote)} is not in the description of ${idem.tool}${typeof env.description === 'string' ? '' : ' (the tool gives none)'}, and a key lifetime counts only where the tool's description states it (spec R8-3).` : null;
  if (lifetimeNote) d = { ...d, key_lifetime: null };
  const sc = (id: string) => ({ id, version: VERSION });
  const why = o.stopped ? `the run stopped before this step: ${o.stopped}` : 'the step was not run';
  const R = (id: string, v: StepVerdict, numbers: Record<string, unknown> = {}, req: 'MWS-RETRY-2' | 'MWS-RES-2' = 'MWS-RETRY-2'): Result => result(req, w, sc(id), v.verdict, v.reason, { steps: v.steps, notes: v.notes, numbers });
  const out: Result[] = [];
  const declNotes: string[] = [];
  if (!idem.replay_marker && !idem.replay_text) declNotes.push('The declaration names no replay indicator (idempotency.replay_marker or replay_text); a replay is recognized by the replay pattern and by the identifier only.');
  const abc = combineABC(judgeA(o.a ?? { key: '', t0: null, a1: null, t1: null, a2: null, t2: null, skipped: why }, d), judgeB(o.b ?? { key: '', t0: null, b: null, t1: null, earlier: null, skipped: why }, d), judgeC(o.c ?? { key: '', vary: null, t0: null, c: null, t1: null, earlier_applied: false, skipped: why }, d));
  out.push(R(RETRY2_SCENARIOS.abc, { ...abc, notes: [...abc.notes, ...declNotes] }));
  const dd = judgeD(o.d ?? { pairs: [], limit: 0, stop: 'error', skipped: why }, d);
  out.push(R(RETRY2_SCENARIOS.concurrent, dd, dd.numbers));
  out.push(R(RETRY2_SCENARIOS.proxy, judgeProxy(o.proxy ?? { skipped: env.gated ? why : 'needs backend.gate (the hop between the server and its backend is not interposed on)', routing: '', learned: null, key: '', t0: null, a1: null, hit: false, t1: null, a2: null, t2: null, undo: [] }, d)));
  const noRestart = !env.restart ? 'the declaration gives no means to stop and start the server (server.restart, Annex E)' : !env.launchable ? 'the tester restarts only a server it starts itself (server.stdio or server.launch)' : why;
  const rs: RestartObs = o.restart ?? { skipped: noRestart, key: '', t0: null, a1: null, t1: null, restart: null, tr: null, a2: null, t2: null, t3: null, gap_ms: null, settle_ms: 0 };
  const withNote = (v: StepVerdict, n: string | null): StepVerdict => (n ? { ...v, notes: [...v.notes, n] } : v);
  out.push(R(RETRY2_SCENARIOS.restart, withNote(withNote(judgeRestart(rs, d), o.restart ? res2CrossNote(o.restart, 'restart', d) : null), lifetimeNote), rs.restart ? { stop: rs.restart.stop_used, stop_requested: rs.restart.stop_requested, gap_ms: rs.gap_ms === null ? null : Math.round(rs.gap_ms) } : {}));
  const cs: CrashObs = o.crash ?? { ...rs, skipped: !env.restart || !env.launchable ? noRestart : !env.gated ? 'needs backend.gate (the first write is committed and its answer held at the interposer)' : why, routing: '', learned: null, hit: false, answered_before_stop: false };
  out.push(R(RETRY2_SCENARIOS.crash, withNote(withNote(judgeCrash(cs, d), o.crash ? res2CrossNote(o.crash, 'crash', d) : null), lifetimeNote), cs.restart ? { stop: cs.restart.stop_used, stop_requested: cs.restart.stop_requested, gap_ms: cs.gap_ms === null ? null : Math.round(cs.gap_ms) } : {}));
  const x1 = o.restart ? res2Cross(o.restart, 'restart', d) : null;
  if (x1) out.push(R(RETRY2_SCENARIOS.res2Restart, { ...x1, notes: ['Method: black-box (launch).', ...x1.notes] }, {}, 'MWS-RES-2'));
  const x2 = o.crash ? res2Cross(o.crash, 'crash', d) : null;
  if (x2) out.push(R(RETRY2_SCENARIOS.res2Crash, { ...x2, notes: ['Method: proxy-assisted (launch).', ...x2.notes] }, {}, 'MWS-RES-2'));
  return out;
}

// ---------------------------------------------------------------- collection

interface Target {
  marker: string;
  args: unknown;
  /** update: the scratch object's driver. */
  driver: Driver | null;
}

async function collectAll(ctx: RunContext, res: ResourceSpec, obs: IdemObs): Promise<void> {
  const idem = res.idempotency!;
  const kind = idem.kind === 'update' ? 'update' : 'create';
  const L = ctx.label('IDEM');
  const L2 = ctx.label('IDEM2');
  const scope = ctx.driver.scope ?? null;
  const known = new Set<string>();
  const settle = res.read.settle_ms;
  const decl = declOf(res);

  const keyed = (args: unknown, key: string): { args: Obj; meta?: Record<string, unknown> } => {
    const a: Obj = isObj(args) ? { ...args } : {};
    if ('arg' in idem.key) return { args: { ...a, [idem.key.arg]: key } };
    return { args: a, meta: { [idem.key.meta]: key } };
  };
  const toObs = (r: CallResult): CallObs => ({ ...brief(r), id: kind === 'create' ? idFromResult(res, r, idem.id) : null, version: res.version ? (getPath(r.data, res.version.read) ?? null) : null, replay_marked: replayIndicated(idem, r.data, readText(r)), t_start_ms: r.t_start_ms, t_end_ms: r.t_end_ms });

  /** One keyed call: a create through the ledger (its id verified), an update as a plain call. */
  const send = async (label: string, args: unknown, key: string, purpose: string, o: { paced?: boolean; counted?: boolean } = {}): Promise<CallObs> => {
    const k = keyed(args, key);
    const step = ctx.session.stepId(`idem.${purpose}`);
    if (kind === 'create') {
      const c = await createVerified(ctx.session, ctx.ledger, res, ctx.prefix, { tool: idem.tool, args: k.args, purpose: `MWS-RETRY-2 ${purpose}`, label, step, ...(k.meta ? { meta: k.meta } : {}), idPath: idem.id, ...o });
      if (c.ok) known.add(JSON.stringify(c.id));
      return { ...toObs(c.call!), args: k.args };
    }
    return { ...toObs(await ctx.session.call(label, idem.tool, k.args, { step, ...(k.meta ? { meta: k.meta } : {}), ...o })), args: k.args };
  };

  /** The trace: the objects with the marker (create), or the scratch object's version (update). */
  const trace = async (tag: string, t: Pick<Target, 'marker' | 'driver'>, wait = true): Promise<TraceRead> => {
    if (wait && settle > 0) await sleep(settle);
    const step = ctx.session.stepId(`idem.trace.${tag}`);
    if (kind === 'create') {
      // why: gate-2 re-run on 378f32f (note 19, R5, R6): the trace is every page of the list; a list that shows a further page
      // it cannot read (no list.next) is a partial trace, which counts nothing and gives no verdict.
      const lr = await listAll(ctx.session, L, res.list!, render(res.list!.args, baseVars(res, ctx.prefix, { scope, marker: t.marker })), step);
      const items = lr.ok ? lr.items : null;
      if (!Array.isArray(items)) return { step, ok: false, count: null, ids: [], version: null, digest: null, t_ms: nowMs(), reason: lr.reason ?? 'the list call failed' };
      const found = items.filter((it) => String(getPath(it, res.list!.name) ?? '').includes(t.marker));
      const ids = found.map((it) => getPath(it, res.list!.id));
      // why: an object the trace finds by this run's marker is ours, whether or not an answer named it; it is cleaned up like the others.
      for (const id of ids) {
        if (id === null || id === undefined || known.has(JSON.stringify(id))) continue;
        known.add(JSON.stringify(id));
        const intent = ctx.ledger.intent(res.name, idem.tool, 'MWS-RETRY-2: an object the trace found by its marker');
        ctx.ledger.append({ kind: 'created', intent, resource: res.name, id, name: t.marker, via: 'sweep' });
      }
      if (lr.partial) return { step, ok: false, count: null, ids, version: null, digest: null, t_ms: nowMs(), reason: `the trace is partial: ${lr.partial}; ${found.length} object(s) with the marker on the page read, and an object on a further page would not be counted` };
      return { step, ok: true, count: found.length, ids, version: null, digest: null, t_ms: nowMs() };
    }
    const r = await t.driver!.readOnce(L, step);
    if (!r.ok) return { step, ok: false, count: null, ids: [], version: null, digest: null, t_ms: nowMs(), reason: `the scratch object did not read back (${(r.call?.text ?? r.call?.rpc_error?.message ?? 'error').slice(0, 120)})` };
    let o: unknown = r.obj;
    for (const p of res.read.ignore) o = setPath(o, p, null);
    return { step, ok: true, count: null, ids: [], version: r.version ?? null, digest: hashJson(o), t_ms: nowMs() };
  };

  /** A fresh target for one step: a marker, the rendered arguments, and (update) a scratch object of its own. */
  const target = async (tag: string): Promise<Target | { skipped: string }> => {
    const marker = ctx.marker(tag);
    if (kind === 'create') return { marker, args: render(idem.args, baseVars(res, ctx.prefix, { scope, marker, key: marker })), driver: null };
    const s = await scratch(ctx, res, { tag, purpose: `MWS-RETRY-2 ${tag}: the object a keyed update writes`, label: L });
    if (!s.ok || !s.driver) return { skipped: `the scratch object could not be created (${s.reason})` };
    return { marker, args: keyedUpdateArgs(res, s.driver, marker, null), driver: s.driver };
  };
  /**
   * The arguments of the keyed write on a target. A create's are fixed. An update's are rendered with the version the trace
   * read just before the call, so a version the declaration puts in the arguments is the object's own (review of note 8, 6).
   */
  const argsAt = (t: Target, tr: TraceRead | null): unknown => (kind === 'create' ? t.args : keyedUpdateArgs(res, t.driver!, t.marker, tr?.version ?? null));
  /** The arguments of one more call on the same target (update: a fresh marker, so the values differ, and the version read before it). */
  const argsFor = (t: Target, tr: TraceRead | null = null): { marker: string; args: unknown } => {
    const marker = ctx.marker('idp');
    if (kind === 'create') return { marker, args: render(idem.args, baseVars(res, ctx.prefix, { scope, marker, key: marker })) };
    return { marker: t.marker, args: keyedUpdateArgs(res, t.driver!, marker, tr?.version ?? null) };
  };
  const key = (tag: string) => ctx.marker(`k${tag}`);

  // Steps (a), (b), (c): one target; (b) and (c) count from their own read before the call.
  {
    const t = await target('idema');
    if ('skipped' in t) obs.a = { key: '', t0: null, a1: null, t1: null, a2: null, t2: null, skipped: t.skipped };
    else {
      const K = key('a');
      const a: StepAObs = { key: K, t0: null, a1: null, t1: null, a2: null, t2: null };
      obs.a = a;
      a.t0 = await trace('a0', t, false);
      const argsA = argsAt(t, a.t0);
      if (kind === 'update' && isObj(argsA)) {
        const skip = new Set(['arg' in idem.key ? idem.key.arg : '', res.version?.arg ?? '']);
        obs.update_fields = Object.fromEntries(Object.entries(argsA).filter(([k, v]) => !skip.has(k) && !deepEqual(v, t.driver!.id)));
      }
      a.a1 = await send(L, argsA, K, 'a.first');
      a.t1 = await trace('a1', t);
      a.a2 = await send(L, argsA, K, 'a.repeat');
      a.t2 = await trace('a2', t);
      // why: note 19 (R6): null where the trace could not be read (a partial trace), so steps (b) and (c) do not say it did not apply.
      const ch = a.t0.ok && a.t1.ok ? (kind === 'create' ? (a.t1.count ?? 0) > (a.t0.count ?? 0) : !deepEqual(a.t1.version, a.t0.version) || a.t1.digest !== a.t0.digest) : null;
      // Step (b): the same arguments as step (a), so an update carries the version the first call consumed (spec: a write
      // that carries the version the first call sent cannot take effect a second time).
      const b: StepBObs = { key: key('b'), t0: a.t2, b: null, t1: null, earlier: { id: a.a1.id, version: a.a1.version, applied: ch }, version_sent: kind === 'update' && versionSent(res, argsA) };
      obs.b = b;
      b.b = await send(L, argsA, b.key, 'b.new_key');
      b.t1 = await trace('b1', t);
      // Step (c): arguments a fresh key would apply: an update's with the version the object has now.
      const v = variedArgs(argsAt(t, b.t1), { vary: idem.vary, marker: t.marker, scope, prefix: ctx.prefix });
      const schema = ctx.tools.find((x) => x.name === idem.tool)?.inputSchema;
      const valid = v ? validates(schema, keyed(v.args, K).args) : null;
      const c: StepCObs = { key: K, vary: v ? { arg: v.arg, from: v.from, to: v.to, valid: valid === null ? 'unknown' : valid } : null, t0: b.t1, c: null, t1: null, earlier_applied: ch };
      obs.c = c;
      // why (review of note 8, 8): arguments the input schema refuses are not sent; the step is not tested.
      if (v && valid !== false) {
        c.c = await send(L, v.args, K, 'c.changed_args');
        c.t1 = await trace('c1', t);
      }
    }
  }

  // Step (d): pairs, one fresh key and marker each, sent at once on two connections.
  {
    const limit = ctx.manifest.limits.pairs;
    const d: StepDObs = { pairs: [], limit, stop: 'limit' };
    obs.d = d;
    const t = await target('idemd');
    if ('skipped' in t) d.skipped = t.skipped;
    else {
      await ctx.session.connect(L);
      await ctx.session.connect(L2);
      let overlapped = 0;
      for (let i = 0; i < limit; i++) {
        if (overlapped >= MIN_OVERLAPPED_PAIRS) {
          d.stop = 'overlapped';
          break;
        }
        const marker = kind === 'create' ? ctx.marker('idp') : t.marker;
        const p: PairObs = { key: key('d'), t0: null, x: null, y: null, t1: null };
        d.pairs.push(p);
        p.t0 = await trace('d0', { marker, driver: t.driver }, false);
        const n = kind === 'create' ? { marker, args: render(idem.args, baseVars(res, ctx.prefix, { scope, marker, key: marker })) } : argsFor(t, p.t0);
        ctx.session.reserveWrites(2, `MWS-RETRY-2 simultaneous pair ${i + 1}`);
        await ctx.session.pace();
        // The barrier: both calls are issued in the same event-loop turn.
        const [x, y] = await Promise.all([send(L, n.args, p.key, `d.pair${i + 1}.x`, { paced: true, counted: true }), send(L2, n.args, p.key, `d.pair${i + 1}.y`, { paced: true, counted: true })]);
        p.x = x;
        p.y = y;
        p.t1 = await trace('d1', { marker: n.marker, driver: t.driver });
        const j = judgePair(p, decl);
        if (j.overlapped && j.outcome === 'counted') overlapped++;
        // why: one pair applied more than once is enough for violated (spec 8.2, rule 1).
        if (j.outcome === 'loss' || j.outcome === 'violated') {
          d.stop = 'error';
          d.error = 'a pair was applied more than once';
          break;
        }
      }
      if (d.stop === 'limit' && overlapped >= MIN_OVERLAPPED_PAIRS) d.stop = 'overlapped';
    }
  }

  /** The learning pass of a gated step: one keyed write alone, to see which backend request commits it. */
  const learn = async (label: string, t: Target): Promise<{ method: string; path: string; nth: number } | { skipped: string }> => {
    const gate = ctx.gate!;
    const mark = gate.mark();
    const tr = kind === 'update' ? await trace('l0', t, false) : null;
    const c = await send(label, argsFor(t, tr).args, key('l'), 'learn');
    const reqs = await gate.since(mark);
    const last = lastMutating(reqs);
    if (!c.ok) return { skipped: `the learning call failed (${(c.text ?? c.rpc_error?.message ?? '').slice(0, 120)})` };
    if (!last) return { skipped: 'the learning call sent no mutating request to the backend' };
    return { method: last.method, path: last.path, nth: nthOf(reqs, last) };
  };

  // The proxy-assisted step.
  if (ctx.gate) {
    const gate = ctx.gate;
    const p: ProxyObs = { routing: gate.describe(), learned: null, key: key('x'), t0: null, a1: null, hit: false, t1: null, a2: null, t2: null, undo: [] };
    obs.proxy = p;
    const t = await target('idemx');
    const l = 'skipped' in t ? t : await learn(L, t);
    if ('skipped' in l) p.skipped = l.skipped;
    else {
      const tt = t as Target;
      p.learned = l;
      p.t0 = await trace('x0', tt, false);
      const args = argsAt(tt, p.t0);
      const mark = gate.mark();
      const f = gate.fault({ method: l.method, path: l.path, nth: l.nth, kind: 'commit_then_reset' });
      try {
        p.a1 = await send(L, args, p.key, 'proxy.cut');
        p.hit = !!(await f.waitHit(1000));
      } finally {
        f.clear();
      }
      p.t1 = await trace('x1', tt);
      p.a2 = await send(L, args, p.key, 'proxy.repeat');
      p.t2 = await trace('x2', tt);
      // why: a delete of the object the cut call created, seen at the interposer, is the server undoing its write.
      p.undo = undoneBy(await gate.since(mark), [...p.t1.ids, ...p.t2.ids]);
    }
  }

  // Step (e): a dedicated server, the first call answered, the tester's own stop and start, then the repeat.
  const restartDecl = ctx.manifest.server.restart;
  const launchable = !!(ctx.manifest.server.stdio || ctx.manifest.server.launch);
  if (restartDecl && launchable) {
    const r: RestartObs = { key: key('e'), t0: null, a1: null, t1: null, restart: null, tr: null, a2: null, t2: null, t3: null, gap_ms: null, settle_ms: settle };
    obs.restart = r;
    const LR = ctx.label('IDEMR');
    const started = await ctx.session.launch({ label: LR, env: {} });
    const t = started.started ? await target('idemr') : { skipped: `the dedicated server did not start: ${started.reason}` };
    if ('skipped' in t) r.skipped = t.skipped;
    else {
      r.t0 = await trace('e0', t, false);
      const args = argsAt(t, r.t0);
      r.a1 = await send(LR, args, r.key, 'restart.first');
      r.t1 = await trace('e1', t);
      r.restart = await ctx.session.restart(LR, restartDecl.stop);
      r.tr = await trace('er', t, false);
      if (r.restart.started) {
        r.a2 = await send(LR, args, r.key, 'restart.repeat');
        r.gap_ms = r.a2.t_start_ms - r.a1.t_end_ms;
        r.t2 = await trace('e2', t, false);
        if (settle > 0) r.t3 = await trace('e3', t);
      }
    }
  }

  // The crash form of step (e): the first write committed, its answer held at the interposer, the server stopped and started.
  if (restartDecl && launchable && ctx.gate) {
    const gate = ctx.gate;
    const c: CrashObs = { routing: gate.describe(), learned: null, hit: false, answered_before_stop: false, key: key('f'), t0: null, a1: null, t1: null, restart: null, tr: null, a2: null, t2: null, t3: null, gap_ms: null, settle_ms: settle };
    obs.crash = c;
    const LC = ctx.label('IDEMC');
    const started = await ctx.session.launch({ label: LC, env: {} });
    const t = started.started ? await target('idemc') : { skipped: `the dedicated server did not start: ${started.reason}` };
    const l = 'skipped' in t ? t : await learn(LC, t);
    if ('skipped' in l) c.skipped = l.skipped;
    else {
      const tt = t as Target;
      c.learned = l;
      c.t0 = await trace('f0', tt, false);
      const args = argsAt(tt, c.t0);
      const mark = gate.mark();
      const f = gate.fault({ method: l.method, path: l.path, nth: l.nth, kind: 'commit_then_hang' });
      let answered = false;
      let hitAt = 0;
      const pending = send(LC, args, c.key, 'crash.first').then((x) => ((answered = true), x));
      try {
        c.hit = !!(await Promise.race([f.waitHit(Math.min(HANG_WAIT_MS, ctx.manifest.limits.timeout_ms)), pending.then(() => null)]));
        if (!c.hit) c.hit = !!(await f.waitHit(50));
        hitAt = nowMs();
        // why: an answer before the stop means the server was not stopped while the answer was held: not a trial of the crash form.
        await sleep(20);
        c.answered_before_stop = answered;
      } finally {
        f.clear();
      }
      if (!c.hit || c.answered_before_stop) c.a1 = await pending;
      else {
        c.restart = await ctx.session.restart(LC, restartDecl.stop);
        c.a1 = await pending;
        c.tr = await trace('fr', tt, false);
        if (c.restart.started) {
          c.a2 = await send(LC, args, c.key, 'crash.repeat');
          c.gap_ms = c.a2.t_start_ms - hitAt;
          c.t2 = await trace('f2', tt, false);
          if (settle > 0) c.t3 = await trace('f3', tt);
          // why (review of note 8, 7): the restarted server may undo the committed write; the proxy step's undo scan applies.
          c.undo = undoneBy(await gate.since(mark), [...c.tr.ids, ...c.t2.ids, ...(c.t3?.ids ?? [])]);
        }
      }
    }
  }
}
