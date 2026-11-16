/**
 * payload/CLI-BUGS.md 1 (and grafana/CLI-BUGS.md 13): `run` refuses a server that has no tool with
 * `readOnlyHint: true`, so a server that omits every annotation cannot be tested at all.
 *
 * Validation row (payload, scratch/run2-native.txt, both commits):
 *   error: target.guard: findTasks does not declare readOnlyHint: true; the positive tenant check must be a read-only tool
 *   exit status 3
 * plugin-mcp 3.93.0 declares no annotation on any of its 12 tools (PAY-08).
 *
 * Deciding text. Spec MWS-ANN-4 (SHOULD): "A server SHOULD declare `readOnlyHint` explicitly on every
 * tool and `destructiveHint` explicitly on every write tool." Verdicts: "`violated` (a hint is missing)".
 * Spec NF-2: "A tool declares the cautious value of a hint, or omits a hint so that the cautious default
 * applies, although its behavior is safer than the hint says. […] Omission is reported only under
 * MWS-ANN-4." A missing hint is therefore a `violated (SHOULD)` row in the report, and the other
 * requirements still get their records; it is not a reason to give no report.
 *
 * The fixture: the Payload tool shapes with no annotation anywhere, results carrying structuredContent
 * (so that this test is about the guard alone), and the guard declared on the server's own read tool.
 * The resource is declared as in the validation manifest (payload/writecheck.yaml, resource `task`).
 *
 * Status: fails on 7562919 (the refusal above; the manifest key below does not exist there). Passes on
 * d3b536f: the owners fixed it in 4dfec32 with a manifest key, `target.guard.read_only: true`, which
 * declares that the guard tool of a server that annotates no tool only reads. The guard below carries the
 * key; without it d3b536f still refuses, and now names the key in the refusal. Kept, skipped, as the
 * regression test for that fix.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fixed, head, rows, runFixture, show, startFixture } from './harness.js';

const MANIFEST = `${head({ guard: '{ tool: findTasks, args: { id: 1 }, path: title, pattern: "^mwsv-guard-task$", read_only: true }' })}
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

test('payload/CLI-BUGS 1: a server with no readOnlyHint on any tool is run and reported, not refused', { skip: fixed('4dfec32', 'payload/CLI-BUGS.md 1') }, async () => {
  const f = await startFixture({ profile: 'payload', opts: ['structured'], backend: { numericIds: true }, manifest: MANIFEST, seed: (b) => b.seed('tasks', { id: 1, title: 'mwsv-guard-task', status: 'todo', owner: null, priority: null, archived: false, locale: null, draft: false }) });
  try {
    // On 7562919 this rejected with exit status 3 ("findTasks does not declare readOnlyHint: true") after the plan was confirmed.
    const r = await runFixture(f);
    assert.equal(r.doc.target.guard?.matched, 'mwsv-guard-task', 'the positive tenant check ran on the declared tool and matched');
    // The missing hints are a finding of their own (MWS-ANN-4, SHOULD), on every tool.
    for (const tool of ['findTasks', 'createTasks', 'updateTasks', 'deleteTasks']) {
      const ann4 = rows(r.doc.results, 'MWS-ANN-4', `(catalog):${tool}`);
      assert.deepEqual(ann4.map((x) => x.verdict), ['violated'], show(ann4));
    }
    // And the write path was tested: its checks are not all "not tested".
    const res1 = rows(r.doc.results, 'MWS-RES-1', 'task:updateTasks');
    assert.ok(res1.length > 0 && res1.every((x) => x.verdict !== 'not tested'), show(res1));
    assert.equal(f.backend.all('tasks').filter((d) => String(d['title']).startsWith('mwsc-')).length, 0, 'nothing of the run is left behind');
  } finally {
    await f.close();
  }
});
