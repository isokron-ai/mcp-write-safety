/**
 * The phase 2 evaluators against recorded observations: the verdict each rule gives, and above all
 * the cases that must not be flagged (unknown outcomes, refusals, the review-only clauses, a claim
 * about all state that can never be `held`).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createsVerdicts } from '../../src/checks/creates.js';
import { gatedVerdicts, type GatedObs } from '../../src/checks/gated.js';
import { launchVerdicts, misspell } from '../../src/checks/launch.js';
import { listEditVerdicts } from '../../src/checks/listedit.js';
import { multiVerdicts, type MultiObs } from '../../src/checks/multi.js';
import { answerOf, questionId, reviewResult, type Question } from '../../src/checks/review.js';
import { Scanner, secretVerdicts } from '../../src/checks/secrets.js';
import { targetingVerdicts } from '../../src/checks/targeting.js';
import type { CallBrief } from '../../src/checks/types.js';
import { parseManifestText, reviewSpec } from '../../src/core/manifest.js';
import { render } from '../../src/core/template.js';

const MAN = parseManifestText(
  `mws: "0.9"
server: { stdio: [node, s.js] }
target: { environment: test, confirm: t }
resources:
  - name: project
    create: { tool: p_create, args: { key: "{{key}}", name: "{{marker}}" }, id: key }
    read: { tool: p_list, args: {}, items: projects, match: key }
    key: { arg: key, vary: { arg: name, path: name } }
    delete: { tool: p_delete, args: { key: "{{id}}" } }
    cleanup: delete
  - name: ticket
    scope: { resource: project, arg: project, default: inbox, list: { tool: t_list, args: { project: "{{scope}}" }, items: tickets } }
    create: { tool: t_create, args: { project: "{{?scope}}", title: "{{marker}}" }, id: id }
    read: { tool: t_get, args: { id: "{{id}}" }, ignore: [updated_at] }
    update: { tool: t_update, mode: field_patch, args: { id: "{{id}}", "{{field}}": "{{value}}" } }
    fields: [ { path: assignee, values: [ann, bob] }, { path: status, values: [open, closed] } ]
    version: { read: version, arg: expected_version, optional: true }
    list: { tool: t_list, args: {}, items: tickets, id: id, name: title }
    cleanup: delete
    delete: { tool: t_delete, args: { id: "{{id}}" } }
    selector: { tool: t_delete_many, args: { project: "{{scope}}" }, forms: [ { name: omitted, args: {} } ] }
    multi:
      - { tool: t_bulk, args: { ids: "{{ids}}", status: closed }, effect: { path: status, value: closed }, invalid_id: T-0, report: { applied: applied, id: id } }
    list_edit: { tool: l_remove, args: { id: "{{id}}" }, list: labels, address: { by_id: label_id, by_position: position }, insert: { tool: l_set, args: { id: "{{id}}", labels: "{{names_inserted}}" } } }
`,
  'm.yaml',
);
const project = MAN.resources[0]!;
const ticket = MAN.resources[1]!;
const ctx = { manifest: MAN, tools: [] };
const call = (o: Partial<CallBrief> = {}): CallBrief => ({ step: 's', ok: true, isError: false, rpc_error: null, text: '', data: null, indeterminate: false, ...o });

test('template: {{?name}} sends an argument only when it has a value', () => {
  assert.deepEqual(render({ a: '{{?v}}', b: 1, c: ['{{?v}}', 2] }, { v: null }), { b: 1, c: [2] });
  assert.deepEqual(render({ a: '{{?v}}' }, { v: 7 }), { a: 7 });
  assert.deepEqual(render({ a: '{{?missing}}' }, {}), {});
});

test('TGT-1: a write in the default scope is violated; a refusal is held; not found anywhere is not tested', () => {
  const base = { scopes: { named: 'a', other: 'b', default: 'inbox' }, id: 'T1' };
  const v = (o: object) => targetingVerdicts({ tgt1: { ...base, call: call(), found_in: [], ...o }, tgt2: null, tgt3: null }, ticket)[0]!;
  assert.equal(v({ found_in: ['default'] }).verdict, 'violated');
  assert.equal(v({ found_in: ['named'] }).verdict, 'held');
  assert.equal(v({ call: call({ ok: false, isError: true }), found_in: [] }).verdict, 'held');
  assert.equal(v({ found_in: [] }).verdict, 'not tested');
  assert.equal(v({ call: call({ ok: false, indeterminate: true }) }).verdict, 'not tested', 'an unknown outcome is never judged');
});

test('TGT-2 and TGT-3: fewer objects left is violated; outside a confirmed container it is not run; an unchanged object is held', () => {
  const t2 = (o: object) => targetingVerdicts({ tgt1: null, tgt2: { container: 'c', before: 3, forms: [], ...o }, tgt3: null }, ticket)[0]!;
  assert.equal(t2({ forms: [{ name: 'omitted', call: call(), remaining: 0 }] }).verdict, 'violated');
  assert.equal(t2({ forms: [{ name: 'omitted', call: call({ ok: false, isError: true }), remaining: 3 }] }).verdict, 'held');
  assert.equal(t2({ skipped: 'the container does not hold exactly the tester\'s objects' }).verdict, 'not tested');
  const t3 = (o: object) => targetingVerdicts({ tgt1: null, tgt2: null, tgt3: { key: 'k', first: call(), second: call({ ok: false, isError: true }), how: 'x', before: 'first', after: 'first', path: 'name', ...o } }, project)[0]!;
  assert.equal(t3({}).verdict, 'held');
  assert.equal(t3({ after: 'second', second: call() }).verdict, 'violated');
  assert.equal(t3({ second: call({ indeterminate: true }) }).verdict, 'not tested');
});

test('ATOM: success with an item missing, or a false list of applied items, is ATOM-1; changes left by a failed call are ATOM-2', () => {
  const m = ticket.multi[0]!;
  const o = (trials: MultiObs['trials']): MultiObs => ({ tool: 't_bulk', routing: null, mutating_in_learning: null, trials });
  const t = (x: Partial<MultiObs['trials'][number]>) => ({ kind: 'invalid item' as const, position: 'last', call: call({ ok: false, isError: true, data: { applied: [] } }), items: ['T1', 'T2'], applied: [], reported: [], ...x });
  const good = multiVerdicts(o([t({})]), ticket, m);
  assert.deepEqual(good.map((r) => r.verdict), ['held', 'held']);
  const lie = multiVerdicts(o([t({ reported: ['T1', 'T2'] })]), ticket, m);
  assert.equal(lie[0]!.verdict, 'violated');
  assert.match(lie[0]!.reason, /lists T1, T2 as applied; actually applied: nothing/);
  assert.equal(multiVerdicts(o([t({ call: call(), applied: ['T1', 'T2'] })]), ticket, m)[0]!.verdict, 'violated', 'success although the refused item was not applied');
  const partial = multiVerdicts(o([t({ kind: 'failed backend write', items: ['T1', 'T2', 'T3'], applied: ['T1'], reported: null, call: call({ ok: false, isError: true, text: 'deleted T1; T2 failed' }) })]), ticket, m);
  assert.deepEqual(partial.map((r) => r.verdict), ['held', 'violated'], 'named but left applied: ATOM-1 held, ATOM-2 violated');
  assert.deepEqual(multiVerdicts(o([t({ skipped: 'an item\'s read-back has an unknown outcome' })]), ticket, m).map((r) => r.verdict), ['not tested', 'not tested']);
});

test('UPD-2: the element identified is held, another element is violated, a refusal is held', () => {
  const base = { addressed_by: 'position' as const, target: { id: 'L2', name: 'b', position: 1 }, inserted: 'ins', before: ['a', 'b'], call: call() };
  assert.equal(listEditVerdicts({ ...base, after: ['a', 'b'] }, ticket)[0]!.verdict, 'violated', 'the inserted element was removed instead');
  assert.equal(listEditVerdicts({ ...base, after: ['a', 'ins'] }, ticket)[0]!.verdict, 'held');
  assert.equal(listEditVerdicts({ ...base, after: ['a', 'ins', 'b'], call: call({ ok: false, isError: true }) }, ticket)[0]!.verdict, 'held');
});

test('RES-3 and RETRY-1: a missing id is violated; one object is not applicable; a key dropped by a closed schema is not "accepted"', () => {
  const c = (o: object) => ({ name: 'ticket', tool: 't_create', parent: null, first: call({ data: { id: 'T5' } }), found: ['T5'], repeat: call(), found_after_repeat: 2, key: null, version: null, read_keys: null, late_failure: null, ...o });
  const v = (o: object) => createsVerdicts({ creates: [c(o)], update_receipt: null, failures: [], delete_case: null, jobs: [] }, ticket, ctx);
  const get = (rs: ReturnType<typeof v>, id: string) => rs.find((r) => r.requirement === id)!.verdict;
  assert.equal(get(v({ first: call({ data: { ok: true } }) }), 'MWS-RES-3'), 'violated');
  assert.equal(get(v({}), 'MWS-RES-3'), 'held');
  assert.equal(get(v({ found_after_repeat: 1 }), 'MWS-RETRY-1'), 'not applicable');
  assert.equal(get(v({ key: { declared: null, carrier: null, in_schema: null, closed_schema: true, call: null } }), 'MWS-RETRY-1'), 'violated');
  assert.equal(get(v({ key: { declared: 'k', carrier: 'arg', in_schema: false, closed_schema: true, call: call() } }), 'MWS-RETRY-1'), 'violated');
  assert.equal(get(v({ key: { declared: 'k', carrier: 'arg', in_schema: true, closed_schema: true, call: call() } }), 'MWS-RETRY-1'), 'held');
  assert.equal(get(v({ key: { declared: 'k', carrier: 'arg', in_schema: false, closed_schema: false, call: call() } }), 'MWS-RETRY-1'), 'held', 'an open schema may take it');
  const f = createsVerdicts({ creates: [], update_receipt: null, failures: [{ name: 'ghost', tool: 'c_add', call: call({ text: 'Could not add' }), changed: [] }], delete_case: null, jobs: [] }, ticket, ctx);
  assert.equal(f[0]!.verdict, 'violated', 'a declared failure answered as a success');
  const d = createsVerdicts({ creates: [], update_receipt: null, failures: [], delete_case: { call: call(), gone: null }, jobs: [] }, ticket, ctx);
  assert.equal(d[0]!.verdict, 'not tested', 'an unknown read-back after a delete is not judged');
});

test('CFG: started with writes accepted is violated; refusal to start is held; a started filter with a typo is violated', () => {
  const v = launchVerdicts({ baseline: { started: true, reason: null }, cfg1: { env: 'RO', starts: [{ value: 'yes', started: true, reason: null, write: { ok: true, changed: true, step: 's' }, tools: [{ tool: 't_update', absent: false, ok: true, effect: 'status', step: 's', observed: true }] }, { value: 'enabled', started: false, reason: 'exit 2', write: null }] }, cfg2: [{ env: 'TOOLS', kind: 'allow', value: 'a,b', started: true, reason: null }, { env: 'DENY', kind: 'deny', value: 'b', started: true, reason: null, calls: [{ tool: 't_update', absent: false, ok: true, effect: 'status', step: 's' }] }, { env: 'DENY2', kind: 'deny', value: 'b', started: true, reason: null, calls: [{ tool: 't_update', absent: true, ok: false, effect: null, step: 's' }] }, { env: 'DENY3', kind: 'deny', value: 'b', started: false, reason: 'exit 2' }], cfg3: { env: 'RO', started: true, reason: null, calls: [{ tool: 't_update', absent: true, ok: false, effect: null, step: 's' }] } });
  assert.deepEqual(v.map((r) => `${r.requirement} ${r.verdict}`), ['MWS-CFG-1 violated', 'MWS-CFG-4 violated', 'MWS-CFG-2 violated', 'MWS-CFG-2 held', 'MWS-CFG-2 held', 'MWS-CFG-3 held']);
  const ok = launchVerdicts({ baseline: { started: true, reason: null }, cfg1: { env: 'RO', starts: [{ value: 'yes', started: true, reason: null, write: { ok: false, changed: false, step: 's' } }] }, cfg2: [], cfg3: null });
  assert.equal(ok[0]!.verdict, 'held');
  assert.equal(launchVerdicts({ baseline: { started: false, reason: 'x' }, cfg1: null, cfg2: [], cfg3: null, skipped: 'does not start' })[0]!.verdict, 'not tested');
  assert.equal(misspell('true'), 'rtue');
});

test('SEC-1: a credential (raw or JSON-escaped) or a token URL is violated; a general pattern alone is only listed; never held', () => {
  const s = new Scanner([{ name: 'TOKEN', value: 'abc"def123', kind: 'credential' }], ['sig']);
  s.onResult({ step: '1', tool: 'get', raw: JSON.stringify({ text: 'request: abc"def123' }), isError: true });
  s.onResult({ step: '2', tool: 'list', raw: '{"url":"https://x.test/f?sig=zzz"}', isError: false });
  s.onResult({ step: '3', tool: 'other', raw: '{"text":"Authorization: Bearer abcdefghijklmnopqrstu"}', isError: false });
  s.onResult({ step: '4', tool: 'clean', raw: '{}', isError: false });
  const v = secretVerdicts({ results: 4, errors: 1, by_tool: { get: 1, list: 1, other: 1, clean: 1 }, hits: s.log.hits, values: ['TOKEN'] });
  const by = Object.fromEntries(v.map((r) => [r.write_path.tool, r.verdict]));
  assert.deepEqual(by, { clean: 'not observed', get: 'violated', list: 'violated', other: 'not observed' });
  assert.ok(v.find((r) => r.write_path.tool === 'other')!.notes.some((n) => /bearer token/.test(n)));
  assert.ok(!JSON.stringify(v).includes('def123'), 'the value itself is never recorded');
});

test('held request: a loss with both successes is violated (platform when the API loses too); not independent or never held is not tested', () => {
  const trial = (kept: { holder: boolean; other: boolean }, ok = true, schedule: 'hold A, run B' | 'hold B, run A' = 'hold A, run B') => ({ schedule, held: { seq: 3, method: 'PUT', path: '/t/1' }, released: 'after the other writer finished' as const, holder: call({ ok }), other: call(), kept, steps: ['s'] });
  const o = (x: Partial<GatedObs>): GatedObs => ({ routing: 'loopback', independent: true, learned: [], trials: [], control: null, conc1: null, res2: null, atom: null, ...x });
  const lost = gatedVerdicts(o({ trials: [trial({ holder: true, other: false })] }), ticket)[0]!;
  assert.equal(lost.verdict, 'violated');
  assert.ok(lost.notes.some((n) => /held #3 PUT \/t\/1, released after the other writer finished/.test(n)));
  assert.equal(gatedVerdicts(o({ trials: [trial({ holder: true, other: false })], control: { pairs: 4, lost: 2, kind: 'patch' } }), ticket)[0]!.verdict, 'platform');
  assert.equal(gatedVerdicts(o({ trials: [trial({ holder: true, other: false })], control: { pairs: 4, lost: 2 } }), ticket)[0]!.verdict, 'violated', 'a control that is not the forced schedule gives no platform (review)');
  assert.equal(gatedVerdicts(o({ trials: [trial({ holder: false, other: true }, false), trial({ holder: true, other: true }, true, 'hold B, run A')] }), ticket)[0]!.verdict, 'held', 'a conflict is held');
  assert.equal(gatedVerdicts(o({ trials: [trial({ holder: true, other: true })] }), ticket)[0]!.verdict, 'not tested', 'held needs both schedules forced');
  assert.equal(gatedVerdicts(o({ trials: [{ ...trial({ holder: true, other: true }), held: null, released: 'never held' as const }] }), ticket)[0]!.verdict, 'not tested');
  assert.equal(gatedVerdicts(o({ independent: false, skipped: 'the two fields are not independent' }), ticket)[0]!.verdict, 'not tested');
});

test('review-only clauses: a rule or an answer gives self-attested (never violated or held); nothing given is not tested', () => {
  const w = { resource: 'ticket', tool: 't_update', arm: 'mcp' as const };
  const q: Question = { id: questionId('MWS-CONC-4', w, 'wording'), requirement: 'MWS-CONC-4', write_path: w, question: 'Does it say so?', evidence: [{ step: 's', text: 'Request failed with status 412' }] };
  const rv = reviewSpec({ by: 'maintainers', conflict_says_not_applied: 'nothing was written' }, 'r');
  const a = answerOf({ ...ctx, review: rv }, q, rv.conflict_says_not_applied);
  const r = reviewResult({ id: 'stale-write', version: '2' }, q, a);
  assert.equal(r.verdict, 'self-attested');
  assert.equal(r.numbers['answer'], false);
  assert.equal(r.scenario.id, 'stale-write.review', 'its own record, apart from the black-box one');
  assert.equal(reviewResult({ id: 'x', version: '1' }, q, answerOf(ctx, q, null)).verdict, 'not tested');
  const explicit = reviewSpec({ by: 'me', answers: { [q.id]: true } }, 'r');
  assert.equal(answerOf({ ...ctx, review: explicit }, q, null)!.answer, true);
});
