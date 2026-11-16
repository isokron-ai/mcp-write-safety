/**
 * Beside payload/CLI-BUGS.md 7 ("a refusal without isError is a success to every check": a false
 * leftover, and a next run blocked by it). This test pins a sibling case that the entry does not write
 * up and that no validation run shows, because the validation manifest reads through a list to avoid it
 * (payload/writecheck.yaml: "plugin-mcp answers a missing id with ordinary text (no isError), so only a
 * list read can show that an object is gone"). It was found with this folder's Payload fixture.
 *
 * What happens on 7562919, and still on d3b536f, with a read by id (the form of repro/writecheck.nostruct.yaml):
 *   deleteTasks {"id":4}  ->  "Document deleted successfully from collection \"tasks\"! …"
 *   findTasks {"id":4}    ->  "Error: Document with ID \"4\" not found in collection \"tasks\""   (no isError)
 * `parseStructured` reads that sentence as YAML, a mapping with the one key `Error`, and the tester takes
 * the mapping for the object:
 *   MWS-RES-1 | MUST | task:deleteTasks | violated | deleteTasks reported success and the object still reads back
 *   leftover: "the id now reads back as an object without this run's prefix …; it was not touched"
 * A false `violated` on a MUST, and a leftover that does not exist.
 *
 * Deciding text. Spec MWS-RES-1, verdicts: "`violated` (the result reports that the change was made, and
 * the state asked for is not in effect)". The state asked for is in effect: the object is gone, and the
 * read tool says so. Correct record: `held`; `not tested` where the tester will not decide from a result
 * that is neither the object nor an error. Never `violated`.
 *
 * The fixture gives results with structuredContent wherever the text carries JSON, as the validation shim
 * did; a not-found answer carries none.
 *
 * Status: fails on 7562919 and on d3b536f. Not skipped.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { head, rows, runFixture, show, startFixture } from './harness.js';

const MANIFEST = `${head({ guard: '{ tool: mwsv_guard, args: {}, path: tenant, pattern: "^mwsv-guard-task$" }' })}
resources:
  - name: task
    create: { tool: createTasks, args: { title: "{{marker}}", status: doing, owner: ann, priority: 2 }, id: doc.id, name_path: title }
    read: { tool: findTasks, args: { id: "{{id}}" }, ignore: [updatedAt, createdAt] }
    update: { tool: updateTasks, mode: field_patch, args: { id: "{{id}}", "{{field}}": "{{value}}" } }
    fields:
      - { path: owner, values: [ann, bob] }
      - { path: status, values: [doing, done] }
    delete: { tool: deleteTasks, args: { id: "{{id}}" } }
    cleanup: delete
`;

test('beside payload/CLI-BUGS 7: a not-found sentence without isError is not read as the object (no false MWS-RES-1 violated, no false leftover)', async () => {
  const f = await startFixture({ profile: 'payload', opts: ['guard', 'structured'], backend: { numericIds: true }, manifest: MANIFEST });
  try {
    const r = await runFixture(f);
    assert.equal(f.backend.all('tasks').length, 0, 'ground truth: every object the run created is gone from the backend');
    const res1 = rows(r.doc.results, 'MWS-RES-1', 'task:deleteTasks');
    assert.ok(res1.length === 1 && ['held', 'not tested'].includes(res1[0]!.verdict), `MWS-RES-1 on the delete must be held (or not tested), never violated:\n${show(res1)}`);
    assert.deepEqual(r.doc.leftovers.map((l) => l.reason), [], 'no leftover is reported for an object that does not exist');
  } finally {
    await f.close();
  }
});
