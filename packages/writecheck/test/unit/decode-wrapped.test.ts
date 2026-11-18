/**
 * t17: a server built on Python FastMCP with a wrap-result output schema answers structuredContent
 * `{"result": "<a JSON document as a string>"}`. Paths are read from the parsed document, but only where the tool is
 * marked (its outputSchema, or the manifest's `decode: json`) and the value is exactly that shape; every other result
 * is read as before.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { outcomeByField, usePatterns } from '../../src/checks/says.js';
import { patternData, readShape, useShapes } from '../../src/checks/shape.js';
import { conflictSignal } from '../../src/checks/signals.js';
import { conflictState, shownBy, staleExperiment, staleVerdicts, versionIn } from '../../src/checks/stale.js';
import { textOf } from '../../src/checks/retry2.js';
import { brief, saidStrings } from '../../src/checks/types.js';
import { objectFrom } from '../../src/core/driver.js';
import type { ExperimentOutcome } from '../../src/core/exec.js';
import { declaredDecodes, parseManifestText } from '../../src/core/manifest.js';
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
  // PR #7 round 3: the extension does not override the type rule
  assert.equal(marksWrappedResult({ type: 'object', properties: { result: { type: 'array' } }, 'x-fastmcp-wrap-result': true }), false, 'the marker with a result that is never a string');
  assert.equal(marksWrappedResult({ type: 'object', properties: { result: {} }, 'x-fastmcp-wrap-result': true }), true, 'the marker with an untyped result');
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

// ---------------------------------------------------------------- review of PR #7: opt-out, raw kept, shape, write tools

test('manifest: decode: none, server.decode per tool, and one mode per tool', () => {
  const text = (server: string, read: string) => `mws: "0.9"
server: { stdio: [node, s.js]${server} }
target: { environment: test, confirm: t }
resources:
  - name: row
    create: { tool: c, args: {}, id: id }
    read: { tool: get_rows, args: {}, items: rows, match: id${read} }
    delete: { tool: d, args: { id: "{{id}}" } }
    cleanup: delete
`;
  const m = parseManifestText(text(', decode: { set_row: json, get_rows: none }', ', decode: none'), '/tmp/m.yaml');
  assert.deepEqual(m.server.decode, { set_row: 'json', get_rows: 'none' });
  assert.equal(m.resources[0]!.read.decode, 'none');
  assert.deepEqual([...declaredDecodes(m)].sort(), [['get_rows', 'none'], ['set_row', 'json']]);
  assert.equal('decode' in parseManifestText(text('', ''), '/tmp/m.yaml').server, false, 'absent: no key');
  assert.throws(() => parseManifestText(text(', decode: { get_rows: none }', ', decode: json'), '/tmp/m.yaml'), /resources\[0\]\.read\.decode: decode: json for get_rows, which server\.decode\.get_rows declares decode: none/);
  assert.throws(() => parseManifestText(text(', decode: { set_row: yes }', ''), '/tmp/m.yaml'), /server\.decode\.set_row\.decode: json .* or none/);
  assert.throws(() => parseManifestText(text(', decode: [set_row]', ''), '/tmp/m.yaml'), /server\.decode/);
});

test('raw kept: a decoded call keeps structuredContent as received beside the decoded data, in the result and the brief', () => {
  const inner = JSON.stringify(DOC);
  const r = call(wrapped(inner), 'outputSchema');
  assert.deepEqual(r.raw_structured, { result: inner });
  const b = brief(r);
  assert.deepEqual(b.raw_structured, { result: inner });
  assert.deepEqual(b.data, DOC);
  // clipped like data where it is large
  const big = JSON.stringify({ rows: Array.from({ length: 400 }, (_, i) => ({ id: `F${i}`, name: 'x'.repeat(20) })) });
  const bb = brief(call(wrapped(big), 'outputSchema'));
  assert.equal((bb.raw_structured as { clipped?: boolean }).clipped, true);
  assert.equal('raw_structured' in brief(call(wrapped(inner), null)), false, 'not decoded: no raw_structured');
});

test('shape and patterns read the same thing: the decoded document where decoded, the raw answer where not', () => {
  useShapes({ results: { shape: 'write-result/0.1', tools: {} } });
  try {
    const inner = JSON.stringify({ id: 'T1', mws: { shape: 'write-result/0.1', outcome: 'applied', message: 'Applied T1.' } });
    const dec = brief(call(wrapped(inner), 'outputSchema'));
    const rs = readShape(dec);
    assert.equal(rs.status, 'ok', JSON.stringify(rs));
    if (rs.status === 'ok') {
      assert.equal(rs.v.outcome, 'applied');
      assert.match(rs.where, /structuredContent\.result decoded/);
    }
    assert.deepEqual(patternData(dec), { id: 'T1', mws: ['Applied T1.'] }, 'the patterns read the same mws, reduced to its free words');
    assert.doesNotMatch(dec.text ?? '', /"outcome"/, 'the serialized block is left out of the prose; its free words are kept');
    assert.match(dec.text ?? '', /Applied T1\./);
    // the twin, not marked: neither reads an mws in the wrapper (a JSON block is not the shape where structuredContent exists)
    const raw = brief(call(wrapped(inner), null));
    assert.equal(readShape(raw).status, 'unread');
    assert.deepEqual(patternData(raw), { result: inner });
  } finally {
    useShapes(null);
  }
});

test('a marked WRITE tool: the conflict signal, the declared outcome field and the CONC readings use the decoded answer; the unmarked twin reads as before', () => {
  const m = parseManifestText(`mws: "0.9"
server: { stdio: [node, s.js] }
target: { environment: test, confirm: t }
outcome_field: { path: outcome, applied: applied, not_applied: not_applied, unknown: unknown }
resources:
  - name: ticket
    create: { tool: ticket_create, args: { title: "{{prefix}}t" }, id: id }
    read: { tool: ticket_get, args: { id: "{{id}}" }, object: ticket, ignore: [updated_at] }
    update: { tool: ticket_update, mode: field_patch, args: { id: "{{id}}", "{{field}}": "{{value}}" } }
    fields: [ { path: assignee, values: [ann, bob] }, { path: status, values: [blocked, closed] } ]
    version: { read: version }
    cleanup: delete
    delete: { tool: ticket_delete, args: { id: "{{id}}" } }
`, '/tmp/m.yaml');
  const res = m.resources[0]!;
  const ctx = { manifest: m, tools: [] };
  usePatterns(m);
  try {
    const inner = JSON.stringify({ status: 409, error: { code: 'conflict', message: 'version conflict' }, outcome: 'not_applied', current: { status: 'closed', version: 7 } });
    const write = (basis: DecodeBasis | null) => toCallResult(wrapped(inner), 'test.write.00001', 'R', 'ticket_update', basis);
    const marked = write('outputSchema');
    const twin = write(null);
    // the readers, one by one
    assert.ok(conflictSignal(brief(marked)), 'a 409 in the decoded answer is a structured conflict signal');
    assert.equal(conflictSignal(brief(twin)), null, 'the wrapper carries no signal');
    assert.equal(outcomeByField(brief(marked))?.outcome, 'not_applied');
    assert.equal(outcomeByField(brief(twin)), null);
    assert.equal(shownBy(brief(marked)), 'signal');
    assert.equal(shownBy(brief(twin)), 'default', 'only the built-in words read the twin as a conflict (decides nothing)');
    assert.equal(versionIn(marked.data, 'version', 7), true);
    assert.equal(versionIn(twin.data, 'version', 7), false);
    // MWS-CONC-6: the conflict carries the current state (the other writer's value and the version)
    const seen = (r: typeof marked) => [{ step: r.step, text: r.text, data: r.data, other: 'closed', version: 7, tool: r.tool, shape: r.shape ?? null }];
    assert.equal(conflictState(ctx, { resource: 'ticket', tool: 'ticket_update', arm: 'mcp' }, res, seen(marked))[0]!.verdict, 'held');
    // MWS-CONC-2: three stale writes answered without isError that applied nothing; held only where a signal shows the conflict
    const exp = staleExperiment(res, 3);
    const env = (r: typeof marked) => ({ write: { ok: r.ok, isError: r.isError, text: r.text, data: r.data, tool: r.tool, shape: r.shape ?? null }, final: { ok: true, obj: { assignee: 'ann', status: 'closed', version: 8 } } });
    const out = (r: typeof marked): ExperimentOutcome => ({
      experiment: exp,
      arms: {
        validity: { role: 'validity', description: '', reps_planned: 1, counts: { valid: 1, both_kept: 1 }, reps: [] },
        test: { role: 'test', description: '', reps_planned: 3, counts: { valid: 3, silent_noop: 3, rejected: 0, stale_won: 0 }, reps: [0, 1, 2].map(() => ({ valid: true, env: env(r), steps: { write: r.step } })) },
      },
      verdict: { criterion: '', verdict: 'inconclusive', reproduced_rule: false, not_reproduced_rule: false, overlapping_rules: false, values: {} },
      simulated: [],
      stopped: null,
    }) as never;
    const conc2 = (r: typeof marked) => staleVerdicts(out(r), res, ctx).find((x) => x.requirement === 'MWS-CONC-2')!;
    assert.equal(conc2(marked).verdict, 'held', conc2(marked).reason);
    assert.equal(conc2(twin).verdict, 'not tested', 'the twin: no structured signal, only the built-in words (as before the change)');
    // the twin is exactly what the tester read before: structuredContent as received, nothing added
    assert.deepEqual(twin.data, { result: inner });
    assert.equal('decoded' in twin || 'raw_structured' in twin, false);
  } finally {
    usePatterns(null);
  }
});

test('PR #7 round 3: a text block that is the serialized wrapper is read as the decoded document, never as the inner JSON', () => {
  const inner = JSON.stringify({ replayed: false, id: 3, message: 'Created T3' });
  const wrapper = JSON.stringify({ result: inner });
  const o = outcome({ content: [{ type: 'text', text: wrapper }], structuredContent: { result: inner } });
  const dec = toCallResult(o, 's', 'L', 'set_row', 'manifest');
  assert.equal(dec.decoded?.text_mirrors, 'structuredContent');
  const b = brief(dec);
  for (const said of [saidStrings(b), textOf(b)]) {
    assert.doesNotMatch(said, /replayed/, 'no field name of the inner document reaches the patterns');
    assert.match(said, /Created T3/);
  }
  // the twin, not decoded: read as before (the inner JSON is one string value of the text)
  const raw = brief(toCallResult(o, 's', 'L', 'set_row', null));
  assert.match(saidStrings(raw), /replayed/);
  // a text that repeats the decoded document (not the wrapper) is not flagged; prose that is no mirror is not either
  assert.equal(call(wrapped(inner), 'manifest').decoded?.text_mirrors, undefined);
  const two = toCallResult(outcome({ content: [{ type: 'text', text: 'Created ticket 3.' }, { type: 'text', text: wrapper }], structuredContent: { result: inner } }), 's', 'L', 'set_row', 'manifest');
  assert.equal(two.decoded?.text_mirrors, undefined);
});

test('PR #7 round 3: with an adopted shape, the wrapper text block is the mirror: the prose keeps only the free words', () => {
  useShapes({ results: { shape: 'write-result/0.1', tools: {} } });
  try {
    const inner = JSON.stringify({ id: 3, mws: { shape: 'write-result/0.1', outcome: 'applied', message: 'Created T3.' } });
    const wrapper = JSON.stringify({ result: inner });
    const one = toCallResult(outcome({ content: [{ type: 'text', text: wrapper }], structuredContent: { result: inner } }), 's', 'L', 't_create', 'outputSchema');
    assert.equal(one.prose_text, 'Created T3.', 'the wrapper is left out of the prose; the decoded shape\'s free words are kept');
    assert.doesNotMatch(brief(one).text ?? '', /outcome|applied|write-result/);
    // prose that is not a mirror stays as it is
    const two = toCallResult(outcome({ content: [{ type: 'text', text: 'Ticket 3 was created.' }, { type: 'text', text: wrapper }], structuredContent: { result: inner } }), 's', 'L', 't_create', 'outputSchema');
    assert.equal(two.prose_text, 'Ticket 3 was created.\nCreated T3.');
    // not decoded: the wrapper is no mirror of anything the tester reads as the shape (as before)
    const raw = toCallResult(outcome({ content: [{ type: 'text', text: wrapper }], structuredContent: { result: inner } }), 's', 'L', 't_create', null);
    assert.equal(raw.shape, null);
  } finally {
    useShapes(null);
  }
});
