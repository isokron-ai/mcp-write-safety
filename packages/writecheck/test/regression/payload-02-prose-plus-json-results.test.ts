/**
 * payload/CLI-BUGS.md 2: a tool result that is prose followed by JSON cannot be read, no manifest
 * option helps, every check of the resource is `not tested`, and the object the run created is left
 * behind.
 *
 * Validation rows (payload, run 9e182e8fe9 on 66e40e2, manifest repro/writecheck.nostruct.yaml):
 *   setup.task.create   send: createTasks {"title":"mwsc-9e182e8fe9-main1","status":"doing","owner":"ann","priority":2}
 *                       recv: "Resource created successfully in collection \"tasks\"!\nCreated resource:\n```json\n{\"id\":3,…}\n```"
 *   …create.verify      send: findTasks {"id":3}
 *                       recv: "Resource from collection \"tasks\":\n{\"id\":3,\"title\":\"mwsc-9e182e8fe9-main1\",…}"
 *   | MWS-UPD-1 | MUST | task:updateTasks | not tested | | setup failed: could not create the object under test: the returned id 3 is not in the read result |
 *   1 object(s) left behind; search for mwsc-9e182e8fe9- (listed in the report)
 *
 * Deciding text. Spec section 4, "Result content": "The `content` array and `structuredContent` of a
 * tool result. Where a test method checks the content of a result or of an error for a value or a
 * statement, either place meets the check". Spec 7.1, black-box: the tester "calls tools, reads state
 * back through the server's own read tools, and compares". The object is in the read result; a result
 * that carries it in `content` only is still the result. Spec 7.3: "A tester MUST write only to
 * objects it created for the test": the object the run created must not be left behind because the
 * tester could not read its own read-back.
 *
 * The fixture: the Payload result shapes as captured, with no structuredContent, plus the one synthetic
 * guard tool the validation shim added. The manifest is the one of the validation run (id_regex for the
 * create id). If the fix is a new manifest option for reading such results, add it to MANIFEST here.
 *
 * Status: fails on 7562919; passes on d3b536f, fixed by the owners in 4dfec32. Kept, skipped, as the regression test for that fix.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fixed, head, rows, runFixture, show, startFixture } from './harness.js';

const MANIFEST = `${head({ guard: '{ tool: mwsv_guard, args: {}, path: tenant, pattern: "^mwsv-guard-task$" }' })}
resources:
  - name: task
    create: { tool: createTasks, args: { title: "{{marker}}", status: doing, owner: ann, priority: 2 }, id_regex: '"id":(\\d+)', name_path: title }
    read: { tool: findTasks, args: { id: "{{id}}" }, ignore: [updatedAt, createdAt] }
    update: { tool: updateTasks, mode: field_patch, args: { id: "{{id}}", "{{field}}": "{{value}}" } }
    fields:
      - { path: owner, values: [ann, bob] }
      - { path: status, values: [doing, done] }
    delete: { tool: deleteTasks, args: { id: "{{id}}" } }
    cleanup: delete
`;

test('payload/CLI-BUGS 2: results that are prose followed by JSON are read; the resource is tested and nothing is left behind', { skip: fixed('4dfec32', 'payload/CLI-BUGS.md 2') }, async () => {
  const f = await startFixture({ profile: 'payload', opts: ['guard'], backend: { numericIds: true }, manifest: MANIFEST });
  try {
    const r = await runFixture(f);
    const setupFailed = r.doc.results.filter((x) => /setup failed/.test(x.reason));
    assert.deepEqual(setupFailed.map((x) => `${x.requirement}: ${x.reason}`).slice(0, 3), [], 'the object the run created reads back through findTasks');
    // The write path has verdicts: for example the update of each declared field took effect and was reported truthfully.
    const res1 = rows(r.doc.results, 'MWS-RES-1', 'task:updateTasks');
    assert.ok(res1.length > 0 && res1.every((x) => x.verdict !== 'not tested'), show(res1));
    // why not r.doc.leftovers: with a read by id, a missing object answers "Error: Document with ID … not found" without
    // isError, which is payload/CLI-BUGS.md 7 (not pinned here); the backend itself is the ground truth.
    assert.equal(f.backend.all('tasks').filter((d) => String(d['title']).startsWith('mwsc-')).length, 0, 'the objects the run created are gone from the backend');
  } finally {
    await f.close();
  }
});
