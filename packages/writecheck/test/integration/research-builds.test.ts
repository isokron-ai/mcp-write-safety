/**
 * Research-build tool errors that need a whole run:
 *
 *   N4         a {{version}} in a delete template is the version just read in every check (the annotation checks too)
 *   set-up     a run in which every resource's set-up failed is `stopped` and exits 4, never `complete` with exit 0
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fakeManifest, runFake, startFake } from '../fake/harness.js';

test('N4: a delete that needs the version just read gets it in every check; clean-up completes', async () => {
  const f = await startFake({ pairs: 10, versionedDelete: true, defects: ['versioned-delete'] });
  try {
    const r = await runFake(f);
    const ann3 = r.doc.results.filter((x) => x.requirement === 'MWS-ANN-3' && x.write_path.tool === 'ticket_delete');
    assert.ok(ann3.length >= 1);
    for (const x of ann3) assert.doesNotMatch(x.reason, /first call did not succeed/, x.reason);
    const res1 = r.doc.results.filter((x) => x.requirement === 'MWS-RES-1' && x.write_path.tool === 'ticket_delete');
    for (const x of res1) assert.doesNotMatch(x.reason, /version/i, x.reason);
    assert.deepEqual(r.doc.cleanup?.failed ?? [], []);
    assert.equal(r.doc.run.status, 'complete', r.doc.run.stopped_reason ?? '');
    assert.equal(f.backend.tickets.size, 0, 'nothing left in the backend');
  } finally {
    await f.close();
  }
});

test('every resource\'s set-up failed: the run is stopped and exits 4', async () => {
  const text = fakeManifest({ pairs: 10 }).replaceAll('create: { tool: ticket_create, args: { title: "{{prefix}}', 'create: { tool: ticket_create, args: { bogus: 1, title: "{{prefix}}');
  assert.ok(text.includes('bogus: 1'));
  const f = await startFake({ pairs: 10, manifestText: text });
  try {
    const r = await runFake(f);
    assert.equal(r.doc.run.status, 'stopped', JSON.stringify(r.doc.run));
    assert.match(r.doc.run.stopped_reason ?? '', /set-up of every resource/);
    assert.equal(r.exit, 4);
  } finally {
    await f.close();
  }
});

// MWS-CONC-2 option A (owner's decision, 15 Nov 2026; spec R13-1): the stale write is staged
// through one connection and one credential, with the second writer's read before its change.
test('CONC-2 option A: a server keyed to the connection (and credential) gets no held; one checking the version in the call does', async () => {
  const keyed = await startFake({ pairs: 10, defects: ['connection-keyed'] });
  try {
    const r = await runFake(keyed);
    const c2 = r.doc.results.filter((x) => x.requirement === 'MWS-CONC-2' && x.write_path.tool === 'ticket_replace' && x.scenario.id === 'stale-write');
    assert.ok(c2.length >= 1);
    for (const x of c2) assert.notEqual(x.verdict, 'held', x.reason);
    assert.ok(c2.some((x) => x.verdict === 'violated'), c2.map((x) => `${x.verdict}: ${x.reason}`).join(' | '));
  } finally {
    await keyed.close();
  }
  const versioned = await startFake({ pairs: 10 });
  try {
    const r = await runFake(versioned);
    const c2 = r.doc.results.filter((x) => x.requirement === 'MWS-CONC-2' && x.write_path.tool === 'ticket_replace' && x.scenario.id === 'stale-write');
    assert.deepEqual(c2.map((x) => x.verdict), ['held'], c2.map((x) => x.reason).join(' | '));
  } finally {
    await versioned.close();
  }
});
