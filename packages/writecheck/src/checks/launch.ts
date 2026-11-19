/**
 * Start-up settings meant to stop writes (black-box, launch): the tester starts separate server
 * processes with the setting given a value, against the same backend, and tries a write on an
 * object it created before the restart.
 *
 *   MWS-CFG-1  the read-only setting set to yes, on, enabled, 1, TRUE and a misspelling of a valid
 *              value; on an inverted switch (the restricting value reads as false, an allow-write flag)
 *              FALSE, False, no, off, 0, disabled and a misspelling of the false word instead (and empty, if the declaration says the server tells empty from unset), less the
 *              declared values that permit writes: for each, the server either does not start, or starts
 *              with writes refused; where a write is applied, every declared write tool is called under
 *              the value, and only a value every tool accepts is judged here (some refusing: MWS-CFG-3)
 *   MWS-CFG-2  a deny-list naming one misspelled tool: the server refuses to start, or starts with every write
 *              tool absent or refusing (each called on the run's objects, as in read-only mode, the tools marked
 *              read-only that have a `calls` entry included; a write through one of them is violated)
 *   MWS-CFG-4  an allow-list naming one misspelled tool: the server refuses to start (SHOULD)
 *   MWS-CFG-3  read-only mode: every declared write tool, listed or not, whatever its annotations, is
 *              absent or refused, and no object changes. Each tool marked read-only (readOnlyHint: true, or a
 *              declared read tool) that has an entry in the manifest's `calls` is called too, with that entry's
 *              arguments and resource as the annotation checks call it: a change through it is violated; a refusal,
 *              or an answer with no change to the watched object, counts as held; a call that failed without
 *              a refusal (timeout, lost connection, an error MCP defines), an input_required or task answer,
 *              a call that could not be made, or an object not read back leaves it not tested (the record
 *              names the tool and why); an object deleted is a change; one with no `calls` entry is not called
 *
 * A server the tester cannot start at all (with no setting) makes these `not tested`.
 */

import { multiGate } from './multi.js';
import { multiBinding } from '../core/manifest.js';
import { fromDeclaration, saidBy, says } from './says.js';
import { declaredWriteTools, readOnlyMarkedCalls } from './coverage.js';
import { baseVars, deleteArgs, needsVersion, type Driver } from '../core/driver.js';
import type { ResourceSpec } from '../core/manifest.js';
import { definitelyGone, goneFrom } from '../core/objects.js';
import { LaunchInitFailed, type LaunchResult } from '../core/session.js';
import { render } from '../core/template.js';
import { deepEqual, diff, getPath, short, withoutIgnored } from '../core/util.js';
import { result, type Result } from '../report/verdicts.js';
import { ignoredPaths } from './readback.js';
import { listScope, newScope, scratch } from './scratch.js';
import { mcpDefinedError, schemaProps, sw, toolByName, type GlobalCheck, type Observation, type PlanContext, type PlannedCheck, type RunContext } from './types.js';

const ID = 'launch-settings';
const VERSION = '1';

/**
 * MWS-CFG-4's echo rule (owner's decision on review item S1, 15 Nov 2026): an error from tools/list counts as refusing the list
 * only where it names, as a whole word, the exact misspelled tool name the tester invented. No word list is read; any other
 * error needs reading.
 */
/** The error's message: the JSON-RPC error message where the list error carries one, else the text after the label. */
export function listErrorMessage(e: string): string {
  const i = e.indexOf('{');
  if (i >= 0) {
    try {
      const j = JSON.parse(e.slice(i, e.lastIndexOf('}') + 1)) as { message?: unknown; error?: { message?: unknown } };
      const m = j.error?.message ?? j.message;
      if (typeof m === 'string') return m;
    } catch {
      /* not JSON */
    }
  }
  return e.replace(/^tools\/list failed on [^:]+: /, '');
}

export function namesInvented(f: { env: string; value: string; list_error?: string | null; invented?: string }): { invented: string; line: string } | null {
  // why: an error cut at the clip may have lost words that change its meaning.
  if (!f.list_error || f.list_error.endsWith('…')) return null;
  const invented = f.invented ?? f.value.split(/[,;|\s]+/).filter(Boolean).pop() ?? '';
  if (!invented) return null;
  const msg = listErrorMessage(f.list_error);
  const esc = invented.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`(^|[^A-Za-z0-9_])${esc}($|[^A-Za-z0-9_])`).test(msg)) return null;
  return { invented, line: `Decided by MWS-CFG-4's echo rule: the error names the exact misspelled tool the tester invented (${JSON.stringify(invented)}), on the text ${JSON.stringify(short(msg, 200))}.` };
}

/** A misspelling: the first two letters swapped (or a letter dropped for a one-letter value). */
export const misspell = (s: string): string => (s.length >= 2 ? `${s[1]}${s[0]}${s.slice(2)}` : `${s}x`);

interface Start {
  value: string;
  started: boolean;
  reason: string | null;
  /** The write probe on a started server: answered as a success, and whether the object changed. */
  /** changed: null when the object did not read back around the write. */
  write: { ok: boolean; changed: boolean | null; step: string } | null;
  /** The server started, but its session.init failed: this value was not tried. */
  init_failed?: string;
  /** Where the write probe was accepted: every declared write tool called under the same value (spec R7-6), to tell an unrecognized value from a partial leak (MWS-CFG-3). */
  tools?: Cfg3Call[];
}

interface Cfg3Call {
  tool: string;
  absent: boolean;
  ok: boolean;
  effect: string | null;
  step: string | null;
  skipped?: string;
  /** The read-back could show whether the call wrote (a call is accepted when the read-back shows its write). */
  observed?: boolean;
  /** The answer was input_required or a task: neither a refusal nor a success. */
  pending?: boolean;
  /** The answer was a JSON-RPC error that MCP defines for the case (a missing client capability, say): not a refusal by the setting. */
  defined?: string;
  /**
   * A tool marked read-only (how: readOnlyMarkedCalls), called because the manifest's `calls` gives it arguments. It is a read
   * unless it changes something: a change is a violation; a refusal, or an answer with the object read back unchanged, counts
   * toward held; a call that failed without a refusal, or an object that could not be read back, leaves the record not tested.
   */
  marked?: string;
  /** A tool marked read-only whose call failed without a refusal (a timeout, a lost connection, an error MCP defines for the case), or could not be set up: why. */
  failed?: string;
}

interface LaunchObs {
  baseline: { started: boolean; reason: string | null };
  /** baseline_tools: every declared write tool called on a server started with no setting, where a value's follow-up ran (a positive control). */
  /** polarity, basis: how the probes were derived from the declared restricting value (normal or inverted switch); absent in older evidence. */
  cfg1: { env: string; starts: Start[]; baseline_tools?: Cfg3Call[]; polarity?: Cfg1Polarity; basis?: string; opposite?: string[] } | null;
  /** invented: the misspelled tool name the tester put in the list (MWS-CFG-4's echo rule). */
  cfg2: { env: string; kind: string; value: string; started: boolean; reason: string | null; calls?: Cfg3Call[]; list_error?: string | null; invented?: string; init_failed?: string }[];
  cfg3: { env: string; started: boolean; reason: string | null; calls: Cfg3Call[]; init_failed?: string } | null;
  skipped?: string;
}

const why = (r: LaunchResult) => (r.started ? null : `${r.reason}${r.exit_code !== null ? ` (exit ${r.exit_code})` : ''}${r.stderr_tail ? `: ${short(r.stderr_tail, 160)}` : ''}`);

/** The resource whose object the write probes use: the first with an update tool and an object under test. */
const probeResource = (ctx: PlanContext): ResourceSpec | undefined => ctx.manifest.resources.find((r) => r.update && r.fields);

export const launchCheck: GlobalCheck = {
  id: ID,
  version: VERSION,
  requirements: ['MWS-CFG-1', 'MWS-CFG-2', 'MWS-CFG-3', 'MWS-CFG-4'],
  plan(ctx: PlanContext): PlannedCheck {
    const base: PlannedCheck = { check: ID, version: VERSION, resource: '(server)', runs: false, calls: [], writes: 0, creates: 0, notRun: [] };
    const sc = { id: ID, version: VERSION };
    const st = ctx.manifest.settings;
    const nr: Result[] = [];
    if (!st.read_only) nr.push(...(['MWS-CFG-1', 'MWS-CFG-3'] as const).map((id) => result(id, sw('(read-only setting)'), sc, 'not tested', 'no settings.read_only in the manifest: if the server has a read-only mode, declare its environment variable and the value that turns it on')));
    if (!st.tool_filters.some((f) => f.kind === 'deny')) nr.push(result('MWS-CFG-2', sw('(tool filter)'), sc, 'not tested', 'no deny-list in settings.tool_filters: if the server has a setting that denies tools by name, declare its environment variable (kind: deny)'));
    if (!st.tool_filters.some((f) => f.kind === 'allow')) nr.push(result('MWS-CFG-4', sw('(tool filter)'), sc, 'not tested', 'no allow-list in settings.tool_filters: if the server has a setting that allows tools by name, declare its environment variable (kind: allow)'));
    // why: spec 516c4ed lets each setting be applied at start or with a request; the request form is declared and not tested here.
    for (const pr of st.per_request ?? []) {
      const ids = pr.kind === 'read_only' ? (['MWS-CFG-1', 'MWS-CFG-3'] as const) : pr.kind === 'deny' ? (['MWS-CFG-2'] as const) : (['MWS-CFG-4'] as const);
      for (const id of ids) nr.push(result(id, sw(pr.name), sc, 'not tested', `${pr.name} is applied with a request: not built in this preview (only settings applied at start are tested)`));
    }
    if (!st.read_only && !st.tool_filters.length) return { ...base, notRun: nr };
    if (ctx.manifest.server.url) return { ...base, notRun: [...nr, ...(['MWS-CFG-1', 'MWS-CFG-2', 'MWS-CFG-3', 'MWS-CFG-4'] as const).filter((id) => !nr.some((x) => x.requirement === id)).map((id) => result(id, sw('(settings)'), sc, 'not tested', 'launch checks need a server the tester starts (server.stdio or server.launch); server.url is started by someone else'))] };
    const calls: string[] = ['start the server once with no setting (it must start)'];
    const marked = [...readOnlyMarkedCalls(ctx.manifest, ctx.tools).keys()];
    const alsoMarked = marked.length ? `, and each tool marked read-only that has a calls entry (${marked.join(', ')}) with that entry's arguments on a scratch object` : '';
    if (st.read_only) {
      const pb = cfg1Probe(st.read_only);
      // why: the plan's text for a normal switch is as before (its hash with it); an inverted or mixed one says which polarity it probes.
      calls.push(`MWS-CFG-1: start with ${st.read_only.env} = ${pb.values.map((v) => JSON.stringify(v)).join(', ')}${pb.polarity === 'normal' ? '' : ` (${pb.polarity} switch: the restricting value reads as ${pb.polarity === 'inverted' ? 'false' : 'both true and false'})`}; on each that starts, one write on the run's object, and where it is applied, every declared write tool under the same value`);
      calls.push(`MWS-CFG-3: start with ${st.read_only.env}=${st.read_only.on}; call every declared write tool on objects created before the restart${alsoMarked}; read back`);
    }
    for (const f of st.tool_filters) calls.push(f.kind === 'deny' ? `MWS-CFG-2: start with ${f.env} (deny-list) naming one misspelled tool; if it starts, a write probe${marked.length ? ` (every declared write tool${alsoMarked})` : ''}` : `MWS-CFG-4: start with ${f.env} (allow-list) naming one misspelled tool`);
    return { ...base, runs: true, calls, writes: 30, creates: 10, notRun: nr };
  },
  async collect(ctx): Promise<Observation> {
    const st = ctx.manifest.settings;
    const obs: LaunchObs = { baseline: { started: false, reason: null }, cfg1: null, cfg2: [], cfg3: null };
    const labelOf = (t: string) => ctx.label(`LAUNCH.${t}`);
    const start = async (env: Record<string, string>, tag: string): Promise<{ label: string; r: LaunchResult }> => {
      const label = labelOf(tag);
      // why: follow-up to PR #14 (A): a server whose session.init fails leaves only the setting it was started for not tested.
      try {
        return { label, r: await ctx.session.launch({ label, env }) };
      } catch (e) {
        if (e instanceof LaunchInitFailed) return { label, r: { started: false, exit_code: null, reason: e.message, stderr_tail: '', init_failed: e.message } };
        throw e;
      }
    };
    const b = await start({}, 'base');
    obs.baseline = { started: b.r.started, reason: why(b.r) };
    const pr = probeResource(ctx);
    // why: spec R15-4: an object that could not be put back after a control is used in no later test.
    const pd0 = pr ? ctx.drivers.get(pr.name) : undefined;
    const pd = pd0 && !pd0.unusable ? pd0 : undefined;
    // Positive control: a server started with no setting must accept the probe write, or a refusal later shows nothing.
    const base = b.r.started && pr && pd ? await writeProbe(ctx, pr, pd, b.label) : null;
    await ctx.session.release([b.label]);
    if (!b.r.started && b.r.init_failed) return { check: ID, version: VERSION, resource: '(server)', data: { ...obs, skipped: `the server started with no setting, but ${b.r.init_failed}` } };
    if (!b.r.started) return { check: ID, version: VERSION, resource: '(server)', data: { ...obs, skipped: `the server does not start with no setting: ${why(b.r)}` } };
    if (base && !(base.ok && base.changed === true)) return { check: ID, version: VERSION, resource: '(server)', data: { ...obs, skipped: 'the positive control failed: a server started with no setting did not apply the probe write, so a refused write under a setting would show nothing' } };
    if (st.read_only) {
      const pb = cfg1Probe(st.read_only);
      obs.cfg1 = { env: st.read_only.env, starts: [], polarity: pb.polarity, basis: pb.basis, ...(pb.opposite.length ? { opposite: pb.opposite } : {}) };
      for (const v of pb.values) {
        const s = await start({ [st.read_only.env]: v }, 'cfg1');
        const rec: Start = { value: v, started: s.r.started, reason: why(s.r), write: null, ...(!s.r.started && s.r.init_failed ? { init_failed: s.r.init_failed } : {}) };
        if (s.r.started && pr && pd) rec.write = await writeProbe(ctx, pr, pd, s.label);
        await ctx.session.release([s.label]);
        // why: R7-6: an accepted write is judged here only where every declared write tool accepted one under the value;
        // where some refused, the server recognized the value and the leak is MWS-CFG-3's. So every tool is called.
        if (rec.write?.changed === true) {
          // why: a positive control, once: a tool that writes nothing with no setting at all (its call cannot work on the tester's
          // objects, say) shows nothing about the value; only tools that write without the setting are compared.
          if (!obs.cfg1.baseline_tools) {
            const b3 = await cfg3(ctx, st.read_only.env, '', start, {});
            if (b3?.started) obs.cfg1.baseline_tools = b3.calls;
          }
          const r3 = await cfg3(ctx, st.read_only.env, v, start);
          if (r3?.started) rec.tools = r3.calls;
          else if (r3?.init_failed) rec.init_failed = r3.init_failed;
        }
        obs.cfg1.starts.push(rec);
      }
      obs.cfg3 = await cfg3(ctx, st.read_only.env, st.read_only.on, start, undefined, { marked: true });
    }
    for (const f of st.tool_filters) {
      const names = ctx.tools.map((t) => t.name);
      const keep = probeResource(ctx)?.read.tool ?? names[0] ?? 'x';
      const bad = misspell(probeResource(ctx)?.update?.tool ?? names[1] ?? 'tool');
      if (f.kind === 'deny') {
        // why: held needs every declared write tool absent or refusing, so each is called, as in read-only mode.
        const r3 = await cfg3(ctx, f.env, bad, start, undefined, { marked: true });
        obs.cfg2.push({ env: f.env, kind: f.kind, value: bad, started: !!r3?.started, reason: r3?.reason ?? null, calls: r3?.calls ?? [], ...(r3?.init_failed ? { init_failed: r3.init_failed } : {}) });
        continue;
      }
      const value = [keep, bad].join(f.separator);
      const s = await start({ [f.env]: value }, 'cfg4');
      // why: spec MWS-CFG-4 is violated when tools/list, made with the list set, returns a result.
      let listed = false;
      let listError: string | null = null;
      if (s.r.started) {
        try {
          await ctx.session.listTools(s.label);
          listed = true;
        } catch (e) {
          listed = false;
          listError = short((e as Error).message, 300);
        }
      }
      obs.cfg2.push({ env: f.env, kind: f.kind, value, started: listed, reason: s.r.started ? (listed ? null : `the server started and refused tools/list${listError ? `: ${listError}` : ''}`) : why(s.r), list_error: listError, invented: bad, ...(!s.r.started && s.r.init_failed ? { init_failed: s.r.init_failed } : {}) });
      await ctx.session.release([s.label]);
    }
    return { check: ID, version: VERSION, resource: '(server)', data: obs };
  },
  evaluate(obs: Observation): Result[] {
    return launchVerdicts(obs.data as LaunchObs);
  },
};

/** What a value of a boolean-like switch means, read from its spelling: 'true' (yes, on, 1, ...), 'false' (no, off, 0, ...) or neither. */
export function switchSense(v: string): 'true' | 'false' | null {
  const t = v.trim();
  if (/^(1|true|t|yes|y|on|enabled?)$/i.test(t)) return 'true';
  if (/^(0|false|f|no|n|off|disabled?)$/i.test(t)) return 'false';
  return null;
}

/**
 * The polarity of the read-only switch (MWS-CFG-1), from the value that turns it on and the values declared to restrict writes:
 *   normal    the restricting values read as true (READ_ONLY=true): probes are truthy variants
 *   inverted  they read as false (an allow-write flag, ALLOW_WRITES=false): probes are falsy variants
 *   mixed     both (or a declaration that cannot be read either way): no spelling variant is sent, only a misspelling
 */
export type Cfg1Polarity = 'normal' | 'inverted' | 'mixed';

/** A misspelling inside the word: its third and fourth letters swapped (false → fasle), or misspell() for a short word. */
const transposeInner = (s: string): string => (s.length >= 4 ? `${s.slice(0, 2)}${s[3]}${s[2]}${s.slice(4)}` : misspell(s));

export interface Cfg1Probe {
  polarity: Cfg1Polarity;
  /** The values sent, in order. */
  values: string[];
  /** The candidates not sent because they mean the opposite of restrict (they would permit writes on this switch). */
  opposite: string[];
  /** One line for the evidence: the polarity and what it was read from. */
  basis: string;
}

export function cfg1Probe(ro: { on: string; valid: string[]; restrict?: string[]; empty_distinct: boolean }): Cfg1Probe {
  const valid = ro.valid.length ? ro.valid : [ro.on];
  const restrict = ro.restrict ?? [ro.on];
  // why: corpus finding (lane F9): a read-only switch can be an inverted allow-write flag, where the restricting value is "false".
  // There TRUE, yes, on or 1 mean "permit", so a write under them is the switch working, and judging it would accuse a correct
  // server. The variants are derived from the declared restricting value: its polarity decides which spellings are probed, and
  // a value whose meaning is the opposite of restrict is never sent as a restrict variant (a value the declaration itself
  // classes as restricting still is).
  const senses = new Set([ro.on, ...restrict].map(switchSense).filter((x) => x !== null));
  const polarity: Cfg1Polarity = senses.has('false') ? (senses.has('true') ? 'mixed' : 'inverted') : 'normal';
  const against = polarity === 'normal' ? 'false' : polarity === 'inverted' ? 'true' : null;
  // The misspelling is of a word with the restricting meaning: a typo of the permitting word is, if anything, a permit.
  const alpha = (v: string) => /^[a-z]{3,}$/i.test(v);
  let candidates: string[];
  if (polarity === 'inverted') {
    const word = [ro.on, ...restrict, ...valid].find((v) => alpha(v) && switchSense(v) === 'false') ?? 'false';
    candidates = ['FALSE', 'False', 'no', 'off', '0', 'disabled', transposeInner(word)];
  } else if (polarity === 'normal') {
    // why: the normal case keeps its list and its misspelling (the first alphabetic valid value), less a word that permits.
    candidates = ['yes', 'on', 'enabled', '1', 'TRUE', misspell(valid.find((v) => alpha(v) && switchSense(v) !== 'false') ?? ro.on)];
  } else candidates = [misspell(ro.on)];
  candidates = [...new Set([...candidates, ...(ro.empty_distinct ? [''] : [])])];
  const opposite = candidates.filter((v) => !restrict.includes(v) && (against === null ? switchSense(v) !== null : switchSense(v) === against));
  // why: spec R7-6: a probe the declaration lists as a valid value that permits writes is not sent; one that restricts writes is
  // sent. A listed value the declaration does not class is treated as permitting (sending it could accuse a correct server).
  const values = candidates.filter((v) => !opposite.includes(v) && (restrict.includes(v) || (!ro.valid.includes(v) && v !== ro.on)));
  const read = `${JSON.stringify(ro.on)}${restrict.filter((v) => v !== ro.on).length ? ` and the values declared to restrict (${restrict.filter((v) => v !== ro.on).map((v) => JSON.stringify(v)).join(', ')})` : ''}`;
  const basis =
    polarity === 'inverted'
      ? `Polarity: inverted (the restricting value ${read} reads as false, as on an allow-write flag); falsy variants were probed, and no value meaning true was sent as a restrict variant.`
      : polarity === 'mixed'
        ? `Polarity: mixed (the restricting values ${read} read as both true and false); no spelling variant was sent, only a misspelling of ${JSON.stringify(ro.on)}.`
        : `Polarity: normal (the restricting value ${read} reads as true, or as neither); truthy variants were probed.`;
  return { polarity, values, opposite, basis };
}

export function cfg1Values(ro: { on: string; valid: string[]; restrict?: string[]; empty_distinct: boolean }): string[] {
  return cfg1Probe(ro).values;
}

/** One write through a started server on the run's object; put back afterwards through the main connection. */
async function writeProbe(ctx: Omit<RunContext, 'driver'>, res: ResourceSpec, d: Driver, label: string): Promise<Start['write']> {
  const f = res.fields![0]!;
  const before = await d.readOnce('MAIN', ctx.session.stepId('cfg.probe.before'));
  const target = deepEqual(getPath(before.obj, f.path), f.values[1]) ? f.values[0] : f.values[1];
  const step = ctx.session.stepId('cfg.probe.write');
  const r = await d.update(label, f, target, { step });
  const after = await d.readSettled('MAIN', 'cfg.probe.after', (o) => deepEqual(getPath(o, f.path), target));
  const changed = before.ok && after.ok ? !deepEqual(getPath(before.obj, f.path), getPath(after.obj, f.path)) : null;
  await d.reset('MAIN');
  // why: an input_required or task answer is neither a refusal nor an acceptance; the probe shows nothing.
  if (r.result_type && r.result_type !== 'complete') return { ok: false, changed: null, step };
  return { ok: r.ok, changed, step };
}

async function cfg3(ctx: Omit<RunContext, 'driver'>, env: string, on: string, start: (e: Record<string, string>, t: string) => Promise<{ label: string; r: LaunchResult }>, envOverride?: Record<string, string>, o: { marked?: boolean } = {}): Promise<LaunchObs['cfg3']> {
  type Ran = { ok: boolean; effect: string | null; step: string; observed?: boolean; pending?: boolean; defined?: string; failed?: string };
  const prep: { tool: string; marked?: string; run: (label: string) => Promise<Ran> }[] = [];
  const main = 'MAIN';
  const seen = new Set<string>();
  const add = (tool: string, run: (label: string) => Promise<Ran>, marked?: string) => {
    if (seen.has(tool)) return;
    seen.add(tool);
    prep.push({ tool, run, ...(marked !== undefined ? { marked } : {}) });
  };
  // Objects for the calls are created now, before the restart, through the main connection.
  for (const res of ctx.manifest.resources) {
    const d = ctx.drivers.get(res.name);
    const ign = ignoredPaths(res);
    const snapCall = async (dd: Driver, tool: string, args: unknown, label: string, tag: string, meta?: Record<string, unknown>) => {
      const before = await dd.readOnce(main, ctx.session.stepId(`cfg3.${tag}.before`));
      const step = ctx.session.stepId(`cfg3.${tool}`);
      const r = await ctx.session.call(label, tool, args, { step, ...(meta ? { meta } : {}) });
      const defined = mcpDefinedError(r.rpc_error);
      const after = await dd.readSettled(main, `cfg3.${tag}.after`, () => false);
      const gone = !!after.call && (definitelyGone(after.call) || (after.call.ok && !!res.read.items && after.obj === null));
      const ch = gone ? ['(the object was deleted)'] : before.ok && after.ok ? withoutIgnored(diff(before.obj, after.obj), ign).map((e) => e.path) : [];
      const observed = gone || (before.ok && after.ok);
      // why: an input_required or task answer is neither a refusal nor a success; it is not counted as refused.
      if (r.result_type && r.result_type !== 'complete') return { ok: true, effect: ch.length ? ch.slice(0, 5).join(', ') : null, step, observed, pending: true };
      return { ok: r.ok, effect: ch.length ? ch.slice(0, 5).join(', ') : null, step, observed, ...(defined ? { defined } : {}) };
    };
    const fresh = async (tag: string) => {
      const s = await scratch({ ...ctx, driver: d }, res, { tag, purpose: `MWS-CFG-3 object for ${tag}`, label: main });
      return s.ok ? s.driver! : null;
    };
    if (res.update && d && d.id !== null && !d.unusable) add(res.update.tool, async (label) => {
      const f = res.fields![0]!;
      const base = await d.readOnce(main, ctx.session.stepId('cfg3.upd.base'));
      // why: a value the object already has cannot show a write; the call sets whichever declared value it does not have.
      const target = base.ok && deepEqual(getPath(base.obj, f.path), f.values[1]) ? f.values[0] : f.values[1];
      return snapCall(d, res.update!.tool, d.updateArgs(f, target, base.ok ? { obj: base.obj, version: base.version } : null), label, 'upd');
    });
    if (res.create) add(res.create.tool, async (label) => {
      const marker = ctx.marker('c3');
      const key = marker;
      const step = ctx.session.stepId(`cfg3.${res.create!.tool}`);
      const intent = ctx.ledger.intent(res.name, res.create!.tool, 'MWS-CFG-3 create in read-only mode');
      const r = await ctx.session.call(label, res.create!.tool, render(res.create!.args, baseVars(res, ctx.prefix, { scope: d?.scope ?? null, marker, key })), { step });
      // why: if read-only mode let the create through, the object exists and must be cleaned up; the prefix sweep finds it.
      ctx.ledger.append(r.ok ? { kind: 'create_unknown', intent, resource: res.name, reason: 'created in read-only mode (MWS-CFG-3)' } : { kind: 'create_failed', intent, resource: res.name, reason: 'refused in read-only mode' });
      let effect: string | null = null;
      let observed = false;
      if (r.ok) {
        const { idFromResult } = await import('../core/objects.js');
        const id = idFromResult(res, r);
        if (id !== null && d) {
          const back = await d.readOnce(main, ctx.session.stepId('cfg3.create.back'), id);
          if (back.ok) {
            effect = `created ${short(id, 30)}`;
            observed = true;
            ctx.ledger.append({ kind: 'created', intent, resource: res.name, id, name: null, via: 'result' });
          }
        }
      }
      // why: R7-6: the tester reads back whether the object exists, whatever the answer said (a create refused in words may still write).
      if (!effect) {
        const found = await existsByMarker(ctx, res, d ?? null, marker, main);
        if (found !== null) {
          observed = true;
          if (found.length) {
            effect = `created ${short(found[0], 30)} (found by its marker)`;
            ctx.ledger.append({ kind: 'created', intent, resource: res.name, id: found[0], name: null, via: 'result' });
          }
        }
      }
      return { ok: r.ok, effect, step, observed };
    });
    if (res.delete && res.create) add(res.delete.tool, async (label) => {
      const dd = await fresh('c3d');
      if (!dd) return { ok: false, effect: null, step: '' };
      // why: review (writesafe T2): a delete that takes the version gets the version just read, so a refusal is read-only mode.
      const cur = needsVersion(res.delete!.args) ? await dd.readOnce(label, ctx.session.stepId('cfg3.del.base')) : null;
      return snapCall(dd, res.delete!.tool, deleteArgs(res, dd.vars(cur?.ok ? { version: cur.version, object: cur.obj } : {}), toolByName(ctx.tools, res.delete!.tool)?.inputSchema), label, 'del');
    });
    for (const m of res.multi) add(m.tool, async (label) => {
      // why: note 27: the same gate as the multi-item check; a refusal is a "not called" line in the CFG-3 record.
      const gate = multiGate(ctx, res, m, 'cfg3');
      if (gate) throw new Error(gate);
      // why: owners' safety item 3: a call bounded by its container alone (a delete, or no {{ids}}) is never sent in the run's
      // container, which the tester has not confirmed holds nothing but its own objects and which is the server's default where it
      // could not be created. It gets a container of its own, created and confirmed to hold only the one object made in it.
      const bind = multiBinding(m.args, res.scope?.arg ?? null);
      if (bind.scope && (m.effect === 'deleted' || !bind.ids)) {
        const why = (s: string) => `${m.tool} is bounded by its container alone, and ${s}; it is called only inside a container the tester created for it and confirmed holds nothing but its own objects (spec 7.3, rule 1)`;
        if (!res.scope) throw new Error(why('the resource declares no scope (a container the tester can create)'));
        const c = await newScope(ctx, res, 'c3c', main);
        if (!c.ok) throw new Error(why(`its container could not be created (${c.reason})`));
        const s = await scratch({ ...ctx, ...(d ? { driver: d } : {}) }, res, { tag: 'c3m', purpose: 'MWS-CFG-3 object for a multi-item tool', label: main, scope: c.key });
        if (!s.ok) throw new Error(why(`its object could not be created in the container (${s.reason})`));
        const listed = await listScope(ctx, res, c.key, main);
        if (listed === null || listed.some((it) => !deepEqual(it.id, s.id))) throw new Error(why(listed === null ? 'the container could not be listed' : 'the container lists objects other than the one made for the call'));
        const own = s.driver!;
        const marker = String(getPath((await own.readOnce(main, ctx.session.stepId('cfg3.m.read'))).obj, res.list?.name ?? 'title') ?? '');
        return snapCall(own, m.tool, render(m.args, own.vars({ ids: [own.id], batch: marker })), label, 'multi');
      }
      const dd = await fresh('c3m');
      if (!dd) return { ok: false, effect: null, step: '' };
      const marker = String(getPath((await dd.readOnce(main, ctx.session.stepId('cfg3.m.read'))).obj, res.list?.name ?? 'title') ?? '');
      return snapCall(dd, m.tool, render(m.args, dd.vars({ ids: [dd.id], batch: marker })), label, 'multi');
    });
    if (res.list_edit) add(res.list_edit.tool, async (label) => {
      const dd = await fresh('c3l');
      if (!dd) return { ok: false, effect: null, step: '' };
      const r0 = await dd.readOnce(main, ctx.session.stepId('cfg3.le.read'));
      const el = (getPath(r0.obj, res.list_edit!.list) as unknown[] | undefined)?.[0];
      const { props } = schemaProps(toolByName(ctx.tools, res.list_edit!.tool));
      const addr = res.list_edit!.address.by_id && res.list_edit!.address.by_id in props ? { [res.list_edit!.address.by_id]: getPath(el, res.list_edit!.element.id) } : res.list_edit!.address.by_position ? { [res.list_edit!.address.by_position]: 0 } : {};
      return snapCall(dd, res.list_edit!.tool, { ...(render(res.list_edit!.args, dd.vars()) as object), ...addr }, label, 'le');
    });
    // Other declared write tools with arguments in the manifest: versioned tools and input_required tools, each on a fresh object.
    for (const t of [...res.versioned, ...res.input_required]) add(t.tool, async (label) => {
      const dd = await fresh('c3v');
      if (!dd) return { ok: false, effect: null, step: '' };
      const r0 = await dd.readOnce(main, ctx.session.stepId('cfg3.v.read'));
      // why: a tool that asks for input is called with the client capabilities its declaration gives (as MWS-RETRY-3 does), so a
      // refusal for a capability the tester did not declare is not taken for a refusal by the setting.
      const caps = 'client_capabilities' in t ? { 'io.modelcontextprotocol/clientCapabilities': t.client_capabilities } : undefined;
      return snapCall(dd, t.tool, render(t.args, dd.vars({ version: r0.version, object: r0.obj })), label, 'v', caps);
    });
    for (const c of res.creates) if (d && d.id !== null && !d.unusable) add(c.tool, async (label) => snapCall(d, c.tool, render(c.args, d.vars({ marker: ctx.marker('c3n') })), label, 'nested'));
  }
  const declared = declaredWriteTools(ctx.manifest, ctx.tools);
  const marked = readOnlyMarkedCalls(ctx.manifest, ctx.tools);
  /** Tools marked read-only that have a calls entry and cannot be called: each gets a "not called" record (review of PR #9). */
  const markedUncalled: { tool: string; marked: string; why: string }[] = [];
  for (const [tool, c] of Object.entries(ctx.manifest.calls)) {
    const how = marked.get(tool);
    // why: a tool marked read-only is called only by MWS-CFG-2 and CFG-3 (CFG-1 compares the declared write tools alone), and
    // only with a `calls` entry whose arguments name the run's own objects (readOnlyMarkedCalls); any other is never called.
    if (how !== undefined ? !o.marked : !declared.has(tool)) continue;
    // why: the entry's resource as the annotation checks bind it (the first resource with an update tool, else the first).
    const rn = c.resource ?? (how !== undefined ? (ctx.manifest.resources.find((x) => x.update) ?? ctx.manifest.resources[0])?.name : ctx.manifest.resources.find((x) => x.update)?.name);
    const res = ctx.manifest.resources.find((r) => r.name === rn);
    const d = res ? ctx.drivers.get(res.name) : undefined;
    // why: a tool marked read-only is never passed over in silence: with no resource to bind it to, it gets a "not called" record.
    // It is called on a fresh scratch object, so the run's own object being unusable does not stop it (review of PR #9).
    if (how !== undefined && !res) {
      markedUncalled.push({ tool, marked: how, why: `calls.${tool} is bound to ${JSON.stringify(rn ?? null)}, which is not a resource of the manifest` });
      continue;
    }
    if (!res || (how === undefined && (!d || (d.unusable && /\{\{\s*id/.test(JSON.stringify(c.args)))))) continue;
    add(tool, async (label) => {
      const s = await scratch({ ...ctx, ...(d ? { driver: d } : {}) }, res, { tag: 'c3c', purpose: `MWS-CFG-3 object for ${tool}`, label: main });
      if (!s.ok) return { ok: false, effect: null, step: '', ...(how !== undefined ? { failed: `its scratch object could not be made (${s.reason})` } : {}) };
      const r0 = await s.driver!.readOnce(main, ctx.session.stepId('cfg3.call.read'));
      const before = r0.obj;
      const step = ctx.session.stepId(`cfg3.${tool}`);
      // why: a tool marked read-only gets the version just read too, as MWS-ANN-1 calls it (research builds N4).
      const r = await ctx.session.call(label, tool, render(c.args, s.driver!.vars({ object: before, marker: ctx.marker('c3x'), ...(how !== undefined ? { version: r0.version } : {}) })), { step });
      const after = await s.driver!.readSettled(main, 'cfg3.call.after', () => false);
      // why: as snapCall: an object removed in read-only mode is a write, whatever the call answered (review of PR #9: a calls tool
      // that deleted its object and answered isError was read as refused, and the read-back failure went unseen).
      const gone = !!after.call && (definitelyGone(after.call) || (after.call.ok && !!res.read.items && after.obj === null));
      const ch = gone ? ['(the object was deleted)'] : r0.ok && after.ok ? withoutIgnored(diff(before, after.obj), ignoredPaths(res)).map((e) => e.path) : [];
      const observed = gone || (r0.ok && after.ok);
      // why: an input_required or task answer is neither a refusal nor a success; it is not counted as refused.
      if (r.result_type && r.result_type !== 'complete') return { ok: true, effect: ch.length ? ch.slice(0, 5).join(', ') : null, step, observed, pending: true };
      // why: for a tool marked read-only, a call that failed without a refusal shows nothing about the mode (review of PR #9); an
      // unknown-tool error is the tool being absent, which is a refusal.
      const defined = mcpDefinedError(r.rpc_error);
      const failed = how === undefined ? null : r.timed_out ? 'the call timed out' : r.transport_error !== null ? `the connection failed (${short(r.transport_error, 100)})` : defined && defined !== 'an unknown tool' ? `an error MCP defines for the case, not a refusal: ${defined}` : null;
      return { ok: r.ok, effect: ch.length ? ch.slice(0, 5).join(', ') : null, step, observed, ...(failed ? { failed } : {}) };
    }, how);
  }
  const s = await start(envOverride ?? { [env]: on }, 'cfg3');
  const out: NonNullable<LaunchObs['cfg3']> = { env, started: s.r.started, reason: why(s.r), calls: [], ...(!s.r.started && s.r.init_failed ? { init_failed: s.r.init_failed } : {}) };
  let listed = new Set<string>();
  if (s.r.started) {
    listed = new Set((await ctx.session.listTools(s.label)).map((t) => String(t['name'])));
    // why: read-only tools are left out only when the manifest does not name them as writes; every declared write tool is called, listed or not.
    for (const p of prep) {
      try {
        const r = await p.run(s.label);
        out.calls.push({ tool: p.tool, absent: !listed.has(p.tool), ok: r.ok, effect: r.effect, step: r.step || null, observed: !!r.observed || !!r.effect, ...(r.pending ? { pending: true } : {}), ...(r.defined ? { defined: r.defined } : {}), ...(p.marked !== undefined ? { marked: p.marked } : {}), ...(r.failed ? { failed: r.failed } : {}) });
      } catch (e) {
        out.calls.push({ tool: p.tool, absent: !listed.has(p.tool), ok: false, effect: null, step: null, skipped: (e as Error).message, ...(p.marked !== undefined ? { marked: p.marked } : {}) });
      }
    }
  }
  await ctx.session.release([s.label]);
  // why: held needs every declared write tool called; a declared tool the tester has no call for is reported, never passed over.
  // why: for CFG-2 ("offered") a tool the server does not list is absent; CFG-3 still needs each declared tool called (its verdict keeps an uncalled one open).
  if (s.r.started) for (const m of markedUncalled) out.calls.push({ tool: m.tool, absent: !listed.has(m.tool), ok: false, effect: null, step: null, skipped: m.why, marked: m.marked });
  for (const [tool] of declared) if (!seen.has(tool)) out.calls.push(s.r.started && !listed.has(tool) ? { tool, absent: true, ok: false, effect: null, step: null } : { tool, absent: false, ok: false, effect: null, step: null, skipped: 'the manifest gives no arguments the tester can call it with on its own objects' });
  return out;
}

/**
 * Does an object carrying the marker exist (MWS-CFG-3, R7-6: the tester reads back whether a create made its object)?
 * By its key where the resource names objects by a key the tester chose, else through the resource's list tool.
 * null: the tester has no way to look.
 */
async function existsByMarker(ctx: Omit<RunContext, 'driver'>, res: ResourceSpec, d: Driver | null, marker: string, label: string): Promise<unknown[] | null> {
  if (res.key && d) {
    const back = await d.readOnce(label, ctx.session.stepId('cfg3.create.find'), marker);
    if (back.ok) return [marker];
    return goneFrom(res, back) ? [] : null;
  }
  if (!res.list) return null;
  const r = await ctx.session.call(label, res.list.tool, render(res.list.args, baseVars(res, ctx.prefix, { scope: d?.scope ?? null, marker })), { write: false, step: ctx.session.stepId('cfg3.create.find') });
  const items = r.ok ? getPath(r.data, res.list.items) : null;
  return Array.isArray(items) ? items.filter((it) => String(getPath(it, res.list!.name) ?? '') === marker).map((it) => getPath(it, res.list!.id)) : null;
}

/** A tool in a CFG-2 or CFG-3 record: a tool marked read-only says so. */
const named = (c: Cfg3Call) => (c.marked !== undefined ? `${c.tool} (marked read-only: ${c.marked})` : c.tool);

/** The line on the tools marked read-only that were called and changed nothing (they count toward held). */
function markedLine(calls: Cfg3Call[]): string {
  const m = calls.filter((c) => c.marked !== undefined && !c.effect);
  if (!m.length) return '';
  return ` ${m.length === 1 ? 'The tool' : 'The tools'} marked read-only with a calls entry (${m.map((c) => c.tool).join(', ')}) ${m.length === 1 ? 'was' : 'were'} called as well, with no change to the watched object.`;
}

/**
 * Tools marked read-only that wrote nothing seen, but whose call failed without a refusal or could not be made, or whose object
 * could not be read back: no change is not shown, so they keep the record from held (review of PR #9). A refusal or an answer
 * with the object read back unchanged counts toward held.
 */
// why: an input_required or task answer (pending) is not a final answer; a write after the read-back would not be seen, so it is
// open, as for a declared write tool (review of PR #9).
const markedOpen = (calls: Cfg3Call[]): Cfg3Call[] => calls.filter((c) => c.marked !== undefined && !c.effect && (!!c.skipped || !c.step || !!c.failed || !!c.pending || c.observed !== true));
const openWhy = (c: Cfg3Call): string => (c.skipped ? `not called: ${c.skipped}` : c.failed ? (c.step ? `the call failed: ${c.failed}` : `not called: ${c.failed}`) : !c.step ? 'not called' : c.pending ? 'answered with input_required or a task, not a final answer, so a later write would not be seen' : 'its object could not be read back');
const openPart = (m: Cfg3Call[]): string => `${m.map((c) => c.tool).join(', ')}, marked read-only, could not be checked (${m.map((c) => `${c.tool}: ${openWhy(c)}`).join('; ')})`;
/** A note's answer for a call: a failure that is not a refusal is named as such. */
const answered = (c: Cfg3Call): string => (c.pending ? 'answered with input_required or a task' : c.ok ? 'answered as a success' : c.failed ? `the call failed (${c.failed})` : 'refused');

export function launchVerdicts(o: LaunchObs): Result[] {
  const sc = { id: ID, version: VERSION };
  const out: Result[] = [];
  if (o.skipped) return (['MWS-CFG-1', 'MWS-CFG-2', 'MWS-CFG-3', 'MWS-CFG-4'] as const).map((id) => result(id, sw('(settings)'), sc, 'not tested', o.skipped!));
  if (o.cfg1) {
    const w = sw(o.cfg1.env);
    // why: R7-6: a call is accepted when the read-back shows its write, whatever the answer said.
    const accepted = o.cfg1.starts.filter((s) => s.started && s.write?.changed === true);
    // A value under which every declared write tool that could be called accepted a write: the server did not recognize it.
    const base = o.cfg1.baseline_tools;
    const writesWithout = (t: string) => !base || base.some((c) => c.tool === t && !!c.effect);
    const toolsOf = (s: Start) => (s.tools ?? []).filter((c) => !c.skipped && c.step && writesWithout(c.tool));
    // why: an input_required or task answer with no write is neither a refusal nor an acceptance; it does not show the value recognized.
    const refusedSome = (s: Start) => toolsOf(s).some((c) => !c.effect && c.observed !== false && !c.pending && !c.defined);
    const bad = accepted.filter((s) => s.tools && toolsOf(s).length && !refusedSome(s));
    const partial = accepted.filter((s) => s.tools && refusedSome(s));
    const open = accepted.filter((s) => !s.tools || !toolsOf(s).length);
    const noProbe = o.cfg1.starts.filter((s) => s.started && (!s.write || s.write.changed === null));
    const initFailed = o.cfg1.starts.filter((s) => s.init_failed);
    const notes = [
      ...(o.cfg1.basis ? [`${o.cfg1.basis}${o.cfg1.opposite?.length ? ` Not sent, as meaning the opposite of restrict on this switch: ${o.cfg1.opposite.map((v) => JSON.stringify(v)).join(', ')}.` : ''}`] : []),
      ...o.cfg1.starts.map((s) => `${o.cfg1!.env}=${JSON.stringify(s.value)}: ${s.started ? (s.write ? `started; the write was ${s.write.changed ? `applied (answered ${s.write.ok ? 'as a success' : 'as an error'})` : s.write.ok ? 'answered as a success but changed nothing' : 'refused'}` : 'started; no write was tried') : s.init_failed ? `started, but not tried: ${s.init_failed}` : `did not start (${s.reason})`}${s.tools ? `; every declared write tool called: ${s.tools.map((c) => `${c.tool} ${c.skipped ? `not called (${c.skipped})` : c.effect ? `wrote (${c.effect})` : c.observed === false ? 'outcome not read back' : 'no write'}`).join(', ')}` : ''}`),
      ...(base ? [`Positive control: with no setting, ${base.filter((c) => c.effect).map((c) => c.tool).join(', ') || 'no tool'} wrote; ${base.filter((c) => !c.effect && !c.skipped && c.step).map((c) => c.tool).join(', ') || 'none'} wrote nothing even then, so ${base.filter((c) => !c.effect && !c.skipped && c.step).length === 1 ? 'it is' : 'they are'} not compared.`] : []),
      ...partial.map((s) => `Observation: under ${o.cfg1!.env}=${JSON.stringify(s.value)} some write tools refused and others wrote, so the server recognized the value; the writes that went through are judged by MWS-CFG-3, not here (spec R7-6).`),
      ...bad.filter((s) => (s.tools ?? []).some((c) => c.skipped || !c.step || c.observed === false)).map((s) => `Under ${o.cfg1!.env}=${JSON.stringify(s.value)}, ${(s.tools ?? []).filter((c) => c.skipped || !c.step || c.observed === false).map((c) => c.tool).join(', ')} could not be called or read back; every tool that could be accepted a write.`),
    ];
    if (!o.cfg1.starts.length) out.push(result('MWS-CFG-1', w, sc, 'not tested', 'no value was left to try: every candidate is a value the declaration lists as permitting writes, or means the opposite of restrict on this switch', { notes }));
    else if (bad.length) out.push(result('MWS-CFG-1', w, sc, 'violated', `The server started with writes enabled for ${bad.map((s) => `${o.cfg1!.env}=${JSON.stringify(s.value)}`).join(', ')}: every declared write tool that was called wrote, so the server did not recognize the value.`, { steps: bad.flatMap((s) => [s.write!.step, ...toolsOf(s).filter((c) => c.effect).map((c) => c.step!)]), notes }));
    else if (open.length) out.push(result('MWS-CFG-1', w, sc, 'not tested', `a write was applied under ${open.map((s) => `${o.cfg1!.env}=${JSON.stringify(s.value)}`).join(', ')}, and whether every declared write tool accepted one (an unrecognized value) or only some (a partial leak, MWS-CFG-3) was not established`, { notes }));
    else if (initFailed.length) out.push(result('MWS-CFG-1', w, sc, 'not tested', `the server started with ${initFailed.map((s) => `${o.cfg1!.env}=${JSON.stringify(s.value)}`).join(', ')}, but its session.init call failed, so ${initFailed.length === 1 ? 'that value was' : 'those values were'} not tried (${initFailed[0]!.init_failed}); the other values are in the notes`, { notes }));
    else if (noProbe.length) out.push(result('MWS-CFG-1', w, sc, 'not tested', 'the server started for some values, and no write could be tried or read back (the manifest declares no resource with an update tool, or the object did not read back)', { notes }));
    else out.push(result('MWS-CFG-1', w, sc, 'held', `For every value tried the server either did not start or started with writes refused. (A value it recognised and one it treated as restrictive look the same; both are held.)`, { notes }));
  }
  for (const f of o.cfg2) {
    const w = sw(f.env);
    // why: R7-6: an error from tools/list given because no tool is enabled is not a refusal of the list.
    // gate-2 re-run on 378f32f (note 19, R12; rule 11): "because no tool is enabled" is read by patterns.no_tools; where only the
    // default decides, a list error that it does not match is not a refusal the tester can credit either.
    // the error's own message is read (the JSON-RPC envelope around it is not an echo to strip)
    if (f.init_failed) {
      out.push(result(f.kind === 'allow' ? 'MWS-CFG-4' : 'MWS-CFG-2', w, sc, 'not tested', `the server started with ${f.env}=${JSON.stringify(f.value)}, but ${f.init_failed}`));
      continue;
    }
    const msg = f.list_error ? listErrorMessage(f.list_error) : '';
    const echo = f.kind === 'allow' && !f.started && f.list_error && !(fromDeclaration('no_tools') && says('no_tools', msg)) ? namesInvented(f) : null;
    if (echo) out.push(result('MWS-CFG-4', w, sc, 'held', `The server started with ${f.env}=${JSON.stringify(f.value)} and answered tools/list with an error that names the misspelled tool the tester put in the list (${JSON.stringify(echo.invented)}): a refusal of the list.`, { notes: [echo.line] }));
    else if (f.kind === 'allow' && !f.started && f.list_error && says('no_tools', msg)) out.push(result('MWS-CFG-4', w, sc, 'not tested', `the server started with ${f.env}=${JSON.stringify(f.value)} and answered tools/list with an error because no tool is enabled (${JSON.stringify(f.list_error.slice(0, 160))}), which is not a refusal of the list`, { notes: [saidBy('no_tools', f.list_error)] }));
    // S1: a tools/list error that neither names the invented tool nor is read by a declared no_tools pattern needs reading.
    else if (f.kind === 'allow' && !f.started && f.list_error) out.push(result('MWS-CFG-4', w, sc, 'not tested', `the server started with ${f.env}=${JSON.stringify(f.value)} and answered tools/list with an error (${JSON.stringify(msg.slice(0, 160))}) that does not name the misspelled tool the tester put in the list${fromDeclaration('no_tools') ? ' and that the declared patterns.no_tools does not read' : ''}; whether it refuses the list or says no tool is enabled needs reading (spec 7.3, rule 11)`, { notes: [saidBy('no_tools', msg)] }));
    else if (f.kind === 'allow') out.push(f.started ? result('MWS-CFG-4', w, sc, 'violated', `The server returned a result to tools/list with ${f.env}=${JSON.stringify(f.value)} (an allow-list with one valid tool name and one it does not have).`) : result('MWS-CFG-4', w, sc, 'held', `The server refused ${f.list_error ? 'the tools/list request' : 'to start'} with ${f.env}=${JSON.stringify(f.value)}: ${f.reason}.`));
    else if (!f.started) out.push(result('MWS-CFG-2', w, sc, 'held', `The server refused to start with ${f.env}=${JSON.stringify(f.value)} (a deny-list naming a tool it does not have): ${f.reason}.`));
    else {
      const calls = f.calls ?? [];
      const took = calls.filter((c) => c.effect);
      // why: a tool marked read-only decides by a write through it; when it could not be checked (markedOpen) the record stays open.
      const writeTools = calls.filter((c) => c.marked === undefined);
      // why: R7-6: a write tool that had no effect (the read-back shows no write) meets "refused or had no effect"; one whose effect could not be read back does not.
      const unclear = writeTools.filter((c) => !c.effect && (c.skipped || (!c.step && !c.absent) || (c.ok && !c.absent && c.observed !== true)));
      const mOpen = markedOpen(calls);
      const notes = calls.map((c) => (c.absent && !c.step && !c.skipped && !c.failed ? `${named(c)}: not listed with this setting, and not called` : `${named(c)}: ${c.skipped ? `not called (${c.skipped})` : `${c.absent ? 'not listed; ' : 'listed; '}${answered(c)}${c.effect ? `; changed ${c.effect}` : c.observed ? '; no write on read-back' : c.marked !== undefined ? '; not read back' : ''}`}`));
      const what = `${f.env}=${JSON.stringify(f.value)} (a deny-list naming a tool it does not have)`;
      if (took.length) out.push(result('MWS-CFG-2', w, sc, 'violated', `The server started with ${what}, and ${took.map(named).join(', ')} still wrote (${took.map((c) => c.effect).join('; ')}).`, { steps: took.map((c) => c.step!).filter(Boolean), notes }));
      else if (!writeTools.length) out.push(result('MWS-CFG-2', w, sc, 'not tested', `the server started with ${what}, and the manifest declares no write tool to call${calls.length ? ` (no write was seen through ${calls.map((c) => c.tool).join(', ')}, marked read-only)` : ''}`, calls.length ? { notes } : {}));
      else if (unclear.length || mOpen.length) out.push(result('MWS-CFG-2', w, sc, 'not tested', `the server started with ${what}; no write was seen to take effect, but ${[...(unclear.length ? [`${unclear.map((c) => c.tool).join(', ')} answered as a success or could not be called`] : []), ...(mOpen.length ? [openPart(mOpen)] : [])].join(', and ')}`, { notes }));
      else out.push(result('MWS-CFG-2', w, sc, 'held', `The server started with ${what}, with every declared write tool (${writeTools.length}) absent, refusing, or without effect on read-back.${markedLine(calls)}`, { notes }));
    }
  }
  if (o.cfg3) {
    const w = sw(o.cfg3.env);
    if (o.cfg3.init_failed) out.push(result('MWS-CFG-3', w, sc, 'not tested', `the server started in read-only mode, but ${o.cfg3.init_failed}`));
    else if (!o.cfg3.started) out.push(result('MWS-CFG-3', w, sc, 'not tested', `the server did not start in read-only mode (${o.cfg3.reason})`));
    else {
      const took = o.cfg3.calls.filter((c) => c.effect);
      // why: "absent or refused" is asked of the declared write tools. A tool marked read-only is called because the mode must
      // stop it too if it writes ("whatever that tool's annotations declare"); it is a read unless it changes something, so a
      // success with no change counts toward held and never leaves the record open; only a change through it decides (violated).
      const writeTools = o.cfg3.calls.filter((c) => c.marked === undefined);
      // why: held is "absent or refused, and no object changed"; a success with no visible effect, or a call that could not be set up, is not that.
      // why: an unlisted tool called anyway that answered as a success shows "no object changed" only where its read-back ran.
      const unclear = writeTools.filter((c) => !c.effect && (c.skipped || !c.step || (c.ok && !c.absent) || (c.ok && c.absent && c.observed !== true)));
      // why: CFG-3 calls each declared write tool "whether or not it is listed"; one not listed and not called leaves it open (review).
      const mOpen = markedOpen(o.cfg3.calls);
      const notes = o.cfg3.calls.map((c) => (c.absent && !c.step && !c.skipped && !c.failed ? `${named(c)}: not listed in this mode, and not called (no call the tester can make)` : `${named(c)}: ${c.skipped ? `not called (${c.skipped})` : c.absent ? 'not listed; called anyway: ' : 'listed; '}${c.skipped ? '' : `${answered(c)}${c.effect ? `; changed ${c.effect}` : c.marked !== undefined ? (c.step && c.observed ? '; no change on read-back' : '; not read back') : ''}`}`));
      const markedTook = took.filter((c) => c.marked !== undefined);
      if (took.length) out.push(result('MWS-CFG-3', w, sc, 'violated', `In read-only mode, ${took.map(named).join(', ')} still wrote (${took.map((c) => c.effect).join('; ')}).${markedTook.length ? ` ${markedTook.map((c) => c.tool).join(', ')} ${markedTook.length > 1 ? 'are' : 'is'} marked read-only, and the mode let ${markedTook.length > 1 ? 'them' : 'it'} write: MWS-CFG-3 asks the mode to refuse every write tool whatever its annotations declare.` : ''}`, { steps: took.map((c) => c.step!).filter(Boolean), notes }));
      else if (!writeTools.length) out.push(result('MWS-CFG-3', w, sc, 'not tested', `the manifest declares no write tool to call${o.cfg3.calls.length ? ` (no write was seen through ${o.cfg3.calls.map((c) => c.tool).join(', ')}, marked read-only)` : ''}`, o.cfg3.calls.length ? { notes } : {}));
      else if (unclear.length || mOpen.length) {
        // why: gate-2 K8s B18: a tool the tester has no call for is a missing test, not a finding; the record names the key that gives it one.
        const uncalled = unclear.filter((c) => !c.step);
        const succeeded = unclear.filter((c) => c.step);
        const parts = [
          ...(succeeded.length ? [`${succeeded.map((c) => c.tool).join(', ')} ${succeeded.length > 1 ? 'were' : 'was'} answered as a success`] : []),
          ...(uncalled.length ? [`${uncalled.map((c) => c.tool).join(', ')} ${uncalled.length > 1 ? 'were' : 'was'} not called (${uncalled.map((c) => c.skipped && !/gives no arguments/.test(c.skipped) ? `${c.tool}: ${c.skipped}` : `${c.tool}: no call declared; give one as calls.${c.tool}: { resource, args }, the arguments for a call on a scratch object of that resource, or on an object the arguments name`).join('; ')})`] : []),
          ...(mOpen.length ? [openPart(mOpen)] : []),
        ];
        const so = [...(unclear.length ? ['"absent or refused" is not shown for every declared write tool (the test calls each one, listed or not)'] : []), ...(mOpen.length ? ['"no object changed" is not shown for every tool marked read-only that was called'] : [])];
        out.push(result('MWS-CFG-3', w, sc, 'not tested', `in read-only mode no write was seen to take effect, but ${parts.join(', and ')}, so ${so.join(', and ')}`, { notes }));
      }
      else out.push(result('MWS-CFG-3', w, sc, 'held', `In read-only mode, every declared write tool (${writeTools.length}) was absent or refused, and no object changed.${markedLine(o.cfg3.calls)}`, { notes }));
    }
  }
  return out;
}
