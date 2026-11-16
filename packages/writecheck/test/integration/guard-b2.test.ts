/**
 * Review B2 on a whole run: a guard declared with read_only_call is sent three
 * times for the whole run (never again between checks), each call is in the ledger and the report and counted as a write, and
 * a declared call that creates an object each time is refused before the run's own writes, with a stop that says so.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { readLedger } from '../../src/core/ledger.js';
import { WritecheckError } from '../../src/core/util.js';
import { fakeManifest, runFake, startFake } from '../fake/harness.js';

const declared = () => {
  const text = fakeManifest({ pairs: 10 }).replace('guard: { tool: whoami, args: {}, path: tenant, pattern: "^mwsc-test-" }', 'guard: { tool: whoami, args: {}, path: tenant, pattern: "^mwsc-test-", read_only_call: true }');
  assert.ok(text.includes('read_only_call: true'));
  return text;
};
const ledgerOf = (stateDir: string) => {
  const runs = readdirSync(stateDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  assert.equal(runs.length, 1);
  return readLedger(join(stateDir, runs[0]!.name, 'ledger.jsonl'));
};

test('B2 / S4: a declared guard call is sent three times for the whole run, and each is in the ledger and the report', async () => {
  const f = await startFake({ pairs: 10, defects: ['no-readonly-hints'], manifestText: declared() });
  try {
    const r = await runFake(f);
    assert.equal(r.doc.run.status, 'complete', r.doc.run.stopped_reason ?? '');
    const checksRun = r.doc.observations.length;
    assert.ok(checksRun > 3, `checks ran (${checksRun})`);
    // e613620: 3 + up to 2 per check and global check; now the declared call is never the liveness check.
    assert.equal(f.backend.whoamiCalls, 3, `whoami was called ${f.backend.whoamiCalls} times over ${checksRun} checks`);
    assert.equal(r.doc.target.guard?.basis, 'operator');
    assert.equal(r.doc.target.guard?.calls, 3);
    assert.equal(r.doc.target.guard?.counted_as_writes, 3);
    assert.equal(r.doc.target.guard?.call_steps?.length, 3);
    assert.match(r.doc.target.guard?.note ?? '', /list ticket_list .*read the same before and after the three calls/);
    const g = ledgerOf(join(f.dir, 'state')).filter((e) => e.kind === 'guard_call');
    assert.deepEqual(g.map((e) => (e as { phase: string }).phase), ['check', 'dry', 'after']);
    const report = readFileSync(join(r.outDir, 'report.md'), 'utf8');
    assert.match(report, /Tenant guard calls: whoami was called 3 time\(s\); 3 of them counted as writes/);
    assert.equal(f.backend.tickets.size, 0, 'nothing left in the backend');
  } finally {
    await f.close();
  }
});

test('B2: a declared guard call that creates an object and answers the same each time is refused; the stop names the calls', async () => {
  const f = await startFake({ pairs: 10, defects: ['no-readonly-hints', 'whoami-writes'], manifestText: declared() });
  try {
    await assert.rejects(runFake(f), (e) => {
      assert.ok(e instanceof WritecheckError, String(e));
      assert.equal(e.code, 3);
      assert.match(e.message, /changed across its three calls/);
      assert.match(e.message, /was sent 3 time\(s\)/);
      assert.match(e.message, /may have changed state/);
      assert.doesNotMatch(e.message, /no write was made|before any of its own writes/);
      return true;
    });
    // the three objects the declared call made are the operator's call's, recorded in the ledger; the run made none of its own
    assert.equal(f.backend.whoamiCalls, 3);
    assert.deepEqual([...f.backend.tickets.values()].map((t) => t.title), ['guard-touch', 'guard-touch', 'guard-touch']);
    const l = ledgerOf(join(f.dir, 'state'));
    assert.equal(l.filter((e) => e.kind === 'guard_call').length, 3);
    assert.equal(l.filter((e) => e.kind === 'intent').length, 0);
  } finally {
    await f.close();
  }
});
