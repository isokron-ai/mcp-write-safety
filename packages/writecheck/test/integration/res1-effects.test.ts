/**
 * MWS-RES-1 on every write tool of tiny-tracker (B-GAP F3), judged from the effects the shipped manifest declares. The correct
 * build is covered by tiny-tracker.test.ts (no violation); here two broken builds (test/regression/res1-broken-tracker.ts) give
 * `violated` on exactly the write tools they break. Runs when tiny-tracker is built; skipped otherwise.
 */

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { writePathKey, type Result } from '../../src/report/verdicts.js';
import { runTT, startTinyTracker, tinyTrackerDir } from '../tiny-tracker/harness.js';

const dir = tinyTrackerDir();
const skip = dir ? false : 'tiny-tracker is not built here (examples/tiny-tracker/dist or TINY_TRACKER_DIR)';
const server = join(dirname(fileURLToPath(import.meta.url)), '..', 'regression', 'res1-broken-tracker.js');
const launch = (variant: string) => (text: string) => text.replace('    command: [node, dist/src/cli.js, server, --port, "0"]', `    command: [node, ${JSON.stringify(server)}, ${variant}]`);
// why: one record per write path from the effects procedure; the in-flight scenario's MWS-RES-1 record (inflight.lost-held, a lost
// answer with the request held) is about another condition and is pinned in inflight.test.ts.
const res1 = (rs: Result[]) => Object.fromEntries(rs.filter((r) => r.requirement === 'MWS-RES-1' && !r.scenario.id.startsWith('inflight.')).map((r) => [writePathKey(r.write_path), r.verdict]));

test('MWS-RES-1, no-op writes: violated on each write tool that reports success and writes nothing (or not what it was asked)', { skip }, async () => {
  const t = await startTinyTracker(dir!, { pairs: 10, gateReps: 1, edit: launch('noop') });
  try {
    const r = await runTT(t);
    const v = res1(r.doc.results);
    for (const k of ['ticket:create_ticket', 'ticket:add_comment', 'ticket:add_label', 'ticket:remove_label', 'ticket:set_labels', 'ticket:close_ticket', 'ticket:bulk_update_tickets', 'project:create_project', 'project:delete_project']) assert.equal(v[k], 'violated', k);
    for (const k of ['ticket:update_ticket', 'ticket:delete_ticket', 'ticket-replace:replace_ticket', 'ticket-replace:delete_ticket']) assert.equal(v[k], 'held', k);
    // why: a delete_tickets that deletes nothing fails MWS-TGT-1's narrow call, so the multi-item delete is not sent (spec 7.3).
    assert.equal(v['ticket:delete_tickets'], 'not tested');
    const add = r.doc.results.find((x) => x.requirement === 'MWS-RES-1' && x.write_path.tool === 'add_label')!;
    assert.match(add.reason, /labels holds \{"name":"added"\}: read back \[/);
    assert.ok(add.steps.length > 0);
  } finally {
    await t.close();
  }
});

test('MWS-RES-1, a bulk delete that leaves one match: violated on delete_tickets only', { skip }, async () => {
  const t = await startTinyTracker(dir!, { pairs: 10, gateReps: 1, edit: launch('batch-drops-last') });
  try {
    const r = await runTT(t);
    const v = res1(r.doc.results);
    assert.equal(v['ticket:delete_tickets'], 'violated');
    assert.deepEqual(Object.entries(v).filter(([k, x]) => k !== 'ticket:delete_tickets' && x !== 'held'), []);
    assert.deepEqual(r.doc.leftovers, []);
  } finally {
    await t.close();
  }
});
