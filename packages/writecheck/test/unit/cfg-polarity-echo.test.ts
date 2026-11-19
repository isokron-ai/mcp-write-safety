/**
 * Lane F9: two false-verdict risks the corpus found.
 *   - MWS-CFG-1 on an inverted switch (an allow-write flag whose restricting value is "false"): the probes are derived from the
 *     declared restricting value, and a value meaning the opposite of restrict is never sent as a restrict variant.
 *   - MWS-RES-3 / RES-4 echo filter: an answer that only repeats the request is not a receipt.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createsVerdicts } from '../../src/checks/creates.js';
import { credit, echoOf, inRequest, requestHay, serverData } from '../../src/checks/echo.js';
import { useShapes } from '../../src/checks/shape.js';
import { cfg1Probe, cfg1Values, launchVerdicts, switchSense } from '../../src/checks/launch.js';
import type { CallBrief } from '../../src/checks/types.js';
import { parseManifestText } from '../../src/core/manifest.js';
import { testHash, usedArgs } from '../../src/report/testhash.js';
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

// ---------------------------------------------------------------------------------------------------------------- CFG-1

test('CFG-1 polarity: a normal switch keeps its probes exactly', () => {
  const ro = M('settings: { read_only: { env: RO, on: "true", valid: { "true": restrict, "1": restrict, "yes": restrict, "on": restrict, "false": permit, "0": permit, "no": permit, "off": permit } } }').settings.read_only!;
  const p = cfg1Probe(ro);
  assert.equal(p.polarity, 'normal');
  // the declared restricting values are sent, and so is an unrecognized truthy word; the misspelling is of "true"
  assert.deepEqual(p.values, ['yes', 'on', 'enabled', '1', 'TRUE', 'rtue']);
  assert.deepEqual(cfg1Values(ro), p.values);
  assert.deepEqual(p.opposite, []);
  assert.match(p.basis, /^Polarity: normal/);
  // a manifest with no valid list: as before
  assert.deepEqual(cfg1Values(M('settings: { read_only: { env: RO, on: "true" } }').settings.read_only!), ['yes', 'on', 'enabled', '1', 'TRUE', 'rtue']);
  // a non-boolean restricting value (MODE=readonly) is read as normal
  assert.equal(cfg1Probe(M('settings: { read_only: { env: MODE, on: "readonly" } }').settings.read_only!).polarity, 'normal');
});

test('CFG-1 polarity: the misspelling on a normal switch is never of the permitting word', () => {
  const ro = M('settings: { read_only: { env: RO, on: "1", valid: { "false": permit, "1": restrict, "true": restrict } } }').settings.read_only!;
  const p = cfg1Probe(ro);
  assert.equal(p.polarity, 'normal');
  assert.ok(!p.values.includes('aflse'), 'a typo of "false" would mean permit');
  assert.ok(p.values.includes('rtue'));
});

test('CFG-1 polarity: an inverted switch (allow-write flag, restrict = "false") probes falsy variants and never a truthy one', () => {
  const ro = M('settings: { read_only: { env: ALLOW_WRITES, on: "false", valid: { "false": restrict, "true": permit } } }').settings.read_only!;
  const p = cfg1Probe(ro);
  assert.equal(p.polarity, 'inverted');
  assert.deepEqual(p.values, ['FALSE', 'False', 'no', 'off', '0', 'disabled', 'fasle']);
  for (const v of p.values) assert.notEqual(switchSense(v), 'true', `${v} means permit on this switch`);
  for (const v of ['yes', 'on', 'enabled', '1', 'TRUE', 'true', 'rtue']) assert.ok(!p.values.includes(v), `${v} is not sent`);
  assert.match(p.basis, /^Polarity: inverted/);
  // with "0" declared as restricting too, it is sent; with "no" declared as permitting, it is not
  const ro2 = M('settings: { read_only: { env: ALLOW_WRITES, on: "0", valid: { "0": restrict, "no": permit, "1": permit } } }').settings.read_only!;
  const p2 = cfg1Probe(ro2);
  assert.equal(p2.polarity, 'inverted');
  assert.ok(!p2.values.includes('no'), 'a declared permitting value is not sent (R7-6)');
  assert.ok(p2.values.includes('0'), 'a declared restricting value is sent (R7-6), as on a normal switch');
  assert.ok(!p2.values.includes('1') && !p2.values.includes('TRUE'));
  assert.ok(p2.values.includes('FALSE') && p2.values.includes('fasle'), 'the misspelling falls back to "false"');
  // empty only where the declaration says it differs from unset
  assert.ok(cfg1Probe(M('settings: { read_only: { env: A, on: "false", empty_distinct: true } }').settings.read_only!).values.includes(''));
});

test('CFG-1 polarity: a mixed declaration sends no spelling variant, only a misspelling', () => {
  const ro = M('settings: { read_only: { env: RO, on: "true", valid: { "true": restrict, "0": restrict } } }').settings.read_only!;
  const p = cfg1Probe(ro);
  assert.equal(p.polarity, 'mixed');
  assert.deepEqual(p.values, ['rtue']);
});

test('CFG-1 evidence: the record names the polarity; no value left to try is not tested, never held', () => {
  const base = { baseline: { started: true, reason: null }, cfg2: [], cfg3: null };
  const ro = M('settings: { read_only: { env: ALLOW_WRITES, on: "false" } }').settings.read_only!;
  const p = cfg1Probe(ro);
  const refused = (value: string) => ({ value, started: true, reason: null, write: { ok: false, changed: false, step: 's' } });
  const r = launchVerdicts({ ...base, cfg1: { env: 'ALLOW_WRITES', starts: p.values.map(refused), polarity: p.polarity, basis: p.basis } } as never)[0]!;
  assert.equal(r.verdict, 'held');
  assert.ok(r.notes.some((n) => /^Polarity: inverted/.test(n)), r.notes.join(' | '));
  const none = launchVerdicts({ ...base, cfg1: { env: 'ALLOW_WRITES', starts: [], polarity: 'inverted', basis: p.basis } } as never)[0]!;
  assert.equal(none.verdict, 'not tested');
  // older evidence without the polarity reads as before
  const old = launchVerdicts({ ...base, cfg1: { env: 'RO', starts: [refused('yes')] } } as never)[0]!;
  assert.equal(old.verdict, 'held');
  assert.ok(!old.notes.some((n) => /Polarity/.test(n)));
});

test('CFG-1 polarity: a restricting word that withholds (WRITES=none) is an inverted switch', () => {
  assert.equal(switchSense('none'), 'false');
  assert.equal(switchSense('all'), 'true');
  assert.equal(switchSense('readonly'), null);
  const p = cfg1Probe(M('settings: { read_only: { env: WRITES, on: "none", valid: { none: restrict, all: permit } } }').settings.read_only!);
  assert.equal(p.polarity, 'inverted');
  assert.deepEqual(p.values, ['FALSE', 'False', 'no', 'off', '0', 'disabled', 'noen'], 'the misspelling is of the restricting word');
  for (const v of ['yes', 'on', '1', 'TRUE', 'enabled']) assert.ok(p.isOpposite(v) && !p.values.includes(v), `${v} is not sent`);
});

test('CFG-1 polarity: where the restricting value is a mode name, the permitting values decide', () => {
  // WRITE_ACCESS=readonly restricts and WRITE_ACCESS=true permits: a truthy probe would be read as a permit
  const inv = cfg1Probe(M('settings: { read_only: { env: WRITE_ACCESS, on: "readonly", valid: { readonly: restrict, "true": permit } } }').settings.read_only!);
  assert.equal(inv.polarity, 'inverted');
  assert.match(inv.basis, /reads neither way, and the values declared to permit \("true"\) read as true/);
  assert.ok(!inv.values.some((v) => switchSense(v) === 'true'), inv.values.join(','));
  assert.ok(inv.values.includes('redaonly'), 'the misspelling is of the restricting word');
  // MODE=readonly restricts and MODE=off permits: the truthy probes stay
  const nor = cfg1Probe(M('settings: { read_only: { env: MODE, on: "readonly", valid: { readonly: restrict, "off": permit } } }').settings.read_only!);
  assert.equal(nor.polarity, 'normal');
  assert.deepEqual(nor.values.slice(0, 5), ['yes', 'on', 'enabled', '1', 'TRUE']);
  // an inverted misspelling is never of a false word declared to permit
  const p = cfg1Probe(M('settings: { read_only: { env: A, on: "0", valid: { "0": restrict, "off": permit, "nope": permit } } }').settings.read_only!);
  assert.ok(p.values.includes('fasle') && !p.values.includes('noep'));
  // a normal misspelling prefers a word declared to restrict over one declared to permit
  const mode = cfg1Probe(M('settings: { read_only: { env: MODE, on: "readonly", valid: { readwrite: permit, readonly: restrict } } }').settings.read_only!);
  assert.ok(mode.values.includes(cfg1Values({ on: 'readonly', valid: ['readonly'], restrict: ['readonly'], empty_distinct: false }).at(-1)!), mode.values.join(','));
});

test('CFG-1 verdicts: a recorded start under a value that means permit on the switch is set aside, never judged', () => {
  // evidence of procedure version 1 on an allow-write flag: TRUE was sent, the server (correctly) wrote under it
  const ro = M('settings: { read_only: { env: ALLOW_WRITES, on: "false", valid: { "false": restrict, "true": permit } } }').settings.read_only!;
  const base = { baseline: { started: true, reason: null }, cfg2: [], cfg3: null };
  const wrote = (value: string) => ({ value, started: true, reason: null, write: { ok: true, changed: true, step: 's1' }, tools: [{ tool: 'ticket_update', ok: true, effect: 'status', step: 's2' }] });
  const refused = (value: string) => ({ value, started: true, reason: null, write: { ok: false, changed: false, step: 's' } });
  const old = { ...base, cfg1: { env: 'ALLOW_WRITES', starts: [wrote('yes'), wrote('TRUE'), refused('fasle')] } };
  assert.equal(launchVerdicts(old as never)[0]!.verdict, 'violated', 'without the declaration at hand the evidence reads as recorded');
  const r = launchVerdicts(old as never, ro)[0]!;
  assert.equal(r.verdict, 'held', r.reason);
  assert.ok(r.notes.some((n) => /^Not judged: .*ALLOW_WRITES="yes", ALLOW_WRITES="TRUE".*opposite of restrict/.test(n)), r.notes.join(' | '));
  assert.ok(r.notes.some((n) => /^Polarity: inverted/.test(n)));
  // nothing left once they are set aside: not tested, never held
  assert.equal(launchVerdicts({ ...base, cfg1: { env: 'ALLOW_WRITES', starts: [wrote('TRUE')] } } as never, ro)[0]!.verdict, 'not tested');
  // a real violation on the same switch stays one
  assert.equal(launchVerdicts({ ...base, cfg1: { env: 'ALLOW_WRITES', starts: [wrote('TRUE'), wrote('FALSE')] } } as never, ro)[0]!.verdict, 'violated');
  // a normal switch: nothing is set aside
  const nro = M('settings: { read_only: { env: RO, on: "true" } }').settings.read_only!;
  const n = launchVerdicts({ ...base, cfg1: { env: 'RO', starts: [wrote('yes')] } } as never, nro)[0]!;
  assert.equal(n.verdict, 'violated');
  assert.ok(!n.notes.some((x) => /^Not judged/.test(x)));
});

test('test_hash: the switch\'s restricting value, list.consistency and the procedure versions are test inputs', () => {
  const tools = [{ name: 'ticket_list', inputSchema: { type: 'object', properties: { consistent: { type: 'boolean' }, limit: { type: 'integer' } } } }];
  const cfg = (m: ReturnType<typeof M>, version = '2') => testHash(result('MWS-CFG-1', { resource: '(server)', tool: 'A', arm: 'mcp' }, { id: 'launch-settings', version }, 'held', 'x'), { manifest: m, tools });
  const normal = M('settings: { read_only: { env: A, on: "true" } }');
  const inverted = M('settings: { read_only: { env: A, on: "false" } }');
  assert.notEqual(cfg(normal), cfg(inverted), 'the declared restricting value decides the probes, and is in the hash (declaration.settings)');
  assert.notEqual(cfg(normal, '1'), cfg(normal, '2'), 'the procedure version is in the hash');
  const withList = (c: string) => parseManifestText(`mws: "0.9"
server: { stdio: [node, s.js] }
target: { environment: test, confirm: t }
resources:
  - name: ticket
    create: { tool: ticket_create, args: { title: "{{marker}}" }, id: id }
    read: { tool: ticket_get, args: { id: "{{id}}" }, object: ticket }
    list: { tool: ticket_list, args: {}, items: tickets, id: id, name: title${c} }
    cleanup: delete
    delete: { tool: ticket_delete, args: { id: "{{id}}" } }
`, 'm.yaml');
  const res3 = (m: ReturnType<typeof M>) => testHash(result('MWS-RES-3', { resource: 'ticket', tool: 'ticket_create', arm: 'mcp' }, { id: 'creates', version: '2' }, 'held', 'x'), { manifest: m, tools });
  const plain = withList('');
  const cons = withList(', consistency: { args: { consistent: true }, settle_ms: 500 }');
  assert.notEqual(res3(plain), res3(cons), 'list.consistency is part of the resource block');
  assert.notEqual(res3(cons), res3(withList(', consistency: { args: { consistent: true }, settle_ms: 900 }')));
  assert.ok(usedArgs('ticket_list', cons.resources[0], false).has('consistent'), 'the consistent-read argument is one the test sends, so its schema enters the hash');
  assert.ok(!usedArgs('ticket_list', plain.resources[0], false).has('consistent'));
});

// ---------------------------------------------------------------------------------------------------------------- echo

test('echo filter: what counts as data the request did not contain', () => {
  const args = { sql: "INSERT INTO tickets (id, title, priority) VALUES (42, 'mwsc-ab12-cr-x1', 1)" };
  const hay = requestHay(args)!;
  assert.ok(inRequest(hay, 42) && inRequest(hay, 'mwsc-ab12-cr-x1') && inRequest(hay, 'title') && inRequest(hay, 'sql'));
  // a pure echo, with fixed words
  assert.deepEqual(serverData(call({ text: `Executed: ${args.sql}`, data: { status: 'ok', sql: args.sql } }), hay), []);
  assert.deepEqual(serverData(call({ text: 'Query executed successfully', data: null }), hay), []);
  // server state: a count, a generated id, a version, a timestamp
  assert.ok(serverData(call({ data: { rowsAffected: 1 } }), hay).length, 'a count under a key the request does not use counts, though 1 is in the request');
  assert.ok(serverData(call({ data: { id: 43 } }), hay).length);
  assert.ok(serverData(call({ text: 'Created ticket T-907' }), hay).length);
  assert.ok(serverData(call({ data: { status: 'open' } }), hay).length, 'a state word the request did not send');
  assert.deepEqual(serverData(call({ data: { done: true, value: null } }), hay), [], 'booleans and nulls say nothing');
  // credit
  const echo = echoOf(call({ text: args.sql }), args);
  assert.equal(credit(true, echo, 42), 'echo');
  assert.equal(credit(true, echo, 'T-9'), 'yes', 'a value the request did not hold counts');
  assert.equal(credit(false, echo, 42), 'no');
  assert.equal(credit(true, echoOf(call({ text: args.sql }), undefined), 42), 'yes', 'no arguments kept (older evidence): no filter');
  assert.equal(credit(true, echoOf(call({ text: args.sql }), { clipped: true, bytes: 99999 }), 42), 'yes', 'arguments too large to keep: no filter');
});

test('echo filter, RES-3: an answer that only echoes the request is not tested; a server-generated id or count holds', () => {
  const ticket = M().resources[0]!;
  const ctx = { manifest: M(), tools: [] };
  const sent = { sql: "INSERT INTO tickets (id, title) VALUES (42, 'mwsc-ab12-cr-x1')" };
  const c = (o: object) => ({ name: 'ticket', tool: 'run_sql', parent: null, first: call({ text: sent.sql }), sent_args: sent, found: [42], repeat: null, found_after_repeat: null, key: null, version: null, read_keys: null, late_failure: null, ...o });
  const v = (o: object) => createsVerdicts({ creates: [c(o)], update_receipt: null, failures: [], delete_case: null, jobs: [] } as never, ticket, ctx);
  const get = (rs: ReturnType<typeof v>, id: string) => rs.find((r) => r.requirement === id)!;
  const echo = get(v({}), 'MWS-RES-3');
  assert.equal(echo.verdict, 'not tested', echo.reason);
  assert.match(echo.reason, /only as an echo of the request/);
  assert.equal(get(v({}), 'MWS-RES-4').verdict, 'not tested', 'RES-4 for the create: the same echo');
  // the same echo beside a server-reported count
  const counted = get(v({ first: call({ text: `${sent.sql}\n`, data: { command: 'INSERT', count: 1 } }) }), 'MWS-RES-3');
  assert.equal(counted.verdict, 'held', counted.reason);
  assert.ok(counted.notes.some((n) => /Echo filter .*counted because the answer also carries data the request did not contain \(count: 1\)/.test(n)), counted.notes.join(' | '));
  // a server-generated id the request did not carry
  assert.equal(get(v({ sent_args: { title: 'mwsc-ab12-cr-x1' }, first: call({ data: { id: 42, title: 'mwsc-ab12-cr-x1' } }) }), 'MWS-RES-3').verdict, 'held');
  // no identifier at all is still violated
  assert.equal(get(v({ first: call({ text: 'ok' }) }), 'MWS-RES-3').verdict, 'violated');
  // older evidence (no sent_args) reads as before
  assert.equal(get(v({ sent_args: undefined }), 'MWS-RES-3').verdict, 'held');
});

test('echo filter, RES-3 late failure: an error that only echoes the id is not tested', () => {
  const ticket = M().resources[0]!;
  const ctx = { manifest: M(), tools: [] };
  const lf = (text: string) => ({ mutating: 2, call: call({ ok: false, isError: true, text }), found: ['P-7'], sent_args: { key: 'P-7', name: 'x' } });
  const c = (late: object) => ({ name: 'ticket', tool: 'p_create', parent: null, first: call({ data: { id: 'T5', seq: 3 } }), sent_args: { title: 'x' }, found: ['T5'], repeat: null, found_after_repeat: null, key: null, version: null, read_keys: null, late_failure: late });
  const r3 = (late: object) => createsVerdicts({ creates: [c(late)], update_receipt: null, failures: [], delete_case: null, jobs: [] } as never, ticket, ctx).find((r) => r.requirement === 'MWS-RES-3')!;
  assert.equal(r3(lf('failed: P-7 x')).verdict, 'not tested');
  assert.equal(r3(lf('failed after creating P-7 (revision 12)')).verdict, 'held');
  assert.equal(r3(lf('failed')).verdict, 'violated');
});

test('echo filter, RES-4 update: a receipt that repeats the request beside server state holds; the echo alone does not', () => {
  const res = M('    version: { read: version }').resources[0]!;
  const plain = M().resources[0]!;
  const ctx = { manifest: M(), tools: [] };
  const sent = { id: 'T-1', assignee: 'bob' };
  const o = (c: Partial<CallBrief>, version: unknown = null) => ({ creates: [], failures: [], delete_case: null, jobs: [], update_receipt: { id: 'T-1', call: call(c), field: 'assignee', arg: 'assignee', value: 'bob', version, read_keys: null, changed: [{ path: 'assignee', after: 'bob' }], sent_args: sent } });
  const r4 = (c: Partial<CallBrief>, r = plain, version: unknown = null) => createsVerdicts(o(c, version) as never, r, ctx).find((x) => x.requirement === 'MWS-RES-4')!;
  const echo = r4({ text: 'T-1 updated: assignee=bob' });
  assert.equal(echo.verdict, 'not tested', 'the identifier, the field and its value all come from the request');
  assert.match(echo.reason, /the identifier, assignee only as an echo of the request/);
  assert.equal(r4({ data: { id: 'T-1', assignee: 'bob' } }).verdict, 'not tested', 'the arguments returned as structured content');
  const withState = r4({ data: { id: 'T-1', assignee: 'bob', version: 8 } }, res, 8);
  assert.equal(withState.verdict, 'held', withState.reason);
  assert.ok(withState.notes.some((n) => /Echo filter/.test(n)));
  assert.equal(r4({ text: 'T-1 updated: assignee=bob; updated_at 2026-11-18T10:00:00Z' }).verdict, 'held', 'a server timestamp is data the request did not contain');
  assert.equal(r4({ text: 'T-1 updated' }).verdict, 'violated', 'a missing field is still violated, echo or not');
  assert.equal(r4({ data: { id: 'T-1', assignee: 'bob' } }, res, 8).verdict, 'violated', 'a missing version is still violated');
});

test('echo filter, RES-4: an adopted result shape is the server\'s own statement, not an echo', () => {
  const ctx = { manifest: M('results: { shape: write-result/0.1 }'), tools: [] };
  const res = ctx.manifest.resources[0]!;
  const sent = { id: 'T-1', assignee: 'bob' };
  const mws = { shape: 'write-result/0.1', outcome: 'applied', object: { id: 'T-1' }, changed: ['/assignee'] };
  useShapes(ctx.manifest, [{ name: 'ticket_update' }]);
  try {
    const o = { creates: [], failures: [], delete_case: null, jobs: [], update_receipt: { id: 'T-1', call: call({ tool: 'ticket_update', data: { mws }, shape: { sc: mws, texts: [] } }), field: 'assignee', arg: 'assignee', value: 'bob', version: null, read_keys: null, changed: [{ path: 'assignee', after: 'bob' }], sent_args: sent } };
    const r = createsVerdicts(o as never, res, ctx).find((x) => x.requirement === 'MWS-RES-4')!;
    assert.equal(r.verdict, 'held', r.reason);
    assert.ok(r.notes.some((n) => /Echo filter .*an adopted result shape/.test(n)), r.notes.join(' | '));
  } finally {
    useShapes(null);
  }
});

test('echo filter: facts about the call are not server data', () => {
  const args = { sql: "INSERT INTO tickets (id, title, priority) VALUES (42, 'mwsc-ab12-cr-x1', 1)" };
  const hay = requestHay(args)!;
  const none = (c: Partial<CallBrief>, why: string) => assert.deepEqual(serverData(call(c), hay), [], why);
  none({ data: { ok: true, operation: 'insertOne', database: 'main', sql: args.sql } }, 'the name of the operation or the database');
  none({ data: { duration_ms: 12, elapsed: 0.012, statusCode: 200, bytes: 512, sql: args.sql } }, 'how long the call took, a status code, a size');
  none({ text: `Executed in 12 ms: ${args.sql}` }, 'a duration in the text');
  none({ text: `Executed in 0.3s (3 ms planning): ${args.sql}` }, 'durations, with and without a space');
  none({ text: `[2026-11-18 10:00:00] Executed: ${args.sql}` }, 'the time the answer was made');
  none({ text: JSON.stringify({ duration_ms: 12, sql: args.sql }), data: { duration_ms: 12, sql: args.sql } }, 'a text that is the JSON of the structured content is read by key');
  none({ data: { id: 42, title: 'mwsc-ab12-cr-x1' } }, 'the request names id and holds 42: the parsed statement returned is an echo');
  none({ data: { timestamp: '2026-11-18T10:00:00Z', row_id: 42 } }, 'a response time; the request\'s own id under another key');
  none({ data: { request_id: 'req-9f3a', traceId: 'a1b2c3', status: 200, account: 'acme-1', valid: 'v2', writeConcern: 'w1' } }, 'an id of the call, a numeric status, and keys that only end like a receipt key');
  none({ text: `HTTP 200. status: 200 (200 OK), exit code 0. ${args.sql}` }, 'status codes in the text');
  // and these still are
  const some = (c: Partial<CallBrief>, why: string, keys: string[] = []) => assert.ok(serverData(call(c), hay, 3, keys).length, why);
  some({ text: `${args.sql}\n1 row affected` }, 'a count stated in words, though 1 is in the request');
  some({ text: 'Inserted. updated_at 2026-11-18T10:00:00Z' }, 'the time of the write, named as one');
  some({ data: { changes: 1, lastInsertRowid: 42 } }, 'a count and a row id under keys the request does not name');
  some({ data: { ticket: { updated_at: '2026-11-18T10:00:00Z' } } }, 'the time of a write under its key');
  some({ data: { etag: 'W-abc' } }, 'a version token');
  some({ data: { resourceVersion: '8841' } }, 'a version under a camel-case key');
  some({ data: { nModified: 1 } }, 'a count under a camel-case key');
  some({ data: { lastModified: '2026-11-18T10:00:00Z' } }, 'the time of a write, camel case');
  some({ text: 'T-1 saved, version 4' }, 'a version in the text');
  some({ data: { result: 'T-907' } }, 'a generated id under a key that only carries the result');
  assert.deepEqual(serverData(call({ data: { ticket: { owner: 'ann' } } }), hay), [], 'a word under an unknown key says nothing by itself');
  some({ data: { ticket: { owner: 'ann' } } }, 'the same word under a field of the object as read back', ['id', 'title', 'owner']);
  assert.deepEqual(serverData(call({ data: { ticket: { title: 'mwsc-ab12-cr-x1' } } }), hay, 3, ['title']), [], 'a field of the object holding the request\'s own value is still an echo');
});

test('echo filter, RES-3 and RES-4: an echo beside facts about the call is still an echo', () => {
  const ticket = M().resources[0]!;
  const ctx = { manifest: M(), tools: [] };
  const sent = { sql: "INSERT INTO tickets (id, title) VALUES (42, 'mwsc-ab12-cr-x1')" };
  const c = (first: CallBrief, o: object = {}) => ({ name: 'ticket', tool: 'run_sql', parent: null, first, sent_args: sent, found: [42], repeat: null, found_after_repeat: null, key: null, version: null, read_keys: ['id', 'title', 'status'], late_failure: null, ...o });
  const v = (first: CallBrief, o: object = {}) => createsVerdicts({ creates: [c(first, o)], update_receipt: null, failures: [], delete_case: null, jobs: [] } as never, ticket, ctx);
  const noisy = v(call({ text: `OK (3 ms)`, data: { success: true, operation: 'insert', duration_ms: 3, statusCode: 200, sql: sent.sql } }));
  assert.equal(noisy.find((r) => r.requirement === 'MWS-RES-3')!.verdict, 'not tested');
  assert.equal(noisy.find((r) => r.requirement === 'MWS-RES-4')!.verdict, 'not tested');
  // the row as the backend stored it (a field the request did not set) is a receipt
  const row = v(call({ data: { rows: [{ id: 42, title: 'mwsc-ab12-cr-x1', status: 'open' }] } }));
  assert.equal(row.find((r) => r.requirement === 'MWS-RES-3')!.verdict, 'held', row.find((r) => r.requirement === 'MWS-RES-3')!.reason);
  // an update: the stored object beside the request's own values holds through a field of the object
  const u = (data: unknown) => createsVerdicts({ creates: [], failures: [], delete_case: null, jobs: [], update_receipt: { id: 'T-1', call: call({ data }), field: 'assignee', arg: 'assignee', value: 'bob', version: null, read_keys: ['id', 'assignee', 'status', 'title'], changed: [{ path: 'assignee', after: 'bob' }], sent_args: { id: 'T-1', assignee: 'bob' } } } as never, ticket, ctx).find((x) => x.requirement === 'MWS-RES-4')!;
  assert.equal(u({ ticket: { id: 'T-1', assignee: 'bob', status: 'open', title: 'a ticket' } }).verdict, 'held');
  assert.equal(u({ id: 'T-1', assignee: 'bob', tool: 'ticket_update', took_ms: 4 }).verdict, 'not tested');
});

// ---------------------------------------------------------------------------------------------------------------- list.consistency

test('list.consistency: parsed, checked, and absent unless declared', () => {
  const base = M();
  assert.equal(base.resources[0]!.list!.consistency, undefined, 'a manifest without it reads as before');
  const withC = (c: string) => parseManifestText(`mws: "0.9"
server: { stdio: [node, s.js] }
target: { environment: test, confirm: t }
resources:
  - name: ticket
    create: { tool: ticket_create, args: { title: "{{prefix}}t" }, id: id }
    read: { tool: ticket_get, args: { id: "{{id}}" }, object: ticket }
    list: { tool: ticket_list, args: { prefix: "{{prefix}}" }, items: tickets, id: id, name: title, consistency: ${c} }
    cleanup: delete
    delete: { tool: ticket_delete, args: { id: "{{id}}" } }
`, 'm.yaml').resources[0]!.list!.consistency;
  assert.deepEqual(withC('{ args: { consistent: true } }'), { args: { consistent: true }, settle_ms: 0 });
  assert.deepEqual(withC('{ settle_ms: 2000 }'), { args: null, settle_ms: 2000 });
  assert.throws(() => withC('{}'), /consistent read, a settle window, or both/);
  assert.throws(() => withC('{ settle_ms: -1 }'), /milliseconds/);
  assert.throws(() => withC('{ settle_ms: 1000, wait: 2 }'), /unknown key wait/);
});
