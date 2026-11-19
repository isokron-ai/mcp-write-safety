/**
 * Run an experiment's arms and apply its verdict rule mechanically. For every repetition: reset the
 * object's two fields (if the arm says so), run the steps in order (fresh server processes per
 * repetition unless the arm says per_arm), and take each counter that holds. A step whose `require`
 * fails, or a reset that fails, makes the repetition a setup failure: it is counted, its counters
 * are not. An exception is counted as such and the run continues; a budget or rate-limit stop ends
 * the experiment and is reported.
 *
 * Every repetition's step results are kept (`reps[].env`), so `recount` can recompute the counters
 * and the verdict offline from a recorded run, with whatever the current rules are.
 */

import { readText } from '../checks/shape.js';
import { evaluate, explain, type Cond } from './conditions.js';
import type { Driver, ReadResult } from './driver.js';
import type { Arm, Experiment, Step } from './experiment.js';
import { halfIndeterminate, halfOk, pair, type HalfResult } from './primitives.js';
import { BudgetExhausted, Interrupted, RateLimited, type CallResult, type HttpResult, type Session } from './session.js';
import type { Env } from './template.js';
import { round3, setPath } from './util.js';

export type ExpVerdict = 'reproduced' | 'not_reproduced' | 'inconclusive';

export interface RepRecord {
  rep: number;
  valid: boolean;
  setup_failure?: string;
  exception?: string;
  pairs: number;
  overlapped: number;
  /** The step results the counters read (variables included). */
  env: Env;
  /** Step ids in the capture, by experiment step. */
  steps: Record<string, string>;
}

export interface ArmOutcome {
  role: Arm['role'];
  description: string;
  reps_planned: number;
  counts: Record<string, number>;
  reps: RepRecord[];
}

export interface ExperimentOutcome {
  experiment: Experiment;
  arms: Record<string, ArmOutcome>;
  verdict: { criterion: string; verdict: ExpVerdict; reproduced_rule: boolean; not_reproduced_rule: boolean; overlapping_rules: boolean; values: Record<string, unknown> };
  simulated: { statement: string; arm: string | null; step: string | null; reps: number }[];
  stopped: string | null;
}

export interface ExecContext {
  session: Session;
  driver: Driver;
}

/** Apply a verdict to counts. */
export function decide(v: Experiment['verdict'], counts: Record<string, Record<string, number>>): ExperimentOutcome['verdict'] {
  const env = counts as Env;
  const r = evaluate(v.reproduced, env);
  const n = evaluate(v.not_reproduced, env);
  const verdict: ExpVerdict = r && !n ? 'reproduced' : n && !r ? 'not_reproduced' : 'inconclusive';
  return { criterion: v.criterion, verdict, reproduced_rule: r, not_reproduced_rule: n, overlapping_rules: r && n, values: { ...explain(v.reproduced, env), ...explain(v.not_reproduced, env) } };
}

function callEnv(r: CallResult) {
  return { indeterminate: r.timed_out || r.transport_error !== null || (!!r.result_type && r.result_type !== 'complete'), ok: r.ok, isError: r.isError, error: r.rpc_error, text: readText(r), data: r.data, tool: r.tool, shape: r.shape ?? null, ...(r.decoded ? { decoded: r.decoded, raw_structured: r.raw_structured } : {}), ...(r.extracted ? { extracted: r.extracted } : {}), ...(r.extract_failed ? { extract_failed: r.extract_failed } : {}), timed_out: r.timed_out, t_start_ms: r.t_start_ms, t_end_ms: r.t_end_ms };
}
function httpEnv(r: HttpResult) {
  return { indeterminate: r.status === null, ok: r.ok, status: r.status, body: r.body, t_start_ms: r.t_start_ms, t_end_ms: r.t_end_ms };
}
function halfEnv(h: HalfResult) {
  if ('exception' in h) return { ok: false, exception: h.exception };
  return h.kind === 'call' ? callEnv(h) : httpEnv(h);
}
function readEnv(r: ReadResult) {
  return { indeterminate: r.call ? r.call.timed_out || r.call.transport_error !== null : r.http ? r.http.status === null : false, ok: r.ok, obj: r.obj, version: r.version, settled: r.settled, reads: r.reads, status: r.http?.status ?? null };
}

async function runStep(x: ExecContext, arm: Arm, rep: number, step: Step, env: Env, labels: Set<string>): Promise<{ value: unknown; stepId: string; pairs?: { overlapped: boolean } }> {
  const s = x.session;
  const d = x.driver;
  const id = s.stepId(`${arm.name}.r${rep}.${step.id}`);
  const label = (l: string) => {
    const lb = arm.servers === 'per_arm' ? `${l}.${arm.name}` : `${l}.${arm.name}.r${rep}`;
    labels.add(lb);
    return lb;
  };
  switch (step.kind) {
    case 'read': {
      if (step.via === 'control') return { value: readEnv(await d.controlRead(id)), stepId: id };
      const lb = label(step.server ?? 'R');
      const settle = step.settle;
      const r = await d.readSettled(lb, id, settle ? (obj) => evaluate(settle, { ...env, [step.id]: { ok: true, obj } }) : undefined);
      return { value: readEnv(r), stepId: id };
    }
    case 'update': {
      const base = step.base ? (env[step.base] as { obj: unknown; version: unknown }) : null;
      const r = await d.update(label(step.server ?? 'W'), d.fields[step.field], getRef(step.value, env), { step: id, base });
      return { value: callEnv(r), stepId: id };
    }
    case 'control_patch':
      return { value: httpEnv(await d.controlPatch(d.fields[step.field], getRef(step.value, env), id)), stepId: id };
    case 'control_write': {
      const base = env[step.base] as { obj: unknown; version: unknown };
      const f = d.fields[step.field];
      return { value: httpEnv(await d.controlWrite(setPath(base.obj, f.path, getRef(step.value, env)), base.version, id)), stepId: id };
    }
    case 'pair': {
      const lbl = { a: label('A'), b: label('B'), same: label('S') };
      const p = await pair(s, d, step.a, step.b, env, { mode: step.mode, step: id, labels: lbl });
      const overlapped = (p.overlap_ms ?? 0) > 0;
      return { value: { a: halfEnv(p.a), b: halfEnv(p.b), overlap_ms: round3(p.overlap_ms), start_skew_ms: round3(p.start_skew_ms), overlapped, both_ok: halfOk(p.a) && halfOk(p.b), indeterminate: halfIndeterminate(p.a) || halfIndeterminate(p.b) }, stepId: id, pairs: { overlapped } };
    }
  }
}

const getRef = (name: string, env: Env): unknown => (/^[A-Z][A-Z0-9_]*$/.test(name) ? env[name] : name);

const isStop = (e: unknown) => e instanceof BudgetExhausted || e instanceof RateLimited || e instanceof Interrupted;

export async function runArm(x: ExecContext, arm: Arm, vars: Env, simulated: Map<string, ExperimentOutcome['simulated'][number]>): Promise<ArmOutcome> {
  const reps: RepRecord[] = [];
  const armLabels = new Set<string>();
  try {
    for (let rep = 0; rep < arm.reps; rep++) {
      const env: Env = { ...vars, REP: rep };
      const rec: RepRecord = { rep, valid: false, pairs: 0, overlapped: 0, env: {}, steps: {} };
      const labels = arm.servers === 'per_arm' ? armLabels : new Set<string>();
      try {
        if (arm.reset && !(await x.driver.reset())) rec.setup_failure = 'reset: the object could not be put back to the baseline';
        for (const step of rec.setup_failure ? [] : arm.steps) {
          const { value, stepId, pairs } = await runStep(x, arm, rep, step, env, labels);
          env[step.id] = value;
          rec.steps[step.id] = stepId;
          if (step.simulated) {
            const k = `${arm.name}/${step.id}`;
            const cur = simulated.get(k) ?? { statement: step.simulated, arm: arm.name, step: step.id, reps: 0 };
            cur.reps++;
            simulated.set(k, cur);
          }
          if (pairs) {
            rec.pairs++;
            if (pairs.overlapped) rec.overlapped++;
          }
          if ((value as { indeterminate?: boolean } | null)?.indeterminate) {
            rec.setup_failure = `${step.id}: outcome unknown to the client (timeout or broken connection); not counted`;
            break;
          }
          if (step.require && !evaluate(step.require, env)) {
            rec.setup_failure = `${step.id}: require failed`;
            break;
          }
        }
        if (!rec.setup_failure) rec.valid = true;
      } catch (e) {
        if (isStop(e)) throw e;
        rec.exception = (e as Error).message.slice(0, 300);
      } finally {
        if (arm.servers === 'per_rep') await x.session.release([...labels]);
      }
      rec.env = Object.fromEntries(Object.entries(env).filter(([k]) => !(k in vars) || k === 'REP'));
      reps.push(rec);
    }
  } finally {
    await x.session.release([...armLabels]);
  }
  return { role: arm.role, description: arm.description, reps_planned: arm.reps, counts: countArm(arm, reps, vars), reps };
}

/** Counters for one arm from its recorded repetitions (pure: used live and by `recheck`). */
export function countArm(arm: Arm, reps: RepRecord[], vars: Env): Record<string, number> {
  const counts: Record<string, number> = { reps: reps.length, valid: 0, setup_failures: 0, exceptions: 0, pairs: 0, overlapped: 0 };
  for (const c of Object.keys(arm.counters)) counts[c] = 0;
  for (const r of reps) {
    if (r.exception) counts['exceptions']!++;
    else if (!r.valid) counts['setup_failures']!++;
    if (!r.valid || r.exception) continue;
    counts['valid']!++;
    counts['pairs']! += r.pairs;
    if (r.pairs > 0 && r.overlapped === r.pairs) counts['overlapped']!++;
    const env = { ...vars, ...r.env };
    for (const [c, cond] of Object.entries(arm.counters)) if (evaluate(cond as Cond, env)) counts[c]!++;
  }
  return counts;
}

export async function runExperiment(x: ExecContext, exp: Experiment): Promise<ExperimentOutcome> {
  const simulated = new Map<string, ExperimentOutcome['simulated'][number]>();
  for (const st of exp.simulated) simulated.set(`*/${st}`, { statement: st, arm: null, step: null, reps: 0 });
  const arms: Record<string, ArmOutcome> = {};
  let stopped: string | null = null;
  for (const arm of exp.arms) {
    try {
      arms[arm.name] = await runArm(x, arm, exp.vars, simulated);
    } catch (e) {
      stopped = (e as Error).message;
      if (isStop(e)) break;
      break;
    }
  }
  return finish(exp, arms, [...simulated.values()], stopped);
}

/** Recount and re-decide an experiment from its recorded repetitions (offline). */
export function recount(exp: Experiment, recorded: Record<string, ArmOutcome>, simulated: ExperimentOutcome['simulated'], stopped: string | null): ExperimentOutcome {
  const arms: Record<string, ArmOutcome> = {};
  for (const arm of exp.arms) {
    const r = recorded[arm.name];
    if (r) arms[arm.name] = { ...r, counts: countArm(arm, r.reps, exp.vars) };
  }
  return finish(exp, arms, simulated, stopped);
}

function finish(exp: Experiment, arms: Record<string, ArmOutcome>, simulated: ExperimentOutcome['simulated'], stopped: string | null): ExperimentOutcome {
  const counts = Object.fromEntries(Object.entries(arms).map(([k, v]) => [k, v.counts]));
  const verdict = stopped ? { criterion: exp.verdict.criterion, verdict: 'inconclusive' as ExpVerdict, reproduced_rule: false, not_reproduced_rule: false, overlapping_rules: false, values: { stopped } } : decide(exp.verdict, counts);
  return { experiment: exp, arms, verdict, simulated, stopped };
}

/** Step ids of the first repetition where a counter held (the smallest failing trace). */
export function witness(out: ExperimentOutcome, arm: string, counter: string): string[] {
  const a = out.arms[arm];
  const def = out.experiment.arms.find((x) => x.name === arm);
  if (!a || !def) return [];
  const cond = def.counters[counter];
  if (!cond) return [];
  for (const r of a.reps) if (r.valid && evaluate(cond, { ...out.experiment.vars, ...r.env })) return Object.values(r.steps);
  return [];
}

/** The repetitions of an arm in which a counter's condition holds (for a closer look at their answers). */
export function repsWhere(out: ExperimentOutcome, arm: string, counter: string): { env: Record<string, unknown>; steps: Record<string, string> }[] {
  const a = out.arms[arm];
  const def = out.experiment.arms.find((x) => x.name === arm);
  if (!a || !def || !def.counters[counter]) return [];
  return a.reps.filter((r) => r.valid && evaluate(def.counters[counter]!, { ...out.experiment.vars, ...r.env })) as never;
}
