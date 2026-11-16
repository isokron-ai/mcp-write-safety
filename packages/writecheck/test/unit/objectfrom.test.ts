/**
 * What a read by id answered (gate-2 re-runs on 169b0cb and 6b028ec, note 14 item 1): an answer that echoes the id is the
 * object; one that does not is the object only where it carries a declared field and is not an error body or a sentence
 * that says nothing was found. Payload's empty-list text is not the object; Grafana's v2 dashboard (no uid in it) is.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { objectFrom } from '../../src/core/driver.js';
import { parseManifestText } from '../../src/core/manifest.js';
import { parseStructured } from '../../src/core/util.js';

const res = parseManifestText(
  `mws: "0.9"
server: { stdio: [node, s.js] }
target: { environment: test, confirm: t }
resources:
  - name: ticket
    create: { tool: t_create, args: { title: "{{marker}}" }, id: id, name_path: title }
    read: { tool: t_get, args: { id: "{{id}}" }, object: ticket }
    update: { tool: t_update, mode: field_patch, args: { id: "{{id}}", "{{field}}": "{{value}}" } }
    fields:
      - { path: assignee, values: [ann, bob] }
      - { path: status, values: [open, closed] }
`,
  'm.yaml',
).resources[0]!;

test('an answer that echoes the id is the object', () => {
  assert.deepEqual(objectFrom(res, { ticket: { id: 'T1', title: 'x' } }, 'T1'), { id: 'T1', title: 'x' });
});

test('G13: an answer without the id that carries declared fields is the object (and a count of 0 inside it does not matter)', () => {
  const t = { title: 'mwsc-x', assignee: 'ann', status: 'open', watchers: { count: 0 } };
  assert.deepEqual(objectFrom(res, { ticket: t }, 'T1'), t);
});

test('Payload 2: the empty-list text is not the object; an empty list or a count is not either', () => {
  const data = parseStructured('Collection: "tickets"\nTotal: 0 documents\nPage: 1 of 1');
  assert.equal(objectFrom({ ...res, read: { ...res.read, object: '$' } }, data, 'T1'), null);
  assert.equal(objectFrom({ ...res, read: { ...res.read, object: '$' } }, { docs: [], totalDocs: 0 }, 'T1'), null);
  assert.equal(objectFrom(res, { ticket: null }, 'T1'), null);
});

test('an error body without isError is not the object, even where it carries a declared field name', () => {
  assert.equal(objectFrom({ ...res, read: { ...res.read, object: '$' } }, { error: 'not found', status: 404 }, 'T1'), null);
  assert.equal(objectFrom({ ...res, read: { ...res.read, object: '$' } }, { message: 'Ticket does not exist', status: 'gone' }, 'T1'), null);
});

test('a data field that happens to say "not found" does not make an object without the id disappear', () => {
  const t = { title: 'Login page not found', assignee: 'ann', status: 'open' };
  assert.deepEqual(objectFrom(res, { ticket: t }, 'T1'), t);
});

test('review: a skeleton or an error body worded otherwise is not the object either', () => {
  const top = { ...res, read: { ...res.read, object: '$' } };
  assert.equal(objectFrom(top, { title: '', status: 0, assignee: '' }, 'T1'), null);
  assert.equal(objectFrom(top, { name: 'NotFound', status: 'open', message: 'Ticket T1 could not be found' }, 'T1'), null);
  assert.equal(objectFrom(top, { status: 'error', message: 'No ticket with id T1' }, 'T1'), null);
});
