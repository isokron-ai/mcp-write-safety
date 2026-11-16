/**
 * From the gate-2 re-run on 6b028ec (payload/CLI-BUGS-6b028ec.md P5; note 14 item 3): a resource with no list block whose
 * read is a list read with `{{id}}` inside a string (Payload's `where`, through the shim). The bystander inventory fell back to
 * the read tool as a list, rendered `{{id}}` with no id, and the template error failed the whole targeting check: MWS-TGT-3
 * `held` became `not tested`, with two rows that should not exist. A list read that needs an id is not a list of the
 * bystanders: the inventory says it could not list them and leaves the check alone.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { head, rows, runFixture, show, startFixture } from './harness.js';

const manifest = `${head({ guard: '{ tool: mwsv_guard, args: {}, path: tenant, pattern: "^mwsv-guard-task$" }' })}
resources:
  - name: task
    create: { tool: createTasks, args: { title: "{{marker}}", status: doing, owner: ann, priority: 2 }, id: doc.id, name_path: title }
    read: { tool: findTasks, args: { where: '{"id":{"equals":{{id}}}}' }, items: docs, match: id, ignore: [updatedAt, createdAt] }
    key: { arg: title, vary: { arg: owner, path: owner } }
    delete: { tool: deleteTasks, args: { id: "{{id}}" } }
    cleanup: delete
`;

test('P5: a list read that needs an id is not used as the inventory; MWS-TGT-3 keeps its verdict and says what was not listed', async () => {
  const f = await startFixture({ profile: 'payload', opts: ['guard', 'structured'], backend: { numericIds: true }, manifest });
  try {
    const r = await runFixture(f);
    const all = r.doc.results.filter((x) => /^MWS-TGT-/.test(x.requirement));
    assert.deepEqual(all.filter((x) => /template|check failed/.test(x.reason)).map((x) => x.reason), [], show(all));
    assert.deepEqual(rows(r.doc.results, 'MWS-TGT-1', 'task:createTasks'), [], 'no MWS-TGT-1 row for a resource without a scope');
    assert.deepEqual(rows(r.doc.results, 'MWS-TGT-2', 'task:createTasks'), [], 'no MWS-TGT-2 row');
    const t3 = rows(r.doc.results, 'MWS-TGT-3', 'task:createTasks');
    assert.equal(t3.length, 1, show(t3));
    assert.equal(t3[0]!.verdict, 'held', show(t3));
    assert.ok(t3[0]!.notes.some((n) => /needs an object's id/.test(n) && /could not all be listed/.test(n)), t3[0]!.notes.join('\n'));
  } finally {
    await f.close();
  }
});
