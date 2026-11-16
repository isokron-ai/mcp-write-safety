/**
 * Spec eb3313f (decision rows R6 and R7): the tester rules and verdict changes that keep a correct server
 * from being accused and a faulty one from being cleared.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createsVerdicts } from '../../src/checks/creates.js';
import { gatedVerdicts, type GatedObs } from '../../src/checks/gated.js';
import { cfg1Values, launchVerdicts } from '../../src/checks/launch.js';
import { multiVerdicts, type MultiObs } from '../../src/checks/multi.js';
import { furtherProbes, readbackVerdicts, type CaseObs } from '../../src/checks/readback.js';
import { probeCases, schemaVerdicts, sendableProbe, type ProbeObs } from '../../src/checks/schema.js';
import { saidBy, usePatterns } from '../../src/checks/says.js';

/** Declared readings of the second clause of MWS-RES-2 (rule 11: only declared patterns decide). */
const DECL = { applied: String.raw`\b(already set|was updated|were updated|remains applied|updated to)\b`, outcome_unknown: String.raw`not known whether|could not confirm`, not_applied: String.raw`\bcould not\b|\bfailed\b` };
import { secretVerdicts } from '../../src/checks/secrets.js';
import { mcpDefinedError, res2Judge, type CallBrief } from '../../src/checks/types.js';
import { saysNotUsed } from '../../src/checks/schema.js';
import { validates } from '../../src/core/jsonschema.js';
import { parseManifestText } from '../../src/core/manifest.js';
import { annotateInputs, mcpLine, mcpRecord } from '../../src/report/protocol.js';
import { result } from '../../src/report/verdicts.js';

const M = (extra = '') =>
  parseManifestText(
    `mws: "0.9"
server: { stdio: [node, s.js] }
target: { environment: test, confirm: t }
resources:
  - name: ticket
    create: { tool: ticket_create, args: { title: "{{prefix}}t" }, id: id }
    read: { tool: ticket_get, args: { id: "{{id}}" }, object: ticket, ignore: [updated_at] }
    update: { tool: ticket_update, mode: field_patch, args: { id: "{{id}}", "{{field}}": "{{value}}" } }
    fields: [ { path: assignee, values: [ann, bob] }, { path: status, values: [blocked, closed] } ]
    version: { read: version }
    cleanup: delete
    delete: { tool: ticket_delete, args: { id: "{{id}}" } }
${extra}`,
    'm.yaml',
  );
const probe = (o: Partial<ProbeObs>): ProbeObs => ({ tool: 'ticket_update', role: 'update', prop: 'priority', name: 'non_numeric_string', requirement: 'MWS-IN-1', value: '"abc"', sent: 'abc', type: 'integer', required: false, ok: false, isError: true, rpc_error: null, text: 'invalid arguments: priority must be an integer', step: 's', ...o });
const call = (o: Partial<CallBrief> = {}): CallBrief => ({ step: 's', ok: true, isError: false, rpc_error: null, text: '', data: null, indeterminate: false, ...o });

test('rule 11: the declaration\'s patterns decide what a result says, and the record says which decided it', () => {
  const m = M('patterns: { not_used: "skipped it" }');
  assert.deepEqual(m.patterns, { not_used: 'skipped it' });
  assert.throws(() => M('patterns: { said: "x" }'), /unknown key said/);
  usePatterns(null);
  assert.equal(saysNotUsed('extra: ignored', 'extra'), true);
  assert.equal(saysNotUsed('extra: skipped it', 'extra'), false);
  assert.match(saidBy('not_used', 'extra: ignored'), /default pattern for not_used/);
  usePatterns(m);
  try {
    assert.equal(saysNotUsed('extra: skipped it', 'extra'), true);
    assert.equal(saysNotUsed('extra: ignored', 'extra'), false);
    assert.match(saidBy('not_used', 'extra: skipped it'), /declaration's pattern patterns\.not_used.*"extra: skipped it"/);
  } finally {
    usePatterns(null);
  }
});

test('IN-2 (R7-5): the record states the name and the value of each extra argument sent', () => {
  const res = M().resources[0]!;
  const tools = [{ name: 'ticket_get' }, { name: 'ticket_update' }];
  const r = schemaVerdicts([probe({ prop: 'mwsc_undefined_argument', name: 'undefined_argument', requirement: 'MWS-IN-2', value: 'mwsc' })], res, tools);
  const in2 = r.find((x) => x.requirement === 'MWS-IN-2' && x.write_path.tool === 'ticket_update')!;
  assert.ok(in2.notes.some((n) => /Extra arguments sent: an unrelated name, mwsc_undefined_argument=mwsc .*only the unrelated probe/.test(n)), in2.notes.join(' | '));
});

test('IN-1 and IN-3 (R7-4): a probe is sent only where the arguments do not validate against the whole input schema', () => {
  assert.equal(validates({ type: 'object', properties: { n: { anyOf: [{ type: 'integer' }, { type: 'string' }] } } }, { n: 'abc' }), true);
  assert.equal(validates({ type: 'object', properties: { n: { type: 'integer' } } }, { n: 'abc' }), false);
  assert.equal(validates({ type: 'object', properties: { n: { unevaluatedProperties: false } } }, { n: {} }), 'unknown');
  assert.equal(validates({ type: 'object', properties: { n: { $ref: '#/$defs/n' } }, $defs: { n: { type: 'integer', maximum: 5 } } }, { n: 6 }), false);
  assert.equal(validates({ type: 'object', if: { properties: { kind: { const: 'a' } } }, then: { properties: { n: { maximum: 5 } } } }, { kind: 'b', n: 9 }), true, 'a constraint in a branch that does not apply is not broken');
  const schema = { type: 'object', properties: { id: { type: 'string' }, n: { type: 'integer', maximum: 5 }, kind: { type: 'string' } }, oneOf: [{ properties: { kind: { const: 'big' }, n: { type: ['integer', 'string'] } } }, { properties: { kind: { const: 'small' } } }] };
  // n="abc" with kind small: invalid; with the declared n type alone the probe looks invalid, but the whole schema decides.
  assert.equal(sendableProbe(schema, { id: 'T-1', kind: 'small' }, 'n', 'abc', false).send, true);
  const big = sendableProbe({ type: 'object', properties: { id: { type: 'string' }, n: { anyOf: [{ type: 'integer' }, { type: 'string' }] } } }, { id: 'T-1' }, 'n', 'abc', false);
  assert.equal(big.send, false);
  assert.match(big.why!, /validate against the tool's whole input schema/);
  const unk = sendableProbe({ type: 'object', properties: { n: { anyOf: [{ type: 'integer' }, { unevaluatedProperties: false }] } } }, {}, 'n', 'abc', false);
  assert.equal(unk.send, false, 'a probe whose invalidity cannot be shown is not sent');
  const hdr = sendableProbe({ type: 'object', properties: { region: { type: 'string', 'x-mcp-header': 'Region' } } }, {}, 'region', { a: 1 }, false);
  assert.equal(hdr.send, false);
  assert.match(hdr.why!, /header/);
});

test('IN-4 and RES-2 (R6-2): a JSON-RPC error that MCP defines for the case is not judged', () => {
  assert.ok(mcpDefinedError({ code: -32602, message: 'Unknown tool: ticket_updat' }));
  assert.ok(mcpDefinedError({ code: -32042, message: 'URL elicitation required' }));
  assert.ok(mcpDefinedError({ code: -32001, message: 'Mcp-Name header does not match the body' }));
  assert.equal(mcpDefinedError({ code: -32602, message: 'priority: expected integer' }), null, 'an argument the tool refused is not a case MCP defines');
  const res = M().resources[0]!;
  const tools = [{ name: 'ticket_get' }, { name: 'ticket_update' }];
  const r = schemaVerdicts([probe({ rpc_error: { code: -32602, message: 'Unknown tool: ticket_update' }, isError: false })], res, tools);
  const in4 = r.find((x) => x.requirement === 'MWS-IN-4' && x.write_path.tool === 'ticket_update')!;
  assert.equal(in4.verdict, 'not tested', in4.reason);
  assert.ok(in4.notes.some((n) => /MCP specification defines/.test(n)));
  // RES-2: no change made → no verdict; a change made → the first two clauses only.
  const none = res2Judge(call({ ok: false, rpc_error: { code: -32042, message: 'URL elicitation required' } }), [], 'backend', 'w');
  assert.equal(none.verdict, 'not tested');
  // Rule 11 (note 19): the second clause is read by declared patterns only; without them a change that remains is not tested.
  assert.equal(res2Judge(call({ ok: false, rpc_error: { code: -32042, message: 'URL elicitation required' } }), ['assignee'], 'backend', 'w').verdict, 'not tested');
  usePatterns({ patterns: DECL } as never);
  const some = res2Judge(call({ ok: false, rpc_error: { code: -32042, message: 'URL elicitation required' } }), ['assignee'], 'backend', 'w');
  const ided = res2Judge(call({ ok: false, rpc_error: { code: -32042, message: 'URL elicitation required; assignee was already set' } }), ['assignee'], 'backend', 'w');
  usePatterns(null);
  // declared-carryover: no declared pattern that means a violation matches, so it needs reading.
  assert.equal(some.verdict, 'not tested');
  assert.match(some.reason, /needs reading/);
  assert.equal(ided.verdict, 'held', 'not violated under the third clause for an error MCP defines');
});

test('RES-2 (R6-4, R6-6, R7-4): content that says the write failed, an unknown resultType, and NF-19', () => {
  // A success where the write failed is the first clause; the third is named only on a declared not_applied pattern (rule 11).
  const failed = res2Judge(call({ ok: true, text: 'Update failed: backend unavailable' }), [], 'backend', 'w');
  assert.equal(failed.verdict, 'violated');
  assert.match(failed.reason, /first clause/);
  assert.match(failed.reason, /Update failed/);
  usePatterns({ patterns: { not_applied: 'update failed' } } as never);
  const failedDecl = res2Judge(call({ ok: true, text: 'Update failed: backend unavailable' }), [], 'backend', 'w');
  usePatterns(null);
  assert.match(failedDecl.reason, /third clause/);
  const plain = res2Judge(call({ ok: true, text: 'Updated.' }), [], 'backend', 'w');
  assert.match(plain.reason, /first clause/);
  const odd = res2Judge(call({ ok: false, result_type: 'deferred' }), [], 'backend', 'w');
  assert.equal(odd.verdict, 'not tested');
  assert.match(odd.reason, /resultType "deferred".*not recognize.*indeterminate/);
  const acc = res2Judge(call({ ok: true, text: 'Accepted; the change is pending.' }), [], 'backend', 'w', {}, { async: true });
  assert.equal(acc.verdict, 'not tested');
  assert.match(acc.reason, /NF-19/);
  const accNotDeclared = res2Judge(call({ ok: true, text: 'Accepted; the change is pending.' }), [], 'backend', 'w', {}, { async: false });
  assert.equal(accNotDeclared.verdict, 'violated', 'for an operation not declared asynchronous, "accepted" is read as a success');
});

test('RES-2 unknown outcome (R6-4): a success that says it failed is the third clause; a write the server undid is judged as a failed write', () => {
  const res = M().resources[0]!;
  const req = { seq: 4, method: 'PATCH', path: '/t/1' };
  const o = (x: Partial<GatedObs['res2u']>): GatedObs => ({ routing: 'loopback', independent: true, learned: [], trials: [], control: null, conc1: null, res2: null, atom: null, res2u: { faulted: req, call: call(), changed: ['assignee'], applied: true, ...x } });
  const v = (x: Partial<GatedObs['res2u']>) => gatedVerdicts(o(x), res).find((r) => r.requirement === 'MWS-RES-2')!;
  assert.equal(v({ call: call({ ok: true, text: 'Updated.' }) }).verdict, 'not tested', 'a success that reports no failure adds no verdict');
  // Rule 11: only a declared not_applied pattern decides the third clause; the default alone gives not tested, quoting the text.
  usePatterns({ patterns: { not_applied: 'update failed' } } as never);
  const said = v({ call: call({ ok: true, text: 'The update failed; try again.' }) });
  usePatterns(null);
  assert.equal(said.verdict, 'violated');
  assert.match(said.reason, /third clause/);
  const saidDefault = v({ call: call({ ok: true, text: 'The update failed; try again.' }) });
  assert.equal(saidDefault.verdict, 'not tested', saidDefault.reason);
  assert.match(saidDefault.reason, /patterns\.not_applied/);
  assert.match(saidDefault.reason, /The update failed/);
  // Review of note 8, 4: a success whose prose or data only looks like a failure is never violated.
  assert.equal(v({ call: call({ ok: true, text: 'Updated ticket T-1 (version 4). Note: this change cannot be undone.' }) }).verdict, 'not tested');
  const inData = v({ call: call({ ok: true, text: 'Updated. {"id":"T-1","description":"login fails on Safari"}', data: { id: 'T-1', description: 'login fails on Safari' } }) });
  assert.equal(inData.verdict, 'not tested');
  assert.doesNotMatch(inData.reason, /patterns\.not_applied/, 'a value in the data is not what the result says');
  assert.equal(v({ call: call({ ok: true, text: '{"id":"T-1","note":"sync failed once"}', data: { id: 'T-1', note: 'sync failed once' } }) }).verdict, 'not tested');
  // The server undid the write: the read-back does not show it; the error is compared with what remains applied.
  const undoneOk = v({ applied: false, changed: [], call: call({ ok: false, isError: true, text: 'The backend did not answer; nothing was changed.' }) });
  assert.equal(undoneOk.verdict, 'held', undoneOk.reason);
  assert.match(undoneOk.reason, /undid/);
  const undoneBad = v({ applied: false, changed: [], call: call({ ok: true, text: 'Updated.' }) });
  assert.equal(undoneBad.verdict, 'violated', 'the server undid the write and reported a success');
  assert.equal(v({ applied: null, changed: null }).verdict, 'not tested');
  // (B): an error that names the changed field or the object but cannot be read is not tested without a declared
  // outcome_unknown pattern; one that names nothing of the write is violated.
  const unread = v({ call: call({ ok: false, isError: true, text: 'The assignee bob could not be saved right now.' }) });
  assert.equal(unread.verdict, 'not tested', unread.reason);
  assert.match(unread.reason, /patterns\.outcome_unknown/);
  assert.equal(v({ object: 'T-4', call: call({ ok: false, isError: true, text: 'Ticket T-4: backend error.' }) }).verdict, 'not tested', 'the object');
  // Rule 11 (note 19): without declared patterns no reading of an error decides; with them, one that neither identifies nor says unknown is violated.
  assert.equal(v({ call: call({ ok: false, isError: true, text: 'The assignee could not be saved right now.' }) }).verdict, 'not tested');
  usePatterns({ patterns: DECL } as never);
  assert.equal(v({ call: call({ ok: false, isError: true, text: 'The assignee could not be saved right now.' }) }).verdict, 'violated');
  assert.equal(v({ call: call({ ok: false, isError: true, text: 'The backend did not answer. It is not known whether the update was applied.' }) }).verdict, 'held');
  usePatterns(null);
  // Re-review 4: a declared not_applied pattern reads a JSON-only success.
  usePatterns({ patterns: { not_applied: 'update failed' } } as never);
  const js = v({ call: call({ ok: true, text: '{"status":"ok","error":"Update failed: the backend did not answer"}', data: { status: 'ok', error: 'Update failed: the backend did not answer' } }) });
  usePatterns(null);
  assert.equal(js.verdict, 'violated', js.reason);
  assert.equal(v({ call: call({ ok: false, isError: true, text: 'Internal error' }) }).verdict, 'not tested', 'rule 11: no declared pattern');
  const odd = v({ call: call({ ok: false, result_type: 'deferred' }) });
  assert.equal(odd.verdict, 'not tested');
  assert.match(odd.reason, /does not recognize/);
});

test('CFG (R7-6): restricting values are sent; a value only some tools accept is CFG-3; a write with no effect holds CFG-2; no tool enabled is not a refusal', () => {
  const ro = M('settings: { read_only: { env: RO, on: "true", valid: { "true": restrict, "1": restrict, "yes": restrict, "false": permit, "0": permit } } }').settings.read_only!;
  assert.deepEqual(ro.restrict.sort(), ['1', 'true', 'yes']);
  const vals = cfg1Values(ro);
  assert.ok(vals.includes('yes') && vals.includes('1'), 'a declared value that restricts writes is sent');
  assert.ok(!vals.includes('false') && !vals.includes('0'), 'a declared value that permits writes is not sent');
  const legacy = M('settings: { read_only: { env: RO, on: "true", valid: ["true", "yes"] } }').settings.read_only!;
  assert.ok(!cfg1Values(legacy).includes('yes'), 'a listed value the declaration does not class is not sent');
  const acc = (tool: string, effect: string | null, ok = true) => ({ tool, absent: false, ok, effect, step: 's', observed: true });
  const base = { baseline: { started: true, reason: null }, cfg2: [], cfg3: null };
  const start = (tools: (ReturnType<typeof acc> & { pending?: boolean; defined?: string })[] | undefined) => ({ value: 'yes', started: true, reason: null, write: { ok: false, changed: true, step: 's' }, ...(tools ? { tools } : {}) });
  const all = launchVerdicts({ ...base, cfg1: { env: 'RO', starts: [start([acc('t_update', 'status'), acc('t_create', 'created T-1')])] } })[0]!;
  assert.equal(all.verdict, 'violated', 'every write tool accepted a write (the read-back shows it, whatever the answer said)');
  const some = launchVerdicts({ ...base, cfg1: { env: 'RO', starts: [start([acc('t_update', 'status'), acc('t_create', null, false)])] } })[0]!;
  assert.equal(some.verdict, 'held', some.reason);
  assert.ok(some.notes.some((n) => /Observation.*MWS-CFG-3/.test(n)));
  assert.equal(launchVerdicts({ ...base, cfg1: { env: 'RO', starts: [start(undefined)] } })[0]!.verdict, 'not tested');
  const ctl = launchVerdicts({ ...base, cfg1: { env: 'RO', starts: [start([acc('t_update', 'status'), acc('t_bulk', null, true)])], baseline_tools: [acc('t_update', 'status'), acc('t_bulk', null, true)] } })[0]!;
  assert.equal(ctl.verdict, 'violated', 'a tool that writes nothing without the setting either is not compared (positive control)');
  assert.ok(ctl.notes.some((n) => /Positive control: .*t_bulk wrote nothing even then/.test(n)));
  assert.equal(launchVerdicts({ ...base, cfg1: { env: 'RO', starts: [start([acc('t_update', 'status'), { ...acc('t_close', null, true), pending: true }])] } })[0]!.verdict, 'violated', 'an input_required answer with no write is not a refusal');
  assert.equal(launchVerdicts({ ...base, cfg1: { env: 'RO', starts: [start([acc('t_update', 'status'), { ...acc('t_close', null, false), defined: 'a missing client capability' }])] } })[0]!.verdict, 'violated', 'an error MCP defines for the case is not a refusal by the setting');
  const deny = (calls: ReturnType<typeof acc>[]) => launchVerdicts({ ...base, cfg1: null, cfg2: [{ env: 'DENY', kind: 'deny', value: 'x', started: true, reason: null, calls }] })[0]!;
  assert.equal(deny([acc('t_update', null, true)]).verdict, 'held', 'a write tool that had no effect');
  assert.equal(deny([{ ...acc('t_update', null, true), observed: false }]).verdict, 'not tested', 'no effect cannot be shown without a read-back');
  const none = launchVerdicts({ ...base, cfg1: null, cfg2: [{ env: 'TOOLS', kind: 'allow', value: 'a,b', started: false, reason: 'tools/list: no tools are enabled', list_error: 'no tools are enabled' }] })[0]!;
  assert.equal(none.verdict, 'not tested', none.reason);
});

test('SEC-1 (R7-7, NF-25): a general pattern is listed, never violated; canaries are only in credential stores', () => {
  const v = secretVerdicts({ results: 2, errors: 0, by_tool: { t_get: 2 }, hits: [{ step: 's', tool: 't_get', isError: false, kind: 'pattern', name: 'bearer token' }], values: ['CANARY'] }, [], ['CANARY']);
  assert.equal(v[0]!.verdict, 'not observed');
  assert.ok(v[0]!.notes.some((n) => /NF-25/.test(n)));
  assert.ok(v[0]!.notes.some((n) => /credential store or a credential-typed field/.test(n)));
});

test('RES-4 (R7-5): the receipt is checked for each field the call changed, as the read-back shows, apart from server-managed fields', () => {
  const res = M().resources[0]!;
  const ctx = { manifest: M(), tools: [] };
  const o = (text: string, changed: { path: string; after: unknown }[] | null) => ({ creates: [], failures: [], delete_case: null, jobs: [], update_receipt: { id: 'T-1', call: call({ text }), field: 'assignee', arg: 'assignee', value: 'bob', version: null, read_keys: null, changed } });
  const r4 = (text: string, changed: { path: string; after: unknown }[] | null) => createsVerdicts(o(text, changed) as never, res, ctx).find((r) => r.requirement === 'MWS-RES-4')!;
  assert.equal(r4('T-1 updated: assignee=bob', [{ path: 'assignee', after: 'bob' }]).verdict, 'held');
  const v = r4('T-1 updated: assignee=bob', [{ path: 'assignee', after: 'bob' }, { path: 'status', after: 'triaged' }]);
  assert.equal(v.verdict, 'violated', 'a field the call also changed is not in the receipt');
  assert.match(v.reason, /status/);
  assert.equal(r4('T-1 updated: assignee=bob, status triaged', [{ path: 'assignee', after: 'bob' }, { path: 'status', after: 'triaged' }]).verdict, 'held');
  assert.equal(r4('T-1 updated: assignee=bob', null).verdict, 'held', 'without a read-back the field the call named is checked');
});

const tc = (o: Partial<NonNullable<CaseObs['tool']>> = {}): NonNullable<CaseObs['tool']> => ({ ok: true, isError: false, rpc_error: null, text: 'ok', diff: [], applied: true, settled: true, reads: 1, steps: ['s'], ...o });

test('rule 13 (R7-2): UPD-1 and RES-1 combine their calls into one verdict and the record states what each call showed; RES-1 platform needs the API to say the change was made', () => {
  const res = M().resources[0]!;
  const by = (r: ReturnType<typeof readbackVerdicts>, id: string) => r.find((x) => x.requirement === id)!;
  const r = readbackVerdicts([
    { case: 'set_field', value: 'bob', tool: tc({ diff: [{ path: 'assignee', kind: 'changed' }] }), control: null },
    { case: 'invalid_type', value: 1, tool: tc({ ok: false, isError: true }), control: null },
    { case: 'explicit_null', value: null, named: 'assignee', tool: tc({ diff: [{ path: 'assignee', kind: 'changed' }], applied: false }), control: null, null_effect: 'cleared' },
    { case: 'nested_subfield', value: { a: 1 }, named: 'details.a', tool: null, control: null, skipped: 'scratch object: no create' },
  ], res);
  const u = by(r, 'MWS-UPD-1');
  assert.equal(u.verdict, 'held');
  assert.ok(u.notes.some((n) => /Each call: set_field .*assignee.*: success; only the named field changed; invalid_type.*refused.*explicit_null.*nested_subfield.*not run \(scratch object: no create\)/.test(n)), u.notes.join(' | '));
  assert.ok(by(r, 'MWS-RES-1').notes.some((n) => /Each call: set_field.*in effect/.test(n)));
  // The platform's answer was 202 Accepted: it does not say the change was made, so no platform verdict.
  const acc = readbackVerdicts([{ case: 'set_field', value: 'bob', tool: tc({ applied: false, diff: [] }), control: { status: 202, diff: [], applied: false } }], res);
  assert.equal(by(acc, 'MWS-RES-1').verdict, 'violated');
  assert.equal(by(acc, 'MWS-RES-1').attribution, 'unresolved');
  const plat = readbackVerdicts([{ case: 'set_field', value: 'bob', tool: tc({ applied: false, diff: [] }), control: { status: 200, diff: [], applied: false } }], res);
  assert.equal(by(plat, 'MWS-RES-1').verdict, 'platform');
});

test('UPD-1 (R7-5): the explicit null probe lists every nullable field, so the one the first read shows set is used; the nested probe needs declared, omittable sub-fields', () => {
  const res = M().resources[0]!;
  const probes = furtherProbes({ type: 'object', properties: { id: { type: 'string' }, assignee: { type: ['string', 'null'] }, due: { type: ['string', 'null'] }, details: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, required: ['a', 'b'] } } }, res);
  const n = probes.find((p) => p.name === 'explicit_null')!;
  assert.deepEqual(n.alts.map((a) => a.prop), ['assignee', 'due']);
  assert.ok(!probes.some((p) => p.name === 'nested_subfield'), 'all sub-fields required: the nested object is one field');
});

test('ATOM-1 (R7-5): a result that names the failed items and says all others were applied names both sets; a count with the failed ids meets it for a selector write', () => {
  const m = parseManifestText(`mws: "0.9"
server: { stdio: [node, s.js] }
target: { environment: test, confirm: t }
resources:
  - name: ticket
    create: { tool: t_create, args: { title: "{{marker}}" }, id: id }
    read: { tool: t_get, args: { id: "{{id}}" } }
    list: { tool: t_list, args: {}, items: tickets, id: id, name: title }
    cleanup: delete
    delete: { tool: t_delete, args: { id: "{{id}}" } }
    multi:
      - { tool: t_bulk, args: { ids: "{{ids}}", status: closed }, effect: { path: status, value: closed }, invalid_id: T-0 }
      - { tool: t_del, args: { project: "{{?scope}}", title_prefix: "{{batch}}" }, effect: deleted }
`, 'm.yaml').resources[0]!;
  const o = (tool: string, trials: MultiObs['trials']): MultiObs => ({ tool, routing: null, mutating_in_learning: null, trials });
  const t = (text: string, items: string[], applied: string[]) => ({ kind: 'failed backend write' as const, position: '2nd', call: call({ ok: false, isError: true, text }), items, applied, reported: null });
  const v = (tool: string, i: number, x: ReturnType<typeof t>) => multiVerdicts(o(tool, [x]), m, m.multi[i]!)[0]!;
  assert.equal(v('t_bulk', 0, t('T2 failed (backend 500); all other tickets were updated', ['T1', 'T2', 'T3'], ['T1', 'T3'])).verdict, 'held');
  assert.equal(v('t_bulk', 0, t('T2 failed (backend 500)', ['T1', 'T2', 'T3'], ['T1', 'T3'])).verdict, 'violated', 'the applied items are neither named nor covered by "all others"');
  assert.equal(v('t_bulk', 0, t('nothing was applied', ['T1', 'T2'], [])).verdict, 'held', 'a result that says nothing was applied names every item as not applied');
  assert.equal(v('t_del', 1, t('deleted 2 tickets; T2 could not be deleted', ['T1', 'T2', 'T3'], ['T1', 'T3'])).verdict, 'held', 'a count with the ids not applied, for a selector write');
  assert.equal(v('t_bulk', 0, t('updated 2 tickets; T2 could not be updated', ['T1', 'T2', 'T3'], ['T1', 'T3'])).verdict, 'violated', 'the count rule is for a selector write');
});

test('5.3 and rule 10: the record states the revision, transport and declared capabilities, and what the tester answered to a request for input', () => {
  const m = M();
  const x = mcpRecord(m, '2026-07-28', [{ step: 'c1', tool: 'ticket_update', method: 'elicitation/create', answer: 'a JSON-RPC error -32601' }]);
  assert.match(mcpLine(x), /MCP revision 2026-07-28 over stdio\. Client capabilities declared: none .*Extensions declared: none\./);
  assert.equal(x.patterns.not_used.from, 'default');
  const rs = [result('MWS-RES-2', { resource: 'ticket', tool: 'ticket_update', arm: 'mcp' }, { id: 'x', version: '1' }, 'held', 'r', { steps: ['c1'] }), result('MWS-TGT-3', { resource: 'ticket', tool: 'ticket_create', arm: 'mcp' }, { id: 'x', version: '1' }, 'held', 'r')];
  annotateInputs(rs, x);
  assert.ok(rs[0]!.notes.some((n) => /During c1 .*elicitation\/create.*the tester answered: a JSON-RPC error -32601/.test(n)));
  assert.ok(rs[1]!.notes.some((n) => /no confirmation was asked for or declined.*was not tested/.test(n)));
});

test('RES-1: a refused delete adds no verdict (rule 13), and NF-19 holds back a verdict for a declared asynchronous operation', () => {
  const res = M().resources[0]!;
  const base = { creates: [], failures: [], update_receipt: null, jobs: [] };
  const del = (c: Partial<CallBrief>, gone: boolean, extra = '') => createsVerdicts({ ...base, delete_case: { call: call(c), gone } } as never, res, { manifest: M(extra), tools: [] }).find((r) => r.requirement === 'MWS-RES-1')!;
  assert.equal(del({ ok: false, isError: true, text: 'refused' }, false).verdict, 'not tested', 'a refusal did not report success');
  assert.equal(del({ ok: true, text: 'Deletion accepted; pending.' }, false).verdict, 'violated', 'not declared asynchronous: "accepted" is a success');
  assert.equal(del({ ok: true, text: 'Deletion accepted; pending.' }, false, 'async_operations: [ticket_delete]').verdict, 'not tested');
  // read-after-write: the update tool declared asynchronous
  const rb = readbackVerdicts([{ case: 'set_field', value: 'bob', tool: tc({ applied: false, diff: [], text: 'Update queued (pending).' }), control: null }], res, [], ['ticket_update']);
  assert.equal(rb.find((r) => r.requirement === 'MWS-RES-1')!.verdict, 'not tested');
});

test('7.3 rule 1 (R6-3): no probe replaces, removes or misspells an identifier, a scope argument or a selector of a write tool, and the record says so', () => {
  const cases = probeCases({ type: 'object', properties: { project: { type: 'string' }, ids: { type: 'array' } }, required: ['project'] }, new Set(['project', 'ids']));
  assert.ok(!cases.some((c) => c.name === 'misspelled_argument'), 'a protected argument is not misspelled either');
  assert.ok(cases.some((c) => c.name === 'undefined_argument'), 'the unrelated probe remains');
  const res = M().resources[0]!;
  const tools = [{ name: 'ticket_get' }, { name: 'ticket_update', inputSchema: { type: 'object', properties: { id: { type: 'string' }, project: { type: 'string' } } } }];
  const r = schemaVerdicts([], res, tools, null, {}, { ticket_update: ['id', 'project'] });
  const in1 = r.find((x) => x.requirement === 'MWS-IN-1' && x.write_path.tool === 'ticket_update')!;
  assert.equal(in1.verdict, 'not tested', 'no other probe remains');
  assert.ok(in1.notes.some((n) => /Not probed \(spec 7\.3, rule 1.*id, project/.test(n)), in1.notes.join(' | '));
});

test('gate-2 K8s B18: a CFG-3 record left open by a declared write tool the tester has no call for names what to declare', () => {
  const refused = (tool: string, absent: boolean) => ({ tool, absent, ok: false, effect: null, step: 's', observed: true });
  const v = launchVerdicts({ baseline: { started: true, reason: null }, cfg1: null, cfg2: [], cfg3: { env: 'RO', started: true, reason: null, calls: [refused('resources_create_or_update', true), refused('resources_delete', true), { tool: 'helm_uninstall', absent: true, ok: false, effect: null, step: null }] } })[0]!;
  // why: the spec calls each declared write tool "whether or not it is listed"; one not called stays open (no false held).
  assert.equal(v.verdict, 'not tested', v.reason);
  assert.match(v.reason, /helm_uninstall/);
  assert.match(v.reason, /calls\.helm_uninstall/, 'the reason names the manifest key that gives the tester a call');
  assert.doesNotMatch(v.reason, /answered as a success/, 'no tool was answered as a success');
  const ok = launchVerdicts({ baseline: { started: true, reason: null }, cfg1: null, cfg2: [], cfg3: { env: 'RO', started: true, reason: null, calls: [refused('resources_create_or_update', true), { tool: 'resources_delete', absent: false, ok: true, effect: null, step: 's', observed: true }] } })[0]!;
  assert.equal(ok.verdict, 'not tested');
  assert.match(ok.reason, /resources_delete was answered as a success/);
});

test('gate-2 Grafana N3: a planned proxy-assisted MWS-CONC-1 that did not run is a not tested record with the reason, never no record', () => {
  const ctl = '    control: { base: "http://127.0.0.1:1", read: { http: [GET, "/t/{{id}}"] }, patch: { http: [PATCH, "/t/{{id}}"], body: { "{{field}}": "{{value}}" } }, write: { http: [PUT, "/t/{{id}}"], body: "{{object}}" } }';
  const res = M(ctl).resources[0]!;
  const o = (x: Partial<GatedObs>): GatedObs => ({ routing: 'loopback', learned: [], trials: [], control: null, conc1: null, res2: null, atom: null, ...x });
  const c1 = (x: Partial<GatedObs>) => gatedVerdicts(o(x), res).filter((r) => r.requirement === 'MWS-CONC-1');
  const notIndep = c1({ independent: false, skipped: 'the two fields are not independent one after the other (writing assignee and status in sequence, in both orders, did not keep both); see MWS-UPD-1' });
  assert.deepEqual(notIndep.map((r) => r.verdict), ['not tested']);
  assert.match(notIndep[0]!.reason, /not independent/);
  const noHold = c1({ independent: true, learned: [{ field: 0, requests: [], hold: null }] });
  assert.deepEqual(noHold.map((r) => r.verdict), ['not tested']);
  assert.match(noHold[0]!.reason, /no mutating request/);
  // A tool that takes a version is the stale-write check's: no proxy-assisted CONC-1 record here.
  assert.equal(gatedVerdicts(o({ independent: true }), { ...res, version: { ...res.version!, arg: 'version' } }).filter((r) => r.requirement === 'MWS-CONC-1').length, 0);
});

test('MWS-CFG-3: an unlisted tool called anyway that answered as a success is not held unless its read-back ran', () => {
  const run = (observed: boolean | undefined) => launchVerdicts({ baseline: { started: true, reason: null }, cfg1: null, cfg2: [], cfg3: { env: 'RO', started: true, reason: null, calls: [{ tool: 't_update', absent: true, ok: true, effect: null, step: 's', ...(observed === undefined ? {} : { observed }) }] } } as never).find((r) => r.requirement === 'MWS-CFG-3')!;
  assert.equal(run(undefined).verdict, 'not tested');
  assert.equal(run(false).verdict, 'not tested');
  assert.equal(run(true).verdict, 'held');
});
