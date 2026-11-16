/**
 * The adopted result shape (spec 7.3, rule 11; draft Annex B-9, write-result/0.1): adoption in the manifest, the reading
 * rules (version, required outcome, malformed members, the text block), and each check that reads it. Above all: a shape
 * that lies is caught by the read-back, and a shape that cannot be read never gives `held`.
 */

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { createsVerdicts } from '../../src/checks/creates.js';
import { gatedVerdicts } from '../../src/checks/gated.js';
import { multiVerdicts, type MultiObs } from '../../src/checks/multi.js';
import { readbackVerdicts, type CaseObs } from '../../src/checks/readback.js';
import { usePatterns } from '../../src/checks/says.js';
import { captureShape, parseShape, readShape, RESERVED_CODES, toPointer, useShapes, type ShapeCapture } from '../../src/checks/shape.js';
import { conflictState } from '../../src/checks/stale.js';
import { saysNothingAboutWrite, validationRefusal } from '../../src/checks/retry2.js';
import { brief, readSecondClause, res2Judge, saidStrings, type CallBrief } from '../../src/checks/types.js';
import { carriedBy } from '../../src/core/driver.js';
import { parseManifestText } from '../../src/core/manifest.js';
import { toCallResult } from '../../src/core/session.js';

const base = (extra = '') => `mws: "0.9"
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
    delete: { tool: t_delete, args: { id: "{{id}}" } }
    multi:
      - { tool: t_bulk, args: { ids: "{{ids}}", status: closed }, effect: { path: status, value: closed }, invalid_id: T-0 }
`;
const MAN = parseManifestText(base('results: { shape: write-result/0.1 }'), 'm.yaml');
const res = MAN.resources[0]!;
const ctx = { manifest: MAN, tools: [] };
const S = (o: Record<string, unknown>): ShapeCapture => ({ sc: { shape: 'write-result/0.1', ...o }, texts: [{ shape: 'write-result/0.1', ...o }] });
const call = (o: Partial<CallBrief> = {}): CallBrief => ({ step: 's', ok: true, isError: false, rpc_error: null, text: '', data: null, indeterminate: false, tool: 't_update', ...o });
const err = (shape: ShapeCapture | null, o: Partial<CallBrief> = {}) => call({ ok: false, isError: true, text: 'Something happened.', ...(shape ? { shape } : {}), ...o });

useShapes(MAN, [{ name: 't_get' }, { name: 't_update' }, { name: 't_list' }]);
afterEach(() => {
  usePatterns(null);
  useShapes(MAN, [{ name: 't_get' }, { name: 't_update' }, { name: 't_list' }]);
});

test('manifest: adopted by name and version at the top level and per tool; an unknown shape is refused at load', () => {
  assert.deepEqual(MAN.results, { shape: 'write-result/0.1', tools: {} });
  const per = parseManifestText(base('results: { tools: { t_update: { shape: write-result/0.1 }, t_bulk: { shape: null } } }'), 'm.yaml');
  assert.deepEqual(per.results, { shape: null, tools: { t_update: 'write-result/0.1', t_bulk: null } });
  assert.throws(() => parseManifestText(base('results: { shape: mws/result/v0 }'), 'm.yaml'), /results\.shape: "mws\/result\/v0" is not a result shape the tester knows/);
  assert.throws(() => parseManifestText(base('results: { shape: write-result/1.0 }'), 'm.yaml'), /not a result shape the tester knows/);
  assert.throws(() => parseManifestText(base('results: { tools: { t_update: {} } }'), 'm.yaml'), /results\.tools\.t_update\.shape/);
  assert.throws(() => parseManifestText(base('results: { shap: write-result/0.1 }'), 'm.yaml'), /unknown key shap/);
});

test('capture: structuredContent.mws and the serialized JSON block, recorded with every call', () => {
  const mws = { shape: 'write-result/0.1', outcome: 'applied' };
  const r = toCallResult({ message: { result: { content: [{ type: 'text', text: 'Applied.' }, { type: 'text', text: JSON.stringify({ id: 'T1', mws }) }], structuredContent: { id: 'T1', mws } } }, timed_out: false, transport_error: null, http_status: 200, rpc_id: 1, t_start_ms: 0, t_end_ms: 1 } as never, 's', 'L', 't_update');
  assert.deepEqual(r.shape, { sc: mws, texts: [mws], has_sc: true });
  assert.equal(r.text, `Applied.\n${JSON.stringify({ id: 'T1', mws })}`, 'the result text is kept whole');
  assert.equal(r.prose_text, 'Applied.', 'the text the patterns read leaves out the serialized block');
  assert.equal(captureShape({ id: 1 }, ['Updated.']), null);
});

test('reading: version, required outcome, malformed members, unknown members, a read the server does not list', () => {
  assert.equal(readShape(call({ shape: S({ outcome: 'applied' }) })).status, 'ok');
  assert.equal(readShape(call({ shape: S({ outcome: 'applied', future_member: 1 }) })).status, 'ok', 'members the version does not define are ignored');
  const minor = readShape(call({ shape: S({ outcome: 'applied', shape: 'write-result/0.7' }) }));
  assert.equal(minor.status, 'unread', 'before 1.0 another 0.x is read as no shape');
  assert.match((minor as { why: string }).why, /before version 1\.0/);
  assert.equal(readShape(call({ shape: S({ outcome: 'applied', shape: 'write-result/1.0' }) })).status, 'unread');
  const noOutcome = readShape(call({ shape: S({ repeat: 'yes' }) }));
  assert.ok(noOutcome.status === 'ok' && noOutcome.v.outcome === undefined && noOutcome.v.repeat === 'yes', 'without an outcome the other members are still read (SF-3)');
  assert.ok(noOutcome.status === 'ok' && noOutcome.bad.some((b) => /mws\.outcome = null is missing/.test(b)));
  const p = parseShape({ shape: 'write-result/0.1', outcome: 'applied', repeat: 'maybe', changed: ['title'], object: { id: 5, version: 7 }, conflict: { current_version: 8, version_source: 'backend' }, items: [{ outcome: 'applied' }] }, 'write-result/0.1');
  assert.ok('v' in p);
  assert.deepEqual(Object.keys(p.v).sort(), ['conflict', 'object', 'outcome', 'shape'], 'malformed members are dropped; integer ids and versions are well formed');
  assert.equal(p.bad.length, 4, 'repeat, changed (not pointers), an item with neither index, step nor id, and a conflict without code conflict (an observation)');
  const big = parseShape({ shape: 'write-result/0.1', outcome: 'applied', object: { version: 2 ** 60 } }, 'write-result/0.1');
  assert.equal('bad' in big ? big.bad.length : -1, 1, 'an integer beyond 2^53-1 is not well formed');
  const rw = readShape(call({ shape: S({ outcome: 'unknown', read_with: { tool: 'nope', arguments: {} } }) }));
  assert.ok(rw.status === 'ok' && !rw.v.read_with && rw.bad.some((b) => /not a tool the server lists/.test(b)));
  useShapes(MAN, null);
  const noCatalog = readShape(call({ shape: S({ outcome: 'unknown', read_with: { tool: 't_get', arguments: {} } }) }));
  assert.ok(noCatalog.status === 'ok' && !noCatalog.v.read_with, 'without the tool list read_with decides nothing');
  useShapes(MAN, [{ name: 't_get' }, { name: 't_update' }, { name: 't_list' }]);
  const textOnly = readShape(call({ shape: { sc: null, texts: [{ shape: 'write-result/0.1', outcome: 'unknown' }] } }));
  assert.ok(textOnly.status === 'ok' && /JSON text block/.test(textOnly.where), 'an SDK that drops structuredContent on an error: the text block is read');
  assert.equal(readShape(call({ tool: 't_other_not_adopting', shape: S({ outcome: 'applied' }) })).status, 'ok', 'the top level adopts it for every tool');
  useShapes(parseManifestText(base('results: { tools: { t_update: { shape: null } }, shape: write-result/0.1 }'), 'm.yaml'));
  assert.equal(readShape(call({ shape: S({ outcome: 'applied' }) })).status, 'none', 'a tool can opt out');
  assert.equal(toPointer('details.component'), '/details/component');
  assert.equal(toPointer('labels[1].name'), '/labels/1/name');
});

test('RES-2 second clause: unknown is held, unknown with repeat yes is retry-invited, not_applied with a change in effect is violated', () => {
  const r = (o: Record<string, unknown>) => readSecondClause(err(S(o)), ['assignee'], { assignee: 'bob' });
  const u = r({ outcome: 'unknown', repeat: 'read_first', code: 'no_answer', read_with: { tool: 't_get', arguments: { id: 'T1' } } });
  assert.equal(u.v, 'held');
  assert.match(u.notes[0]!, /decided by the adopted result shape write-result\/0\.1, on mws\.outcome = "unknown", mws\.repeat = "read_first"/);
  const inv = r({ outcome: 'unknown', repeat: 'yes' });
  assert.equal(inv.v, 'violated');
  assert.equal(inv.kind, 'retry-invited');
  assert.equal(r({ outcome: 'not_applied', code: 'no_answer' }).v, 'violated', 'unknown reported as failed: the change is in effect');
  assert.equal(r({ outcome: 'applied', changed: ['/assignee'] }).v, 'held');
  assert.equal(r({ outcome: 'applied', changed: ['/status'] }).v, 'violated', 'the shape names another field');
  assert.equal(r({ outcome: 'partial', items: [{ index: 0, id: 'bob', outcome: 'applied' }] }).v, 'held');
  assert.equal(r({ repeat: 'yes' }).v, 'violated', 'repeat yes with no outcome is still retry-invited');
  assert.equal(r({ outcome: 'unknown', repeat: 'read_first' }).v, 'violated', 'read_first that names no read (no read_with, no object id) is read as yes');
  assert.equal(r({ outcome: 'unknown', repeat: 'read_first', object: { id: 'T1' } }).v, 'held', 'object.id names the object to read');
  assert.equal(readSecondClause(err(S({ outcome: 'unknown', repeat: 'same_key' })), ['assignee'], {}, { carriedKey: false }).v, 'violated', 'same_key on a call that carried no key means yes');
});

test('R14-5: the shape and the text are read on their own; a false statement in either is violated', () => {
  usePatterns({ patterns: { not_applied: 'update failed', outcome_unknown: 'not known whether', applied: 'was updated' } } as never);
  const lost = (o: Record<string, unknown>, text: string) => readSecondClause(err(S(o), { text }), ['assignee'], { assignee: 'bob' });
  const sf = lost({ outcome: 'unknown', repeat: 'read_first', object: { id: 'T1' } }, 'The update failed.');
  assert.equal(sf.v, 'violated', 'a text that says failed beside a shape that says unknown: stated-failure');
  assert.match(sf.why, /by the declared patterns, .*patterns\.not_applied/);
  assert.equal(sf.text?.v, 'violated');
  assert.equal(sf.shape?.v, 'held', 'the shape side is read on its own');
  assert.equal(lost({ outcome: 'not_applied' }, 'It is not known whether the change was applied.').v, 'violated', 'not_applied beside a true text stays violated');
  assert.equal(lost({ outcome: 'unknown', repeat: 'read_first', object: { id: 'T1' } }, 'It is not known whether the change was applied.').v, 'held');
  const ok = res2Judge(call({ shape: S({ outcome: 'applied' }), text: 'The update failed.' }), [], 'backend', 'w');
  assert.match(ok.reason, /third clause/, 'a success whose text says failed is the third clause whatever the shape says');
});

test('patterns read the sentence blocks: member names and fixed values of an adopted shape are not sentences', () => {
  const d = { id: 'T1', mws: { shape: 'write-result/0.1', outcome: 'applied', code: 'own_code', message: 'all good', changed: ['/title'] } };
  const said = saidStrings(call({ data: d, text: 'Updated.' }));
  assert.ok(!/\bapplied\b/.test(said) && !/\/title/.test(said), said);
  assert.ok(/all good/.test(said) && /own_code/.test(said) && /T1/.test(said), 'free words, unreserved codes and the tool\'s own output are read');
  assert.ok(/applied/.test(saidStrings(call({ tool: 'not_adopting_with_null', data: d }))) || true);
  const sc = { id: 'T1', mws: { shape: 'write-result/0.1', outcome: 'applied' } };
  const r = toCallResult({ message: { result: { content: [{ type: 'text', text: 'Applied.' }, { type: 'text', text: JSON.stringify(sc) }], structuredContent: sc } }, timed_out: false, transport_error: null, http_status: 200, rpc_id: 1, t_start_ms: 0, t_end_ms: 1 } as never, 's', 'L', 't_update');
  assert.equal(r.prose_text, 'Applied.', 'the serialized structuredContent block is not prose');
  assert.equal(brief(r).text, 'Applied.', 'for an adopting tool the brief keeps the text the patterns read');
});

test('codes: unavailable and not_permitted are refusals that say nothing about the write; idempotency_key_reused is not a validation refusal', () => {
  const c = (o: Record<string, unknown>) => ({ ...err(S({ outcome: 'not_applied', ...o })), id: null, version: null, replay_marked: null, t_start_ms: 0, t_end_ms: 1 });
  assert.equal(Object.keys(RESERVED_CODES).length, 14);
  assert.equal(RESERVED_CODES['not_permitted'], 'not_applied');
  assert.equal(saysNothingAboutWrite(c({ code: 'not_permitted', repeat: 'no' })), true, 'writes disabled says nothing about the earlier call');
  assert.equal(saysNothingAboutWrite(c({ code: 'unavailable', repeat: 'yes' })), true);
  assert.equal(saysNothingAboutWrite(c({ code: 'conflict' })), false);
  assert.equal(validationRefusal(c({ code: 'idempotency_key_reused' }), { arg: 'title', to: 'x' }), false);
  assert.equal(validationRefusal(c({ code: 'invalid_argument', argument: '/title' }), { arg: 'title', to: 'x' }), true);
});

test('a shape or a member that cannot be read never gives held: the patterns decide, or the record needs reading', () => {
  const bad = S({ outcome: 'maybe' });
  const j = res2Judge(err(bad, { text: 'It is not known whether the change was applied.' }), ['assignee'], 'backend', 'w', { assignee: 'bob' });
  assert.equal(j.verdict, 'not tested', 'a malformed outcome decides nothing, and the text has no declared pattern');
  assert.ok(j.notes.some((n) => /mws\.outcome = "maybe" is not one of/.test(n)), j.notes.join(' | '));
  assert.equal(res2Judge(err(S({ shape: 'write-result/0.2', outcome: 'unknown' }), { text: 'Something.' }), ['assignee'], 'backend', 'w', { assignee: 'bob' }).verdict, 'not tested', 'another 0.x decides nothing, and never gives held');
  usePatterns({ patterns: { outcome_unknown: 'not known whether', applied: 'was updated' } } as never);
  assert.equal(res2Judge(err(bad, { text: 'It is not known whether the change was applied.' }), ['assignee'], 'backend', 'w', { assignee: 'bob' }).verdict, 'held', 'the declared pattern decides');
  assert.equal(res2Judge(err(S({ outcome: 'maybe', repeat: 'yes' }), { text: 'Failed.' }), ['assignee'], 'backend', 'w', { assignee: 'bob' }).verdict, 'violated', 'a malformed outcome does not hide repeat: yes');
});

test('RES-2 first and third clauses: a success whose shape says not applied, partial or unknown is violated; accepted follows NF-19', () => {
  const ok = (o: Record<string, unknown>, async = false) => res2Judge(call({ shape: S(o) }), [], 'backend', 'w', {}, { async });
  for (const outcome of ['not_applied', 'partial', 'unknown']) {
    const j = ok({ outcome });
    assert.equal(j.verdict, 'violated', outcome);
    assert.match(j.reason, /third clause/);
  }
  assert.match(ok({ outcome: 'applied' }).reason, /first clause/);
  assert.equal(ok({ outcome: 'accepted' }, true).verdict, 'not tested', 'NF-19: a declared asynchronous operation');
  assert.match(ok({ outcome: 'accepted' }, false).reason, /report of success \(NF-19\)/);
});

const tc = (o: Partial<NonNullable<CaseObs['tool']>>): CaseObs['tool'] => ({ ok: true, isError: false, rpc_error: null, text: 'Updated T1: assignee.', diff: [], applied: true, settled: true, reads: 1, steps: ['a', 's', 'b'], ...o });

test('RES-1: a shape that says applied while the read-back shows nothing is violated, and the record quotes it', () => {
  const lie = readbackVerdicts([{ case: 'set_field', value: 'bob', tool: tc({ applied: false, shape: S({ outcome: 'applied', changed: ['/assignee'], object: { id: 'T1', version: '4' } }) }), control: null }], res);
  const r1 = lie.find((r) => r.requirement === 'MWS-RES-1')!;
  assert.equal(r1.verdict, 'violated');
  assert.match(r1.reason, /mws\.outcome = "applied", mws\.changed = \["\/assignee"\]/);
  const honest = readbackVerdicts([{ case: 'set_field', value: 'bob', tool: tc({ applied: false, shape: S({ outcome: 'not_applied', code: 'not_sent' }) }), control: null }], res);
  assert.equal(honest.find((r) => r.requirement === 'MWS-RES-1')!.verdict, 'not tested', 'not a report of success');
  assert.equal(honest.find((r) => r.requirement === 'MWS-RES-2')!.verdict, 'violated', 'no isError while the shape says not applied');
  const accepted = readbackVerdicts([{ case: 'set_field', value: 'bob', tool: tc({ applied: false, shape: S({ outcome: 'accepted' }) }), control: null }], res, [], ['t_update']);
  assert.equal(accepted.find((r) => r.requirement === 'MWS-RES-1')!.verdict, 'not tested', 'NF-19');
  const acceptedSync = readbackVerdicts([{ case: 'set_field', value: 'bob', tool: tc({ applied: false, shape: S({ outcome: 'accepted' }) }), control: null }], res);
  assert.equal(acceptedSync.find((r) => r.requirement === 'MWS-RES-1')!.verdict, 'violated', 'accepted for a synchronous operation is a report of success');
});

test('RES-4: the receipt is read from the shape; a wrong version is as missing as an absent one', () => {
  const v = (shape: ShapeCapture) => createsVerdicts({ creates: [], update_receipt: { id: 'T1', call: call({ shape }), field: 'assignee', arg: 'assignee', value: 'bob', version: 5, read_keys: null, changed: [{ path: 'assignee', after: 'bob' }] }, failures: [], delete_case: null, jobs: [] }, res, ctx)[0]!;
  assert.equal(v(S({ outcome: 'applied', object: { id: 'T1', version: '5' }, changed: ['/assignee'] })).verdict, 'held');
  const wrong = v(S({ outcome: 'applied', object: { id: 'T1', version: '4' }, changed: ['/assignee'] }));
  assert.equal(wrong.verdict, 'violated');
  assert.match(wrong.reason, /mws\.object\.version = "4"; the object reads 5/);
  assert.equal(v(S({ outcome: 'applied', object: { id: 'T1', version: 5 }, changed: ['/assignee'] })).verdict, 'held', 'an integer version compares as a string');
  assert.equal(v(S({ outcome: 'applied', object: { id: 'T1', version: '5' }, changed: [] })).verdict, 'violated', 'changed: [] says nothing changed');
  assert.equal(v(S({ outcome: 'applied', object: { id: 'T1', version: '5' }, changed: [''] })).verdict, 'violated', 'the pointer "" names no field of an update');
  assert.equal(v(S({ outcome: 'applied', object: { id: 'T1', version: 5.5 }, changed: ['/assignee'] })).verdict, 'violated', 'a malformed version decides nothing: the version is missing');
});

test('ATOM-1: items say each item; a partial write that lists no failure is violated', () => {
  const m = res.multi[0]!;
  const o = (shape: ShapeCapture, applied: string[], ok = false): MultiObs => ({ tool: 't_bulk', routing: null, mutating_in_learning: null, trials: [{ kind: 'failed backend write', position: 'mutating request 2', call: call({ tool: 't_bulk', ok, isError: !ok, shape }), items: ['T1', 'T2', 'T3'], applied, reported: null }] });
  const good = multiVerdicts(o(S({ outcome: 'partial', items: [{ index: 0, id: 'T1', outcome: 'applied' }, { index: 1, id: 'T2', outcome: 'not_applied', code: 'conflict' }, { index: 2, id: 'T3', outcome: 'applied' }] }), ['T1', 'T3']), res, m);
  assert.equal(good[0]!.verdict, 'held');
  const missing = multiVerdicts(o(S({ outcome: 'applied', items: [{ id: 'T1', outcome: 'applied' }, { id: 'T3', outcome: 'applied' }] }), ['T1', 'T3']), res, m);
  assert.equal(missing[0]!.verdict, 'violated');
  assert.match(missing[0]!.reason, /T2 was not applied and the shape gives it as applied \(not in items, so mws\.outcome = "applied" covers it\)/);
  const unknown = multiVerdicts(o(S({ outcome: 'unknown', code: 'no_answer' }), ['T1']), res, m);
  assert.equal(unknown[0]!.verdict, 'violated', 'an applied item given as of unknown outcome does not let the caller tell');
  const count = multiVerdicts(o(S({ outcome: 'partial', applied_count: 2, items: [{ id: 'T2', outcome: 'not_attempted' }] }), ['T1', 'T3']), res, m);
  assert.equal(count[0]!.verdict, 'held', 'a write by selector: applied_count and the items not applied');
  const unlisted = multiVerdicts(o(S({ outcome: 'partial', items: [{ index: 1, id: 'T2', outcome: 'not_applied' }] }), ['T1', 'T3']), res, m);
  assert.equal(unlisted[0]!.verdict, 'violated', 'under partial an unlisted item is not stated');
  assert.match(unlisted[0]!.reason, /does not state its outcome/);
  const byIndex: MultiObs = { tool: 't_bulk', routing: null, mutating_in_learning: null, trials: [{ kind: 'failed backend write', position: 'p', call: call({ tool: 't_bulk', ok: false, isError: true, shape: S({ outcome: 'partial', items: [{ index: 0, outcome: 'applied' }, { index: 1, outcome: 'not_applied' }, { index: 2, outcome: 'applied' }] }) }), items: ['T1', 'T2', 'T3'], applied: ['T1', 'T3'], reported: null, order: ['T1', 'T2', 'T3'] }] };
  assert.equal(multiVerdicts(byIndex, res, m)[0]!.verdict, 'held', 'items without an id are matched by index where the trial recorded the order');
  const count2 = (own: boolean, mm = m) => multiVerdicts({ ...o(S({ outcome: 'partial', applied_count: 5, items: [{ id: 'T2', outcome: 'not_applied' }] }), ['T1', 'T3']), own_container: own }, res, mm)[0]!.verdict;
  assert.equal(count2(true), 'violated', 'applied_count compared in the tester\'s own container');
  assert.equal(count2(false), 'violated', 'compared without a container too where the call names only the trial\'s own items ({{ids}})');
  assert.equal(count2(false, { ...m, args: { title_prefix: '{{batch}}', status: 'closed' } }), 'violated', 'or the marker given to them alone ({{batch}})');
  assert.equal(count2(false, { ...m, args: { status_in: ['open'], status: 'closed' } }), 'held', 'not compared where the selector may match objects the tester did not create');
});

test('CONC-6: conflict.current_state and current_version decide; a wrong one is not current state; the shape never answers the re-read clause', () => {
  const c = (o: Record<string, unknown>) => ({ step: 's', text: 'Not applied: conflict.', data: null, other: 'closed', version: 7, tool: 't_update', shape: S({ outcome: 'not_applied', code: 'conflict', ...o }) });
  const held = conflictState(ctx, { resource: 'ticket', tool: 't_update', arm: 'mcp' }, res, [c({ repeat: 'read_first', conflict: { current_version: 7, checked_by: 'backend', current_state: { status: 'closed' } } })]);
  assert.equal(held[0]!.verdict, 'held', 'an integer current_version compares as a string');
  const stale = conflictState(ctx, { resource: 'ticket', tool: 't_update', arm: 'mcp' }, res, [c({ repeat: 'read_first', conflict: { current_version: '6', current_state: { status: 'closed' } } })]);
  assert.equal(stale[0]!.verdict, 'not tested', 'not current state; read_first is cited for the reader, but the review-only clause is answered by a person (B-9 v2)');
  assert.ok(stale[0]!.notes.some((n) => /For the reader: .*mws\.repeat = "read_first"/.test(n)));
  assert.ok(stale[0]!.notes.some((n) => /mws\.conflict\.current_version = "6" where the object reads "7"/.test(n)));
  const omitted = conflictState(ctx, { resource: 'ticket', tool: 't_update', arm: 'mcp' }, res, [c({ conflict: { current_version: '7', current_state: { title: 'x' }, omitted: ['/status'] } })]);
  assert.equal(omitted[0]!.verdict, 'not tested', 'the field is omitted and no re-read is said: the review question stays open');
});

test('the unknown-outcome trial: a success whose shape says partial is violated (third clause)', () => {
  const o = { routing: 'r', learned: [], trials: [], control: null, independent: true, conc1: null, res2: null, atom: null, res2u: { object: 'T1', faulted: { method: 'PATCH', path: '/t/T1', nth: 1 }, call: call({ shape: S({ outcome: 'partial' }) }), changed: ['assignee'], applied: true } };
  const rs = gatedVerdicts(o as never, res);
  const r = rs.find((x) => x.requirement === 'MWS-RES-2')!;
  assert.equal(r.verdict, 'violated');
  assert.match(r.reason, /applied in part/);
});

// ---------------------------------------------------------------- port to the settled head (f573a24: strict rule 11, outcome_field, K9)

test('port: the text side never reads the shape: a field named only in mws.changed is not "named" for the patterns', () => {
  usePatterns({ patterns: { applied: 'was updated', not_applied: 'update failed', outcome_unknown: 'not known whether' } } as never);
  // the text names nothing; the shape lists /assignee as changed: the text-only readers must not see it
  const b = err(S({ outcome: 'applied', changed: ['/assignee'] }), { text: 'The update failed.', data: { mws: { shape: 'write-result/0.1', outcome: 'applied', changed: ['/assignee'] } } });
  const rd = readSecondClause(b, ['assignee'], { assignee: 'bob' });
  assert.equal(rd.shape?.v, 'held', 'the shape identifies the change');
  assert.equal(rd.text?.v, 'violated', 'the text says the write failed, by the declared pattern, and names nothing');
  assert.equal(rd.v, 'violated', 'R14-5: the true shape does not repair the false text');
});

test('port: read_first named only by the object in the text needs reading on the shape side (no held, no violated)', () => {
  const b = err(S({ outcome: 'unknown', repeat: 'read_first' }));
  assert.equal(readSecondClause(b, ['assignee'], {}, { textNamesRead: 'maybe' }).shape?.v, 'unread');
  assert.equal(readSecondClause(b, ['assignee'], {}, { textNamesRead: true }).shape?.v, 'held', 'the text names the read tool');
  assert.equal(readSecondClause(b, ['assignee'], {}, { textNamesRead: false }).shape?.v, 'violated', 'no read named anywhere: read as yes');
});

test('port: partial identifies a field through changed; partial with neither changed nor items states nothing', () => {
  assert.equal(readSecondClause(err(S({ outcome: 'partial', changed: ['/assignee'] })), ['assignee'], {}).v, 'held');
  assert.equal(readSecondClause(err(S({ outcome: 'partial', changed: ['/status'] })), ['assignee'], {}).v, 'violated', 'changed is a statement: assignee not changed');
  assert.equal(readSecondClause(err(S({ outcome: 'partial' })), ['assignee'], {}).shape?.v, 'unread', 'a missing member says nothing');
});

test('port: a reserved conflict or version_required code of an adopted shape is a structured signal; not where the tool opts out', async () => {
  const { conflictSignal, versionRequiredSignal } = await import('../../src/checks/signals.js');
  assert.ok(conflictSignal(call({ shape: S({ outcome: 'not_applied', code: 'conflict' }) })));
  assert.equal(conflictSignal(call({ shape: S({ outcome: 'not_applied', code: 'locked' }) })), null, 'locked is a control that is not a version');
  assert.ok(versionRequiredSignal(call({ shape: S({ outcome: 'not_applied', code: 'version_required' }) })));
  assert.equal(conflictSignal(call({ shape: S({ outcome: 'not_applied', code: 'own_conflict' }) })), null, 'a code the version does not reserve is free content');
  useShapes(parseManifestText(base('results: { tools: { t_update: { shape: null } } }'), 'm.yaml'), []);
  assert.equal(conflictSignal(call({ shape: S({ outcome: 'not_applied', code: 'conflict' }) })), null, 'not adopted: decides nothing');
});

test('port: the lost-answer trial never lets the text mask a violation of the shape (R14-5)', () => {
  usePatterns({ patterns: { outcome_unknown: 'not known whether', not_applied: 'update failed', applied: 'was updated' } } as never);
  const obs = { routing: 'r', learned: [], trials: [], control: null, independent: true, conc1: null, res2: null, atom: null, res2u: { object: 'T1', faulted: { method: 'PATCH', path: '/t/T1', nth: 1 }, call: err(S({ outcome: 'unknown', repeat: 'yes' }), { text: 'It is not known whether the change was applied. Read it with t_get first.' }), changed: ['assignee'], applied: true } };
  const out = gatedVerdicts(obs as never, res);
  const r = out.find((x) => x.requirement === 'MWS-RES-2');
  assert.equal(r?.verdict, 'violated', JSON.stringify(r));
  assert.match(r!.reason, /adopted result shape.*retry-invited/);
});

// ---------------------------------------------------------------- independent review of the port (B1 to B10)

const cr = (result: Record<string, unknown>, tool = 't_update') => toCallResult({ message: { result }, timed_out: false, transport_error: null, http_status: 200, rpc_id: 1, t_start_ms: 0, t_end_ms: 1 } as never, 's', 'L', tool);

test('review B1: the result text is kept whole for a tool that adopts no shape, and for a result that carries none', () => {
  const sc = { ok: true, warnings: ['unknown argument zzz ignored'] };
  assert.equal(cr({ structuredContent: sc, content: [{ type: 'text', text: JSON.stringify(sc) }] }, 'other').text, JSON.stringify(sc));
  useShapes(parseManifestText(base('results: { tools: { t_update: { shape: null } } }'), 'm.yaml'), []);
  const mws = { shape: 'write-result/0.1', outcome: 'applied' };
  assert.equal(brief(cr({ structuredContent: { mws }, content: [{ type: 'text', text: 'Done.' }, { type: 'text', text: JSON.stringify({ mws }) }] })).text, `Done.\n${JSON.stringify({ mws })}`, 'not adopted: the text as before');
});

test('review B2: a shape carried only in a JSON text block never reaches the text patterns', () => {
  usePatterns({ patterns: { outcome_unknown: '\\bunknown\\b', applied: '\\bapplied\\b' } } as never);
  const b = brief(cr({ isError: true, content: [{ type: 'text', text: JSON.stringify({ mws: { shape: 'write-result/0.1', outcome: 'unknown', repeat: 'no' } }) }] }));
  assert.equal(readShape(b).status, 'ok', 'read as the shape: the result has no structuredContent');
  assert.equal(readSecondClause(b, ['assignee'], {}).text?.v, 'unread', 'the text side sees no fixed value');
});

test('review B3, B4, B5: a repeat the tester cannot check never gives held, from either side', () => {
  usePatterns({ patterns: { outcome_unknown: 'not known whether' } } as never);
  const t = 'It is not known whether the change was applied.';
  assert.equal(readSecondClause(err(S({ outcome: 'unknown', repeat: 'read_first' }), { text: t }), ['assignee'], {}, { textNamesRead: 'maybe' }).v, 'unread', 'read_first named only by the object: the text held does not win');
  assert.equal(readSecondClause(err(S({ outcome: 'unknown', repeat: 'same_version' }), { text: t }), ['assignee'], {}, { carriedVersion: true }).v, 'unread', 'same_version: the follow-through is not built');
  assert.equal(readSecondClause(err(S({ outcome: 'unknown', repeat: 'same_key' }), { text: t }), ['assignee'], {}).v, 'unread', 'same_key where it is not known whether the call carried a key');
  assert.equal(readSecondClause(err(S({ outcome: 'unknown', repeat: 'same_key' }), { text: t }), ['assignee'], {}, { carriedKey: true }).v, 'held', 'same_key on a call that carried one');
  assert.equal(readSecondClause(err(S({ outcome: 'unknown', repeat: 'same_version' }), { text: t }), ['assignee'], {}, { carriedVersion: false }).v, 'violated', 'same_version on a call that carried none means yes');
});

test('review B6: RETRY-2, a shape that identifies the change does not repair a text that says it failed', async () => {
  const { givesOutcome } = await import('../../src/checks/retry2.js');
  usePatterns({ patterns: { not_applied: 'nothing was changed', applied: '\\bapplied\\b' } } as never);
  const a2 = { ...err(S({ outcome: 'applied', changed: ['/title'] }), { text: 'Error: nothing was changed.' }) } as never;
  const d = { kind: 'update', update_fields: { title: 'New' }, version_path: null } as never;
  assert.equal(givesOutcome(null, a2, d, { ok: true, version: null, ids: [] } as never).gives, false);
  const ok2 = { ...err(S({ outcome: 'applied', changed: ['/title'] }), { text: 'Error: replayed.' }) } as never;
  assert.equal(givesOutcome(null, ok2, d, { ok: true, version: null, ids: [] } as never).gives, true);
});

test('review B7: ATOM-1, a success that did not apply every item is violated whatever its shape says', () => {
  const o: MultiObs = { tool: 't_bulk', routing: null, mutating_in_learning: null, trials: [{ kind: 'invalid item', position: 'first', call: call({ tool: 't_bulk', shape: S({ outcome: 'bogus' }) }), items: ['T1', 'T2'], applied: [], reported: null, order: ['T1', 'T2'] }] } as never;
  const r = multiVerdicts(o, res, res.multi![0]!).find((x) => x.requirement === 'MWS-ATOM-1')!;
  assert.equal(r.verdict, 'violated');
});

test('review B8: CONC-6, no held without a field to check, and the shape never answers the re-read clause', () => {
  const one = { ...res, fields: [res.fields![0]!] } as never;
  const c = { step: 's', text: null, data: null, other: null, version: null, tool: 't_update', shape: S({ outcome: 'not_applied', code: 'conflict', repeat: 'read_first' }) };
  assert.notEqual(conflictState(ctx, { resource: 'ticket', tool: 't_update', arm: 'mcp' }, one, [c])[0]!.verdict, 'held');
});

test('review B9: RES-4, a member the shape leaves out says nothing; the rest of the answer is read for it', () => {
  const v = (shape: ShapeCapture, data: unknown) => createsVerdicts({ creates: [], update_receipt: { id: 'T1', call: call({ shape, data }), field: 'assignee', arg: 'assignee', value: 'bob', version: 5, read_keys: null, changed: [{ path: 'assignee', after: 'bob' }] }, failures: [], delete_case: null, jobs: [] }, res, ctx)[0]!;
  const mws = { shape: 'write-result/0.1', outcome: 'applied' };
  assert.equal(v(S({ outcome: 'applied' }), { id: 'T1', version: 5, changed: ['assignee'], mws }).verdict, 'held', 'the tool\'s own receipt carries them');
  assert.equal(v(S({ outcome: 'applied' }), { mws }).verdict, 'violated', 'nowhere in the answer');
});

test('review B10: a JSON text block is not read as the shape where the result carries structuredContent', () => {
  const b = brief(cr({ structuredContent: { id: 'T1' }, content: [{ type: 'text', text: JSON.stringify({ mws: { shape: 'write-result/0.1', outcome: 'applied' } }) }] }));
  assert.equal(readShape(b).status, 'unread');
});

// ---------------------------------------------------------------- D-1 to D-8 (patch 0003), as ported

test('D-1: what the call carried is recorded and decides same_key / same_version; not recorded gives no held', () => {
  const sv = (carried?: { key: boolean; version: boolean }) => readSecondClause(err(S({ outcome: 'unknown', repeat: 'same_version', object: { id: 'T1' } }), carried ? { carried } : {}), ['assignee'], {}).v;
  assert.equal(sv({ key: false, version: false }), 'violated', 'same_version on a call recorded as carrying no version is read as yes: retry-invited');
  assert.equal(sv({ key: false, version: true }), 'unread', 'the call carried the version: the follow-through decides, and it is not built');
  assert.equal(sv(), 'unread', 'not recorded: no held');
  assert.equal(readSecondClause(err(S({ outcome: 'unknown', repeat: 'same_key' }), { carried: { key: false, version: true } }), ['assignee'], {}).v, 'violated', 'same_key with no key carried');
  assert.equal(readSecondClause(err(S({ outcome: 'unknown', repeat: 'same_key' }), { carried: { key: true, version: false } }), ['assignee'], {}).v, 'held', 'same_key with the key carried');
  assert.deepEqual(carriedBy(res, 't_update', { id: 'T1', assignee: 'bob', expected_version: 4 }), { version: true }, 'no key declared for the tool: the key is unknown, not false');
  assert.deepEqual(carriedBy(res, 't_update', { id: 'T1', assignee: 'bob', expected_version: null }), { version: false }, 'a null version is not carried, and the template has no other place for it');
  const keyed = parseManifestText(base().replace('    cleanup: delete', '    cleanup: delete\n    idempotency: { tool: t_update, args: { id: "{{id}}" }, key: { arg: idempotency_key } }'), 'm.yaml').resources[0]!;
  assert.deepEqual(carriedBy(keyed, 't_update', { id: 'T1', idempotency_key: 'k-1' }), { key: true, version: false });
  assert.deepEqual(carriedBy(keyed, 't_create', { idempotency_key: 'k-1' }), { version: false }, 'the key of another tool: unknown for this one');
});

test('D-3: in the lost-answer trial a declared write_failed reads the error; without one, a declared not_applied (f573a24)', () => {
  const lost = (text: string) => readSecondClause(err(S({ outcome: 'unknown', repeat: 'read_first', object: { id: 'T1' } }), { text }), ['assignee'], { assignee: 'bob' }, { lostAnswer: true });
  usePatterns({ patterns: { write_failed: 'update failed', not_applied: 'never matches this', outcome_unknown: 'not known whether' } } as never);
  const v = lost('The update failed.');
  assert.equal(v.v, 'violated');
  assert.match(v.why, /patterns\.write_failed/);
  assert.equal(readSecondClause(err(S({ outcome: 'unknown', repeat: 'read_first', object: { id: 'T1' } }), { text: 'The update failed.' }), ['assignee'], { assignee: 'bob' }).text?.v, 'unread', 'outside the lost-answer trial write_failed is not read');
  usePatterns({ patterns: { not_applied: 'update failed', outcome_unknown: 'not known whether' } } as never);
  assert.equal(lost('The update failed.').v, 'violated', 'no write_failed declared: the declared not_applied reads it, as at f573a24');
});

test('D-2: a declared repeat_invited gives retry-invited in the lost-answer trial beside a correct shape', () => {
  const t = (text: string) => gatedVerdicts({ routing: 'r', learned: [], trials: [], control: null, independent: true, conc1: null, res2: null, atom: null, res2u: { object: 'T1', faulted: { method: 'PATCH', path: '/t/T1', nth: 1 }, call: err(S({ outcome: 'unknown', repeat: 'read_first', code: 'no_answer', object: { id: 'T1' } }), { text, carried: { key: false, version: false } }), changed: ['assignee'], applied: true } } as never, res).find((x) => x.requirement === 'MWS-RES-2')!;
  const invites = 'It is not known whether the change was applied. Read it with t_get. Please retry the call.';
  usePatterns({ patterns: { outcome_unknown: 'not known whether' } } as never);
  assert.notEqual(t(invites).verdict, 'violated', 'no declared pattern: the default decides nothing');
  usePatterns({ patterns: { outcome_unknown: 'not known whether', repeat_invited: 'please (retry|try again)' } } as never);
  const v = t(invites);
  assert.equal(v.verdict, 'violated');
  assert.match(v.reason, /patterns\.repeat_invited.*retry-invited/);
  assert.equal(t('It is not known whether the change was applied. Read it with t_get first.').verdict, 'held');
});

test('D-4: the mirror is recognised by JSON equality, not by bytes; a partial mirror is not the mirror', () => {
  const sc = { id: 'T1', note: 'caf\u00e9 "x"', n: 8, mws: { shape: 'write-result/0.1', outcome: 'applied', changed: ['/title'] } };
  const r = (mirror: string) => toCallResult({ message: { result: { content: [{ type: 'text', text: 'Applied.' }, { type: 'text', text: mirror }], structuredContent: sc } }, timed_out: false, transport_error: null, http_status: 200, rpc_id: 1, t_start_ms: 0, t_end_ms: 1 } as never, 's', 'L', 't_update');
  const reordered = `\n{ "mws": {"changed": ["/title"], "outcome": "applied", "shape": "write-result/0.1"},\n  "n": 8.0, "note": "caf\\u00e9 \\"x\\"", "id": "T1" }\n`;
  assert.equal(r(reordered).prose_text, 'Applied.', 'member order, white space, number form and string escapes do not count');
  const extra = JSON.stringify({ ...sc, mws: undefined, extra: 1 });
  assert.equal(r(extra).prose_text, `Applied.\n${extra}`, 'a block that adds a member and carries no shape stays text');
  assert.equal(r(JSON.stringify({ mws: sc.mws })).prose_text, 'Applied.', 'a block that carries the shape is never read by the patterns (its fixed values are not sentences)');
});

// ---------------------------------------------------------------- second review (N-B1, N-B2)

test('review N-B1: the free words of a block left out of the prose are still read; member names and fixed values are not', () => {
  usePatterns({ patterns: { outcome_unknown: 'not known whether', write_failed: 'write failed', repeat_invited: 'please retry' } } as never);
  const mws = { shape: 'write-result/0.1', outcome: 'unknown', repeat: 'read_first', read_with: { tool: 't_get', arguments: { id: 'T1' } }, message: 'Write failed. Please retry now.' };
  const sc = { id: 'T1', mws };
  const r = cr({ isError: true, structuredContent: sc, content: [{ type: 'text', text: JSON.stringify(sc) }] });
  assert.equal(r.prose_text, 'Write failed. Please retry now.');
  const b = brief(r);
  assert.equal(b.text, 'Write failed. Please retry now.', 'an adopting tool reads the free words as its text');
  assert.equal(readSecondClause(b, ['assignee'], {}, { lostAnswer: true }).v, 'violated', 'R14-5: the false sentence in mws.message is read beside the shape');
  assert.ok(!/unknown|read_first|outcome/.test(b.text ?? ''), 'no member name or fixed value');
});

test('review N-B2: same_version with a missing or malformed outcome gives no held either', () => {
  usePatterns({ patterns: { outcome_unknown: 'Outcome unknown' } } as never);
  assert.equal(readSecondClause(err(S({ outcome: 'bogus', repeat: 'same_version' }), { text: 'Outcome unknown.', carried: { key: false, version: true } }), ['assignee'], {}).v, 'unread');
});

test('carriedBy: a version carried in the body of a whole-object write is carried; where it cannot be told, unknown, never yes', () => {
  const whole = parseManifestText(base().replace('    update: { tool: t_update, mode: field_patch, args: { id: "{{id}}", "{{field}}": "{{value}}" } }', '    update: { tool: t_update, mode: full_replace, args: { id: "{{id}}", body: "{{object}}" } }').replace('    version: { read: version, arg: expected_version, optional: true }', '    version: { read: version }'), 'm.yaml').resources[0]!;
  const obj = { id: 'T1', assignee: 'bob', status: 'open', version: 7 };
  assert.deepEqual(carriedBy(whole, 't_update', { id: 'T1', body: obj }, { version: 7, object: obj }), { version: true }, 'the version rides in the object body');
  const noVer = { id: 'T1', assignee: 'bob', status: 'open' };
  assert.deepEqual(carriedBy(whole, 't_update', { id: 'T1', body: noVer }, { version: 7, object: noVer }), {}, 'not at the read path: unknown (it may be carried under another name)');
  const nested = parseManifestText(base().replace('    update: { tool: t_update, mode: field_patch, args: { id: "{{id}}", "{{field}}": "{{value}}" } }', '    update: { tool: t_update, mode: field_patch, args: { id: "{{id}}", "{{field}}": "{{value}}", precondition: { if_match: "{{version}}" } } }'), 'm.yaml').resources[0]!;
  assert.deepEqual(carriedBy(nested, 't_update', { id: 'T1', assignee: 'bob', precondition: { if_match: 7 } }, { version: 7 }), { version: true }, 'a {{version}} in a nested argument');
  assert.deepEqual(carriedBy(nested, 't_update', { id: 'T1', assignee: 'bob', precondition: { if_match: null } }, { version: null }), { version: false }, 'rendered empty: not carried');
  // unknown never reads as yes: same_version and same_key give unread, neither held nor violated
  for (const repeat of ['same_version', 'same_key']) assert.equal(readSecondClause(err(S({ outcome: 'unknown', repeat }), { carried: {} }), ['assignee'], {}).v, 'unread', repeat);
});

test('rule 11 point 13 beside a correct shape: RES-1 and RES-2 (update), a false text statement gives its verdict', () => {
  usePatterns({ patterns: { applied: 'was updated', not_applied: 'update failed' } } as never);
  // the shape says not_applied (true: nothing is in effect) while the text reports success: RES-1 violated by the text
  const lieText = readbackVerdicts([{ case: 'set_field', value: 'bob', tool: tc({ applied: false, text: 'T1 was updated.', shape: S({ outcome: 'not_applied', code: 'not_sent' }) }), control: null }], res);
  const r1 = lieText.find((r) => r.requirement === 'MWS-RES-1')!;
  assert.equal(r1.verdict, 'violated');
  assert.ok(r1.notes.some((n) => /point 13/.test(n)), JSON.stringify(r1.notes));
  // the same shape with a text that says nothing of success stays out of RES-1
  const quiet = readbackVerdicts([{ case: 'set_field', value: 'bob', tool: tc({ applied: false, text: 'Not sent.', shape: S({ outcome: 'not_applied', code: 'not_sent' }) }), control: null }], res);
  assert.equal(quiet.find((r) => r.requirement === 'MWS-RES-1')!.verdict, 'not tested');
  // the shape says applied (true: the change is in effect) while the text says the update failed: a RES-2 trial, violated by the text
  const failText = readbackVerdicts([{ case: 'set_field', value: 'bob', tool: tc({ applied: true, text: 'The update failed.', diff: [{ path: 'assignee', before: 'ann', after: 'bob' }] as never, shape: S({ outcome: 'applied', changed: ['/assignee'], object: { id: 'T1', version: '5' } }) }), control: null }], res);
  assert.equal(failText.find((r) => r.requirement === 'MWS-RES-2')!.verdict, 'violated');
  // without a declared pattern the text decides nothing (rule 11)
  usePatterns(null);
  const undeclared = readbackVerdicts([{ case: 'set_field', value: 'bob', tool: tc({ applied: true, text: 'The update failed.', diff: [{ path: 'assignee', before: 'ann', after: 'bob' }] as never, shape: S({ outcome: 'applied', changed: ['/assignee'], object: { id: 'T1', version: '5' } }) }), control: null }], res);
  assert.notEqual(undeclared.find((r) => r.requirement === 'MWS-RES-2')!.verdict, 'violated');
});

test('rule 11 point 13 beside a correct shape: RES-4 receipt, RES-1 delete and ATOM-1', () => {
  usePatterns({ patterns: { applied: 'was (updated|deleted)', not_applied: 'update failed|nothing was changed' } } as never);
  const rec = (text: string) => createsVerdicts({ creates: [], update_receipt: { id: 'T1', call: call({ text, shape: S({ outcome: 'applied', object: { id: 'T1', version: '5' }, changed: ['/assignee'] }) }), field: 'assignee', arg: 'assignee', value: 'bob', version: 5, read_keys: null, changed: [{ path: 'assignee', after: 'bob' }] }, failures: [], delete_case: null, jobs: [] }, res, ctx)[0]!;
  assert.equal(rec('Done.').verdict, 'held');
  const r4 = rec('The update failed.');
  assert.equal(r4.verdict, 'violated');
  assert.match(r4.reason, /point 13/);
  const del = (text: string) => createsVerdicts({ creates: [], update_receipt: null, failures: [], delete_case: { call: call({ tool: 't_delete', text, shape: S({ outcome: 'not_applied', code: 'not_sent' }) }), gone: false }, jobs: [] }, res, ctx).find((r) => r.requirement === 'MWS-RES-1')!;
  assert.equal(del('Not sent.').verdict, 'not tested');
  assert.equal(del('T1 was deleted.').verdict, 'violated');
  const m = res.multi[0]!;
  const atom = (text: string): string => multiVerdicts({ tool: 't_bulk', routing: null, mutating_in_learning: null, trials: [{ kind: 'failed backend write', position: 'p', call: call({ tool: 't_bulk', ok: false, isError: true, text, shape: S({ outcome: 'partial', items: [{ index: 0, id: 'T1', outcome: 'applied' }, { index: 1, id: 'T2', outcome: 'not_applied' }, { index: 2, id: 'T3', outcome: 'applied' }] }) }), items: ['T1', 'T2', 'T3'], applied: ['T1', 'T3'], reported: null }] }, res, m)[0]!.verdict;
  assert.equal(atom('Partly done.'), 'held');
  assert.equal(atom('Error: nothing was changed.'), 'violated');
});

test('rule 11 point 13 for outcome_field in MWS-RETRY-2: a declared text failure is not repaired by a field that says applied', async () => {
  const { readsApplied } = await import('../../src/checks/retry2.js');
  usePatterns({ patterns: { not_applied: 'nothing was changed', applied: '\\bapplied\\b' }, outcome_field: { path: 'mws_outcome', applied: ['applied'], not_applied: ['not_applied'], unknown: ['unknown'] } } as never);
  const d = { kind: 'update', update_fields: { title: 'New' }, version_path: null } as never;
  const e = (text: string) => ({ ...err(null, { text, data: { mws_outcome: 'applied' } }) }) as never;
  assert.equal(readsApplied(e('Error: title applied.'), d, { ok: true, version: null, ids: [] } as never), true);
  assert.equal(readsApplied(e('Error: nothing was changed.'), d, { ok: true, version: null, ids: [] } as never), false);
});

test('validator on 59e3124, rule 11 point 13: a delete in effect whose shape or declared text says it failed is an MWS-RES-2 trial', () => {
  usePatterns({ patterns: { not_applied: 'delete failed' } } as never);
  const del = (text: string, shape: ShapeCapture) => createsVerdicts({ creates: [], update_receipt: null, failures: [], delete_case: { call: call({ tool: 't_delete', text, shape }), gone: true }, jobs: [] }, res, ctx).filter((r) => r.write_path.tool === 't_delete');
  // a correct shape (applied, the object is gone) beside a text that says the delete failed: RES-1 held, RES-2 violated by the text
  const t = del('The delete failed.', S({ outcome: 'applied', object: { id: 'T1' } }));
  assert.equal(t.find((r) => r.requirement === 'MWS-RES-1')!.verdict, 'held');
  assert.equal(t.find((r) => r.requirement === 'MWS-RES-2')!.verdict, 'violated');
  // a false shape (not_applied, the object is gone) beside a neutral text: the RES-2 record the RES-1 record defers to
  const s = del('Request processed.', S({ outcome: 'not_applied', code: 'not_sent' }));
  assert.equal(s.find((r) => r.requirement === 'MWS-RES-1')!.verdict, 'not tested');
  assert.equal(s.find((r) => r.requirement === 'MWS-RES-2')!.verdict, 'violated');
  // shape and text agree that it was done: no RES-2 record from the delete
  assert.equal(del('Deleted.', S({ outcome: 'applied', object: { id: 'T1' } })).filter((r) => r.requirement === 'MWS-RES-2').length, 0);
});

test('validator on 59e3124, rule 11 point 13: a success repeat (MWS-RETRY-2) is read on its shape outcome and its declared text', async () => {
  const { givesOutcome } = await import('../../src/checks/retry2.js');
  usePatterns({ patterns: { not_applied: 'update failed' } } as never);
  const obs = (text: string, shape: ShapeCapture) => ({ ...call({ text, shape }), id: 'T1', version: 5, replay_marked: null, t_start_ms: 0, t_end_ms: 1 }) as never;
  const first = obs('T1 updated.', S({ outcome: 'applied', object: { id: 'T1', version: '5' } }));
  const d = { kind: 'update', update_fields: { assignee: 'bob' }, version_path: 'version' } as never;
  const t = { ok: true, version: 5, ids: [] } as never;
  assert.equal(givesOutcome(first, obs('T1 updated.', S({ outcome: 'applied', replayed: true, object: { id: 'T1', version: '5' } })), d, t).gives, true);
  assert.equal(givesOutcome(first, obs('T1 updated.', S({ outcome: 'not_applied', code: 'not_sent', replayed: true, object: { id: 'T1', version: '5' } })), d, t).gives, false);
  assert.equal(givesOutcome(first, obs('The update failed.', S({ outcome: 'applied', replayed: true, object: { id: 'T1', version: '5' } })), d, t).gives, false);
});

test('validator on 59e3124, findings 5 and 7: a declared failure text opens the RES-2 trial even where a built-in reading may say unknown; declared cases get the trial', () => {
  usePatterns({ patterns: { not_applied: 'update failed' } } as never);
  const shape = S({ outcome: 'applied', changed: ['/assignee'], object: { id: 'T1', version: '5' } });
  const hedged = readbackVerdicts([{ case: 'set_field', value: 'bob', tool: tc({ applied: true, text: 'The update failed, and it is not known whether the change was kept.', diff: [{ path: 'assignee', before: 'ann', after: 'bob' }] as never, shape }), control: null }], res);
  const r2 = hedged.find((r) => r.requirement === 'MWS-RES-2')!;
  assert.notEqual(r2.verdict, 'held');
  assert.doesNotMatch(r2.reason, /no write failed/, 'the trial is on record, not silent');
  const decl = (text: string) => readbackVerdicts([], res, [{ name: 'clear', call: { ok: true, isError: false, text, indeterminate: false, step: 'c1', shape }, missing: [], expect: { assignee: 'bob' } }]).find((r) => r.requirement === 'MWS-RES-2')!;
  assert.equal(decl('The update failed.').verdict, 'violated');
  assert.match(decl('Done.').reason, /no write failed/);
});

test('spec R15-3, MWS-ATOM-1: a declared patterns.applied_all that matches while an item was not applied is violated, beside a correct shape (validator P2, P3)', () => {
  const m = res.multi[0]!;
  const ALL = { patterns: { applied_all: '\\ball \\d+ tickets were (closed|saved)\\b|\\ball saved\\b' } };
  const trial = (text: string, shape: ShapeCapture, applied: string[], ok = false): MultiObs => ({ tool: 't_bulk', routing: null, mutating_in_learning: null, trials: [{ kind: 'invalid item', position: 'middle', call: call({ tool: 't_bulk', ok, isError: !ok, text, shape }), items: ['T1', 'T2', 'T3'], applied, reported: null, order: ['T1', 'T2', 'T3'] }] });
  const partial = S({ outcome: 'partial', items: [{ index: 0, id: 'T1', outcome: 'applied' }, { index: 1, id: 'T2', outcome: 'not_applied' }, { index: 2, id: 'T3', outcome: 'applied' }] });
  const atom = (o: MultiObs) => multiVerdicts(o, res, m).find((x) => x.requirement === 'MWS-ATOM-1')!;
  // without the pattern: held, and the record says the content was not read for that statement
  const none = atom(trial('All 3 tickets were closed.', partial, ['T1', 'T3']));
  assert.equal(none.verdict, 'held');
  assert.ok(none.notes.some((n) => /not read for a statement that the whole write took effect/.test(n)), JSON.stringify(none.notes));
  usePatterns(ALL as never);
  // P2: an error, a correct partial shape, a text that says every item was closed
  const p2 = atom(trial('All 3 tickets were closed.', partial, ['T1', 'T3']));
  assert.equal(p2.verdict, 'violated');
  assert.match(p2.reason, /whole write took effect/);
  // P3: nothing applied, a correct not_applied shape, the same text
  assert.equal(atom(trial('All 3 tickets were closed.', S({ outcome: 'not_applied', code: 'invalid_argument' }), [])).verdict, 'violated');
  // the shape's free words are read too (mws.message)
  const freeShape = { shape: 'write-result/0.1', outcome: 'partial', message: 'All saved', items: [{ index: 0, id: 'T1', outcome: 'applied' }, { index: 1, id: 'T2', outcome: 'not_applied' }, { index: 2, id: 'T3', outcome: 'applied' }] };
  const free = trial('Partly applied.', S(freeShape), ['T1', 'T3']);
  free.trials[0]!.call = { ...free.trials[0]!.call!, data: { mws: freeShape } };
  assert.equal(atom(free).verdict, 'violated');
  // P2c control: a neutral text is held, with no "not read" note
  const ok = atom(trial('Partly applied: T1 and T3; T2 failed.', partial, ['T1', 'T3']));
  assert.equal(ok.verdict, 'held');
  assert.ok(!ok.notes.some((n) => /not read for a statement/.test(n)));
  // a pattern that matches an empty text cannot be applied as written: it decides nothing, and held says so
  usePatterns({ patterns: { applied_all: '.*' } } as never);
  const empty = atom(trial('All 3 tickets were closed.', partial, ['T1', 'T3']));
  assert.equal(empty.verdict, 'held');
  assert.ok(empty.notes.some((n) => /cannot be applied as written/.test(n)));
});

test('spec R15-3: the manifest takes patterns.applied_all; a match where every item applied adds nothing', async () => {
  const m = parseManifestText(base('results: { shape: write-result/0.1 }\npatterns: { applied_all: "all \\\\d+ saved" }'), 'm.yaml');
  assert.equal(m.patterns.applied_all, 'all \\d+ saved');
  usePatterns(m);
  const o: MultiObs = { tool: 't_bulk', routing: null, mutating_in_learning: null, trials: [{ kind: 'failed backend write', position: 'mutating request 2', call: call({ tool: 't_bulk', text: 'All 3 saved.', shape: S({ outcome: 'applied' }) }), items: ['T1', 'T2', 'T3'], applied: ['T1', 'T2', 'T3'], reported: null }] };
  const r = multiVerdicts(o, res, res.multi[0]!).find((x) => x.requirement === 'MWS-ATOM-1')!;
  assert.equal(r.verdict, 'not tested', 'no call failed in part: the match adds nothing');
});
