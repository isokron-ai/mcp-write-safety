/**
 * payload/CLI-BUGS-169b0cb.md P2 and P3 (old entries 7 and N3 of CLI-BUGS-d3b536f.md): what clean-up reports must match
 * what is on the backend, in both directions.
 *
 * P3: "N object(s) left behind" for objects that do not exist, and the next run on the same state folder is refused;
 * plain `cleanup` does not clear it. In every P3 run one of the entries is MWS-TGT-3's second create with the same key,
 * refused in text without isError ("The following field is invalid: sku") and so recorded with an unknown outcome, on a
 * resource (`listing-key`) that declares no list block. Another resource made by the same create tool (`listing`) has a
 * list block whose name field is the one the create fills. A list that answered without the object proves it does not
 * exist; the entry is closed and not counted as left behind.
 *
 * P2: a clean-up whose sweep list could not be read (its answer has no list at the declared `items`) reported "a sweep by
 * prefix … found no object" while 6 objects were left, 3 reported. An answer that is not a list is not "nothing is
 * there": the entry stays open and is reported as an unknown outcome, with the reason.
 */

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { openRuns, readLedger } from '../../src/core/ledger.js';
import { head, runFixture, startFixture } from './harness.js';

const GUARD = '{ tool: mwsv_guard, args: {}, path: tenant, pattern: "^mwsv-guard-task$" }';
const TASK = (o: { name: string; list?: string; id?: string }) => `  - name: ${o.name}
    create: { tool: createTasks, args: { title: "{{marker}}", status: doing, owner: ann, priority: 2 }, id: ${o.id ?? 'doc.id'}, name_path: title }
    read: { tool: findTasks, args: { id: "{{id}}" }, ignore: [updatedAt, createdAt] }
    update: { tool: updateTasks, mode: field_patch, args: { id: "{{id}}", "{{field}}": "{{value}}" } }
    fields:
      - { path: owner, values: [ann, bob] }
      - { path: status, values: [doing, done] }
    delete: { tool: deleteTasks, args: { id: "{{id}}" } }
${o.list ? `    list: ${o.list}\n` : ''}    cleanup: delete
`;
const KEYED = `  - name: task-key
    create: { tool: createTasks, args: { title: "{{key}}", status: doing, owner: ann }, id: doc.id, name_path: title }
    read: { tool: findTasks, args: { id: "{{id}}" }, ignore: [updatedAt, createdAt] }
    key: { arg: title, vary: { arg: owner, path: owner } }
    delete: { tool: deleteTasks, args: { id: "{{id}}" } }
    cleanup: delete
`;

test('payload/CLI-BUGS-169b0cb P3: a refused second create on a resource with no list block is closed by a list of the same create tool; nothing is reported left and the next run may start', async () => {
  const manifest = `${head({ guard: GUARD })}
resources:
${TASK({ name: 'task', list: '{ tool: findTasks, args: {}, items: docs, id: id, name: title }' })}${KEYED}`;
  const f = await startFixture({ profile: 'payload', opts: ['guard', 'structured', 'unique-title'], backend: { numericIds: true }, manifest });
  try {
    const r = await runFixture(f);
    assert.equal(f.backend.all('tasks').length, 0, 'ground truth: nothing of the run is on the backend');
    assert.deepEqual(r.doc.leftovers.map((l) => `${l.resource}: ${l.reason}`), [], 'no object is reported left behind');
    assert.deepEqual(openRuns(join(f.dir, 'state')).map((x) => x.run_id), [], 'the ledger has no open entry, so the next run is not refused');
  } finally {
    await f.close();
  }
});

test('payload/CLI-BUGS-169b0cb P2: a sweep whose answer is not a list says it could not look; the entries stay open and are reported', async () => {
  // The create answer carries no id at the declared path, so every create has an unknown outcome; the list block's `items`
  // is not in the answer (as `items: docs` was not in plugin-mcp's own answer).
  const manifest = `${head({ guard: GUARD })}
resources:
${TASK({ name: 'task', id: 'doc.nothere', list: '{ tool: findTasks, args: {}, items: documents, id: id, name: title }' })}`;
  const f = await startFixture({ profile: 'payload', opts: ['guard', 'structured'], backend: { numericIds: true }, manifest });
  try {
    const r = await runFixture(f);
    const onBackend = f.backend.all('tasks').length;
    assert.ok(onBackend > 0, 'ground truth: the run left objects');
    const runs = openRuns(join(f.dir, 'state'));
    assert.equal(runs.length, 1, 'the entries stay open');
    const ledger = readLedger(join(runs[0]!.dir, 'ledger.jsonl'));
    assert.ok(!ledger.some((e) => e.kind === 'abandoned' && /found no object/.test(e.reason)), 'an unreadable list is not "found no object"');
    assert.ok(r.doc.leftovers.length >= onBackend, `every object on the backend is reported (${onBackend} there, ${r.doc.leftovers.length} reported)`);
    assert.ok(r.doc.leftovers.some((l) => /could not (look|be read)|not a list/.test(l.reason)), r.doc.leftovers.map((l) => l.reason).join('\n'));
  } finally {
    await f.close();
  }
});
