/**
 * payload/CLI-BUGS.md 3: a false `violated` under MWS-IN-1. The find tools declare `id` as
 * `{"type": ["string", "number"]}`; the tester took the first member of the list ("string") and sent
 * the number 12345 as a value of another type.
 *
 * Validation row (payload, e94270a, four find tools; `fixed` on 66e40e2):
 *   | MWS-IN-1 | MUST | task:findTasks | violated | cases 29, accepted 1 | findTasks accepted 1 of 29 value(s) its schema does not allow: id=12345 (wrong_type). |
 * The server's answer was `Error: Document with ID "12345" not found in collection "tasks"`, as text
 * without isError.
 *
 * Deciding text. Spec MWS-IN-1, test method: "For each typed argument, send each probe in the list
 * below that is of another type than the schema declares. […] A probe is skipped where the schema
 * declares that type for the argument, for example `null` for an argument typed `["number", "null"]`."
 * A number is a declared type of `id`, so no number is sent for it, and no MWS-IN-1 record can rest
 * on one.
 *
 * Status: fails on e94270a; passes on 7562919 and on d3b536f, fixed by the owners in 66e75ce. Kept, skipped, as
 * the regression test for that fix.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fixed, head, rows, runFixture, show, startFixture } from './harness.js';

const MANIFEST = `${head({ guard: '{ tool: mwsv_guard, args: {}, path: tenant, pattern: "^mwsv-guard-task$" }' })}
resources:
  - name: task
    create: { tool: createTasks, args: { title: "{{marker}}", status: doing, owner: ann, priority: 2 }, id: doc.id, name_path: title }
    read: { tool: findTasks, args: { where: '{"id":{"equals":{{id}}}}' }, items: docs, match: id, ignore: [updatedAt, createdAt] }
    update: { tool: updateTasks, mode: field_patch, args: { id: "{{id}}", "{{field}}": "{{value}}" } }
    fields:
      - { path: owner, values: [ann, bob] }
      - { path: status, values: [doing, done] }
    delete: { tool: deleteTasks, args: { id: "{{id}}" } }
    cleanup: delete
`;

test('payload/CLI-BUGS 3: no number is sent as a wrong type for an argument typed ["string","number"]; MWS-IN-1 is not violated', { skip: fixed('66e75ce', 'payload/CLI-BUGS.md 3', 'e94270a') }, async () => {
  const f = await startFixture({ profile: 'payload', opts: ['guard', 'structured'], backend: { numericIds: true }, manifest: MANIFEST });
  try {
    const r = await runFixture(f);
    // The probe itself: the only numbers findTasks ever receives as `id` are ids of objects the run created.
    const created = new Set(f.backend.requests.filter((q) => q.method === 'POST' && q.path === '/c/tasks').map((_, i) => i + 1));
    const numericIds = f.calls().filter((c) => c.tool === 'findTasks' && typeof c.args['id'] === 'number' && !created.has(c.args['id']));
    assert.deepEqual(numericIds, [], 'no number was sent for `id` as a value of another type');
    for (const path of ['task:findTasks', 'task:updateTasks']) {
      const in1 = rows(r.doc.results, 'MWS-IN-1', path);
      // why: action dogfood SH-6 (spec R14-6): on the update tool a probe whose counterpart would write a value the base call does
      // not send (priority = 5) is not judged, so that record is not tested with that reason; neither is violated.
      assert.deepEqual(in1.map((x) => x.verdict), [path === 'task:updateTasks' ? 'not tested' : 'held'], show(in1));
      if (path === 'task:updateTasks') assert.match(in1[0]!.reason, /counterpart of the same meaning .* was not sent/, show(in1));
      assert.ok(!in1.some((x) => /\bid=/.test(x.reason)), show(in1));
    }
  } finally {
    await f.close();
  }
});
