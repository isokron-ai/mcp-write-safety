/**
 * Lane F9, independent review: each finding has a test here that fails on d363b67 and passes with its fix.
 *   F1  RES-3: a late failure that leaves an unnamed object is violated even where the first answer is an echo.
 *   F2  echo filter: bind placeholders, a request id in free text, and keyed ids of the call's own unit of work are not server data.
 *   F3  echo filter: the new id of a create is an echo only where the request holds it as the object's own id.
 *   F4  CFG-1: a list-form `valid` classes nothing, so it never makes a switch inverted.
 *   F5  CFG-1: recheck sets aside a version-1 start under a misspelling of a word that permits writes.
 *   F6  creates: records judged without kept arguments carry version 1 and its test_hash.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createsVerdicts } from '../../src/checks/creates.js';
import { requestHay, serverData } from '../../src/checks/echo.js';
import { cfg1Probe, launchVerdicts } from '../../src/checks/launch.js';
import type { CallBrief } from '../../src/checks/types.js';
import { parseManifestText } from '../../src/core/manifest.js';
import { testHash } from '../../src/report/testhash.js';
import { result } from '../../src/report/verdicts.js';

const M = (extra = '') =>
  parseManifestText(
    `mws: "0.9"
server: { stdio: [node, s.js] }
target: { environment: test, confirm: t }
resources:
  - name: ticket
    create: { tool: ticket_create, args: { title: "{{prefix}}t" }, id: id }
    read: { tool: ticket_get, args: { id: "{{id}}" }, object: ticket }
    update: { tool: ticket_update, mode: field_patch, args: { id: "{{id}}", "{{field}}": "{{value}}" } }
    fields: [ { path: assignee, values: [ann, bob] }, { path: status, values: [blocked, closed] } ]
    list: { tool: ticket_list, args: {}, items: tickets, id: id, name: title }
    cleanup: delete
    delete: { tool: ticket_delete, args: { id: "{{id}}" } }
${extra}`,
    'm.yaml',
  );
const call = (o: Partial<CallBrief> = {}): CallBrief => ({ step: 's', ok: true, isError: false, rpc_error: null, text: '', data: null, indeterminate: false, ...o });
const ctx = { manifest: M(), tools: [] };
const create = (o: object) => ({ name: 'ticket', tool: 'ticket_create', parent: null, first: call(), found: [], repeat: null, found_after_repeat: null, key: null, version: null, read_keys: null, late_failure: null, ...o });
const verdicts = (o: object) => createsVerdicts({ creates: [create(o)], update_receipt: null, failures: [], delete_case: null, jobs: [] } as never, ctx.manifest.resources[0]!, ctx);
const get = (rs: ReturnType<typeof verdicts>, id: string) => rs.find((r) => r.requirement === id)!;

test('F1: an echo-only first answer does not discard a late failure that left an unnamed object (RES-3 violated)', () => {
  const sent = { id: 'mwsc-ab-cr-1', title: 'mwsc-ab-cr-1 title' };
  const late = { mutating: 2, call: call({ ok: false, isError: true, text: 'internal error' }), found: ['mwsc-ab-crf-2'], sent_args: { id: 'mwsc-ab-crf-2', title: 'x' } };
  const r = get(verdicts({ sent_args: sent, first: call({ data: { ...sent } }), found: ['mwsc-ab-cr-1'], late_failure: late }), 'MWS-RES-3');
  assert.equal(r.verdict, 'violated', r.reason);
  assert.match(r.reason, /last backend write failed.*does not carry the identifier/);
  // with a late failure that names the object, the echo still leaves the record open
  const named = { ...late, call: call({ ok: false, isError: true, text: 'internal error; mwsc-ab-crf-2 was created' }) };
  assert.equal(get(verdicts({ sent_args: sent, first: call({ data: { ...sent } }), found: ['mwsc-ab-cr-1'], late_failure: named }), 'MWS-RES-3').verdict, 'not tested');
});

test('F2: placeholders, a request id in free text and keyed ids of the call are not server data', () => {
  const args = { id: 'mwsc-ab-cr-1', title: 'mwsc-ab-cr-1 title' };
  const hay = requestHay(args)!;
  const none = (c: Partial<CallBrief>, why: string) => assert.deepEqual(serverData(call(c), hay), [], why);
  none({ text: 'INSERT INTO tickets (id, title) VALUES ($1, $2) params: mwsc-ab-cr-1' }, 'numbered placeholders');
  none({ text: 'INSERT INTO tickets (id, title) VALUES (?1, ?2); UPDATE t SET a = :1' }, '?n and :n placeholders');
  none({ text: 'request 7f3a2c9e: executed create_ticket(id=mwsc-ab-cr-1)' }, 'a request id in free text');
  none({ text: 'job 4411 finished; request id 99 executed create_ticket(id=mwsc-ab-cr-1)' }, 'a job number, and an id of the request');
  none({ data: { query_id: 'q-77', job_id: 'j-9', execution_id: 'e-3', statement_id: 's-2', operation_id: 'op-5', task_id: 't-6', run_id: 'r-8', id: 'mwsc-ab-cr-1' } }, 'keyed ids of the call\'s own unit of work');
  // still server data
  assert.ok(serverData(call({ text: 'created mwsc-ab-cr-1 (rowid 42)' }), hay).length, 'an identifier word before the token');
  assert.ok(serverData(call({ text: 'saved T-907' }), hay).length, 'a write word before the token');
  assert.ok(serverData(call({ data: { task_id: 't-6' } }), hay, 3, ['task_id', 'title']).length, 'a key the object as read back has is its state');
  // the record: an echo beside such call facts is not tested, not held
  const r = get(verdicts({ sent_args: args, first: call({ text: 'request 7f3a2c9e: executed create_ticket(id=mwsc-ab-cr-1)', data: { query_id: 'q-77' } }), found: ['mwsc-ab-cr-1'] }), 'MWS-RES-3');
  assert.equal(r.verdict, 'not tested', r.reason);
});

test('F3: a new id that matches a non-id argument is the server\'s, not an echo (RES-3 and RES-4 held)', () => {
  const a = verdicts({ sent_args: { title: 'mwsc-ab-cr-1', priority: 1 }, marker: 'mwsc-ab-cr-1', first: call({ data: { id: 1, title: 'mwsc-ab-cr-1' } }), found: [1] });
  assert.equal(get(a, 'MWS-RES-3').verdict, 'held', get(a, 'MWS-RES-3').reason);
  assert.equal(get(a, 'MWS-RES-4').verdict, 'held', get(a, 'MWS-RES-4').reason);
  const b = verdicts({ sent_args: { ticket_id: 1, body: 'hello' }, first: call({ data: { id: 1, ticket_id: 1, body: 'hello' } }), found: [1] });
  assert.equal(get(b, 'MWS-RES-3').verdict, 'held', get(b, 'MWS-RES-3').reason);
  // still echoes: the id sent as the object's own id, one inside a statement sent, one that contains the marker
  assert.equal(get(verdicts({ sent_args: { id: 7, title: 'x' }, first: call({ data: { id: 7, title: 'x' } }), found: [7] }), 'MWS-RES-3').verdict, 'not tested');
  assert.equal(get(verdicts({ sent_args: { sql: 'INSERT INTO t (id) VALUES (7)' }, first: call({ text: 'INSERT INTO t (id) VALUES (7)' }), found: [7] }), 'MWS-RES-3').verdict, 'not tested');
  assert.equal(get(verdicts({ sent_args: { title: 'mwsc-ab-cr-1' }, marker: 'mwsc-ab-cr-1', first: call({ data: { slug: 'tickets/mwsc-ab-cr-1' } }), found: ['tickets/mwsc-ab-cr-1'] }), 'MWS-RES-3').verdict, 'not tested');
});

test('F4: a list-form valid (readonly, "true") keeps the normal probes; only the map form makes it inverted', () => {
  const list = cfg1Probe(M('settings: { read_only: { env: MODE, on: "readonly", valid: ["readonly", "true"] } }').settings.read_only!);
  assert.equal(list.polarity, 'normal', list.basis);
  assert.ok(!list.values.some((v) => ['FALSE', 'False', 'no', 'off', '0', 'disabled'].includes(v)), list.values.join(','));
  const map = cfg1Probe(M('settings: { read_only: { env: MODE, on: "readonly", valid: { readonly: restrict, "true": permit } } }').settings.read_only!);
  assert.equal(map.polarity, 'inverted');
});

test('F5: recheck sets aside a version-1 start under a misspelling of a word that permits writes', () => {
  const ro = M('settings: { read_only: { env: RO, on: "true", valid: ["false", "true"] } }').settings.read_only!;
  const p = cfg1Probe(ro);
  assert.ok(!p.values.includes('aflse') && p.permitTypo('aflse'), p.values.join(','));
  const base = { baseline: { started: true, reason: null }, cfg2: [], cfg3: null };
  const wrote = (value: string) => ({ value, started: true, reason: null, write: { ok: true, changed: true, step: 's1' }, tools: [{ tool: 'ticket_update', ok: true, effect: 'assignee', step: 's3' }] });
  const refused = (value: string) => ({ value, started: true, reason: null, write: { ok: false, changed: false, step: 's2' } });
  const r = launchVerdicts({ ...base, cfg1: { env: 'RO', starts: [wrote('aflse'), refused('yes'), refused('TRUE')] } } as never, ro)[0]!;
  assert.equal(r.verdict, 'held', r.reason);
  assert.ok(r.notes.some((n) => /^Not judged: .*RO="aflse".*misspelling of a value that permits writes/.test(n)), r.notes.join(' | '));
  // a misspelling this procedure sends is still judged
  assert.equal(launchVerdicts({ ...base, cfg1: { env: 'RO', starts: [wrote('rtue')] } } as never, ro)[0]!.verdict, 'violated');
});

test('F6: create records judged without kept arguments carry version 1, so a rechecked record keeps its test_hash', () => {
  const old = verdicts({ first: call({ data: { id: 'T-5' } }), found: ['T-5'] });
  for (const r of old.filter((x) => /^MWS-(RES-3|RES-4)$/.test(x.requirement))) assert.equal(r.scenario.version, '1', r.requirement);
  const now = verdicts({ sent_args: { title: 'x' }, first: call({ data: { id: 'T-5' } }), found: ['T-5'] });
  for (const r of now.filter((x) => /^MWS-(RES-3|RES-4)$/.test(x.requirement))) assert.equal(r.scenario.version, '2', r.requirement);
  const h = (version: string) => testHash(result('MWS-RES-3', { resource: 'ticket', tool: 'ticket_create', arm: 'mcp' }, { id: 'creates', version }, 'held', 'x'), { manifest: ctx.manifest, tools: [] });
  const rechecked = get(old, 'MWS-RES-3');
  assert.equal(testHash(rechecked, { manifest: ctx.manifest, tools: [] }), h('1'), 'the hash a version-1 run stamped');
  // an update receipt without kept arguments too
  const u = createsVerdicts({ creates: [], failures: [], delete_case: null, jobs: [], update_receipt: { id: 'T-1', call: call({ text: 'T-1 updated: assignee=bob, version 4' }), field: 'assignee', arg: 'assignee', value: 'bob', version: null, read_keys: null, changed: [{ path: 'assignee', after: 'bob' }] } } as never, ctx.manifest.resources[0]!, ctx).find((x) => x.requirement === 'MWS-RES-4')!;
  assert.equal(u.scenario.version, '1');
});
