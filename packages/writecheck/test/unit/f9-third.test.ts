/**
 * Lane F9, third review. The echo filter fails toward `not tested` where it is unsure, never toward `held`. Each test fails
 * on 1fdfc29 and passes with its fix (F4 and F5 change no behaviour: see their tests).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createsVerdicts } from '../../src/checks/creates.js';
import { createdIdEcho, requestHay, serverData } from '../../src/checks/echo.js';
import type { CallBrief } from '../../src/checks/types.js';
import { parseManifestText } from '../../src/core/manifest.js';

const M = () =>
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
`,
    'm.yaml',
  );
const call = (o: Partial<CallBrief> = {}): CallBrief => ({ step: 's', ok: true, isError: false, rpc_error: null, text: '', data: null, indeterminate: false, ...o });
const ctx = { manifest: M(), tools: [] };
const res = ctx.manifest.resources[0]!;
const updateR4 = (text: string) =>
  createsVerdicts({ creates: [], failures: [], delete_case: null, jobs: [], update_receipt: { id: 'T-1', call: call({ text }), field: 'assignee', arg: 'assignee', value: 'bob', version: null, read_keys: null, changed: [{ path: 'assignee', after: 'bob' }], sent_args: { id: 'T-1', assignee: 'bob' } } } as never, res, ctx).find((x) => x.requirement === 'MWS-RES-4')!;
const createR3 = (sent: unknown, first: CallBrief, found: unknown, marker = 'mkZZ') =>
  createsVerdicts({ creates: [{ name: 'ticket', tool: 'ticket_create', parent: null, first, sent_args: sent, marker, found: [found], repeat: null, found_after_repeat: null, key: null, version: null, read_keys: null, late_failure: null }], update_receipt: null, failures: [], delete_case: null, jobs: [] } as never, res, ctx).find((x) => x.requirement === 'MWS-RES-3')!;

test('third review F1: a strict call word right before the token vetoes it, even beside a write word', () => {
  const hay = requestHay({ id: 'T-1', assignee: 'bob' })!;
  for (const text of ['Created. request_id: 8f2c91ab', 'Inserted; request id 99', 'Updated (job 4411)', 'Saved via session 77', 'Updated, query 9912', 'INSERT INTO t VALUES (1) -- updated by pid 4242']) assert.deepEqual(serverData(call({ text }), hay), [], text);
  // resource nouns still do not veto
  for (const text of ['Saved user 42 (version 8)', 'Updated task 42, rev 8', 'Updated run 42: version 8']) assert.ok(serverData(call({ text }), hay).length, text);
  for (const text of ['UPDATE tickets SET assignee = bob WHERE id = T-1; updated, request_id 8f2c91ab', 'T-1 assignee bob updated (job 4411)']) {
    const r = updateR4(text);
    assert.equal(r.verdict, 'not tested', `${text}: ${r.reason}`);
  }
});

test('third review F2: an id wrapped by the arguments (input, data, the resource\'s name) is an echo', () => {
  const r = createR3({ input: { id: 'rec-7', title: 'x' } }, call({ data: { id: 'rec-7', title: 'x' } }), 'rec-7');
  assert.equal(r.verdict, 'not tested', r.reason);
  for (const w of ['data', 'body', 'record', 'item', 'object', 'fields', 'attributes', 'params', 'payload', 'values', 'ticket']) assert.equal(createdIdEcho({ [w]: { id: 'rec-7' } }, 'rec-7', { others: [] }), true, w);
  assert.equal(createdIdEcho({ input: [{ id: 'rec-7' }] }, 'rec-7', {}), true, 'inside a list');
  // what names another object is passed over
  for (const args of [{ project: { id: 'rec-7' } }, { parent: { id: 'rec-7' } }, { project_ref: { id: 'rec-7' } }, { project_id: 'rec-7' }, { projectId: 'rec-7' }]) assert.equal(createdIdEcho(args, 'rec-7', { others: ['project'] }), false, JSON.stringify(args));
});

test('third review F3: a statement behind a comment, a parenthesis, BEGIN or a GraphQL keyword is an echo', () => {
  for (const text of ['-- make one\nINSERT INTO t (id) VALUES (7)', '/* bulk */ insert into t values (7)', '(SELECT 7)', 'BEGIN; INSERT INTO t VALUES (7); COMMIT;', 'mutation { createTicket(id: 7) { id } }', 'MATCH (n {id: 7}) RETURN n', 'EXPLAIN INSERT INTO t VALUES (7)']) assert.equal(createdIdEcho({ text }, 7, {}), true, text);
  for (const k of ['graphql', 'gql', 'mutation', 'cypher', 'q']) assert.equal(createdIdEcho({ [k]: `{ t(id: 7) }` }, 7, {}), true, k);
  const r = createR3({ text: '/* x */ INSERT INTO t (id) VALUES (7)' }, call({ text: '/* x */ INSERT INTO t (id) VALUES (7)' }), 7);
  assert.equal(r.verdict, 'not tested', r.reason);
  const g = createR3({ body: 'mutation { createTicket(id: 7) { id } }' }, call({ data: { data: { createTicket: { id: 7 } } } }), 7);
  assert.equal(g.verdict, 'not tested', g.reason);
});

test('third review F4 (no narrowing): a title that holds the id as a word leaves the record not tested', () => {
  assert.equal(createdIdEcho({ title: 'Update the docs for 3 pages' }, 3, {}), true);
  assert.equal(createdIdEcho({ title: 'Docs for 3 pages' }, 3, {}), true, 'prose and a statement are not told apart');
  assert.equal(createdIdEcho({ priority: 3, title: 'Docs' }, 3, {}), false, 'a scalar under a non-id key is not an echo');
});

test('third review F5 (documented, unchanged): a number after an infrastructure word never counts', () => {
  const hay = requestHay({ title: 'x' })!;
  for (const text of ['Created node 42', 'Saved on client 7']) assert.deepEqual(serverData(call({ text }), hay), [], text);
});
