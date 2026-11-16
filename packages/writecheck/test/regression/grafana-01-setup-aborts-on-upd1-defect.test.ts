/**
 * grafana/CLI-BUGS.md 1: the tester's setup aborts on the very defect MWS-UPD-1 is about. A tool that
 * resets the fields it is not given can never hold both declared fields at their baseline, so every row
 * of the resource is `not tested`, with a reason that does not name MWS-UPD-1.
 *
 * Validation rows (grafana, both commits; resource `alert-rule`, tool alerting_rules_write, fields
 * `labels` and `annotations`, both created with non-default values; 26 rows on e94270a, more on 66e40e2):
 *   MWS-UPD-1 | MUST | alert-rule:alerting_rules_write | not tested | setup failed: the baseline values did not read back
 * By hand on the same build: an update that names only `labels` removes `annotations` (GF-03).
 *
 * Deciding text. Spec MWS-UPD-1: "An update tool in field-patch mode MUST change only the fields its
 * arguments name, so that every other field of the object, apart from server-managed fields, keeps its
 * stored value and no default is written that the caller did not send." Test method: "Read the object
 * through the server's read tool. Call the update tool naming one field. Read the object again through
 * the same read tool, and compare every other field with its value in the first read". The method has no
 * step that must first succeed in setting two fields one after the other through the tool under test;
 * the first update that names one field and resets the other is the `violated` record.
 *
 * The fixture: ticket_update rebuilds the whole ticket from its arguments (option `rebuild`), so each
 * field the call does not name goes back to its default. Both declared fields have non-default values.
 *
 * Status: fails on 7562919; passes on d3b536f, fixed by the owners in 9d7234d. Kept, skipped, as the regression test for that fix.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fixed, head, rows, runFixture, show, startFixture, TRACKER_GUARD } from './harness.js';
import { ASSIGNEE_STATUS, PATCH_UPDATE, ticket } from './tracker-fixture.js';

const MANIFEST = `${head({ guard: TRACKER_GUARD })}
resources:
${ticket({ create: 'assignee: ann, status: blocked, note: "keep me", priority: 4', update: PATCH_UPDATE, fields: ASSIGNEE_STATUS })}`;

test('grafana/CLI-BUGS 1: a tool that resets unnamed fields is MWS-UPD-1 violated, not "setup failed"', { skip: fixed('9d7234d', 'grafana/CLI-BUGS.md 1') }, async () => {
  const f = await startFixture({ profile: 'tracker', opts: ['rebuild'], manifest: MANIFEST });
  try {
    const r = await runFixture(f);
    const upd1 = rows(r.doc.results, 'MWS-UPD-1', 'ticket:ticket_update');
    assert.deepEqual(upd1.map((x) => x.verdict), ['violated'], show(upd1));
    assert.equal(f.backend.all('tickets').length, 0, 'nothing of the run is left behind');
  } finally {
    await f.close();
  }
});

/*
 * grafana/CLI-BUGS-d3b536f.md 1 (seen again on 169b0cb): GF-03 set-up still aborts with no MWS-UPD-1 record. The
 * set-up record was made only for a field still present with another value; Grafana's alerting_rules_write removes
 * the field the call does not name (the read after the second write has no `labels`). A field that a write naming
 * only the other field removed is changed by that write, which is the defect MWS-UPD-1 is about.
 *
 * The fixture: ticket_update rebuilds the ticket without the fields it is not given (option rebuild-drop), and the
 * ticket is created without the baseline values, so the set-up has to write both fields.
 */
const DROP_MANIFEST = `${head({ guard: TRACKER_GUARD })}
resources:
${ticket({ update: PATCH_UPDATE, fields: ASSIGNEE_STATUS })}`;

test('grafana/CLI-BUGS-d3b536f 1: a write naming one field that removes the other gives the set-up MWS-UPD-1 violated record', async () => {
  const f = await startFixture({ profile: 'tracker', opts: ['rebuild-drop'], manifest: DROP_MANIFEST });
  try {
    const r = await runFixture(f);
    const upd1 = rows(r.doc.results, 'MWS-UPD-1', 'ticket:ticket_update');
    assert.deepEqual(upd1.map((x) => x.verdict), ['violated'], show(upd1));
    assert.match(upd1[0]!.reason, /removed it|removed/, upd1[0]!.reason);
    assert.equal(f.backend.all('tickets').length, 0, 'nothing of the run is left behind');
  } finally {
    await f.close();
  }
});
