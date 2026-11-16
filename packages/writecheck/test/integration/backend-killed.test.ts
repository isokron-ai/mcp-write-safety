/**
 * The GitHub Action's test (problem 14 in the Action's NOTES.md, "Job status"): tiny-tracker's backend was killed 20 s into a run, and the CLI still reported the run `complete` with exit 0
 * (166 records not tested, clean-up stopped after 3 failures, 61 failed deletes, 9 creates of unknown outcome).
 *
 * A run whose target or backend stops answering, or whose clean-up cannot finish, is `stopped`, exits 4, and says why at
 * the top of the report. It is never `complete` while its own objects may be left behind.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { runFake, startFake } from '../fake/harness.js';

test('a backend killed mid-run: the run is stopped, exits 4, and the report says why at the top', async () => {
  const f = await startFake({ pairs: 10 });
  let killed = false;
  // Mid-run: after the setup and the first checks have made their requests.
  const t = setInterval(() => {
    if (!killed && f.backend.requests >= 60) {
      killed = true;
      void f.backend.stop();
    }
  }, 5);
  try {
    const r = await runFake(f);
    assert.ok(killed, 'the backend was killed during the run');
    assert.equal(r.doc.run.status, 'stopped', r.doc.run.stopped_reason ?? '');
    assert.equal(r.exit, 4);
    assert.match(r.doc.run.stopped_reason ?? '', /stopped answering|clean-up did not finish/);
    const md = readFileSync(join(r.outDir, 'report.md'), 'utf8');
    const top = md.split('\n').slice(0, 12).join('\n');
    assert.match(top, /This run is incomplete \(exit 4\)/, top);
    // The objects it could not delete are named.
    const c = r.doc.cleanup!;
    assert.ok(c.failed.length + c.unknown.length > 0 || c.stopped !== null || r.doc.leftovers.length > 0, JSON.stringify(c).slice(0, 400));
  } finally {
    clearInterval(t);
    await f.close();
  }
});

test('a backend that stays up: the run is complete and exits 0 or 1', async () => {
  const f = await startFake({ pairs: 10 });
  try {
    const r = await runFake(f);
    assert.equal(r.doc.run.status, 'complete', r.doc.run.stopped_reason ?? '');
    assert.ok(r.exit === 0 || r.exit === 1);
  } finally {
    await f.close();
  }
});
