/**
 * Lane F9, end to end against the in-repo fake server:
 *   - MWS-CFG-1 on an inverted switch (TRACKER_ALLOW_WRITES, an allow-write flag whose restricting value is "false"): a correct
 *     server is held, not accused for the truthy values that permit writes on it; a server that only reads the exact "false"
 *     is violated on a falsy variant.
 *   - MWS-RES-4's echo filter: an update whose answer is its own arguments is not a receipt (not tested), where the same
 *     update answered with the stored ticket holds.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { writePathKey, type Result } from '../../src/report/verdicts.js';
import { fakeManifest, runFake, startFake } from '../fake/harness.js';

const INVERTED = `settings: { read_only: { env: TRACKER_ALLOW_WRITES, on: "false", valid: { "false": restrict, "true": permit } } }`;
const find = (rs: Result[], req: string, path: string) => rs.find((x) => x.requirement === req && writePathKey(x.write_path) === path);

test('CFG-1, inverted switch: a correct allow-write flag holds, and no value meaning "permit" is sent', async () => {
  const f = await startFake({ extra: INVERTED });
  try {
    const r = await runFake(f);
    const c1 = find(r.doc.results, 'MWS-CFG-1', '(server):TRACKER_ALLOW_WRITES')!;
    assert.equal(c1.verdict, 'held', `${c1.reason}\n${c1.notes.join('\n')}`);
    assert.ok(c1.notes.some((n) => /^Polarity: inverted/.test(n)), c1.notes.join('\n'));
    const tried = c1.notes.map((n) => /^TRACKER_ALLOW_WRITES=("[^"]*")/.exec(n)?.[1]).filter(Boolean).map((v) => JSON.parse(v!) as string);
    assert.deepEqual(tried, ['FALSE', 'False', 'no', 'off', '0', 'disabled', 'fasle']);
    for (const v of ['yes', 'on', '1', 'TRUE', 'enabled']) assert.ok(!tried.includes(v), `${v} permits writes on this switch and is not sent`);
    const obs = r.doc.observations.find((o) => o.check === 'launch-settings')!.data as { cfg1: { polarity: string } };
    assert.equal(obs.cfg1.polarity, 'inverted', 'the evidence records the polarity');
    assert.equal(find(r.doc.results, 'MWS-CFG-3', '(server):TRACKER_ALLOW_WRITES')!.verdict, 'held');
    assert.deepEqual(r.doc.leftovers, []);
  } finally {
    await f.close();
  }
});

test('CFG-1, inverted switch: a server that reads only the exact "false" is violated on a falsy variant', async () => {
  const f = await startFake({ extra: INVERTED, defects: ['allow-writes-exact'] });
  try {
    const r = await runFake(f);
    const c1 = find(r.doc.results, 'MWS-CFG-1', '(server):TRACKER_ALLOW_WRITES')!;
    assert.equal(c1.verdict, 'violated', `${c1.reason}\n${c1.notes.join('\n')}`);
    assert.match(c1.reason, /TRACKER_ALLOW_WRITES="FALSE"/);
    assert.ok(!/TRACKER_ALLOW_WRITES="(TRUE|yes|on|1)"/.test(c1.reason));
    assert.deepEqual(r.doc.leftovers, []);
  } finally {
    await f.close();
  }
});

test('RES-4 echo filter: an update answered with its own arguments is not a receipt; the stored ticket is', async () => {
  // why: without a declared version, the update's receipt is the identifier and the field set alone, both in the request. The
  // version still changes on every write, so it is a field that changes on its own here (read.ignore), as a timestamp is.
  const text = fakeManifest().replaceAll('    version: { read: version }\n', '').replaceAll('ignore: [updated_at]', 'ignore: [updated_at, version]');
  for (const [defects, want] of [[[], 'held'], [['echo-update'], 'not tested']] as const) {
    const f = await startFake({ manifestText: text, defects: [...defects] });
    try {
      const r = await runFake(f);
      const r4 = find(r.doc.results, 'MWS-RES-4', 'ticket:ticket_update')!;
      assert.equal(r4.verdict, want, `${defects.join(',') || 'correct'}: ${r4.reason}`);
      if (want === 'not tested') assert.match(r4.reason, /only as an echo of the request/);
      else assert.ok(r4.notes.some((n) => /^Echo filter/.test(n)), r4.notes.join('\n'));
      assert.deepEqual(r.doc.leftovers, []);
    } finally {
      await f.close();
    }
  }
});

test('list.consistency: an eventually consistent list finds the new object within the declared window (RES-3, RETRY-1)', async () => {
  // why: the create carries the run's marker in the name the list shows, so the object it made can be found by it.
  const lagging = fakeManifest().replace('args: { title: "{{prefix}}ticket" }', 'args: { title: "{{marker}}" }');
  assert.notEqual(lagging, fakeManifest());
  const settled = lagging.replace('list: { tool: ticket_list, args: { prefix: "{{prefix}}" }, items: items, id: id, name: title }', 'list: { tool: ticket_list, args: { prefix: "{{prefix}}" }, items: items, id: id, name: title, consistency: { settle_ms: 3000 } }');
  assert.notEqual(settled, lagging);
  for (const [text, want] of [[lagging, 'not tested'], [settled, 'held']] as const) {
    const f = await startFake({ manifestText: text, defects: ['list-lag'] });
    try {
      const r = await runFake(f);
      const r3 = find(r.doc.results, 'MWS-RES-3', 'ticket:ticket_create')!;
      assert.equal(r3.verdict, want, r3.reason);
      const retry1 = find(r.doc.results, 'MWS-RETRY-1', 'ticket:ticket_create');
      if (want === 'held') {
        assert.ok(r3.notes.some((n) => /list\.consistency/.test(n)), r3.notes.join('\n'));
        // the fake makes two tickets for two identical calls, and takes the declared key: RETRY-1 is decided, not skipped
        assert.equal(retry1?.verdict, 'held', retry1?.reason);
      } else assert.match(r3.reason, /0 objects carry the call's marker.*declare list\.consistency/);
    } finally {
      await f.close();
    }
  }
});
