/**
 * Batch-run finding: MWS-ANN-1 showed a read-only-marked tool changing the object (a query tool whose list of stages can
 * write), and MWS-CFG-3 never called it in read-only mode, because the read-only check called only the declared write tools.
 * The spec: "In read-only mode a server MUST refuse every call to a write tool, whatever that tool's annotations declare."
 * The fixture's read-only mode is decided by the annotation (every tool not marked readOnlyHint: true is refused), so a
 * read-only-marked tool that writes slips through it. The tool's `calls` entry names the object as {{object.id}}, not {{id}}.
 *   query-writes  the stage is written: MWS-CFG-3 is violated, through ticket_query, and the record says it is marked read-only
 *   (read only)   the stage is ignored: the tool's successful answer with no change does not keep MWS-CFG-3 from held
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { head, runFixture, show, startFixture, TRACKER_GUARD } from './harness.js';
import { ASSIGNEE_STATUS, PATCH_UPDATE, ticket } from './tracker-fixture.js';

const withCalls = (calls: string) => `${head({ guard: TRACKER_GUARD }).replace('SHAPE_CALL_LOG]', 'SHAPE_CALL_LOG, SHAPE_READ_ONLY]')}settings:
  read_only: { env: SHAPE_READ_ONLY, on: "true", valid: { "true": restrict, "false": permit } }
calls:
${calls}resources:
${ticket({ update: PATCH_UPDATE, fields: ASSIGNEE_STATUS })}`;

const manifest = `${head({ guard: TRACKER_GUARD }).replace('SHAPE_CALL_LOG]', 'SHAPE_CALL_LOG, SHAPE_READ_ONLY]')}settings:
  read_only: { env: SHAPE_READ_ONLY, on: "true", valid: { "true": restrict, "false": permit } }
calls:
  ticket_query: { resource: ticket, args: { id: "{{object.id}}", stages: [ { set: { status: closed } } ] } }
resources:
${ticket({ update: PATCH_UPDATE, fields: ASSIGNEE_STATUS })}`;

const cfg3 = (rs: { requirement: string }[]) => rs.filter((r) => r.requirement === 'MWS-CFG-3') as never as { verdict: string; reason: string; notes: string[] }[];

test('CFG-3: a read-only-marked tool with a calls entry that writes in read-only mode is called there and gives violated', async () => {
  const f = await startFixture({ profile: 'tracker', opts: ['ro-by-annotation', 'query-tool', 'query-writes'], manifest });
  try {
    const r = await runFixture(f);
    const rows = cfg3(r.doc.results);
    assert.equal(rows.length, 1, show(r.doc.results.filter((x) => x.requirement === 'MWS-CFG-3')));
    assert.equal(rows[0]!.verdict, 'violated', rows[0]!.reason);
    assert.match(rows[0]!.reason, /ticket_query \(marked read-only: annotated readOnlyHint: true\) still wrote \(status\)/);
    assert.ok(rows[0]!.notes.some((n) => /^ticket_update: listed; refused/.test(n)), rows[0]!.notes.join(' | '));
    // The annotation check sees the same tool write.
    assert.ok(r.doc.results.some((x) => x.requirement === 'MWS-ANN-1' && x.write_path.tool === 'ticket_query' && x.verdict === 'violated'));
    assert.ok(f.calls().some((c) => c.tool === 'ticket_query' && (c.args['stages'] as unknown[]).length === 1));
  } finally {
    await f.close();
  }
});

test('CFG-3: a read-only-marked tool with a calls entry that changes nothing is called and leaves CFG-3 held', async () => {
  const f = await startFixture({ profile: 'tracker', opts: ['ro-by-annotation', 'query-tool'], manifest });
  try {
    const r = await runFixture(f);
    const rows = cfg3(r.doc.results);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.verdict, 'held', rows[0]!.reason);
    assert.match(rows[0]!.reason, /\(ticket_query\) was called as well, with no change to the watched object/);
    assert.ok(rows[0]!.notes.some((n) => /^ticket_query \(marked read-only: annotated readOnlyHint: true\): listed; answered as a success; no change on read-back$/.test(n)), rows[0]!.notes.join(' | '));
    assert.deepEqual(r.doc.leftovers, []);
  } finally {
    await f.close();
  }
});

// Review of PR #9, item 3: an object removed in read-only mode is a write, through the calls path too.
test('CFG-3: a read-only-marked tool that deletes its object in read-only mode gives violated', async () => {
  const f = await startFixture({ profile: 'tracker', opts: ['ro-by-annotation', 'query-tool', 'query-writes'], manifest: withCalls('  ticket_query: { resource: ticket, args: { id: "{{object.id}}", stages: [ { delete: true } ] } }\n') });
  try {
    const r = await runFixture(f);
    const rows = cfg3(r.doc.results);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.verdict, 'violated', rows[0]!.reason);
    assert.match(rows[0]!.reason, /ticket_query \(marked read-only: annotated readOnlyHint: true\) still wrote \(\(the object was deleted\)\)/);
  } finally {
    await f.close();
  }
});

test('CFG-3: a declared calls tool that deletes its object in read-only mode and answers isError gives violated, not held', async () => {
  const f = await startFixture({ profile: 'tracker', opts: ['ro-by-annotation', 'archive-tool', 'archive-ignores-ro'], manifest: withCalls('  ticket_archive: { resource: ticket, args: { id: "{{id}}" } }\n') });
  try {
    const r = await runFixture(f);
    const rows = cfg3(r.doc.results);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.verdict, 'violated', rows[0]!.reason);
    assert.match(rows[0]!.reason, /ticket_archive still wrote \(\(the object was deleted\)\)/);
  } finally {
    await f.close();
  }
});

// Review of PR #9, item 2: a read-only-marked tool with a calls entry is never passed over in silence.
test('CFG-3: a read-only-marked tool whose calls entry cannot be bound gets a "not called" record, and CFG-3 is not held', async () => {
  const f = await startFixture({ profile: 'tracker', opts: ['ro-by-annotation', 'query-tool'], manifest: withCalls('  ticket_query: { resource: nosuch, args: { id: "{{object.id}}" } }\n') });
  try {
    const r = await runFixture(f);
    const rows = cfg3(r.doc.results);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.verdict, 'not tested', rows[0]!.reason);
    assert.match(rows[0]!.reason, /ticket_query: not called: calls\.ticket_query is bound to "nosuch", which is not a resource of the manifest/);
  } finally {
    await f.close();
  }
});
