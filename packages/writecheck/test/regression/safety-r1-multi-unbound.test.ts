/**
 * Note 25, review v5 R1 (tester safety; also on 0295ed6): a multi-item delete whose arguments carry neither {{scope}}
 * nor {{ids}} was called three times after the run "confirmed" a container the tool is never told about; on a server that falls
 * back to its default project both bystanders were deleted, with no loss recorded. The fix refuses such a tool at manifest load:
 * the bulk delete is never called. Both reproducers (r1-none-multi-unbound, r1b-base-multi-unbound) are here.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { head, runFixture, startFixture, TRACKER_GUARD } from './harness.js';
import { BYSTANDERS, bystandersLeft, seedBystanders } from './safety-fixture.js';
import { ASSIGNEE_STATUS, PATCH_UPDATE, PROJECT, ticket } from './tracker-fixture.js';

const MULTI = `    multi:
      - tool: tickets_delete
        args: { title_prefix: "{{batch}}" }
        effect: deleted
        invalid_id: T-0
`;
const SELECTOR_NONE = `    selector:
      tool: tickets_delete
      container: none
      args: {}
      forms:
        - { name: omitted, args: {} }
`;
const manifest = (extra: string) => `${head({ guard: TRACKER_GUARD })}
resources:
${PROJECT}${ticket({ scope: true, update: PATCH_UPDATE, fields: ASSIGNEE_STATUS, extra })}`;

// r1-none-multi-unbound adds `selector.container: none`, a key of the reproducers' series not in this head; its multi-item part is r1b's.
void SELECTOR_NONE;
for (const [name, extra] of [['r1b-base-multi-unbound (an unbound multi-item delete)', MULTI]] as const) {
  test(`R1 ${name}: refused at load; the bulk delete is never called; no bystander is lost`, async () => {
    const f = await startFixture({ profile: 'tracker', opts: ['default-missing-scope', 'delete-ignores-prefix'], manifest: manifest(extra), seed: seedBystanders });
    try {
      await assert.rejects(runFixture(f), /must bind the objects the call acts on/);
      assert.deepEqual(f.calls().filter((c: { tool: string }) => c.tool === 'tickets_delete'), []);
      assert.deepEqual(bystandersLeft(f.backend), BYSTANDERS);
    } finally {
      await f.close();
    }
  });
}
