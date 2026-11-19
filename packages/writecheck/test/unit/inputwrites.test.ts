/**
 * B-GAP F2 (B3): MWS-IN-1 to IN-4 on every declared write tool, not only the read and update tools. The base call of each tool
 * comes from the declaration (generic, no server's names); the records keep the existing shape, keyed by requirement and
 * write_path.tool, so the cell matrix can merge them.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { counterpartArgsAllowed, declaredAnswers, inputWritesCheck, inputWritesVerdicts, inventoryCovers, writeCallFor, writeCallGate, writeToolsOf, type WriteKind, type WriteToolObs } from '../../src/checks/inputwrites.js';
import { INTERMEDIATE, type ProbeObs } from '../../src/checks/schema.js';
import type { PlanContext, Tool } from '../../src/checks/types.js';
import { parseManifestText } from '../../src/core/manifest.js';
import { TT_MANIFEST } from '../tiny-tracker/harness.js';

const text = readFileSync(TT_MANIFEST, 'utf8');
const man = parseManifestText(text, TT_MANIFEST);
const READ = ['get_ticket', 'list_tickets', 'list_projects', 'get_operation'];
const WRITE = ['create_ticket', 'update_ticket', 'replace_ticket', 'delete_ticket', 'delete_tickets', 'bulk_update_tickets', 'add_comment', 'add_label', 'remove_label', 'set_labels', 'close_ticket', 'create_project', 'delete_project'];
const schema = { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } }, additionalProperties: false };
const tools: Tool[] = [...READ.map((name) => ({ name, inputSchema: schema, annotations: { readOnlyHint: true } })), ...WRITE.map((name) => ({ name, inputSchema: schema, annotations: { readOnlyHint: false } }))] as Tool[];
const ctx = { manifest: man, tools } as unknown as PlanContext;
const res = (name: string) => man.resources.find((r) => r.name === name)!;

test('every declared write tool other than the update tools is probed, under the resource it is declared with', () => {
  const ticket = writeToolsOf(man, tools, res('ticket')).sort();
  const project = writeToolsOf(man, tools, res('project')).sort();
  assert.deepEqual(ticket, ['add_comment', 'add_label', 'bulk_update_tickets', 'close_ticket', 'create_ticket', 'delete_ticket', 'delete_tickets', 'remove_label', 'set_labels']);
  assert.deepEqual(project, ['create_project', 'delete_project']);
  assert.deepEqual(writeToolsOf(man, tools, res('ticket-replace')), [], 'replace_ticket is the update tool of its resource: schema.ts probes it');
});

test('the base call of each tool comes from the declaration, by kind', () => {
  const kinds = Object.fromEntries([...writeToolsOf(man, tools, res('ticket')).map((t) => [t, writeCallFor(man, res('ticket'), t)]), ...writeToolsOf(man, tools, res('project')).map((t) => [t, writeCallFor(man, res('project'), t)])].map(([t, c]) => [t, (c as { kind: string } | null)?.kind ?? null]));
  assert.deepEqual(kinds, { add_comment: 'append', add_label: 'object', bulk_update_tickets: 'multi', close_ticket: 'confirm', create_ticket: 'create', delete_ticket: 'delete', delete_tickets: 'selector', remove_label: 'object', set_labels: 'object', create_project: 'create', delete_project: 'delete' });
  // the selector tool starts from the selector's arguments with selector.narrow, never from the selector forms
  assert.deepEqual(writeCallFor(man, res('ticket'), 'delete_tickets')!.args, { project: '{{scope}}', title_prefix: '{{marker}}' });
  // the confirmation tool carries the client capabilities the declaration gives
  assert.ok(writeCallFor(man, res('ticket'), 'close_ticket')!.meta);
  assert.equal(writeCallFor(man, res('ticket'), 'get_ticket'), null);
});

test('plan: each tool is probed, or not tested with the reason; nothing is left without a record', () => {
  const p = inputWritesCheck.plan(ctx, res('ticket'));
  assert.equal(p.runs, true);
  assert.deepEqual(p.notRun, []);
  assert.equal(p.calls.length, 9);
  assert.ok(p.writes > 0 && p.creates > 0);
  // a selector tool without the operator's disposable-backend declaration is never sent
  // (without the disposable-backend declaration the manifest may not list counterpart_args on a delete or bulk tool, so those go too)
  const noDisposable = parseManifestText(text.replace('send_empty_forms: true', 'send_empty_forms: false').replace(/^  (delete_ticket|delete_tickets|bulk_update_tickets): \{ counterpart_args: .*\n/gm, ''), TT_MANIFEST);
  const r = noDisposable.resources.find((x) => x.name === 'ticket')!;
  const why = writeCallGate({ manifest: noDisposable, tools }, r, writeCallFor(noDisposable, r, 'delete_tickets'), 'delete_tickets');
  assert.match(why ?? '', /disposable \(spec 7\.3, rule 1; selector\.send_empty_forms\)/);
  const p2 = inputWritesCheck.plan({ manifest: noDisposable, tools } as unknown as PlanContext, r);
  const rows = p2.notRun.filter((x) => x.write_path.tool === 'delete_tickets');
  assert.deepEqual(rows.map((x) => x.requirement), ['MWS-IN-1', 'MWS-IN-2', 'MWS-IN-3', 'MWS-IN-4', 'MWS-IN-6', 'MWS-IN-7']);
  assert.ok(rows.every((x) => x.verdict === 'not tested'));
  // a tool the server does not offer
  assert.match(writeCallGate({ manifest: man, tools: tools.filter((t) => t.name !== 'add_label') }, res('ticket'), writeCallFor(man, res('ticket'), 'add_label'), 'add_label') ?? '', /not in tools\/list/);
  // a write tool the declaration names only where the backend refuses it gives no base call
  assert.match(writeCallGate({ manifest: man, tools }, res('ticket'), null, 'x') ?? '', /not in tools\/list/);
  assert.match(writeCallGate({ manifest: man, tools: [...tools, { name: 'x', inputSchema: schema } as Tool] }, res('ticket'), null, 'x') ?? '', /gives no call of x that succeeds/);
});

test('manifest: inputs.<tool>.counterpart_args is parsed and checked', () => {
  assert.deepEqual(man.inputs['add_label'], { counterpart_args: ['name'] });
  assert.throws(() => parseManifestText(text.replace('add_label: { counterpart_args: [name] }', 'add_label: { counterpart: [name] }'), TT_MANIFEST), /inputs\.add_label/);
  assert.deepEqual(parseManifestText(text.replace(/^inputs:\n(  .*\n)+/m, ''), TT_MANIFEST).inputs, {});
});

const probe = (o: Partial<ProbeObs>): ProbeObs => ({ tool: 'add_label', role: 'write', prop: 'name', name: 'number', requirement: 'MWS-IN-1', value: '5', ok: false, isError: true, rpc_error: null, text: 'name: expected string, got integer', step: 's1', sent: 5, type: 'string', required: true, refused_by: 'the error names the argument', ...o });
const obs = (o: Partial<WriteToolObs> = {}): WriteToolObs => ({ tool: 'add_label', kind: 'object', source: 'calls.add_label', protected: ['id'], unprobed: [], counterpart_base: [], losses: [], inventory_calls: 0, ...o });
// the review-only clause of MWS-IN-4 (does the error give the reason) is its own record, scenario `….review`; left out here.
const by = (rs: { requirement: string; verdict: string; scenario: { id: string } }[]) => Object.fromEntries(rs.filter((r) => !r.scenario.id.endsWith('.review')).map((r) => [r.requirement, r.verdict]));

test('verdicts: the records of a write tool use the existing shape, keyed by requirement and write_path.tool', () => {
  const ps = [probe({}), probe({ requirement: 'MWS-IN-2', prop: 'mwsc_undefined_argument', name: 'undefined_argument', value: 'mwsc', text: 'mwsc_undefined_argument: is not an argument of this tool', type: undefined }), probe({ requirement: 'MWS-IN-3', name: 'too_long', value: 'xxx', text: 'name: must be at most 32 characters', type: undefined })];
  const rs = inputWritesVerdicts(ps, [obs()], res('ticket'), ctx);
  assert.deepEqual(by(rs), { 'MWS-IN-1': 'held', 'MWS-IN-6': 'held', 'MWS-IN-2': 'held', 'MWS-IN-7': 'held', 'MWS-IN-3': 'held', 'MWS-IN-4': 'held' });
  for (const r of rs) {
    assert.deepEqual(r.write_path, { resource: 'ticket', tool: 'add_label', arm: 'mcp' });
    assert.ok(r.notes.some((n) => n.startsWith('Base call: the declared call calls.add_label')), r.requirement);
  }
});

test('verdicts: a refused probe whose counterpart could not be sent (spec R15-4) keeps IN-1, IN-4 and IN-6 from held', () => {
  const ps = [probe({ cannot_tell: true, control: 'the control with the counterpart of the same meaning (the string "5") was not sent: delete_project deletes', refused_by: undefined }), probe({ requirement: 'MWS-IN-3', name: 'pattern_mismatch', value: 'x', text: 'name: must match', type: undefined })];
  const v = by(inputWritesVerdicts(ps, [obs()], res('ticket'), ctx));
  assert.equal(v['MWS-IN-1'], 'not tested');
  assert.equal(v['MWS-IN-4'], 'not tested');
  assert.equal(v['MWS-IN-6'], 'not tested');
  assert.equal(v['MWS-IN-3'], 'held');
});

test('verdicts: an accepted probe used with another meaning is violated on the write tool; a tool not probed is not tested with the reason', () => {
  const ps = [probe({ ok: true, isError: false, text: 'Label added', value: '{"a":1}', sent: { a: 1 }, meaning: { kind: 'changes', why: '{"a":1} was flattened to the string "[object Object]"' }, meaning_steps: ['s1'] })];
  const v = by(inputWritesVerdicts(ps, [obs()], res('ticket'), ctx));
  assert.equal(v['MWS-IN-1'], 'violated');
  assert.equal(v['MWS-IN-6'], 'violated');
  const rs = inputWritesVerdicts([], [obs({ tool: 'close_ticket', not_probed: 'the base call did not succeed' })], res('ticket'), ctx);
  assert.equal(rs.length, 6);
  assert.ok(rs.every((r) => r.verdict === 'not tested' && /close_ticket was not probed: the base call did not succeed/.test(r.reason)));
});

test('verdicts: a bystander lost around a call that spec 7.3, rule 1 covers keeps the tool\'s records from held', () => {
  const loss = { gone: ['T-1'], changed: [], missing: [], unavailable: null, partial: [] } as unknown as WriteToolObs['losses'][number];
  const rs = inputWritesVerdicts([probe({})], [obs({ losses: [loss], inventory_calls: 2 })], res('ticket'), ctx);
  const v = by(rs);
  assert.equal(v['MWS-IN-1'], 'not tested');
  assert.ok(rs.find((r) => r.requirement === 'MWS-IN-1')!.numbers['bystanders_lost']);
});

test('the tenant guard and the canary tools are never probed, even where they are not marked read-only (guard B2)', () => {
  const guarded = parseManifestText(text.replace('guard: { tool: list_projects', 'guard: { tool: add_label'), TT_MANIFEST);
  const r = guarded.resources.find((x) => x.name === 'ticket')!;
  assert.match(writeCallGate({ manifest: guarded, tools }, r, writeCallFor(guarded, r, 'add_label'), 'add_label') ?? '', /tenant guard/);
  const canary = parseManifestText(text.replace('- { name: projects, tool: list_projects', '- { name: projects, tool: set_labels'), TT_MANIFEST);
  const r2 = canary.resources.find((x) => x.name === 'ticket')!;
  assert.match(writeCallGate({ manifest: canary, tools }, r2, writeCallFor(canary, r2, 'set_labels'), 'set_labels') ?? '', /canary/);
});

// --- an input_required answer is intermediate, not final ---------------------------------------------------------------------

test('input_required: the declared answers are used for a retry only where they answer every input request the answer makes', () => {
  const r = res('ticket');
  const ir = r.input_required.find((x) => x.tool === 'close_ticket')!;
  assert.deepEqual(declaredAnswers(r, 'close_ticket', { confirm: { method: 'elicitation/create' } }), ir.answers);
  assert.deepEqual(declaredAnswers(r, 'close_ticket', null), ir.answers, 'an answer that does not list its requests is retried with the declared answers');
  assert.equal(declaredAnswers(r, 'close_ticket', { confirm: {}, reason: {} }), null, 'a request the declaration does not answer: no retry');
  assert.equal(declaredAnswers(r, 'add_label', { confirm: {} }), null, 'no input_required entry for the tool: no retry');
  const none = { ...r, input_required: r.input_required.map((x) => ({ ...x, answers: {} })) };
  assert.equal(declaredAnswers(none, 'close_ticket', { confirm: {} }), null, 'empty answers: no retry');
});

test('plan: a confirmation tool whose input_required answer is retried with the declared answers counts the retries as writes', () => {
  const p = inputWritesCheck.plan(ctx, res('ticket'));
  assert.ok(p.calls.some((x) => x.startsWith('close_ticket (confirm') && /retried with the declared answers/.test(x)));
  assert.ok(!p.calls.some((x) => x.startsWith('add_label') && /retried/.test(x)));
});

const ct = (o: Partial<WriteToolObs> = {}) => obs({ tool: 'close_ticket', kind: 'confirm', source: 'ticket.input_required (close_ticket)', ...o });
const extra = (o: Partial<ProbeObs> = {}) => probe({ tool: 'close_ticket', requirement: 'MWS-IN-2', prop: 'mwsc_undefined_argument', name: 'undefined_argument', value: 'mwsc', type: undefined, refused_by: undefined, ...o });

test('verdicts: an extra argument answered only with input_required leaves MWS-IN-2 and MWS-IN-7 not judged, never violated', () => {
  // as the check records it: taken (ok), no notice in the intermediate answer, no final result
  const interim = extra({ ok: true, isError: false, text: '', intermediate: true, control: INTERMEDIATE, step: 's-ir' });
  const refusedType = probe({ tool: 'close_ticket', prop: 'id', text: 'id: expected string, got integer' });
  const rs = inputWritesVerdicts([refusedType, interim], [ct()], res('ticket'), ctx);
  const v = by(rs);
  assert.equal(v['MWS-IN-2'], 'not tested');
  assert.equal(v['MWS-IN-7'], 'not tested');
  for (const id of ['MWS-IN-2', 'MWS-IN-7']) assert.ok(rs.find((x) => x.requirement === id)!.reason.startsWith(INTERMEDIATE), id);
  // a refusal is final: MWS-IN-1, IN-4 and IN-6 judge the refused type probe as before
  assert.equal(v['MWS-IN-1'], 'held');
  assert.equal(v['MWS-IN-6'], 'held');
  assert.equal(v['MWS-IN-4'], 'held');
  // the same answer judged as final (the old reading) would have been an argument dropped silently
  const asFinal = by(inputWritesVerdicts([refusedType, extra({ ok: true, isError: false, text: '', effect: [] })], [ct()], res('ticket'), ctx));
  assert.equal(asFinal['MWS-IN-2'], 'violated');
});

test('verdicts: the final result after the retry is judged (a notice there that the argument was not used is not a silent drop)', () => {
  const final = extra({ ok: true, isError: false, text: 'Closed. Ignored argument mwsc_undefined_argument.', effect: [] });
  const rs = by(inputWritesVerdicts([final], [ct()], res('ticket'), ctx));
  assert.notEqual(rs['MWS-IN-2'], 'violated');
  assert.equal(rs['MWS-IN-7'], 'violated', 'accepted, not rejected: MWS-IN-7 (SHOULD) is violated');
});

test('verdicts: one extra argument with only an intermediate answer keeps MWS-IN-2 and MWS-IN-7 from held; a violation by another stands', () => {
  const refused = extra({ prop: 'nmae', name: 'misspelled_argument', text: 'nmae: is not an argument of this tool' });
  const interim = extra({ ok: true, isError: false, text: '', intermediate: true });
  const rs = inputWritesVerdicts([refused, interim], [ct()], res('ticket'), ctx);
  assert.deepEqual([by(rs)['MWS-IN-2'], by(rs)['MWS-IN-7']], ['not tested', 'not tested']);
  assert.ok(rs.filter((x) => x.requirement === 'MWS-IN-2' || x.requirement === 'MWS-IN-7').every((x) => x.reason.startsWith(INTERMEDIATE)));
  const silent = extra({ prop: 'nmae', name: 'misspelled_argument', ok: true, isError: false, text: 'Closed.', effect: [] });
  const rs2 = inputWritesVerdicts([silent, interim], [ct()], res('ticket'), ctx);
  assert.equal(by(rs2)['MWS-IN-2'], 'violated');
  assert.ok(rs2.find((x) => x.requirement === 'MWS-IN-2')!.notes.some((n) => n.startsWith(INTERMEDIATE)));
});

// --- delete and bulk tools: every call after the base call is bracketed; counterpart_args only on a disposable backend -----

test('the bystander inventory brackets every non-base call of a delete or bulk tool, whatever argument it changes', () => {
  for (const k of ['delete', 'multi'] as WriteKind[]) {
    assert.equal(inventoryCovers(k, false), true, `${k}: a probe, control or counterpart base call`);
    assert.equal(inventoryCovers(k, true), false, `${k}: the declared base call`);
  }
  assert.equal(inventoryCovers('selector', true), true);
  assert.equal(inventoryCovers('selector', false), true);
  for (const k of ['create', 'append', 'object', 'confirm'] as WriteKind[]) assert.equal(inventoryCovers(k, false), false, k);
});

test('counterpart_args on a delete or bulk tool: refused at load unless the backend is declared disposable', () => {
  assert.equal(counterpartArgsAllowed(man, 'delete'), true, 'the shipped manifest declares the backend disposable');
  const off = text.replace('send_empty_forms: true', 'send_empty_forms: false');
  assert.throws(() => parseManifestText(off, TT_MANIFEST), /inputs\.(delete_ticket|bulk_update_tickets)\.counterpart_args: .*disposable/);
  assert.throws(() => parseManifestText(off.replace(/^  delete_ticket: \{ counterpart_args: .*\n/m, ''), TT_MANIFEST), /inputs\.bulk_update_tickets\.counterpart_args/);
  const ok = parseManifestText(off.replace(/^  (delete_ticket|delete_tickets|bulk_update_tickets): \{ counterpart_args: .*\n/gm, ''), TT_MANIFEST);
  assert.deepEqual(ok.inputs['add_label'], { counterpart_args: ['name'] }, 'a tool that writes one object keeps its counterpart_args');
  assert.equal(counterpartArgsAllowed(ok, 'delete'), false);
  assert.equal(counterpartArgsAllowed(ok, 'multi'), false);
  assert.equal(counterpartArgsAllowed(ok, 'object'), true);
  // an empty list declares nothing and is not refused
  assert.doesNotThrow(() => parseManifestText(off.replace(/counterpart_args: \[(force|assignee|all)\]/g, 'counterpart_args: []'), TT_MANIFEST));
});
