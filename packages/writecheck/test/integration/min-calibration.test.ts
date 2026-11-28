/**
 * Min mode, the false-pass guard (calibration): min mode run against tiny-tracker's builds, with tiny-tracker's backend
 * replaced by the mock made from its own OpenAPI description (examples/tiny-tracker/openapi.yaml).
 *
 *   - every MCP-layer defect whose requirement min mode judges (run or partial) is detected: that requirement is violated
 *     (or, for a review-only clause, self-attested: no);
 *   - every defect whose requirement needs real backend semantics (UPD, CONC-1/2/3, TGT-1/3, RES-1, ATOM-2, and the
 *     in-flight form of RES-2) comes out not_testable_mock, never held and never violated;
 *   - the correct build is clean: no violated record, no review answer "no".
 *
 * One top-level test per build, so that CI can split the file (scripts/ci/test-shard.mjs --split). MIN_CALIBRATION
 * narrows it to a comma list of defect names (or "correct").
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { readDeclaration } from '../../src/min/declaration.js';
import { capViolations, minStatus, observedMin, runMin, type MinDoc } from '../../src/min/run.js';
import { tinyTrackerDir, TT_MANIFEST } from '../tiny-tracker/harness.js';

const tt = tinyTrackerDir();
const skip = tt ? false : 'tiny-tracker is not built (examples/tiny-tracker: npm ci && npm run build, or TINY_TRACKER_DIR)';
const ttSrc = join(TT_MANIFEST, '..');
const expected = JSON.parse(readFileSync(join(ttSrc, 'expected', 'writecheck-expected-0.4.0.json'), 'utf8')) as { defects: Record<string, { layer: string; expected: string[] }> };

/** What min mode must say about one defect (null: nothing; the backend fixture-layer defects and lookup-reexecutes). */
export function minExpectation(defect: string): { judged: string[]; capped: string[] } | null {
  const e = expected.defects[defect];
  if (!e || !e.expected.length) return null;
  const reqs = e.expected.map((x) => x.split(':')[0]!);
  // The in-flight forms (features inflight): a concurrency defect, whatever its requirement's area.
  const inflight = ['in-progress-reported-not-applied', 'settle-miss-reported-not-applied'].includes(defect);
  return { judged: inflight ? [] : reqs.filter((r) => minStatus(r) !== 'not_testable_mock'), capped: inflight ? reqs : reqs.filter((r) => minStatus(r) === 'not_testable_mock') };
}

export async function runBuild(defects: string[]): Promise<MinDoc> {
  return runMin({
    spec: join(tt!, 'openapi.yaml'),
    specUrl: 'https://github.com/isokron-ai/mcp-write-safety/blob/main/examples/tiny-tracker/openapi.yaml',
    server: { command: process.execPath, args: [join(tt!, 'dist', 'src', 'cli.js'), 'stdio'], cwd: tt!, env: defects.length ? { TRACKER_DEFECTS: defects.join(',') } : {} },
    baseUrlEnv: ['TRACKER_BACKEND_URL'],
    envNames: ['TRACKER_BACKEND_TOKEN'],
    declaration: readDeclaration(TT_MANIFEST),
    timeoutMs: 10_000,
    ...(process.env['MIN_VERBOSE'] ? { log: (l: string) => process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${l}\n`), out: join(process.env['MIN_VERBOSE'], defects.join('+') || 'correct') } : {}),
  });
}

const only = (process.env['MIN_CALIBRATION'] ?? '').split(',').filter(Boolean);
const want = (name: string) => !only.length || only.includes(name);

const caps = (doc: MinDoc, reqs: string[]) => {
  for (const r of reqs) {
    const recs = doc.results.filter((x) => x.requirement === r);
    assert.ok(recs.length, `${r}: no record`);
    for (const x of recs) {
      assert.equal(x.verdict, 'not tested', `${r} must never be judged in min mode, got ${x.verdict}: ${x.reason}`);
      assert.equal(x.status, 'not_testable_mock', `${r}: not marked not_testable_mock`);
      assert.equal(x.reason_code, 'backend_semantics_not_exercised');
      assert.equal(x.basis, 'stateful-mock');
    }
  }
};

if (want('correct')) {
  test('R-MIN-01: min mode on the correct tiny-tracker build is clean, and the nine backend-semantic requirements are not_testable_mock', { skip, timeout: 600_000 }, async () => {
    const doc = await runBuild([]);
    assert.equal(doc.run.status, 'complete', doc.server.start_problem ?? '');
    assert.equal(doc.mode, 'min');
    assert.match(doc.spec.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(capViolations(doc), []);
    assert.deepEqual(observedMin(doc), [], `the correct build must be clean:\n${doc.results.filter((r) => r.verdict === 'violated' || r.answer === false).map((r) => `${r.requirement} ${r.tool} ${r.case}: ${r.reason}`).join('\n')}`);
    caps(doc, ['MWS-UPD-1', 'MWS-UPD-2', 'MWS-CONC-1', 'MWS-CONC-2', 'MWS-CONC-3', 'MWS-TGT-1', 'MWS-TGT-3', 'MWS-RES-1', 'MWS-ATOM-2']);
    assert.ok(doc.results.some((r) => r.verdict === 'held'), 'some requirement must have been forced and held');
    assert.ok(doc.faults_injected.length > 0, 'the mock injected no fault');
  });
}

if (want('read-merge-put')) {
  test('R-MIN-05: the false-pass self-test: a server that loses updates (read-merge-put) against the stateful mock comes back not tested for MWS-CONC-3, never held; without the cap the guard refuses it', { skip, timeout: 600_000 }, async () => {
    const doc = await runBuild(['read-merge-put']);
    assert.equal(doc.run.status, 'complete');
    caps(doc, ['MWS-CONC-3', 'MWS-CONC-1', 'MWS-UPD-1', 'MWS-RES-1']);
    assert.deepEqual(capViolations(doc), []);
    // Mutation check: the same run with the cap turned off is refused by the guard (no not_testable_mock record for CONC-3).
    const off = await runMin({ spec: join(tt!, 'openapi.yaml'), server: { command: process.execPath, args: [join(tt!, 'dist', 'src', 'cli.js'), 'stdio'], cwd: tt!, env: { TRACKER_DEFECTS: 'read-merge-put' } }, baseUrlEnv: ['TRACKER_BACKEND_URL'], envNames: ['TRACKER_BACKEND_TOKEN'], declaration: readDeclaration(TT_MANIFEST), timeoutMs: 10_000, mutate: { cap: false } });
    assert.ok(capViolations(off).some((b) => b.startsWith('MWS-CONC-3')), 'the guard must catch a run without the cap');
  });
}

for (const [defect, e] of Object.entries(expected.defects)) {
  if (e.layer !== 'mcp' || !want(defect)) continue;
  const x = minExpectation(defect);
  if (!x) continue;
  const kind = x.judged.length ? 'is detected' : 'comes out not_testable_mock, never held';
  test(`R-MIN-02: min mode on tiny-tracker with ${defect} ${kind} (${[...x.judged, ...x.capped].join(', ')})`, { skip, timeout: 600_000 }, async () => {
    const doc = await runBuild([defect]);
    assert.equal(doc.run.status, 'complete', doc.server.start_problem ?? '');
    assert.deepEqual(capViolations(doc), []);
    const seen = observedMin(doc);
    for (const r of x.judged) assert.ok(seen.includes(`${r}:violated`) || seen.includes(`${r}:self-attested-no`), `${defect}: ${r} was not detected; min mode reported ${JSON.stringify(seen)}; ${r} records: ${JSON.stringify(doc.results.filter((y) => y.requirement === r).map((y) => [y.tool, y.case, y.verdict, y.reason]))}`);
    caps(doc, x.capped);
  });
}
