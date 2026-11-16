/**
 * 15 Nov (spec 7.3 rule 11): MWS-IN-2 decided "not used" from the tester's built-in word list. What a result says
 * is decided by a pattern the declaration gives, or by a person's reading. A notice worded outside the default pattern must
 * not give a false MUST `violated`: the record is `not tested`, quoting the text; with a declared pattern that matches, `held`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { head, rows, runFixture, show, startFixture, TRACKER_GUARD } from './harness.js';
import { ASSIGNEE_STATUS, PATCH_UPDATE, ticket } from './tracker-fixture.js';

const manifest = (patterns: string) => `${head({ guard: TRACKER_GUARD })}
${patterns}resources:
${ticket({ update: PATCH_UPDATE, fields: ASSIGNEE_STATUS })}`;

test('an IN-2 notice worded outside the default pattern is not tested, with the text quoted, never violated', async () => {
  const f = await startFixture({ profile: 'tracker', opts: ['odd-notice'], manifest: manifest('') });
  try {
    const r = await runFixture(f);
    const in2 = rows(r.doc.results, 'MWS-IN-2', 'ticket:ticket_update');
    assert.equal(in2.length, 1, show(in2));
    assert.equal(in2[0]!.verdict, 'not tested', show(in2));
    assert.match(in2[0]!.reason, /disregards/);
  } finally {
    await f.close();
  }
});

test('with a declared not_used pattern that matches the notice, MWS-IN-2 is held', async () => {
  const f = await startFixture({ profile: 'tracker', opts: ['odd-notice'], manifest: manifest('patterns: { not_used: "disregards" }\n') });
  try {
    const r = await runFixture(f);
    const in2 = rows(r.doc.results, 'MWS-IN-2', 'ticket:ticket_update');
    assert.equal(in2[0]?.verdict, 'held', show(in2));
  } finally {
    await f.close();
  }
});

test('a drop without a word is still MWS-IN-2 violated', async () => {
  const f = await startFixture({ profile: 'tracker', opts: ['drop-unknown-args'], manifest: manifest('') });
  try {
    const r = await runFixture(f);
    const in2 = rows(r.doc.results, 'MWS-IN-2', 'ticket:ticket_update');
    assert.equal(in2[0]?.verdict, 'violated', show(in2));
  } finally {
    await f.close();
  }
});
