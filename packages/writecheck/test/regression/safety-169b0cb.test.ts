/**
 * Tester safety, from the gate-2 re-run on 169b0cb (cases a1, d2, d3, b2, d1).
 *
 *   a1   the narrowed MWS-TGT-1 call is sent to a bulk delete that ignores its scope: MWS-TGT-1 violated on the selector tool,
 *        no empty-selector form sent, bystanders intact (test 0002 never sends this call: its manifest has no narrow)
 *   S1   the tool honours the scope with a selector and falls to the default project without one: the forms delete bystanders;
 *        MWS-TGT-2 is never held, and the loss is in the record and at the top of the report
 *   S1b  the same, but without a selector it runs in every project
 *   S2   the narrowed call itself is a bulk delete on a tool that ignores the scope and the narrowing: the loss is in the
 *        MWS-TGT-1 record (violated); and without the opt-in, no call reaches the selector tool at all
 *   S3   a narrow that can render empty is refused by the loader; one that names an argument the tool does not take is not sent
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { parseManifestText } from '../../src/core/manifest.js';
import { head, rows, runFixture, show, startFixture, TRACKER_GUARD } from './harness.js';
import { BYSTANDERS, bystandersLeft, dangerous } from './safety-fixture.js';
import { ASSIGNEE_STATUS, PATCH_UPDATE, PROJECT, ticket } from './tracker-fixture.js';
import type { ShapeBackend } from './backend.js';

const manifest = (o: { optIn: boolean; narrow?: string }) => `${head({ guard: TRACKER_GUARD })}
resources:
${PROJECT}${ticket({
  scope: true,
  update: PATCH_UPDATE,
  fields: ASSIGNEE_STATUS,
  extra: `    selector:
      tool: tickets_delete
      args: { project: "{{scope}}" }
      narrow: ${o.narrow ?? '{ title_prefix: "{{marker}}" }'}
${o.optIn ? '      send_empty_forms: true\n' : ''}      forms:
        - { name: omitted, args: {} }
        - { name: empty, args: { title_prefix: "" } }
`,
})}`;

/** B1, B2 in the default project; B4 in a project `ops` the tester did not create. */
const seed = (b: ShapeBackend): void => {
  for (const id of BYSTANDERS) b.seed('tickets', { id, scope: 'inbox', title: `customer ticket ${id}`, status: 'open', assignee: 'carol', priority: 2, note: null, paused: false, labels: [], meta: {} });
  b.seed('projects', { id: 'ops', key: 'ops', name: 'ops' });
  b.seed('tickets', { id: 'B4', scope: 'ops', title: 'customer ticket B4', status: 'open', assignee: 'carol', priority: 2, note: null, paused: false, labels: [], meta: {} });
};
const ALL = [...BYSTANDERS, 'B4'];
const left = (b: ShapeBackend) => b.all('tickets').filter((t) => ALL.includes(String(t['id']))).map((t) => String(t['id']));
const narrowedSent = (calls: { tool: string; args: Record<string, unknown> }[]) => calls.filter((c) => c.tool === 'tickets_delete' && typeof c.args['title_prefix'] === 'string' && (c.args['title_prefix'] as string).length > 0);
const lostOf = (r: { numbers: Record<string, unknown> }) => (Array.isArray(r.numbers['bystanders_lost']) ? (r.numbers['bystanders_lost'] as string[]) : []);

test('a1: the narrowed MWS-TGT-1 call reaches a scope-ignoring bulk delete, is violated, and no empty form follows', async () => {
  const f = await startFixture({ profile: 'tracker', opts: ['delete-ignores-scope', 'empty-selector-matches-all'], manifest: manifest({ optIn: true }), seed });
  try {
    const r = await runFixture(f);
    assert.ok(narrowedSent(f.calls() as never).length >= 1, 'the narrowed MWS-TGT-1 call was sent');
    assert.deepEqual(dangerous(f.calls()).filter((d) => d.call.tool === 'tickets_delete').map((d) => d.call.args), [], 'no empty-selector form was sent');
    assert.deepEqual(left(f.backend).sort(), [...ALL].sort(), 'bystanders intact');
    const t1 = rows(r.doc.results, 'MWS-TGT-1', 'ticket:tickets_delete');
    assert.equal(t1.length, 1, show(t1));
    assert.equal(t1[0]!.verdict, 'violated', show(t1));
    const t2 = rows(r.doc.results, 'MWS-TGT-2', 'ticket:tickets_delete');
    assert.equal(t2[0]?.verdict, 'not tested', show(t2));
  } finally {
    await f.close();
  }
});

for (const [name, opt, lost] of [['S1 (falls to the default project)', 'empty-falls-to-default', BYSTANDERS], ['S1b (runs in every project)', 'empty-all-projects', ALL]] as const) {
  test(`${name}: a form that deleted bystanders is never MWS-TGT-2 held, and every loss is in the record and the report`, async () => {
    const f = await startFixture({ profile: 'tracker', opts: ['empty-selector-matches-all', opt], manifest: manifest({ optIn: true }), seed });
    try {
      const r = await runFixture(f);
      const gone = ALL.filter((id) => !left(f.backend).includes(id));
      assert.deepEqual(gone.sort(), [...lost].sort(), 'ground truth: the fixture deleted these (the run opted in, on a disposable backend)');
      const t2 = rows(r.doc.results, 'MWS-TGT-2', 'ticket:tickets_delete');
      assert.equal(t2.length, 1, show(t2));
      assert.equal(t2[0]!.verdict, 'violated', show(t2));
      for (const id of lost) assert.ok(lostOf(t2[0]!).some((k) => k.includes(`"${id}"`)), `the record names ${id}: ${lostOf(t2[0]!).join(', ')}`);
      const md = readFileSync(join(r.outDir, 'report.md'), 'utf8');
      assert.ok(md.indexOf('Objects the tester did not create were changed or deleted') >= 0 && md.indexOf('Objects the tester did not create') < md.indexOf('## Violations'), 'the loss is at the top of report.md');
    } finally {
      await f.close();
    }
  });
}

test('S2: the narrowed call deletes bystanders on a tool that ignores scope and narrowing: in the MWS-TGT-1 record, violated; no form sent', async () => {
  const f = await startFixture({ profile: 'tracker', opts: ['delete-ignores-scope', 'delete-ignores-prefix', 'empty-selector-matches-all'], manifest: manifest({ optIn: true }), seed });
  try {
    const r = await runFixture(f);
    const t1 = rows(r.doc.results, 'MWS-TGT-1', 'ticket:tickets_delete');
    assert.equal(t1[0]?.verdict, 'violated', show(t1));
    for (const id of BYSTANDERS) assert.ok(lostOf(t1[0]!).some((k) => k.includes(`"${id}"`)), `the record names ${id}`);
    assert.equal(f.calls().filter((c) => c.tool === 'tickets_delete').length, 1, 'only the narrowed call reached the tool');
  } finally {
    await f.close();
  }
});

test('S2, default: without send_empty_forms no call reaches the selector tool, and MWS-TGT-2 is not tested with the reason', async () => {
  const f = await startFixture({ profile: 'tracker', opts: ['delete-ignores-scope', 'delete-ignores-prefix', 'empty-selector-matches-all'], manifest: manifest({ optIn: false }), seed });
  try {
    const r = await runFixture(f);
    assert.equal(f.calls().filter((c) => c.tool === 'tickets_delete').length, 0);
    assert.deepEqual(left(f.backend).sort(), [...ALL].sort());
    const t2 = rows(r.doc.results, 'MWS-TGT-2', 'ticket:tickets_delete');
    assert.equal(t2[0]?.verdict, 'not tested', show(t2));
    assert.match(t2[0]!.reason, /destructive by design/);
  } finally {
    await f.close();
  }
});

test('S3: a narrow that can render empty is refused; one naming an argument the tool does not take is not sent', async () => {
  assert.throws(() => parseManifestText(manifest({ optIn: true, narrow: '{ title_prefix: "", note: "{{marker}}" }'}), 'm.yaml'), /narrow/);
  const f = await startFixture({ profile: 'tracker', opts: ['delete-ignores-scope', 'empty-selector-matches-all'], manifest: manifest({ optIn: true, narrow: '{ note: "{{marker}}" }' }), seed });
  try {
    const r = await runFixture(f);
    assert.equal(f.calls().filter((c) => c.tool === 'tickets_delete').length, 0, 'no call to the selector tool');
    const t1 = rows(r.doc.results, 'MWS-TGT-1', 'ticket:tickets_delete');
    assert.equal(t1[0]?.verdict, 'not tested', show(t1));
    assert.match(t1[0]!.reason, /does not declare the argument note/);
  } finally {
    await f.close();
  }
});
