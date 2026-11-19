/**
 * MWS-RES-2 on every declared write call (B-GAP F4): the write calls the write-faults check takes from the manifest, its verdicts
 * for the failed request, the lost answer and the declared failures, the multi-item tool's RES-2 records, and the follow-through
 * of the lost-answer trial (spec R10-11) on both the shape and the text side.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';

import { createsCheck } from '../../src/checks/creates.js';
import { followRead, lostAnswerVerdict, textNamesVersion, type LostAnswerObs } from '../../src/checks/gated.js';
import { multiCheck, multiRes2Verdicts, type MultiObs } from '../../src/checks/multi.js';
import { usePatterns } from '../../src/checks/says.js';
import { useShapes, type ShapeCapture } from '../../src/checks/shape.js';
import { readSecondClause, type CallBrief, type Tool } from '../../src/checks/types.js';
import { resourceWriteCalls, writeCallsOf, writeFaultsCheck, writeFaultsVerdicts, type FaultTrial, type WriteCallObs, type WriteFaultsObs } from '../../src/checks/writefaults.js';
import { parseManifestText } from '../../src/core/manifest.js';

const TT = parseManifestText(readFileSync(new URL('../../../../../examples/tiny-tracker/writecheck.yaml', import.meta.url), 'utf8'), 'writecheck.yaml');
const TOOLS = ['create_ticket', 'get_ticket', 'list_tickets', 'update_ticket', 'replace_ticket', 'delete_ticket', 'delete_tickets', 'bulk_update_tickets', 'close_ticket', 'add_comment', 'add_label', 'remove_label', 'set_labels', 'create_project', 'list_projects', 'delete_project', 'get_operation'].map((name) => ({ name, inputSchema: { type: 'object' }, annotations: name.startsWith('get_') || name.startsWith('list_') ? { readOnlyHint: true } : {} })) as unknown as Tool[];

const base = (extra = '') =>
  parseManifestText(
    `mws: "0.9"
server: { stdio: [node, s.js] }
target: { environment: test, confirm: t }
${extra}
resources:
  - name: ticket
    create: { tool: t_create, args: { title: "{{marker}}" }, id: id }
    read: { tool: t_get, args: { id: "{{id}}" }, ignore: [updated_at] }
    update: { tool: t_update, mode: field_patch, args: { id: "{{id}}", "{{field}}": "{{value}}" } }
    fields: [ { path: assignee, values: [ann, bob] }, { path: status, values: [open, closed] } ]
    version: { read: version, arg: expected_version, optional: true }
    list: { tool: t_list, args: {}, items: tickets, id: id, name: title }
    cleanup: delete
    delete: { tool: t_delete, args: { id: "{{id}}", expected_version: "{{version}}" } }
`,
    'm.yaml',
  );
const MAN = base('results: { shape: write-result/0.1 }');
const RES = MAN.resources[0]!;
const S = (o: Record<string, unknown>): ShapeCapture => ({ sc: { shape: 'write-result/0.1', ...o }, texts: [{ shape: 'write-result/0.1', ...o }] });
const call = (o: Partial<CallBrief> = {}): CallBrief => ({ step: 's', ok: true, isError: false, rpc_error: null, text: '', data: null, indeterminate: false, tool: 't_delete', ...o });
const err = (shape: ShapeCapture | null, o: Partial<CallBrief> = {}) => call({ ok: false, isError: true, text: 'It is not known whether the change was applied.', ...(shape ? { shape } : {}), ...o });
const req = { seq: 7, method: 'DELETE', path: '/t/T1', status: null };

useShapes(MAN, [{ name: 't_get' }, { name: 't_delete' }, { name: 't_update' }, { name: 't_list' }]);
afterEach(() => usePatterns(null));

test('write calls: every declared write of tiny-tracker is judged once per argument template; read tools never', () => {
  const by = (name: string) => writeCallsOf(TT, TOOLS, TT.resources.find((r) => r.name === name)!).map((c) => `${c.tool}:${c.kind}`);
  assert.deepEqual(by('project'), ['create_project:create', 'delete_project:delete']);
  assert.deepEqual(by('ticket'), ['create_ticket:create', 'delete_ticket:delete', 'add_label:object', 'remove_label:object', 'set_labels:object', 'close_ticket:object', 'add_comment:object']);
  assert.deepEqual(by('ticket-replace'), ['create_ticket:create', 'delete_ticket:delete'], 'its create and delete templates differ from ticket\'s (delete with force: true): write paths of their own; replace_ticket is the held-request check\'s');
  const all = TT.resources.flatMap((r) => writeCallsOf(TT, TOOLS, r).map((c) => c.tool));
  for (const t of ['update_ticket', 'replace_ticket', 'bulk_update_tickets', 'delete_tickets', 'get_ticket', 'list_projects']) assert.ok(!all.includes(t), `${t} is judged elsewhere, or is a read`);
  const close = resourceWriteCalls(TT, TT.resources.find((r) => r.name === 'ticket')!).find((c) => c.tool === 'close_ticket')!;
  assert.deepEqual(close.input?.answers, { confirm: { action: 'accept', content: { confirm: true } } }, 'close_ticket is retried with the declared answers');
});

test('plan: without backend.gate each write call is not tested with the reason; with it, each is planned', () => {
  const noGate = TT.resources.find((r) => r.name === 'project')!;
  const m0 = { ...TT, backend: null } as typeof TT;
  const p0 = writeFaultsCheck.plan({ manifest: m0, tools: TOOLS }, noGate);
  assert.deepEqual(p0.notRun.map((r) => `${r.write_path.tool} ${r.verdict}`), ['create_project not tested', 'delete_project not tested']);
  assert.match(p0.notRun[0]!.reason, /backend\.gate/);
  const p1 = writeFaultsCheck.plan({ manifest: TT, tools: TOOLS }, noGate);
  assert.equal(p1.notRun.length, 0);
  assert.ok(p1.calls.some((c) => c.startsWith('MWS-RES-2 create_project')));
  assert.ok(p1.calls.some((c) => /declared failure project_name_too_long/.test(c)), 'a resource without an object under test: its failures run here');
  assert.ok(!createsCheck.plan({ manifest: TT, tools: TOOLS }, noGate).calls.some((c) => /declared failure/.test(c)), '... and not in the creates check');
  assert.ok(createsCheck.plan({ manifest: TT, tools: TOOLS }, TT.resources.find((r) => r.name === 'ticket')!).calls.some((c) => /declared failure label_on_missing_ticket/.test(c)), 'with an object under test the creates check runs them');
});

const trial = (o: Partial<FaultTrial>): FaultTrial => ({ call: err(S({ outcome: 'unknown', repeat: 'read_first', read_with: { tool: 't_get', arguments: { id: 'T1' } } })), steps: ['s'], requests: [], faulted: req, changed: ['T1'], values: { T1: 'T1' }, applied: true, object: 'T1', ...o });
const obs = (c: Partial<WriteCallObs>): WriteFaultsObs => ({ routing: 'loopback', failures: [], calls: [{ tool: 't_delete', kind: 'delete', from: 'ticket.delete', learn: trial({ call: call({ text: 'Deleted T0.' }), faulted: null, requests: [{ seq: 1, method: 'DELETE', path: '/t/T0', status: 200 }] }), hold: { method: 'DELETE', nth: 1, req }, fail: trial({ call: err(null, { text: 'Delete failed: the backend answered 500. Nothing was deleted.' }), changed: [], values: {}, applied: false }), lost: trial({}), ...c }] });
const rec = (o: WriteFaultsObs, sc: string) => writeFaultsVerdicts(o, RES).find((r) => r.scenario.id === sc)!;

test('verdicts: the failed request and the lost answer of a write call, each in its own record on the call\'s write path', () => {
  usePatterns({ patterns: { outcome_unknown: 'not known whether', not_applied: '\\bfailed\\b' } } as never);
  const o = obs({});
  const f = rec(o, 'write-faults');
  assert.equal(f.verdict, 'held', f.reason);
  assert.deepEqual(f.write_path, { resource: 'ticket', tool: 't_delete', arm: 'mcp' });
  assert.equal(rec(o, 'write-faults.unknown-outcome').verdict, 'held');
  // a success for a failed request is the first clause
  const s = rec(obs({ fail: trial({ call: call({ text: 'Deleted T1.' }), changed: [], values: {}, applied: false }) }), 'write-faults');
  assert.equal(s.verdict, 'violated');
  assert.match(s.reason, /reported it as a success/);
  // an open outcome reported by the shape as not applied
  const n = rec(obs({ lost: trial({ call: err(S({ outcome: 'not_applied', repeat: 'no' })) }) }), 'write-faults.unknown-outcome');
  assert.equal(n.verdict, 'violated', n.reason);
  // a skipped learning pass gives both records, not tested, with the reason
  const sk = writeFaultsVerdicts(obs({ skipped: 't_delete sent no mutating request to the backend in the learning pass (no backend request)' }), RES);
  assert.deepEqual(sk.map((r) => `${r.scenario.id} ${r.verdict}`), ['write-faults not tested', 'write-faults.unknown-outcome not tested']);
  // the server retried the failed request and the write took effect: no failure was produced, but only where the gate shows it
  const retried = rec(obs({ fail: trial({ call: call({ text: 'Deleted T1.' }), applied: true, requests: [{ ...req, status: 500 }, { seq: 8, method: 'DELETE', path: '/t/T1', status: 204 }] }) }), 'write-faults');
  assert.equal(retried.verdict, 'not tested');
  assert.match(retried.reason, /retried/);
  const notRetried = rec(obs({ fail: trial({ call: call({ text: 'Deleted T1.' }), applied: true, requests: [{ seq: 6, method: 'PATCH', path: '/t/T1', status: 200 }, { ...req, status: 500 }] }) }), 'write-faults');
  assert.equal(notRetried.verdict, 'violated', 'a success over a failed later request, with no retry seen at the gate');
});

test('R10-11 follow-through, shape side: same_version decided by the repeat with that version', () => {
  usePatterns({ patterns: { outcome_unknown: 'not known whether' } } as never);
  const b = err(S({ outcome: 'unknown', repeat: 'same_version' }), { carried: { version: true } });
  assert.equal(readSecondClause(b, ['assignee'], {}).v, 'unread', 'not sent: no held');
  const v = readSecondClause(b, ['assignee'], {}, { followThrough: { applied_again: true, how: 'the version read 2 before it and 3 after it' } });
  assert.equal(v.v, 'violated');
  assert.equal(v.kind, 'retry-invited');
  assert.match(v.why, /did not guard the repeat/);
  assert.equal(readSecondClause(b, ['assignee'], {}, { followThrough: { applied_again: false, how: 'the repeat was refused' } }).v, 'held');
  assert.equal(readSecondClause(b, ['assignee'], {}, { followThrough: { applied_again: null, how: 'no read' } }).v, 'unread');
  // a call that carried no version: same_version means yes, whatever a follow-through says
  assert.equal(readSecondClause(err(S({ outcome: 'unknown', repeat: 'same_version' }), { carried: { version: false } }), ['assignee'], {}, { followThrough: { applied_again: false, how: '' } }).v, 'violated');
});

test('R10-11 follow-through in the lost-answer record: an unguarding version is retry-invited; a guarding one is held', () => {
  usePatterns({ patterns: { outcome_unknown: 'not known whether' } } as never);
  const sv = err(S({ outcome: 'unknown', repeat: 'same_version' }), { carried: { version: true } });
  const o = (follow: LostAnswerObs['follow']) => obs({ lost: trial({ call: sv, version_sent: 3, follow }) });
  const bad = rec(o({ applied_again: true, how: 'the repeat was answered as a success; the version read 4 before it and 5 after it' }), 'write-faults.unknown-outcome');
  assert.equal(bad.verdict, 'violated');
  assert.match(bad.reason, /kind retry-invited/);
  assert.match(bad.reason, /did not guard the repeat/);
  assert.ok(bad.notes.some((n) => /Follow-through \(R10-11\).*applied again/.test(n)));
  const good = rec(o({ applied_again: false, how: 'the repeat was refused ("Conflict")' }), 'write-faults.unknown-outcome');
  assert.equal(good.verdict, 'held', good.reason);
  assert.equal(rec(o(null), 'write-faults.unknown-outcome').verdict, 'not tested', 'no follow-through: open, never held');
});

test('R10-11 follow-through, text side: an error that invites the repeat with the version the call carried', () => {
  usePatterns({ patterns: { outcome_unknown: 'not known whether', retry_invited: '\\btry again\\b' } } as never);
  const text = 'It is not known whether the change was applied. You can try again with expected_version 3.';
  const r = (follow: LostAnswerObs['follow']) => lostAnswerVerdict({ faulted: req, call: err(null, { text }), changed: ['assignee'], applied: true, object: 'T1', requests: [], version_sent: 3, follow }, { w: { resource: 'ticket', tool: 't_update', arm: 'mcp' }, sc: { id: 'x', version: '1' }, route: 'Route: loopback', tool: 't_update', readTool: 't_get', versionArg: 'expected_version', values: { assignee: 'bob' }, fallbackChanged: ['assignee'], async: false, learned: [] });
  assert.equal(r(null).verdict, 'not tested');
  assert.match(r(null).reason, /follow-through repeat with that version was not sent/);
  const v = r({ applied_again: true, how: 'the version read 4 before it and 5 after it' });
  assert.equal(v.verdict, 'violated');
  assert.match(v.reason, /kind retry-invited/);
  assert.equal(r({ applied_again: false, how: 'the repeat was refused' }).verdict, 'held');
});

test('declared failures of a resource with no object under test: judged on what the call could change', () => {
  usePatterns({ patterns: { not_applied: '\\bnothing was\\b' } } as never);
  const f = (o: Partial<WriteFaultsObs['failures'][number]>) => writeFaultsVerdicts({ routing: null, calls: [], failures: [{ name: 'dup', tool: 'p_create', call: err(null, { text: 'Project exists; nothing was changed.' }), changed: [], values: {}, ...o }] }, RES)[0]!;
  assert.equal(f({}).verdict, 'held');
  assert.equal(f({}).scenario.id, 'write-faults.declared');
  assert.equal(f({ call: call({ text: 'Created project p1.' }), changed: ['p1'], values: { p1: 'p1' } }).verdict, 'violated');
  assert.equal(f({ skipped: 'the scratch object could not be created (x)', call: null }).verdict, 'not tested');
});

test('multi-item tools: RES-2 from the failed-request trials and the lost answer, in records of their own', () => {
  usePatterns({ patterns: { outcome_unknown: 'not known whether' } } as never);
  const t = (o: Partial<MultiObs['trials'][number]>) => ({ kind: 'failed backend write' as const, position: 'mutating request 1 of 1 (POST /batch) failed with status 500, not forwarded', call: err(null, { text: 'Bulk update failed; nothing was written.', tool: 't_bulk' }), items: ['T1', 'T2', 'T3'], applied: [], reported: null, ...o });
  const m: MultiObs = { tool: 't_bulk', routing: 'loopback', mutating_in_learning: 1, trials: [t({})], learn: { call: call({ tool: 't_bulk' }), requests: [{ seq: 1, method: 'POST', path: '/batch', status: 200 }], applied: true }, lost: { ...t({ call: err(S({ outcome: 'unknown', repeat: 'read_first', read_with: { tool: 't_get', arguments: { id: 'T4' } } }), { tool: 't_bulk' }), items: ['T4', 'T5', 'T6'], applied: ['T4', 'T5', 'T6'] }), position: 'lost', requests: [], faulted: { seq: 9, method: 'POST', path: '/batch', status: null } } };
  const rs = multiRes2Verdicts(m, RES);
  assert.deepEqual(rs.map((r) => `${r.requirement} ${r.scenario.id} ${r.verdict}`), ['MWS-RES-2 multi-item.res2 held', 'MWS-RES-2 multi-item.res2.unknown-outcome held']);
  assert.ok(rs.every((r) => r.write_path.tool === 't_bulk'));
  const bad = multiRes2Verdicts({ ...m, lost: { ...m.lost!, call: err(S({ outcome: 'not_applied', repeat: 'no' }), { tool: 't_bulk' }) } }, RES);
  assert.equal(bad[1]!.verdict, 'violated');
  assert.deepEqual(multiRes2Verdicts({ ...m, routing: null }, RES), [], 'without the gate there is no RES-2 trial here');
  assert.deepEqual(multiRes2Verdicts({ ...m, skipped: 'unsafe' }, RES).map((r) => r.verdict), ['not tested', 'not tested']);
});

test('multi-item tools without backend.gate: MWS-RES-2 is not tested, and says why', () => {
  const ticket = TT.resources.find((r) => r.name === 'ticket')!;
  const p = multiCheck.plan({ manifest: { ...TT, backend: null } as typeof TT, tools: TOOLS }, ticket);
  const r2 = p.notRun.filter((r) => r.requirement === 'MWS-RES-2');
  assert.deepEqual(r2.map((r) => r.write_path.tool), ['bulk_update_tickets', 'delete_tickets']);
  assert.ok(r2.every((r) => r.verdict === 'not tested' && /backend\.gate/.test(r.reason)));
  assert.equal(multiCheck.plan({ manifest: TT, tools: TOOLS }, ticket).notRun.filter((r) => r.requirement === 'MWS-RES-2').length, 0);
});

test('fallback: a call is tried under the next resource that can run it', () => {
  const m = parseManifestText(
    `mws: "0.9"
server: { stdio: [node, s.js] }
target: { environment: test, confirm: t }
backend: { gate: { rewrite_env: U } }
resources:
  - name: a
    create: { tool: t_create, args: { title: "{{marker}}" }, id: id }
    read: { tool: t_get, args: { id: "{{id}}" } }
    delete: { tool: t_delete, args: { id: "{{id}}" } }
  - name: b
    create: { tool: t_create, args: { title: "{{marker}}" }, id: id }
    read: { tool: t_get, args: { id: "{{id}}" } }
    list: { tool: t_list, args: {}, items: items, id: id, name: title }
    delete: { tool: t_delete, args: { id: "{{id}}" } }
    cleanup: delete
`,
    'm.yaml',
  );
  const tools = ['t_create', 't_get', 't_list', 't_delete'].map((name) => ({ name, inputSchema: { type: 'object' } })) as unknown as Tool[];
  assert.deepEqual(writeCallsOf(m, tools, m.resources[0]!).map((c) => c.tool), [], 'a has no cleanup policy');
  assert.deepEqual(writeCallsOf(m, tools, m.resources[1]!).map((c) => c.tool), ['t_create', 't_delete']);
});

test('follow-through read (review of f4): applied again by a change after the out-of-band write; held only on a conflict or a replay', () => {
  usePatterns(null);
  const mid = { ok: true, obj: { status: 'open', version: 5 }, version: 5 };
  const same = { ok: true, obj: { status: 'open', version: 5 }, version: 5 };
  const ok = { ok: true, text: 'Updated.', rpc_error: null, data: null };
  assert.equal(followRead(ok, mid, { ok: true, obj: { status: 'closed', version: 6 }, version: 6 }, true, 'version', []).applied_again, true);
  assert.equal(followRead(ok, mid, same, true, 'version', []).applied_again, null, 'a plain success that changed nothing does not show the guard');
  assert.equal(followRead({ ok: false, text: 'Not applied.', rpc_error: null, data: { status: 412 } }, mid, same, true, 'version', []).applied_again, false, 'a conflict by a structured signal');
  assert.equal(followRead({ ok: false, text: 'Not found.', rpc_error: null, data: null }, mid, same, true, 'version', []).applied_again, null, 'a refusal of another kind');
  assert.equal(followRead({ ok: false, text: 'x', rpc_error: null, data: null, timed_out: true }, mid, same, true, 'version', []).applied_again, null);
});

test('the version is named by a number only beside the version argument or the word version (review of f4)', () => {
  const c = (text: string) => call({ ok: false, isError: true, text });
  assert.equal(textNamesVersion(c('Repeat with expected_version 3.'), 'expected_version', 3), true);
  assert.equal(textNamesVersion(c('Send version: 3 again.'), 'expected_version', 3), true);
  assert.equal(textNamesVersion(c('Ticket T-3 had 3 labels.'), 'expected_version', 3), false);
  assert.equal(textNamesVersion(c('Send the same expected_version.'), 'expected_version', 3), true, 'the argument name alone still names it');
});

test('learning pass gate (review of f4): a write call whose learning pass did not apply is not tested', () => {
  const o = obs({ skipped: 'the learning pass did not show a working write (it answered success and the read-back shows nothing applied), so there is no write to fail' });
  assert.deepEqual(writeFaultsVerdicts(o, RES).map((r) => r.verdict), ['not tested', 'not tested']);
  const ms: MultiObs = { tool: 't_bulk', routing: 'loopback', mutating_in_learning: 1, trials: [], learn: { call: call({ tool: 't_bulk' }), requests: [], applied: false } };
  const rs = multiRes2Verdicts(ms, RES);
  assert.deepEqual(rs.map((r) => r.verdict), ['not tested', 'not tested']);
  assert.match(rs[0]!.reason, /learning pass did not show a working write/);
});
