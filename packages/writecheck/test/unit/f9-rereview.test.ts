/**
 * Lane F9, second review: each finding has a test here that fails on 8686e8a and passes with its fix.
 *   M1  free text: a resource noun between a write word and the token does not veto it.
 *   M2  CFG-1: the map form of `valid` is part of the parsed declaration (test_hash, copies).
 *   L1  createdIdEcho: a statement is a text that looks like one; a nested parent id is not the object's own.
 *   L2  numbers tied to the server or its infrastructure, and status-like values, are not server data.
 *   L3  a create that was not tried keeps the run's procedure version.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createsVerdicts } from '../../src/checks/creates.js';
import { createdIdEcho, requestHay, serverData } from '../../src/checks/echo.js';
import { cfg1Probe } from '../../src/checks/launch.js';
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
const res = ctx.manifest.resources[0]!;

test('M1: a resource noun between a write word and the token does not veto it', () => {
  const hay = requestHay({ id: 42, name: 'bob' })!;
  for (const text of ['Saved user 42 (version 8)', 'Updated user version 8', 'Updated task 42, rev 8', 'Updated message 42 version 8', 'Updated run 42: version 8']) assert.ok(serverData(call({ text }), hay).length, text);
  // the call's own ids still refuse
  for (const text of ['request 7f3a2c9e: executed create_ticket', 'request id 99 executed', 'job 4411 finished']) assert.deepEqual(serverData(call({ text }), hay), [], text);
  const r4 = (text: string) =>
    createsVerdicts({ creates: [], failures: [], delete_case: null, jobs: [], update_receipt: { id: 'T-1', call: call({ text }), field: 'assignee', arg: 'assignee', value: 'bob', version: null, read_keys: null, changed: [{ path: 'assignee', after: 'bob' }], sent_args: { id: 'T-1', assignee: 'bob' } } } as never, res, ctx).find((x) => x.requirement === 'MWS-RES-4')!;
  assert.equal(r4('T-1 assignee bob; saved user version 8').verdict, 'held');
  assert.equal(r4('T-1 assignee bob; saved ticket version 8').verdict, 'held');
});

test('M2: the map form of valid is in the parsed declaration: a different CFG-1 test_hash, kept by a copy', () => {
  const list = M('settings: { read_only: { env: MODE, on: "readonly", valid: ["readonly", "true"] } }');
  const map = M('settings: { read_only: { env: MODE, on: "readonly", valid: { readonly: restrict, "true": permit } } }');
  const h = (m: typeof list) => testHash(result('MWS-CFG-1', { resource: '(server)', tool: 'MODE', arm: 'mcp' }, { id: 'launch-settings', version: '2' }, 'held', 'x'), { manifest: m, tools: [] });
  assert.notEqual(h(list), h(map));
  assert.equal(list.settings.read_only!.permit, undefined, 'a list form parses as before');
  assert.equal(cfg1Probe({ ...map.settings.read_only! }).polarity, 'inverted', 'a spread copy keeps the map form');
  assert.equal(cfg1Probe(structuredClone(map.settings.read_only!)).polarity, 'inverted', 'a structured clone keeps it');
  assert.equal(cfg1Probe(structuredClone(list.settings.read_only!)).polarity, 'normal');
});

test('L1 (as revised by the third review): a nested parent id is not the object\'s own; any text holding the id is an echo', () => {
  assert.equal(createdIdEcho({ title: 'buy 2 apples', note: 'see 7 first' }, 7, {}), true, 'prose or statement cannot be told apart: an echo (not tested)');
  assert.equal(createdIdEcho({ sql: 'INSERT INTO t (id) VALUES (7)' }, 7, {}), true);
  assert.equal(createdIdEcho({ ticket: { id: 1 }, body: 'hello' }, 1, { others: ['ticket'] }), false, 'a nested id under another resource is another object');
  assert.equal(createdIdEcho({ parent: { id: 1 }, body: 'hello' }, 1, {}), false, 'a parent reference');
  assert.equal(createdIdEcho({ id: 1, body: 'hello' }, 1, {}), true);
  const r3 = createsVerdicts({ creates: [{ name: 'ticket', tool: 'ticket_create', parent: null, first: call({ data: { id: 1, parent: { id: 1 } } }), sent_args: { parent: { id: 1 }, body: 'hello' }, found: [1], repeat: null, found_after_repeat: null, key: null, version: null, read_keys: null, late_failure: null }], update_receipt: null, failures: [], delete_case: null, jobs: [] } as never, res, ctx).find((x) => x.requirement === 'MWS-RES-3')!;
  assert.equal(r3.verdict, 'held', r3.reason);
});

test('L2: server, API, shard and protocol numbers, and status-like values, are not server data', () => {
  const hay = requestHay({ id: 'T-1', assignee: 'bob' })!;
  for (const text of ['T-1 assignee bob (server version 16.1)', 'T-1 assignee bob; API version 2', 'T-1 assignee bob; inserted on shard 3', 'T-1 saved over protocol version 3', 'T-1 saved: 1', 'T-1 updated, 200']) assert.deepEqual(serverData(call({ text }), hay), [], text);
  for (const data of [{ result: 1 }, { result: 0 }, { status: 200 }, { code: 404 }, { message: '500' }, { ok: true }, { success: 'true' }, { result: 'true' }, { data: 201 }]) assert.deepEqual(serverData(call({ data }), hay), [], JSON.stringify(data));
  assert.ok(serverData(call({ data: { result: 'T-907' } }), hay).length, 'a generated id under a result key still counts');
  assert.ok(serverData(call({ text: 'T-1 saved, version 1' }), hay).length, 'a version word names a 1');
});

test('L3: a create that was not tried keeps the run\'s procedure version', () => {
  const rs = createsVerdicts({ creates: [{ name: 'ticket', tool: 'ticket_create', parent: null, first: null, found: [], repeat: null, found_after_repeat: null, key: null, version: null, read_keys: null, late_failure: null, skipped: 'no create in this run' }], update_receipt: null, failures: [], delete_case: null, jobs: [] } as never, res, ctx);
  const r3 = rs.find((x) => x.requirement === 'MWS-RES-3')!;
  assert.equal(r3.verdict, 'not tested');
  assert.equal(r3.scenario.version, '2');
});
