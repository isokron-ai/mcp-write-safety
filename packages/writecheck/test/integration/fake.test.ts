/**
 * End to end against the in-repo fake tracker (the stand-in for tiny-tracker until its branch
 * lands): the correct build gives no `violated`; each defect gives `violated` for its requirement
 * (and the listed secondary effects, nothing else); a backend that loses updates itself gives
 * `platform`; and the evidence, the cleanup and `recheck` work on a real run.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { recheckCommand } from '../../src/cli/commands.js';
import { verifyCapture } from '../../src/core/capture.js';
import { openRuns } from '../../src/core/ledger.js';
import { verifyChecksums } from '../../src/report/evidence.js';
import { requirement } from '../../src/requirements.js';
import { RESULTS_KEYS } from '../../src/report/results.js';
import { writePathKey, type Result } from '../../src/report/verdicts.js';
import { fakeManifest, runFake, startFake } from '../fake/harness.js';

const key = (r: Result) => `${r.requirement} ${writePathKey(r.write_path)}`;
const violated = (rs: Result[]) => rs.filter((r) => r.verdict === 'violated').map(key).sort();
const find = (rs: Result[], k: string) => rs.find((r) => key(r) === k);

test('correct build, 40 pairs: no violation, the forced cases held, pairs only "not observed", nothing left behind', async () => {
  const f = await startFake({ pairs: 40 });
  try {
    const r = await runFake(f);
    const rs = r.doc.results;
    assert.deepEqual(violated(rs), []);
    assert.equal(r.exit, 0);
    assert.equal(r.doc.run.status, 'complete');
    for (const k of ['MWS-CONC-2 ticket-doc:ticket_replace', 'MWS-CONC-1 ticket-doc:ticket_replace', 'MWS-CONC-4 ticket-doc:ticket_replace', 'MWS-UPD-1 ticket:ticket_update', 'MWS-RES-1 ticket:ticket_update', 'MWS-RES-2 ticket:ticket_update', 'MWS-RETRY-2 ticket:ticket_create'])
      assert.equal(find(rs, k)?.verdict, 'held', k);
    // why: spec R14-6, Annex E: priority is declared restorable, so its counterpart is sent, put back and confirmed, and the
    // probe is judged (without the declaration, SH-6 leaves it not judged and these records not tested).
    for (const k of ['MWS-IN-1 ticket:ticket_update', 'MWS-IN-4 ticket:ticket_update']) assert.equal(find(rs, k)?.verdict, 'held', `${k}: ${find(rs, k)?.reason}`);
    assert.equal(find(rs, 'MWS-ANN-3 ticket:ticket_update')?.verdict, 'not observed', 'a claim about all state is never held (spec 8.2, rule 8)');
    for (const k of ['MWS-CONC-3 ticket:ticket_update', 'MWS-CONC-3 ticket-doc:ticket_replace']) {
      const c = find(rs, k)!;
      // spec 8.2 rule 6: "not observed" needs 30 overlapped pairs; fewer is "not tested".
      assert.equal(c.verdict, (c.numbers['pairs_overlapped'] as number) >= 30 ? 'not observed' : 'not tested', k);
      assert.equal(c.numbers['pairs'], 40);
    }
    assert.equal(find(rs, 'MWS-CONC-2 ticket:ticket_update')?.verdict, 'not applicable', 'a field patch with no version has no stale base');
    assert.equal(find(rs, 'MWS-UPD-1 ticket-doc:ticket_replace')?.verdict, 'not applicable', 'UPD-1 does not apply to full_replace');
    assert.ok(rs.every((r) => r.write_path.tool && r.write_path.tool !== '(all)'), 'results are per write path, tool or setting');
    // Cleanup: the ledger is closed, the backend holds nothing the run made, no leftovers.
    assert.equal(f.backend.tickets.size, 0);
    assert.deepEqual(r.doc.leftovers, []);
    assert.deepEqual(openRuns(join(f.dir, 'state')), []);
    // Evidence.
    for (const file of ['report.md', 'results.json', 'junit.xml', 'SHA256SUMS', 'history.jsonl', 'ledger.jsonl', 'catalog.json', 'plan.json', 'manifest.yaml']) assert.ok(existsSync(join(r.outDir, file)), file);
    assert.ok(verifyChecksums(r.outDir).ok);
    assert.ok(verifyCapture(join(r.outDir, 'capture')).ok);
    const json = JSON.parse(readFileSync(join(r.outDir, 'results.json'), 'utf8')) as Record<string, unknown>;
    assert.deepEqual(Object.keys(json), [...RESULTS_KEYS]);
    assert.equal(readFileSync(join(r.outDir, 'report.md'), 'utf8').split('\n')[0]!.startsWith('Scope:'), true);
    assert.ok(r.doc.measurements && r.doc.measurements['A-2'].tools === 7 && r.doc.measurements['A-4'].order_stable_across_two_lists === true);
    // History: every invoke has an outcome.
    const hist = readFileSync(join(r.outDir, 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { op: number; phase: string });
    const invoked = new Set(hist.filter((h) => h.phase === 'invoke').map((h) => h.op));
    const ended = new Set(hist.filter((h) => h.phase !== 'invoke').map((h) => h.op));
    assert.deepEqual([...invoked].filter((o) => !ended.has(o)), []);
    // recheck: the same rules over the recorded observations give the same verdicts, offline.
    const re = recheckCommand({ dir: r.outDir, log: () => {} });
    assert.deepEqual(re.changed, []);
    assert.ok(verifyChecksums(r.outDir).ok, 'recheck does not touch the sealed evidence');
  } finally {
    await f.close();
  }
});

/** Each defect: the violations it must produce, and nothing else. Secondary effects are listed and explained. */
const MATRIX: [string, string[]][] = [
  ['MWS-CONC-3', ['MWS-CONC-3 ticket:ticket_update']],
  // A whole-object tool that drops the version loses both the stale write and the concurrent pair, and bypasses the backend's check.
  ['MWS-CONC-2', ['MWS-CONC-1 ticket-doc:ticket_replace', 'MWS-CONC-2 ticket-doc:ticket_replace', 'MWS-CONC-3 ticket-doc:ticket_replace']],
  ['MWS-CONC-4', ['MWS-CONC-4 ticket-doc:ticket_replace']],
  ['MWS-UPD-1', ['MWS-UPD-1 ticket:ticket_update']],
  ['MWS-RES-1', ['MWS-RES-1 ticket:ticket_update']],
  ['MWS-RES-2', ['MWS-RES-2 ticket:ticket_update']],
  // Coercion also turns a wrong-type id into a not-found.
  // K9: ticket_get's coerced id answers with a tool error that does not name the argument: MWS-IN-4 violated there.
  ['MWS-IN-1', ['MWS-IN-1 ticket:ticket_update', 'MWS-IN-4 ticket-doc:ticket_get', 'MWS-IN-4 ticket:ticket_get', 'MWS-IN-6 ticket:ticket_update']],
  // A dropped argument was also not rejected (MWS-IN-7).
  ['MWS-IN-2', ['MWS-IN-2 ticket-doc:ticket_get', 'MWS-IN-2 ticket-doc:ticket_replace', 'MWS-IN-2 ticket:ticket_get', 'MWS-IN-2 ticket:ticket_update', 'MWS-IN-7 ticket-doc:ticket_get', 'MWS-IN-7 ticket-doc:ticket_replace', 'MWS-IN-7 ticket:ticket_get', 'MWS-IN-7 ticket:ticket_update']],
  ['MWS-IN-3', ['MWS-IN-3 ticket:ticket_update']],
  ['MWS-IN-4', ['MWS-IN-4 ticket-doc:ticket_get', 'MWS-IN-4 ticket-doc:ticket_replace', 'MWS-IN-4 ticket:ticket_get', 'MWS-IN-4 ticket:ticket_update']],
  ['MWS-ANN-1', ['MWS-ANN-1 ticket-doc:ticket_list', 'MWS-ANN-1 ticket:ticket_list']],
  // An overwrite of the field the call names is not MWS-ANN-2 (spec, narrowed); it is not additive (MWS-ANN-5).
  ['MWS-ANN-2', ['MWS-ANN-5 ticket:ticket_update']],
  ['MWS-ANN-3', ['MWS-ANN-3 ticket-doc:ticket_create', 'MWS-ANN-3 ticket:ticket_create']],
  ['MWS-ANN-4', ['MWS-ANN-4 (catalog):ticket_list']],
  // Step (d) is its own record (the same key sent twice at once also makes two objects).
  ['MWS-RETRY-2', ['MWS-RETRY-2 ticket:ticket_create', 'MWS-RETRY-2 ticket:ticket_create']],
  // Deduplicating by title without the key is also a race: simultaneous pairs make two objects (step (d)).
  ['MWS-RETRY-2:args', ['MWS-RETRY-2 ticket:ticket_create', 'MWS-RETRY-2 ticket:ticket_create']],
  ['MWS-RETRY-2:reuse', ['MWS-RETRY-2 ticket:ticket_create', 'MWS-RETRY-2 ticket:ticket_create']],
];

for (const [defect, expected] of MATRIX) {
  test(`defect ${defect}: violated exactly where expected; cleanup complete`, async () => {
    const f = await startFake({ defects: [defect], pairs: 10 });
    try {
      const r = await runFake(f);
      assert.deepEqual(violated(r.doc.results), expected);
      assert.equal(r.exit, expected.some((k) => requirement(k.split(' ')[0]!).level === 'MUST') ? 1 : 0, 'exit 1 only for a violated MUST');
      assert.equal(f.backend.tickets.size, 0, 'nothing left in the backend');
      assert.deepEqual(openRuns(join(f.dir, 'state')), []);
      for (const k of expected) assert.ok(find(r.doc.results, k)!.reason.length > 10);
    } finally {
      await f.close();
    }
  });
}

// MWS-RETRY-2 with the gate and a declared restart: the proxy-assisted step, step (e) and its crash form run against the fake.
const gatedRestart = (stop: 'graceful' | 'kill') => fakeManifest({ pairs: 4 }).replace('  processes: separate', `  processes: separate\n  restart: { stop: ${stop} }`) + 'backend:\n  gate: { rewrite_env: TRACKER_URL }\n';
const retry2 = (rs: Result[]) => Object.fromEntries(rs.filter((r) => r.requirement === 'MWS-RETRY-2' && r.write_path.tool === 'ticket_create').map((r) => [r.scenario.id, r.verdict]));

test('MWS-RETRY-2, gated and restarted: keys kept by the backend hold every step; a key map in server memory is violated after a restart', async () => {
  const ok = await startFake({ manifestText: gatedRestart('kill'), pairs: 4 });
  try {
    const r = await runFake(ok);
    assert.deepEqual(retry2(r.doc.results), { 'idempotency-replay': 'held', 'idempotency-replay.concurrent': 'not tested', 'idempotency-replay.proxy': 'held', 'idempotency-replay.restart': 'held', 'idempotency-replay.restart-crash': 'held' });
    const e = r.doc.results.find((x) => x.scenario.id === 'idempotency-replay.restart')!;
    assert.equal(e.numbers['stop'], 'kill');
    assert.ok(e.notes.some((n) => /^Method: black-box \(launch\)/.test(n)));
    assert.ok(r.doc.results.find((x) => x.scenario.id === 'idempotency-replay.restart-crash')!.notes.some((n) => /commit_then_hang/.test(n)), 'spec 7.3 rule 7: the schedule');
    assert.equal(ok.backend.tickets.size, 0);
    assert.deepEqual(r.doc.leftovers, []);
  } finally {
    await ok.close();
  }
  const bad = await startFake({ manifestText: gatedRestart('graceful'), defects: ['MWS-RETRY-2:reuse'], pairs: 4 });
  try {
    const r = await runFake(bad);
    const v = retry2(r.doc.results);
    for (const k of ['idempotency-replay.proxy', 'idempotency-replay.restart', 'idempotency-replay.restart-crash']) assert.equal(v[k], 'violated', k);
    assert.equal(bad.backend.tickets.size, 0, 'the second objects the trace found were adopted and cleaned up');
    assert.deepEqual(r.doc.leftovers, []);
  } finally {
    await bad.close();
  }
});

test('a backend that loses updates itself: platform, not violated', async () => {
  const f = await startFake({ lostUpdate: true, pairs: 10 });
  try {
    const r = await runFake(f);
    const rs = r.doc.results;
    assert.equal(find(rs, 'MWS-CONC-3 ticket:ticket_update')?.verdict, 'platform');
    assert.equal(find(rs, 'MWS-CONC-3 ticket-doc:ticket_replace')?.verdict, 'platform');
    assert.equal(find(rs, 'MWS-CONC-2 ticket-doc:ticket_replace')?.verdict, 'platform');
    assert.equal(find(rs, 'MWS-CONC-1 ticket-doc:ticket_replace')?.verdict, 'not applicable', 'spec MWS-CONC-1: the backend did not apply the declared control');
    assert.deepEqual(violated(rs), []);
  } finally {
    await f.close();
  }
});

test('the same defect without a control: CONC-2 row 4 (violated, attribution unresolved); no CONC-1 verdict', async () => {
  const f = await startFake({ defects: ['MWS-CONC-2'], control: false, pairs: 10 });
  try {
    const rs = (await runFake(f)).doc.results;
    const c2 = find(rs, 'MWS-CONC-2 ticket-doc:ticket_replace')!;
    assert.equal(c2.verdict, 'violated', 'spec MWS-CONC-2, row 4: applied, and no control arm ran');
    assert.equal(c2.attribution, 'unresolved');
    assert.notEqual(find(rs, 'MWS-CONC-1 ticket-doc:ticket_replace')?.verdict, 'violated', 'CONC-1 needs a control arm');
  } finally {
    await f.close();
  }
});
