/**
 * Re-review of 3ccc803..eddcc14, item 1 (tester safety): with the container created and confirmed, a multi-item delete that
 * names its container by a scope argument still deleted bystanders when the server ignores that argument.
 *
 * Deciding text. Spec 7.3, rule 1: where the container is named to a deleting tool by a scope argument, its test "MUST NOT
 * be run unless MWS-TGT-1 has been run for that tool with the verdict held".
 *
 * The fixture: projects can be created; the bulk delete ignores its project (`delete-ignores-scope`, so it runs in the
 * default project, which holds two bystander tickets) and its prefix (`delete-ignores-prefix`). No selector is declared, so
 * no MWS-TGT-1 is run for tickets_delete. Before the fix both bystanders were deleted; now the multi-item delete is not
 * called and MWS-ATOM-1 and MWS-ATOM-2 are `not tested`, naming MWS-TGT-1.
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
        args: { project: "{{scope}}", title_prefix: "{{batch}}" }
        effect: deleted
        invalid_id: T-0
`,
})}`;

test('re-review 1: a multi-item delete named by a scope argument is called only where MWS-TGT-1 is held for it; the bystanders are untouched', async () => {
  const f = await startFixture({ profile: 'tracker', opts: ['delete-ignores-scope', 'delete-ignores-prefix'], manifest: MANIFEST, seed: seedBystanders });
  try {
    const r = await runFixture(f);
    assert.deepEqual(bystandersLeft(f.backend), BYSTANDERS, 'the tickets the tester did not create are untouched');
    assert.deepEqual(f.calls().filter((c) => c.tool === 'tickets_delete').map((c) => JSON.stringify(c.args)), [], 'the bulk delete was not called');
    for (const req of ['MWS-ATOM-1', 'MWS-ATOM-2']) {
      const rs = rows(r.doc.results, req, 'ticket:tickets_delete');
      assert.equal(rs.length, 1, show(rs));
      assert.equal(rs[0]!.verdict, 'not tested', show(rs));
      assert.match(rs[0]!.reason, /MWS-TGT-1/, show(rs));
    }
  } finally {
    await f.close();
  }
});
