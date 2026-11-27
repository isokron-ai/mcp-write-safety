// R-DM-*: the result bundle of the defect-matrix T0 worker (t0-defects lane of tool-qa).
// Runs in ci.yml's spec job (node --test scripts/ci/*.test.mjs).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { build, judge, SUBJECT_ID } from './t0-bundle.mjs';
import { cellRecord } from './t0-cell.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const yaml = readFileSync(join(root, '.github', 'workflows', 'defect-matrix.yml'), 'utf8');
const builds = JSON.parse(readFileSync(join(root, 'examples', 'tiny-tracker', 'expected', 'builds-0.3.0.json'), 'utf8')).builds.map((b) => b.label);

const EXPECTED = [
  { kind: 'known-bad', label: 'backend defect digest-of-current-state' },
  { kind: 'known-good', label: 'correct build' },
  { kind: 'defect', defect: 'lookup-reexecutes' },
  { kind: 'defect', defect: 'key-expires-early' },
];
const ok = (c) => ({ ...c, outcome: 'success' });
const control = (b, kind) => b.meta.controls.find((c) => c.kind === kind);

test('R-DM-01: every cell matched: known_good match and known_bad all_caught, nothing missed', () => {
  const b = build({ expected: EXPECTED, found: EXPECTED.map(ok), env: { GITHUB_SHA: 'a'.repeat(40), GITHUB_REPOSITORY: 'isokron-ai/mcp-write-safety' } });
  assert.deepEqual(b.meta.controls, [{ kind: 'known_good', expected: 'match', observed: 'match' }, { kind: 'known_bad', expected: 'all_caught', observed: 'all_caught' }]);
  assert.deepEqual(b.matrix.missed, []);
  assert.equal(b.meta.subject.id, SUBJECT_ID);
  assert.equal(b.meta.subject.sha, 'a'.repeat(40));
});

test('R-DM-02: a seeded defect whose row no longer matches is a miss: known_bad is "missed" and the report names it', () => {
  const found = EXPECTED.map((c) => (c.defect === 'key-expires-early' ? { ...c, outcome: 'failure' } : ok(c)));
  const b = build({ expected: EXPECTED, found });
  assert.equal(control(b, 'known_bad').observed, 'missed');
  assert.notEqual(control(b, 'known_bad').observed, control(b, 'known_bad').expected, 'ingest rejects this as control_failed');
  assert.equal(control(b, 'known_good').observed, 'match', 'the correct build is not blamed');
  assert.deepEqual(b.matrix.missed, ['key-expires-early']);
});

test('R-DM-03: a correct build that no longer matches its row fails known_good', () => {
  const found = EXPECTED.map((c) => (c.kind === 'known-good' ? { ...c, outcome: 'failure' } : ok(c)));
  const b = build({ expected: EXPECTED, found });
  assert.equal(control(b, 'known_good').observed, 'differs');
  assert.equal(control(b, 'known_bad').observed, 'all_caught');
});

test('R-DM-04: a cell that left no result is incomplete, never counted as caught', () => {
  const found = EXPECTED.filter((c) => c.defect !== 'lookup-reexecutes').map(ok);
  const b = build({ expected: EXPECTED, found });
  assert.equal(control(b, 'known_bad').observed, 'incomplete');
  assert.deepEqual(b.matrix.missed, ['lookup-reexecutes']);
  assert.equal(judge(EXPECTED, [{ kind: 'defect', defect: 'lookup-reexecutes', outcome: 'cancelled' }]).find((c) => c.defect === 'lookup-reexecutes').outcome, 'incomplete', 'a cancelled cell is incomplete');
  assert.equal(judge(EXPECTED, [{ kind: 'defect', defect: 'lookup-reexecutes', outcome: 'success', extra: 1 }]).find((c) => c.defect === 'lookup-reexecutes').outcome, 'success');
});

test('R-DM-05: an explicit defect list has no known_good control, and the bundle always carries at least one control', () => {
  const only = [{ kind: 'defect', defect: 'lookup-reexecutes' }];
  const b = build({ expected: only, found: only.map(ok) });
  assert.deepEqual(b.meta.controls.map((c) => c.kind), ['known_bad']);
});

test('R-DM-06: the meta file has the shape worker-kit takes (labels are lower case words, sha 40 hex or null)', () => {
  const b = build({ expected: EXPECTED, found: EXPECTED.map(ok), env: { GITHUB_SHA: 'zz' } });
  assert.equal(b.meta.subject.sha, null, 'an unusable sha is null, not passed on');
  for (const c of b.meta.controls) assert.match(`${c.expected}${c.observed}`, /^[a-z_]+$/);
  assert.deepEqual(Object.keys(b.meta).sort(), ['controls', 'finished_at', 'oracles', 'settings_manifest_digest', 'skips', 'started_at', 'subject', 'tools']);
});

test('R-DM-07: the cell record carries only a known kind and outcome', () => {
  assert.deepEqual(cellRecord({ KIND: 'defect', DEFECT: 'x-y', OUTCOME: 'failure' }), { kind: 'defect', outcome: 'failure', defect: 'x-y' });
  assert.deepEqual(cellRecord({ KIND: 'known-good', LABEL: 'correct build', OUTCOME: 'success' }), { kind: 'known-good', outcome: 'success', label: 'correct build' });
  assert.equal(cellRecord({ KIND: 'defect', DEFECT: 'x', OUTCOME: 'weird' }).outcome, 'unknown');
  assert.throws(() => cellRecord({ KIND: 'other' }), /not known-good/);
});

/** The guard step's script, run with IN_DEFECTS; returns the cells it chose. */
function guardCells(defects) {
  const lines = yaml.split('\n');
  const at = lines.findIndex((l) => l.trim() === 'name: Kill switch, then validate the inputs');
  let i = lines.findIndex((l, n) => n > at && /^\s*run: \|\s*$/.test(l));
  const runIndent = lines[i].search(/\S/);
  const body = [];
  for (i++; i < lines.length && (lines[i].trim() === '' || lines[i].search(/\S/) > runIndent); i++) body.push(lines[i]);
  const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.search(/\S/)));
  const script = body.map((l) => l.slice(indent)).join('\n');
  const tmp = mkdtempSync(join(tmpdir(), 'dm-'));
  try {
    const out = join(tmp, 'out');
    writeFileSync(out, '');
    const r = spawnSync('bash', ['-e', '-c', script], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, GITHUB_OUTPUT: out, LOOP_ENABLED: 'true', IN_SHARD_ID: 's', IN_ATTEMPT_ID: 'a', IN_FENCE: '1', IN_RUN_KEY: 'k', IN_DEFECTS: defects } });
    const text = readFileSync(out, 'utf8');
    return { status: r.status, cells: /^cells=(.*)$/m.test(text) ? JSON.parse(/^cells=(.*)$/m.exec(text)[1]) : null };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

test('R-DM-08: defects=all runs every build of the committed list: each defect build once, each correct build against its row, plus the known-bad control', () => {
  const r = guardCells('all');
  assert.equal(r.status, 0);
  const defects = builds.filter((l) => /(^|\s)defect [a-z0-9-]+$/.test(l)).map((l) => /defect ([a-z0-9-]+)$/.exec(l)[1]);
  const goods = builds.filter((l) => !/(^|\s)defect [a-z0-9-]+$/.test(l));
  assert.ok(defects.length >= 10 && goods.length >= 2, 'the committed list has defects and correct builds');
  assert.deepEqual(r.cells.filter((c) => c.kind === 'defect').map((c) => c.defect), defects);
  assert.deepEqual(r.cells.filter((c) => c.kind === 'known-good').map((c) => c.label), goods);
  assert.equal(r.cells.filter((c) => c.kind === 'known-bad').length, 1);
  assert.equal(r.cells.length, builds.length + 1);
});

test('R-DM-08: "all" is an exact word: all with a newline is refused, and an empty list is still the control set', () => {
  assert.equal(guardCells('all\nx').status, 1);
  assert.deepEqual(guardCells('all,x').cells, [{ kind: 'defect', defect: 'all' }, { kind: 'defect', defect: 'x' }], 'all among other names is just a name');
  assert.equal(guardCells('').cells.length, 2);
});
