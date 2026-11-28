// The simulator's own checks: cells worked out by hand from the rules in model.mjs, and the seeded population reproduced.
// Run by same-key-sim.yml (node --test scripts/sim/same-key-inflight/*.test.mjs).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify, grid, measure, population, simulateCell, VARIANTS, POLICY_NAMES } from './model.mjs';

const pick = (m) => ({ report: m.report, objects: m.objects, extra: m.extra, duplicate: m.duplicate, lost: m.lost, wrong: m.wrong, unresolved: m.unresolved });
const row = (report, objects, extra, flags = {}) => ({ report, objects, extra, duplicate: false, lost: false, wrong: false, unresolved: false, ...flags });

test('hand-worked cells', async () => {
  const cases = [
    // A: the retry says not_applied while W1 is in flight; P1 creates with a new key at 500, W1 lands at 1800.
    [['A', 'P1', 'lands', 1800], row('saved', 2, 2, { duplicate: true, wrong: true })],
    // B: unknown at 500 and 1500, the replay at 2500.
    [['B', 'P1', 'lands', 1800], row('saved', 1, 3)],
    // B and P3: any non-success is "not saved", and W1 lands at 800.
    [['B', 'P3', 'lands', 800], row('not_saved', 1, 1, { lost: true, wrong: true })],
    // D blocks the retry until 1800, past the client's 500 ms timeout; P5 re-issues with a new key at 1000.
    [['D', 'P5', 'lands', 1800], row('saved', 2, 2, { duplicate: true, wrong: true })],
    // D answers the retry at 800, inside the timeout: the replay.
    [['D', 'P2', 'lands', 800], row('saved', 1, 1)],
    // E: not_applied, read strictly, stops; W1 lands at 3000.
    [['E', 'P4', 'lands', 3000], row('not_saved', 1, 1, { lost: true, wrong: true })],
    // B and P4, W1 still in flight after three polls (1500, 2500, 3500): the read back at 3500 finds nothing.
    [['B', 'P4', 'lands', 8000], row('unknown', 1, 5, { unresolved: true })],
    // The first write fails: A's not_applied is then true of the keyed write too.
    [['A', 'P4', 'fails', 800], row('not_saved', 0, 1)],
    // C has no outcome: P1 retries the same key; at 2500 the key is closed (not_applied) and P1 creates with a new key.
    [['C', 'P1', 'fails', 1800], row('saved', 1, 4)],
  ];
  for (const [args, want] of cases) assert.deepEqual(pick(await simulateCell(...args)), want, args.join(' '));
});

test('B (strict B-9) gives no duplicate and no lost write to P1 to P4 on the grid', async () => {
  for (const m of (await grid()).filter((x) => x.variant === 'B' && x.policy !== 'P5')) {
    assert.equal(m.duplicate, false, `${m.policy} ${m.outcome} ${m.d}`);
    assert.equal(m.lost, false, `${m.policy} ${m.outcome} ${m.d}`);
  }
});

test('the grid covers every cell once, and the population is reproduced from its seed', async () => {
  const g = await grid();
  assert.equal(g.length, VARIANTS.length * POLICY_NAMES.length * 2 * 4);
  const a = await population({ runs: 300 });
  const b = await population({ runs: 300 });
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.rows, (await population({ runs: 300, seed: 7 })).rows);
});

test('classify and measure', () => {
  assert.equal(classify({ content: [] }).cls, 'success');
  assert.equal(classify({ isError: true, structuredContent: { mws: { outcome: 'not_applied', code: 'conflict' } } }).cls, 'not_applied');
  assert.equal(classify({ isError: true, structuredContent: { mws: { outcome: 'unknown', code: 'in_progress' } } }).cls, 'unknown');
  assert.equal(classify({ isError: true, content: [{ type: 'text', text: '409' }] }).cls, 'no_claim');
  assert.equal(classify(null).cls, 'no_claim');
  assert.deepEqual(pick(measure('unknown', 1, 3)), row('unknown', 1, 2, { unresolved: true }));
  assert.deepEqual(pick(measure('saved', 0, 1)), row('saved', 0, 0, { lost: true, wrong: true }));
});
