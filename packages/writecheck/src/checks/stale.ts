/**
 * Tier 1, the stale write (deterministic, client only, always run), through one connection (one server process) and one
 * credential (MWS-CONC-2 option A, spec R13-1): the first writer reads; the second writer reads and changes field 1; then
 * the first writer writes field 0 from its own, now stale, read.
 * One interleaving, forced by sequencing, no timing involved. Decides MWS-CONC-2 (and MWS-CONC-1
 * with a control, MWS-CONC-4 when a conflict is produced).
 *
 *   validity  one after the other (F1, then F0 from a fresh read): both kept, or the fields are not
 *             independent and nothing here can be judged (see MWS-UPD-1)
 *   test      read, second writer's read and F1 = VO, stale write F0 = VA from the first read, settled read-back
 *   control   the same stale write straight to the platform's API (read, patch F1, write F0 with the
 *             version read first): 409 or 412 means the backend offers the check the tool must keep
 *
 * Applies to update tools that take base state: a whole object (full_replace) or a version argument.
 * A field patch with no version carries no stale base, so there is nothing to refuse.
 *
 * The delete path (MWS-CONC-2 names deletes): a scratch object is read, a second writer reads it and changes
 * field 1 (the same connection), and the delete tool is called with the version from the first read. A control arm sends
 * the same stale delete to the platform's API. Refusals feed MWS-CONC-4 on the delete tool.
 *
 * Review-only clauses, answered from the review block or left `not tested`: the conflict's wording
 * (MWS-CONC-4) and, where the platform's API applies the stale write, whether the tool's
 * description says stale writes are not detected (MWS-CONC-2).
 */

import { fromDeclaration, says as saysKind } from './says.js';
const says = saysKind;
import { conflictSignal, versionRequiredSignal, type Signal } from './signals.js';
import { hasControl, valueAt } from '../core/driver.js';
import { recount, repsWhere, runExperiment, witness, type ExperimentOutcome } from '../core/exec.js';
import { validateExperiment, type Experiment } from '../core/experiment.js';
import type { ResourceSpec } from '../core/manifest.js';
import { goneFrom } from '../core/objects.js';
import { render } from '../core/template.js';
import { deepEqual, diff, formatPath, parsePath, short, withoutIgnored } from '../core/util.js';
import { ignoredPaths } from './readback.js';
import { result, VIOLATED_CAVEAT, type Result } from '../report/verdicts.js';
import { answerOf, questionId, reviewResult, type Question } from './review.js';
import { ruleNote } from './rules.js';
import { scratch } from './scratch.js';
import { decidedByShape, quoteField, sameValue, shapeFallbackNote, shapeOf, toPointer, type ShapeCapture } from './shape.js';
import { brief, lastSeg, mentions, notRun, toolByName, wp, type CallBrief, type CheckModule, type Observation, type PlanContext, type PlannedCheck, type RunContext } from './types.js';

const ID = 'stale-write';
// '4': option A staging (one connection, the second writer's read); results of '3' staged the writers on separate processes.
const VERSION = '4';

/** A field path as a condition reference below `<step>.obj` (bracket-quoted where needed). */
export const objRef = (step: string, path: string): string => {
  const p = formatPath(parsePath(path));
  return p.startsWith('[') ? `${step}.obj${p}` : `${step}.obj.${p}`;
};

export function staleExperiment(res: ResourceSpec, reps: number): Experiment {
  const [f0, f1] = res.fields!;
  const has = (s: string, v: string) => `${objRef(s, f0.path)} == ${v}`;
  const ctl = hasControl(res, 'read', 'patch', 'write');
  const kept = (s: string) => ({ all: [`${objRef(s, f1.path)} == VO`, `${objRef(s, f0.path)} == VA`] });
  const arms: Experiment['arms'] = [
    {
      name: 'validity',
      role: 'validity',
      description: `one after the other, in both orders, each from a fresh read: ${f1.path} then ${f0.path}, and back; both fields must be kept each time`,
      reps: 1,
      reset: true,
      servers: 'per_arm',
      steps: [
        { id: 'other', kind: 'update', field: 1, value: 'VO', server: 'O', require: 'other.ok' },
        { id: 'write', kind: 'update', field: 0, value: 'VA', server: 'W' },
        // why: review of the writesafe items (1, 2): a success is judged against a settled read through the writer's own server.
        { id: 'wread', kind: 'read', via: 'tool', require: 'wread.ok', server: 'W', settle: has('wread', 'VA') },
        { id: 'final', kind: 'read', via: 'tool', require: 'final.ok', server: 'R', settle: kept('final') },
        { id: 'back0', kind: 'update', field: 0, value: 'B0', server: 'W', require: 'back0.ok' },
        { id: 'back1', kind: 'update', field: 1, value: 'B1', server: 'O', require: 'back1.ok' },
        { id: 'final2', kind: 'read', via: 'tool', require: 'final2.ok', server: 'R', settle: { all: [`${objRef('final2', f0.path)} == B0`, `${objRef('final2', f1.path)} == B1`] } },
      ],
      counters: {
        both_kept: { all: ['write.ok', `${objRef('final', f1.path)} == VO`, has('final', 'VA'), `${objRef('final2', f0.path)} == B0`, `${objRef('final2', f1.path)} == B1`] },
        // why: writesafe self-test T7: a write answered as a success whose own field is not in effect afterwards (an A -> B -> A
        // replay) is a success that left nothing applied, not only "fields not independent".
        success_unapplied: { all: ['write.ok', `${objRef('wread', f0.path)} != VA`] },
      },
    },
    {
      name: 'test',
      role: 'test',
      // why: MWS-CONC-2 option A (owner's decision, 15 Nov 2026; spec R13-1): the stale write is
      // staged through one connection (one server process) and one credential: the first writer's read, the second writer's
      // read and its change, then the first writer's write, in that order. A check keyed to the credential, the user or the
      // connection cannot tell the first read from the second writer's later one, so only a version (or a handle) carried in
      // the call can refuse it.
      description: `through one connection and one credential: the first writer reads through ${res.read.tool}; the second writer reads and sets ${f1.path}; ${res.update!.tool} writes ${f0.path} from the first read`,
      reps,
      reset: true,
      servers: 'per_arm',
      steps: [
        { id: 'read', kind: 'read', via: 'tool', server: 'R', require: 'read.ok' },
        { id: 'oread', kind: 'read', via: 'tool', server: 'R', require: 'oread.ok' },
        { id: 'other', kind: 'update', field: 1, value: 'VO', base: 'oread', server: 'R', require: 'other.ok' },
        { id: 'write', kind: 'update', field: 0, value: 'VA', base: 'read', server: 'R' },
        { id: 'final', kind: 'read', via: 'tool', require: 'final.ok', server: 'R', settle: kept('final') },
      ],
      counters: {
        write_ok: 'write.ok',
        stale_won: { all: ['write.ok', `${objRef('final', f1.path)} != VO`] },
        rejected: { not: 'write.ok' },
        rejected_tool_error: { all: [{ not: 'write.ok' }, 'write.isError'] },
        applied_despite_refusal: { all: [{ not: 'write.ok' }, has('final', 'VA')] },
        both_kept: { all: ['write.ok', `${objRef('final', f1.path)} == VO`, has('final', 'VA')] },
        silent_noop: { all: ['write.ok', `${objRef('final', f1.path)} == VO`, `${objRef('final', f0.path)} != VA`] },
      },
    },
  ];
  if (ctl)
    arms.push({
      name: 'control',
      role: 'control',
      description: `the same stale write straight to the platform's API: read, patch ${f1.path}, write ${f0.path} with the version read first`,
      reps,
      reset: true,
      servers: 'per_arm',
      steps: [
        { id: 'r0', kind: 'read', via: 'control', require: 'r0.ok' },
        { id: 'oob', kind: 'control_patch', field: 1, value: 'VO', require: 'oob.ok' },
        // why: a control patch the platform answers 2xx and ignores would look like a lost change (CLI-BUGS item 12).
        { id: 'mid', kind: 'read', via: 'control', require: 'mid.ok' },
        { id: 'stale', kind: 'control_write', field: 0, value: 'VA', base: 'r0' },
        { id: 'final', kind: 'read', via: 'control', require: 'final.ok' },
      ],
      counters: { conflict: { all: [`${objRef('mid', f1.path)} == VO`, { any: ['stale.status == 409', 'stale.status == 412'] }] }, stale_2xx_lost: { all: [`${objRef('mid', f1.path)} == VO`, 'stale.ok', `${objRef('final', f1.path)} != VO`] } },
    });
  return validateExperiment({
    id: `${ID}.${res.name}`,
    version: VERSION,
    hypothesis: `A write through ${res.update!.tool} made from a read that another client has since changed does not overwrite that change.`,
    vars: { VA: f0.values[1], VO: f1.values[1], B0: f0.values[0], B1: f1.values[0] },
    simulated: [],
    arms,
    verdict: {
      criterion: 'reproduced if a stale write through the tool succeeded and the other client\'s change is gone in at least one repetition, while the platform API (when a control is declared) lost nothing; not reproduced if no repetition lost the change',
      reproduced: ctl ? { all: ['test.stale_won >= 1', 'control.stale_2xx_lost == 0'] } : 'test.stale_won >= 1',
      not_reproduced: { all: ['test.valid >= 1', 'test.stale_won == 0'] },
    },
    control: ctl ? { kind: 'arms', arms: ['control'] } : { kind: 'none', reason: 'the manifest declares no control read, patch and write for this resource, so the result cannot be attributed to the server or its backend' },
  });
}

function applies(res: ResourceSpec): string | null {
  if (!res.update) return 'n/a';
  if (res.update.mode === 'full_replace' || res.version?.arg) return null;
  return 'n/a';
}

/** The delete path applies when the delete tool's arguments carry the version the caller read. */
const deleteTakesVersion = (res: ResourceSpec): boolean => !!res.delete && /\{\{\s*\??version\s*\}\}/.test(JSON.stringify(res.delete.args));

export interface DelRep {
  skip?: string;
  version: unknown;
  del: CallBrief | null;
  /** The stale call took effect: for a delete, the object no longer reads back; for another write, the object changed. */
  gone: boolean | null;
  /** The second writer's change is still there. */
  other_kept: boolean | null;
  /** The object's version after the call (for MWS-CONC-6). */
  current_version?: unknown;
  steps: string[];
}
export interface DelObs {
  tool: string;
  /** delete: `gone` means the object was deleted; write: `gone` means the stale write changed the object. */
  kind?: 'delete' | 'write';
  /** The same call from a fresh read: it must succeed and take effect for a stale refusal to count as a conflict. */
  positive?: { ok: boolean; effect: boolean | null; step: string | null };
  reps: DelRep[];
  control: { status: number | null; gone: boolean | null }[] | null;
  /** The second run of MWS-CONC-2 for an optional version: the update tool's stale write with the version left out (and no override). */
  version_left_out?: boolean;
}

/**
 * The second run of MWS-CONC-2 (spec 0852410): only for a tool that replaces a whole object or deletes one, and
 * whose version argument is optional. It sends the stale call with the version left out and no override; the
 * positive control sends it with the version. A field-patch tool gets no second run (NF-12).
 */
export function versionLeftOutRuns(res: ResourceSpec): { tool: string; kind: 'write' | 'delete'; bare: unknown; versioned: unknown }[] {
  const v = res.version;
  if (!v?.optional || !v.arg) return [];
  const strip = (args: Record<string, unknown>) => {
    const bare = { ...args };
    delete bare[v.arg!];
    if (v.override) delete bare[v.override];
    return bare;
  };
  const out: { tool: string; kind: 'write' | 'delete'; bare: unknown; versioned: unknown }[] = [];
  const u = res.update;
  if (u && u.mode === 'full_replace' && !u.apply && res.fields && typeof u.args === 'object' && u.args !== null && Object.hasOwn(u.args, v.arg)) {
    const f = res.fields[0];
    const versioned = JSON.parse(JSON.stringify(u.args).replace(/\{\{\s*field\s*\}\}/g, f.arg).replace(/"\{\{\s*value\s*\}\}"/g, JSON.stringify(f.values[1]))) as Record<string, unknown>;
    versioned[v.arg] = '{{version}}';
    out.push({ tool: u.tool, kind: 'write', bare: strip(versioned), versioned });
  }
  const d = res.delete;
  if (d && typeof d.args === 'object' && d.args !== null && Object.hasOwn(d.args, v.arg)) {
    const versioned = { ...(d.args as Record<string, unknown>), [v.arg]: '{{version}}' };
    out.push({ tool: d.tool, kind: 'delete', bare: strip(versioned), versioned });
  }
  return out;
}

interface StaleObs {
  update: ExperimentOutcome | null;
  delete: DelObs | null;
  /** Other tools that take the version the caller read, each from a stale read. */
  versioned?: DelObs[];
  /** Each tool's description, for the review-only disclosure clause. */
  descriptions: Record<string, string>;
}

export const staleCheck: CheckModule = {
  id: ID,
  version: VERSION,
  requirements: ['MWS-CONC-1', 'MWS-CONC-2', 'MWS-CONC-4', 'MWS-CONC-5', 'MWS-CONC-6'],
  plan(ctx: PlanContext, res: ResourceSpec): PlannedCheck {
    const base: PlannedCheck = { check: ID, version: VERSION, resource: res.name, runs: false, calls: [], writes: 0, creates: 0, notRun: [] };
    const calls: string[] = [];
    const nr: Result[] = [];
    let writes = 0;
    let creates = 0;
    const reps = ctx.manifest.limits.stale_reps;
    if (res.update) {
      const w = wp(res.name, res.update.tool);
      if (applies(res) === 'n/a') {
        nr.push(...notRun(this, ['MWS-CONC-2', 'MWS-CONC-4'], w, 'not applicable', `${res.update.tool} is a ${res.update.mode} update with no version argument: it carries no stale base to refuse`));
        // why: MWS-CONC-1 for such a tool is the gated check's; without a gate it is not tested, never "not applicable" (CLI-BUGS item 4).
        if (!ctx.gated) nr.push(...notRun(this, ['MWS-CONC-1'], w, 'not tested', `${res.update.tool} takes no version; MWS-CONC-1 for a tool that reads and writes inside one call is tested through the backend gate, which is not configured, and ${'only a version check sent with the write is looked for in this preview; another kind of concurrency control (such as a lock held by another user) is not staged, so whether the backend offers a check the tool bypasses is not established'}`));
      }
      else {
        const ctl = hasControl(res, 'read', 'patch', 'write');
        calls.push(
          `validity x1: ${res.update.tool} ${res.fields![1].path}, then ${res.fields![0].path}; ${res.read.tool}; and back in the other order; ${res.read.tool}`,
          `test x${reps}, one connection and one credential: ${res.read.tool} (first writer); ${res.read.tool} and ${res.update.tool} ${res.fields![1].path} (second writer); ${res.update.tool} ${res.fields![0].path} from the first read${res.version?.arg ? `, sending ${res.version.arg}` : ''}; ${res.read.tool}`,
          ...(ctl ? [`control x${reps}: control read; control patch ${res.fields![1].path}; control write ${res.fields![0].path} with the stale version; control read`] : []),
        );
        writes += 6 + reps * 4 + (ctl ? reps * 4 : 0);
        if (!ctl) nr.push(...notRun(this, ['MWS-CONC-1'], w, 'not tested', 'needs a control block with read, patch and write: whether the backend offers a check can only be seen through its own API'));
      }
    }
    // why: a delete tool shared by two resources is tested once, under the first that sends it a version.
    // Tools the declaration says the backend cannot version-check: MWS-CONC-2 does not apply; MWS-CONC-5 asks whether the description says so.
    for (const t of res.no_version_check) {
      const w = wp(res.name, t);
      // why: the tool deletes or writes, so MWS-CONC-2 applies; with no version check the stale call is row 3 or 4, and that run is not built for such tools here.
      // why: TB-B2-2 (t23): the update tool already has its not-applicable record above (no version argument); a second, not-tested
      // record for the same write path would contradict it.
      if (!(res.update && t === res.update.tool && applies(res) === 'n/a')) nr.push(result('MWS-CONC-2', w, { id: ID, version: VERSION }, 'not tested', `the declaration states that the backend has no version check for ${t}; the stale call through it, with a control arm (row 3, platform) or without (row 4), is not built in this preview`));
      const q: Question = { id: questionId('MWS-CONC-5', w, 'description'), requirement: 'MWS-CONC-5', write_path: w, question: `The backend cannot detect a change for ${t} (as declared). Does its description state that stale writes are not detected, or are detected only on a best-effort basis?`, evidence: [{ step: null, text: String(toolByName(ctx.tools, t)?.description ?? '') }] };
      nr.push(reviewResult({ id: ID, version: VERSION }, q, answerOf({ ...ctx, review: ctx.review ?? ctx.manifest.review }, q, (ctx.review ?? ctx.manifest.review)?.stale_writes_disclosed ?? null)));
    }
    // why: research builds N6 (review): a resource that sends no version keeps its own "carries no {{version}}" row even where
    // another resource sends the same delete tool a version; the two are different write paths.
    if (res.delete && !res.no_version_check.includes(res.delete.tool)) {
      const w = wp(res.name, res.delete.tool);
      if (!deleteTakesVersion(res)) nr.push(result('MWS-CONC-2', w, { id: ID, version: VERSION }, 'not tested', `${res.delete.tool}'s arguments in the manifest carry no {{version}}: declare where the delete takes the version the caller read (a delete that takes none cannot refuse a stale delete; if the tool has no such argument, it is a finding to check by hand against MWS-CONC-2)`));
      else if (!res.create || !res.cleanup || res.cleanup === 'leave') nr.push(...notRun(this, ['MWS-CONC-2', 'MWS-CONC-4'], w, 'not tested', 'the stale delete needs scratch objects: a create block and a cleanup policy'));
      else if (!res.update && !hasControl(res, 'patch')) nr.push(...notRun(this, ['MWS-CONC-2', 'MWS-CONC-4'], w, 'not tested', 'the second writer needs an update tool or control.patch'));
      else {
        const ctl = hasControl(res, 'read', 'patch', 'delete');
        calls.push(`delete x${reps}: create a scratch object; ${res.read.tool}; second writer changes ${res.fields?.[1]?.path ?? 'a field'}; ${res.delete.tool} with the version from the first read; ${res.read.tool}`);
        if (ctl) calls.push(`delete control x${reps}: create a scratch object; control read; control patch; control delete with the stale version; control read`);
        writes += reps * 3 + (ctl ? reps * 3 : 0);
        creates += reps * (ctl ? 2 : 1);
        if (!ctl) nr.push(...notRun(this, ['MWS-CONC-1'], w, 'not tested', 'needs control read, patch and delete: whether the backend refuses a stale delete can only be seen through its own API'));
      }
    }
    for (const v of res.versioned) {
      if (!res.create || !res.cleanup || res.cleanup === 'leave' || !res.update) {
        nr.push(...notRun(this, ['MWS-CONC-2', 'MWS-CONC-4'], wp(res.name, v.tool), 'not tested', 'the stale write needs scratch objects (a create block and a cleanup policy) and an update tool for the second writer'));
        continue;
      }
      calls.push(`${v.tool} x${reps}: create a scratch object; ${res.read.tool}; second writer changes ${res.fields?.[1]?.path ?? 'a field'}; ${v.tool} with the version from the first read; ${res.read.tool}`);
      writes += reps * 3;
      creates += reps;
    }
    if (res.create && res.cleanup && res.cleanup !== 'leave' && (res.update || hasControl(res, 'patch'))) {
      for (const run of versionLeftOutRuns(res)) {
        if (res.no_version_check.includes(run.tool)) continue;
        const sch = toolByName(ctx.tools, run.tool)?.inputSchema as { required?: string[] } | undefined;
        if (sch?.required?.includes(res.version!.arg!)) continue;
        calls.push(`${run.tool} x${reps}, version left out (MWS-CONC-2, second run): positive control; create a scratch object; ${res.read.tool}; second writer changes ${res.fields?.[1]?.path ?? 'a field'}; ${run.tool} with neither the version nor the override; ${res.read.tool}`);
        writes += reps * 3 + 2;
        creates += reps + 1;
      }
    }
    return { ...base, runs: calls.length > 0, calls, writes, creates, notRun: nr };
  },
  async collect(ctx: RunContext, res: ResourceSpec): Promise<Observation> {
    const obs: StaleObs = { update: null, delete: null, descriptions: {} };
    for (const t of [res.update?.tool, res.delete?.tool]) if (t) obs.descriptions[t] = String(toolByName(ctx.tools, t)?.description ?? '');
    if (res.update && applies(res) === null) obs.update = await runExperiment({ session: ctx.session, driver: ctx.driver }, staleExperiment(res, ctx.manifest.limits.stale_reps));
    if (res.delete && deleteTakesVersion(res) && res.create && res.cleanup && res.cleanup !== 'leave' && (res.update || hasControl(res, 'patch'))) obs.delete = await staleDelete(ctx, res);
    if (res.create && res.cleanup && res.cleanup !== 'leave' && (res.update || hasControl(res, 'patch'))) {
      for (const run of versionLeftOutRuns(res)) {
        if (res.no_version_check.includes(run.tool)) continue;
        // why: the second run is for an optional version only; a tool whose schema requires it gets none (review).
        const sch = toolByName(ctx.tools, run.tool)?.inputSchema as { required?: string[] } | undefined;
        if (sch?.required?.includes(res.version!.arg!)) continue;
        (obs.versioned ??= []).push({ ...(await staleDelete(ctx, res, { tool: run.tool, args: run.bare }, run.versioned, run.kind)), version_left_out: true });
      }
    }
    if (res.versioned.length && res.create && res.cleanup && res.cleanup !== 'leave' && res.update) {
      obs.versioned ??= [];
      for (const v of res.versioned) {
        obs.descriptions[v.tool] = String(toolByName(ctx.tools, v.tool)?.description ?? '');
        obs.versioned.push(await staleDelete(ctx, res, v));
      }
    }
    return { check: ID, version: VERSION, resource: res.name, data: obs };
  },
  evaluate(obs: Observation, ctx: PlanContext): Result[] {
    const res = ctx.manifest.resources.find((r) => r.name === obs.resource)!;
    const data = obs.data as StaleObs;
    const out: Result[] = [];
    if (data.update) {
      const rec = data.update;
      out.push(...staleVerdicts(recount(rec.experiment, rec.arms, rec.simulated, rec.stopped), res, ctx, data.descriptions));
    }
    if (data.delete) out.push(...deleteVerdicts(data.delete, res, ctx));
    for (const v of data.versioned ?? []) {
      // why: the second run's control arm is the main run's, which sends the version (spec MWS-CONC-2).
      if (v.version_left_out) v.control = v.kind === 'delete' ? (data.delete?.control ?? null) : controlFromExperiment(data.update);
      out.push(...deleteVerdicts(v, res, ctx));
    }
    return out;
  },
};

/**
 * The stale write for a delete (or, with `write`, for another tool that takes the version): a scratch
 * object is read, a second writer changes field 1, then the tool is called with the version from the
 * first read. For a delete, "applied" is the object gone; for another tool, the object changed beyond
 * the second writer's change.
 */
async function staleDelete(ctx: RunContext, res: ResourceSpec, write?: { tool: string; args: unknown }, positiveArgs?: unknown, kindOverride?: 'write' | 'delete'): Promise<DelObs> {
  const reps = ctx.manifest.limits.stale_reps;
  const t = write ?? res.delete!;
  const kind = kindOverride ?? (write ? 'write' : 'delete');
  const asWrite = kind === 'write';
  // why: the version-left-out run of a delete keeps the control arm unchanged (it sends the version), so it needs none of its own here.
  const out: DelObs = { tool: t.tool, kind, reps: [], control: !write && hasControl(res, 'read', 'patch', 'delete') ? [] : null };
  const label = ctx.label('DEL');
  const f1 = res.fields?.[1] ?? null;
  // Positive control: the same call from a fresh read, with no other writer, must succeed and take effect;
  // otherwise a refusal of the stale call says nothing about conflicts (a bad template, a permission, a validation error).
  {
    const sc0 = await scratch(ctx, res, { tag: 'sdp', purpose: 'MWS-CONC-2 positive control', label });
    if (sc0.ok) {
      const d0 = sc0.driver!;
      const r0 = await d0.readOnce(label, ctx.session.stepId('stale-positive.read'));
      const r = r0.ok ? await ctx.session.call(label, t.tool, render(positiveArgs ?? t.args, d0.vars({ version: r0.version, object: r0.obj })), { step: ctx.session.stepId('stale-positive.call') }) : null;
      const back = r ? await d0.readSettled(label, 'stale-positive.after', () => false) : null;
      const effect = !back || !r0.ok ? null : asWrite ? (back.ok ? withoutIgnored(diff(r0.obj, back.obj), ignoredPaths(res)).length > 0 : null) : goneFrom(res, back);
      out.positive = { ok: !!r?.ok, effect, step: r?.step ?? null };
    } else out.positive = { ok: false, effect: null, step: null };
  }
  for (let i = 0; i < reps; i++) {
    const rep: DelRep = { version: null, del: null, gone: null, other_kept: null, steps: [] };
    out.reps.push(rep);
    const sc = await scratch(ctx, res, { tag: 'sd', purpose: 'MWS-CONC-2 stale delete', label });
    if (!sc.ok) {
      rep.skip = `scratch object: ${sc.reason}`;
      continue;
    }
    const d = sc.driver!;
    const first = await d.readOnce(label, ctx.session.stepId('stale-delete.read'));
    if (!first.ok || first.version === null || first.version === undefined) {
      rep.skip = first.ok ? `no version at ${res.version?.read ?? '(version.read not declared)'}` : 'the scratch object did not read back';
      continue;
    }
    rep.version = first.version;
    let otherVal: unknown = null;
    if (f1 && res.update) {
      otherVal = f1.values[1];
      // why: MWS-CONC-2 option A: the second writer reads and changes the object through the same connection and credential.
      const oread = await d.readOnce(label, ctx.session.stepId('stale-delete.other.read'));
      if (!oread.ok) {
        rep.skip = "the second writer's read failed";
        continue;
      }
      const u = await d.update(label, f1, otherVal, { step: ctx.session.stepId('stale-delete.other'), base: { obj: oread.obj, version: oread.version } });
      if (!u.ok) {
        rep.skip = `the second writer's update failed: ${u.text ?? u.rpc_error?.message ?? 'error'}`;
        continue;
      }
    } else {
      rep.skip = 'no field for the second writer';
      continue;
    }
    // why: the condition is forced only if the second writer's change took effect (review: an update answered as a success that did not store).
    const mid = await d.readOnce(label, ctx.session.stepId('stale-write.mid'));
    if (!mid.ok || !deepEqual(valueAt(mid.obj, f1.path), otherVal) || deepEqual(mid.version, first.version)) {
      rep.skip = "the second writer's change did not take effect (or the version did not move), so the call would not be stale";
      continue;
    }
    const step = ctx.session.stepId(`stale-${asWrite ? 'write' : 'delete'}.call`);
    // why: the stale call carries what the first read gave (a whole-object body from the first read), never the state after the second writer.
    const r = await ctx.session.call(label, t.tool, render(t.args, d.vars({ version: first.version, object: first.obj })), { step });
    rep.del = brief(r);
    rep.steps.push(first.call?.step ?? '', step);
    const back = await d.readSettled(label, 'stale-delete.after', () => false);
    if (asWrite) rep.gone = !mid?.ok || !back.ok ? null : withoutIgnored(diff(mid.obj, back.obj), ignoredPaths(res)).length > 0;
    else rep.gone = goneFrom(res, back);
    rep.other_kept = back.ok ? deepEqual(valueAt(back.obj, f1.path), otherVal) : null;
    rep.current_version = back.ok ? back.version : null;
    if (back.call) rep.steps.push(back.call.step);
  }
  if (out.control) {
    for (let i = 0; i < reps; i++) {
      const sc = await scratch(ctx, res, { tag: 'sdc', purpose: 'MWS-CONC-2 stale delete, control arm', label });
      if (!sc.ok || !f1) continue;
      const d = sc.driver!;
      const r0 = await d.controlRead(ctx.session.stepId('stale-delete.ctl.read'));
      if (!r0.ok) continue;
      const p = await d.controlPatch(f1, f1.values[1], ctx.session.stepId('stale-delete.ctl.other'));
      if (!p.ok) continue;
      // why: a control patch the platform ignored would make the delete look unconditioned (CLI-BUGS item 12, review).
      const m = await d.controlRead(ctx.session.stepId('stale-delete.ctl.mid'));
      if (!m.ok || !deepEqual(valueAt(m.obj, f1.path), f1.values[1])) continue;
      const del = await d.controlRequest(res.control!.delete!, { version: r0.version }, ctx.session.stepId('stale-delete.ctl.delete'));
      const back = await d.controlRead(ctx.session.stepId('stale-delete.ctl.after'));
      out.control.push({ status: del.status, gone: back.http?.status === 404 ? true : back.ok ? false : null });
    }
  }
  return out;
}

export function deleteVerdicts(o: DelObs, res: ResourceSpec, ctx: PlanContext): Result[] {
  if (o.version_left_out) {
    // why: in this run a refusal is row 1 only as a conflict or where it says a version or an explicit override is needed (review).
    const v = res.version!;
    // why: rule 11 (note 19): a refusal is row 1 where it names the version argument or the override (by name), or a
    // declared patterns.version_required reads it; the default pattern alone decides nothing, and such a repetition is not judged.
    const word = (t: string, w: string) => new RegExp(`(^|[^A-Za-z0-9_])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9_])`).test(t);
    // why: rule-11 coverage package: structured signals first: a conflict (409, 412, a Status reason Conflict, a conflict code)
    // or a version-required signal (428, precondition_required) is row 1 before any text is read.
    const why = (t: string | null): 'named' | 'declared' | 'default' | null => !t ? null : word(t, v.arg!) || (!!v.override && word(t, v.override)) ? 'named' : fromDeclaration('version_required') ? (saysKind('version_required', t) ? 'declared' : null) : saysKind('version_required', t) ? 'default' : null;
    o = { ...o, reps: o.reps.map((r) => {
      if (!(r.del && !r.del.ok && !r.del.indeterminate)) return r;
      if (conflictSignal(r.del) || versionRequiredSignal(r.del)) return r;
      const t = r.del.text ?? r.del.rpc_error?.message ?? null;
      const k = why(t);
      if (k === 'named' || k === 'declared') return r;
      return { ...r, skip: k === 'default' ? `the call without the version was refused, and only the tester's default pattern reads the refusal as asking for a version (${short(t ?? '', 80)}); declare patterns.version_required, or read it (spec 7.3, rule 11)` : `the call without the version was refused for another reason (${short(t ?? '', 80)})` };
    }) };
    // why: spec MWS-CONC-2: the second run has its own record, marked "version left out", decided by the same rows;
    // a refusal that asks for a version or an explicit override is row 1. Its form is not a conflict, so CONC-4 and CONC-6 are not judged on it.
    const w = wp(res.name, o.tool);
    const srcs = new Map<string, number>();
    for (const r of o.reps) {
      if (r.skip || !r.del || r.del.ok || r.del.indeterminate) continue;
      const sg = conflictSignal(r.del) ?? versionRequiredSignal(r.del);
      const t = r.del.text ?? r.del.rpc_error?.message ?? null;
      const k = sg ? sg.source : why(t) === 'named' ? `the error names ${v.arg}${v.override ? ` or ${v.override}` : ''}` : 'the declared patterns.version_required';
      srcs.set(k, (srcs.get(k) ?? 0) + 1);
    }
    const srcNote = srcs.size ? [`Each refusal counted as row 1 by: ${[...srcs].map(([k, n]) => `${k} (${n})`).join('; ')} (structured signals are read first).`] : [];
    return deleteVerdictsInner(o, res, ctx)
      .filter((r) => r.requirement === 'MWS-CONC-2')
      .map((r) => ({ ...r, scenario: { id: `${ID}.version-left-out`, version: VERSION }, write_path: w, reason: `Version left out: ${r.reason.replace(/^./, (c) => c.toLowerCase())}`.replace('was given the version the caller read and still', 'was called without the version and still').replace(' (the tool accepts a version and did not use it)', ', with no override argument sent').replace('with the version read first', 'with the version left out'), notes: [...r.notes, `The stale write was sent without ${res.version!.arg}${res.version!.override ? ` and without ${res.version!.override}` : ''}; leaving out an optional version is not an override (spec NF-7). The control arm, where one exists, sends the version.`, ...srcNote] }));
  }
  return deleteVerdictsInner(o, res, ctx);
}

function deleteVerdictsInner(o: DelObs, res: ResourceSpec, ctx: PlanContext): Result[] {
  const w = wp(res.name, o.tool);
  const sc = { id: ID, version: VERSION };
  // why: a read-back whose outcome is unknown (gone === null) says nothing either way; that repetition is not judged.
  const valid = o.reps.filter((r) => !r.skip && r.del && !r.del.indeterminate && r.gone !== null);
  if (o.positive && !(o.positive.ok && o.positive.effect === true)) return (['MWS-CONC-2', 'MWS-CONC-4'] as const).map((id) => result(id, w, sc, 'not tested', `the positive control failed: ${o.tool} called from a fresh read, with no other writer, ${!o.positive!.ok ? 'was refused' : o.positive!.effect === null ? 'could not be read back' : 'took no effect'}, so a refusal of the stale call would not show a conflict (check the arguments in the manifest)`, { steps: o.positive!.step ? [o.positive!.step] : [] }));
  if (!valid.length) return (['MWS-CONC-2', 'MWS-CONC-4'] as const).map((id) => result(id, w, sc, 'not tested', `no valid repetition of the stale ${o.kind === 'write' ? 'write' : 'delete'} (${o.reps.map((r) => r.skip ?? (r.del?.indeterminate ? 'outcome unknown' : '')).filter(Boolean).join('; ') || 'none ran'})`));
  // why: for a write, "applied" means the other writer's change was lost; a merge that kept both is NF-12 (not judged here).
  const staleWon = valid.filter((r) => r.del!.ok && r.gone === true && (o.kind !== 'write' || r.other_kept === false));
  const merged = o.kind === 'write' ? valid.filter((r) => r.del!.ok && r.gone === true && r.other_kept !== false) : [];
  // why: for a write (not a delete), an answer without an error that left the object as the second writer left it is
  // a refusal returned as an ordinary result; it counts as refused here and is judged in form by MWS-CONC-4.
  // why: rule-11 coverage package: a structured signal (409/412, a Status reason Conflict, a conflict code) shows the conflict;
  // the tester's built-in words alone decide nothing (spec 7.3, rule 11), so such a repetition needs reading.
  const quiet = o.kind === 'write' ? valid.filter((r) => r.del!.ok && r.gone === false && r.other_kept === true && shownBy(r.del!) === 'signal') : [];
  const quietDefault = o.kind === 'write' ? valid.filter((r) => r.del!.ok && r.gone === false && r.other_kept === true && shownBy(r.del!) === 'default') : [];
  const refused = valid.filter((r) => !r.del!.ok || quiet.includes(r));
  // why: research builds N5: a control delete whose template carries no {{version}} never sent the version, so what the platform
  // did with it says nothing about a stale version: it is neither `platform` nor an attribution.
  const ctlVersioned = !!res.control?.delete && /\{\{\s*(json:|\?)?version\b/.test(JSON.stringify(res.control.delete));
  const ctlValid = ctlVersioned ? (o.control ?? []).filter((c) => c.status !== null) : [];
  const ctlRefused = ctlValid.length > 0 && ctlValid.every((c) => c.status === 409 || c.status === 412);
  const ctlApplied = ctlValid.some((c) => c.status !== null && c.status >= 200 && c.status < 300 && c.gone === true);
  const numbers = { repetitions: valid.length, stale_deleted: staleWon.length, refused: refused.length, ...(o.control ? { control_repetitions: ctlValid.length, control_refused: ctlValid.filter((c) => c.status === 409 || c.status === 412).length } : {}) };
  const out: Result[] = [];
  if (staleWon.length) {
    if (ctlApplied) out.push(result('MWS-CONC-2', w, sc, 'platform', `${o.tool} deleted an object changed since the caller's read in ${staleWon.length} of ${valid.length} repetitions, and the platform's API deleted it too with the stale version.`, { numbers, steps: staleWon.flatMap((r) => r.steps), notes: [ruleNote('RAW_API_CONTROL', 'the API accepts the stale delete')] }));
    else out.push(result('MWS-CONC-2', w, sc, 'violated', `${o.tool} was given the version the caller read and still ${o.kind === 'write' ? 'wrote to' : 'deleted'} the object after another writer changed it, in ${staleWon.length} of ${valid.length} repetitions${ctlRefused ? '; the platform\'s API refused the same stale delete' : ' (the tool accepts a version and did not use it)'}.`, { numbers, attribution: ctlRefused ? 'server' : 'unresolved', steps: staleWon.flatMap((r) => r.steps), notes: [VIOLATED_CAVEAT] }));
  } else if (merged.length) out.push(result('MWS-CONC-2', w, sc, 'not tested', `${merged.length} of ${valid.length} stale call(s) through ${o.tool} were applied and the other writer's change survived: writes to different fields that both survive say nothing about a version check (spec NF-12).`, { numbers }));
  else if (refused.length === valid.length) out.push(result('MWS-CONC-2', w, sc, 'held', `The stale ${o.kind === 'write' ? 'write' : 'delete'} was refused in all ${valid.length} forced repetitions (read, another writer changes the object, ${o.tool} with the version read first).`, { numbers, notes: [ruleNote('VERSION_REQUIRED', 'the refusal is the contract working'), ...signalNote(refused.map((r) => r.del!))] }));
  else if (quietDefault.length) out.push(result('MWS-CONC-2', w, sc, 'not tested', `${quietDefault.length} of ${valid.length} stale call(s) through ${o.tool} were answered without an error and left the object as the other writer left it; no structured signal shows a conflict, and only the tester's built-in words read the answer as one, which decides nothing (spec 7.3, rule 11). It needs reading: ${JSON.stringify(short(quietDefault[0]!.del!.text ?? '', 160))}`, { numbers }));
  else {
    const kept = valid.filter((r) => r.del!.ok && r.gone === false);
    // why: held needs the stale call refused (spec MWS-CONC-2); an accepted call that left the object is not that.
    out.push(result('MWS-CONC-2', w, sc, 'not tested', `${valid.length - refused.length} of ${valid.length} stale call(s) were accepted without taking effect; a stale ${o.kind === 'write' ? 'write' : 'delete'} that is neither refused nor applied does not show the version was checked.`, { numbers }));
    if (kept.length && o.kind !== 'write') out.push(result('MWS-RES-1', w, sc, 'violated', `${o.tool} reported success for ${kept.length} delete(s), but the object still reads back.`, { numbers, steps: kept.flatMap((r) => r.steps) }));
  }
  if (o.control && !ctlVersioned) out.push(result('MWS-CONC-1', w, sc, 'not tested', `the declared control.delete sends no {{version}}, so the platform's own check of a stale delete was not tried (declare the version in its path, body or headers)`, { numbers }));
  else if (o.control) {
    if (ctlRefused) out.push(staleWon.length ? result('MWS-CONC-1', w, sc, 'violated', `The platform's API refuses a stale delete (${ctlValid.length} of ${ctlValid.length}), but ${o.tool} deleted the changed object in ${staleWon.length} of ${valid.length}: the tool does not keep the check the backend offers.`, { numbers, steps: staleWon.flatMap((r) => r.steps), notes: [VIOLATED_CAVEAT] }) : result('MWS-CONC-1', w, sc, 'held', `The backend refuses a stale delete and ${o.tool} kept that check in ${valid.length} forced repetitions.`, { numbers }));
    else if (ctlApplied) out.push(result('MWS-CONC-1', w, sc, 'not applicable', 'the backend did not apply the declared control (the platform\'s API deleted with the stale version).', { numbers, notes: ['Only a version check sent with the write was declared and tried; another kind of control (such as a lock held by another user) is not staged in this preview.'] }));
    else out.push(result('MWS-CONC-1', w, sc, 'not tested', 'The control arm neither refused nor applied the stale delete consistently; the backend\'s check could not be established.', { numbers }));
  }
  if (!ctlApplied || !staleWon.length) out.push(conc5Record(w, sc, ctlRefused));
  else {
    const q: Question = { id: questionId('MWS-CONC-5', w, 'description'), requirement: 'MWS-CONC-5', write_path: w, question: `The backend applied the stale call (MWS-CONC-2, row 3). Does ${o.tool}'s description state that stale writes are not detected, or are detected only on a best-effort basis?`, evidence: [{ step: null, text: String(ctx.tools.find((t) => t.name === o.tool)?.description ?? '') }] };
    out.push(reviewResult(sc, q, answerOf(ctx, q, ctx.review?.stale_writes_disclosed ?? null)));
  }
  // MWS-CONC-4 on the delete tool
  if (!refused.length) out.push(result('MWS-CONC-4', w, sc, 'not tested', `No conflict was produced on the ${o.kind === 'write' ? `stale-write path of ${o.tool}` : 'delete path'}, so its form could not be checked.`, { numbers }));
  else {
    const notToolError = refused.filter((r) => !r.del!.isError);
    const applied = refused.filter((r) => r.gone === true || r.other_kept === false);
    if (notToolError.length || applied.length) out.push(result('MWS-CONC-4', w, sc, 'violated', `${notToolError.length ? `${notToolError.length} of ${refused.length} refusals were not tool execution errors (a protocol error or no isError). ` : ''}${applied.length ? `${applied.length} refused delete(s) left the object changed or gone.` : ''}`.trim(), { numbers, steps: [...notToolError, ...applied].flatMap((r) => r.steps) }));
    else out.push(result('MWS-CONC-4', w, sc, 'held', `Each of the ${refused.length} refused stale ${o.kind === 'write' ? 'writes' : 'deletes'} was a tool execution error (isError: true) and left the object as the second writer left it.`, { numbers }));
    out.push(conflictWording(ctx, w, refused.map((r) => ({ step: r.del!.step, text: r.del!.text ?? JSON.stringify(r.del!.data ?? null) }))));
    out.push(...conflictState(ctx, w, res, refused.map((r) => ({ step: r.del!.step, text: r.del!.text, data: r.del!.data, other: res.fields?.[1]?.values[1] ?? null, version: r.current_version ?? null, tool: r.del!.tool ?? null, shape: r.del!.shape ?? null }))));
  }
  return out;
}

/** MWS-CONC-4, review-only: does the conflict say the write was not applied? */
/**
 * MWS-CONC-6: black-box, does each conflict carry the object's current state (the value the second writer wrote
 * and, where a version is declared, the current version under the declared name)? If not, the re-read clause is
 * review-only: answered from review.conflict_says_reread, else not tested.
 */
/** The version as the value of `current_version`, `currentVersion`, or of the declared name inside a `current` object. */
export function versionIn(data: unknown, name: string, version: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  // why: review: object or list versions compare by their JSON, never by String() ("[object Object]").
  const same = (x: unknown) => x !== undefined && x !== null && (typeof x === 'object' || typeof version === 'object' ? JSON.stringify(x) === JSON.stringify(version) : String(x) === String(version));
  if (same(d['current_version']) || same(d['currentVersion'])) return true;
  const cur = d['current'];
  return !!cur && typeof cur === 'object' && same((cur as Record<string, unknown>)[name]);
}

type ConflictSeen = { step: string | null; text: string | null; data: unknown; other: unknown; version: unknown; tool?: string | null; shape?: ShapeCapture | null };

/**
 * MWS-CONC-6 from an adopted result shape (rule 11; B-9 "Conflict"): the conflict carries the current state where
 * `conflict.current_state` holds the second writer's value at its field (not listed in `omitted`) and, where a version is
 * declared, `conflict.current_version` is the version the object reads with. A wrong one is not the current state: it never
 * gives held, and the text is not read to make up for it. Where the shape gives no state but `repeat: "read_first"`, it tells
 * the caller to read again (the review-only clause), by the member. Null where the shape decides nothing.
 */
function conflictByShape(c: ConflictSeen, res: ResourceSpec): { carries: boolean; why: string; note: string; reread: boolean } | null {
  const sh = shapeOf(c);
  if (!sh || (!sh.conflict && sh.code !== 'conflict')) return null;
  const f1 = res.fields?.[1]?.path ?? null;
  // why: without the second writer's field the tester cannot check the state: the shape decides nothing (as the text cannot give held).
  if (f1 === null) return null;
  const cf = sh.conflict ?? {};
  const st = cf.current_state;
  const omitted = f1 !== null && (cf.omitted ?? []).some((p) => p === toPointer(f1) || toPointer(f1).startsWith(`${p}/`));
  const value = f1 !== null && st ? valueAt(st, f1) : undefined;
  const valueOk = st !== undefined && !omitted && deepEqual(value, c.other);
  const versionOk = !res.version || c.version === null || c.version === undefined || sameValue(cf.current_version, c.version);
  const why = [st === undefined ? 'mws.conflict.current_state is absent' : omitted ? `${f1} is listed in mws.conflict.omitted` : !valueOk ? `${quoteField(`conflict.current_state.${f1}`, value ?? null)} where the object reads ${JSON.stringify(c.other)}` : '', !versionOk ? `${quoteField('conflict.current_version', cf.current_version ?? null)} where the object reads ${JSON.stringify(String(c.version))}` : ''].filter(Boolean).join('; ');
  return { carries: valueOk && versionOk, why, note: decidedByShape([['code', sh.code], ['conflict', sh.conflict], ['repeat', sh.repeat], ['read_with', sh.read_with]], c), reread: sh.repeat === 'read_first' };
}

export function conflictState(ctx: PlanContext, w: ReturnType<typeof wp>, res: ResourceSpec, cs: ConflictSeen[]): Result[] {
  if (!cs.length) return [];
  const sc = { id: ID, version: VERSION };
  const name = res.version ? lastSeg(res.version.read) : null;
  // why: rule 11: where every conflict carries the adopted result shape with a conflict, the shape decides; a wrong one is not current state.
  const byShape = cs.map((c) => conflictByShape(c, res));
  if (byShape.every((x) => x !== null)) {
    const notes = [...new Set(byShape.map((x) => x!.note))];
    if (byShape.every((x) => x!.carries)) return [result('MWS-CONC-6', w, sc, 'held', `Each of the ${cs.length} conflict(s) carried the object's current state in its adopted result shape (conflict.current_state with the second writer's value${name ? `, and conflict.current_version` : ''}).`, { notes })];
    const bad = byShape.filter((x) => !x!.carries).map((x) => x!.why);
    const q: Question = { id: questionId('MWS-CONC-6', w, 're-read'), requirement: 'MWS-CONC-6', write_path: w, question: 'The conflict does not carry the current state. Does it tell the caller to read the object again before retrying?', evidence: cs.map((c) => ({ step: c.step, text: c.text ?? JSON.stringify(c.data ?? null) })) };
    // why: B-9 v2 and spec 8.2 rule 11: the shape never answers a review-only clause; a person answers it and may cite the shape.
    const r = reviewResult(sc, q, answerOf(ctx, q, ctx.review?.conflict_says_reread ?? null));
    const cite = byShape.every((x) => x!.reread) ? [`For the reader: each conflict's adopted result shape says ${quoteField('repeat', 'read_first')}; the shape does not answer this review-only clause (B-9 v2).`] : [];
    r.notes.unshift(`The adopted result shape's conflict does not carry the current state (${[...new Set(bad)].join(' | ')}), so it does not carry it; the text was not read to make up for it.`, ...notes, ...cite);
    return [r];
  }
  const fbs = cs.map((c) => shapeFallbackNote(c)).filter((x): x is string => !!x);
  const carries = (c: (typeof cs)[number]) => {
    const hay = `${c.text ?? ''}\n${JSON.stringify(c.data ?? null)}`;
    const value = mentions({ text: c.text, data: c.data }, c.other);
    // why: R6-5: the current version as the value of a field of the declared name, or stated in the text as the current version.
    const ev = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const V = ev(String(c.version));
    // why: writesafe self-test T6: a field named current_version (or currentVersion), or the version inside a `current` object, counts too.
    const version = !name || c.version === null || c.version === undefined || versionIn(c.data, name, c.version) || new RegExp(`"(${ev(name)}|current_?version|currentVersion)"\\s*:\\s*${ev(JSON.stringify(c.version))}(?![0-9])|\\b${ev(name)}\\s*(is|=|:|now)?\\s*"?${V}\\b|\\bcurrent(ly)?\\b[^.\\n]{0,40}?\\b(version|${ev(name)})\\b[^.\\n]{0,12}?\\b${V}\\b`, 'i').test(hay);
    return value && version;
  };
  if (cs.every(carries)) return [result('MWS-CONC-6', w, sc, 'held', `Each of the ${cs.length} conflict(s) carried the object's current state (the second writer's value${name ? ` and ${name}` : ''}).`, { notes: [...new Set(fbs)] })];
  const q: Question = { id: questionId('MWS-CONC-6', w, 're-read'), requirement: 'MWS-CONC-6', write_path: w, question: 'The conflict does not carry the current state. Does it tell the caller to read the object again before retrying?', evidence: cs.map((c) => ({ step: c.step, text: c.text ?? JSON.stringify(c.data ?? null) })) };
  return [reviewResult(sc, q, answerOf(ctx, q, ctx.review?.conflict_says_reread ?? null))];
}

function conflictWording(ctx: PlanContext, w: ReturnType<typeof wp>, evidence: { step: string | null; text: string }[]): Result {
  const q: Question = { id: questionId('MWS-CONC-4', w, 'wording'), requirement: 'MWS-CONC-4', write_path: w, question: 'Does each conflict result say that the write was not applied?', evidence };
  return reviewResult({ id: ID, version: VERSION }, q, answerOf(ctx, q, ctx.review?.conflict_says_not_applied ?? null));
}

export function staleVerdicts(out: ExperimentOutcome, res: ResourceSpec, ctx: PlanContext = { manifest: { resources: [res] } as never, tools: [] }, descriptions: Record<string, string> = {}): Result[] {
  const w = wp(res.name, res.update!.tool);
  const sc = { id: ID, version: VERSION };
  const c = (arm: string, k: string) => out.arms[arm]?.counts[k] ?? 0;
  const ran = (arm: string) => out.arms[arm] !== undefined;
  const all3 = (v: 'not tested', why: string) => (['MWS-CONC-2', 'MWS-CONC-4', ...(ran('control') || hasControl(res, 'read', 'patch', 'write') ? (['MWS-CONC-1'] as const) : [])] as const).map((id) => result(id, w, sc, v, why));
  if (out.stopped) return all3('not tested', `the run stopped: ${out.stopped}`);
  const unapplied = c('validity', 'success_unapplied');
  // why: NF-19: an operation the declaration lists as completed asynchronously is not judged here (readback's RES-1 handles it).
  const asyncOp = (ctx.manifest.async_operations ?? []).includes(res.update!.tool);
  const res1 = unapplied > 0 && !asyncOp ? [result('MWS-RES-1', w, { id: `${ID}.validity`, version: VERSION }, 'violated', `${res.update!.tool} answered a write of ${res.fields![0].path} as a success, and a read through the same server process afterwards (within the settle window) did not show the value written, in ${unapplied} of ${c('validity', 'valid') || 1} repetition(s) of the stale-write test's validity arm (one writer after the other, each from a fresh read): a success that left nothing applied.`, { steps: witness(out, 'validity', 'success_unapplied'), notes: [`Settle window: ${res.read.settle_ms} ms (read.settle_ms); the read was repeated until the value showed or the window passed.`] })] : [];
  if (c('validity', 'valid') < 1 || c('validity', 'both_kept') < c('validity', 'valid')) return [...res1, ...all3('not tested', `the two fields are not independent one after the other (writing ${res.fields![0].path} and ${res.fields![1].path} in sequence, in both orders, did not keep both), so a stale write cannot be told apart; see MWS-UPD-1`)];
  const valid = c('test', 'valid');
  if (valid < 1) return all3('not tested', `no valid repetition (${c('test', 'setup_failures')} setup failures, ${c('test', 'exceptions')} exceptions)`);
  const numbers = { repetitions: valid, stale_won: c('test', 'stale_won'), refused: c('test', 'rejected'), both_kept: c('test', 'both_kept'), ...(ran('control') ? { control_repetitions: c('control', 'valid'), control_conflict: c('control', 'conflict'), control_stale_lost: c('control', 'stale_2xx_lost') } : {}) };
  const results: Result[] = [];
  const controlLost = ran('control') && c('control', 'stale_2xx_lost') >= 1;
  // A success that applied nothing counts as a refusal only where its answer shows the conflict (spec MWS-CONC-2 row 1:
  // "refused ... with a conflict"); otherwise it is a success without the change (MWS-RES-1).
  const silentReps = repsWhere(out, 'test', 'silent_noop');
  const showsBy = (e: Record<string, unknown>) => {
    const wr = (e['write'] ?? {}) as { text?: string | null; data?: unknown; tool?: string | null; shape?: ShapeCapture | null };
    return shownBy({ text: wr.text ?? null, data: wr.data, tool: wr.tool ?? undefined, shape: wr.shape ?? null });
  };
  const shows = (e: Record<string, unknown>): boolean => showsBy(e) === 'signal';
  const silentShown = silentReps.filter((r) => shows(r.env)).length;
  // why: rule-11 coverage package: only the tester's built-in words read a conflict here; neither held nor violated rests on that.
  const silentDefault = silentReps.filter((r) => showsBy(r.env) === 'default');
  const silentHidden = silentReps.filter((r) => showsBy(r.env) === null);
  const rejectedWrites = repsWhere(out, 'test', 'rejected').map((r) => ((r.env['write'] ?? {}) as { text?: string | null; data?: unknown; tool?: string | null; shape?: ShapeCapture | null })).map((x) => ({ text: x.text ?? null, data: x.data, tool: x.tool ?? undefined, shape: x.shape ?? null }));
  const controlRefused = ran('control') && c('control', 'valid') >= 1 && c('control', 'conflict') === c('control', 'valid');
  // MWS-CONC-2
  if (c('test', 'stale_won') >= 1) {
    const steps = witness(out, 'test', 'stale_won');
    if (controlLost) {
      results.push(result('MWS-CONC-2', w, sc, 'platform', `A stale write through ${res.update!.tool} overwrote another client's change in ${c('test', 'stale_won')} of ${valid} repetitions, and the platform's API accepted the same stale write (${c('control', 'stale_2xx_lost')} of ${c('control', 'valid')}).`, { numbers, steps, notes: [ruleNote('RAW_API_CONTROL', 'the API loses the change too'), 'The description is judged under MWS-CONC-5 (review-only).'] }));
      const q: Question = { id: questionId('MWS-CONC-5', w, 'description'), requirement: 'MWS-CONC-5', write_path: w, question: `The backend applied the stale write (MWS-CONC-2, row 3). Does ${res.update!.tool}'s description state that stale writes are not detected, or are detected only on a best-effort basis?`, evidence: [{ step: null, text: descriptions[res.update!.tool] ?? '' }] };
      results.push(reviewResult(sc, q, answerOf(ctx, q, ctx.review?.stale_writes_disclosed ?? null)));
    }
    // Spec MWS-CONC-2, rows 2 and 4: violated, attributed to the server when the control arm refused, unresolved without one.
    else results.push(result('MWS-CONC-2', w, sc, 'violated', `A write through ${res.update!.tool} made from a stale read overwrote another client's change to ${res.fields![1].path} in ${c('test', 'stale_won')} of ${valid} repetitions.${ran('control') ? ` The platform's API refused the same stale write in ${c('control', 'conflict')} of ${c('control', 'valid')}.` : ' No control was declared, so the backend was not checked.'}${res.version?.arg ? ` ${res.update!.tool} accepts a version and did not use it.` : ''}`, { numbers, steps, attribution: controlRefused ? 'server' : 'unresolved', notes: [VIOLATED_CAVEAT, ...(ran('control') && !controlRefused ? ['The control arm neither refused every stale write nor lost the change (its out-of-band change may not have taken effect), so it decides no attribution.'] : [])] }));
  } else if (c('test', 'rejected') + c('test', 'silent_noop') === valid && silentShown === c('test', 'silent_noop')) {
    results.push(result('MWS-CONC-2', w, sc, 'held', `The stale write was refused in all ${valid} forced repetitions (one schedule, through one connection and one credential: the first writer's read, the second writer's read and change, the first writer's write).`, { numbers, notes: [ruleNote('VERSION_REQUIRED', 'the refusal is the contract working'), ...signalNote(rejectedWrites)] }));
  } else if (silentDefault.length) {
    const wr = (silentDefault[0]!.env['write'] ?? {}) as { text?: string | null };
    results.push(result('MWS-CONC-2', w, sc, 'not tested', `${silentDefault.length} of ${valid} stale write(s) through ${res.update!.tool} were answered without an error and did not change ${res.fields![0].path}; no structured signal shows a conflict, and only the tester's built-in words read the answer as one, which decides nothing (spec 7.3, rule 11). It needs reading: ${JSON.stringify(short(wr.text ?? '', 160))}`, { numbers }));
  } else {
    // why: spec MWS-CONC-2's held is "the stale write was refused with a conflict"; a merge of different fields (NF-12) shows nothing either way.
    results.push(result('MWS-CONC-2', w, sc, 'not tested', `The stale write was accepted and merged in ${c('test', 'both_kept')} of ${valid} repetitions (the other client's change survived); a different-field stale write that merges cannot show whether the version was checked. Same-field staleness is not tested in this release (${c('test', 'rejected')} refused, ${c('test', 'both_kept')} accepted and merged).`, { numbers, notes: silentHidden.length ? [`${silentHidden.length} write(s) reported success but ${res.fields![0].path} did not change, with no conflict shown; reported under MWS-RES-1.`] : [] }));
  }
  // MWS-CONC-5 where it was not reviewed above (row 3): not applicable when the control arm refused, else not tested.
  if (!results.some((r) => r.requirement === 'MWS-CONC-5')) results.push(conc5Record(w, sc, controlRefused));
  // MWS-CONC-1
  if (ran('control')) {
    if (controlRefused) {
      if (c('test', 'stale_won') >= 1) results.push(result('MWS-CONC-1', w, sc, 'violated', `The platform's API refuses a stale write (409/412 in ${c('control', 'conflict')} of ${c('control', 'valid')}), but ${res.update!.tool} overwrote the newer state in ${c('test', 'stale_won')} of ${valid}: the tool does not keep the check the backend offers.`, { numbers, steps: witness(out, 'test', 'stale_won'), notes: [VIOLATED_CAVEAT] }));
      else results.push(result('MWS-CONC-1', w, sc, 'held', `The backend offers a version check (the API refused every stale write) and the tool kept it: no stale write through ${res.update!.tool} overwrote a newer change in ${valid} repetitions.`, { numbers }));
    } else if (controlLost) results.push(result('MWS-CONC-1', w, sc, 'not applicable', 'the backend did not apply the declared control (the platform\'s API accepted the stale write).', { numbers, notes: ['Only a version check sent with the write was declared and tried; another kind of control (such as a lock held by another user) is not staged in this preview.'] }));
    else results.push(result('MWS-CONC-1', w, sc, 'not tested', `The control arm neither refused nor lost the change consistently (${c('control', 'conflict')} conflicts, ${c('control', 'stale_2xx_lost')} lost of ${c('control', 'valid')}); the backend's check could not be established.`, { numbers }));
  }
  // A stale write answered without an error that did not take effect (and left the other change) is a refused
  // conflict returned as an ordinary result: MWS-CONC-4 (the validity arm shows the tool's writes take effect).
  const silent = silentShown;
  if (silentHidden.length) results.push(result('MWS-RES-1', w, sc, 'violated', `${silentHidden.length} stale write(s) through ${res.update!.tool} were answered as a success, but ${res.fields![0].path} did not change and the answer shows no conflict.`, { numbers, steps: Object.values(silentHidden[0]!.steps), attribution: 'unresolved' }));
  // MWS-CONC-4
  const refused = c('test', 'rejected');
  if (silent >= 1) results.push(result('MWS-CONC-4', w, sc, 'violated', `${silent} of ${valid} stale write(s) through ${res.update!.tool} were not applied (the other client's change stayed) and were answered without isError, with an answer that shows the conflict: a refused conflict returned as an ordinary result.`, { numbers, steps: Object.values(silentReps.find((r) => shows(r.env))!.steps) }));
  else if (refused === 0) results.push(result('MWS-CONC-4', w, sc, 'not tested', 'No conflict was produced in this run, so its form could not be checked.', { numbers }));
  else if (c('test', 'rejected_tool_error') === refused && c('test', 'applied_despite_refusal') === 0) results.push(result('MWS-CONC-4', w, sc, 'held', `Each of the ${refused} refusals was a tool execution error (isError: true) and left nothing applied.`, { numbers, notes: ['The wording (does it say the write was not applied?) is a separate, review-only record.'] }));
  else {
    const bad = refused - c('test', 'rejected_tool_error');
    results.push(result('MWS-CONC-4', w, sc, 'violated', `${bad ? `${bad} of ${refused} refusals were not tool execution errors (a protocol error or no isError). ` : ''}${c('test', 'applied_despite_refusal') ? `${c('test', 'applied_despite_refusal')} refused write(s) were applied anyway.` : ''}`.trim(), { numbers: { ...numbers, refused_not_tool_error: bad, applied_despite_refusal: c('test', 'applied_despite_refusal') }, steps: witness(out, 'test', 'rejected') }));
  }
  if (refused > 0) {
    const reps = (out.arms['test']?.reps ?? []).filter((r) => r.valid && (r.env['write'] as { ok?: boolean } | undefined)?.ok === false);
    const texts = reps.map((r) => ({ step: r.steps['write'] ?? null, text: String((r.env['write'] as { text?: unknown }).text ?? JSON.stringify((r.env['write'] as { data?: unknown }).data ?? null)) }));
    results.push(conflictWording(ctx, w, texts));
    // MWS-CONC-6: does each conflict carry the current state (the second writer's value, and the version under its declared name)?
    const conflicts = reps.map((r) => {
      const wr = r.env['write'] as { text?: string | null; data?: unknown; tool?: string | null; shape?: ShapeCapture | null };
      const fin = r.env['final'] as { obj?: unknown; version?: unknown } | undefined;
      return { step: r.steps['write'] ?? null, text: wr.text ?? null, data: wr.data ?? null, other: res.fields![1].values[1], version: fin?.version ?? null, tool: wr.tool ?? null, shape: wr.shape ?? null };
    });
    results.push(...conflictState(ctx, w, res, conflicts));
  }
  return results;
}

/** MWS-CONC-5 outside row 3 of MWS-CONC-2: the control arm shows the backend detects the change, or nothing shows whether it can. */
/**
 * Does an answer show a conflict? 'signal': a structured signal (409/412, a Status reason Conflict, a conflict code, conflict:
 * true); 'default': only the tester's built-in words read one (decides nothing, rule 11); null: neither.
 */
export function shownBy(a: { text: string | null; data?: unknown; tool?: string; shape?: ShapeCapture | null }): 'signal' | 'default' | null {
  // why: review: an answer without an error is read in its structured content's top level and error object only, never in text.
  if (conflictSignal(a, { success: true })) return 'signal';
  // a declared patterns.conflict reads the text (spec Annex E: "refused because of a named concurrency control"); the default alone decides nothing.
  if (!says('conflict', a.text ?? '')) return null;
  return fromDeclaration('conflict') ? 'signal' : 'default';
}

/** The record's note on what the refusals carried: each structured conflict signal by source (rule-11 coverage package). */
export function signalNote(as: { text: string | null; data?: unknown; rpc_error?: { code: number; message: string } | null }[]): string[] {
  if (!as.length) return [];
  const by = new Map<string, number>();
  for (const a of as) {
    const s: Signal | null = conflictSignal(a);
    if (s) by.set(s.source, (by.get(s.source) ?? 0) + 1);
  }
  const n = [...by.values()].reduce((x, y) => x + y, 0);
  return [n ? `${n} of ${as.length} refusal(s) carried a structured conflict signal: ${[...by].map(([k, c]) => `${k} (${c})`).join('; ')}.` : `None of the ${as.length} refusal(s) carried a structured conflict signal (409, 412, a Status reason Conflict or a conflict code); a refusal of the stale call after the positive control counts as the refusal the row needs.`];
}

function conc5Record(w: ReturnType<typeof wp>, sc: { id: string; version: string }, controlRefused: boolean): Result {
  return controlRefused
    ? result('MWS-CONC-5', w, sc, 'not applicable', 'The control arm of MWS-CONC-2 refused the stale write: the backend can detect the change.')
    : result('MWS-CONC-5', w, sc, 'not tested', 'Neither a control arm nor the declaration shows whether the backend can detect the change (declare a control, or list the tool in no_version_check).');
}

/** The stale-write experiment's control arm as per-repetition outcomes (for the version-left-out record of a whole-object tool). */
function controlFromExperiment(rec: ExperimentOutcome | null): DelObs['control'] {
  if (!rec) return null;
  const out = recount(rec.experiment, rec.arms, rec.simulated, rec.stopped);
  const c = out.arms['control']?.counts;
  if (!c) return null;
  const other = Math.max(0, (c['valid'] ?? 0) - (c['conflict'] ?? 0) - (c['stale_2xx_lost'] ?? 0));
  return [...Array.from({ length: c['conflict'] ?? 0 }, () => ({ status: 409, gone: false })), ...Array.from({ length: c['stale_2xx_lost'] ?? 0 }, () => ({ status: 200, gone: true })), ...Array.from({ length: other }, () => ({ status: 0, gone: null }))];
}
