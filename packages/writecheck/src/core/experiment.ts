/**
 * Experiments: a check's calls as data, with test, control and validity arms, counters over each
 * repetition's step results, and a verdict rule stated before the run and applied mechanically.
 * The checks generate experiments from the manifest; the executor runs them; the result keeps every
 * repetition's step results, so `recheck` can recount and re-decide offline.
 *
 *   id: stale-ticket        hypothesis: "…"
 *   vars: { VA: …, VO: … }
 *   arms:
 *     - name: test          role: test | control | validity
 *       reps: 3             reset: true          servers: per_rep | per_arm
 *       steps:
 *         - { id: read,  kind: read, via: tool, server: R }
 *         - { id: other, kind: update, field: 1, value: VO, server: O }
 *         - { id: write, kind: update, field: 0, value: VA, base: read, server: W }
 *         - { id: final, kind: read, via: tool, settle: { all: ["final.obj.status == VA", …] } }
 *       counters: { stale_won: { all: [write.ok, "final.obj.assignee != VO"] } }
 *   verdict:
 *     criterion: "…"
 *     reproduced:     "test.stale_won >= 1"
 *     not_reproduced: { all: ["test.valid >= 1", "test.stale_won == 0"] }
 *
 * Verdict: reproduced if its rule holds and not_reproduced's does not; not_reproduced likewise;
 * otherwise inconclusive (neither, or both: overlapping rules are reported, never resolved by order).
 * Built-in counters per arm: reps, valid, setup_failures, exceptions, pairs, overlapped.
 *
 * A step whose outcome is unknown to the client (a timeout, a broken connection, an HTTP request
 * with no status) makes its repetition a setup failure: an indeterminate write is never counted as
 * a refusal, an error result or a success.
 *
 * A control is required: an arm with role control, or `control: none` with a reason (the run
 * records the reason; without a control the verdict cannot separate the server from its backend).
 */

import { condRefs, refParts, type Cond } from './conditions.js';
import { canonical, isObj, WritecheckError } from './util.js';

export const ROLES = ['test', 'control', 'validity'] as const;
export type Role = (typeof ROLES)[number];
export const BUILTIN_COUNTERS = ['reps', 'valid', 'setup_failures', 'exceptions', 'pairs', 'overlapped'] as const;

/** One half of a pair: an update through the tool, or a patch through the control. */
export type Half =
  | { kind: 'update'; field: 0 | 1; value: string; base?: string; server?: string }
  | { kind: 'control_patch'; field: 0 | 1; value: string }
  | { kind: 'control_write'; field: 0 | 1; value: string; base: string };

interface StepBase {
  id: string;
  /** A step that stands in for something real (a second client): stated in the result. */
  simulated?: string;
  /** If false after the step, the repetition is a setup failure and its counters are not taken. */
  require?: Cond;
}
export type Step =
  | (StepBase & { kind: 'read'; via: 'tool' | 'control'; server?: string; settle?: Cond })
  | (StepBase & { kind: 'update'; field: 0 | 1; value: string; base?: string; server?: string })
  | (StepBase & { kind: 'control_patch'; field: 0 | 1; value: string })
  | (StepBase & { kind: 'control_write'; field: 0 | 1; value: string; base: string })
  | (StepBase & { kind: 'pair'; mode: 'same' | 'separate'; a: Half; b: Half });

export interface Arm {
  name: string;
  role: Role;
  description: string;
  reps: number;
  /** Put the object's two fields back to the baseline before each repetition. */
  reset: boolean;
  servers: 'per_rep' | 'per_arm';
  steps: Step[];
  counters: Record<string, Cond>;
}

export interface Experiment {
  id: string;
  /** Scenario version: bumped when the generated calls or the rule change. */
  version: string;
  hypothesis: string;
  vars: Record<string, unknown>;
  simulated: string[];
  arms: Arm[];
  verdict: { criterion: string; reproduced: Cond; not_reproduced: Cond };
  control: { kind: 'arms'; arms: string[] } | { kind: 'none'; reason: string };
}

const ID = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const RESULT_FIELDS: Record<Step['kind'], string[]> = {
  read: ['ok', 'obj', 'version', 'settled', 'reads', 'status'],
  update: ['ok', 'isError', 'error', 'text', 'data', 'timed_out', 't_start_ms', 't_end_ms'],
  control_patch: ['ok', 'status', 'body', 't_start_ms', 't_end_ms'],
  control_write: ['ok', 'status', 'body', 't_start_ms', 't_end_ms'],
  pair: ['a', 'b', 'overlap_ms', 'start_skew_ms', 'overlapped', 'both_ok', 'indeterminate'],
};

const bad = (why: string) => new WritecheckError(`experiment: ${why}`);

/** Validate an experiment built by a check (the rules the toolkit applies to a pre-registered file). */
export function validateExperiment(e: Experiment): Experiment {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(e.id)) throw bad(`id ${e.id}`);
  if (!e.arms.length) throw bad('at least one arm');
  if (!e.arms.some((a) => a.role === 'test')) throw bad('needs an arm with role test');
  const names = new Set<string>();
  for (const a of e.arms) {
    if (!ID.test(a.name) || names.has(a.name)) throw bad(`arm name ${a.name}`);
    names.add(a.name);
    if (!Number.isInteger(a.reps) || a.reps < 1 || a.reps > 1000) throw bad(`${a.name}.reps: 1 to 1000`);
    const seen = new Set<string>();
    for (const s of a.steps) {
      if (!ID.test(s.id) || seen.has(s.id)) throw bad(`${a.name}: step id ${s.id}`);
      if (s.kind === 'update' && s.base && !seen.has(s.base)) throw bad(`${a.name}.${s.id}: base ${s.base} is not an earlier step`);
      if (s.kind === 'control_write' && !seen.has(s.base)) throw bad(`${a.name}.${s.id}: base ${s.base} is not an earlier step`);
      if (s.kind === 'pair') for (const h of [s.a, s.b]) if ((h.kind === 'update' || h.kind === 'control_write') && h.base && !seen.has(h.base)) throw bad(`${a.name}.${s.id}: base ${h.base} is not an earlier step`);
      for (const c of [s.require, s.kind === 'read' ? s.settle : undefined]) {
        if (c === undefined) continue;
        for (const r of condRefs(c, `${a.name}.${s.id}`)) {
          const root = refParts(r).root;
          if (root !== s.id && !seen.has(root) && !/^[A-Z][A-Z0-9_]*$/.test(root)) throw bad(`${a.name}.${s.id} refers to ${root}, not an earlier step or a VARIABLE`);
        }
      }
      seen.add(s.id);
    }
    for (const [c, cond] of Object.entries(a.counters)) {
      if (!ID.test(c) || (BUILTIN_COUNTERS as readonly string[]).includes(c)) throw bad(`${a.name}.counters.${c}: a counter name`);
      for (const r of condRefs(cond, `${a.name}.counters.${c}`)) {
        const { root, path } = refParts(r);
        if (/^[A-Z][A-Z0-9_]*$/.test(root)) continue;
        const step = a.steps.find((s) => s.id === root);
        if (!step) throw bad(`${a.name}.counters.${c} refers to ${root}, which is not a step of the arm`);
        const f = path[0];
        if (typeof f === 'string' && !RESULT_FIELDS[step.kind].includes(f)) throw bad(`${a.name}.counters.${c}: ${r}: a ${step.kind} result has ${RESULT_FIELDS[step.kind].join(', ')}`);
      }
    }
  }
  const controls = e.arms.filter((a) => a.role === 'control').map((a) => a.name);
  if (e.control.kind === 'none') {
    if (controls.length) throw bad('control: none, but there is a control arm');
    if (e.control.reason.trim().length < 20) throw bad('control: none needs a reason of at least 20 characters');
  } else if (!controls.length || canonical(controls) !== canonical(e.control.arms)) throw bad('control arms do not match the arms with role control');
  const used = new Set<string>();
  for (const k of ['reproduced', 'not_reproduced'] as const) {
    for (const r of condRefs(e.verdict[k], `verdict.${k}`)) {
      const [arm, counter, ...rest] = r.split('.');
      const a = e.arms.find((x) => x.name === arm);
      if (!a || !counter || rest.length) throw bad(`verdict.${k}: ${r} must be <arm>.<counter>`);
      if (!(BUILTIN_COUNTERS as readonly string[]).includes(counter) && !(counter in a.counters)) throw bad(`verdict.${k}: arm ${arm} has no counter ${counter}`);
      used.add(arm!);
    }
  }
  if (canonical(e.verdict.reproduced) === canonical(e.verdict.not_reproduced)) throw bad('reproduced and not_reproduced are the same rule');
  for (const a of e.arms) if ((a.role === 'test' || a.role === 'control') && !used.has(a.name)) throw bad(`the verdict does not reference arm ${a.name} (role ${a.role}): every test and control arm belongs inside the verdict`);
  if (!isObj(e.vars)) throw bad('vars: an object');
  return e;
}
