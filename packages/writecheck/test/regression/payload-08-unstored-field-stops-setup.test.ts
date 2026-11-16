/**
 * payload/CLI-BUGS.md 8: a field that silently does not store makes the whole resource `not tested`.
 * The behaviour that stops the tester's setup (success reported, value not in effect) is the MWS-RES-1
 * violation itself, and it is reported as a setup failure with no requirement named.
 *
 * Validation rows (payload, resource `listing-market`, fields `locale` and `draft`; 15 rows on e94270a,
 * 18 on 66e40e2):
 *   setup: updateListings locale and draft to the baseline ("en-GB", true); findListings
 *   | MWS-RES-1 | MUST | listing-market:updateListings | not tested | | setup failed: the baseline values did not read back |
 * updateListings answers "Document updated successfully" and stores neither field (published PAY-04).
 *
 * Deciding text. Spec MWS-RES-1: "A write tool MUST report success only when the state the caller
 * asked for is in effect afterwards." Test method: "send calls that the server may be unable to carry
 * out as asked: […] an update of each field the declaration lists […]. After the settle interval that
 * the declaration states, read back and compare the state with what the call asked for." Verdicts:
 * "`violated` (the result reports that the change was made, and the state asked for is not in effect)".
 * The update of a declared field that reports success and is not in effect is that record.
 *
 * The fixture: the Payload tool shapes on one collection; `locale` and `draft` are stored fields that
 * are also the tool's own operation arguments, so the tool takes them for those and stores nothing.
 *
 * Status: fails on 7562919; passes on d3b536f, fixed by the owners in 4dfec32. Kept, skipped, as the regression test for that fix.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fixed, head, rows, runFixture, show, startFixture } from './harness.js';

const MANIFEST = `${head({ guard: '{ tool: mwsv_guard, args: {}, path: tenant, pattern: "^mwsv-guard-task$" }' })}
resources:
  - name: task-market
    create: { tool: createTasks, args: { title: "{{marker}}", status: doing, owner: ann, priority: 2 }, id: doc.id, name_path: title }
    read: { tool: findTasks, args: { where: '{"id":{"equals":{{id}}}}' }, items: docs, match: id, ignore: [updatedAt, createdAt] }
    update: { tool: updateTasks, mode: field_patch, args: { id: "{{id}}", "{{field}}": "{{value}}" } }
    fields:
      - { path: locale, values: [en-GB, de-DE] }
      - { path: draft, values: [true, false] }
    delete: { tool: deleteTasks, args: { id: "{{id}}" } }
    cleanup: delete
`;

test('payload/CLI-BUGS 8: an update that reports success and stores nothing is MWS-RES-1 violated, not "setup failed"', { skip: fixed('4dfec32', 'payload/CLI-BUGS.md 8') }, async () => {
  const f = await startFixture({ profile: 'payload', opts: ['guard', 'structured'], backend: { numericIds: true }, manifest: MANIFEST });
  try {
    const r = await runFixture(f);
    const res1 = rows(r.doc.results, 'MWS-RES-1', 'task-market:updateTasks');
    assert.ok(res1.some((x) => x.verdict === 'violated'), `MWS-RES-1 on task-market:updateTasks must be violated:\n${show(res1)}`);
    const setupFailed = r.doc.results.filter((x) => x.requirement === 'MWS-RES-1' && /setup failed/.test(x.reason));
    assert.deepEqual(setupFailed.map((x) => x.reason), [], 'the defect is not hidden behind a setup failure');
    assert.equal(f.backend.all('tasks').filter((d) => String(d['title']).startsWith('mwsc-')).length, 0, 'nothing of the run is left behind');
  } finally {
    await f.close();
  }
});
