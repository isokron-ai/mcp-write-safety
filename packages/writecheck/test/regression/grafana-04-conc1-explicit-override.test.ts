/**
 * grafana/CLI-BUGS.md 4: MWS-CONC-1 is `violated` and `held` on one write path. The stale-write record
 * rests on calls that carried an explicit override the manifest had to declare among the tool's
 * arguments: a false `violated`.
 *
 * Validation rows (grafana, both commits; resource `dashboard-v2`, update args
 * `{ uid, dashboard: "{{object}}", folderUid, overwrite: true }`, because the tool refuses every full-body
 * update of an existing v2 dashboard without `overwrite`; the tool has no version argument):
 *   MWS-CONC-1 | MUST | dashboard-v2:update_dashboard | violated | repetitions=3, stale_won=3, refused=0, control_conflict=3 |
 *     The platform's API refuses a stale write (409/412 in 3 of 3), but update_dashboard overwrote the newer state in 3 of 3
 *   MWS-CONC-1 | MUST | dashboard-v2:update_dashboard | held |
 *     In 2 forced trials the tool's held write did not go over the other writer's change (refused, or re-read).
 *
 * Deciding text. Spec MWS-CONC-1: "A write tool MUST NOT disable or bypass a concurrency control that the
 * backend offers for the operation it performs, unless the caller sets an explicit override argument whose
 * default is off." Test method, black-box: "Send through the tool, with default arguments, the same write
 * that the control arm sent to the platform API". Spec NF-7, behavior: "A caller sets an explicit override
 * or opt-in argument (to bypass a lock, to overwrite, or to match everything) and the tool does what the
 * argument asks."; correct treatment: "Not a violation of MWS-CONC-1, MWS-CONC-2, MWS-TGT-2 or MWS-TGT-3."
 *
 * Correct record for this fixture: sent with default arguments (no `overwrite`), the stale write is
 * refused, which is `held` ("the tool's write was refused"). If the tester cannot send the write without
 * the declared override, the black-box arm was not run as the method says, which is `not tested`. A
 * `violated` that rests only on calls carrying `overwrite: true` is the false row.
 *
 * The fixture: ticket_save has the shape of update_dashboard on a v2 dashboard: no version argument;
 * `overwrite` (boolean, schema default false); without it a save of an existing ticket is refused; with
 * it the tool copies the current version onto the caller's body.
 *
 * Status: fails on 7562919, with the manifest as it was declared in the validation run (the two rows
 * above, word for word; `update.override` does not exist there). Passes on d3b536f: the owners fixed it
 * in 9d7234d with a manifest key, `update.override: <argument>`, which names the explicit override among
 * the declared arguments; MWS-CONC-1's black-box record is then `not tested`. The manifest below carries
 * the key. Without the key d3b536f still gives the false `violated`: nothing in the tool reads the input
 * schema's `default: false` for an argument the declaration sets to true. Kept, skipped, as the regression
 * test for that fix.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fixed, head, rows, runFixture, show, startFixture, TRACKER_GUARD } from './harness.js';
import { ASSIGNEE_STATUS, ticket } from './tracker-fixture.js';

const MANIFEST = `${head({ guard: TRACKER_GUARD, gate: true })}
resources:
${ticket({ name: 'ticket-save', update: '{ tool: ticket_save, mode: full_replace, args: { id: "{{id}}", ticket: "{{object}}", overwrite: true }, override: overwrite }', fields: ASSIGNEE_STATUS })}`;

test('grafana/CLI-BUGS 4: a stale write that went through only with an explicit override set is not an MWS-CONC-1 violation', { skip: fixed('9d7234d', 'grafana/CLI-BUGS.md 4') }, async () => {
  const f = await startFixture({ profile: 'tracker', manifest: MANIFEST });
  try {
    const r = await runFixture(f);
    const conc1 = rows(r.doc.results, 'MWS-CONC-1', 'ticket-save:ticket_save');
    // Every ticket_save call that was applied carried the override: the tool refuses all others.
    const saves = f.calls().filter((c) => c.tool === 'ticket_save');
    assert.ok(saves.length > 0, 'the tool was exercised');
    const violated = conc1.filter((x) => x.verdict === 'violated');
    assert.deepEqual(violated.map((x) => `[${x.scenario.id}] ${x.reason}`), [], `NF-7: the override was set by the caller in every call that was applied (${saves.filter((c) => c.args['overwrite'] === true).length} of ${saves.length} calls carried overwrite: true)`);
    const stale = conc1.filter((x) => x.scenario.id.startsWith('stale-write'));
    assert.ok(stale.length === 1 && ['held', 'not tested'].includes(stale[0]!.verdict), `the black-box record is held (sent with default arguments, the write is refused) or not tested:\n${show(stale)}`);
    assert.equal(f.backend.all('tickets').length, 0, 'nothing of the run is left behind');
  } finally {
    await f.close();
  }
});
