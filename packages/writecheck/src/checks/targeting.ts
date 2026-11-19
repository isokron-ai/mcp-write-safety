/**
 * Targeting: the write lands on what the caller named, and nowhere else.
 *
 *   MWS-TGT-1  with two scopes the tester created (neither the server's default), create through
 *              the tool naming the first; look in the first, the second and the default scope
 *   MWS-TGT-2  only inside a container the tester created and confirmed holds nothing but its own
 *              objects: three objects, then the bulk or delete tool with each declared selector
 *              form (empty, omitted, match-all) and no opt-in argument; count what remains
 *   MWS-TGT-3  create an object with a caller-chosen key; create again with the same key and a
 *              different value for a non-key field (or change a field first, when an update tool
 *              is declared), default arguments; read back: was the existing object overwritten?
 *
 * Without a container the tester owns, MWS-TGT-2 is not run (spec 9.3). Objects for the container
 * are created through the platform's API when control.create is declared, so their setup does not
 * depend on the tool under test.
 */

import { baseVars, Driver } from '../core/driver.js';
import type { ResourceSpec } from '../core/manifest.js';
import { createVerified, idFromResult } from '../core/objects.js';
import { render } from '../core/template.js';
import { deepEqual, getPath, short } from '../core/util.js';
import { result, type Result } from '../report/verdicts.js';
import { anyLoss, BYSTANDER_NOTE, compare, coverageText, inventory, lossText, noLoss, withEarlier, type Loss } from './bystanders.js';
import { listScope, newScope, scratch } from './scratch.js';
import { brief, wp, type CallBrief, type CheckModule, type Observation, type PlanContext, type PlannedCheck, type RunContext } from './types.js';

const ID = 'targeting';
const VERSION = '1';

/**
 * The deleting tools for which MWS-TGT-1 was run in this run with the verdict held, and the call shown to act in the named
 * scope only, with no object outside the tester's own lost (spec 7.3, rule 1). Keyed by the run's session, so it lives as long
 * as the run; a later check (the multi-item delete) reads it before it calls a tool that takes the scope argument.
 */
const scopedTools = new WeakMap<object, Set<string>>();
export const tgt1HeldFor = (ctx: Pick<RunContext, 'session'>, tool: string): boolean => scopedTools.get(ctx.session)?.has(tool) ?? false;
const markTgt1Held = (ctx: Pick<RunContext, 'session'>, tool: string): void => {
  const set = scopedTools.get(ctx.session) ?? new Set<string>();
  set.add(tool);
  scopedTools.set(ctx.session, set);
};

interface Tgt1Obs {
  skipped?: string;
  /** Objects outside the tester's own lost around the create (the bystander inventory). */
  loss?: Loss;
  scopes: { named: unknown; other: unknown; default: unknown };
  call: CallBrief | null;
  id: unknown;
  found_in: string[];
}
/** MWS-TGT-1 on the selector tool: an object of one name in each scope, then the tool naming the first scope, narrowed to that name. */
interface Tgt1SelObs {
  skipped?: string;
  loss?: Loss;
  /** Objects outside the tester's own lost or changed while the fixtures were created (before the call). */
  fixture_loss?: Loss;
  scopes: { named: unknown; other: unknown; default: unknown };
  call: CallBrief | null;
  before: Record<string, number>;
  after: Record<string, number | null>;
}
interface Tgt2Obs {
  skipped?: string;
  fixture_loss?: Loss;
  container: unknown;
  before: number;
  forms: { name: string; call: CallBrief; remaining: number | null; loss?: Loss }[];
}
interface Tgt3Obs {
  skipped?: string;
  /** R10-1: the class the declaration put the tool in, with the words relied on. */
  class_note?: string;
  loss?: Loss;
  key: unknown;
  first: CallBrief | null;
  second: CallBrief | null;
  how: string;
  before: unknown;
  after: unknown;
  path: string | null;
}
interface TargetObs {
  tgt1: Tgt1Obs | null;
  tgt1sel?: Tgt1SelObs | null;
  tgt2: Tgt2Obs | null;
  tgt3: Tgt3Obs | null;
}

export const targetingCheck: CheckModule = {
  id: ID,
  version: VERSION,
  requirements: ['MWS-TGT-1', 'MWS-TGT-2', 'MWS-TGT-3'],
  plan(ctx: PlanContext, res: ResourceSpec): PlannedCheck {
    const base: PlannedCheck = { check: ID, version: VERSION, resource: res.name, runs: false, calls: [], writes: 0, creates: 0, notRun: [] };
    const sc = { id: ID, version: VERSION };
    const calls: string[] = [];
    const nr: Result[] = [];
    let writes = 0;
    let creates = 0;
    const cleanable = !!res.cleanup && res.cleanup !== 'leave';
    if (res.scope && res.create) {
      if (!cleanable) nr.push(result('MWS-TGT-1', wp(res.name, res.create.tool), sc, 'not tested', 'needs a cleanup policy (it creates scopes and an object)'));
      else {
        calls.push(`MWS-TGT-1: create two scopes; ${res.create.tool} naming the first; list the first, the second${res.scope.default ? ` and the default (${res.scope.default})` : ''} scope`);
        writes += 3;
        creates += 3;
      }
    }
    // why: R7-5: for a tool that updates or deletes and takes a scope argument, MWS-TGT-1 first creates an object of the same
    // name in each scope; the selector tool gets its own MWS-TGT-1 record from the selector test (run with selector.narrow and
    // send_empty_forms, else not tested with the reason); each other such tool gets a row saying it is not built in this preview.
    if (res.scope) {
      const scoped = [res.update, res.delete, res.selector, ...res.multi].filter((t): t is NonNullable<typeof t> => !!t && Object.hasOwn((t.args ?? {}) as object, res.scope!.arg));
      for (const t of [...new Map(scoped.map((x) => [x.tool, x])).values()]) if (t.tool !== res.create?.tool && !(cleanable && res.selector && t.tool === res.selector.tool)) nr.push(result('MWS-TGT-1', wp(res.name, t.tool), sc, 'not tested', `${t.tool} updates or deletes and takes the scope argument ${res.scope.arg}: the test with an object of the same name in each scope (spec R7-5) is not built in this preview`));
    }
    if (res.selector) {
      if (!res.scope) nr.push(result('MWS-TGT-2', wp(res.name, res.selector.tool), sc, 'not tested', 'there is no container the tester can create (declare scope), and this test must not run outside one'));
      else if (!cleanable) nr.push(result('MWS-TGT-2', wp(res.name, res.selector.tool), sc, 'not tested', 'needs a cleanup policy (it creates a container and objects)'));
      else {
        if (res.selector.narrow) calls.push(`MWS-TGT-1 for ${res.selector.tool}: create two scopes; one object of one name in each scope${res.scope.default ? ' and in the default scope' : ''}; ${res.selector.tool} naming the first scope, narrowed to that name; list each scope`);
        calls.push(`MWS-TGT-2 (only where MWS-TGT-1 is held for ${res.selector.tool}): create a container; confirm it is empty; create 3 objects in it${res.control?.create ? ' through the platform\'s API' : ''}; ${res.selector.tool} with ${res.selector.forms.map((f) => f.name).join(', ')} (no opt-in); count after each`);
        writes += 4 + res.selector.forms.length;
        creates += 4;
      }
    }
    // why: spec 96d3691 (R10-1): a tool that does not call itself a create, upsert or apply (run, start, deploy, install, clone)
    // is tested as a create only where the declaration puts it among the creates and quotes the words of its name or description.
    const cls = res.key ? tgt3Class(res, ctx.tools) : null;
    if (res.key && cls && cls.verdict) nr.push(result('MWS-TGT-3', wp(res.name, res.create!.tool), sc, cls.verdict, cls.why));
    else if (res.key) {
      if (!cleanable) nr.push(result('MWS-TGT-3', wp(res.name, res.create!.tool), sc, 'not tested', 'needs a cleanup policy (it creates an object)'));
      else if (!res.key.vary && !res.update) nr.push(result('MWS-TGT-3', wp(res.name, res.create!.tool), sc, 'not tested', 'declare key.vary (a non-key argument a second create changes) or an update tool, so that an overwrite can be seen'));
      else {
        calls.push(`MWS-TGT-3: ${res.create!.tool} with a new key; ${res.key.vary ? `${res.create!.tool} again with the same key and a different ${res.key.vary.arg}` : `change a field; ${res.create!.tool} again with the same key`}; ${res.read.tool}`);
        writes += 3;
        creates += 2;
      }
    }
    return { ...base, runs: calls.length > 0, calls, writes, creates, notRun: nr };
  },
  async collect(ctx: RunContext, res: ResourceSpec): Promise<Observation> {
    const obs: TargetObs = { tgt1: null, tgt1sel: null, tgt2: null, tgt3: null };
    const label = ctx.label('TGT');
    const cleanable = !!res.cleanup && res.cleanup !== 'leave';
    if (res.scope && res.create && cleanable) obs.tgt1 = await tgt1(ctx, res, label);
    // why: spec 7.3, rule 1: where the container is named to the selector tool by a scope argument, the selector forms are sent only
    // where MWS-TGT-1 has been run for that tool (the tool that deletes, not the create tool) with the verdict held. MWS-TGT-1 on
    // the create tool held is a further precondition before any call to the selector tool, so a tool family that ignores the
    // scope is caught on a create first.
    const t1 = obs.tgt1;
    // why: gate-2 re-run on 6b028ec (T12, k3): a loss around the MWS-TGT-1 create is not held either, so it gates the selector tool too.
    const createScoped = !!t1 && !t1.skipped && !!t1.call?.ok && t1.found_in.length === 1 && t1.found_in[0] === 'named' && !anyLoss(t1.loss);
    if (res.selector && res.scope && cleanable) {
      const noSel = (why: string) => ({ skipped: why, scopes: { named: null, other: null, default: res.scope!.default }, call: null, before: {}, after: {} });
      // why: gate-2 re-run on 169b0cb (S1, S2): no order of black-box calls makes the empty-selector forms safe, and the narrowed
      // MWS-TGT-1 call is itself a bulk delete; both are sent only where the declaration opts in for a backend whose every object
      // is disposable.
      if (!res.selector.send_empty_forms) obs.tgt1sel = noSel(`the selector forms of MWS-TGT-2, and the MWS-TGT-1 call that gates them, are destructive by design: a server that ignores the scope or the selector deletes objects the tester did not create. They are sent only with selector.send_empty_forms: true, on a backend where every object is disposable`);
      else if (!res.selector.narrow) obs.tgt1sel = noSel(`MWS-TGT-1 is not run for ${res.selector.tool}: declare selector.narrow (arguments that limit the call to the objects named with {{marker}})`);
      else if (!createScoped) obs.tgt1sel = noSel(`MWS-TGT-1 is not held for ${res.create?.tool ?? 'the create tool'} in this run${t1 && anyLoss(t1.loss) ? ' (objects the tester did not create were lost or changed around it)' : ''}, so ${res.selector.tool} is not called (spec 7.3, rule 1)`);
      else obs.tgt1sel = await tgt1Selector(ctx, res, label);
      const ts = obs.tgt1sel;
      const selScoped = !ts.skipped && !!ts.call?.ok && !ts.call.indeterminate && (ts.after['named'] ?? 1) < (ts.before['named'] ?? 0) && Object.entries(ts.after).every(([k, v]) => k === 'named' || (v !== null && v === ts.before[k]));
      if (selScoped && noLoss(ts.loss)) markTgt1Held(ctx, res.selector.tool);
      if (!res.selector.send_empty_forms) obs.tgt2 = { skipped: ts.skipped!, container: null, before: 0, forms: [] } as unknown as Tgt2Obs;
      else obs.tgt2 = selScoped && noLoss(ts.loss) ? await tgt2(ctx, res, label) : ({ skipped: `MWS-TGT-1 has not been run for ${res.selector.tool} with the verdict held in this run${ts.skipped ? ` (${ts.skipped})` : ''}, so the selector forms are not sent (spec 7.3, rule 1: the container is named to the tool by a scope argument)`, container: null, before: 0, forms: [] } as unknown as Tgt2Obs);
    }
    const t3c = res.key ? tgt3Class(res, ctx.tools) : null;
    if (res.key && cleanable && (res.key.vary || res.update) && !t3c?.verdict) {
      obs.tgt3 = await tgt3(ctx, res, label);
      if (t3c?.note) obs.tgt3.class_note = t3c.note;
    }
    return { check: ID, version: VERSION, resource: res.name, data: obs };
  },
  evaluate(obs: Observation, ctx: PlanContext): Result[] {
    const res = ctx.manifest.resources.find((r) => r.name === obs.resource)!;
    return targetingVerdicts(obs.data as TargetObs, res);
  },
};

async function tgt1(ctx: RunContext, res: ResourceSpec, label: string): Promise<Tgt1Obs> {
  const o: Tgt1Obs = { scopes: { named: null, other: null, default: res.scope!.default }, call: null, id: null, found_in: [] };
  const a = await newScope(ctx, res, 'ta', label);
  const b = await newScope(ctx, res, 'tb', label);
  if (!a.ok || !b.ok) return { ...o, skipped: `a scope could not be created: ${a.reason || b.reason}` };
  o.scopes.named = a.key;
  o.scopes.other = b.key;
  const marker = ctx.marker('t1');
  const step = ctx.session.stepId('tgt1.create');
  const inv0 = await inventory(ctx, res, label);
  const c = await createVerified(ctx.session, ctx.ledger, res, ctx.prefix, { tool: res.create!.tool, args: render(res.create!.args, baseVars(res, ctx.prefix, { scope: a.key, marker })), purpose: 'MWS-TGT-1 create naming a scope', label, step });
  o.call = c.call ? brief(c.call) : null;
  o.id = c.id;
  o.loss = await compare(ctx, res, label, inv0, await inventory(ctx, res, label));
  const where: [string, unknown][] = [['named', a.key], ['other', b.key], ...(res.scope!.default ? ([['default', res.scope!.default]] as [string, unknown][]) : [])];
  for (const [name, scope] of where) {
    const items = await listScope(ctx, res, scope, label, { marker });
    if (items === null) return { ...o, skipped: `the ${name} scope could not be listed, so where the write took effect is not known` };
    // why: ids can be numbered per scope; outside the named scope only the call's own marker identifies the object.
    if (items.some((it) => String(it.name ?? '').includes(marker) || (name === 'named' && c.id !== null && deepEqual(it.id, c.id)))) o.found_in.push(name);
  }
  return o;
}

async function tgt1Selector(ctx: RunContext, res: ResourceSpec, label: string): Promise<Tgt1SelObs> {
  const sel = res.selector!;
  const o: Tgt1SelObs = { scopes: { named: null, other: null, default: res.scope!.default }, call: null, before: {}, after: {} };
  // why: gate-2 re-run on 6b028ec (note 14 item 5, k2): a fixture create can remove a bystander; the inventory is taken before
  // the fixtures too, and a loss there stops the test before the selector tool is called.
  const invF = await inventory(ctx, res, label);
  if (invF.unavailable) return { ...o, skipped: `the objects outside the tester's own could not be listed (${invF.unavailable}), so a loss could not be seen; ${sel.tool} is not called` };
  const a = await newScope(ctx, res, 'sa', label);
  const b = await newScope(ctx, res, 'sb', label);
  if (!a.ok || !b.ok) return { ...o, skipped: `a scope could not be created: ${a.reason || b.reason}` };
  o.scopes.named = a.key;
  o.scopes.other = b.key;
  const marker = ctx.marker('t1s');
  const where: [string, unknown][] = [['named', a.key], ['other', b.key], ...(res.scope!.default ? ([['default', res.scope!.default]] as [string, unknown][]) : [])];
  const count = async (scope: unknown) => {
    const items = await listScope(ctx, res, scope, label, { marker });
    return items === null ? null : items.filter((it) => String(it.name ?? '').includes(marker)).length;
  };
  for (const [name, scope] of where) {
    const s = await scratch(ctx, res, { tag: 't1s', marker, purpose: `MWS-TGT-1 for ${sel.tool}: object of one name in the ${name} scope`, label, scope });
    if (!s.ok) return { ...o, skipped: `the object in the ${name} scope could not be created: ${s.reason}` };
    const n = await count(scope);
    if (n !== 1) return { ...o, skipped: `the ${name} scope ${n === null ? 'could not be listed' : `lists ${n} object(s) with the run's marker, not 1`}` };
    o.before[name] = n;
  }
  const args = render({ ...(sel.args as object), ...sel.narrow! }, baseVars(res, ctx.prefix, { scope: a.key, marker })) as Record<string, unknown>;
  // why: S3: a narrowing that renders empty, or that names an argument the tool does not take, leaves the selector empty.
  const props = (ctx.tools.find((t) => t.name === sel.tool)?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  for (const k of Object.keys(sel.narrow!)) {
    const v = args[k];
    if (typeof v !== 'string' || !v.includes(marker)) return { ...o, skipped: `selector.narrow.${k} does not render to a value carrying the run's marker, so the call would not be narrowed; it is not sent` };
    if (!props || !Object.hasOwn(props, k)) return { ...o, skipped: `${sel.tool}'s input schema does not declare the argument ${k} that selector.narrow sets, so the call would not be narrowed; it is not sent` };
  }
  const step = ctx.session.stepId('tgt1.selector');
  const inv0 = await inventory(ctx, res, label, { readById: true });
  if (inv0.unavailable) return { ...o, skipped: `the objects outside the tester's own could not be listed (${inv0.unavailable}), so a loss could not be seen; ${sel.tool} is not called` };
  o.fixture_loss = await compare(ctx, res, label, invF, inv0, { fixtures: true });
  if (anyLoss(o.fixture_loss)) return { ...o, skipped: `objects the tester did not create were lost or changed while the objects for this test were created (${lossText(o.fixture_loss)}); ${sel.tool} is not called` };
  // why: i13b: a list that leaves an entry out now and then; a second listing right away, and the one before the fixtures,
  // complete the set of bystanders compared around the call.
  // why: review (5): the freshest listing first, so an entry is compared in its latest listed form.
  await withEarlier(ctx, label, inv0, await inventory(ctx, res, label));
  await withEarlier(ctx, label, inv0, invF);
  o.call = brief(await ctx.session.call(label, sel.tool, args, { step }));
  o.loss = await compare(ctx, res, label, inv0, await inventory(ctx, res, label, { readById: true }), { selector: true });
  for (const [name, scope] of where) o.after[name] = await count(scope);
  return o;
}

async function tgt2(ctx: RunContext, res: ResourceSpec, label: string): Promise<Tgt2Obs> {
  const o: Tgt2Obs = { container: null, before: 0, forms: [] };
  const invF = await inventory(ctx, res, label);
  if (invF.unavailable) return { ...o, skipped: `the objects outside the tester's own could not be listed (${invF.unavailable}), so a loss could not be seen; no form is sent` };
  const c = await newScope(ctx, res, 'tc', label);
  if (!c.ok) return { ...o, skipped: `the container could not be created: ${c.reason}` };
  o.container = c.key;
  const empty = await listScope(ctx, res, c.key, label);
  if (empty === null || empty.length !== 0) return { ...o, skipped: empty === null ? 'the container could not be listed' : `the new container already holds ${empty.length} object(s); the test runs only in a container holding nothing but the tester's objects` };
  const mine: unknown[] = [];
  for (let i = 0; i < 3; i++) {
    const s = await scratch(ctx, res, { tag: 'tg', purpose: 'MWS-TGT-2 object in the container', label, via: 'control', scope: c.key });
    if (s.ok) mine.push(s.id);
  }
  const listed = await listScope(ctx, res, c.key, label);
  if (listed === null || listed.length !== mine.length || !mine.length || !listed.every((it) => mine.some((m) => deepEqual(m, it.id)))) return { ...o, skipped: `the container does not hold exactly the tester's ${mine.length} object(s) (${listed === null ? 'not listed' : `${listed.length} listed`}); the test is not run` };
  o.before = listed.length;
  let inv0 = await inventory(ctx, res, label, { readById: true });
  if (!inv0.unavailable) {
    o.fixture_loss = await compare(ctx, res, label, invF, inv0, { fixtures: true });
    if (anyLoss(o.fixture_loss)) return { ...o, skipped: `objects the tester did not create were lost or changed while the container and its objects were created (${lossText(o.fixture_loss)}); no form is sent` };
    await withEarlier(ctx, label, inv0, await inventory(ctx, res, label));
    await withEarlier(ctx, label, inv0, invF);
  }
  for (const f of res.selector!.forms) {
    const args = render({ ...(res.selector!.args as object), ...f.args }, baseVars(res, ctx.prefix, { scope: c.key }));
    const step = ctx.session.stepId(`tgt2.${f.name}`);
    if (inv0.unavailable) return { ...o, skipped: `the objects outside the tester's own could not be listed before the form ${f.name} (${inv0.unavailable}), so a loss could not be seen; the form is not sent` };
    const r = await ctx.session.call(label, res.selector!.tool, args, { step });
    const after = await listScope(ctx, res, c.key, label);
    const inv1 = await inventory(ctx, res, label, { readById: true });
    const loss = await compare(ctx, res, label, inv0, inv1, { selector: true });
    inv0 = inv1;
    o.forms.push({ name: f.name, call: brief(r), remaining: after === null ? null : after.length, loss });
    // why: a form that touched anything outside the container ends the test at once.
    if (!noLoss(loss)) break;
    // why: one form that matched everything is enough; the container is not refilled.
    if (after !== null && after.length < o.before) break;
  }
  return o;
}

async function tgt3(ctx: RunContext, res: ResourceSpec, label: string): Promise<Tgt3Obs> {
  const key = ctx.marker('k3');
  const o: Tgt3Obs = { key, first: null, second: null, how: '', before: null, after: null, path: res.key!.vary?.path ?? null };
  const env = baseVars(res, ctx.prefix, { key, marker: key });
  const args1 = render(res.create!.args, env) as Record<string, unknown>;
  const c1 = await createVerified(ctx.session, ctx.ledger, res, ctx.prefix, { tool: res.create!.tool, args: args1, purpose: 'MWS-TGT-3 first create', label, step: ctx.session.stepId('tgt3.first') });
  o.first = c1.call ? brief(c1.call) : null;
  if (!c1.ok) return { ...o, skipped: `the first create failed: ${c1.reason}` };
  const d = new Driver(ctx.session, ctx.manifest, res, ctx.prefix, ctx.env);
  d.id = c1.id;
  let args2: Record<string, unknown> = args1;
  if (res.key!.vary) {
    const v = res.key!.vary;
    const was = args1[v.arg];
    // why: the second value keeps the argument's type, so a refusal is about the key, not a type error (CLI-BUGS item 13).
    args2 = { ...args1, [v.arg]: typeof was === 'string' ? `${was}-second` : typeof was === 'number' ? was + 1 : typeof was === 'boolean' ? !was : `${ctx.prefix}second` };
    o.how = `the second create sends ${v.arg} ${JSON.stringify(args2[v.arg])} instead of ${JSON.stringify(was)}`;
  } else {
    const f = res.fields![0];
    const u = await d.update(label, f, f.values[1], { step: ctx.session.stepId('tgt3.change') });
    if (!u.ok) return { ...o, skipped: 'the field could not be changed before the second create' };
    o.how = `${f.path} was changed to ${JSON.stringify(f.values[1])} before the second create`;
    o.path = f.path;
  }
  const r0 = await d.readOnce(label, ctx.session.stepId('tgt3.before'));
  o.before = r0.ok ? getPath(r0.obj, o.path!) : null;
  // The second create goes through the ledger too: if it makes a new object (a different id), cleanup removes it.
  const intent = ctx.ledger.intent(res.name, res.create!.tool, 'MWS-TGT-3 second create with the same key');
  const step = ctx.session.stepId('tgt3.second');
  const inv0 = await inventory(ctx, res, label);
  const r = await ctx.session.call(label, res.create!.tool, args2, { step });
  o.loss = await compare(ctx, res, label, inv0, await inventory(ctx, res, label));
  o.second = brief(r);
  // why: an accepted second create may have made a second object (a key that is not unique); the prefix sweep looks for it.
  const id2 = r.ok ? idFromResult(res, r) : null;
  ctx.ledger.append(id2 !== null ? { kind: 'created', intent, resource: res.name, id: id2, name: null, via: 'result' } : r.ok || r.timed_out || r.transport_error ? { kind: 'create_unknown', intent, resource: res.name, reason: r.ok ? `a second create with key ${short(key, 40)} was accepted without an id in its answer` : 'the second create has an unknown outcome' } : { kind: 'create_failed', intent, resource: res.name, reason: 'refused' });
  const r1 = await d.readSettled(label, 'tgt3.after', () => false);
  if (!r0.ok || !r1.ok) return { ...o, skipped: 'the object did not read back around the second create (outcome unknown)' };
  o.after = getPath(r1.obj, o.path!);
  return o;
}

/**
 * The bystander rule (gate-2 re-runs on 169b0cb and 6b028ec): a record whose call lost an object the tester did not create is
 * never `held`. Where the call deleted one (`gone`, a read by id says so) and `canViolate` (a selector call: acting outside
 * what it named is the forbidden behaviour), the record is `violated`; a change, an object missing from every listing that
 * cannot be read by id, a loss around a create or while fixtures were created (`blocking`), makes a `held` record
 * `not tested`. An inventory that could not be taken, or that was partial, never leaves a selector record `held` ("not seen to
 * be lost" is the most it can say); around a create it is noted and the record keeps its verdict on the spec's own method.
 * Every loss is in the record (reason, notes and numbers.bystanders_lost), and what was listed is in the notes and in
 * numbers.bystander_inventory.
 */
/** R10-1: whether the create tool of a key block is a create for MWS-TGT-3, from its name and description and the declaration's class. */
export function tgt3Class(res: ResourceSpec, tools: { name: string; description?: unknown }[]): { verdict: 'not tested' | 'not applicable' | null; why: string; note?: string } {
  const tool = res.create!.tool;
  const t = tools.find((x) => x.name === tool);
  const desc = typeof t?.description === 'string' ? t.description : '';
  const nameWords = tool.replace(/[_-]+/g, ' ');
  const words = `${tool} ${nameWords} ${desc}`;
  const c = res.key!.class;
  if (!c) {
    // why: review (10): the class is read from the tool's name (run, start, deploy, …) and from words of an upsert in its name or
    // description (or update, replace, overwrite, apply, existing); either needs the declaration's class. A plain create passes.
    const runLike = /\b(run|start|launch|deploy|install|clone)\b/i.test(nameWords);
    const upsertLike = /\b(upsert|apply|or update|create or update|replac\w*|overwrit\w*|existing)\b/i.test(words) || /create_or_update|createorupdate|upsert/i.test(tool);
    if (!runLike && !upsertLike) return { verdict: null, why: '' };
    return { verdict: 'not tested', why: `${tool} ${upsertLike ? 'may update or replace an existing object of the same name (its name or description says so)' : 'does not call itself a create, upsert or apply'}; declare key.class (as: create or upsert) with a quote of the words of its name or description relied on (spec MWS-TGT-3, applicability, R10-1, NF-8); the text of a result does not count` };
  }
  const norm = (x: string) => x.toLowerCase().replace(/\s+/g, ' ');
  if (!norm(words).includes(norm(c.quote))) return { verdict: 'not tested', why: `key.class quotes ${JSON.stringify(c.quote)}, which is not in the name or the description of ${tool}; the class rests on those words (R10-1)` };
  if (c.as === 'upsert') return { verdict: 'not applicable', why: `the declaration puts ${tool} among the upserts and applies (${JSON.stringify(c.quote)}), which MWS-TGT-3 does not cover (NF-8)` };
  return { verdict: null, why: '', note: `The declaration puts ${tool} among the creates, on the words ${JSON.stringify(c.quote)} (R10-1).` };
}

/** `callSteps`: the steps of the calls the losses are around; a record turned into violated without steps of its own gets them (review R2). */
export function withLoss(r: Result, losses: (Loss | undefined)[], canViolate: boolean, blocking: (Loss | undefined)[] = [], callSteps: string[] = []): Result {
  const own = losses.filter((l): l is Loss => !!l);
  const ls = [...own, ...blocking.filter((l): l is Loss => !!l)];
  if (!ls.length) return r;
  const gone = [...new Set(ls.flatMap((l) => l.gone))];
  const changed = [...new Set(ls.flatMap((l) => l.changed))];
  const missing = [...new Set(ls.flatMap((l) => l.missing ?? []))];
  const ownGone = [...new Set(own.flatMap((l) => l.gone))];
  const unavailable = ls.find((l) => l.unavailable)?.unavailable ?? null;
  const partial = [...new Set(ls.flatMap((l) => l.partial ?? []))];
  const covered = ls.find((l) => l.covered)?.covered;
  const volatile = [...new Set(ls.flatMap((l) => l.volatile ?? []))];
  const text = lossText({ gone, changed, missing, unavailable });
  const lost = gone.length || changed.length || missing.length;
  const out: Result = {
    ...r,
    numbers: {
      ...r.numbers,
      // why: k1 brackets apply withLoss again to a record that already has losses; the lists are merged, never replaced.
      ...(lost ? { bystanders_lost: [...new Set([...(Array.isArray(r.numbers['bystanders_lost']) ? (r.numbers['bystanders_lost'] as string[]) : []), ...gone, ...changed, ...missing.map((m) => `${m} (missing; not confirmed gone)`)])] } : {}),
      ...(unavailable ? { bystander_inventory: { unavailable } } : covered ? { bystander_inventory: { scopes: covered.scopes, objects: covered.objects, lists: [...new Set(covered.lists)], read_back_by_id: covered.read_back_by_id, partial } } : {}),
    },
    notes: [...r.notes],
  };
  if (lost) out.notes.push(`${BYSTANDER_NOTE} around this test's calls: ${text}.`);
  if (unavailable) out.notes.push(`The objects outside the tester's own could not all be listed (${unavailable}); a loss cannot be ruled out.`);
  else if (covered) out.notes.push(`Bystander inventory: ${coverageText(covered, partial)}.`);
  if (volatile.length) out.notes.push(`Fields set aside as changing by themselves (a time, an age, or a value that differed between two listings with no call in between): ${volatile.slice(0, 8).join(', ')}.`);
  if (ownGone.length && canViolate && r.verdict !== 'violated') return { ...out, verdict: 'violated', steps: out.steps.length ? out.steps : [...callSteps], reason: `The call removed objects the tester did not create (${ownGone.join(', ')}), outside what it named. ${r.reason}` };
  if (gone.length && r.verdict === 'violated') return { ...out, reason: `${r.reason} Objects the tester did not create were also lost: ${gone.join(', ')}.` };
  if (r.verdict !== 'held') return out;
  if (lost) return { ...out, verdict: 'not tested', reason: `Objects the tester did not create were lost or changed around the call (${text}), so this record is not held. ${r.reason}` };
  // why: review: a bracket around a check (k1) whose inventory could not be taken cannot rule a loss out either.
  const bracketUnavailable = blocking.some((l) => !!l?.unavailable);
  if (unavailable) return canViolate || bracketUnavailable ? { ...out, verdict: 'not tested', reason: `The objects outside the tester's own could not all be listed (${unavailable}), so a loss could not be ruled out and the record is not held. ${r.reason}` } : out;
  if (partial.length) {
    // why: note 14: a selector call on a partial inventory is never held; around a create the record keeps the spec's verdict.
    if (canViolate) return { ...out, verdict: 'not tested', reason: `No object outside the tester's own was seen to be lost, but the inventory was partial (${partial.join('; ')}), so a loss is not ruled out and the record is not held. ${r.reason}` };
    return { ...out, reason: `${r.reason} Objects outside the tester's own: not seen to be lost; the inventory was partial (${partial.join('; ')}).` };
  }
  // why: review: an observation from before this change (recheck) has no coverage; it keeps its reason.
  if (!covered) return out;
  return { ...out, reason: `${r.reason} Objects outside the tester's own: not seen to be lost (${covered.scopes.length} scope(s), ${covered.objects} object(s) listed${covered.read_back_by_id ? ', each read back by id' : ''}).` };
}

/** A loss seen later in the run, with where it was seen (a check, a set-up, the resets between checks). */
export interface LaterLoss {
  where: string;
  loss: Loss;
  /** Seen after the last window (no record of its own): named in every earlier record, held or not. */
  all?: boolean;
  /** nx1-x-lie (validator re-run on 9288cfc): the inventory was shown partial later (paging); no earlier record stays held. */
  paging?: string[];
}

/**
 * Gate-2 re-run on 0295ed6 (k1): a loss seen in a later window of the run cannot be ruled out as an effect of an earlier record's
 * calls (a server can act on a write later: a queue, a cap enforced on the next write). Every earlier record that made calls
 * and is `held` becomes `not tested`, and names the loss. Records made without calls (the catalog) are left as they are.
 */
export function withLaterLoss(r: Result, later: LaterLoss[]): Result {
  // why: R10 Q8 (nx1-x-lie): once a list is shown to page incompletely, every earlier held record rests on an inventory that is
  // now known to be partial; it becomes not tested with the paging reason (the lost object itself stays unseen: no list shows it).
  const pg = later.filter((x) => x.paging?.length);
  if (pg.length && r.verdict === 'held' && r.write_path.resource !== '(catalog)') {
    const why = [...new Set(pg.flatMap((x) => x.paging!))];
    r = { ...r, verdict: 'not tested', reason: `The bystander inventory was shown later in this run to be partial (${pg.map((x) => x.where).join('; ')}: ${short(why[0]!, 240)}), so a loss around this record's calls is not ruled out and the record is not held. ${r.reason}`, notes: [...r.notes, ...why.map((w) => `Inventory partial (found later): ${w}.`)] };
  }
  later = later.filter((x) => !x.paging?.length);
  const held = r.verdict === 'held';
  const ls = later.filter((x) => anyLoss(x.loss) && (held || x.all));
  if (!ls.length || r.write_path.resource === '(catalog)') return r;
  const lost = [...new Set(ls.flatMap((x) => [...x.loss.gone, ...x.loss.changed, ...(x.loss.missing ?? []).map((m) => `${m} (missing; not confirmed gone)`)]))];
  const where = [...new Set(ls.map((x) => x.where))];
  const text = ls.map((x) => `${x.where}: ${lossText(x.loss)}`).join('; ');
  const named = { ...r.numbers, bystanders_lost: [...new Set([...(Array.isArray(r.numbers['bystanders_lost']) ? (r.numbers['bystanders_lost'] as string[]) : []), ...lost])] };
  const note = `${BYSTANDER_NOTE} later in this run (${where.join('; ')}).`;
  const notes = r.notes.includes(note) ? r.notes : [...r.notes, note];
  if (!held) return { ...r, numbers: named, notes };
  return {
    ...r,
    verdict: 'not tested',
    reason: `Objects the tester did not create were lost or changed later in this run (${text}); an effect of this record's calls that showed only later is not ruled out, so the record is not held. ${r.reason}`,
    numbers: named,
    notes,
  };
}

export function targetingVerdicts(o: TargetObs, res: ResourceSpec): Result[] {
  const sc = { id: ID, version: VERSION };
  const out: Result[] = [];
  const lossOn = (from: number, losses: (Loss | undefined)[], canViolate: boolean, blocking: (Loss | undefined)[] = [], callSteps: string[] = []) => {
    for (let i = from; i < out.length; i++) out[i] = withLoss(out[i]!, losses, canViolate, blocking, callSteps);
  };
  if (o.tgt1) {
    const t = o.tgt1;
    const w = wp(res.name, res.create!.tool);
    const notes = [`scopes: named ${short(t.scopes.named, 40)}, other ${short(t.scopes.other, 40)}${t.scopes.default ? `, default ${short(t.scopes.default, 40)}` : ''}`];
    if (t.skipped) out.push(result('MWS-TGT-1', w, sc, 'not tested', t.skipped));
    else if (!t.call || t.call.indeterminate) out.push(result('MWS-TGT-1', w, sc, 'not tested', 'the create\'s outcome is unknown (timeout or broken connection)'));
    else if (!t.call.ok && !t.found_in.length) out.push(result('MWS-TGT-1', w, sc, 'held', `${res.create!.tool} refused the call; nothing was written anywhere.`, { steps: [t.call.step], notes }));
    else if (t.found_in.some((x) => x !== 'named')) out.push(result('MWS-TGT-1', w, sc, 'violated', `${res.create!.tool} was told to write in scope ${short(t.scopes.named, 40)}, and the object is in the ${t.found_in.filter((x) => x !== 'named').join(' and ')} scope${t.found_in.includes('named') ? ' as well' : ' instead'}${t.call.ok ? '; the call reported success' : ''}.`, { steps: [t.call.step], notes }));
    else if (t.found_in.includes('named')) out.push(result('MWS-TGT-1', w, sc, 'held', `The object was written in the named scope only (looked in the named, the other${t.scopes.default ? ' and the default' : ''} scope).`, { notes }));
    else out.push(result('MWS-TGT-1', w, sc, 'not tested', 'the created object was found in none of the scopes read back; where it landed could not be established', { notes }));
  }
  if (o.tgt1) lossOn(out.length - 1, [o.tgt1.loss], false);
  if (o.tgt1sel) {
    const t = o.tgt1sel;
    const w = wp(res.name, res.selector!.tool);
    const notes = [`scopes: named ${short(t.scopes.named, 40)}, other ${short(t.scopes.other, 40)}${t.scopes.default ? `, default ${short(t.scopes.default, 40)}` : ''}`, ...Object.keys(t.before).map((k) => `${k}: ${t.before[k]} before, ${t.after[k] ?? '?'} after`)];
    const outside = Object.keys(t.before).filter((k) => k !== 'named' && t.after[k] !== null && t.after[k] !== undefined && t.after[k]! < t.before[k]!);
    if (t.skipped) out.push(result('MWS-TGT-1', w, sc, 'not tested', t.skipped));
    else if (outside.length) out.push(result('MWS-TGT-1', w, sc, 'violated', `${res.selector!.tool} was told to act in scope ${short(t.scopes.named, 40)} on the objects named with the run's marker, and it removed the object of that name in the ${outside.join(' and ')} scope${(t.after['named'] ?? 1) < (t.before['named'] ?? 0) ? ' as well' : ''}${t.call?.ok ? '; the call reported success' : ''}.`, { steps: t.call ? [t.call.step] : [], notes }));
    else if (!t.call || t.call.indeterminate || Object.values(t.after).some((v) => v === null)) out.push(result('MWS-TGT-1', w, sc, 'not tested', 'the call\'s outcome is unknown, or a scope could not be listed afterwards', { notes }));
    else if (!t.call.ok && t.after['named'] === t.before['named']) out.push(result('MWS-TGT-1', w, sc, 'held', `${res.selector!.tool} refused the call; nothing was removed in any scope.`, { steps: [t.call.step], notes: [...notes, 'A refusal holds MWS-TGT-1; the selector forms of MWS-TGT-2 are sent only where the call took effect in the named scope.'] }));
    else if ((t.after['named'] ?? 1) < (t.before['named'] ?? 0)) out.push(result('MWS-TGT-1', w, sc, 'held', `${res.selector!.tool} acted in the named scope only (an object of the same name in the other${t.scopes.default ? ' and the default' : ''} scope was left).`, { steps: [t.call.step], notes }));
    else out.push(result('MWS-TGT-1', w, sc, 'not tested', `${res.selector!.tool} removed nothing in the named scope either, so where it acts could not be established (check selector.narrow)`, { notes }));
  }
  if (o.tgt1sel) lossOn(out.length - 1, [o.tgt1sel.loss], true, [o.tgt1sel.fixture_loss], o.tgt1sel.call ? [o.tgt1sel.call.step] : []);
  if (o.tgt2) {
    const t = o.tgt2;
    const w = wp(res.name, res.selector!.tool);
    if (t.skipped) out.push(result('MWS-TGT-2', w, sc, 'not tested', t.skipped));
    else {
      const bad = t.forms.filter((f) => f.remaining !== null && f.remaining < t.before);
      const notes = t.forms.map((f) => `${f.name}: ${f.call.ok ? 'success' : 'refused'}, ${f.remaining ?? '?'} of ${t.before} left`);
      if (bad.length) out.push(result('MWS-TGT-2', w, sc, 'violated', `With the selector ${bad[0]!.name} and no opt-in argument, ${res.selector!.tool} removed ${t.before - (bad[0]!.remaining ?? 0)} of ${t.before} objects in the tester's container.`, { steps: bad.map((f) => f.call.step), notes }));
      else if (t.forms.some((f) => f.call.indeterminate || f.remaining === null)) out.push(result('MWS-TGT-2', w, sc, 'not tested', 'a selector call had an unknown outcome, or the container could not be counted', { notes }));
      else out.push(result('MWS-TGT-2', w, sc, 'held', `No declared selector form (${t.forms.map((f) => f.name).join(', ')}) without the opt-in removed anything in the tester's container (${t.before} of ${t.before} left each time).`, { steps: t.forms.map((f) => f.call.step), notes: [...notes, `Only the forms the declaration names were tried; ${['empty', 'omitted', 'match-all', 'container path'].filter((n) => !t.forms.some((f) => f.name.includes(n.split(' ')[0]!))).join(', ') || 'none'} of the spec's forms were not declared.`] }));
    }
  }
  if (o.tgt2 && (!o.tgt2.skipped || o.tgt2.fixture_loss)) lossOn(out.length - 1, (o.tgt2.forms ?? []).map((f) => f.loss), true, [o.tgt2.fixture_loss], (o.tgt2.forms ?? []).map((f) => f.call.step));
  if (o.tgt3) {
    const t = o.tgt3;
    const w = wp(res.name, res.create!.tool);
    if (t.skipped) out.push(result('MWS-TGT-3', w, sc, 'not tested', t.skipped));
    else if (!t.second || t.second.indeterminate) out.push(result('MWS-TGT-3', w, sc, 'not tested', 'the second create\'s outcome is unknown'));
    else if (!deepEqual(t.before, t.after)) out.push(result('MWS-TGT-3', w, sc, 'violated', `A second create with the existing key ${short(t.key, 40)} overwrote the object: ${t.path} ${short(t.before, 40)} → ${short(t.after, 40)} (${t.how})${t.second.ok ? '; it reported success' : ''}.`, { steps: [t.second.step] }));
    else out.push(result('MWS-TGT-3', w, sc, 'held', `A second create with the existing key left the object as it was (${t.how}; the call ${t.second.ok ? `was answered without isError${t.second.text ? `: ${JSON.stringify(short(t.second.text, 100))}` : ''}` : 'was refused'}). One name collision in one scope was tested.`, { steps: [t.second.step] }));
  }
  if (o.tgt3?.class_note) out[out.length - 1] = { ...out[out.length - 1]!, notes: [...out[out.length - 1]!.notes, o.tgt3.class_note] };
  if (o.tgt3) lossOn(out.length - 1, [o.tgt3.loss], false);
  return out;
}
