/**
 * MWS-RES-1 on every declared write call (B-GAP F3): the `effects` declaration, the conditions read back, the judging of one
 * trial (a success whose effect is not in effect is violated; a refusal adds no verdict; an adopted shape that does not report
 * success is MWS-RES-2's unless the text claims the write), one record per write tool, and the multi-item tool's call on good
 * items only.
 */

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { condHolds, declaredEffects, describeCond, effectsCheck, effectsVerdicts, multiRes1, res1Trial, type EffectTrial } from '../../src/checks/effects.js';
import { CHECKS } from '../../src/checks/index.js';
import type { MultiObs } from '../../src/checks/multi.js';
import { usePatterns } from '../../src/checks/says.js';
import { useShapes, type ShapeCapture } from '../../src/checks/shape.js';
import type { CallBrief } from '../../src/checks/types.js';
import { parseManifestText } from '../../src/core/manifest.js';

const base = (effects: string, extra = '') => `mws: "0.9"
server: { stdio: [node, s.js] }
target: { environment: test, confirm: t }
${extra}
resources:
  - name: ticket
    create: { tool: t_create, args: { title: "{{marker}}" }, id: id }
    read: { tool: t_get, args: { id: "{{id}}" } }
    list: { tool: t_list, args: {}, items: tickets, id: id, name: title }
    cleanup: delete
    delete: { tool: t_delete, args: { id: "{{id}}" } }
    multi:
      - { tool: t_bulk, args: { ids: "{{ids}}", status: closed }, effect: { path: status, value: closed }, invalid_id: T-0 }
    input_required:
      - { tool: t_close, args: { id: "{{id}}" }, answers: { confirm: { action: accept } }, effect: { path: status, value: closed } }
${effects}`;

const EFF = `    effects:
      - { tool: t_create, args: { title: "{{marker}}", priority: 2 }, effect: [created, { path: priority, value: 2 }] }
      - { tool: t_label, args: { id: "{{id}}", name: x }, effect: { path: labels, contains: { name: x } } }
      - { tool: t_unlabel, args: { id: "{{id}}", label_id: "{{object.labels[0].id}}" }, effect: { path: labels, lacks: { id: "{{object.labels[0].id}}" } } }
      - { tool: t_set, args: { id: "{{id}}", labels: [z] }, effect: { path: labels, pick: name, value: [z] } }
      - { tool: t_delete, args: { id: "{{id}}" }, effect: deleted }
`;
const MAN = parseManifestText(base(EFF), 'm.yaml');
const res = MAN.resources[0]!;
const call = (o: Partial<CallBrief> = {}): CallBrief => ({ step: 's1', ok: true, isError: false, rpc_error: null, text: 'Done.', data: null, indeterminate: false, ...o });
const S = (o: Record<string, unknown>): ShapeCapture => ({ sc: { shape: 'write-result/0.1', ...o }, texts: [{ shape: 'write-result/0.1', ...o }] });
afterEach(() => usePatterns(null));

test('manifest: effects parse into object and new trials; bad forms are refused at load', () => {
  const e = res.effects!;
  assert.equal(e.length, 5);
  assert.deepEqual(e[0], { tool: 't_create', args: { title: '{{marker}}', priority: 2 }, on: 'new', deleted: false, expect: [{ path: 'priority', value: 2, pick: null }], answers: null, client_capabilities: null });
  assert.deepEqual(e[1]!.expect, [{ path: 'labels', contains: { name: 'x' } }]);
  assert.deepEqual(e[2]!.expect, [{ path: 'labels', lacks: { id: '{{object.labels[0].id}}' } }]);
  assert.deepEqual(e[3]!.expect, [{ path: 'labels', value: ['z'], pick: 'name' }]);
  assert.equal(e[4]!.deleted, true);
  const bad = (eff: string) => () => parseManifestText(base(`    effects:\n      - { tool: t_x, args: {}, effect: ${eff} }\n`), 'm.yaml');
  assert.throws(bad('{ path: a }'), /exactly one of value, contains or lacks/);
  assert.throws(bad('{ path: a, value: 1, contains: 2 }'), /exactly one of value, contains or lacks/);
  assert.throws(bad('{ path: a, contains: 1, pick: b }'), /only with value/);
  assert.throws(bad('[deleted, { path: a, value: 1 }]'), /"deleted" stands alone/);
  assert.throws(bad('[]'), /"deleted", "created", a condition/);
  assert.throws(bad('{ path: a, value: 1, colour: red }'), /unknown key colour/);
  assert.throws(() => parseManifestText(base('    effects:\n      - { tool: t_x, args: {}, effect: created }\n').replace('    list: { tool: t_list, args: {}, items: tickets, id: id, name: title }\n', ''), 'm.yaml'), /create and list blocks/);
  assert.throws(() => parseManifestText(base('    effects: { tool: t_x }\n'), 'm.yaml'), /a list of/);
});

test('declared effects: the effects entries, then each input_required effect no entry repeats; the check is registered', () => {
  const d = declaredEffects(res);
  assert.deepEqual(d.map((x) => [x.tool, x.on, x.from]), [['t_create', 'new', 'effects'], ['t_label', 'object', 'effects'], ['t_unlabel', 'object', 'effects'], ['t_set', 'object', 'effects'], ['t_delete', 'object', 'effects'], ['t_close', 'object', 'input_required']]);
  assert.deepEqual(d[5]!.answers, { confirm: { action: 'accept' } });
  const again = parseManifestText(base('    effects:\n      - { tool: t_close, args: { id: "{{id}}", confirm: true }, effect: { path: status, value: closed } }\n'), 'm.yaml').resources[0]!;
  assert.deepEqual(declaredEffects(again).map((x) => x.from), ['effects'], 'an effects entry for the same tool replaces the input_required one');
  assert.ok(CHECKS.includes(effectsCheck));
  const p = effectsCheck.plan({ manifest: MAN, tools: [] }, res);
  assert.equal(p.runs, true);
  assert.equal(p.calls.length, 6);
  const noClean = parseManifestText(base(EFF).replace('    cleanup: delete\n', ''), 'm.yaml').resources[0]!;
  const p2 = effectsCheck.plan({ manifest: MAN, tools: [] }, noClean);
  assert.equal(p2.runs, false);
  assert.ok(p2.notRun.every((r) => r.requirement === 'MWS-RES-1' && r.verdict === 'not tested' && /cleanup policy/.test(r.reason)));
});

test('conditions: equal (empty-like), contains, lacks, pick; a missing list never satisfies contains or lacks', () => {
  const obj = { status: 'closed', labels: [{ id: 'L1', name: 'a' }, { id: 'L2', name: 'b' }], tags: ['x'], note: null };
  assert.equal(condHolds(obj, { path: 'status', value: 'closed', pick: null }).holds, true);
  assert.equal(condHolds(obj, { path: 'note', value: '', pick: null }).holds, true, 'an empty value reads back as null');
  assert.equal(condHolds(obj, { path: 'labels', contains: { name: 'a' } }).holds, true);
  assert.equal(condHolds(obj, { path: 'labels', contains: { name: 'z' } }).holds, false);
  assert.equal(condHolds(obj, { path: 'tags', contains: 'x' }).holds, true);
  assert.equal(condHolds(obj, { path: 'labels', lacks: { id: 'L1' } }).holds, false);
  assert.equal(condHolds(obj, { path: 'labels', lacks: { id: 'L9' } }).holds, true);
  assert.equal(condHolds(obj, { path: 'missing', lacks: { id: 'L9' } }).holds, false, 'no list: the read-back shows nothing about the element');
  assert.equal(condHolds(obj, { path: 'missing', contains: 'x' }).holds, false);
  assert.deepEqual(condHolds(obj, { path: 'labels', value: ['a', 'b'], pick: 'name' }), { holds: true, got: ['a', 'b'] });
  assert.equal(condHolds(obj, { path: 'labels', value: ['b', 'a'], pick: 'name' }).holds, false, 'order counts for a list set whole');
  assert.equal(describeCond({ path: 'labels', value: ['z'], pick: 'name' }), 'labels[*].name is ["z"]');
  assert.equal(describeCond({ path: 'labels', lacks: { id: 'L1' } }), 'labels holds no {"id":"L1"}');
});

test('one trial: success in effect is held, success not in effect is violated, a refusal or an unknown outcome adds no verdict', () => {
  assert.equal(res1Trial(call(), true, 't_label', []).verdict, 'held');
  assert.equal(res1Trial(call(), false, 't_label', []).verdict, 'violated');
  const refused = res1Trial(call({ ok: false, isError: true, text: 'No such ticket.' }), false, 't_label', []);
  assert.equal(refused.verdict, null);
  assert.match(refused.why, /refused.*MWS-RES-2/);
  assert.equal(res1Trial(call({ ok: false, rpc_error: { code: -32602, message: 'bad' }, text: null }), false, 't_label', []).verdict, null);
  assert.match(res1Trial(call({ ok: false, indeterminate: true }), false, 't_label', []).why, /unknown outcome/);
  assert.match(res1Trial(call({ ok: false, indeterminate: true, result_type: 'input_required' }), false, 't_label', []).why, /input_required/);
  // NF-19: an operation the declaration lists as asynchronous that says it was accepted is not a report of success.
  assert.equal(res1Trial(call({ text: 'Accepted; it will be applied shortly.' }), false, 't_label', ['t_label']).verdict, null);
  assert.equal(res1Trial(call({ text: 'Accepted; it will be applied shortly.' }), false, 't_label', []).verdict, 'violated');
});

test('one trial with an adopted shape: outcome applied is a success; not_applied is MWS-RES-2\'s unless the text claims the write (rule 11, point 13)', () => {
  const man = parseManifestText(base(EFF, "results: { shape: write-result/0.1 }\npatterns:\n  applied: '\\b(added|applied)\\b'"), 'm.yaml');
  useShapes(man, [{ name: 't_label' }]);
  usePatterns(man);
  try {
    assert.equal(res1Trial(call({ tool: 't_label', shape: S({ outcome: 'applied' }) }), false, 't_label', []).verdict, 'violated');
    const na = res1Trial(call({ tool: 't_label', text: 'Nothing changed.', shape: S({ outcome: 'not_applied', code: 'conflict' }) }), false, 't_label', []);
    assert.equal(na.verdict, null);
    assert.match(na.why, /not a report of success/);
    const lie = res1Trial(call({ tool: 't_label', text: 'Label added.', shape: S({ outcome: 'not_applied', code: 'conflict' }) }), false, 't_label', []);
    assert.equal(lie.verdict, 'violated');
    assert.match(lie.why, /text reports the write as done/);
  } finally {
    useShapes(MAN, []);
  }
});

const trial = (o: Partial<EffectTrial>): EffectTrial => ({ tool: 't_label', on: 'object', from: 'effects', call: call(), object: 'T-1', missing: [], expect: ['labels holds {"name":"x"}'], ...o });

test('records: one per write tool, violated if any trial is, held where each judged trial held, otherwise not tested', () => {
  const r = effectsVerdicts([
    trial({}),
    trial({ tool: 't_set', missing: [{ cond: 'labels[*].name is ["z"]', got: '["a","b"]' }], expect: ['labels[*].name is ["z"]'] }),
    trial({ tool: 't_delete', gone: false, expect: [] }),
    trial({ tool: 't_create', on: 'new', found: 0, skipped: undefined, object: null, expect: [] }),
    trial({ tool: 't_unlabel', call: call({ ok: false, isError: true, text: 'Refused.' }) }),
    trial({ tool: 't_close', from: 'input_required', skipped: 'the scratch object did not read back before the call', call: null }),
    trial({ tool: 't_delete2', gone: null }),
  ], res);
  const by = (t: string) => r.find((x) => x.write_path.tool === t)!;
  assert.equal(r.length, 7);
  assert.ok(r.every((x) => x.requirement === 'MWS-RES-1' && x.scenario.id === 'effects' && x.write_path.resource === 'ticket'));
  assert.equal(by('t_label').verdict, 'held');
  assert.match(by('t_label').reason, /labels holds \{"name":"x"\}/);
  assert.equal(by('t_set').verdict, 'violated');
  assert.match(by('t_set').reason, /labels\[\*\]\.name is \["z"\]: read back \["a","b"\]/);
  assert.deepEqual(by('t_set').steps, ['s1']);
  assert.equal(by('t_set').attribution, 'unresolved', 'no control arm ran (spec 8.2, rule 3)');
  assert.equal(by('t_delete').verdict, 'violated');
  assert.match(by('t_delete').reason, /still reads back/);
  assert.equal(by('t_create').verdict, 'violated');
  assert.match(by('t_create').reason, /no object carries the call's marker/);
  assert.equal(by('t_unlabel').verdict, 'not tested');
  assert.match(by('t_unlabel').reason, /refused/);
  assert.equal(by('t_close').verdict, 'not tested');
  assert.equal(by('t_delete2').verdict, 'not tested');
  assert.match(by('t_delete2').reason, /unknown outcome/);
  // Two trials of one tool: the violated one decides, and the record states the other.
  const two = effectsVerdicts([trial({}), trial({ missing: [{ cond: 'labels holds {"name":"x"}', got: '[]' }] })], res);
  assert.equal(two.length, 1);
  assert.equal(two[0]!.verdict, 'violated');
  // A create that made two objects with the marker cannot be judged; one with an unmet condition is violated.
  assert.equal(effectsVerdicts([trial({ tool: 't_create', on: 'new', found: 2, skipped: '2 objects carry the call\'s marker' })], res)[0]!.verdict, 'not tested');
  assert.equal(effectsVerdicts([trial({ tool: 't_create', on: 'new', found: 1, missing: [{ cond: 'priority is 2', got: '3' }] })], res)[0]!.verdict, 'violated');
  assert.equal(effectsVerdicts([trial({ tool: 't_create', on: 'new', found: 1, expect: ['priority is 2'] })], res)[0]!.verdict, 'held');
});

test('multi-item: the call on good items only is held where every item holds the effect, violated where one does not', () => {
  const m = res.multi[0]!;
  const o = (clean: MultiObs['clean'], extra: Partial<MultiObs> = {}): MultiObs => ({ tool: 't_bulk', routing: null, mutating_in_learning: null, trials: [], ...(clean ? { clean } : {}), ...extra });
  assert.equal(multiRes1(o({ call: call(), items: ['T1', 'T2'], applied: ['T1', 'T2'] }), res, m).verdict, 'held');
  const v = multiRes1(o({ call: call(), items: ['T1', 'T2', 'T3'], applied: ['T1', 'T2'] }), res, m);
  assert.equal(v.verdict, 'violated');
  assert.match(v.reason, /1 of them does not read back status = "closed".*T3/);
  assert.equal(multiRes1(o({ call: call({ ok: false, isError: true, text: 'Refused' }), items: ['T1'], applied: [] }), res, m).verdict, 'not tested');
  assert.equal(multiRes1(o({ call: call(), items: ['T1'], applied: null }), res, m).verdict, 'not tested');
  assert.equal(multiRes1(o(undefined, { skipped: 'not bound' }), res, m).verdict, 'not tested');
  assert.match(multiRes1(o(undefined), res, m).reason, /no call on good items only/);
  assert.equal(multiRes1(o({ call: null, items: [], applied: [], skipped: 'the items could not be created' }), res, m).reason, 'the items could not be created');
  // The record is the multi-item check's: its scenario id and version (2 since the check sends the call on good items only).
  const multi = CHECKS.find((c) => c.id === 'multi-item')!;
  assert.deepEqual(v.scenario, { id: multi.id, version: multi.version });
  assert.equal(multi.version, '2');
});
