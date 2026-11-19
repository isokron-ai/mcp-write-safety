/**
 * MWS-IN-5, the scoped search (lane F7): a fully automated search for a fixed constraint on one argument's value that the
 * server or its backend enforces and the input schema does not declare. The owner needs to declare nothing (try_values and
 * fixed_constraints are still used and merged); the record states the scope searched in its numbers.
 *
 *   1. probes      in5gen.ts: values valid by the schema that commonly meet an undeclared limit, per argument, plus bounds a
 *                  description or a declared document states in words; the declared try_values of the update tool; sent
 *                  interleaved over the arguments in a fixed scrambled order, never ascending (a failure that begins during the
 *                  run then shows on both sides of an order)
 *   2. search      each probe in an otherwise valid call, after a base call that succeeded (as MWS-IN-1 sends its probes)
 *   3. boundary    between the last value accepted and the first refused on an order, bisection; it stops on an answer left out
 *                  of the reading
 *   4. repeat      in a fresh context (a second scratch object with another field varied, a fresh create, or a read call with
 *                  another argument set to a value accepted in the search) the refused value, then its accepted neighbour
 *   5. reading     in5read.ts, pure: a refusal is a fixed single-argument constraint only with neighbours accepted, the repeat
 *                  refused and the neighbour accepted again after it, and on an order a monotonic boundary. Until MWS 0.10
 *                  accepts that reading, a constraint it alone confirms is a candidate in a `not observed` record, unless
 *                  --in5-reading=tester (IN5_READING); the declaration (fixed_constraints) gives `violated` either way

 * Where it searches, and how it stays safe (spec 7.3, rule 1; R15-4):
 *   read tools    the resource's read call (on the object under test) and its declared list calls: probed freely, never an
 *                 argument that names the object or the scope
 *   update tool   only on scratch objects the tester creates for the search (through the ledger, cleaned up by the policy);
 *                 never the object under test, never the identifier, the version or the scope
 *   create tool   create-then-cleanup through the ledger (createVerified): every probe that is accepted makes an object of the
 *                 run's own, named with the run prefix, which cleanup removes; never the scope, the caller's key or an
 *                 idempotency key
 *   other tools   not searched in this release (no base call is built for them here); the record says so
 * A resource whose cleanup policy is `leave` (or none) gets no write probe: the record is `not tested` with that reason (its
 * try_values are then sent by schema-probes on the object under test). Each tool gets at most limits.in5_probes calls, a create
 * tool at most limits.in5_creates; read probes are paced like writes; the plan counts them; the search stops short of the
 * writes the later checks plan.
 */

import { readFileSync } from 'node:fs';

import { baseVars, Driver } from '../core/driver.js';
import { validates } from '../core/jsonschema.js';
import type { Manifest, ResourceSpec } from '../core/manifest.js';
import { createVerified } from '../core/objects.js';
import type { CallResult } from '../core/session.js';
import { render, type Env } from '../core/template.js';
import { deepEqual, getPath, isObj, short, type Obj } from '../core/util.js';
import { result, type Result } from '../report/verdicts.js';
import { declaredWriteTools } from './coverage.js';
import { DEFAULT_PAYLOAD_BYTES, in5Probes, orderedValue, regexHints, type Dim, type Hint, type HintExtractor, type In5Probe } from './in5gen.js';
import { bisectNext, boundaryOf, describe, excludedWhy, readIn5, refusedCall, type Constraint, type FixedDecl, type In5Call, type Phase } from './in5read.js';
import { carries, haltedIn, ID_LIKE } from './schema.js';
import { scratch } from './scratch.js';
import { annotations, offeredKeys, toolByName, wp, type CheckModule, type Observation, type PlanContext, type PlannedCheck, type RunContext, type Tool } from './types.js';

const ID = 'in5-search';
const VERSION = '1';
const SC = { id: ID, version: VERSION };
export const IN5_DEFAULT_PROBES = 80;
/** Review M8: objects a create tool's search may make (each accepted probe is one), unless limits.in5_creates says otherwise. */
export const IN5_DEFAULT_CREATES = 10;
/** Calls per tool at most: limits.in5_probes, and for a create tool also limits.in5_creates (the base create included). */
export const capFor = (m: Manifest, role: Role): number => Math.min(m.limits.in5_probes ?? IN5_DEFAULT_PROBES, role === 'create' ? (m.limits.in5_creates ?? IN5_DEFAULT_CREATES) : Infinity);

/**
 * Review (until MWS 0.10 is accepted): whether a constraint that only the tester's differential reading confirms gives
 * `violated` (`tester`, with --in5-reading=tester) or is recorded in a `not observed` record as a candidate constraint, seen,
 * not judged (`declaration`, the default). A constraint the declaration states (fixed_constraints) gives `violated` either way.
 */
export const IN5_READING: { value: 'declaration' | 'tester' } = { value: 'declaration' };
/** Bisection steps per boundary at most (2^64 covers every number the generator sends; the per-tool cap bounds them too). */
const MAX_BISECT = 64;

/** The extractors of hints in use; a model-based one may be added here (HintExtractor), with no dependency in this module. */
export const HINT_EXTRACTORS: HintExtractor[] = [regexHints];

export type Role = 'read' | 'update' | 'create';
export interface Source {
  tool: string;
  role: Role;
  /** Where the base call comes from in the declaration. */
  from: string;
  args: unknown;
}

/**
 * The tools a resource's search covers, each with the declared call its probes start from. A tool is searched once per run,
 * under the first resource (in manifest order) that declares a call for it here.
 */
export function sourcesOf(m: Manifest, tools: Tool[], res: ResourceSpec): Source[] {
  const all = new Map<string, { res: string; s: Source }>();
  for (const r of m.resources) {
    const cand: Source[] = [];
    if (r.update) cand.push({ tool: r.update.tool, role: 'update', from: `${r.name}.update`, args: r.update.args });
    if (r.create) cand.push({ tool: r.create.tool, role: 'create', from: `${r.name}.create`, args: r.create.args });
    cand.push({ tool: r.read.tool, role: 'read', from: `${r.name}.read`, args: r.read.args });
    if (r.list) cand.push({ tool: r.list.tool, role: 'read', from: `${r.name}.list`, args: r.list.args });
    if (r.scope?.list) cand.push({ tool: r.scope.list.tool, role: 'read', from: `${r.name}.scope.list`, args: r.scope.list.args });
    for (const c of cand) {
      if (!toolByName(tools, c.tool) || all.has(c.tool)) continue;
      // why: a list call is probed freely only where it reads: a tool annotated as a write is not a read source.
      if (c.role === 'read' && c.from !== `${r.name}.read` && annotations(toolByName(tools, c.tool))['readOnlyHint'] === false) continue;
      all.set(c.tool, { res: r.name, s: c });
    }
  }
  return [...all.values()].filter((x) => x.res === res.name).map((x) => x.s);
}

/** Does the search search this resource's update tool (on scratch objects)? Where not, schema-probes sends its try_values. */
export function searchesUpdate(m: Manifest, tools: Tool[], res: ResourceSpec): boolean {
  return sourcesOf(m, tools, res).some((s) => s.role === 'update' && s.tool === res.update?.tool && gate(m, tools, res, s) === null);
}

/** Declared write tools of the resource that the search does not cover in this release. */
function uncovered(m: Manifest, tools: Tool[], res: ResourceSpec): string[] {
  const covered = new Set(m.resources.flatMap((r) => sourcesOf(m, tools, r).map((s) => s.tool)));
  const first = m.resources[0]?.name;
  return [...declaredWriteTools(m, tools)].filter(([t, r]) => (r === res.name || (r === '(manifest)' && res.name === first)) && !covered.has(t) && toolByName(tools, t)).map(([t]) => t);
}

const propsOf = (t: Tool | undefined): Obj => (t && isObj(t.inputSchema) && isObj(t.inputSchema['properties']) ? (t.inputSchema['properties'] as Obj) : {});

/** The tools of a resource the search does not cover, each with the reason (the gate, or no base call built for it here). */
function skippedTools(ctx: PlanContext, res: ResourceSpec): { tool: string; why: string }[] {
  const out: { tool: string; why: string }[] = [];
  for (const s of sourcesOf(ctx.manifest, ctx.tools, res)) {
    const g = gate(ctx.manifest, ctx.tools, res, s);
    if (g) out.push({ tool: s.tool, why: `${s.tool} was not searched: ${g}` });
  }
  for (const tool of uncovered(ctx.manifest, ctx.tools, res)) out.push({ tool, why: `the MWS-IN-5 search starts only from a resource's read, list, create and update calls in this release, and ${tool} is none of them` });
  return out;
}

/** Arguments never probed, and why (by name and by the declaration; the run adds those whose value names its objects). */
function neverProbed(m: Manifest, tools: Tool[], res: ResourceSpec, s: Source): Map<string, string> {
  const out = new Map<string, string>();
  const props = Object.keys(propsOf(toolByName(tools, s.tool)));
  for (const k of props) if (ID_LIKE.test(k)) out.set(k, 'its name says it names an object, a scope or a selector (spec 7.3, rule 1)');
  if (res.scope) out.set(res.scope.arg, 'the scope argument (spec 7.3, rule 1)');
  if (res.version?.arg) out.set(res.version.arg, 'the version argument');
  if (res.version?.override) out.set(res.version.override, 'the version override');
  if (s.role === 'create' && res.key) out.set(res.key.arg, "the caller's key for the object (MWS-TGT-3)");
  for (const k of offeredKeys(tools, s.tool)) out.set(k, 'an idempotency key');
  return new Map([...out].filter(([k]) => props.includes(k)));
}

/** Why a source's search cannot run at all, or null. */
function gate(m: Manifest, tools: Tool[], res: ResourceSpec, s: Source): string | null {
  if (m.target.guard?.tool === s.tool) return `${s.tool} is the tenant guard (target.guard); the declaration vouches only for the guard call itself`;
  if ((m.canaries ?? []).some((c) => c.tool === s.tool)) return `${s.tool} is a canary (canaries); the declaration vouches only for the canary call itself`;
  if (s.role !== 'read' && (!res.cleanup || res.cleanup === 'leave')) return `the resource's cleanup policy is ${res.cleanup ?? 'not declared'}, so the search makes no object of its own through ${s.tool}`;
  if (s.role === 'update' && (!res.create || !res.fields)) return `the search updates only scratch objects of its own, and ${res.name} declares no create block (or no fields) to make one`;
  return null;
}

/** The documents the declaration names (in5.docs), read once; a document that cannot be read is noted. */
function docsOf(m: Manifest): { docs: { path: string; text: string }[]; missing: string[] } {
  const docs: { path: string; text: string }[] = [];
  const missing: string[] = [];
  for (const p of m.in5?.docs ?? []) {
    try {
      docs.push({ path: p, text: readFileSync(p, 'utf8').slice(0, 2_000_000) });
    } catch {
      missing.push(p);
    }
  }
  return { docs, missing };
}

export function hintsFor(m: Manifest, t: Tool): { hints: Hint[]; missing: string[] } {
  const { docs, missing } = docsOf(m);
  return { hints: HINT_EXTRACTORS.flatMap((x) => x.hints(t, docs)), missing };
}

/** A value as the record shows it: short, with the length of a long string or list. */
export function shown(v: unknown): string {
  if (typeof v === 'string' && [...v].length > 40) return `${JSON.stringify(v.slice(0, 24))}… (${[...v].length} characters)`;
  if (Array.isArray(v) && v.length > 3) return `[${v.length} items]`;
  return short(v, 60);
}

export interface ArgPlan {
  arg: string;
  probes: number;
  /** Why no probe is sent (never probed, or the generator gives none). */
  skipped?: string;
  /** Set where the argument is not searchable by rule (an identifier, scope, version or key; enum or const; boolean; object; a format). */
  rule?: string;
}

export interface ToolObs5 {
  tool: string;
  role: Role;
  from: string;
  args_total: number;
  args: ArgPlan[];
  calls: In5Call[];
  hints: Hint[];
  cap: number;
  used: number;
  /** The per-tool cap or the write budget stopped the search before it was done. */
  cut: string | null;
  not_probed?: string;
  /** Spec R15-4: a put-back on this tool failed earlier in the run; nothing was sent. */
  halted?: string;
  notes: string[];
}

export const in5SearchCheck: CheckModule = {
  id: ID,
  version: VERSION,
  requirements: ['MWS-IN-5'],
  plan(ctx: PlanContext, res: ResourceSpec): PlannedCheck {
    const base: PlannedCheck = { check: ID, version: VERSION, resource: res.name, runs: false, calls: [], writes: 0, creates: 0, notRun: [] };
    const calls: string[] = [];
    const nr: Result[] = [];
    let writes = 0;
    let creates = 0;
    for (const s of sourcesOf(ctx.manifest, ctx.tools, res)) {
      const t = toolByName(ctx.tools, s.tool)!;
      if (gate(ctx.manifest, ctx.tools, res, s)) continue;
      const never = neverProbed(ctx.manifest, ctx.tools, res, s);
      const { hints } = hintsFor(ctx.manifest, t);
      const cap = capFor(ctx.manifest, s.role);
      const n = Object.keys(propsOf(t)).filter((a) => !never.has(a)).reduce((k, a) => k + in5Probes(t.inputSchema, null, a, { payload_bytes: ctx.manifest.limits.in5_payload_bytes ?? DEFAULT_PAYLOAD_BYTES, hints, role: s.role === 'read' ? 'read' : 'write' }).probes.length, 0);
      const extra = s.role === 'update' ? res.try_values.length : 0;
      // the base call, each probe, the bisection of up to two boundaries and a repeat of each refusal, within the per-tool cap.
      const at = Math.min(cap, 1 + 2 * (n + extra) + 4 * MAX_BISECT);
      calls.push(`${s.tool} (${s.role}, from ${s.from}): MWS-IN-5 search, ${n + extra} probe value(s) valid by the schema, with bisection and repeats, at most ${cap} call(s)${s.role === 'update' ? ' on two scratch objects of its own' : s.role === 'create' ? ` (limits.in5_creates), each accepted create cleaned up by the policy` : ', paced like writes'}`);
      if (s.role === 'update') {
        // two scratch objects (the search's context and the fresh context of the repeats)
        writes += at + 2;
        creates += 2;
      } else if (s.role === 'create') {
        writes += at;
        creates += at;
      }
    }
    nr.push(...skippedTools(ctx, res).map((x) => result('MWS-IN-5', wp(res.name, x.tool), SC, 'not tested', x.why)));
    // why: a check that runs gives its own not-tested records from evaluate: a plan record for one tool would keep the run from
    // giving the generic record of the requirement for every other tool where the check cannot run (run.ts filters by requirement).
    if (calls.length) return { ...base, runs: true, calls: [...calls, ...nr.map((r) => `${r.write_path.tool}: not searched (${r.reason})`)], writes, creates, notRun: [] };
    return { ...base, runs: false, calls, writes, creates, notRun: nr };
  },
  async collect(ctx: RunContext, res: ResourceSpec): Promise<Observation> {
    const out: ToolObs5[] = [];
    for (const s of sourcesOf(ctx.manifest, ctx.tools, res)) {
      if (gate(ctx.manifest, ctx.tools, res, s)) continue;
      // why: spec R15-4: a tool a failed put-back halted gets nothing more; schema-probes gives its MWS-IN-5 record (in5Halted).
      if (s.role === 'update' && haltedIn(ctx.session).has(s.tool) && res.update?.tool === s.tool) continue;
      out.push(await searchTool(ctx, res, s));
    }
    return { check: ID, version: VERSION, resource: res.name, data: { tools: out, skipped: skippedTools(ctx, res) } };
  },
  evaluate(obs: Observation, ctx: PlanContext): Result[] {
    const res = ctx.manifest.resources.find((r) => r.name === obs.resource)!;
    const data = obs.data as { tools: ToolObs5[]; skipped?: { tool: string; why: string }[] };
    return [...(data.skipped ?? []).map((x) => result('MWS-IN-5', wp(res.name, x.tool), SC, 'not tested', x.why)), ...(data.tools ?? []).map((o) => in5SearchVerdict(o, res))];
  },
};

/** One context the probes are sent in: the base call's arguments, and the call itself. */
interface Ctx5 {
  name: 'A' | 'B';
  varied: string[];
  base(): Promise<Obj | null>;
  call(args: Obj, step: string): Promise<CallResult>;
  /** For an update tool: read the value an accepted call left (try_values, R10-8). */
  stored?(arg: string, value: unknown): Promise<boolean | null>;
  /** Told the argument the next call probes (an update tool's context B varies a field other than it). */
  probing?(arg: string): void;
  /** The object the context's calls act on (an update tool's scratch object). */
  obj_id?: unknown;
  /** A read tool's context B: the other argument set to another value for a probe of `arg`, and how (review M4). */
  vary?(arg: string): Obj;
  variedFor?(arg: string): string[];
  why: string | null;
}

async function searchTool(ctx: RunContext, res: ResourceSpec, s: Source): Promise<ToolObs5> {
  const t = toolByName(ctx.tools, s.tool)!;
  const schema = t.inputSchema;
  const props = propsOf(t);
  const cap = capFor(ctx.manifest, s.role);
  const payload = ctx.manifest.limits.in5_payload_bytes ?? DEFAULT_PAYLOAD_BYTES;
  const { hints, missing } = hintsFor(ctx.manifest, t);
  const o: ToolObs5 = { tool: s.tool, role: s.role, from: s.from, args_total: Object.keys(props).length, args: [], calls: [], hints, cap, used: 0, cut: null, notes: missing.map((p) => `The document ${p} (in5.docs) could not be read; no hint was taken from it.`) };
  const halted = haltedIn(ctx.session).get(s.tool);
  if (halted) return { ...o, halted };
  if (!o.args_total) return o;
  const label = ctx.label('IN5');
  const never = neverProbed(ctx.manifest, ctx.tools, res, s);

  // --- contexts ---------------------------------------------------------------------------------------------------------
  const unknownOutcome = (r: CallResult) => r.timed_out || r.transport_error !== null || (!!r.result_type && r.result_type !== 'complete');
  const mk = async (name: 'A' | 'B'): Promise<Ctx5> => {
    if (s.role === 'read') {
      const d = ctx.driver;
      const env: Env = baseVars(res, ctx.prefix, { id: d.id, scope: d.scope });
      let args: unknown;
      try {
        args = render(s.args, env);
      } catch {
        args = null;
      }
      const ok = isObj(args) && !Object.values(args).some((v) => v === undefined);
      const needsId = /\{\{\s*(json:)?\??id\s*\}\}/.test(JSON.stringify(s.args));
      const why = !ok ? 'the declared call did not render to a mapping' : needsId && (d.id === null || d.id === undefined) ? 'the read call names the object under test, and this resource has none' : null;
      // why: review M8: read probes are paced like writes (the shared rate limit), so a search of reads cannot flood the backend.
      return {
        name,
        varied: [],
        why,
        base: async () => (why ? null : { ...(args as Obj) }),
        call: async (a, step) => {
          await ctx.session.pace();
          return ctx.session.call(label, s.tool, a, { step, write: false });
        },
      };
    }
    if (s.role === 'create') {
      return {
        name,
        varied: name === 'B' ? ['a fresh create, with a fresh name (marker)'] : [],
        why: null,
        base: async () => {
          const marker = ctx.marker(`in5${name.toLowerCase()}`);
          const a = render(s.args, baseVars(res, ctx.prefix, { scope: ctx.driver.scope, marker, key: marker }));
          return isObj(a) ? (a as Obj) : null;
        },
        call: async (a, step) => {
          const cr = await createVerified(ctx.session, ctx.ledger, res, ctx.prefix, { tool: s.tool, args: a, purpose: `MWS-IN-5 search of ${s.tool} (${step})`, label, step });
          return cr.call ?? ({ step, ok: false, isError: false, rpc_error: null, text: cr.reason, timed_out: false, transport_error: 'not sent', data: null } as unknown as CallResult);
        },
      };
    }
    // update: a scratch object of the search's own; B varies another declared field.
    const sc = await scratch(ctx, res, { tag: `in5${name.toLowerCase()}`, purpose: `MWS-IN-5 search of ${s.tool} (context ${name})`, label });
    if (!sc.ok || !sc.driver) return { name, varied: [], why: `a scratch object for the search could not be created (${sc.reason})`, base: async () => null, call: async () => null as never };
    const d: Driver = sc.driver;
    const [f0, f1] = res.fields!;
    let cur: { obj: unknown; version: unknown } | null = null;
    let stale = true;
    const vary = (arg: string) => (name === 'A' ? { f: f0, v: f0.values[0] } : f0.arg !== arg ? { f: f0, v: f0.values[1] } : { f: f1, v: f1.values[1] });
    let lastArg = '';
    return {
      name,
      obj_id: d.id,
      varied: name === 'B' ? [`a second scratch object`, `${f0.arg} = ${short(f0.values[1], 30)} (or ${f1.arg} = ${short(f1.values[1], 30)} where ${f0.arg} is the argument probed)`] : [],
      variedFor: (arg) => (name === 'A' ? [] : ['a second scratch object', f0.arg !== arg ? `${f0.arg} = ${short(f0.values[1], 30)}` : `${f1.arg} = ${short(f1.values[1], 30)}`]),
      why: null,
      base: async () => {
        if (stale || !cur) {
          const r = await d.readOnce(label, ctx.session.stepId(`in5.${s.tool}.${name}.read`));
          if (!r.ok) return null;
          cur = { obj: r.obj, version: r.version };
          stale = false;
        }
        const { f, v } = vary(lastArg);
        const a = d.updateArgs(f, v, cur);
        return isObj(a) ? (a as Obj) : null;
      },
      call: async (a, step) => {
        const r = await ctx.session.call(label, s.tool, a, { step, write: true });
        if (r.ok || unknownOutcome(r)) stale = true;
        return r;
      },
      stored: async (arg, value) => {
        const path = res.fields?.find((f) => f.arg === arg)?.path ?? arg;
        const back = await d.readSettled(label, `in5.${s.tool}.${arg}.stored`, (x) => deepEqual(getPath(x, path), value));
        stale = true;
        return back.ok ? back.settled : null;
      },
      // why: B varies the field the probed argument is not; base() reads which argument is probed from here.
      probing: (a) => {
        lastArg = a;
      },
    };
  };

  const A = await mk('A');
  if (A.why) return { ...o, not_probed: A.why };
  let B: Ctx5 | null = null as Ctx5 | null;

  // The base call, once (as MWS-IN-1 sends its probes: in a call that is otherwise valid, after a base call that succeeded); for
  // a create tool, one create with the declared arguments (review S8: the spec's rule for every tool).
  const b0 = await A.base();
  if (!b0) return { ...o, not_probed: 'the base call could not be built (the object did not read back, or the arguments did not render)' };
  {
    const r0 = await A.call({ ...b0 }, ctx.session.stepId(`in5.${s.tool}.base_call`));
    o.used++;
    if (!r0.ok) return { ...o, not_probed: `the base call did not succeed (${short(r0.text ?? r0.rpc_error?.message ?? r0.transport_error ?? (r0.timed_out ? 'timed out' : 'error'), 160)}), so no probe would be sent in an otherwise valid call` };
  }
  const baseNow = (await A.base()) ?? b0;

  // Which arguments keep the run prefix (the name cleanup finds the object by), and which are never probed.
  const keep = new Set<string>();
  for (const [k, v] of Object.entries(baseNow)) if (s.role !== 'read' && carries(v, [ctx.prefix])) keep.add(k);
  if (s.role !== 'read' && res.create?.name_path) keep.add(String(res.create.name_path.split('.')[0]).replace(/^\$\.?/, ''));
  const marks = [A.obj_id, ctx.driver.id, ctx.driver.scope, ...Object.values(res.vars)].filter((v) => v !== null && v !== undefined && v !== '');
  // why: the update tool is searched on scratch objects of the tester's own, so, unlike the MWS-IN probes on the object under
  // test (protectedProps, spec R15-4), any argument may be given another value there, except those that name the object, its
  // version or its scope (spec 7.3, rule 1).
  const prot = new Map(never);
  for (const [k, v] of Object.entries(baseNow)) if (!prot.has(k) && !keep.has(k) && carries(v, marks)) prot.set(k, 'its value names the object or the scope the call acts on (spec 7.3, rule 1)');

  type Planned = In5Probe & { phase: Phase };
  const perArg = new Map<string, Planned[]>();
  const integer = (arg: string) => isObj(props[arg]) && (props[arg] as Obj)['type'] === 'integer';
  for (const arg of Object.keys(props)) {
    if (prot.has(arg)) {
      o.args.push({ arg, probes: 0, skipped: `not probed: ${prot.get(arg)}`, rule: 'names the object, scope, version or key' });
      continue;
    }
    const g = in5Probes(schema, baseNow, arg, { payload_bytes: payload, keep_prefix: keep.has(arg) ? ctx.prefix : null, hints, role: s.role === 'read' ? 'read' : 'write' });
    const list: Planned[] = g.probes.map((p) => ({ ...p, phase: 'search' as Phase }));
    if (s.role === 'update') {
      for (const tv of res.try_values.filter((x) => x.arg === arg)) {
        const value = tv.value !== undefined ? render(tv.value, ctx.driver.vars()) : keep.has(arg) ? `${ctx.prefix}${'x'.repeat(Math.max(0, tv.length! - ctx.prefix.length))}` : 'x'.repeat(tv.length!);
        if (validates(props[arg], value, schema) !== true || validates(schema, { ...baseNow, [arg]: value }) !== true) {
          o.notes.push(`Declared value ${arg}=${shown(value)} (try_values) is not valid by the schema, so it was not sent (it would be MWS-IN-3).`);
          continue;
        }
        list.push({ arg, cls: 'declared', value, source: 'declared', why: 'a value the declaration lists (try_values)', phase: 'declared', ...(typeof value === 'string' ? { dim: 'length' as Dim, n: [...value].length } : typeof value === 'number' ? { dim: 'value' as Dim, n: value } : {}) });
      }
    }
    o.args.push({ arg, probes: list.length, ...(list.length ? {} : { skipped: `no probe: ${g.skipped ?? 'none valid by the schema'}` }), ...(g.rule && !list.length ? { rule: g.rule } : {}) });
    if (list.length) perArg.set(arg, list);
  }

  // --- one call -----------------------------------------------------------------------------------------------------------
  const budget = ctx.manifest.limits.write_budget;
  const reserve = await laterWrites(ctx, res);
  const values = new Map<In5Call, unknown>();
  const send = async (c: Ctx5, p: { arg: string; cls: string; value: unknown; dim?: Dim; n?: number; plain_len?: number }, phase: Phase, extra: Partial<In5Call> = {}): Promise<In5Call | null> => {
    if (o.used >= cap) {
      o.cut ??= `the per-tool cap of ${cap} calls (${s.role === 'create' ? 'limits.in5_creates for a create tool' : 'limits.in5_probes'}) was reached`;
      return null;
    }
    if (s.role !== 'read' && ctx.session.writes + 4 > budget - reserve) {
      o.cut ??= `the search stopped ${reserve} writes short of the write budget (${budget}): the writes the later checks plan`;
      return null;
    }
    c.probing?.(p.arg);
    const b = await c.base();
    if (!b) {
      o.notes.push(`Context ${c.name}: the base call could not be built for ${p.arg}=${shown(p.value)}; not sent.`);
      return null;
    }
    const args = { ...b, ...(c.vary?.(p.arg) ?? {}), [p.arg]: p.value };
    if (validates(schema, args) !== true) {
      o.notes.push(`${p.arg}=${shown(p.value)}: with the base call of context ${c.name} the arguments are not valid by the schema, so it was not sent.`);
      return null;
    }
    o.used++;
    const step = ctx.session.stepId(`in5.${s.tool}.${p.arg}.${p.cls}`);
    const r = await c.call(args, step);
    const varied = c.variedFor?.(p.arg) ?? c.varied;
    const call: In5Call = { arg: p.arg, cls: p.cls, value: shown(p.value), ...(p.dim ? { dim: p.dim } : {}), ...(p.n !== undefined ? { n: p.n } : {}), ...(p.plain_len !== undefined ? { plain_len: p.plain_len } : {}), ...(integer(p.arg) ? { integer: true } : {}), phase, context: c.name, ...(varied.length ? { varied } : {}), ...(c.name === 'B' ? { fresh: varied.length > 0 } : {}), ok: r.ok, isError: r.isError, rpc_error: r.rpc_error, text: r.text === null ? (r.rpc_error?.message ?? null) : short(r.text, 2000), step: r.step ?? step, ...(unknownOutcome(r) ? { indeterminate: true } : {}), ...extra };
    if (phase === 'declared' && r.ok && !call.indeterminate && c.stored) call.stored = await c.stored(p.arg, p.value);
    o.calls.push(call);
    values.set(call, p.value);
    return call;
  };

  const bOpen = async (): Promise<boolean> => {
    if (B) return !B.why;
    B = s.role === 'read' ? readB(A, o.calls, values, prot, keep) : await mk('B');
    if (B.why) o.notes.push(`The fresh context for the repeats could not be made: ${B.why}.`);
    return !B.why;
  };
  await searchPhases({
    perArg,
    props,
    schema,
    keepPrefix: (arg) => (keep.has(arg) ? ctx.prefix : null),
    payload,
    calls: o.calls,
    values,
    stopped: () => o.cut !== null,
    send: (where, p, phase, extra) => (where === 'A' ? send(A, p, phase, extra) : send(B!, p, phase, extra)),
    openB: bOpen,
  });
  return o;
}

type Probe5 = { arg: string; cls: string; value: unknown; dim?: Dim; n?: number; plain_len?: number };
export interface SearchIO {
  perArg: Map<string, (In5Probe & { phase: Phase })[]>;
  props: Obj;
  schema: unknown;
  keepPrefix(arg: string): string | null;
  payload: number;
  /** Every call sent so far, in order (the send below appends to it). */
  calls: In5Call[];
  /** The value each call sent (for a neighbour sent again). */
  values: Map<In5Call, unknown>;
  stopped(): boolean;
  send(where: 'A' | 'B', p: Probe5, phase: Phase, extra?: Partial<In5Call>): Promise<In5Call | null>;
  /** Make context B; false where it cannot be made. */
  openB(): Promise<boolean>;
}

/**
 * The three phases of the search for one tool, apart from how a call is sent (so a test drives the same code with a simulated
 * server): 1. the probes, interleaved; 2. the boundaries, by bisection; 3. the repeats in context B, each refused value followed
 * by its accepted neighbour.
 */
export async function searchPhases(io: SearchIO): Promise<void> {
  // --- 1. the search ------------------------------------------------------------------------------------------------------
  // why: review M3: the probes are not sent in ascending order. A deterministic interleaving (round-robin over the arguments,
  // each argument's probes in a fixed scrambled order) makes a failure that begins at some point of the run show as refusals on
  // both sides of an order, which the reading does not take for a bound.
  for (const p of interleave([...io.perArg.values()])) if (!(await io.send('A', p, p.phase)) && io.stopped()) break;

  // --- 2. the boundaries, by bisection ------------------------------------------------------------------------------------
  for (const arg of io.perArg.keys()) {
    for (const dim of ['length', 'value', 'items'] as Dim[]) {
      for (const side of ['upper', 'lower'] as const) {
        for (let i = 0; i < MAX_BISECT && !io.stopped(); i++) {
          const b = boundaryOf(io.calls.filter((c) => c.arg === arg), dim)[side];
          const next = b ? bisectNext(b.acc, b.ref) : null;
          if (next === null) break;
          const v = orderedValue(io.props[arg], dim, next, io.keepPrefix(arg), io.payload);
          if (v === null || validates(io.props[arg], v, io.schema) !== true) break;
          const c = await io.send('A', { arg, cls: `bisect.${dim}`, value: v, dim, n: next }, 'bisect');
          // why: review M7: an answer left out of the reading (a rate limit, an unknown outcome) does not move the boundary, so
          // the same value would be sent again: the bisection of this side stops.
          if (!c || excludedWhy(c) !== null) break;
        }
      }
    }
  }

  // --- 3. the repeats, in a fresh context: the refused value, then its accepted neighbour (review M3) ---------------------
  const repeats: { p: Probe5; nb: Probe5 }[] = [];
  for (const arg of io.perArg.keys()) {
    const mine = io.calls.filter((c) => c.arg === arg);
    for (const dim of ['length', 'value', 'items'] as Dim[]) {
      const b = boundaryOf(mine, dim);
      for (const cand of [b.upper, b.lower]) {
        if (!cand) continue;
        const v = orderedValue(io.props[arg], dim, cand.ref, io.keepPrefix(arg), io.payload);
        const nv = orderedValue(io.props[arg], dim, cand.acc, io.keepPrefix(arg), io.payload);
        if (v !== null && nv !== null) repeats.push({ p: { arg, cls: `repeat.${dim}`, value: v, dim, n: cand.ref }, nb: { arg, cls: `repeat.${dim}`, value: nv, dim, n: cand.acc } });
      }
    }
    for (const c of mine.filter((x) => x.context === 'A' && x.cls.startsWith('chars.') && refusedCall(x) && excludedWhy(x) === null)) {
      const plain = mine.find((x) => x.cls === 'plain' && x.n === c.plain_len && !refusedCall(x));
      const p = io.perArg.get(arg)!.find((x) => x.cls === c.cls);
      if (plain && p) repeats.push({ p: { arg, cls: c.cls, value: p.value, ...(p.plain_len !== undefined ? { plain_len: p.plain_len } : {}) }, nb: { arg, cls: 'plain', value: io.values.get(plain), dim: 'length', n: plain.n! } });
    }
  }
  if (repeats.length && !io.stopped() && (await io.openB())) {
    for (const r of repeats) {
      if (!(await io.send('B', r.p, 'repeat', { repeat_of: 'refused' }))) break;
      if (!(await io.send('B', r.nb, 'repeat', { repeat_of: 'neighbour' }))) break;
    }
  }
}

/**
 * Context B of a read tool (review M4): the same call with another argument the search may probe set to a value of its own that
 * was accepted in context A (the one sent first), so a constraint across two arguments (page and per_page) does not repeat as
 * one on a single argument. Where no other argument can be varied, the repeat is still sent, and marked not fresh.
 */
function readB(A: Ctx5, calls: In5Call[], values: Map<In5Call, unknown>, prot: Map<string, string>, keep: Set<string>): Ctx5 {
  const accepted = new Map<string, unknown>();
  for (const c of calls) if (c.context === 'A' && c.ok && !c.indeterminate && !accepted.has(c.arg) && !prot.has(c.arg) && !keep.has(c.arg)) accepted.set(c.arg, values.get(c));
  const pick = (arg: string): [string, unknown] | null => [...accepted].find(([k]) => k !== arg) ?? null;
  return {
    ...A,
    name: 'B',
    varied: [],
    vary: (arg) => {
      const v = pick(arg);
      return v ? { [v[0]]: v[1] } : {};
    },
    variedFor: (arg) => {
      const v = pick(arg);
      return v ? [`${v[0]} = ${shown(v[1])} (another argument, a value accepted in the search)`] : [];
    },
  };
}

/** A fixed scramble of a list (FNV-1a of each item's class and position), so the order is the same on every run. */
function scrambled<T extends { cls: string; n?: number; arg: string }>(xs: T[]): T[] {
  const h = (x: T): number => {
    let v = 0x811c9dc5;
    for (const ch of `${x.arg}|${x.cls}|${x.n ?? ''}|${xs.indexOf(x)}`) v = Math.imul(v ^ ch.charCodeAt(0), 0x01000193) >>> 0;
    return v;
  };
  return [...xs].sort((a, b) => h(a) - h(b));
}

/** Round-robin over the arguments, each argument's probes scrambled (review M3). */
export function interleave<T extends { cls: string; n?: number; arg: string }>(lists: T[][]): T[] {
  const qs = lists.map((l) => scrambled(l));
  const out: T[] = [];
  for (let i = 0; qs.some((q) => i < q.length); i++) for (const q of qs) if (i < q.length) out.push(q[i]!);
  return out;
}

/**
 * The writes the checks after this one plan (review S7): the later resources' checks and set-up, and the server-wide checks.
 * The search stops that many writes short of the budget (at least 20), so it never takes what a later check needs.
 */
async function laterWrites(ctx: RunContext, res: ResourceSpec): Promise<number> {
  try {
    const { CHECKS, GLOBAL_CHECKS } = await import('./index.js');
    const pc: PlanContext = { manifest: ctx.manifest, tools: ctx.tools, ...(ctx.gated !== undefined ? { gated: ctx.gated } : {}) };
    const i = ctx.manifest.resources.findIndex((r) => r.name === res.name);
    let n = 0;
    for (const r of ctx.manifest.resources.slice(i + 1)) {
      n += r.update ? 4 : 0;
      for (const c of CHECKS) if (c.id !== ID && (!c.needsUpdate || (r.update && r.fields))) n += c.plan(pc, r).writes;
    }
    for (const g of GLOBAL_CHECKS) n += g.plan(pc).writes;
    return Math.max(20, n);
  } catch {
    return Math.max(20, Math.floor(ctx.manifest.limits.write_budget * 0.05));
  }
}

/** The MWS-IN-5 record of one tool (spec 8.2, rule 8: `violated` or `not observed`, beyond `not tested` and `not applicable`). */
export function in5SearchVerdict(o: ToolObs5, res: ResourceSpec, mode: 'declaration' | 'tester' = IN5_READING.value): Result {
  const w = wp(res.name, o.tool);
  if (o.halted) return result('MWS-IN-5', w, SC, 'not tested', `${o.tool} was not probed further after a failed put-back (spec R15-4): ${short(o.halted, 300)}. The MWS-IN-5 search sent nothing to it.`);
  if (!o.args_total) return result('MWS-IN-5', w, SC, 'not applicable', `the input schema of ${o.tool} declares no argument, so no constraint on an argument's value can be enforced`);
  const fixed: FixedDecl[] = o.role === 'update' ? res.fixed_constraints : [];
  const rd = readIn5(o.calls, fixed);
  const judgedCalls = o.calls.filter((c) => excludedWhy(c) === null);
  // review M5: an argument counts as searched only with at least one judged call; the denominator leaves out the arguments not
  // searchable by rule (an identifier, scope, version or key; enum or const; boolean; object; a format the tester cannot check).
  const judgedArgs = new Set(judgedCalls.map((c) => c.arg));
  const searchable = o.args.filter((a) => !a.rule);
  const skippedBy: Record<string, number> = {};
  for (const a of o.args.filter((x) => x.rule)) skippedBy[a.rule!] = (skippedBy[a.rule!] ?? 0) + 1;
  const complete = searchable.filter((a) => {
    const mine = o.calls.filter((c) => c.arg === a.arg && c.context === 'A' && (c.phase === 'search' || c.phase === 'declared'));
    return a.probes > 0 && mine.length >= a.probes && mine.every((c) => excludedWhy(c) === null);
  });
  const refusals = o.calls.filter((c) => refusedCall(c) && excludedWhy(c) === null);
  const counted = rd.confirmed.filter((k) => k.reading_by === 'declaration' || mode === 'tester');
  const candidates = rd.confirmed.filter((k) => !counted.includes(k));
  const constraintsOf = (ks: Constraint[], candidate: boolean) => ks.map((k) => ({ arg: k.arg, keyword: k.keyword, bound: k.bound, exact: k.exact, accepted_at: k.accepted_at, refused_at: k.refused_at, ...(k.cls ? { class: k.cls } : {}), reading_by: k.reading_by, ...(candidate ? { candidate: true } : {}) }));
  const numbers = {
    args_total: o.args_total,
    args_searchable: searchable.length,
    args_judged: judgedArgs.size,
    args_probed: judgedArgs.size,
    args_complete: complete.length,
    args_skipped: skippedBy,
    probes: o.used,
    judged: judgedCalls.length,
    refusals: refusals.length,
    confirmed: counted.length,
    candidates: candidates.length,
    excluded: rd.excluded.length,
    cap: o.cap,
    reading: mode,
    ...(o.cut ? { cut: true } : {}),
    ...(rd.confirmed.length ? { constraints: [...constraintsOf(counted, false), ...constraintsOf(candidates, true)] } : {}),
  };
  const scope = `Scope of the search: ${judgedArgs.size} of ${searchable.length} searchable argument(s) of ${o.tool} judged (${o.args_total} in all; ${complete.length} searched in full), ${o.used} call(s) (at most ${o.cap}), ${judgedCalls.length} judged, from the declared call ${o.from}${o.role === 'update' ? ", on scratch objects of the tester's own" : o.role === 'create' ? ', each accepted create cleaned up' : ', paced like writes'}. Classes: string lengths 0, 1, 255, 256, 1024, 4096, 65536 within the declared bounds, eight character classes beside a plain value of the same length (UTF-16 units), format extremes, numbers 0 and ±1 with the extremes on write tools (±2^31, 2^53-1, within an integer format) and up to a declared maximum on read tools, fractions for numbers, arrays of 0, 1, 100 and 1000 items on read tools and 0, 1, 2 and the declared maxItems on write tools, the bounds stated in words, and the declared try_values; enums, consts, booleans, objects and formatted items are not searched. Probes are sent interleaved, not in ascending order.`;
  const argNotes = o.args.filter((a) => a.skipped).map((a) => `${a.arg}: ${a.skipped}`);
  const reading = (k: Constraint) => `${describe(k)}. Reading by: ${k.reading_by}${k.reading_by === 'declaration' ? ' (fixed_constraints)' : ' (a neighbour accepted in the same context, the refusal repeated in a fresh context with another argument varied and its neighbour accepted again after it, and on an order a monotonic boundary; spec MWS-IN-5, draft 0.10)'}. The refusal: ${JSON.stringify(k.text)} (names the argument: ${k.refusal.names_arg ? 'yes' : 'no'}; kind: ${k.refusal.kind}${k.refusal.states_bound === null ? '' : `; states the bound: ${k.refusal.states_bound ? 'yes' : 'no'}`}${k.refusal.server_failure ? '; a server failure, not a validation answer' : ''}).`;
  const notes = [
    scope,
    ...(argNotes.length ? [`Arguments not searched: ${argNotes.join('; ')}.`] : []),
    ...(o.cut ? [`The search was cut: ${o.cut}. Raise the limit to search further.`] : []),
    ...(o.hints.length ? [`Bounds stated in words, probed at N and N+1: ${o.hints.slice(0, 8).map((h) => `${h.arg} ${h.kind}${h.n !== undefined ? ` ${h.n}` : ''}${h.text ? ` ${JSON.stringify(h.text)}` : ''} (${h.source}: ${JSON.stringify(short(h.quote, 80))})`).join('; ')}${o.hints.length > 8 ? '; …' : ''}.`] : []),
    ...o.notes,
    ...rd.excluded.filter((x) => refusedCall(x.call) || x.call.indeterminate).slice(0, 10).map((x) => `Excluded from the reading: ${x.call.arg}=${x.call.value} (${x.call.cls}, step ${x.call.step}): ${x.why}${x.call.text ? `: ${JSON.stringify(short(x.call.text, 160))}` : ''}.`),
  ];
  const candNotes = candidates.map((k) => `Candidate constraint, seen, not judged: ${reading(k)} The tester's differential reading is a source of this verdict only in the draft for MWS 0.10; run with --in5-reading=tester to record it as violated.`);
  const seen = rd.seen.map((x) => `Seen, not judged: ${x.call.arg}=${x.call.value} (${x.call.cls}, step ${x.call.step}) was refused${x.call.ok ? ' (answered as a success, and the value is not stored)' : ''}: ${JSON.stringify(x.call.text ?? '')}. ${x.why}; neither the declaration (fixed_constraints) nor the tester's differential reading states that the constraint is fixed.`);
  if (o.not_probed) return result('MWS-IN-5', w, SC, 'not tested', `${o.tool} was not searched: ${o.not_probed}`, { numbers, notes });
  if (counted.length) {
    const opts: NonNullable<Parameters<typeof result>[5]> & { evidence?: { acknowledged?: boolean | null; read_back?: boolean | null; synthetic_fault?: boolean | null } } = {
      numbers,
      steps: counted.flatMap((k) => k.steps),
      notes: [...counted.map(reading), ...notes, ...candNotes, ...seen],
      // why: lane F1 (docs/CELLS.md, rule 4): the evidence the check knows. The violation rests on refusals, not on writes the
      // server acknowledged, and nothing was injected by the gate.
      evidence: { synthetic_fault: false, ...(o.calls.some((c) => c.phase === 'declared' && c.stored === false) ? { read_back: true } : {}) },
    };
    return result('MWS-IN-5', w, SC, 'violated', `${o.tool} refused value(s) valid by its input schema under a fixed constraint on one argument that the schema does not declare: ${counted.map(describe).join('; ')}.`, opts);
  }
  // review M5: a search with no judged call examined nothing.
  if (!judgedCalls.length) return result('MWS-IN-5', w, SC, 'not tested', o.calls.length ? `every call the search sent to ${o.tool} was left out of the reading (an unknown outcome, a rate limit, the backend's state), so nothing was examined` : `no probe could be sent to ${o.tool}: ${argNotes.length ? argNotes.join('; ') : 'no argument the search may probe has a value valid by its schema'}`, { numbers, notes });
  const lead = candidates.length
    ? `${o.tool} refused value(s) valid by its schema at ${candidates.length} candidate constraint(s) that only the tester's differential reading confirms (${candidates.map(describe).join('; ')}); in this release that reading alone does not give violated (spec MWS-IN-5, draft 0.10).`
    : refusals.length
      ? `${o.tool} refused ${refusals.length} of the ${judgedCalls.length} judged value(s) valid by its schema; none was shown to rest on a fixed constraint, and each is listed, seen, not judged.`
      : `${o.tool} accepted all ${judgedCalls.length} judged value(s) valid by its schema that the search sent.`;
  return result('MWS-IN-5', w, SC, 'not observed', `${lead} This is a search (spec 8.2, rule 8): ${judgedArgs.size} of ${searchable.length} searchable argument(s) judged.`, { numbers, notes: [...notes, ...candNotes, ...seen] });
}
