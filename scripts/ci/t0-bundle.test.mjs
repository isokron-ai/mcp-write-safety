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
import { cellRecord } from './matrix-cell.mjs';
import { allCells, cellsFor, documentedGaps, judgeCell, labelsFor, plan } from './matrix-plan.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const yaml = readFileSync(join(root, '.github', 'workflows', 'defect-matrix.yml'), 'utf8');

const EXPECTED = [
  { kind: 'known-bad', label: 'backend defect digest-of-current-state' },
  { kind: 'known-good', label: 'correct build' },
  { kind: 'defect', defect: 'lookup-reexecutes' },
  { kind: 'defect', defect: 'key-expires-early' },
];
const ok = (c) => ({ ...c, outcome: 'success' });
const control = (b, kind) => b.meta.controls.find((c) => c.kind === kind);

test('R-DM-01: every cell matched: known_good match and known_bad detected_or_documented, nothing missed', () => {
  const b = build({ expected: EXPECTED, found: EXPECTED.map(ok), env: { GITHUB_SHA: 'a'.repeat(40), GITHUB_REPOSITORY: 'isokron-ai/mcp-write-safety' } });
  assert.deepEqual(b.meta.controls, [{ kind: 'known_good', expected: 'match', observed: 'match' }, { kind: 'known_bad', expected: 'detected_or_documented', observed: 'detected_or_documented' }]);
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
  assert.equal(control(b, 'known_bad').observed, 'detected_or_documented');
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

const BUILDS = JSON.parse(readFileSync(join(root, 'examples', 'tiny-tracker', 'expected', 'builds-0.4.0.json'), 'utf8'));
const COMMITTED = JSON.parse(readFileSync(join(root, 'examples', 'tiny-tracker', 'expected', '0.4.0.json'), 'utf8'));
const rows = Object.fromEntries(COMMITTED.builds.map((r) => [r.label, r]));
/** What running the builds now would give if they reproduce their committed rows. */
const asCommitted = (labels) => Object.fromEntries(labels.map((l) => [l, { build_hash: rows[l].build_hash, fixture: rows[l].fixture }]));
const judgeIt = (cell, over = {}) => { const got = { ...asCommitted(labelsFor(cell, BUILDS)), ...over }; return judgeCell({ cell, buildsDoc: BUILDS, expectedDoc: COMMITTED, got }); };

test('R-DM-07: the cell record carries only a known kind, the outcome and the judging facts', () => {
  assert.deepEqual(cellRecord({ KIND: 'defect', DEFECT: 'x-y' }, { ok: false, reason: 'neutered', mode: 'single', detected: false, documented: false, builds: 3 }), { kind: 'defect', outcome: 'failure', defect: 'x-y', reason: 'neutered', mode: 'single', detected: false, documented: false });
  assert.deepEqual(cellRecord({ KIND: 'known-good', LABEL: 'L2 correct build' }, { ok: true, builds: 1 }), { kind: 'known-good', outcome: 'success', label: 'L2 correct build' });
  assert.throws(() => cellRecord({ KIND: 'other' }, { ok: true }), /not known-good/);
});

test('R-DM-08: the matrix is read from the 0.4.0 list (tiny-tracker 0.4.0): every correct build, every distinct defect, once', () => {
  const cells = allCells(BUILDS);
  const { correct, defects } = plan(BUILDS);
  assert.equal(correct.length, 4, 'one correct build per level');
  assert.ok(defects.size >= 50, `${defects.size} defects`);
  assert.ok(BUILDS.builds.length >= 500, `${BUILDS.builds.length} builds in the list, not the 13 of 0.3.0`);
  assert.equal(cells.length, correct.length + defects.size);
  assert.equal(new Set(cells.map((c) => c.defect ?? c.label)).size, cells.length);
  assert.deepEqual(cellsFor('', BUILDS).map((c) => c.defect ?? c.label), ['L2 correct build', 'digest-of-current-state']);
  assert.deepEqual(cellsFor('a-b,a-b,c', BUILDS), [{ kind: 'defect', defect: 'a-b' }, { kind: 'defect', defect: 'c' }]);
  for (const c of cells.filter((x) => x.kind === 'defect')) assert.ok(labelsFor(c, BUILDS).length >= 1, c.defect);
});

test('R-DM-09: a defect is judged on its single-defect builds; one with none is combo_only and only has to reproduce', () => {
  const { defects } = plan(BUILDS);
  const single = [...defects].find(([, o]) => o.single.length)[0];
  assert.ok(labelsFor({ kind: 'defect', defect: single }, BUILDS).every((l) => plan(BUILDS).defects.get(single).single.some((b) => b.label === l)));
  const combo = [...defects].find(([, o]) => !o.single.length)[0];
  const r = judgeIt({ kind: 'defect', defect: combo });
  assert.equal(r.mode, 'combo_only');
  assert.equal(r.ok, true);
  assert.equal(r.detected, false, 'never reported as detected');
});

test('R-DM-10: a defect whose answers equal the correct build\'s is NEUTERED and fails its cell, unless the known-answer file documents it as not detected', () => {
  const { defects, correct } = plan(BUILDS);
  // pick a defect that is detected in the committed rows and make its single builds answer like the correct build
  const goodOf = (b) => rows[correct.find((x) => x.factors.level === b.factors.level).label];
  const detectedDefect = [...defects].find(([d, o]) => o.single.length && !documentedGaps(COMMITTED).has(d) && o.single.some((b) => JSON.stringify(rows[b.label].fixture) !== JSON.stringify(goodOf(b).fixture)))[0];
  const cell = { kind: 'defect', defect: detectedDefect };
  const ok = judgeIt(cell);
  assert.equal(ok.ok, true);
  assert.equal(ok.detected, true);
  const o = defects.get(detectedDefect);
  // a defect that was neutered: its builds now answer exactly like the correct build (and the committed contract rows are the correct build's)
  const neutered = Object.fromEntries(o.single.map((b) => [b.label, { build_hash: rows[b.label].build_hash, fixture: goodOf(b).fixture }]));
  const saved = new Map(o.single.map((b) => [b.label, { f: rows[b.label].fixture, c: rows[b.label].contract }]));
  try {
    for (const b of o.single) { rows[b.label].fixture = goodOf(b).fixture; rows[b.label].contract = goodOf(b).contract; }
    const r = judgeCell({ cell, buildsDoc: BUILDS, expectedDoc: COMMITTED, got: neutered });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'neutered');
  } finally {
    for (const [l, v] of saved) { rows[l].fixture = v.f; rows[l].contract = v.c; }
  }
  const gaps = [...documentedGaps(COMMITTED)];
  assert.ok(gaps.length >= 30, `${gaps.length} documented gaps`);
  assert.ok(gaps.includes('update-adds-defaults'));
});

test('R-DM-11: a defect build that no longer reproduces its committed row, or did not run, fails its cell', () => {
  const { defects } = plan(BUILDS);
  const [d, o] = [...defects].find(([, x]) => x.single.length);
  const cell = { kind: 'defect', defect: d };
  const l = o.single[0].label;
  assert.equal(judgeIt(cell, { [l]: { build_hash: 'f'.repeat(64), fixture: rows[l].fixture } }).reason, 'not_reproduced');
  assert.equal(judgeIt(cell, { [l]: { build_hash: rows[l].build_hash, fixture: { 'FX-X-1': ['held'] } } }).reason, 'not_reproduced');
  const got = asCommitted(labelsFor(cell, BUILDS)); delete got[l];
  assert.equal(judgeCell({ cell, buildsDoc: BUILDS, expectedDoc: COMMITTED, got }).reason, 'not_run');
  const good = { kind: 'known-good', label: 'L2 correct build' };
  assert.equal(judgeIt(good).ok, true);
  assert.equal(judgeIt(good, { 'L2 correct build': { build_hash: rows['L2 correct build'].build_hash, fixture: {} } }).ok, false);
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

test('R-DM-12: the guard step gives defects=all the 0.4.0 cells; "all" is an exact word, and an empty list is the control set', () => {
  const r = guardCells('all');
  assert.equal(r.status, 0);
  assert.deepEqual(r.cells, allCells(BUILDS));
  assert.equal(guardCells('all\nx').status, 1);
  assert.deepEqual(guardCells('all,x').cells, [{ kind: 'defect', defect: 'all' }, { kind: 'defect', defect: 'x' }]);
  assert.equal(guardCells('').cells.length, 2);
  assert.doesNotMatch(yaml, /builds-0\.3\.0|0\.3\.0\.json/, 'the workflow no longer reads the 0.3.0 files');
  assert.doesNotMatch(yaml, /t0-<attempt_id>/, 'no stale wording about the old manifest stub');
});

test('R-DM-13: a difference only in the committed contract rows is reported as committed_contract, not as detected, and only when BOTH rows have a contract (a row with none is never "detected by absence")', () => {
  const { defects, correct } = plan(BUILDS);
  const goodOf = (b) => rows[correct.find((x) => x.factors.level === b.factors.level).label];
  const [d, o] = [...defects].find(([n, x]) => x.single.length && !documentedGaps(COMMITTED).has(n));
  const saved = o.single.map((b) => [b.label, rows[b.label].fixture, rows[b.label].contract, goodOf(b).contract]);
  const run = (contractOf) => {
    const got = {};
    for (const b of o.single) { rows[b.label].fixture = goodOf(b).fixture; rows[b.label].contract = contractOf(b); got[b.label] = { build_hash: rows[b.label].build_hash, fixture: goodOf(b).fixture }; }
    return judgeCell({ cell: { kind: 'defect', defect: d }, buildsDoc: BUILDS, expectedDoc: COMMITTED, got });
  };
  try {
    for (const b of o.single) goodOf(b).contract = { answers: { 'LRT-A1': ['pass'] } };
    const both = run(() => ({ answers: { 'LRT-A1': ['fail'] } }));
    assert.equal(both.ok, true);
    assert.equal(both.status, 'committed_contract');
    assert.equal(both.detected, false, 'not run here, so not detected');
    const none = run(() => undefined);
    assert.equal(none.ok, false, 'a row with no contract differs from the correct build only by absence: not detection');
    assert.equal(none.reason, 'neutered');
  } finally {
    for (const [l, f, c, gc] of saved) { rows[l].fixture = f; rows[l].contract = c; }
    for (const b of o.single) goodOf(b).contract = saved[0][3];
  }
});

test('R-DM-14: variants are correct alternatives, not defects: no cell is made for a variant, a build with a variant is not a single-defect build, and the correct builds are the plain ones', () => {
  const { defects, correct } = plan(BUILDS);
  const variants = new Set(BUILDS.builds.map((b) => b.factors.variant).filter((v) => v !== '-'));
  assert.ok(variants.size >= 1, 'the list has variants');
  for (const v of variants) assert.equal(defects.has(v), false, `${v} is a variant, not a defect`);
  for (const [, o] of defects) for (const b of o.single) assert.equal(b.factors.variant, '-');
  for (const b of correct) assert.deepEqual([b.factors.mcp, b.factors.backend, b.factors.variant], ['-', '-', '-']);
  assert.equal(correct.length, 4);
  assert.ok(!allCells(BUILDS).some((c) => variants.has(c.defect)));
});

test('R-DM-15: combo_only and committed_contract defects never satisfy known_bad: they are listed in the report on their own, and known_bad is judged on the defects that were detected or documented', () => {
  const cells = [
    { kind: 'known-good', label: 'L2 correct build', outcome: 'success' },
    { kind: 'defect', defect: 'a', outcome: 'success', status: 'detected' },
    { kind: 'defect', defect: 'b', outcome: 'success', status: 'documented' },
    { kind: 'defect', defect: 'c', outcome: 'success', status: 'combo_only' },
    { kind: 'defect', defect: 'd', outcome: 'success', status: 'committed_contract' },
  ];
  const b = build({ expected: cells.map(({ outcome, status, ...c }) => c), found: cells });
  assert.deepEqual(b.matrix.combo_only, ['c']);
  assert.deepEqual(b.matrix.committed_contract, ['d']);
  assert.deepEqual(b.matrix.detected, ['a']);
  assert.deepEqual(b.matrix.documented_gaps, ['b']);
  assert.equal(control(b, 'known_bad').observed, 'detected_or_documented');
  // the judged ones decide: a neutered one is a miss even beside an unjudged one
  const bad = cells.map((c) => (c.defect === 'a' ? { ...c, outcome: 'failure', status: 'neutered' } : c));
  assert.equal(control(build({ expected: cells.map(({ outcome, status, ...c }) => c), found: bad }), 'known_bad').observed, 'missed');
  // nothing judged at all: the control is not satisfied by the unjudged ones
  const only = cells.filter((c) => c.status === 'combo_only' || c.status === 'committed_contract');
  const none = build({ expected: only.map(({ outcome, status, ...c }) => c), found: only });
  assert.equal(control(none, 'known_bad').observed, 'none_judged');
});
