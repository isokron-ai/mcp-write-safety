/**
 * F6: evidence validity on every `violated` record (docs/CELLS.md, "Validity"). A rating counts one evidence-valid violation,
 * so whether a record's evidence holds up must be decided by a written rule from the record itself, not by a person.
 *
 * Rules (each one a record must meet; a failed rule makes the record `harness-suspect`, which does not count until a re-run
 * reproduces it):
 * - V-STEPS: the record keeps the step ids of its trace (at least one), so the capture shows what happened.
 * - V-RUN: the run was not cut short by the write budget, a rate limit (429) or an interrupt (cutShort below). A run that
 *   stopped for another reason (clean-up not finished, a fixture not put back, bystanders lost, a server that died) keeps its
 *   violations: those stops say nothing against evidence already recorded, and they are safety facts of their own.
 * - V-ACK: every write the violation rests on was acknowledged as a success (a check that knows says so in `evidence`;
 *   barrier pairs show it in their numbers: a lost pair is counted only when both calls succeeded).
 * - V-READBACK: the final state was read back (a check that knows says so in `evidence`).
 *
 * Class `platform`: a record that meets every rule and whose attribution is `unresolved` (spec 8.2 rule 3: no control arm
 * decided whether the backend does the same). It counts: an undisclosed loss is the caller's loss either way, and leaving the
 * control block out of a declaration must not turn a violation into no finding. It is printed apart, as "attribution unresolved".
 *
 * `synthetic_fault`: the violation was provoked with a status the gate injected (a 500 the real backend may never send). It is
 * printed; it does not disqualify the record, since what is tested is how the server reports a backend refusal. A connection
 * cut after the backend applied the write (`*.unknown-outcome`) is not synthetic: a lost answer is a real-world event.
 *
 * Exempt from V-STEPS (STEPS_EXEMPT): records whose evidence is a fact of the catalog, the launch observation or the ledger, not
 * a call trace. Each exemption names its basis, which the record's validity carries.
 */

import type { Evidence, Result, Validity } from './verdicts.js';

export const VALIDITY_RULES = {
  'V-STEPS': 'the record keeps the step ids of its trace',
  'V-RUN': 'the run was not cut short by the write budget, a rate limit or an interrupt',
  'V-ACK': 'every write the violation rests on was acknowledged as a success',
  'V-READBACK': 'the final state was read back after the writes',
} as const;
export type ValidityRule = keyof typeof VALIDITY_RULES;

/**
 * Scenarios whose violated records rest on a status the gate injected: gated.ts (the failed request and the composite trials), and
 * F4's `write-faults` and `multi-item.res2`. Connection-cut scenarios (`*.unknown-outcome`) are not listed: a lost answer is real.
 */
export const SYNTHETIC_SCENARIO = /^(held-request|write-faults|multi-item\.res2)$/;
const SYNTHETIC_REQUIREMENTS = ['MWS-RES-2', 'MWS-ATOM-1'];

/** V-STEPS exemptions: (scenario, requirement) whose evidence is not a call trace, with the basis the record carries. */
export const STEPS_EXEMPT: { scenario: string; requirement: string; basis: string }[] = [
  { scenario: 'catalog', requirement: 'MWS-ANN-4', basis: 'the tool\'s annotations in tools/list (catalog.json)' },
  { scenario: 'catalog-only', requirement: 'MWS-ANN-4', basis: 'the tool\'s annotations in tools/list (catalog.json)' },
  { scenario: 'launch-settings', requirement: 'MWS-CFG-4', basis: 'the launch observation: the server started and answered tools/list with the allow-list set' },
  { scenario: 'annotation-effects', requirement: 'MWS-ANN-1', basis: 'the ledger: objects created through a tool that declares readOnlyHint: true' },
];
const exemptOf = (r: Result) => STEPS_EXEMPT.find((x) => x.scenario === r.scenario.id && x.requirement === r.requirement) ?? null;

/** The part of a run's stop reason that cut it short (write budget, rate limit, interrupt), or null: only that stop fails V-RUN. */
export function cutShortOf(stopped: string | null): string | null {
  if (!stopped) return null;
  const hit = stopped.split(/;\s*/).find((x) => /would exceed the write budget|\(rate limited\)|\b429\b|^interrupted by\b/.test(x));
  return hit ?? null;
}

export function validityOf(r: Result, run: { stopped: string | null }): Validity {
  const given: Evidence = r.validity?.evidence ?? {};
  const failed: ValidityRule[] = [];
  const exempt = exemptOf(r);
  if (!r.steps.length && !exempt) failed.push('V-STEPS');
  if (cutShortOf(run.stopped)) failed.push('V-RUN');
  let ack = given.acknowledged ?? null;
  if (ack === null && r.scenario.id === 'barrier-pairs') {
    const both = Number(r.numbers['both_ok'] ?? NaN);
    const lost = Number(r.numbers['lost'] ?? NaN);
    if (Number.isFinite(both) && Number.isFinite(lost)) ack = lost >= 1 && both >= lost;
  }
  if (ack === false) failed.push('V-ACK');
  if (given.read_back === false) failed.push('V-READBACK');
  const synthetic = given.synthetic_fault === true || (SYNTHETIC_SCENARIO.test(r.scenario.id) && SYNTHETIC_REQUIREMENTS.includes(r.requirement));
  const cls: Validity['class'] = failed.length ? 'harness-suspect' : r.attribution === 'unresolved' ? 'platform' : 'valid';
  return { class: cls, counts: cls !== 'harness-suspect', failed, synthetic_fault: synthetic, evidence: { acknowledged: ack, read_back: given.read_back ?? null, synthetic_fault: given.synthetic_fault ?? (synthetic || null), ...(exempt && !r.steps.length ? { basis: exempt.basis } : {}) } };
}

/** Stamp validity on every violated record (and take it off any other: a record adjusted away from violated keeps none). */
export function withValidity(results: Result[], run: { stopped: string | null }): Result[] {
  return results.map((r) => {
    if (r.verdict === 'violated') return { ...r, validity: validityOf(r, run) };
    if (r.validity) {
      const { validity: _v, ...rest } = r;
      return rest;
    }
    return r;
  });
}
