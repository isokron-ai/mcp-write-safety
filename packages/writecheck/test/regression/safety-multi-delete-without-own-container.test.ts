/**
 * Review of note 8, finding 12 (tester safety): a declared multi-item bulk delete was called in `ctx.driver.scope`, which is
 * null (the server's default project, holding tickets the tester did not create) when the run scope could not be created.
 *
 * Deciding text. Spec 7.3, first rule: a probe that could act beyond the tester's objects "is sent only where … that scope is
 * also a container that the tester created and has confirmed holds nothing but objects it created. Where the rules cannot be
 * met, the test is not run or the probe is not sent, and the record says so".
 *
 * The fixture: no project can be created (`project-create-fails`), so the run scope falls back to the default project, which
 * holds two bystander tickets; the bulk delete with no project acts on the default project (`default-missing-scope`) and does
 * not use its prefix (`delete-ignores-prefix`). Before the fix the ATOM trial deleted the bystanders. Now the multi-item delete
 * is not called at all, the bystanders are untouched, and MWS-ATOM-1 and MWS-ATOM-2 are `not tested` with the reason.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { head, rows, runFixture, show, startFixture, TRACKER_GUARD } from './harness.js';
import { BYSTANDERS, bystandersLeft, seedBystanders } from './safety-fixture.js';
import { ASSIGNEE_STATUS, PATCH_UPDATE, PROJECT, ticket } from './tracker-fixture.js';

const MANIFEST = `${head({ guard: TRACKER_GUARD })}
resources:
${PROJECT}${ticket({
  scope: true,
  update: PATCH_UPDATE,
  fields: ASSIGNEE_STATUS,
  extra: `    multi:
      - tool: tickets_delete
        args: { project: "{{?scope}}", title_prefix: "{{batch}}" }
        effect: deleted
        invalid_id: T-0
`,
})}`;

test('review 12: a multi-item delete is never called outside a container the tester created and confirmed; the bystanders are untouched', async () => {
  const f = await startFixture({ profile: 'tracker', opts: ['project-create-fails', 'default-missing-scope', 'delete-ignores-prefix'], manifest: MANIFEST, seed: seedBystanders });
  try {
    const r = await runFixture(f);
    assert.deepEqual(bystandersLeft(f.backend), BYSTANDERS, 'the tickets the tester did not create are untouched');
    assert.deepEqual(f.calls().filter((c) => c.tool === 'tickets_delete').map((c) => JSON.stringify(c.args)), [], 'the bulk delete was not called');
    for (const req of ['MWS-ATOM-1', 'MWS-ATOM-2']) {
      const rs = rows(r.doc.results, req, 'ticket:tickets_delete');
      assert.equal(rs.length, 1, show(rs));
      assert.equal(rs[0]!.verdict, 'not tested', show(rs));
      assert.match(rs[0]!.reason, /container/, show(rs));
    }
  } finally {
    await f.close();
  }
});
