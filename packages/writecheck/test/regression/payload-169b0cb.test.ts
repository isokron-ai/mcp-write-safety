/**
 * From the gate-2 re-run on 169b0cb (GATE2-RERUN-169b0cb.md, safety-169b0cb S5 and S6, Payload 2 and N3):
 *
 *   empty list   a read by id of a missing document answers the empty list's text ("Collection: tasks / Total: 0 documents")
 *                without isError: it is not the object (no false MWS-RES-1 violated, no phantom leftover)
 *   soft delete  the row is kept and marked trashed; the tool's read says not found. The declared control read still returns
 *                it: MWS-RES-1 on the delete is not held
 *   S6           a delete answered "Error: … not found" without isError deletes nothing: clean-up reads back and reports the
 *                objects still there as left, never as deleted
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { head, rows, runFixture, show, startFixture } from './harness.js';

const manifest = (control: boolean) => `${head({ guard: '{ tool: mwsv_guard, args: {}, path: tenant, pattern: "^mwsv-guard-task$" }' })}
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
${control ? `    control:
      base_env: SHAPE_URL
      read: { http: [GET, "/c/tasks/{{id}}"] }
` : ''}`;

test('a missing id answered with the empty list text is not the object: no false MWS-RES-1 violated, no phantom leftover', async () => {
  const f = await startFixture({ profile: 'payload', opts: ['guard', 'structured', 'missing-as-empty-list'], backend: { numericIds: true }, manifest: manifest(false) });
  try {
    const r = await runFixture(f);
    assert.equal(f.backend.all('tasks').length, 0, 'ground truth: every object the run created is gone');
    const res1 = rows(r.doc.results, 'MWS-RES-1', 'task:deleteTasks');
    assert.ok(res1.length === 1 && ['held', 'not tested'].includes(res1[0]!.verdict), show(res1));
    assert.deepEqual(r.doc.leftovers.map((l) => l.reason), []);
  } finally {
    await f.close();
  }
});

test('S5: a soft delete that the declared control read still returns is not MWS-RES-1 held', async () => {
  const f = await startFixture({ profile: 'payload', opts: ['guard', 'structured', 'soft-delete'], backend: { numericIds: true }, manifest: manifest(true) });
  try {
    const r = await runFixture(f);
    const res1 = rows(r.doc.results, 'MWS-RES-1', 'task:deleteTasks');
    assert.ok(res1.length === 1 && res1[0]!.verdict === 'not tested', show(res1));
    assert.match(res1[0]!.reason, /platform's API still returns it/);
  } finally {
    await f.close();
  }
});

test('S6: a delete answered "not found" without isError is not counted as done by clean-up', async () => {
  const f = await startFixture({ profile: 'payload', opts: ['guard', 'structured', 'delete-says-not-found'], backend: { numericIds: true }, manifest: manifest(false) });
  try {
    const r = await runFixture(f);
    const still = f.backend.all('tasks').map((t) => String(t['id']));
    assert.ok(still.length > 0, 'ground truth: the run left objects');
    const reported = r.doc.leftovers.map((l) => String(l.id));
    for (const id of still) assert.ok(reported.includes(id), `object ${id} is still on the backend and must be reported left (reported: ${reported.join(', ')})`);
    assert.ok(!(r.doc.cleanup?.deleted ?? []).some((d: { id: unknown }) => still.includes(String(d.id))), 'none of them is reported deleted');
  } finally {
    await f.close();
  }
});
