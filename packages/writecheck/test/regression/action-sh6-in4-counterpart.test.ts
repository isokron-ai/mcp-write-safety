/**
 * Action dogfood on 59e3124 (CLI-BUGS.md, "Launch candidate 59e3124"): SH-6 and SH-7.
 *   SH-6  The MWS-IN-4 counterpart control (spec R14-6) was sent as a real write on the object under test. A boolean counterpart
 *         (paused: true for the probe "true") changed the object's state, which the tester cannot put back: every later update
 *         was refused, so every later base control failed and the records of the tool were lost (Payload updateTasks archived,
 *         Grafana disable_provenance). The fixture's paused-locks option is that shape.
 *   SH-7  Where a control could not be sent or failed, the record repeated the R10-3 sentence ("it repeated when sent again")
 *         instead of saying the control failed.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { head, runFixture, startFixture, TRACKER_GUARD } from './harness.js';
import { ASSIGNEE_STATUS, PATCH_UPDATE, PROJECT, ticket } from './tracker-fixture.js';

const manifest = `${head({ guard: TRACKER_GUARD })}resources:
${PROJECT}${ticket({ update: PATCH_UPDATE, fields: ASSIGNEE_STATUS })}`;

test('SH-6: no counterpart control writes a value the base call did not send to the object under test; the tool keeps its records', async () => {
  const f = await startFixture({ profile: 'tracker', opts: ['paused-locks'], manifest });
  try {
    const r = await runFixture(f);
    const results = r.doc.results as { requirement: string; verdict: string; reason: string; notes: string[]; write_path: { resource: string; tool: string } }[];
    const paused = f.calls().filter((c: { tool: string; args: Record<string, unknown> }) => c.tool === 'ticket_update' && c.args['paused'] === true);
    assert.deepEqual(paused, [], 'the counterpart paused: true is never sent to the object under test');
    const refusedLater = f.calls().length > 0 && results.filter((x) => x.write_path.tool === 'ticket_update' && /is paused/.test(`${x.reason} ${x.notes.join(' ')}`));
    assert.deepEqual(refusedLater, [], 'no record of ticket_update was lost to a paused ticket');
    const in1 = results.filter((x) => x.requirement === 'MWS-IN-1' && x.write_path.tool === 'ticket_update');
    assert.ok(in1.length && in1.every((x) => !/base call.*did not succeed|could not be put back/.test(x.reason)), JSON.stringify(in1.map((x) => [x.verdict, x.reason])));
    // SH-8: the write path keeps its MWS-RES-4 record.
    assert.ok(results.some((x) => x.requirement === 'MWS-RES-4' && x.write_path.tool === 'ticket_update'), 'ticket_update has an MWS-RES-4 record');
    // SH-7: a probe whose counterpart was not sent is reported as such, never with the R10-3 sentence.
    const all = results.filter((x) => x.write_path.tool === 'ticket_update' && /^MWS-IN-/.test(x.requirement));
    assert.ok(all.every((x) => !/it repeated when sent again/.test(x.reason)), JSON.stringify(all.filter((x) => /repeated when sent again/.test(x.reason)).map((x) => x.reason)));
    const told = all.filter((x) => /counterpart/.test(`${x.reason} ${x.notes.join(' ')}`));
    assert.ok(told.length > 0, `a record says the counterpart control was not sent: ${JSON.stringify(all.map((x) => [x.requirement, x.verdict, x.reason.slice(0, 160)]))}`);
  } finally {
    await f.close();
  }
});
