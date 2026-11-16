/**
 * grafana/CLI-BUGS.md 12: the tester's setup writes hide what the first write does to fields it did not
 * name, so MWS-UPD-1 is `held` where the correct record is `platform`: a false `held`.
 *
 * Validation row (grafana, both commits):
 *   | MWS-UPD-1 | MUST | dashboard:update_dashboard | held | cases_judged=3 | In 3 successful write(s), each changed only the
 *     field it named (description; ignored: id, version). |
 * By hand, the first patch of a dashboard changes `panels` in the tool's own read (the key
 * `datasource: null` disappears from each panel); the raw merge patch sent to the platform API does the
 * same. The CLI compares only after its two setup updates, when nothing is left to change.
 *
 * Deciding text. Spec MWS-UPD-1, test method: "Create an object […]. Read the object through the server's
 * read tool. Call the update tool naming one field. Read the object again through the same read tool, and
 * compare every other field with its value in the first read […]. The comparison is between the read
 * before the call and the read after it […]. A control arm exists only where the platform API has a
 * partial-update operation of its own: send the equivalent partial update to it and compare in the same
 * way." Verdicts: "`platform` is available only where the platform API's own partial update resets the
 * same fields." Spec NF-1: "the platform API shows the same behavior as the server in a control arm":
 * `platform`.
 *
 * The fixture: the platform itself rewrites `meta` on the first write to an object (keys whose value is
 * null are dropped), through the tool's patch and through the platform's own PATCH alike. The tool is a
 * plain field patch. No string field may be empty and no field is nullable or a list, as for
 * update_dashboard ("not allowed by update_dashboard's schema for any field the tester may write:
 * explicit_null, empty_list, nested_subfield"), so the scratch-object probes do not apply.
 *
 * Status: fails on 7562919 (`held`). Passes on d3b536f: the owners (9d7234d) keep MWS-UPD-1 from `held`
 * when the first write after a create changed a field it did not name. The record there is `not tested`
 * ("judging that first write against the platform is not built in this preview"), not yet the `platform`
 * the method leads to; this test pins the false `held` only. Kept, skipped, as the regression test for
 * that fix.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fixed, head, rows, runFixture, show, startFixture, TRACKER_GUARD } from './harness.js';
import { ASSIGNEE_STATUS, PATCH_UPDATE, ticket } from './tracker-fixture.js';

const MANIFEST = `${head({ guard: TRACKER_GUARD })}
resources:
${ticket({ create: 'assignee: ann, status: blocked, note: "keep me", priority: 4, meta: { source: null, panels: 2 }', update: PATCH_UPDATE, fields: ASSIGNEE_STATUS })}`;

test('grafana/CLI-BUGS 12: a field the first write changes, through the tool and through the platform API alike, is not MWS-UPD-1 held', { skip: fixed('9d7234d', 'grafana/CLI-BUGS.md 12') }, async () => {
  const f = await startFixture({ profile: 'tracker', opts: ['strict-empty'], backend: { normalizeOnWrite: true }, manifest: MANIFEST });
  try {
    const r = await runFixture(f);
    const upd1 = rows(r.doc.results, 'MWS-UPD-1', 'ticket:ticket_update');
    // Correct by the method: `platform`. `not tested` with the reason is also a true record; `held` is the false one.
    assert.ok(upd1.length === 1 && ['platform', 'not tested'].includes(upd1[0]!.verdict), show(upd1));
    assert.match(upd1[0]!.reason, /meta/, 'the record names the field the first write changed');
    assert.equal(f.backend.all('tickets').length, 0, 'nothing of the run is left behind');
  } finally {
    await f.close();
  }
});
