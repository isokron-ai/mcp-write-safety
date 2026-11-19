/**
 * MWS-RES-2 on every declared write call (B-GAP F4): the failed request, the lost answer and the declared failures, generalised
 * from the update tool's held-request check (gated.ts) to each write the manifest declares a call for.
 *
 *   write calls     from the manifest only: a resource's create, its delete, the top-level `calls` bound to it, its `versioned`
 *                   calls, its `input_required` calls (retried with the declared answers) and its `creates`. A tool is judged
 *                   once, under the first resource that declares a call for it. The update tools (gated.ts) and the multi-item
 *                   tools (multi.ts) are judged where their own procedure runs; read tools are never called here.
 *   target          a scratch object of the resource for a call that names one (its {{id}}), read back by id; a create is read
 *                   back by its key (a keyed create) or found by its marker through the list call
 *   learning pass   the call alone through the gate, with no fault; its backend requests are recorded, and the last mutating
 *                   one is the request the trials fail. The run is also a trial of the clause on a settled outcome (R9-1).
 *   failed request  (proxy-assisted) that request answered with status 500 and not forwarded; read back; judged by res2Judge
 *   lost answer     (proxy-assisted) that request forwarded, the backend applies it, the connection is closed before the server
 *                   receives the answer; read back; judged by lostAnswerVerdict (gated.ts). Where the error names the version
 *                   the call carried, the follow-through (R10-11) sends the call again once with that version, with no fault.
 *   declared        (black-box) the `failures` of a resource with no object under test (it has no update block): each on a
 *   failures        scratch object where it names one, else read back by the key it carries. A resource with an object under
 *                   test has its failures judged by the creates check, against that object.
 *
 * Each trial uses a fresh target, so the trials do not depend on each other. The fault matches the learned request by its
 * method and its position among the requests of that method in the call (the path holds the target's id, which differs).
 */

import { baseVars, deleteArgs, Driver } from '../core/driver.js';
import { listAll } from '../core/lists.js';
import type { ResourceSpec } from '../core/manifest.js';
import { createVerified, goneFrom } from '../core/objects.js';
import type { CallResult, Carried } from '../core/session.js';
import { render, templateRoots } from '../core/template.js';
import { deepEqual, diff, getPath, isObj, short, sleep, withoutIgnored } from '../core/util.js';
import { lastMutating, type GateRequest } from '../gate/gate.js';
import { result, type Result } from '../report/verdicts.js';
import { declaredWriteTools } from './coverage.js';
import { changeOutOfBand, followRead, lostAnswerVerdict, namesCarriedVersion, type LostAnswerObs, type SettledRun } from './gated.js';
import { ignoredPaths } from './readback.js';
import { scratch } from './scratch.js';
import { brief, res2Judge, toolByName, wp, type CallBrief, type CheckModule, type FollowThroughRead, type Observation, type PlanContext, type PlannedCheck, type RunContext, type Tool } from './types.js';

const ID = 'write-faults';

/**
 * The evidence a violation provoked by an injected status carries (F1: Evidence.synthetic_fault): a 500 the gate made, which the
 * real backend may never send. Passed through result()'s options; a result() without the evidence option ignores it. The lost
 * answer (a connection cut after the backend applied the write) is not synthetic.
 */
export const SYNTHETIC_FAULT: object = { evidence: { synthetic_fault: true } };
const VERSION = '1';

/** One declared write call: the tool, its argument template, and how its target is set up and read back. */
export interface WriteCall {
  tool: string;
  /** create: a new object, found by its key or marker; delete: a scratch object, gone afterwards; object: a scratch object it changes. */
  kind: 'create' | 'delete' | 'object';
  args: unknown;
  /** Where in the manifest the call is declared (for the record). */
  from: string;
  /** For a tool that answers input_required: the answers sent on the retry, and the client capabilities declared for it. */
  input?: { answers: Record<string, unknown>; caps: Record<string, unknown> } | null;
}

type Req = { seq: number; method: string; path: string; status: number | null };
const reqOf = (r: GateRequest): Req => ({ seq: r.seq, method: r.method, path: r.path, status: r.status });
const showReq = (r: Req) => `#${r.seq} ${r.method} ${r.path}`;

/** The declared write calls of one resource, in the order above (the first call declared for a tool is kept). */
export function resourceWriteCalls(m: PlanContext['manifest'], res: ResourceSpec): WriteCall[] {
  const out: WriteCall[] = [];
  const add = (c: WriteCall) => {
    if (!out.some((x) => x.tool === c.tool)) out.push(c);
  };
  if (res.create) add({ tool: res.create.tool, kind: 'create', args: res.create.args, from: `${res.name}.create` });
  if (res.delete) add({ tool: res.delete.tool, kind: 'delete', args: res.delete.args, from: `${res.name}.delete` });
  for (const [tool, c] of Object.entries(m.calls ?? {})) if (c.resource === res.name) add({ tool, kind: 'object', args: c.args, from: `calls.${tool}` });
  for (const v of res.versioned) add({ tool: v.tool, kind: 'object', args: v.args, from: `${res.name}.versioned` });
  for (const ir of res.input_required) add({ tool: ir.tool, kind: 'object', args: ir.args, from: `${res.name}.input_required`, input: { answers: ir.answers, caps: ir.client_capabilities } });
  for (const c of res.creates) add({ tool: c.tool, kind: 'object', args: c.args, from: `${res.name}.creates.${c.name}` });
  return out;
}

/**
 * The write calls this check judges for a resource: the declared write tools (never a read tool), leaving out every resource's
 * update tool (the held-request check) and every multi-item tool (the multi-item check), which have their own failed-request and
 * lost-answer trials. One trial per distinct argument template of a tool (a delete declared with the version on one resource and
 * with force: true on another is two write paths), under the first resource declaring that template that can run the trial; where
 * none can, under the first that declares it, which then records why.
 */
export function writeCallsOf(m: PlanContext['manifest'], tools: Tool[], res: ResourceSpec): WriteCall[] {
  const writes = declaredWriteTools(m, tools);
  const elsewhere = new Set<string>([...m.resources.flatMap((r) => (r.update ? [r.update.tool] : [])), ...m.resources.flatMap((r) => r.multi.map((x) => x.tool))]);
  const owner = new Map<string, string>();
  const keyOf = (c: WriteCall) => `${c.tool}\u0000${c.kind}\u0000${JSON.stringify(c.args ?? null)}`;
  for (const r of m.resources) for (const c of resourceWriteCalls(m, r)) if (!owner.has(keyOf(c)) && !cannotTry(r, c)) owner.set(keyOf(c), r.name);
  for (const r of m.resources) for (const c of resourceWriteCalls(m, r)) if (!owner.has(keyOf(c))) owner.set(keyOf(c), r.name);
  return resourceWriteCalls(m, res).filter((c) => writes.has(c.tool) && !elsewhere.has(c.tool) && owner.get(keyOf(c)) === res.name);
}

/** Why a write call cannot be tried on this resource, or null. */
function cannotTry(res: ResourceSpec, c: Pick<WriteCall, 'kind' | 'tool'>): string | null {
  if (!res.cleanup || res.cleanup === 'leave') return `${res.name} has no cleanup policy, and every trial makes objects`;
  if (c.kind === 'create') return res.key || res.list ? null : `${res.name} declares neither a key nor a list block, so the object a create made cannot be found by anything but its answer`;
  if (!res.create) return `${res.name} has no create block, so there is no scratch object for ${c.tool} to act on`;
  return null;
}

/**
 * What the call carried (B-9 "How a tester uses it"), for reading `same_version` and `same_key`: a version where the declared
 * version argument has a value; none where the template has neither {{version}} nor {{object}}; otherwise unknown (the version
 * may be carried under another name). The key: the declared idempotency key of this tool as an argument; these trials add none.
 */
function carriedOf(res: ResourceSpec, c: WriteCall, args: unknown): Carried {
  const roots = templateRoots(c.args ?? null);
  const present = (v: unknown) => v !== null && v !== undefined && v !== '';
  const vArg = res.version?.arg;
  let version: boolean | undefined;
  if (vArg && isObj(args) && present(args[vArg])) version = true;
  // why: {{version}} under another argument, or a whole object that may hold it, cannot be told apart here: unknown.
  else if (roots.has('version') || roots.has('object')) version = undefined;
  else version = false;
  const idem = res.idempotency && res.idempotency.tool === c.tool ? res.idempotency : (res.creates.find((x) => x.tool === c.tool)?.idempotency ?? null);
  const key = !idem ? undefined : 'arg' in idem.key ? isObj(args) && present(args[idem.key.arg]) : false;
  return { ...(key !== undefined ? { key } : {}), ...(version !== undefined ? { version } : {}) };
}

/** A failure call that names the target object ({{id}}, {{object…}} or {{version}}). */
const namesTarget = (args: unknown): boolean => ['id', 'object', 'version'].some((k) => templateRoots(args).has(k));

interface Snap {
  ok: boolean;
  present: boolean;
  obj: unknown;
  version: unknown;
  /** For a create found by its marker: the ids found. */
  ids?: unknown[];
  why?: string;
}

/** What one trial saw. */
export interface FaultTrial {
  skipped?: string;
  call: CallBrief | null;
  /** The step ids of the calls the trial made (the call, and the retry of an input_required answer). */
  steps: string[];
  requests: Req[];
  faulted: Req | null;
  changed: string[] | null;
  values: Record<string, unknown>;
  applied: boolean | null;
  object: unknown;
  version_sent?: unknown;
  follow?: FollowThroughRead | null;
}

export interface WriteCallObs {
  tool: string;
  kind: WriteCall['kind'];
  from: string;
  skipped?: string;
  learn: FaultTrial | null;
  hold: { method: string; nth: number; req: Req } | null;
  fail: FaultTrial | null;
  lost: FaultTrial | null;
}

export interface DeclaredFailureObs {
  name: string;
  tool: string;
  call: CallBrief | null;
  changed: string[] | null;
  values: Record<string, unknown>;
  skipped?: string;
}

export interface WriteFaultsObs {
  routing: string | null;
  calls: WriteCallObs[];
  failures: DeclaredFailureObs[];
}

export const writeFaultsCheck: CheckModule = {
  id: ID,
  version: VERSION,
  requirements: ['MWS-RES-2'],
  plan(ctx: PlanContext, res: ResourceSpec): PlannedCheck {
    const base: PlannedCheck = { check: ID, version: VERSION, resource: res.name, runs: false, calls: [], writes: 0, creates: 0, notRun: [] };
    const sc = { id: ID, version: VERSION };
    const calls: string[] = [];
    const nr: Result[] = [];
    let writes = 0;
    let creates = 0;
    for (const c of writeCallsOf(ctx.manifest, ctx.tools, res)) {
      const w = wp(res.name, c.tool);
      if (!toolByName(ctx.tools, c.tool)) {
        nr.push(result('MWS-RES-2', w, sc, 'not tested', `${c.tool} is not in tools/list`));
        continue;
      }
      if (!ctx.manifest.backend?.gate) {
        nr.push(result('MWS-RES-2', w, sc, 'not tested', `a failed or lost backend answer for ${c.tool} (declared at ${c.from}) is brought about through backend.gate, which the declaration does not configure (the hop between the server and its backend cannot be interposed on without it)`));
        continue;
      }
      const no = cannotTry(res, c);
      if (no) {
        nr.push(result('MWS-RES-2', w, sc, 'not tested', no));
        continue;
      }
      calls.push(`MWS-RES-2 ${c.tool} (${c.from}): learning pass on a fresh ${c.kind === 'create' ? 'marker' : 'scratch object'}; fail its last mutating backend request (status 500); let it through and cut the answer (lost answer); where the error names the version the call carried, change the object out of band and send the call again once with that version (R10-11); read back after each`);
      // Four sends of the call (learning pass, failed request, lost answer, follow-through), each two calls where it answers
      // input_required and is retried; the out-of-band change; and a scratch object per trial except for a create.
      writes += (c.input ? 2 : 1) * 4 + 1 + (c.kind === 'create' ? 0 : 3);
      creates += c.kind === 'create' ? 4 : 3;
    }
    if (!res.update)
      for (const f of res.failures) {
        if (!toolByName(ctx.tools, f.tool)) {
          nr.push(result('MWS-RES-2', wp(res.name, f.tool), { id: `${ID}.declared`, version: VERSION }, 'not tested', `${f.tool} is not in tools/list`));
          continue;
        }
        const keyed = !!res.key && isObj(f.args) && f.args[res.key.arg] !== undefined;
        const nof = !namesTarget(f.args) && !keyed ? `${f.tool}'s arguments name neither an object of ${res.name} ({{id}}) nor a key (${res.key ? res.key.arg : 'no key declared'}), so nothing could be read around the call; it is not sent` : cannotTry(res, { tool: f.tool, kind: namesTarget(f.args) ? 'object' : 'create' });
        if (nof) {
          nr.push(result('MWS-RES-2', wp(res.name, f.tool), { id: `${ID}.declared`, version: VERSION }, 'not tested', `${f.name}: ${nof}`));
          continue;
        }
        calls.push(`MWS-RES-2 declared failure ${f.name}: ${f.tool}${namesTarget(f.args) ? ' on a scratch object' : ''}; ${res.read.tool} around it`);
        writes += 2;
        creates += namesTarget(f.args) ? 1 : 0;
      }
    return { ...base, runs: calls.length > 0, calls, writes, creates, notRun: nr };
  },
  async collect(ctx: RunContext, res: ResourceSpec): Promise<Observation> {
    const obs: WriteFaultsObs = { routing: ctx.gate?.describe() ?? null, calls: [], failures: [] };
    if (ctx.gate) for (const c of writeCallsOf(ctx.manifest, ctx.tools, res)) if (toolByName(ctx.tools, c.tool) && !cannotTry(res, c)) obs.calls.push(await runCall(ctx, res, c));
    if (!res.update) for (const f of res.failures) if (toolByName(ctx.tools, f.tool) && (namesTarget(f.args) || (!!res.key && isObj(f.args) && f.args[res.key.arg] !== undefined)) && !cannotTry(res, { tool: f.tool, kind: namesTarget(f.args) ? 'object' : 'create' })) obs.failures.push(await runFailure(ctx, res, f));
    return { check: ID, version: VERSION, resource: res.name, data: obs };
  },
  evaluate(obs: Observation, ctx: PlanContext): Result[] {
    const res = ctx.manifest.resources.find((r) => r.name === obs.resource)!;
    return writeFaultsVerdicts(obs.data as WriteFaultsObs, res, ctx.manifest.async_operations ?? []);
  },
};

/** A target for one trial: a scratch object (read back by id), a keyed create (read back by its key), or a marker to find. */
interface Target {
  driver: Driver | null;
  marker: string;
  vars: Record<string, unknown>;
  known: Set<string>;
  skipped?: string;
}

async function target(ctx: RunContext, res: ResourceSpec, kind: WriteCall['kind'], tag: string, label: string): Promise<Target> {
  const marker = ctx.marker(tag);
  const known = new Set<string>();
  const scope = ctx.driver.scope ?? null;
  if (kind === 'create') {
    let d: Driver | null = null;
    // why: a keyed create is read back by the key the call carries; any other create is found through the list by its marker.
    if (res.key) {
      d = new Driver(ctx.session, ctx.manifest, res, ctx.prefix, ctx.env);
      d.scope = scope;
      d.id = marker;
    }
    return { driver: d, marker, known, vars: baseVars(res, ctx.prefix, { scope, marker, key: marker }) };
  }
  const s = await scratch(ctx, res, { tag, purpose: `MWS-RES-2 ${tag}: the object the write acts on`, label });
  if (!s.ok || !s.driver) return { driver: null, marker, known, vars: {}, skipped: `the scratch object could not be created (${s.reason})` };
  known.add(JSON.stringify(s.id));
  return { driver: s.driver, marker, known, vars: s.driver.vars({ marker, key: marker }) };
}

async function snap(ctx: RunContext, res: ResourceSpec, t: Target, label: string, tag: string, settle: boolean): Promise<Snap> {
  if (settle && res.read.settle_ms > 0) await sleep(res.read.settle_ms);
  const step = ctx.session.stepId(`res2w.${tag}`);
  if (t.driver) {
    const r = await t.driver.readOnce(label, step);
    if (r.ok) return { ok: true, present: true, obj: r.obj, version: r.version };
    const g = goneFrom(res, r);
    if (g === true) return { ok: true, present: false, obj: null, version: null };
    return { ok: false, present: false, obj: null, version: null, why: `the object did not read back (${short(r.call?.text ?? r.call?.rpc_error?.message ?? 'error', 120)})` };
  }
  if (!res.list) return { ok: false, present: false, obj: null, version: null, why: 'no list block to find the object by its marker' };
  const lr = await listAll(ctx.session, label, res.list, render(res.list.args, baseVars(res, ctx.prefix, { scope: ctx.driver.scope ?? null, marker: t.marker })), step);
  if (!lr.ok || lr.partial) return { ok: false, present: false, obj: null, version: null, why: lr.partial ?? lr.reason ?? 'the list call failed' };
  const ids = lr.items.filter((it) => String(getPath(it, res.list!.name) ?? '').includes(t.marker)).map((it) => getPath(it, res.list!.id));
  // why: an object found by this run's marker is ours, whether or not an answer named it; it is cleaned up like the others.
  for (const id of ids) {
    if (id === null || id === undefined || t.known.has(JSON.stringify(id))) continue;
    t.known.add(JSON.stringify(id));
    const intent = ctx.ledger.intent(res.name, res.create?.tool ?? '(create)', 'MWS-RES-2: an object found by its marker');
    ctx.ledger.append({ kind: 'created', intent, resource: res.name, id, name: t.marker, via: 'sweep' });
  }
  return { ok: true, present: ids.length > 0, obj: null, version: null, ids };
}

/** What changed between two snapshots: paths (with the value each has afterwards), or null where a read failed. */
function changes(res: ResourceSpec, t: Target, b: Snap, a: Snap): { paths: string[]; values: Record<string, unknown> } | null {
  if (!b.ok || !a.ok) return null;
  if (b.ids || a.ids) {
    const fresh = (a.ids ?? []).filter((id) => !(b.ids ?? []).some((x) => deepEqual(x, id)));
    return { paths: fresh.map((id) => String(id)), values: Object.fromEntries(fresh.map((id) => [String(id), id])) };
  }
  const id = t.driver?.id;
  if (b.present !== a.present) return { paths: [String(id)], values: { [String(id)]: id } };
  if (!b.present) return { paths: [], values: {} };
  const d = withoutIgnored(diff(b.obj, a.obj), ignoredPaths(res));
  return { paths: d.map((e) => e.path), values: Object.fromEntries(d.map((e) => [e.path, e.after])) };
}

/** The call, retried once with the declared answers where it answers input_required; the final answer is the one judged. */
async function send(ctx: RunContext, res: ResourceSpec, c: WriteCall, t: Target, args: unknown, label: string, tag: string): Promise<{ r: CallResult; steps: string[] }> {
  const step = ctx.session.stepId(`res2w.${tag}`);
  if (c.kind === 'create') {
    // why: through the ledger, so an error leaves the marker for clean-up and a success leaves the id.
    const cr = await createVerified(ctx.session, ctx.ledger, res, ctx.prefix, { tool: c.tool, args, purpose: `MWS-RES-2 ${tag}`, label, step });
    if (cr.ok) t.known.add(JSON.stringify(cr.id));
    return { r: cr.call!, steps: [step] };
  }
  const meta = c.input ? { 'io.modelcontextprotocol/clientCapabilities': c.input.caps } : undefined;
  const r1 = await ctx.session.call(label, c.tool, args, { step, ...(meta ? { meta } : {}) });
  if (r1.result_type !== 'input_required' || !c.input) return { r: r1, steps: [step] };
  const step2 = ctx.session.stepId(`res2w.${tag}.retry`);
  const params: Record<string, unknown> = { inputResponses: c.input.answers, ...(r1.input_required?.requestState ? { requestState: r1.input_required.requestState } : {}) };
  return { r: await ctx.session.call(label, c.tool, args, { step: step2, meta, params }), steps: [step, step2] };
}

function argsFor(ctx: RunContext, res: ResourceSpec, c: WriteCall, t: Target, b: Snap): unknown {
  const vars = { ...t.vars, ...(t.driver && b.present ? { object: b.obj, version: b.version } : {}) };
  if (c.kind === 'delete') return deleteArgs(res, vars, toolByName(ctx.tools, c.tool)?.inputSchema);
  return render(c.args, vars);
}

async function runCall(ctx: RunContext, res: ResourceSpec, c: WriteCall): Promise<WriteCallObs> {
  const gate = ctx.gate!;
  const label = ctx.label('RES2W');
  const o: WriteCallObs = { tool: c.tool, kind: c.kind, from: c.from, learn: null, hold: null, fail: null, lost: null };
  const one = async (mode: 'learn' | 'fail' | 'lost'): Promise<FaultTrial> => {
    const tr: FaultTrial = { call: null, steps: [], requests: [], faulted: null, changed: null, values: {}, applied: null, object: null };
    const t = await target(ctx, res, c.kind, `rw${mode[0]}`, label);
    if (t.skipped) return { ...tr, skipped: t.skipped };
    tr.object = t.driver?.id ?? t.marker;
    const b = await snap(ctx, res, t, label, `${mode}.before`, false);
    if (!b.ok) return { ...tr, skipped: `before the call: ${b.why}` };
    const args = argsFor(ctx, res, c, t, b);
    const vArg = res.version?.arg;
    if (vArg && isObj(args) && args[vArg] !== undefined && args[vArg] !== null && args[vArg] !== '') tr.version_sent = args[vArg];
    const f = mode === 'learn' || !o.hold ? null : gate.fault({ method: o.hold.method, path: '*', nth: o.hold.nth, kind: mode === 'fail' ? 'status' : 'commit_then_reset', status: 500 });
    const mark = gate.mark();
    let sent: { r: CallResult; steps: string[] };
    try {
      sent = await send(ctx, res, c, t, args, label, `${c.tool}.${mode}`);
    } finally {
      // why: a fault left armed would fail a later request of another check.
      if (f) {
        const hit = await f.waitHit(1000);
        f.clear();
        tr.faulted = hit ? reqOf(hit) : null;
      }
    }
    tr.call = brief({ ...sent.r, carried: carriedOf(res, c, args) });
    tr.steps = sent.steps;
    tr.requests = (await gate.since(mark)).map(reqOf);
    const a = await snap(ctx, res, t, label, `${mode}.after`, true);
    const ch = changes(res, t, b, a);
    tr.changed = ch?.paths ?? null;
    tr.values = ch?.values ?? {};
    tr.applied = ch ? ch.paths.length > 0 : null;
    if (f && !tr.faulted) tr.skipped = 'the fault was not applied (different backend requests than in the learning pass)';
    // R10-11: the error names the version the call carried: the call is sent again once with that version, with no fault.
    // why: review of f4: the object is changed out of band first, so that a repeat the version does not guard shows as applied.
    if (mode === 'lost' && tr.faulted && tr.applied && tr.call && namesCarriedVersion(tr.call, vArg ?? null, tr.version_sent)) {
      const oob = t.driver && a.present ? await changeOutOfBand(t.driver, res, a.obj, label, ctx.session.stepId('res2w.oob')) : null;
      const mid = oob?.ok ? await snap(ctx, res, t, label, `${mode}.oob`, true) : null;
      const moved = !!mid && mid.ok && mid.present && (!deepEqual(mid.version, a.version) || withoutIgnored(diff(a.obj, mid.obj), ignoredPaths(res)).length > 0);
      if (!oob || !oob.ok || !mid || !moved) tr.follow = { applied_again: null, how: `the object could not be changed out of band before the repeat (${!t.driver || !a.present ? 'the object is not present to change' : oob ? oob.how : 'no control.patch, no update tool or no declared field'}), so an unguarded repeat would not show` };
      else {
        const again = await send(ctx, res, c, t, args, label, `${c.tool}.follow`);
        const a2 = await snap(ctx, res, t, label, `${mode}.follow`, true);
        const fr = followRead(brief(again.r), mid, a2, !!res.version, res.version?.read ?? null, ignoredPaths(res));
        tr.follow = { ...fr, how: `out of band, ${oob.how}; ${fr.how}` };
      }
    }
    return tr;
  };
  o.learn = await one('learn');
  if (o.learn.skipped) return { ...o, skipped: `learning pass: ${o.learn.skipped}` };
  // why: review of f4: the trials fail a write the learning pass showed working; a pass that was refused, or that the read-back
  // does not show applied, gives no write to fail.
  if (!o.learn.call?.ok || o.learn.applied !== true) return { ...o, skipped: `the learning pass did not show a working write (${!o.learn.call ? 'no answer' : o.learn.call.indeterminate ? 'its outcome is unknown' : !o.learn.call.ok ? `it was refused: ${JSON.stringify(short(o.learn.call.text ?? o.learn.call.rpc_error?.message ?? '', 120))}` : o.learn.applied === null ? 'the target did not read back around it' : 'it answered success and the read-back shows nothing applied'}), so there is no write to fail` };
  const reqs = o.learn.requests;
  const last = lastMutating(reqs);
  if (!last) return { ...o, skipped: `${c.tool} sent no mutating request to the backend in the learning pass (${reqs.length ? reqs.map(showReq).join(', ') : 'no backend request'})` };
  o.hold = { method: last.method, nth: reqs.filter((q) => q.seq <= last.seq && q.method === last.method).length, req: last };
  o.fail = await one('fail');
  o.lost = await one('lost');
  return o;
}

async function runFailure(ctx: RunContext, res: ResourceSpec, f: ResourceSpec['failures'][number]): Promise<DeclaredFailureObs> {
  const label = ctx.label('RES2F');
  const o: DeclaredFailureObs = { name: f.name, tool: f.tool, call: null, changed: null, values: {} };
  // why: the read-back target: a scratch object where the call names one; else the object under the key the call carries.
  const byObject = namesTarget(f.args);
  const keyArg = !byObject && res.key && isObj(f.args) && f.args[res.key.arg] !== undefined ? f.args[res.key.arg] : undefined;
  let t: Target;
  if (byObject) t = await target(ctx, res, 'object', 'rwd', label);
  else {
    const marker = ctx.marker('rwd');
    const vars = baseVars(res, ctx.prefix, { scope: ctx.driver.scope ?? null, marker, key: marker });
    let d: Driver | null = null;
    if (keyArg !== undefined) {
      d = new Driver(ctx.session, ctx.manifest, res, ctx.prefix, ctx.env);
      d.scope = ctx.driver.scope ?? null;
      d.id = render(keyArg, vars);
    }
    t = { driver: d, marker, known: new Set(), vars };
  }
  if (t.skipped) return { ...o, skipped: t.skipped };
  if (!t.driver) return { ...o, skipped: `${f.tool}'s arguments name neither an object of ${res.name} ({{id}}) nor a key (${res.key ? res.key.arg : 'no key declared'}), so nothing could be read around the call` };
  const b = await snap(ctx, res, t, label, `fail.${f.name}.before`, false);
  if (!b.ok) return { ...o, skipped: `before the call: ${b.why}` };
  // why: review of f4: a failure read back by its key needs that key free; an object already under it is not the tester's to judge by.
  if (!byObject && b.present) return { ...o, skipped: `an object already exists under the key ${short(t.driver.id, 60)} the call carries, so what the call changed could not be told apart from it; the call was not sent` };
  const args = render(f.args, { ...t.vars, ...(b.present ? { object: b.obj, version: b.version } : {}) });
  const step = ctx.session.stepId(`res2w.fail.${f.name}`);
  // why: a failure that names a key creates nothing on a correct server; through the ledger all the same, so a server that does
  // create it leaves the key for clean-up.
  const viaCreate = !!res.create && f.tool === res.create.tool;
  const cr = viaCreate ? await createVerified(ctx.session, ctx.ledger, res, ctx.prefix, { tool: f.tool, args, purpose: `MWS-RES-2 declared failure ${f.name}`, label, step }) : null;
  const r = cr ? cr.call! : await ctx.session.call(label, f.tool, args, { step });
  o.call = brief(r);
  const a = await snap(ctx, res, t, label, `fail.${f.name}.after`, true);
  // why: review of f4: a failure keyed on an object that the server wrongly made (by a tool other than the create, or a create whose
  // answer gave no id) is the run's object: it goes into the ledger, so clean-up removes it.
  if (!byObject && a.ok && a.present && !b.present && !cr?.ok) {
    const intent = ctx.ledger.intent(res.name, f.tool, `MWS-RES-2 declared failure ${f.name}: an object found under the key the call carried`);
    ctx.ledger.append({ kind: 'created', intent, resource: res.name, id: t.driver.id, name: String(t.driver.id), via: 'sweep' });
  }
  const ch = changes(res, t, b, a);
  o.changed = ch?.paths ?? null;
  o.values = ch?.values ?? {};
  return o;
}

export function writeFaultsVerdicts(o: WriteFaultsObs, res: ResourceSpec, asyncOps: string[] = []): Result[] {
  const out: Result[] = [];
  const sc = { id: ID, version: VERSION };
  const su = { id: `${ID}.unknown-outcome`, version: VERSION };
  const sd = { id: `${ID}.declared`, version: VERSION };
  const route = `Route: ${o.routing ?? 'no gate'}`;
  for (const c of o.calls) {
    const w = wp(res.name, c.tool);
    const from = `Write call: ${c.tool} as declared at ${c.from} (${c.kind === 'create' ? 'a create, found afterwards by its key or marker' : c.kind === 'delete' ? 'a delete of a scratch object' : 'a write on a scratch object'}); each trial on a fresh target.`;
    const learned = c.learn ? `learning pass: ${c.learn.requests.map(showReq).join(', ') || 'no backend request'}${c.hold ? `; the trials fail the ${c.hold.nth}${c.hold.nth === 1 ? 'st' : c.hold.nth === 2 ? 'nd' : 'th'} ${c.hold.method} request of the call (${showReq(c.hold.req)} in the learning pass)` : ''}` : 'no learning pass';
    const notes = [route, from, learned];
    if (c.skipped) {
      out.push(result('MWS-RES-2', w, sc, 'not tested', `failed backend request: ${c.skipped}`, { notes }));
      out.push(result('MWS-RES-2', w, su, 'not tested', `unknown outcome: ${c.skipped}`, { notes }));
      continue;
    }
    // The failed request (status 500, not forwarded), judged as the update tool's is (gated.ts).
    const r = c.fail;
    if (!r || r.skipped || !r.call || r.call.indeterminate) out.push(result('MWS-RES-2', w, sc, 'not tested', `failed backend request: ${r?.skipped ?? (r?.call ? 'the outcome of the call is unknown' : 'the call was not made')}`, { notes }));
    else if (r.changed === null) out.push(result('MWS-RES-2', w, sc, 'not tested', 'failed backend request: the target did not read back around the call', { notes }));
    // why: review of f4: a success with the write in effect counts as a retry the server made only where the gate shows the faulted
    // request sent again and carried out (a 2xx for the same method and path after it); in a call of several backend requests a
    // success over a failed later request is otherwise a failure reported as a success.
    else if (r.call.ok && r.applied && r.requests.some((q) => q.seq > r.faulted!.seq && q.method === r.faulted!.method && q.path === r.faulted!.path && typeof q.status === 'number' && q.status >= 200 && q.status < 300)) out.push(result('MWS-RES-2', w, sc, 'not tested', 'failed backend request: the server retried the failed request (the gate shows it sent again and carried out) and the write took effect, so no failure was produced', { notes }));
    else {
      const j = res2Judge(r.call, r.changed, 'backend', `The tester failed the backend request (failed ${showReq(r.faulted!)} with status 500, not forwarded)`, r.values, { async: asyncOps.includes(c.tool), object: r.object });
      out.push(result('MWS-RES-2', w, sc, j.verdict, j.reason, { steps: j.verdict === 'violated' ? r.steps : [], notes: [...notes, ...j.notes], ...SYNTHETIC_FAULT }));
    }
    // The lost answer, judged by the same rules as the update tool's (gated.ts lostAnswerVerdict).
    const l = c.lost;
    const lost: LostAnswerObs = l ? { ...(l.skipped ? { skipped: l.skipped } : {}), faulted: l.faulted, call: l.call, changed: l.changed, applied: l.applied, object: l.object, requests: l.requests, version_sent: l.version_sent ?? null, follow: l.follow ?? null } : { skipped: 'the trial was not made', faulted: null, call: null, changed: null, applied: null };
    const runs: SettledRun[] = c.learn && c.learn.call ? [{ label: `${c.tool} (${c.from})`, requests: c.learn.requests, call: c.learn.call, applied: c.learn.applied }] : [];
    const rec = lostAnswerVerdict(lost, { w, sc: su, route, tool: c.tool, readTool: res.read.tool, versionArg: res.version?.arg ?? null, values: l?.values ?? {}, fallbackChanged: l?.changed ?? [], async: asyncOps.includes(c.tool), learned: runs });
    // why: a violated record names the steps of the call it judges, including the retry of an input_required answer.
    out.push({ ...rec, steps: rec.verdict === 'violated' && l ? [...new Set([...l.steps, ...rec.steps])] : rec.steps, notes: [...rec.notes.filter((x) => x !== route), ...notes].filter((x, i, a) => a.indexOf(x) === i) });
  }
  for (const f of o.failures) {
    const w = wp(res.name, f.tool);
    if (f.skipped || !f.call) {
      out.push(result('MWS-RES-2', w, sd, 'not tested', `${f.name}: ${f.skipped ?? 'the call was not made'}`));
      continue;
    }
    const jd = res2Judge(f.call, f.call.ok ? (f.changed ?? []) : f.changed, 'backend', `${f.name}: the backend refuses this call (the declaration says so)`, f.values, { async: asyncOps.includes(f.tool) });
    out.push(result('MWS-RES-2', w, sd, jd.verdict, jd.reason, { steps: jd.verdict === 'violated' ? [f.call.step] : [], notes: jd.notes }));
  }
  return out;
}

