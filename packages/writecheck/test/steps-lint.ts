/**
 * Review R2 (lane F1): every violated record a fixture run produces keeps its trace steps, or is a listed exemption whose evidence
 * is not a call trace (validity.ts STEPS_EXEMPT). The shared harnesses call this on every run, so a producer that drops its steps,
 * or a rewrite that turns a record into violated without steps (targeting.ts withLoss), fails the test that exercises it.
 */

import assert from 'node:assert/strict';

import type { ResultsDoc } from '../src/report/results.js';
import { STEPS_EXEMPT } from '../src/report/validity.js';

export function assertViolationsHaveSteps(doc: Pick<ResultsDoc, 'results'>): void {
  const bad = doc.results
    .filter((r) => r.verdict === 'violated' && !r.steps.length && !STEPS_EXEMPT.some((e) => e.scenario === r.scenario.id && e.requirement === r.requirement))
    .map((r) => `${r.requirement} ${r.write_path.resource}:${r.write_path.tool} (${r.scenario.id}): ${r.reason.slice(0, 120)}`);
  assert.deepEqual(bad, [], 'violated records without trace steps (they would be harness-suspect: docs/CELLS.md, V-STEPS)');
}
