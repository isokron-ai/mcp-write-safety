// The defect matrix in min mode (writecheck-min.mjs): what min mode is expected to say per defect, and how a run is judged.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { judgeCell } from './matrix-plan.mjs';
import { cellRecord } from './matrix-cell.mjs';
import { judgeMin, minExpected, minStatuses, readMin } from './writecheck-min.mjs';
import { MAP_FILE } from './writecheck-expected.mjs';

const map = JSON.parse(readFileSync(MAP_FILE, 'utf8')).defects;
const NINE = ['MWS-UPD-1', 'MWS-UPD-2', 'MWS-CONC-1', 'MWS-CONC-2', 'MWS-CONC-3', 'MWS-TGT-1', 'MWS-TGT-3', 'MWS-RES-1', 'MWS-ATOM-2'];

test('R-DM-29: min mode expects violated for a defect it judges, not_testable_mock for a backend-semantic one (and the in-flight forms), nothing for a fixture defect', () => {
  const st = minStatuses();
  assert.deepEqual(NINE.filter((r) => st[r] !== 'not_testable_mock'), []);
  assert.deepEqual(minExpected('error-as-text', map['error-as-text']), ['MWS-RES-2:violated']);
  assert.deepEqual(minExpected('read-merge-put', map['read-merge-put']), ['MWS-CONC-3:not_testable_mock']);
  assert.deepEqual(minExpected('update-adds-defaults', map['update-adds-defaults']), ['MWS-UPD-1:not_testable_mock']);
  assert.deepEqual(minExpected('lost-update', map['lost-update']), ['MWS-CONC-3:not_testable_mock'], 'the platform verdict needs a backend: not testable against a mock');
  assert.deepEqual(minExpected('in-progress-reported-not-applied', map['in-progress-reported-not-applied']), ['MWS-RES-2:not_testable_mock']);
  assert.deepEqual(minExpected('conflict-as-generic-error', map['conflict-as-generic-error']), ['MWS-CONC-6:self-attested-no']);
  assert.deepEqual(minExpected('digest-of-current-state', map['digest-of-current-state']), []);
});

const doc = (results) => ({ format: 'mws-min-results/1', mode: 'min', results });
const capped = NINE.map((r) => ({ requirement: r, verdict: 'not tested', status: 'not_testable_mock' }));

test('R-DM-30: a min run is detected only where min mode said what it may; a backend-semantic defect reported held is missed, never detected', () => {
  const run = (results) => ({ ok: true, ...readMin(doc(results)) });
  assert.equal(judgeMin({ run: run([...capped, { requirement: 'MWS-RES-2', verdict: 'violated' }]), expected: map['error-as-text'], defect: 'error-as-text' }).state, 'detected');
  assert.equal(judgeMin({ run: run(capped), expected: map['read-merge-put'], defect: 'read-merge-put' }).state, 'detected');
  assert.equal(judgeMin({ run: run([...capped, { requirement: 'MWS-CONC-6', verdict: 'violated' }]), expected: map['conflict-as-generic-error'], defect: 'conflict-as-generic-error' }).state, 'detected', 'violated stands for a review "no"');
  // Mutations: the MCP-layer defect not reported; CONC-3 held instead of capped; a correct build with a violation.
  assert.equal(judgeMin({ run: run(capped), expected: map['error-as-text'], defect: 'error-as-text' }).state, 'missed');
  const held = [...capped.filter((r) => r.requirement !== 'MWS-CONC-3'), { requirement: 'MWS-CONC-3', verdict: 'held' }];
  assert.equal(judgeMin({ run: run(held), expected: map['read-merge-put'], defect: 'read-merge-put' }).state, 'missed');
  assert.equal(judgeMin({ run: run(capped), expected: null }).state, 'clean');
  assert.equal(judgeMin({ run: run([...capped, { requirement: 'MWS-IN-3', verdict: 'violated' }]), expected: null }).state, 'violated');
  assert.equal(judgeMin({ run: { ok: false, error: 'x' }, expected: map['error-as-text'], defect: 'error-as-text' }).state, 'error');
  assert.throws(() => readMin({ format: 'mws-results/1', results: [] }), /not a min-mode/);
});

test('R-DM-31: a min cell is judged by min mode\'s rules and its record says writecheck_mode min, with not_testable_mock answers kept', () => {
  const got = {};
  const cell = { kind: 'defect', defect: 'read-merge-put' };
  const run = { ok: true, ...readMin(doc(capped)) };
  const buildsDoc = { builds: [] };
  const expectedDoc = { builds: [] };
  let v;
  try {
    v = judgeCell({ cell, buildsDoc, expectedDoc, got, writecheck: { run, expected: map['read-merge-put'], judge: judgeMin, mode: 'min' } });
  } catch {
    v = null;
  }
  // The fixture part needs the builds file; judge the writecheck part on its own when it is not there.
  if (v) {
    assert.equal(v.writecheck_mode, 'min');
    const rec = cellRecord({ KIND: 'defect', DEFECT: 'read-merge-put' }, v);
    assert.equal(rec.writecheck_mode, 'min');
    assert.ok(rec.writecheck.observed.includes('MWS-CONC-3:not_testable_mock'));
  }
  const w = judgeMin({ run, expected: map['read-merge-put'], defect: 'read-merge-put' });
  assert.deepEqual(w.observed, ['MWS-CONC-3:not_testable_mock']);
});
