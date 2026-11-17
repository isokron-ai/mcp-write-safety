/**
 * Tier 2, barrier pairs (client only, statistical, always run): two writes to different fields of
 * one object, released together after a barrier, from two server processes (stdio) or two sessions
 * (HTTP), or as two requests to one process (`processes: same`). Default 30 pairs. The overlap of
 * each pair is measured on the client side.
 *
 * Pairs can only give `violated` (a lost update was seen), `platform` (the platform's API loses the
 * same pair), `not observed` (none seen; with the pairs that overlapped and the upper bound on the
 * loss rate), or `not tested` (fewer than half the pairs overlapped). Never `held`: only a forced
 * interleaving (the backend gate, tier 3) can give that.
 */

import { hasControl, needsBase, valueAt } from '../core/driver.js';
import { recount, repsWhere, runExperiment, witness, type ExperimentOutcome } from '../core/exec.js';
import { validateExperiment, type Experiment } from '../core/experiment.js';
import type { ResourceSpec } from '../core/manifest.js';
import { ruleOfThree, wilson } from '../core/stats.js';
import { deepEqual } from '../core/util.js';
import { NOT_OBSERVED_SENTENCE, result, VIOLATED_CAVEAT, type Result } from '../report/verdicts.js';
import { ruleNote } from './rules.js';
import { objRef, shownBy } from './stale.js';
import type { ShapeCapture } from './shape.js';
import { notRun, wp, type CheckModule, type Observation, type PlanContext, type PlannedCheck, type RunContext } from './types.js';

const ID = 'barrier-pairs';
/** Spec 8.2 rule 6. */
export const MIN_OVERLAPPED = 30;
const VERSION = '1';


export function pairsExperiment(res: ResourceSpec, reps: number, mode: 'same' | 'separate'): Experiment {
  const [f0, f1] = res.fields!;
  const both = (s: string) => ({ all: [`${objRef(s, f0.path)} == VA`, `${objRef(s, f1.path)} == VB`] });
  const lost = (s: string) => ({ any: [`${objRef(s, f0.path)} != VA`, `${objRef(s, f1.path)} != VB`] });
  const base = needsBase(res);
  // why: like for like: a whole-object tool is compared with two whole-object writes from one read, a patch tool with two patches.
  const ctl = base ? hasControl(res, 'read', 'write') : hasControl(res, 'read', 'patch');
  const arms: Experiment['arms'] = [
    {
      name: 'validity',
      role: 'validity',
      description: `one after the other, in both orders, each through ${res.update!.tool} from a fresh read: ${f0.path} then ${f1.path}, and back; both must be kept each time`,
      reps: 1,
      reset: true,
      servers: 'per_arm',
      steps: [
        { id: 'first', kind: 'update', field: 0, value: 'VA', server: 'A', require: 'first.ok' },
        { id: 'second', kind: 'update', field: 1, value: 'VB', server: 'B', require: 'second.ok' },
        { id: 'final', kind: 'read', via: 'tool', require: 'final.ok', server: 'R', settle: both('final') },
        { id: 'back1', kind: 'update', field: 1, value: 'B1', server: 'B', require: 'back1.ok' },
        { id: 'back0', kind: 'update', field: 0, value: 'B0', server: 'A', require: 'back0.ok' },
        { id: 'final2', kind: 'read', via: 'tool', require: 'final2.ok', server: 'R', settle: { all: [`${objRef('final2', f0.path)} == B0`, `${objRef('final2', f1.path)} == B1`] } },
      ],
      counters: { both_kept: { all: [both('final'), `${objRef('final2', f0.path)} == B0`, `${objRef('final2', f1.path)} == B1`] } },
    },
    {
      name: 'test',
      role: 'test',
      description: `pairs through ${res.update!.tool}: ${f0.path} and ${f1.path} released together (${mode === 'separate' ? 'two server processes' : 'one server process'})${base ? '; both writers build on one read, as two clients reading at the same moment would' : ''}`,
      reps,
      reset: true,
      servers: 'per_arm',
      steps: [
        ...(base ? [{ id: 'read', kind: 'read' as const, via: 'tool' as const, server: 'R', require: 'read.ok' }] : []),
        { id: 'race', kind: 'pair', mode, a: { kind: 'update', field: 0, value: 'VA', ...(base ? { base: 'read' } : {}) }, b: { kind: 'update', field: 1, value: 'VB', ...(base ? { base: 'read' } : {}) } },
        { id: 'final', kind: 'read', via: 'tool', require: 'final.ok', server: 'R', settle: both('final') },
      ],
      counters: { both_ok: 'race.both_ok', silent_loss: { all: ['race.both_ok', lost('final')] }, one_error: { any: [{ all: ['race.a.ok', { not: 'race.b.ok' }] }, { all: ['race.b.ok', { not: 'race.a.ok' }] }] } },
    },
  ];
  if (ctl)
    arms.push({
      name: 'control',
      role: 'control',
      description: base ? `two whole-object writes straight to the platform's API from one read, released together` : `the same two partial updates straight to the platform's API, released together`,
      reps,
      reset: true,
      servers: 'per_arm',
      steps: [
        ...(base ? [{ id: 'cread', kind: 'read' as const, via: 'control' as const, require: 'cread.ok' }] : []),
        // A control pair counts only when both writes were accepted: a failed control attributes nothing.
        { id: 'race', kind: 'pair', mode: 'same', a: base ? { kind: 'control_write', field: 0, value: 'VA', base: 'cread' } : { kind: 'control_patch', field: 0, value: 'VA' }, b: base ? { kind: 'control_write', field: 1, value: 'VB', base: 'cread' } : { kind: 'control_patch', field: 1, value: 'VB' }, require: 'race.both_ok' },
        { id: 'final', kind: 'read', via: 'control', require: 'final.ok' },
      ],
      counters: { both_ok: 'race.both_ok', silent_loss: { all: ['race.both_ok', lost('final')] } },
    });
  return validateExperiment({
    id: `${ID}.${res.name}`,
    version: VERSION,
    hypothesis: `Two concurrent updates of ${res.name} to different fields (${f0.path}, ${f1.path}) through ${res.update!.tool} keep both changes, or one caller is told of a conflict.`,
    vars: { VA: f0.values[1], VB: f1.values[1], B0: f0.values[0], B1: f1.values[0] },
    simulated: base ? [`both writers' bodies come from one read through ${res.read.tool} (two clients reading at the same moment see the same version)`] : [],
    arms,
    verdict: {
      criterion: `reproduced if a pair lost a field while both calls reported success (test.silent_loss >= 1)${ctl ? ' and the API control lost none' : ''}; not reproduced if no pair lost a field and at least half the pairs overlapped`,
      reproduced: ctl ? { all: ['test.silent_loss >= 1', 'control.silent_loss == 0'] } : 'test.silent_loss >= 1',
      not_reproduced: { all: ['test.silent_loss == 0', `test.overlapped >= ${Math.ceil(reps / 2)}`] },
    },
    control: ctl ? { kind: 'arms', arms: ['control'] } : { kind: 'none', reason: 'the manifest declares no control read and patch for this resource, so a loss cannot be attributed to the server or its backend' },
  });
}

export const pairsCheck: CheckModule = {
  id: ID,
  version: VERSION,
  needsUpdate: true,
  requirements: ['MWS-CONC-3'],
  plan(ctx: PlanContext, res: ResourceSpec): PlannedCheck {
    const w = wp(res.name, res.update!.tool);
    const base: PlannedCheck = { check: ID, version: VERSION, resource: res.name, runs: false, calls: [], writes: 0, creates: 0, notRun: [] };
    const n = ctx.manifest.limits.pairs;
    const ctl = needsBase(res) ? hasControl(res, 'read', 'write') : hasControl(res, 'read', 'patch');
    const mode = ctx.manifest.server.processes;
    return {
      ...base,
      runs: true,
      calls: [
        `validity x1: ${res.update!.tool} ${res.fields![0].path}, then ${res.fields![1].path}; ${res.read.tool}; and back in the other order; ${res.read.tool}`,
        `test x${n}: ${needsBase(res) ? `${res.read.tool}; ` : ''}${res.update!.tool} ${res.fields![0].path} || ${res.update!.tool} ${res.fields![1].path} (released together, ${mode}); ${res.read.tool}`,
        ...(ctl ? [`control x${n}: ${needsBase(res) ? 'control read; control write' : 'control patch'} ${res.fields![0].path} || ${needsBase(res) ? 'control write' : 'control patch'} ${res.fields![1].path}; control read`] : []),
      ],
      writes: (1 + n) * 4 + (ctl ? n * 4 : 0),
    };
  },
  async collect(ctx: RunContext, res: ResourceSpec): Promise<Observation> {
    const exp = pairsExperiment(res, ctx.manifest.limits.pairs, ctx.manifest.server.processes);
    const out = await runExperiment({ session: ctx.session, driver: ctx.driver }, exp);
    return { check: ID, version: VERSION, resource: res.name, data: out };
  },
  evaluate(obs: Observation, ctx: PlanContext): Result[] {
    const res = ctx.manifest.resources.find((r) => r.name === obs.resource)!;
    const rec = obs.data as ExperimentOutcome;
    return pairsVerdicts(recount(rec.experiment, rec.arms, rec.simulated, rec.stopped), res, ctx.manifest.backend?.gate != null);
  },
};

export function pairsVerdicts(out: ExperimentOutcome, res: ResourceSpec, gateConfigured: boolean): Result[] {
  // why: review item 4: the experiment's own rule (out.verdict, kept in the observation and unchanged so the plan hash is too)
  // counts test.silent_loss from isError alone. Where the requirement verdict reads a shown conflict and differs, the record
  // says so, and the record's verdict is the one that counts.
  return conc3Verdicts(out, res, gateConfigured).map((r) =>
    out.verdict?.verdict === 'reproduced' && r.verdict !== 'violated' && r.verdict !== 'platform'
      ? { ...r, notes: [...r.notes, `The experiment's mechanical rule (${out.verdict.criterion}) says reproduced, because it counts a call without isError as a success; this record reads what the answers say (numbers conflict_shown and needs_reading), so its verdict is ${r.verdict}, and that verdict is the one that counts.`] }
      : r,
  );
}

function conc3Verdicts(out: ExperimentOutcome, res: ResourceSpec, gateConfigured: boolean): Result[] {
  const w = wp(res.name, res.update!.tool);
  const sc = { id: ID, version: VERSION };
  const c = (arm: string, k: string) => out.arms[arm]?.counts[k] ?? 0;
  const gateNote = gateConfigured ? ['The forced interleaving through backend.gate is a separate record (scenario held-request).'] : [];
  if (out.stopped) return [result('MWS-CONC-3', w, sc, 'not tested', `the run stopped: ${out.stopped}`)];
  if (c('validity', 'valid') < 1 || c('validity', 'both_kept') < c('validity', 'valid')) return [result('MWS-CONC-3', w, sc, 'not tested', `the two fields are not independent one after the other (writing ${res.fields![0].path} and ${res.fields![1].path} in sequence, in both orders, did not keep both); see MWS-UPD-1`)];
  const valid = c('test', 'valid');
  const overlapped = c('test', 'overlapped');
  // why: spec MWS-CONC-3 counts a loss only where both calls reported success, and its held covers "one caller received a
  // conflict"; a result without isError whose content says the write failed is not a success (MWS-RES-2 test method), and
  // what a result says is decided by a structured signal or a declared pattern (7.3, rule 11). So a pair in which either
  // answer shows a conflict that way is not a loss here; that answer's form (no isError) is MWS-CONC-4's to judge. A
  // conflict read only by the built-in default words decides nothing: such a pair needs reading.
  const lossReps = repsWhere(out, 'test', 'silent_loss');
  const shownIn = (e: Record<string, unknown>): 'signal' | 'default' | null => {
    const race = (e['race'] ?? {}) as Record<string, { text?: string | null; data?: unknown; tool?: string | null; shape?: ShapeCapture | null } | undefined>;
    const by = [race['a'], race['b']].map((h) => (h ? shownBy({ text: h.text ?? null, data: h.data, tool: h.tool ?? undefined, shape: h.shape ?? null }) : null));
    return by.includes('signal') ? 'signal' : by.includes('default') ? 'default' : null;
  };
  const conflictShown = lossReps.filter((r) => shownIn(r.env) === 'signal');
  const needsReading = lossReps.filter((r) => shownIn(r.env) === 'default');
  // why: review item 3: an answer that showed a conflict while its own change is in effect afterwards, and the other writer's
  // (reported as a success) is the one lost, said "refused" for a write that took effect. Both calls did not report success,
  // so it is not a CONC-3 loss under the spec text, but it is recorded, as the stale-write check records a refusal that left
  // the object changed (MWS-CONC-4 applied).
  const ownApplied = conflictShown.filter((r) => {
    const race = (r.env['race'] ?? {}) as Record<string, { text?: string | null; data?: unknown; tool?: string | null; shape?: ShapeCapture | null } | undefined>;
    const fin = (r.env['final'] ?? {}) as { ok?: boolean; obj?: unknown };
    if (!fin.ok) return false;
    const kept = [deepEqual(valueAt(fin.obj, res.fields![0].path), res.fields![0].values[1]), deepEqual(valueAt(fin.obj, res.fields![1].path), res.fields![1].values[1])];
    return (['a', 'b'] as const).some((k, i) => {
      const h = race[k];
      return !!h && shownBy({ text: h.text ?? null, data: h.data, tool: h.tool ?? undefined, shape: h.shape ?? null }) === 'signal' && kept[i] && !kept[1 - i];
    });
  });
  const loss = c('test', 'silent_loss') - conflictShown.length - needsReading.length;
  const numbers: Record<string, unknown> = { pairs: valid, pairs_overlapped: overlapped, both_ok: c('test', 'both_ok'), one_error: c('test', 'one_error'), lost: loss, ...(lossReps.length ? { conflict_shown: conflictShown.length, conflict_shown_own_applied: ownApplied.length, needs_reading: needsReading.length } : {}) };
  const conflictNote = conflictShown.length ? [`In ${conflictShown.length} pair(s) one change was absent afterwards but its answer, without isError, showed a conflict (a structured signal or the declared patterns.conflict); these are not counted as losses, and the form of such an answer is MWS-CONC-4's to judge in its own trials.`, ...(ownApplied.length ? [`In ${ownApplied.length} of them the answer that showed a conflict had its own change in effect afterwards, and the change lost was the other writer's, reported as a success: that answer said refused for a write that took effect (a false refusal). Both calls did not report success, so it is not counted as a loss here.`] : [])] : [];
  if (out.arms['control']) Object.assign(numbers, { control_pairs: c('control', 'valid'), control_lost: c('control', 'silent_loss') });
  if (valid < 1) return [result('MWS-CONC-3', w, sc, 'not tested', `no valid pair (${c('test', 'setup_failures')} setup failures, ${c('test', 'exceptions')} exceptions)`, { numbers })];
  if (loss < 1 && needsReading.length) {
    const h = ((needsReading[0]!.env['race'] ?? {}) as { a?: { text?: string | null }; b?: { text?: string | null } });
    return [result('MWS-CONC-3', w, sc, 'not tested', `In ${needsReading.length} of ${valid} pairs one change was absent afterwards while both calls answered without isError, and only the tester's built-in words read one answer as a conflict, which decides nothing (spec 7.3, rule 11). It needs reading: ${JSON.stringify(String(h.a?.text ?? '').slice(0, 160))} / ${JSON.stringify(String(h.b?.text ?? '').slice(0, 160))} (declare patterns.conflict if the answer reports a refusal).`, { numbers, steps: Object.values(needsReading[0]!.steps), notes: [...conflictNote, ...gateNote] })];
  }
  if (loss >= 1) {
    const counted = lossReps.filter((r) => shownIn(r.env) === null);
    const steps = counted.length ? Object.values(counted[0]!.steps) : witness(out, 'test', 'silent_loss');
    if (out.arms['control'] && c('control', 'silent_loss') >= 1) return [result('MWS-CONC-3', w, sc, 'platform', `Both calls reported success and one change was lost in ${loss} of ${valid} pairs; the platform's API lost ${c('control', 'silent_loss')} of ${c('control', 'valid')} of the same pairs.`, { numbers, steps, notes: [ruleNote('RAW_API_CONTROL', 'the API loses concurrent partial updates too'), VIOLATED_CAVEAT, ...conflictNote, ...gateNote] })];
    return [result('MWS-CONC-3', w, sc, 'violated', `Both calls reported success and one change was lost in ${loss} of ${valid} pairs (${overlapped} overlapped).${!out.arms['control'] ? ' No control was declared, so the backend was not checked.' : c('control', 'valid') >= 1 ? ` The platform's API lost none of ${c('control', 'valid')} accepted pairs (${c('control', 'overlapped')} overlapped; side by side, R10-4: tool arm ${loss} lost of ${valid} pairs, ${overlapped} overlapped; control arm 0 lost of ${c('control', 'valid')} pairs, ${c('control', 'overlapped')} overlapped).` : ' The platform\'s API never accepted both writes of a pair (it refused one, or the control failed), so it shows no loss to compare.'}`, { numbers, steps, attribution: out.arms['control'] && c('control', 'overlapped') >= MIN_OVERLAPPED ? 'server' : 'unresolved', notes: [VIOLATED_CAVEAT, ...conflictNote, ...(needsReading.length ? [`${needsReading.length} further pair(s) lost a change where only the built-in words read an answer as a conflict; they are not counted (spec 7.3, rule 11).`] : []), ...gateNote, ...(out.arms['control'] && c('control', 'overlapped') < MIN_OVERLAPPED ? [`The control arm lost none in ${c('control', 'overlapped')} overlapped pairs; "none lost" needs ${MIN_OVERLAPPED} (spec 8.2, rule 6), so it does not show that the platform keeps both changes, and the attribution stays unresolved (gate-2 Grafana item 3).`] : [])] })];
  }
  // Spec 8.2 rule 6: not observed needs at least 30 overlapped pairs with no loss.
  if (overlapped < MIN_OVERLAPPED) return [result('MWS-CONC-3', w, sc, 'not tested', `too few overlapped pairs: ${overlapped} of ${valid} pairs were in flight together, and ${MIN_OVERLAPPED} are needed before "not observed" (raise limits.pairs)`, { numbers, notes: [...conflictNote, ...gateNote] })];
  const wi = wilson(0, overlapped);
  const r3 = ruleOfThree(overlapped);
  Object.assign(numbers, { loss_rate_upper_95_wilson: wi ? Math.round(wi.hi * 10_000) / 10_000 : null, loss_rate_upper_95_rule_of_three: r3 ? Math.round(r3.approx * 10_000) / 10_000 : null });
  return [result('MWS-CONC-3', w, sc, 'not observed', `No lost update in ${valid} simultaneous pairs (${overlapped} overlapped); the per-pair loss rate under these conditions could still be up to about ${r3 ? Math.round(r3.approx * 100) : '?'}% (95% bound). ${NOT_OBSERVED_SENTENCE}`, { numbers, notes: [...conflictNote, ...gateNote] })];
}
