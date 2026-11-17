/**
 * t17: a server built on Python FastMCP with a wrap-result output schema answers structuredContent
 * `{"result": "<a JSON document as a string>"}`. Paths are read from the parsed document, but only where the tool is
 * marked (its outputSchema, or the manifest's `decode: json`) and the value is exactly that shape; every other result
 * is read as before.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { brief } from '../../src/checks/types.js';
import { objectFrom } from '../../src/core/driver.js';
import { parseManifestText } from '../../src/core/manifest.js';
import { marksWrappedResult, toCallResult, unwrapResult, type DecodeBasis } from '../../src/core/session.js';
import { getPath } from '../../src/core/util.js';

const DOC = { rows: [{ id: 'F1', name: 'mwsc-fixture' }, { id: 'F2', name: 'other' }], tenant: 'mwsc-test-1' };

const outcome = (result: Record<string, unknown>) => ({ message: { jsonrpc: '2.0', id: 1, result }, timed_out: false, transport_error: null, http_status: 200, rpc_id: 1, t_start_ms: 0, t_end_ms: 1 }) as never;
const wrapped = (inner: string, extra: Record<string, unknown> = {}) => outcome({ content: [{ type: 'text', text: inner }], structuredContent: { result: inner, ...extra } });
const call = (o: never, basis: DecodeBasis | null) => toCallResult(o, 's.00001', 'MAIN', 'get_rows', basis);

test('marksWrappedResult: the FastMCP marker, or an object schema whose only property is result (string or untyped)', () => {
  assert.equal(marksWrappedResult({ type: 'object', properties: { result: { type: 'string' } }, required: ['result'], 'x-fastmcp-wrap-result': true }), true);
  assert.equal(marksWrappedResult({ type: 'object', properties: { result: { type: 'string' } } }), true);
  assert.equal(marksWrappedResult({ type: 'object', properties: { result: {} } }), true);
  assert.equal(marksWrappedResult({ type: 'object', properties: { result: { type: ['string', 'null'] } } }), true);
  // not marked
  assert.equal(marksWrappedResult(undefined), false);
  assert.equal(marksWrappedResult({ type: 'object' }), false);
  assert.equal(marksWrappedResult({ type: 'object', properties: { result: { type: 'integer' } } }), false, 'a result that is never a string');
  assert.equal(marksWrappedResult({ type: 'object', properties: { result: { type: 'string' }, total: { type: 'integer' } } }), false, 'another property');
  assert.equal(marksWrappedResult({ type: 'object', properties: { rows: { type: 'array' } } }), false);
  assert.equal(marksWrappedResult({ type: 'object', properties: { result: { type: 'string' }, extra: {} }, 'x-fastmcp-wrap-result': true }), false, 'the marker with another property');
});

test('unwrapResult: only {"result": "<JSON object or array>"} is decoded', () => {
  assert.deepEqual(unwrapResult({ result: JSON.stringify(DOC) }), DOC);
  assert.deepEqual(unwrapResult({ result: ` \n${JSON.stringify([1, { a: 2 }])}\n` }), [1, { a: 2 }]);
  // no decode
  assert.equal(unwrapResult({ result: 'Created ticket T1' }), undefined, 'not JSON');
  assert.equal(unwrapResult({ result: '{"rows": [' }), undefined, 'broken JSON');
  assert.equal(unwrapResult({ result: '42' }), undefined, 'a JSON scalar');
  assert.equal(unwrapResult({ result: '"x"' }), undefined, 'a JSON string');
  assert.equal(unwrapResult({ result: 'null' }), undefined, 'JSON null');
  assert.equal(unwrapResult({ result: JSON.stringify(DOC), total: 1 }), undefined, 'another key');
  assert.equal(unwrapResult({ result: DOC }), undefined, 'not a string');
  assert.equal(unwrapResult({ data: JSON.stringify(DOC) }), undefined, 'another key name');
  assert.equal(unwrapResult([JSON.stringify(DOC)]), undefined);
  assert.equal(unwrapResult(JSON.stringify(DOC)), undefined);
  assert.equal(unwrapResult(null), undefined);
});

test('toCallResult: a marked tool reads paths from the decoded document; the decode is recorded', () => {
  const inner = JSON.stringify(DOC);
  for (const basis of ['outputSchema', 'manifest'] as const) {
    const r = call(wrapped(inner), basis);
    assert.deepEqual(r.data, DOC);
    assert.deepEqual(r.decoded, { from: 'structuredContent.result', basis });
    assert.equal(r.text, inner, 'the text is kept as received');
    assert.equal(getPath(r.data, 'tenant'), 'mwsc-test-1');
    assert.deepEqual(brief(r).decoded, { from: 'structuredContent.result', basis }, 'the brief in the evidence says so');
    assert.deepEqual(brief(r).data, DOC);
  }
});

test('toCallResult: no decode for a tool that is not marked, or for a value that is not exactly a wrapped JSON document', () => {
  const inner = JSON.stringify(DOC);
  const cases: [string, never, DecodeBasis | null][] = [
    ['not marked', wrapped(inner), null],
    ['marked, not JSON', wrapped('Ticket T1 updated'), 'outputSchema'],
    ['marked, a JSON scalar', wrapped('7'), 'manifest'],
    ['marked, another key', wrapped(inner, { total: 2 }), 'outputSchema'],
    ['marked, result is an object', outcome({ content: [{ type: 'text', text: inner }], structuredContent: { result: DOC } }), 'outputSchema'],
    ['marked, an ordinary object', outcome({ content: [{ type: 'text', text: inner }], structuredContent: DOC }), 'outputSchema'],
  ];
  for (const [name, o, basis] of cases) {
    const r = call(o, basis);
    const sc = ((o as { message: { result: { structuredContent: unknown } } }).message.result.structuredContent);
    assert.deepEqual(r.data, sc, name);
    assert.equal(r.decoded, undefined, name);
    assert.equal('decoded' in brief(r), false, name);
  }
  // a result without structuredContent is read from its text as before, marked or not
  const t = call(outcome({ content: [{ type: 'text', text: JSON.stringify({ result: inner }) }] }), 'outputSchema');
  assert.deepEqual(t.data, { result: inner });
  assert.equal(t.decoded, undefined);
});

test('the fixture lookup (read.items + read.match) finds the object only in the decoded document', () => {
  const m = parseManifestText(`mws: "0.9"
server: { stdio: [node, s.js] }
target: { environment: test, confirm: t }
resources:
  - name: row
    fixture: { id: F1, name: mwsc-fixture }
    read: { tool: get_rows, args: {}, items: rows, match: id }
    update: { tool: set_row, mode: field_patch, args: { id: "{{id}}", "{{field}}": "{{value}}" } }
    fields: [ { path: a, values: [1, 2] }, { path: b, values: [1, 2] } ]
`, '/tmp/m.yaml');
  const res = m.resources[0]!;
  const inner = JSON.stringify(DOC);
  assert.deepEqual(objectFrom(res, call(wrapped(inner), 'outputSchema').data, 'F1'), DOC.rows[0]);
  assert.equal(objectFrom(res, call(wrapped(inner), null).data, 'F1'), null, 'without the decode the fixture is not found');
});

test('manifest: decode: json on a read, a list and the guard; anything else is refused; absent leaves no key', () => {
  const text = (read: string, list: string, guard: string) => `mws: "0.9"
server: { stdio: [node, s.js] }
target: { environment: test, confirm: t, guard: { tool: whoami, args: {}, path: tenant, pattern: "^t-"${guard} } }
resources:
  - name: row
    create: { tool: c, args: {}, id: id }
    read: { tool: get_rows, args: {}, items: rows, match: id${read} }
    list: { tool: list_rows, args: {}, items: rows${list} }
    delete: { tool: d, args: { id: "{{id}}" } }
    cleanup: delete
`;
  const on = parseManifestText(text(', decode: json', ', decode: json', ', decode: json'), '/tmp/m.yaml');
  assert.equal(on.resources[0]!.read.decode, 'json');
  assert.equal(on.resources[0]!.list!.decode, 'json');
  assert.equal(on.target.guard!.decode, 'json');
  const off = parseManifestText(text('', '', ''), '/tmp/m.yaml');
  // why: the parsed manifest of an existing declaration is unchanged (no decode key at all).
  assert.equal('decode' in off.resources[0]!.read, false);
  assert.equal('decode' in off.resources[0]!.list!, false);
  assert.equal('decode' in off.target.guard!, false);
  assert.throws(() => parseManifestText(text(', decode: yaml', '', ''), '/tmp/m.yaml'), /resources\[0\]\.read\.decode: json/);
  assert.throws(() => parseManifestText(text('', '', ', decode: true'), '/tmp/m.yaml'), /target\.guard\.decode: json/);
});
