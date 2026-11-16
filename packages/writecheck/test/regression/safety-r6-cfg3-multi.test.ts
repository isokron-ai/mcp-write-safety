/**
 * Note 27 (review v6, R6): the CFG-3 read-only check and the CFG-2 deny filters called every multi-item tool with its
 * declared arguments, outside the gates of the multi-item check; on the R1 setup with a read-only setting the server ignores,
 * the bulk delete was sent 8 times and both bystanders were deleted. One gate (multiGate) now serves every caller.
 *   unbound   the reproducer as given: refused at manifest load (note 25, R1), so never sent on any path
 *   scope     the same delete bound by {{scope}}, MWS-TGT-1 not held: not sent by the launch check, and its CFG-3 record says so
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { head, runFixture, startFixture, TRACKER_GUARD } from './harness.js';
import { BYSTANDERS, bystandersLeft, seedBystanders } from './safety-fixture.js';
import { ASSIGNEE_STATUS, PATCH_UPDATE, PROJECT, ticket } from './tracker-fixture.js';

const manifest = (args: string) => `${head({ guard: TRACKER_GUARD }).replace('SHAPE_CALL_LOG]', 'SHAPE_CALL_LOG, SHAPE_READ_ONLY]')}settings:
  read_only: { env: SHAPE_READ_ONLY, on: "true", valid: { "true": restrict, "false": permit } }
resources:
${PROJECT}${ticket({
  scope: true,
  update: PATCH_UPDATE,
  fields: ASSIGNEE_STATUS,
  // the reproducer's selector.container: none is a key of the reproducers' series, not of this head; the multi-item part is kept
  extra: `    multi:
      - tool: tickets_delete
        args: ${args}
        effect: deleted
        invalid_id: T-0
`,
})}`;
const OPTS = ['default-missing-scope', 'delete-ignores-prefix'];

test('R6 unbound: the reproducer is refused at load; the bulk delete is never sent', async () => {
  const f = await startFixture({ profile: 'tracker', opts: OPTS, manifest: manifest('{ title_prefix: "{{batch}}" }'), seed: seedBystanders });
  try {
    await assert.rejects(runFixture(f), /must bind the objects the call acts on/);
    assert.deepEqual(f.calls().filter((c: { tool: string }) => c.tool === 'tickets_delete'), []);
    assert.deepEqual(bystandersLeft(f.backend), BYSTANDERS);
  } finally {
    await f.close();
  }
});

test('R6 scope-bound: without MWS-TGT-1 held the launch check does not send the bulk delete, and the CFG-3 record says it was not called', async () => {
  const f = await startFixture({ profile: 'tracker', opts: OPTS, manifest: manifest('{ project: "{{scope}}", title_prefix: "{{batch}}" }'), seed: seedBystanders });
  try {
    const r = await runFixture(f);
    assert.deepEqual(f.calls().filter((c: { tool: string }) => c.tool === 'tickets_delete'), [], 'not sent on any path');
    assert.deepEqual(bystandersLeft(f.backend), BYSTANDERS);
    const cfg = r.doc.results.filter((x: { requirement: string }) => x.requirement === 'MWS-CFG-3' || x.requirement === 'MWS-CFG-1');
    assert.ok(cfg.some((x: { reason: string; notes: string[] }) => /tickets_delete not called/.test(`${x.reason} ${x.notes.join(' ')}`)), JSON.stringify(cfg.map((x: { reason: string }) => x.reason)).slice(0, 600));
  } finally {
    await f.close();
  }
});

// Series v7 BL-4 (review-v7 r10): every placeholder form for the container binds the tool to it; the gate reads the template's own
// parsed roots, so none of them bypasses it.
for (const [id, project] of [['R10a', '{{scope}}'], ['R10b', '{{ ?scope }}'], ['R10c', '{{json:scope}}'], ['R10d (path form)', '{{scope.id}}'], ['R10e (literal under the scope key)', 'inbox']] as const) {
  test(`${id}: a scope-bound multi-item delete without MWS-TGT-1 held is never sent, on any path`, async () => {
    const m = manifest(`{ project: ${JSON.stringify(project)}, title_prefix: "{{batch}}" }`).replace('scope: true', 'scope: true');
    const f = await startFixture({ profile: 'tracker', opts: ['delete-ignores-scope', 'delete-ignores-prefix'], manifest: m, seed: seedBystanders });
    try {
      let threw = false;
      await runFixture(f).catch(() => (threw = true));
      assert.deepEqual(f.calls().filter((c: { tool: string }) => c.tool === 'tickets_delete'), [], `${id}: not sent (refused at load: ${threw})`);
      assert.deepEqual(bystandersLeft(f.backend), BYSTANDERS);
    } finally {
      await f.close();
    }
  });
}
