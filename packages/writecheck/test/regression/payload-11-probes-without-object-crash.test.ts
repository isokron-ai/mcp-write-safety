/**
 * payload/CLI-BUGS.md 11 and grafana/CLI-BUGS.md 7: the schema probes crash on a resource that has no
 * update tool (so no object under test) when the read template carries `{{id}}` inside a longer string.
 *
 * Validation rows (payload, resource `listing-key`; 4 rows on e94270a, 7 on 66e40e2. grafana, resource
 * `folder`, read `grafana_api_request` with `endpoint: "/api/folders/{{id}}"`, both commits):
 *   | MWS-IN-1 | MUST | listing-key:createListings | not tested | | the check failed: template {{id}} inside a longer string is not a scalar; use {{json:id}} |
 * The same text for MWS-IN-2, -3, -4 (and -5, -6, -7 on 66e40e2). The rows are attributed to the create
 * tool, while the tool that would be probed is the read tool.
 *
 * Deciding text. Spec 8.1, `not tested`: "The test was not run, or its result cannot be used. The record
 * states the reason and what would be needed to run it." An internal template error is neither. Spec
 * MWS-IN-2, test method: "Make two calls that are otherwise valid"; a read with no object to name is not
 * such a call, so the probes are either sent from a valid base (an object created for them) or not
 * sent, with a record that says what is missing.
 *
 * The resource is the validation manifest's `listing-key`, on the fixture's one collection.
 *
 * Status: fails on 7562919; passes on d3b536f, fixed by the owners in 4dfec32. Kept, skipped, as the regression test for that fix.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fixed, head, runFixture, startFixture } from './harness.js';

const MANIFEST = `${head({ guard: '{ tool: mwsv_guard, args: {}, path: tenant, pattern: "^mwsv-guard-task$" }' })}
resources:
  - name: task-key
    create: { tool: createTasks, args: { title: "{{marker}}", status: doing, owner: ann, priority: 2 }, id: doc.id, name_path: title }
    read: { tool: findTasks, args: { where: '{"id":{"equals":{{id}}}}' }, items: docs, match: id, ignore: [updatedAt, createdAt] }
    delete: { tool: deleteTasks, args: { id: "{{id}}" } }
    cleanup: delete
`;

test('payload/CLI-BUGS 11, grafana/CLI-BUGS 7: schema probes on a resource with no update tool do not crash on the read template', { skip: fixed('4dfec32', 'payload/CLI-BUGS.md 11, grafana/CLI-BUGS.md 7') }, async () => {
  const f = await startFixture({ profile: 'payload', opts: ['guard', 'structured'], backend: { numericIds: true }, manifest: MANIFEST });
  try {
    const r = await runFixture(f);
    const crashed = r.doc.results.filter((x) => /the check failed|is not a scalar/.test(x.reason));
    assert.deepEqual(crashed.map((x) => `${x.requirement} ${x.write_path.resource}:${x.write_path.tool}: ${x.reason}`), [], 'no record carries an internal error as its reason');
    // Every probe call that was sent names an object: no read went out with the id missing from its where clause.
    const blind = f.calls().filter((c) => c.tool === 'findTasks' && typeof c.args['where'] === 'string' && /null|""|\{\{/.test(c.args['where']));
    assert.deepEqual(blind, [], 'no probe was sent from a base call that names no object');
    assert.equal(f.backend.all('tasks').filter((d) => String(d['title']).startsWith('mwsc-')).length, 0, 'nothing of the run is left behind');
  } finally {
    await f.close();
  }
});
