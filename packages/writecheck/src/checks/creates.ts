/**
 * Creates and their answers:
 *
 *   MWS-RES-3    create an object, find it independently (by the call's marker, through a list or
 *                read call), and check that the answer carries its identifier. With the backend
 *                gate and a create that makes more than one backend write, its last write is failed
 *                and the error must still carry the identifier of the object that now exists.
 *   MWS-RES-4    after a successful create and a successful update: the answer identifies the
 *                object, names (or carries the new value of) each field an update set, and carries
 *                the new version where one is declared; and it carries no server-managed field
 *                (declared in read.ignore) that the read tool's answer for the same object omits
 *   MWS-RETRY-1  the same create sent twice, one after the other; if that made two objects, a call
 *                carrying the declared idempotency key must be accepted, as a key the tool declares
 *   MWS-RES-2    the calls the declaration says the backend will refuse: each must not be answered
 *                as a success, and the object under test must be left as it was
 *   MWS-RES-1    a delete of a scratch object: success only if it is gone afterwards
 *   Annex A-1    each declared job: the number of tool calls it took (measured, never judged)
 */

import { baseVars, deleteArgs, needsVersion, objectFrom, type Driver, sameCollection } from '../core/driver.js';
import type { CreateSpec, ResourceSpec } from '../core/manifest.js';
import { createVerified, goneByAnswer, goneFrom } from '../core/objects.js';
import { render, templateRoots } from '../core/template.js';
import { deepEqual, diff, getPath, isObj, short, sleep, withoutIgnored, type Obj } from '../core/util.js';
import { isMutating, lastMutating } from '../gate/gate.js';
import { result, type Result } from '../report/verdicts.js';
import { ignoredPaths } from './readback.js';
import { saidBy, says } from './says.js';
import { scratch } from './scratch.js';
import { createdIdEcho, echoOf, requestHay, echoReason, keptArgs, Tally } from './echo.js';
import { decidedByShape, quoteField, reportsSuccess, sameValue, shapeFallbackNote, shapeNamesField, shapeOf } from './shape.js';
import { brief, forPatterns, mentions, offeredKeys, res2Judge, schemaProps, textStatement, toolByName, wp, type CallBrief, type CheckModule, type Observation, type PlanContext, type PlannedCheck, type RunContext } from './types.js';

const ID = 'creates';
// '2': MWS-RES-3 and RES-4 read a receipt through the echo filter (echo.ts), and the finds follow a declared list.consistency;
// '1' counted a value the answer repeated from the request.
const VERSION = '2';

interface CreateObs {
  name: string;
  tool: string;
  /** For an object created inside the object under test: that object's id (the receipt may identify either). */
  parent: unknown;
  /** The arguments the create set (name → value), for MWS-RES-4. */
  set_fields?: Record<string, unknown>;
  /** The first create and the object found by its marker (independently of the answer). */
  first: CallBrief | null;
  /** The arguments the first create sent, for the echo filter (src/checks/echo.ts); absent in older evidence (no filter). */
  sent_args?: unknown;
  /** The marker the first create carried (absent in older evidence): an identifier that contains it is the request's own. */
  marker?: string;
  found: unknown[];
  /** The second identical create (RETRY-1): objects found by the same marker afterwards. */
  repeat: CallBrief | null;
  found_after_repeat: number | null;
  key: { declared: string | null; carrier: 'arg' | 'meta' | null; in_schema: boolean | null; closed_schema: boolean; call: CallBrief | null } | null;
  /** RES-4 for the create: the version read back, and the read answer's top-level keys. */
  version: unknown;
  read_keys: string[] | null;
  /** RES-3, second clause: the last of several backend writes failed. */
  late_failure: { skipped?: string; mutating: number; call: CallBrief | null; found: unknown[]; sent_args?: unknown } | null;
  /** How the finds read the list where list.consistency is declared; absent otherwise. */
  consistency?: string;
  skipped?: string;
}

interface CheckObs {
  creates: CreateObs[];
  /** Why no update receipt was collected for a resource with an update block (action dogfood SH-8); null where one was. */
  update_skipped?: string | null;
  /** sent_args: the update's arguments as sent, for the echo filter; absent in older evidence (no filter). */
  update_receipt: { id: unknown; call: CallBrief | null; field: string; arg: string; value: unknown; version: unknown; read_keys: string[] | null; changed?: { path: string; after: unknown }[] | null; sent_args?: unknown } | null;
  /** changed: null when the object under test did not read back around the call. */
  /** values: the value each changed path has after the call (gate-2 safety re-run F2: a declared applied pattern may credit an error that names it). */
  failures: { name: string; tool: string; call: CallBrief; changed: string[] | null; values?: Record<string, unknown>; skipped?: string }[];
  delete_case: { call: CallBrief | null; gone: boolean | null; skipped?: string } | null;
  jobs: { name: string; calls: number; ok: boolean; failed_at: number | null }[];
}

/** A create tool of this resource (the main one, or a `creates` entry), normalised. */
interface CreateTool {
  name: string;
  tool: string;
  args: unknown;
  /** want: how many objects the find expects at most (a declared list.consistency.settle_ms re-reads until it sees them). */
  find: (ctx: RunContext, marker: string, label: string, scope: unknown, want?: number) => Promise<unknown[] | null>;
  /** The declared consistency of the list the find reads (list.consistency), for the records; null: one plain read. */
  consistency: string | null;
  idem: { key: { arg: string } | { meta: string } } | null;
}

/**
 * Action CI SH-2: a key that makes every create name its object (the caller chooses it) changes what a repeat does; a key declared
 * only to say the tool is an upsert (key.class: upsert) does not switch off RETRY-1, RES-3 and RES-4.
 */
const keyedCreate = (res: ResourceSpec): boolean => !!res.key && res.key.class?.as !== 'upsert';

function createTools(res: ResourceSpec, all: ResourceSpec[] = [res]): CreateTool[] {
  const out: CreateTool[] = [];
  // why: a create tool shared by two resources (one per update tool) is checked once, under the first, where they are one
  // collection (B1 follow-up: a generic create tool shared by posts and pages is checked for each).
  const first = all.find((r) => r.create?.tool === res.create?.tool && r.list && !r.key && sameCollection(r, res));
  if (res.create && res.list && !keyedCreate(res) && first?.name === res.name)
    out.push({
      name: res.name,
      tool: res.create.tool,
      args: res.create.args,
      idem: (() => {
        const d = all.find((r) => r.idempotency?.tool === res.create!.tool)?.idempotency;
        return d ? { key: d.key } : null;
      })(),
      consistency: consistencyLine(res),
      find: async (ctx, marker, label, scope, want = 1) => {
        // why: an eventually consistent list can miss an object just made (RES-3: not found) or the second of two (RETRY-1: read
        // as "not applicable"). list.consistency asks the backend for a consistent read, and/or re-reads within a window.
        const cons = res.list!.consistency;
        const once = async () => {
          const vars = baseVars(res, ctx.prefix, { scope, marker });
          const a = render(res.list!.args, vars);
          const extra = cons?.args ? render(cons.args, vars) : null;
          const r = await ctx.session.call(label, res.list!.tool, isObj(extra) ? { ...(isObj(a) ? a : {}), ...extra } : a, { write: false, step: ctx.session.stepId('creates.find') });
          const items = r.ok ? getPath(r.data, res.list!.items) : null;
          return Array.isArray(items) ? items.filter((it) => String(getPath(it, res.list!.name) ?? '') === marker).map((it) => getPath(it, res.list!.id)) : null;
        };
        let got = await once();
        const until = Date.now() + (cons?.settle_ms ?? 0);
        while (got !== null && got.length < want && Date.now() < until) {
          await sleep(Math.max(20, Math.min(200, (cons?.settle_ms ?? 0) / 10)));
          got = await once();
        }
        return got;
      },
    });
  for (const c of res.creates)
    out.push({
      name: c.name,
      tool: c.tool,
      args: c.args,
      idem: c.idempotency,
      consistency: null,
      find: async (ctx, marker, label) => findIn(ctx, res, c, marker, label),
    });
  return out;
}

/** The record's line on a declared list.consistency; null where none is declared. */
function consistencyLine(res: ResourceSpec): string | null {
  const c = res.list?.consistency;
  if (!c) return null;
  const parts = [...(c.args ? [`with the declared consistent-read arguments ${JSON.stringify(c.args)}`] : []), ...(c.settle_ms ? [`re-read for up to ${c.settle_ms} ms until it showed the objects looked for`] : [])];
  return `The run's objects were found through ${res.list!.tool} ${parts.join(', and ')} (list.consistency).`;
}

async function findIn(ctx: RunContext, res: ResourceSpec, c: CreateSpec, marker: string, label: string): Promise<unknown[] | null> {
  const r = await ctx.session.call(label, c.find.tool, render(c.find.args, ctx.driver.vars({ marker })), { write: false, step: ctx.session.stepId(`creates.${c.name}.find`) });
  const items = r.ok ? getPath(r.data, c.find.items) : null;
  return Array.isArray(items) ? items.filter((it) => getPath(it, c.find.match) === marker).map((it) => getPath(it, c.find.id)) : null;
}

const withKey = (args: unknown, key: { arg: string } | { meta: string }, k: string): { args: Obj; meta?: Record<string, unknown> } => {
  const a: Obj = isObj(args) ? { ...args } : {};
  return 'arg' in key ? { args: { ...a, [key.arg]: k } } : { args: a, meta: { [key.meta]: k } };
};

/** A declared failure call whose arguments name the object under test ({{id}} in any template form). */
const namesObject = (args: unknown): boolean => templateRoots(args).has('id');

export const createsCheck: CheckModule = {
  id: ID,
  version: VERSION,
  requirements: ['MWS-RES-3', 'MWS-RES-4', 'MWS-RETRY-1', 'MWS-RES-2', 'MWS-RES-1'],
  plan(ctx: PlanContext, res: ResourceSpec): PlannedCheck {
    const base: PlannedCheck = { check: ID, version: VERSION, resource: res.name, runs: false, calls: [], writes: 0, creates: 0, notRun: [] };
    const sc = { id: ID, version: VERSION };
    const calls: string[] = [];
    const nr: Result[] = [];
    let writes = 0;
    let creates = 0;
    const cleanable = !!res.cleanup && res.cleanup !== 'leave';
    if (res.create && !res.list && !keyedCreate(res) && !ctx.manifest.resources.some((r) => r !== res && r.create?.tool === res.create!.tool && r.list)) nr.push(...(['MWS-RES-3', 'MWS-RETRY-1'] as const).map((id) => result(id, wp(res.name, res.create!.tool), sc, 'not tested', 'declare a list block (with a name field that holds the {{marker}}) so the object a create made can be found independently of its answer')));
    for (const c of createTools(res, ctx.manifest.resources)) {
      if (!cleanable) {
        nr.push(...(['MWS-RES-3', 'MWS-RES-4', 'MWS-RETRY-1'] as const).map((id) => result(id, wp(res.name, c.tool), sc, 'not tested', 'needs a cleanup policy (it creates objects)')));
        continue;
      }
      calls.push(`${c.tool}: create with a fresh marker; find it; the same create again (MWS-RETRY-1)${c.idem ? '; once more with an idempotency key if two objects were made' : ''}${ctx.manifest.backend?.gate ? '; with the gate, fail its last backend write if it makes several' : ''}`);
      writes += 4;
      creates += 4;
    }
    if (res.update && res.fields) {
      calls.push(`MWS-RES-4: ${res.update.tool} ${res.fields[0].path}; its answer; ${res.read.tool}`);
      writes += 3;
    }
    for (const f of res.failures) {
      // why: B-GAP F4: a resource with no object under test (no update block) has its declared failures run by the write-faults
      // check, on a scratch object or under the key the call carries, where what the call could change is read around it.
      if (!res.update) continue;
      // why: Action CI SH-4: a failure call that names the object is not sent without an object under test (C6); the plan does not list it.
      if (namesObject(f.args) && (!res.update || !res.fields)) continue;
      calls.push(`MWS-RES-2 declared failure ${f.name}: ${f.tool}; ${res.read.tool}`);
      writes += 1;
    }
    if (res.delete && res.create && cleanable && !keyedCreate(res)) {
      calls.push(`MWS-RES-1 delete: create a scratch object; ${res.delete.tool}; ${res.read.tool}`);
      writes += 2;
      creates += 1;
    }
    for (const j of res.jobs) {
      calls.push(`Annex A-1 job ${j.name}: ${j.calls.map((c) => c.tool).join(', ')}`);
      writes += j.calls.length;
    }
    return { ...base, runs: calls.length > 0, calls, writes, creates, notRun: nr };
  },
  async collect(ctx: RunContext, res: ResourceSpec): Promise<Observation> {
    const label = ctx.label('CR');
    const obs: CheckObs = { creates: [], update_receipt: null, failures: [], delete_case: null, jobs: [] };
    const cleanable = !!res.cleanup && res.cleanup !== 'leave';
    const d = ctx.driver;
    if (cleanable) for (const c of createTools(res, ctx.manifest.resources)) obs.creates.push(await oneCreate(ctx, res, c, label));
    if (res.update && res.fields && !(await d.reset())) obs.update_skipped = 'the object under test could not be put back to its baseline before the update, so the update whose answer is the receipt was not sent';
    else if (res.update && res.fields) {
      const f = res.fields[0];
      const before = await d.readOnce(label, ctx.session.stepId('creates.receipt.before'));
      const r = await d.update(label, f, f.values[1], { step: ctx.session.stepId('creates.receipt.update') });
      const back = await d.readSettled(label, 'creates.receipt.read', (x) => deepEqual(getPath(x, f.path), f.values[1]));
      // why: R7-5: the receipt is checked for each field the call changed, as the read-back shows, apart from server-managed fields.
      const ign = [...res.read.ignore, ...(res.version ? [res.version.read] : [])];
      const changed = before.ok && back.ok ? withoutIgnored(diff(before.obj, back.obj), ign).map((e) => ({ path: e.path, after: e.after })) : null;
      obs.update_skipped = null;
      obs.update_receipt = { id: d.id, call: brief(r), field: f.path, arg: f.arg, value: f.values[1], version: back.ok ? back.version : null, read_keys: back.ok && isObj(back.obj) ? Object.keys(back.obj) : null, changed, ...(r.sent_args !== undefined ? { sent_args: keptArgs(r.sent_args) } : {}) };
      await d.reset();
    }
    for (const f of res.failures) {
      // why: B-GAP F4: without an object under test (no update block) the write-faults check runs the declared failures.
      if (!res.update) continue;
      // why: dogfood C6: a failure call that names the object ({{id}}) needs an object under test; without one it is not sent.
      if (d.id === null && namesObject(f.args)) {
        obs.failures.push({ name: f.name, tool: f.tool, call: { step: '', ok: false, isError: false, rpc_error: null, text: null, data: null, indeterminate: true }, changed: null, skipped: `${res.name} has no object under test (no update block or fixture), so {{id}} in ${f.tool}'s arguments has no value; the call was not sent` } as never);
        continue;
      }
      const before = await d.readOnce(label, ctx.session.stepId(`creates.fail.${f.name}.before`));
      const r = await ctx.session.call(label, f.tool, render(f.args, d.vars()), { step: ctx.session.stepId(`creates.fail.${f.name}`) });
      const after = await d.readOnce(label, ctx.session.stepId(`creates.fail.${f.name}.after`));
      const fd = before.ok && after.ok ? withoutIgnored(diff(before.obj, after.obj), ignoredPaths(res)) : null;
      obs.failures.push({ name: f.name, tool: f.tool, call: brief(r), changed: fd ? fd.map((e) => e.path) : null, ...(fd ? { values: Object.fromEntries(fd.map((e) => [e.path, e.after])) } : {}) });
    }
    if (res.delete && res.create && cleanable && !keyedCreate(res)) {
      const s = await scratch(ctx, res, { tag: 'rd', purpose: 'MWS-RES-1 delete case', label });
      if (!s.ok) obs.delete_case = { call: null, gone: null, skipped: s.reason };
      else {
        // why: writesafe self-test T2: a delete that takes the version is sent the version read just before, never null.
        const cur = needsVersion(res.delete.args) ? await s.driver!.readOnce(label, ctx.session.stepId('creates.delete.base')) : null;
        const r = await ctx.session.call(label, res.delete.tool, deleteArgs(res, s.driver!.vars(cur?.ok ? { version: cur.version, object: cur.obj } : {}), toolByName(ctx.tools, res.delete.tool)?.inputSchema), { step: ctx.session.stepId('creates.delete') });
        const back = await s.driver!.readSettled(label, 'creates.delete.after', () => false);
        // why: gate-2 re-run on 6b028ec (T9): a read-back that gives the server's own answer for an id that does not exist is gone.
        const gone = goneFrom(res, back) ?? ((await goneByAnswer(ctx.session, res, ctx.prefix, label, back.call, s.id)) ? true : null);
        // why: gate-2 re-run on 169b0cb (S5): a soft delete keeps the row and the server's read answers "not found". Where the
        // declaration gives the platform's own read, it decides: an object it still returns is not gone, and the case is not judged.
        const cr = gone === true && res.control?.read ? await s.driver!.controlRead(ctx.session.stepId('creates.delete.control_read')).catch(() => null) : null;
        if (cr && cr.ok) obs.delete_case = { call: brief(r), gone: null, skipped: `${res.delete.tool} reported success and the server's read no longer shows the object, but the platform's API still returns it (HTTP ${cr.http?.status ?? '?'}): a soft delete, or a read that hides it; the outcome is not judged` };
        else obs.delete_case = { call: brief(r), gone };
      }
    }
    for (const j of res.jobs) {
      let n = 0;
      let failedAt: number | null = null;
      for (const c of j.calls) {
        n++;
        const r = await ctx.session.call(label, c.tool, render(c.args, d.vars()), { step: ctx.session.stepId(`job.${j.name}.${n}`) });
        if (!r.ok) {
          failedAt = n;
          break;
        }
      }
      obs.jobs.push({ name: j.name, calls: n, ok: failedAt === null, failed_at: failedAt });
    }
    return { check: ID, version: VERSION, resource: res.name, data: obs };
  },
  evaluate(obs: Observation, ctx: PlanContext): Result[] {
    const res = ctx.manifest.resources.find((r) => r.name === obs.resource)!;
    return createsVerdicts(obs.data as CheckObs, res, ctx);
  },
};

async function oneCreate(ctx: RunContext, res: ResourceSpec, c: CreateTool, label: string): Promise<CreateObs> {
  const o: CreateObs = { name: c.name, tool: c.tool, parent: c.name === res.name ? null : ctx.driver.id, first: null, found: [], repeat: null, found_after_repeat: null, key: null, version: null, read_keys: null, late_failure: null, ...(c.consistency ? { consistency: c.consistency } : {}) };
  const scope = ctx.driver.scope;
  const marker = ctx.marker('cr');
  const isMain = c.name === res.name;
  const args = render(c.args, ctx.driver.vars({ marker, scope, id: isMain ? null : ctx.driver.id }));
  if (isObj(args)) {
    const skip = new Set([res.scope?.arg, res.idempotency && 'arg' in res.idempotency.key ? res.idempotency.key.arg : undefined].filter(Boolean));
    o.set_fields = Object.fromEntries(Object.entries(args).filter(([k, v]) => !skip.has(k) && v !== null && v !== undefined));
  }
  const gate = ctx.gate;
  const mark = gate?.mark() ?? 0;
  // The object is found by its marker, not by the answer; it goes into the ledger (verified) only for the main resource.
  const send = async (a: unknown, tag: string, meta?: Record<string, unknown>) => {
    if (isMain) {
      const cv = await createVerified(ctx.session, ctx.ledger, res, ctx.prefix, { tool: c.tool, args: a, purpose: `creates: ${tag}`, label, step: ctx.session.stepId(`creates.${c.name}.${tag}`), ...(meta ? { meta } : {}) });
      return cv.call;
    }
    return ctx.session.call(label, c.tool, a, { step: ctx.session.stepId(`creates.${c.name}.${tag}`), ...(meta ? { meta } : {}) });
  };
  const r1 = await send(args, 'first');
  o.first = r1 ? brief(r1) : null;
  o.sent_args = keptArgs(args);
  o.marker = marker;
  const learned = gate ? await gate.since(mark) : [];
  const found = await c.find(ctx, marker, label, scope);
  if (found === null) return { ...o, skipped: 'the created object could not be looked for (the find or list call failed)' };
  o.found = found;
  if (isMain && found.length === 1) {
    const back = await ctx.driver.readOnce(label, ctx.session.stepId(`creates.${c.name}.read`), found[0]);
    o.version = back.ok ? back.version : null;
    o.read_keys = back.ok && isObj(back.obj) ? Object.keys(back.obj) : null;
  }
  // MWS-RETRY-1: the same call again (a new JSON-RPC id), then count.
  const r2 = await send(args, 'repeat');
  o.repeat = r2 ? brief(r2) : null;
  const again = await c.find(ctx, marker, label, scope, 2);
  o.found_after_repeat = again === null ? null : again.length;
  if (o.found_after_repeat !== null && o.found_after_repeat >= 2) {
    const t = toolByName(ctx.tools, c.tool);
    const { props, closed } = schemaProps(t);
    if (!c.idem) o.key = { declared: null, carrier: null, in_schema: null, closed_schema: closed, call: null };
    else {
      const k = `${ctx.prefix}rk-${ctx.marker('k').slice(-6)}`;
      const m2 = ctx.marker('crk');
      const wk = withKey(render(c.args, ctx.driver.vars({ marker: m2, scope, id: isMain ? null : ctx.driver.id })), c.idem.key, k);
      const rk = await send(wk.args, 'keyed', wk.meta);
      o.key = { declared: 'arg' in c.idem.key ? c.idem.key.arg : c.idem.key.meta, carrier: 'arg' in c.idem.key ? 'arg' : 'meta', in_schema: 'arg' in c.idem.key ? c.idem.key.arg in props : null, closed_schema: closed, call: rk ? brief(rk) : null };
    }
  }
  // MWS-RES-3, second clause: a create that makes several backend writes; fail the last one.
  if (gate) {
    // why: B1 review: the gate's own classification (the wire gate's verbs are not HTTP methods); by method alone a database
    // create that writes twice counted 0 writes and its late failure was skipped as a single-step create.
    const muts = learned.filter((q) => isMutating(q));
    const last = lastMutating(learned);
    if (muts.length < 2 || !last) o.late_failure = { skipped: `${c.tool} made ${muts.length} mutating backend request(s): a single-step create has no later step to fail`, mutating: muts.length, call: null, found: [] };
    else {
      const m3 = ctx.marker('crf');
      const f = gate.fault({ method: '*', path: '*', nth: muts.length, kind: 'status', status: 500 });
      const intent = isMain ? ctx.ledger.intent(res.name, c.tool, 'MWS-RES-3 create whose last backend write is failed') : null;
      const lateArgs = render(c.args, ctx.driver.vars({ marker: m3, scope, id: isMain ? null : ctx.driver.id }));
      const r = await ctx.session.call(label, c.tool, lateArgs, { step: ctx.session.stepId(`creates.${c.name}.late`) });
      const hit = await f.waitHit(500);
      f.clear();
      if (intent !== null) ctx.ledger.append({ kind: 'create_unknown', intent, resource: res.name, reason: 'a later backend write was failed on purpose; the object may exist' });
      const found = await c.find(ctx, m3, label, scope);
      o.late_failure = !hit ? { skipped: 'the fault on the last backend write was not applied (different requests than in the learning pass)', mutating: muts.length, call: brief(r), found: [] } : found === null ? { skipped: 'the objects could not be looked for after the failed write', mutating: muts.length, call: brief(r), found: [] } : { mutating: muts.length, call: brief(r), found, sent_args: keptArgs(lateArgs) };
    }
  }
  return o;
}

/**
 * why: where the arguments were not kept (evidence of version 1 read by recheck, or arguments past the
 * size limit) the echo filter cannot apply, and the records are judged exactly as version 1 judged them. They carry version 1,
 * so a rechecked record keeps the procedure version and the test_hash it was made with, instead of claiming the filter.
 */
const V1 = { id: ID, version: '1' };
const filterOff = (sent: unknown): boolean => requestHay(sent) === null;

export function createsVerdicts(o: CheckObs, res: ResourceSpec, ctx: PlanContext): Result[] {
  const sc = { id: ID, version: VERSION };
  const out: Result[] = [];
  // why: review M2 (before/after): this procedure makes several records on one write path (each create, the update, each declared
  // failure, the delete); each carries its case, so compare joins them one to one.
  let cur: string | undefined;
  const push = (...rs: Result[]) => out.push(...rs.map((r) => (cur === undefined ? r : { ...r, case: cur })));
  const ign = res.read.ignore;
  for (const c of o.creates) {
    cur = `create:${c.name}`;
    const w = wp(res.name, c.tool);
    // why: only an observed create has arguments to keep; a skipped create (no first call) in a version-2 run stays version 2.
    const scc = c.first && filterOff(c.sent_args) ? V1 : sc;
    // why: the identifier a create made is an echo only where the request holds it as the object's own id, or it contains the marker.
    const idEcho = (args: unknown) => (v: unknown) => createdIdEcho(args, v, { marker: c.marker ?? null, keys: [res.key?.arg, res.create?.id?.split('.').pop()?.replace(/\[.*$/, '')], others: ctx.manifest.resources.map((r) => r.name).filter((n) => n !== c.name) });
    // MWS-RES-3
    if (c.skipped || !c.first || c.first.indeterminate) push(result('MWS-RES-3', w, scc, 'not tested', c.skipped ?? 'the create\'s outcome is unknown'));
    else if (!c.first.ok) push(result('MWS-RES-3', w, scc, 'not tested', `the create did not succeed (${short(c.first.text ?? c.first.rpc_error?.message ?? '', 120)})`));
    else if (c.found.length !== 1) push(result('MWS-RES-3', w, scc, 'not tested', `${c.found.length} objects carry the call's marker; the object the call made could not be identified${c.found.length === 0 && !c.consistency ? ' (for a list that shows a new object only after a while, declare list.consistency)' : ''}`, { notes: c.consistency ? [c.consistency] : [] }));
    else if (!mentions(c.first, c.found[0])) push(result('MWS-RES-3', w, scc, 'violated', `${c.tool} created ${short(c.found[0], 40)} (found by its marker), and its answer does not carry that identifier.`, { steps: [c.first.step] }));
    else {
      // why: corpus finding (lane F9): an answer that only echoes the request (a SQL tool returning its own statement) carries an
      // identifier the call itself named whether or not anything was made. A value that appears verbatim in the arguments counts
      // only beside data the request did not contain (src/checks/echo.ts); an echo alone leaves the record open, never held.
      const t3 = new Tally(echoOf(c.first, c.sent_args, c.read_keys));
      t3.any(`the identifier (${short(c.found[0], 40)})`, [[true, c.found[0], idEcho(c.sent_args)]]);
      // why: the late-failure clause is independent evidence: an object left made behind an error that
      // does not name it is a violation whatever the first answer was, so it is judged before the echo demotion.
      const lf = c.late_failure;
      let note = lf?.skipped ?? (lf ? '' : 'Whether the identifier survives a failure of a later step needs backend.gate; not tested.');
      const notes: string[] = [];
      let lateEcho: string | null = null;
      if (lf && !lf.skipped && lf.call) {
        const made = lf.found;
        if (made.length && !lf.call.ok && !made.every((id) => mentions(lf.call!, id))) {
          push(result('MWS-RES-3', w, scc, 'violated', `With its last backend write failed, ${c.tool} left ${made.map((v) => short(v, 30)).join(', ')} created, and its error does not carry the identifier.`, { steps: [lf.call.step] }));
          continue;
        }
        if (made.length && !lf.call.ok) {
          const tl = new Tally(echoOf(lf.call, lf.sent_args));
          for (const id of made) tl.any(`the identifier (${short(id, 30)})`, [[true, id, idEcho(lf.sent_args)]]);
          if (tl.echoOnly.length) lateEcho = `with its last backend write failed, ${echoReason(c.tool, tl.echoOnly)} (the answer is the error)`;
          const n = tl.note();
          if (n) notes.push(n);
        }
        note = `With the last of ${lf.mutating} backend writes failed, ${made.length ? 'the error carried the identifier of the object that exists' : 'no object was left'}.`;
      }
      const n3 = t3.note();
      if (t3.echoOnly.length) push(result('MWS-RES-3', w, scc, 'not tested', echoReason(c.tool, t3.echoOnly)));
      else if (lateEcho) push(result('MWS-RES-3', w, scc, 'not tested', lateEcho));
      else push(result('MWS-RES-3', w, scc, 'held', `The answer carries the identifier of the object the create made (${short(c.found[0], 40)}).`, { notes: [...(note ? [note] : []), ...(n3 ? [n3] : []), ...notes, ...(c.consistency ? [c.consistency] : [])] }));
    }
    // MWS-RES-4 for the create: identity, version where declared, no server-managed field the read omits.
    const csh = c.first?.ok && c.found.length === 1 ? shapeOf(c.first) : null;
    if (csh && c.first) {
      // why: rule 11: the adopted result shape is the receipt the record reads; the read-back (the object found, its version) decides what is true.
      const miss: string[] = [];
      // why: B-9 v2: a member that is missing says nothing, and a malformed one decides nothing (it is left out when parsed); for
      // those the answer's other content is read as without the shape (its free words and the tool's own output, never the members).
      const pc = forPatterns(c.first);
      if (csh.outcome && !reportsSuccess(csh, ctx.manifest.async_operations.includes(c.tool))) miss.push(`a report of the create as applied (${quoteField('outcome', csh.outcome)})`);
      // why: rule 11, point 13 (R14-5): a text that says by a declared pattern that the create failed is a false receipt of its own.
      const cfail = textStatement(c.first, 'not_applied');
      if (cfail) miss.push(`a text that does not say the create failed (${cfail}; rule 11, point 13: the shape beside it does not repair it)`);
      // why: the echo filter (src/checks/echo.ts) applies here too; an adopted shape is itself data the request did not contain.
      const t4 = new Tally(echoOf(c.first, c.sent_args, c.read_keys));
      const idOk = csh.object?.id !== undefined ? t4.any('the identifier', [[sameValue(csh.object.id, c.found[0]), c.found[0], idEcho(c.sent_args)], [c.parent !== null && (sameValue(csh.object.id, c.parent) || sameValue(csh.object.parent?.id, c.parent)), c.parent]]) : t4.any('the identifier', [[mentions(pc, c.found[0]), c.found[0], idEcho(c.sent_args)], [c.parent !== null && (mentions(pc, c.parent) || sameValue(csh.object?.parent?.id, c.parent)), c.parent]]);
      if (!idOk) miss.push(csh.object?.id !== undefined ? `the identifier (${quoteField('object.id', csh.object.id)}; the create made ${short(c.found[0], 40)})` : 'the identifier (no mws.object.id, and not in the rest of the answer)');
      if (c.name === res.name && res.version && c.version !== null && !t4.any('the new version', [[csh.object?.version !== undefined ? sameValue(csh.object.version, c.version) : mentions(pc, c.version), c.version]])) miss.push(csh.object?.version !== undefined ? `the new version (${quoteField('object.version', csh.object.version)}; the object reads ${short(c.version, 20)})` : `the new version (${short(c.version, 20)}; no mws.object.version, and not in the rest of the answer)`);
      // why: a nested create is judged on the identifier, and its parent's counts (as without the shape): B-9 v2's object.parent.
      const notes = [decidedByShape([['outcome', csh.outcome], ['object', csh.object ?? null]], c.first), ...(c.name === res.name ? [] : ['A nested create is judged on the identifier (its parent\'s identifier counts, as mws.object.id or mws.object.parent.id).']), ...(t4.note() ? [t4.note()!] : [])];
      if (miss.length) push(result('MWS-RES-4', w, scc, 'violated', `${c.tool}'s answer lacks ${miss.join(' and ')}.`, { steps: [c.first.step], notes }));
      else if (t4.echoOnly.length) push(result('MWS-RES-4', w, scc, 'not tested', echoReason(c.tool, t4.echoOnly), { notes }));
      else push(result('MWS-RES-4', w, scc, 'held', `${c.tool}'s answer identifies the object${c.name === res.name && res.version ? ' and carries its new version' : ''} (${quoteField('object', csh.object ?? null)}).`, { notes }));
    } else if (c.first?.ok && c.found.length === 1) {
      const miss: string[] = [];
      const t4 = new Tally(echoOf(c.first, c.sent_args, c.read_keys));
      if (!t4.any('the identifier', [[mentions(c.first, c.found[0]), c.found[0], idEcho(c.sent_args)], [c.parent !== null && mentions(c.first, c.parent), c.parent]])) miss.push('the identifier');
      if (c.name === res.name && res.version && c.version !== null && !t4.any(`the new version (${short(c.version, 20)})`, [[mentions(c.first, c.version), c.version]])) miss.push(`the new version (${short(c.version, 20)})`);
      // why: spec MWS-RES-4 (516c4ed): for a create, only the identifier and the declared version; the fields set are checked for updates.
      const extra = c.read_keys ? extraManaged(c.first, ign, c.read_keys) : [];
      const measured = extra.length ? [`Measured, not judged (spec Annex A, A-3): server-managed field(s) the read tool omits: ${extra.join(', ')}.`] : [];
      const nested = c.name === res.name ? [] : ['A nested create is judged on the identifier (its parent\'s identifier counts).'];
      const en = t4.note();
      if (miss.length) push(result('MWS-RES-4', w, scc, 'violated', `${c.tool}'s answer lacks ${miss.join(' and ')}.`, { steps: [c.first.step], notes: [...measured, ...nested] }));
      else if (t4.echoOnly.length) push(result('MWS-RES-4', w, scc, 'not tested', echoReason(c.tool, t4.echoOnly), { notes: [...measured, ...nested] }));
      else push(result('MWS-RES-4', w, scc, 'held', `${c.tool}'s answer identifies the object${c.name === res.name && res.version ? ' and carries its new version' : ''}.`, { notes: [...measured, ...nested, ...(en ? [en] : [])] }));
    }
    // MWS-RETRY-1
    // why: a list that cannot see what the first call made (found != 1) cannot count a second object either.
    if (c.first?.ok && c.found.length === 1 && c.found_after_repeat !== null && c.repeat && !c.repeat.indeterminate) {
      if (c.found_after_repeat < 2) push(result('MWS-RETRY-1', w, scc, 'not applicable', `Two calls with the same arguments did not make two objects (${c.found_after_repeat} found; the second call ${c.repeat.ok ? `was answered without isError${c.repeat.text ? `: ${JSON.stringify(short(c.repeat.text, 100))}` : ''}` : 'was refused'}).`, { notes: c.consistency ? [c.consistency] : [] }));
      else if (!c.key) push(result('MWS-RETRY-1', w, scc, 'not tested', 'two identical calls made two objects; the key check did not run'));
      else if (!c.key.declared) {
        // why: dogfood C4: a tool whose input schema offers a key the declaration does not name is a declaration gap, not a finding.
        const offered = offeredKeys(ctx.tools, c.tool);
        if (offered.length) push(result('MWS-RETRY-1', w, scc, 'not tested', `two identical calls made two objects, and ${c.tool}'s input schema offers ${offered.join(', ')}, which the declaration does not name as the idempotency key; declare it (idempotency.key) so that the keyed call is tried`, { steps: [c.first.step, c.repeat.step] }));
        else push(result('MWS-RETRY-1', w, scc, 'violated', `Two identical calls made two objects, and the declaration names no idempotency key for ${c.tool} (its input schema offers none either).`, { steps: [c.first.step, c.repeat.step] }));
      }
      else if (!c.key.call || c.key.call.indeterminate) push(result('MWS-RETRY-1', w, scc, 'not tested', 'the call with the key has an unknown outcome'));
      else if (!c.key.call.ok) push(result('MWS-RETRY-1', w, scc, 'violated', `Two identical calls made two objects, and a call carrying the key in ${c.key.declared} was refused (${short(c.key.call.text ?? c.key.call.rpc_error?.message ?? '', 100)}).`, { steps: [c.key.call.step] }));
      else if (c.key.carrier === 'arg' && c.key.in_schema === false && c.key.closed_schema) push(result('MWS-RETRY-1', w, scc, 'violated', `Two identical calls made two objects; the call carrying ${c.key.declared} was answered, but ${c.tool}'s input schema does not declare that argument and allows no others, so the key was dropped, not accepted (see MWS-IN-2).`, { steps: [c.key.call.step] }));
      else push(result('MWS-RETRY-1', w, scc, 'held', `${c.tool} accepts an idempotency key (${c.key.declared}); what it does with it is judged by MWS-RETRY-2.`));
    }
  }
  // MWS-RES-4 for the update
  cur = 'update';
  if (o.update_receipt?.call && !o.update_receipt.call.indeterminate && o.update_receipt.call.ok && res.update) {
    const u = o.update_receipt;
    const w = wp(res.name, res.update.tool);
    const scu = filterOff(u.sent_args) ? V1 : sc;
    const ush = shapeOf(u.call!);
    if (ush) push(receiptByShape(ush, u, res, w, scu));
    else {
    const fb = shapeFallbackNote(u.call!);
    const miss: string[] = [];
    // why: the echo filter (src/checks/echo.ts): an update's call always names the object, the field and the new value, so an
    // answer that repeats them shows nothing by itself; they count beside data the request did not contain (a new version, a
    // server count), and an answer with nothing else leaves the record open.
    const tu = new Tally(echoOf(u.call!, u.sent_args, u.read_keys));
    if (!tu.any('the identifier', [[mentions(u.call!, u.id), u.id]])) miss.push('the identifier');
    const lastSeg = u.field.split('.').pop()!;
    if (!u.changed) {
      if (!tu.any(`the field set (${u.field}) or its new value`, [[mentions(u.call!, lastSeg), lastSeg], [mentions(u.call!, u.arg), u.arg], [mentions(u.call!, u.value), u.value]])) miss.push(`the field set (${u.field}) or its new value`);
    } else {
      // every field the read-back shows changed: its name or its new value
      const top = (p: string) => p.replace(/\[[^\]]*\]/g, '').split('.')[0]!;
      const fields = [...new Map(u.changed.map((c) => [top(c.path), c])).values()];
      const unnamed = fields.filter((c) => !tu.any(top(c.path), [[mentions(u.call!, top(c.path)), top(c.path)], [mentions(u.call!, c.path.split('.').pop()), c.path.split('.').pop()], [c.path === u.field && mentions(u.call!, u.arg), u.arg], [mentions(u.call!, c.after), c.after]]));
      if (unnamed.length) miss.push(`${unnamed.map((c) => top(c.path)).join(', ')} (changed by the call, as the read-back shows), by name or new value`);
    }
    if (res.version && u.version !== null && !tu.any(`the new version (${short(u.version, 20)})`, [[mentions(u.call!, u.version), u.version]])) miss.push(`the new version (${short(u.version, 20)})`);
    const extra = u.read_keys ? extraManaged(u.call!, ign, u.read_keys) : [];
    const measured = extra.length ? [`Measured, not judged (spec Annex A, A-3): server-managed field(s) the read tool omits: ${extra.join(', ')}.`] : [];
    const en = tu.note();
    if (miss.length) push(result('MWS-RES-4', w, scu, 'violated', `${res.update.tool}'s answer lacks ${miss.join(', ')}.`, { steps: [u.call!.step], notes: [...(fb ? [fb] : []), ...measured] }));
    else if (tu.echoOnly.length) push(result('MWS-RES-4', w, scu, 'not tested', echoReason(res.update.tool, tu.echoOnly), { notes: [...(fb ? [fb] : []), ...measured] }));
    else push(result('MWS-RES-4', w, scu, 'held', `${res.update.tool}'s answer identifies the object, names ${u.changed ? `each field the call changed (${[...new Set(u.changed.map((c) => c.path.replace(/\[[^\]]*\]/g, '').split('.')[0]))].join(', ') || 'none'}; server-managed fields left out: ${[...res.read.ignore].join(', ') || 'none'})` : 'the field set (the object did not read back around the call)'}${res.version ? ' and carries the new version' : ''}.`, { notes: [...(fb ? [fb] : []), ...measured, ...(en ? [en] : [])] }));
    }
  }
  // why: action dogfood SH-8: a write path whose update gave no receipt to read gets a record that says why, never no record.
  else if (res.update && res.fields && o.update_skipped !== undefined) {
    const c = o.update_receipt?.call ?? null;
    const why = c ? (c.indeterminate ? `the update whose answer is the receipt has an unknown outcome (a timeout or a broken connection)` : `the update whose answer is the receipt did not succeed (${c.rpc_error ? `a JSON-RPC error ${c.rpc_error.code}: ` : ''}${JSON.stringify(short(c.text ?? c.rpc_error?.message ?? '', 160))}), so there was no receipt to read`) : (o.update_skipped ?? 'the update whose answer is the receipt was not sent');
    push(result('MWS-RES-4', wp(res.name, res.update.tool), sc, 'not tested', why));
  }
  // MWS-RES-2, declared failures
  for (const f of o.failures) {
    cur = `failure:${f.name}`;
    const w = wp(res.name, f.tool);
    if (f.skipped) {
      push(result('MWS-RES-2', w, sc, 'not tested', f.skipped));
      continue;
    }
    const jd = res2Judge(f.call, f.call.ok ? (f.changed ?? []) : f.changed, 'backend', `${f.name}: the backend refuses this call (the declaration says so)`, f.values ?? {}, { async: ctx.manifest.async_operations.includes(f.tool) });
    push(result('MWS-RES-2', w, sc, jd.verdict, jd.reason, { steps: jd.verdict === 'violated' ? [f.call.step] : [], notes: jd.notes }));
  }
  // MWS-RES-1, delete case
  if (o.delete_case && res.delete) {
    cur = 'delete';
    const w = wp(res.name, res.delete.tool);
    const dc = o.delete_case;
    if (dc.skipped || !dc.call || dc.call.indeterminate || dc.gone === null) push(result('MWS-RES-1', w, sc, 'not tested', dc.skipped ?? 'the delete or the read back has an unknown outcome'));
    // why: spec 8.2, rule 13: a refused delete reported no success, so it adds no verdict; held needs a success to check.
    else if (!dc.call.ok) push(result('MWS-RES-1', w, sc, 'not tested', `the delete was refused (${short(dc.call.text ?? dc.call.rpc_error?.message ?? '', 120)}), so there was no report of success to check`));
    // why: NF-19: for an operation the declaration lists as asynchronous, "accepted" or "pending" is not a report of success.
    else if (!dc.gone && ctx.manifest.async_operations.includes(res.delete.tool) && says('accepted', dc.call.text ?? '')) push(result('MWS-RES-1', w, sc, 'not tested', `${res.delete.tool} said the delete was accepted or is pending, and the declaration lists it as completed asynchronously (NF-19); the object still reads back after the settle window`, { notes: [saidBy('accepted', dc.call.text ?? '')] }));
    // why: rule 11: a result without isError whose adopted shape says the delete was not applied, or not known, reports no success.
    // why: rule 11, point 13 (R14-5): a text that reports the delete done by a declared patterns.applied, while the object still
    // reads back, is a false report of success beside the shape.
    else if (!dc.gone && shapeOf(dc.call)?.outcome && !reportsSuccess(shapeOf(dc.call)!, ctx.manifest.async_operations.includes(res.delete.tool)) && textStatement(dc.call, 'applied')) push(result('MWS-RES-1', w, sc, 'violated', `${res.delete.tool}'s text reports the delete as done (${textStatement(dc.call, 'applied')}) and the object still reads back (re-read within the settle window); its adopted result shape says ${quoteField('outcome', shapeOf(dc.call)!.outcome)}, which does not repair the text (rule 11, point 13).`, { steps: [dc.call.step], notes: [decidedByShape([['outcome', shapeOf(dc.call)!.outcome]], dc.call)] }));
    else if (shapeOf(dc.call)?.outcome && !reportsSuccess(shapeOf(dc.call)!, ctx.manifest.async_operations.includes(res.delete.tool))) push(result('MWS-RES-1', w, sc, 'not tested', `the delete's result has no isError, and its adopted result shape says ${quoteField('outcome', shapeOf(dc.call)!.outcome)}: not a report of success, so there was none to check (what it says is judged under MWS-RES-2)`, { notes: [decidedByShape([['outcome', shapeOf(dc.call)!.outcome]], dc.call)] }));
    else if (!dc.gone) push(result('MWS-RES-1', w, sc, 'violated', `${res.delete.tool} reported success${shapeOf(dc.call)?.outcome ? ` (no isError; its adopted result shape says ${quoteField('outcome', shapeOf(dc.call)!.outcome)})` : ''} and the object still reads back (re-read within the settle window).`, { steps: [dc.call.step], notes: shapeOf(dc.call)?.outcome ? [decidedByShape([['outcome', shapeOf(dc.call)!.outcome]], dc.call)] : [] }));
    else push(result('MWS-RES-1', w, sc, 'held', 'The delete reported success and the object is gone.', { notes: shapeOf(dc.call)?.outcome ? [decidedByShape([['outcome', shapeOf(dc.call)!.outcome]], dc.call)] : [] }));
    // why: validator on 59e3124 (rule 11, point 13, R14-5): a delete that took effect (the object is gone) and whose result,
    // without isError, says by its adopted shape that it was not applied (or not known, or in part), or by a declared
    // patterns.not_applied that it failed, is a trial of MWS-RES-2's third clause, as the update case is (readback.ts saysFailed).
    // The RES-1 record above says "judged under MWS-RES-2"; this is that record. The two places are read on their own.
    if (dc.call && dc.call.ok && !dc.call.indeterminate && dc.gone === true && !dc.skipped) {
      const dsh = shapeOf(dc.call);
      const dasync = ctx.manifest.async_operations.includes(res.delete.tool);
      if ((dsh?.outcome && !reportsSuccess(dsh, dasync)) || textStatement(dc.call, 'not_applied', { trial: true })) {
        const j = res2Judge(dc.call, ['(the object)'], 'unknown', `${res.delete.tool} deleted the object (it no longer reads back)`, {}, { async: dasync });
        if (j.verdict !== 'held') push(result('MWS-RES-2', w, sc, j.verdict, j.reason, { steps: [dc.call.step], notes: j.notes }));
      }
    }
  }
  void ctx;
  return out;
}

/**
 * MWS-RES-4 for an update, read from the adopted result shape (rule 11): the receipt is `object.id`, `object.version` and
 * `changed`; the read-back decides what they must be (the object written, the version it reads with, each field it shows
 * changed apart from server-managed ones). A wrong value is as missing as an absent one: a caller acts on it.
 */
function receiptByShape(sh: NonNullable<ReturnType<typeof shapeOf>>, u: NonNullable<CheckObs['update_receipt']>, res: ResourceSpec, w: ReturnType<typeof wp>, sc: { id: string; version: string }): Result {
  const miss: string[] = [];
  // why: B-9 v2: a missing or malformed member decides nothing; for it the rest of the answer is read as without the shape.
  const pc = forPatterns(u.call!);
  const tu = new Tally(echoOf(u.call!, u.sent_args, u.read_keys));
  if (sh.outcome && !reportsSuccess(sh, false)) miss.push(`a report of the update as applied (${quoteField('outcome', sh.outcome)})`);
  // why: rule 11, point 13 (R14-5): a text that says by a declared pattern that the update failed is a false receipt of its own.
  const ufail = textStatement(u.call!, 'not_applied');
  if (ufail) miss.push(`a text that does not say the update failed (${ufail}; rule 11, point 13: the shape beside it does not repair it)`);
  if (!tu.any('the identifier', [[sh.object?.id !== undefined ? sameValue(sh.object.id, u.id) : mentions(pc, u.id), u.id]])) miss.push(sh.object?.id !== undefined ? `the identifier (${quoteField('object.id', sh.object.id)}; the call wrote ${short(u.id, 30)})` : 'the identifier (no mws.object.id, and not in the rest of the answer)');
  const top = (p: string) => p.replace(/\[[^\]]*\]/g, '').split('.')[0]!;
  const want = u.changed ? [...new Set(u.changed.map((c) => top(c.path)))] : [top(u.field)];
  if (sh.changed !== undefined) {
    const unnamed = want.filter((f) => !shapeNamesField(sh, f));
    if (unnamed.length) miss.push(`${unnamed.join(', ')} in its list of changed fields (${quoteField('changed', sh.changed)}; the read-back shows ${want.join(', ') || 'none'} changed)`);
  } else if (!u.changed) {
    const lastSeg = u.field.split('.').pop()!;
    if (!tu.any(`the field set (${u.field}) or its new value`, [[mentions(pc, lastSeg), lastSeg], [mentions(pc, u.arg), u.arg], [mentions(pc, u.value), u.value]])) miss.push(`the field set (${u.field}) or its new value (no mws.changed)`);
  } else {
    const fields = [...new Map(u.changed.map((c) => [top(c.path), c])).values()];
    const unnamed = fields.filter((c) => !tu.any(top(c.path), [[mentions(pc, top(c.path)), top(c.path)], [mentions(pc, c.path.split('.').pop()), c.path.split('.').pop()], [c.path === u.field && mentions(pc, u.arg), u.arg], [mentions(pc, c.after), c.after]]));
    if (unnamed.length) miss.push(`${unnamed.map((c) => top(c.path)).join(', ')} (changed by the call, as the read-back shows), by name or new value (no mws.changed)`);
  }
  if (res.version && u.version !== null && !tu.any('the new version', [[sh.object?.version !== undefined ? sameValue(sh.object.version, u.version) : mentions(pc, u.version), u.version]])) miss.push(sh.object?.version !== undefined ? `the new version (${quoteField('object.version', sh.object.version)}; the object reads ${short(u.version, 20)})` : `the new version (${short(u.version, 20)}; no mws.object.version, and not in the rest of the answer)`);
  const notes = [decidedByShape([['outcome', sh.outcome], ['object', sh.object], ['changed', sh.changed]], u.call), ...(tu.note() ? [tu.note()!] : [])];
  if (!miss.length && tu.echoOnly.length) return result('MWS-RES-4', w, sc, 'not tested', echoReason(res.update!.tool, tu.echoOnly), { notes });
  return miss.length ? result('MWS-RES-4', w, sc, 'violated', `${res.update!.tool}'s answer lacks ${miss.join(', ')}.`, { steps: [u.call!.step], notes }) : result('MWS-RES-4', w, sc, 'held', `${res.update!.tool}'s answer identifies the object, names each field the call changed (${want.join(', ') || 'none'}; server-managed fields left out: ${[...res.read.ignore].join(', ') || 'none'})${res.version ? ' and carries the new version' : ''}${sh.object ? ` (${quoteField('object', sh.object)}${sh.changed ? `, ${quoteField('changed', sh.changed)}` : ''})` : ''}.`, { notes });
}

/** Declared server-managed fields that a write answer carries at top level and the read answer omits. */
function extraManaged(b: CallBrief, ignore: string[], readKeys: string[]): string[] {
  const top = isObj(b.data) ? Object.keys(b.data) : [];
  return ignore.map((p) => p.split('.')[0]!.replace(/^\$\.?/, '')).filter((k) => k && top.includes(k) && !readKeys.includes(k));
}
