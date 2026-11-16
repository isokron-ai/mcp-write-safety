/**
 * The rule-11 coverage package, first set (approved 15 Nov 2026):
 *
 *   structured signals first   MWS-CONC-2 and MWS-IN-4 read 409/412, a Kubernetes Status reason, error codes and the SDK
 *                              validation strings before any text, and the record names the source
 *   outcome_field              a declared structured outcome field decides what a result says about the outcome
 *   MWS-CFG-4 echo rule        an error naming the misspelled tool the tester invented refuses the list
 *   positive match only        (declared-carryover; see r9-r10.test.ts)
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { launchVerdicts, listErrorMessage, namesInvented } from '../../src/checks/launch.js';
import { givesOutcome } from '../../src/checks/retry2.js';
import { outcomeByField, usePatterns } from '../../src/checks/says.js';
import { refusedBy, schemaVerdicts, type ProbeObs } from '../../src/checks/schema.js';
import { conflictSignal, rejectSignal, versionRequiredSignal } from '../../src/checks/signals.js';
import { deleteVerdicts, shownBy, type DelObs } from '../../src/checks/stale.js';
import { readSecondClause, res2Judge, type CallBrief } from '../../src/checks/types.js';
import { parseManifestText } from '../../src/core/manifest.js';

const M = (extra = '') =>
  parseManifestText(
    `mws: "0.9"
server: { stdio: [node, s.js] }
target: { environment: test, confirm: t }
resources:
  - name: ticket
    create: { tool: ticket_create, args: { title: "{{prefix}}t" }, id: id }
    read: { tool: ticket_get, args: { id: "{{id}}" }, object: ticket }
    update: { tool: ticket_update, mode: full_replace, args: { id: "{{id}}", ticket: "{{object}}", version: "{{version}}" } }
    fields: [ { path: assignee, values: [ann, bob] }, { path: status, values: [blocked, closed] } ]
    version: { read: version, arg: version, optional: true }
    cleanup: delete
    delete: { tool: ticket_delete, args: { id: "{{id}}", version: "{{version}}" } }
${extra}`,
    'm.yaml',
  );
const call = (o: Partial<CallBrief> = {}): CallBrief => ({ step: 's', ok: true, isError: false, rpc_error: null, text: '', data: null, indeterminate: false, ...o });
const err = (text: string, data: unknown = null) => call({ ok: false, isError: true, text, data });

// Owner's decision on review item S1 (15 Nov 2026): only a structured field decides; a status, a message or an SDK string in
// free text decides nothing.
test('conflict signals (strict): a structured 409/412, a Kubernetes Status, a conflict code or conflict: true; never text', () => {
  const k8s = { kind: 'Status', apiVersion: 'v1', status: 'Failure', message: 'Operation cannot be fulfilled on configmaps "x": the object has been modified', reason: 'Conflict', code: 409 };
  assert.match(conflictSignal(err(JSON.stringify(k8s), k8s))!.source, /Kubernetes Status with reason Conflict/);
  assert.match(conflictSignal(err('refused', { error: { code: 'version_conflict', current_version: 7 } }))!.source, /conflict code "version_conflict"/);
  assert.match(conflictSignal(err('', { status: 409 }))!.source, /HTTP status 409 in the field status/);
  assert.match(conflictSignal(call({ text: 'ok', data: { conflict: true } }))!.source, /conflict: true/);
  // text decides nothing, however clear
  for (const t of ['update failed (status 409): version mismatch', 'HTTP 412 Precondition Failed', 'request failed, status: 409', 'Operation cannot be fulfilled on dashboards.grafana.app "d1": the object has been modified; please apply your changes to the latest version and try again', JSON.stringify(k8s), 'HTTP status 500', 'A conflict of interest was noted.']) assert.equal(conflictSignal(err(t)), null, t);
  assert.match(versionRequiredSignal(err('', { code: 'precondition_required' }))!.source, /version-required code/);
  assert.equal(versionRequiredSignal(err('HTTP 428 Precondition Required')), null);
});

test('validation signals (strict): JSON-RPC -32602 as the error code, or a validation code; never an SDK string in text', () => {
  assert.match(rejectSignal(call({ ok: false, rpc_error: { code: -32602, message: 'Invalid params' }, text: null }))!.source, /-32602/);
  assert.match(rejectSignal(err('refused', { error: { code: 'invalid_argument' } }))!.source, /validation code/);
  for (const t of ['MCP error -32602: Input validation error: Invalid arguments for tool ticket_update: []', 'unknown argument "x"; valid arguments: id', 'invalid arguments: json: cannot unmarshal string into Go struct field UpdateArgs.priority of type int', '1 validation error for ticket_updateArguments\npriority\n  Input should be a valid integer', 'ConfigMap "x" is invalid: metadata.name: Invalid value: "A_B"', 'Ticket T-9 not found.']) assert.equal(rejectSignal(err(t)), null, t);
});

test('IN-4 / R10-3: a structured signal decides the refusal first, and the record names the source', () => {
  assert.match(refusedBy({ text: 'refused', data: { error: { code: 'invalid_argument' } }, rpc_error: null }, 'priority')!, /validation code/);
  assert.equal(refusedBy({ text: 'invalid arguments: json: cannot unmarshal string into Go struct field UpdateArgs.prio of type int', rpc_error: null }, 'priority'), null, 'an SDK string in text decides nothing (S1)');
  assert.equal(refusedBy({ text: 'the call failed', rpc_error: null }, 'priority'), null, 'no signal, not named, no declared pattern: cannot tell');
  assert.equal(refusedBy({ text: 'priority must be an integer', rpc_error: null }, 'priority'), 'the error names the argument');
  const res = M().resources[0]!;
  const tools = [{ name: 'ticket_update', inputSchema: { type: 'object', properties: { id: { type: 'string' }, priority: { type: 'integer' } } } }];
  const p: ProbeObs = { tool: 'ticket_update', role: 'update', prop: 'priority', name: 'non_numeric_string', requirement: 'MWS-IN-1', value: '"abc"', sent: 'abc', type: 'integer', required: false, ok: false, isError: true, rpc_error: null, text: 'priority: invalid', step: 's', refused_by: 'a validation code "invalid" in the field code ("…")' };
  const in4 = schemaVerdicts([p], res, tools as never).find((r) => r.requirement === 'MWS-IN-4' && r.verdict !== 'not tested' && !/review/.test(r.scenario.id))!;
  assert.equal(in4.verdict, 'held', in4.reason);
  assert.ok(in4.notes.some((n) => /known to refuse the probed value by: a validation code "invalid" in the field code \(1\)/.test(n)), in4.notes.join(' | '));
});

const rep = (del: CallBrief, o: Partial<DelObs['reps'][number]> = {}) => ({ version: 3, del, gone: false, other_kept: true, steps: ['s'], current_version: 4, ...o });

test('CONC-2: a structured conflict signal is counted and named; a quiet answer read only by built-in words needs reading', () => {
  const m = M();
  const res = m.resources[0]!;
  const ctx = { manifest: m, tools: [] };
  const by = (rs: ReturnType<typeof deleteVerdicts>, id: string) => rs.find((r) => r.requirement === id)!;
  const held = deleteVerdicts({ tool: 'ticket_update', kind: 'write', positive: { ok: true, effect: true, step: 'p' }, control: null, reps: [rep(err('{"reason":"Conflict","code":409}', { reason: 'Conflict', code: 409 })), rep(err('stale version'))] }, res, ctx);
  assert.equal(by(held, 'MWS-CONC-2').verdict, 'held');
  assert.ok(by(held, 'MWS-CONC-2').notes.some((n) => /1 of 2 refusal\(s\) carried a structured conflict signal: a Kubernetes Status with reason Conflict \(1\)/.test(n)));
  // a success that applied nothing: a signal makes it a refusal returned as an ordinary result; built-in words alone do not
  const quietSig = deleteVerdicts({ tool: 'ticket_update', kind: 'write', positive: { ok: true, effect: true, step: 'p' }, control: null, reps: [rep(call({ text: 'Not saved.', data: { conflict: true } }))] }, res, ctx);
  assert.equal(by(quietSig, 'MWS-CONC-2').verdict, 'held');
  assert.equal(by(quietSig, 'MWS-CONC-4').verdict, 'violated', 'a refused conflict returned without isError');
  const quietWords = deleteVerdicts({ tool: 'ticket_update', kind: 'write', positive: { ok: true, effect: true, step: 'p' }, control: null, reps: [rep(call({ text: 'Conflict: nothing was written.' }))] }, res, ctx);
  assert.equal(by(quietWords, 'MWS-CONC-2').verdict, 'not tested');
  assert.match(by(quietWords, 'MWS-CONC-2').reason, /needs reading/);
  assert.notEqual(by(quietWords, 'MWS-CONC-4').verdict, 'violated', 'no violated on built-in words');
  assert.equal(shownBy({ text: 'Conflict: nothing was written.' }), 'default');
  assert.equal(shownBy({ text: 'x', data: { error: { code: 'version_conflict' } } }), 'signal');
  assert.equal(shownBy({ text: 'Saved.' }), null);
});

test('CONC-2, version left out: a structured 409 or 428 is row 1; a 409 in free text is not (S1)', () => {
  const m = M();
  const res = m.resources[0]!;
  const ctx = { manifest: m, tools: [] };
  const o = (d: CallBrief): DelObs => ({ tool: 'ticket_update', kind: 'write', version_left_out: true, positive: { ok: true, effect: true, step: 'p' }, control: null, reps: [rep(d)] });
  const k = deleteVerdicts(o(err('request failed', { status: 409 })), res, ctx)[0]!;
  assert.equal(k.verdict, 'held', k.reason);
  assert.ok(k.notes.some((n) => /row 1 by: HTTP status 409 in the field status \(1\)/.test(n)), k.notes.join(' | '));
  // S1: an unrelated 409 in free text gives no held
  const t = deleteVerdicts(o(err('the audit service answered (status 409) while logging; nothing else to say')), res, ctx)[0]!;
  assert.notEqual(t.verdict, 'held', t.reason);
  const p = deleteVerdicts(o(err('refused', { code: 'precondition_required' })), res, ctx)[0]!;
  assert.equal(p.verdict, 'held');
  const none = deleteVerdicts(o(err('Request refused.')), res, ctx)[0]!;
  assert.equal(none.verdict, 'not tested', 'no signal, the version not named, no declared pattern');
});

test('outcome_field: parsed and checked at load; it decides RES-2 and RETRY-2 readings, and the record says so', () => {
  const m = M('outcome_field: { path: written, applied: "yes", not_applied: "no", unknown: "unknown" }\n');
  assert.deepEqual(m.outcome_field, { path: 'written', applied: ['yes'], not_applied: ['no'], unknown: ['unknown'] });
  assert.throws(() => M('outcome_field: { path: written }\n'), /at least one/);
  assert.throws(() => M('outcome_field: { path: written, applied: x, unknown: x }\n'), /only one outcome/);
  usePatterns(m);
  try {
    assert.equal(outcomeByField({ data: { written: 'unknown' } })!.outcome, 'unknown');
    assert.equal(outcomeByField({ data: { written: 'maybe' } }), null, 'a value the declaration does not list decides nothing');
    assert.equal(outcomeByField({ data: null }), null);
    const u = readSecondClause(err('The backend could not be reached.', { written: 'unknown', error: 'connection_failed' }), ['assignee']);
    assert.equal(u.v, 'held');
    assert.match(u.notes[0]!, /declared outcome field outcome_field.path "written" = "unknown"/);
    const n = readSecondClause(err('Something happened.', { written: 'no' }), ['assignee']);
    assert.equal(n.v, 'violated', 'a positive statement in the declared field');
    const s = res2Judge(call({ text: 'Done', data: { written: 'no' } }), [], 'backend', 'w');
    assert.equal(s.verdict, 'violated', 'a success whose declared field says not applied (third clause)');
    const d = { kind: 'update' } as never;
    assert.equal(givesOutcome(null, { ...err('x', { written: 'yes' }), id: null, version: null } as never, d, null).gives, true);
    assert.equal(givesOutcome(null, { ...err('x', { written: 'unknown' }), id: null, version: null } as never, d, null).gives, false);
  } finally {
    usePatterns(null);
  }
  assert.equal(readSecondClause(err('Something happened.', { written: 'no' }), ['assignee']).v, 'unread', 'without the declaration the field decides nothing');
});

test('MWS-CFG-4 echo rule (S1): an error naming the exact invented tool refuses the list; anything else needs reading', () => {
  const base = { baseline: { started: true, reason: null }, cfg1: null, cfg3: null };
  const f = (list_error: string) => ({ env: 'TOOLS', kind: 'allow', value: 'ticket_get,itcket_update', started: false, reason: `the server started and refused tools/list: ${list_error}`, list_error, invented: 'itcket_update' });
  const cfg4 = (e: string) => launchVerdicts({ ...base, cfg2: [f(e)] } as never)[0]!;
  // the research harness's fake2 texts (378f32f), with their truth
  const yes = cfg4('tools/list failed on LAUNCH.cfg4: {"code":-32603,"message":"the allow-list names a tool this server does not have: itcket_update"}');
  assert.equal(yes.verdict, 'held', yes.reason);
  assert.ok(yes.notes.some((n) => /echo rule/.test(n)));
  assert.equal(cfg4('no tools are enabled').verdict, 'not tested');
  assert.equal(cfg4('Keine Werkzeuge aktiviert.').verdict, 'not tested');
  assert.equal(cfg4('the allow-list was refused, not because no tool is enabled but because itcket_update is not a tool').verdict, 'held', 'S1: it names the exact invented tool');
  assert.equal(cfg4('E_LIST_3').verdict, 'not tested', 'S1: an error without the invented name is not tested');
  assert.equal(cfg4('unknown tool: itcket_updates').verdict, 'not tested', 'a different name');
  assert.equal(listErrorMessage('tools/list failed on L: {"code":-32603,"message":"m"}'), 'm');
  assert.equal(namesInvented({ env: 'T', value: 'a,itcket_update', list_error: 'unknown tool: itcket_update' })!.invented, 'itcket_update', 'older records: the invented name is the last list item');
});

test('review of 6d07a9f: the reviewer\'s inputs give no false verdict', async () => {
  const { withLoss } = await import('../../src/checks/targeting.js');
  const { result } = await import('../../src/report/verdicts.js');
  const { safeCommand } = await import('../../src/cli/commands.js');
  const withP = <T>(p: Record<string, unknown>, f: () => T): T => {
    usePatterns(p as never);
    try {
      return f();
    } finally {
      usePatterns(null);
    }
  };
  // 1: a failure that names every change is not violated
  assert.notEqual(withP({ patterns: { not_applied: 'failed' } }, () => readSecondClause(err('Failed to update labels; the title was updated to "New".'), ['title'], { title: 'New' })).v, 'violated');
  // 2: a status or code inside an echoed object, or prose, is not a conflict signal
  assert.equal(shownBy({ text: '{"id":7,"area":{"code":"412"}}' }), null);
  assert.equal(shownBy({ text: 'ok', data: { kind: { type: 'conflict' } } }), null);
  assert.equal(shownBy({ text: 'ok', data: { id: 7, area: { code: 412 } } }), null);
  assert.equal(conflictSignal(err('status 409 orders processed')), null);
  assert.equal(conflictSignal(err('', { id: 7, area: { code: 412 } })), null, 'nested in an echoed object');
  assert.equal(conflictSignal(err('x', { code: '409' })), null, 'a string under code is not a status');
  // 3: a bracket whose inventory could not be taken blocks held
  const h = result('MWS-UPD-1', { resource: 'ticket', tool: 't', arm: 'mcp' } as never, { id: 'x', version: '1' }, 'held', 'r');
  assert.equal(withLoss(h, [], false, [{ gone: [], changed: [], unavailable: 'the inventory before the check could not be taken' }]).verdict, 'not tested');
  // 4: the echo rule fails closed on other scripts, on negations and on "no tools"
  for (const e of ['xrceate_issue unknown', 'rceate_issue2 unknown', 'no tools enabled']) assert.equal(namesInvented({ env: 'T', value: 'a,rceate_issue', list_error: e, invented: 'rceate_issue' }), null, e);
  assert.equal(namesInvented({ env: 'T', value: 'a,rceate_issue', list_error: `${'x'.repeat(10)} rceate_issue…`, invented: 'rceate_issue' }), null, 'a clipped error');
  assert.ok(namesInvented({ env: 'T', value: 'a,rceate_issue', list_error: 'no such tool: rceate_issue', invented: 'rceate_issue' }));
  // 5: a field that says not applied beside text that says the outcome is unknown is read, not violated
  withP({ outcome_field: { path: 'status', applied: ['ok'], not_applied: ['failed'], unknown: [] } }, () => assert.equal(readSecondClause(err('It is not known whether the change was applied', { status: 'failed' }), ['title']).v, 'unread'));
  // 6: credentials never printed
  for (const a of [['--headers', '{"Authorization":"Bearer sk_live_abc"}'], ['-H', 'X-Api-Key=abcdef'], ['Authorization: Bearer abc'], ['{"api_key":"v1"}']]) {
    const s = safeCommand(['srv', ...a]);
    assert.ok(!/sk_live_abc|abcdef|Bearer abc|v1/.test(s), s);
  }
  // 7: a -32602 not-found does not refuse the probed value
  assert.equal(refusedBy({ text: null, rpc_error: { code: -32602, message: 'User zz not found' } }, 'user'), null);
});

test('re-review of a6b111e: no false violated where the answer may name the change; no held against the field; no credential printed', async () => {
  const { safeCommand } = await import('../../src/cli/commands.js');
  const withP = <T>(p: Record<string, unknown>, f: () => T): T => {
    usePatterns(p as never);
    try {
      return f();
    } finally {
      usePatterns(null);
    }
  };
  // 1: patterns.applied declared but not matching; the default reading or the bare new value names the change
  const P = { patterns: { not_applied: 'failed|could not', applied: 'was saved' } };
  for (const t of ['Failed to update labels; the title was updated to "New".', 'Failed: labels. The title is now "New".', 'Failed on labels. New title set.']) assert.notEqual(withP(P, () => readSecondClause(err(t), ['title'], { title: 'New' })).v, 'violated', t);
  assert.equal(withP(P, () => readSecondClause(err('Could not save the title New right now.'), ['title'], { title: 'New' })).v, 'violated', 'a negated clause naming the value is still a stated failure');
  // 2: a field that says not applied beside text that names the change, or says unknown, is read, not held
  const F = { outcome_field: { path: 'outcome', applied: [], not_applied: ['failed'], unknown: [] } };
  assert.equal(withP({ ...F, patterns: { applied: 'updated' } }, () => readSecondClause(err('Something broke; the title was updated to "New".', { outcome: 'failed' }), ['title'], { title: 'New' })).v, 'unread');
  assert.equal(withP({ ...F, patterns: { outcome_unknown: 'not known whether' } }, () => readSecondClause(err('It is not known whether it was applied.', { outcome: 'failed' }), ['title'])).v, 'unread');
  // 3: credentials inside sh -c strings, NAME=value anywhere, URL user information, nested and single-quoted keys
  for (const a of [['sh', '-c', 'node s.js --api-key=S3CR3T'], ['sh', '-c', 'node s.js --password S3CR3T'], ['sh', '-c', 'export GITHUB_TOKEN=S3CR3T; node s.js'], ['DB_URL=postgres://u:S3CR3T@h/db'], ['--opt', '{"auth":{"user":"u","value":"S3CR3T"}}'], ["{'token': 'S3CR3T'}"], ['x token: S3CR3T'], ['a=1&password=S3CR3T']]) {
    const s = safeCommand(['srv', ...a]);
    assert.ok(!s.includes('S3CR3T'), s);
  }
  assert.equal(safeCommand(['node', 'server.js', '--port', '3000']), 'node server.js --port 3000');
  // low: "status: 409" in a client error; an apostrophe-quoted invented name; an SDK message listing not_found
  assert.equal(conflictSignal(err('request failed, status: 409')), null, 'S1: text decides nothing');
  assert.ok(namesInvented({ env: 'T', value: 'a,itcket_update', list_error: "unknown tool 'itcket_update'", invented: 'itcket_update' }));
  assert.match(refusedBy({ text: 'refused: status must be one of open, not_found', data: { error: { code: 'invalid_argument' } }, rpc_error: null }, 'priority') ?? 'null', /validation code|null/, 'S1: no SDK string decides; a not-found word may leave it to reading');
});

test('patterns.conflict: a quiet conflict without a structured signal counts only where the declared pattern reads it', () => {
  const t = { text: 'Request failed with status 412. Nothing was written.', data: { written: false } };
  assert.equal(shownBy(t), 'default');
  usePatterns({ patterns: { conflict: '\\bstatus 412\\b' } } as never);
  try {
    assert.equal(shownBy(t), 'signal');
    assert.equal(shownBy({ text: 'Saved.', data: null }), null);
  } finally {
    usePatterns(null);
  }
});
