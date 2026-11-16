/**
 * Spec 96d3691: R9-1 and R10-1 to R10-12 (spec/DECISIONS.md), as this release builds them.
 *
 *   R9-1, R10-11  MWS-RES-2 in the lost-answer trial: the kinds (retry-invited, stated-failure, bare-transport, no-error-flag,
 *                 protocol-error) and a settled outcome reported as not known (unknown-when-settled), by declared patterns only
 *   R10-1         MWS-TGT-3: a run/start/deploy tool is a create only where the declaration puts it there, quoting its words
 *   R10-3         an error that the tester cannot tell gives no verdict and no held
 *   R10-8         MWS-IN-5: violated only on a declared fixed constraint; otherwise "seen, not judged"
 *   R10-9         a catalog-only statement never carries a credential's value
 *   i8            an ignored field the tool can set is warned, and refused for a selector tool in opt-in mode
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { gatedVerdicts, type GatedObs } from '../../src/checks/gated.js';
import { in5Verdicts, schemaVerdicts, type ProbeObs } from '../../src/checks/schema.js';
import { usePatterns } from '../../src/checks/says.js';
import { tgt3Class } from '../../src/checks/targeting.js';
import type { CallBrief } from '../../src/checks/types.js';
import { safeCommand } from '../../src/cli/commands.js';
import { parseManifestText } from '../../src/core/manifest.js';
import { buildPlan, ignoreWarnings } from '../../src/core/plan.js';

const M = (extra = '', key = '') =>
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
${key}${extra}`,
    'm.yaml',
  );
const call = (o: Partial<CallBrief> = {}): CallBrief => ({ step: 's', ok: true, isError: false, rpc_error: null, text: '', data: null, indeterminate: false, ...o });
const withP = <T>(p: Record<string, string>, f: () => T): T => {
  usePatterns({ patterns: p } as never);
  try {
    return f();
  } finally {
    usePatterns(null);
  }
};
const req = { seq: 4, method: 'PATCH', path: '/t/1', status: null };
const G = (x: Partial<NonNullable<GatedObs['res2u']>>, learned: GatedObs['learned'] = []): GatedObs => ({ routing: 'loopback', independent: true, learned, trials: [], control: null, conc1: null, res2: null, atom: null, res2u: { faulted: req, call: call(), changed: ['assignee'], applied: true, object: 'T1', requests: [], ...x } });
const res2 = (o: GatedObs) => gatedVerdicts(o, M().resources[0]!).find((r) => r.requirement === 'MWS-RES-2' && /unknown-outcome/.test(r.scenario.id))!;
const DECL = { applied: '\\bwas updated\\b', outcome_unknown: 'not known whether', retry_invited: '\\btry again\\b', not_applied: '\\bfailed\\b' };

test('R9-1: retry-invited by a declared pattern, unless the error names a read; a default pattern alone never decides', () => {
  const err = (text: string) => call({ ok: false, isError: true, text });
  const v = withP(DECL, () => res2(G({ call: err('The backend did not answer. Please try again.') })));
  assert.equal(v.verdict, 'violated', v.reason);
  assert.match(v.reason, /retry-invited/);
  const read = withP(DECL, () => res2(G({ call: err('It is not known whether the update was applied. Read T1 with ticket_get, then try again.') })));
  assert.equal(read.verdict, 'held', read.reason);
  const none = res2(G({ call: err('The backend did not answer. Please try again.') }));
  assert.notEqual(none.verdict, 'held');
  assert.notEqual(none.verdict, 'violated');
});

test('R9-1: the kinds stated-failure, bare-transport, no-error-flag and protocol-error', () => {
  const sf = withP(DECL, () => res2(G({ call: call({ ok: false, isError: true, text: 'The update failed.' }) })));
  assert.match(sf.reason, /stated-failure/);
  // bare-transport says nothing a declared pattern can match positively, so it needs reading (declared-carryover).
  const bt = withP(DECL, () => res2(G({ call: call({ ok: false, isError: true, text: 'Connection to the backend lost.' }) })));
  assert.equal(bt.verdict, 'not tested', bt.reason);
  assert.match(bt.reason, /needs reading/);
  const nf = withP(DECL, () => res2(G({ call: call({ ok: true, text: 'It is not known whether the update was applied.' }) })));
  assert.equal(nf.verdict, 'violated');
  assert.match(nf.reason, /no-error-flag/);
  const pe = res2(G({ call: call({ ok: false, rpc_error: { code: -32603, message: 'internal error' } }) }));
  assert.match(pe.reason, /protocol-error/);
});

test('R9-1: a settled outcome reported as not known in the run without a fault is unknown-when-settled; with the default only, a note', () => {
  const learned = [{ field: 0, requests: [{ seq: 1, method: 'GET', path: '/t/1', status: 200 }, { seq: 2, method: 'PATCH', path: '/t/1', status: 200 }], hold: null, call: call({ ok: false, isError: true, text: 'It is not known whether the update was applied.' }), applied: true }];
  const okTrial = call({ ok: false, isError: true, text: 'It is not known whether the update was applied.' });
  const v = withP(DECL, () => res2(G({ call: okTrial }, learned)));
  assert.equal(v.verdict, 'violated', v.reason);
  assert.match(v.reason, /unknown-when-settled/);
  const d = res2(G({ call: okTrial }, learned));
  assert.notEqual(d.verdict, 'violated');
  assert.ok(d.notes.some((n) => /Seen, not judged/.test(n)), d.notes.join('\n'));
  // An answer the interposer made itself (a 5xx), or one that reports only acceptance (202), does not settle the outcome.
  const open = [{ ...learned[0]!, requests: [{ seq: 2, method: 'PATCH', path: '/t/1', status: 202 }] }];
  assert.notEqual(withP(DECL, () => res2(G({ call: okTrial }, open))).verdict, 'violated');
});

test('R10-1: a run/deploy tool needs key.class with words from its name or description', () => {
  const tools = [{ name: 'pods_run', description: 'Run a pod with the given name and image.' }];
  const m = (k: string) => parseManifestText(
    `mws: "0.9"
server: { stdio: [node, s.js] }
target: { environment: test, confirm: t }
resources:
  - name: pod
    create: { tool: pods_run, args: { name: "{{key}}" }, id: name }
    read: { tool: pods_get, args: { name: "{{id}}" } }
    delete: { tool: pods_delete, args: { name: "{{id}}" } }
    cleanup: delete
    key: { arg: name, vary: { arg: image, path: image }${k} }
`,
    'm.yaml',
  ).resources[0]!;
  assert.equal(tgt3Class(m(''), tools).verdict, 'not tested');
  assert.match(tgt3Class(m(''), tools).why, /key\.class/);
  assert.equal(tgt3Class(m(', class: { as: create, quote: "Run a pod with the given name" }'), tools).verdict, null);
  assert.equal(tgt3Class(m(', class: { as: upsert, quote: "Run a pod" }'), tools).verdict, 'not applicable');
  assert.equal(tgt3Class(m(', class: { as: create, quote: "creates a pod" }'), tools).verdict, 'not tested', 'the quote must be in the name or description');
  assert.equal(tgt3Class(m('').key ? { ...m(''), create: { ...m('').create!, tool: 'create_pod' } } : m(''), [{ name: 'create_pod', description: 'Create a pod.' }]).verdict, null);
});

test('R10-3: a probe the tester cannot tell gives no verdict and keeps the record from held', () => {
  const res = M().resources[0]!;
  const tools = [{ name: 'ticket_get' }, { name: 'ticket_update', inputSchema: { type: 'object', properties: { id: { type: 'string' }, assignee: { type: 'string' }, priority: { type: 'integer' } } } }];
  const p = (o: Partial<ProbeObs>): ProbeObs => ({ tool: 'ticket_update', role: 'update', prop: 'priority', name: 'non_numeric_string', requirement: 'MWS-IN-1', value: '"abc"', sent: 'abc', type: 'integer', required: false, ok: false, isError: true, rpc_error: null, text: 'invalid arguments: priority must be an integer', step: 's', ...o });
  const r = schemaVerdicts([p({}), p({ name: 'boolean', value: 'true', sent: true, text: 'Something went wrong.', cannot_tell: true })], res, tools as never);
  const in1 = r.find((x) => x.requirement === 'MWS-IN-1' && x.write_path.tool === 'ticket_update')!;
  const in4 = r.find((x) => x.requirement === 'MWS-IN-4' && x.write_path.tool === 'ticket_update')!;
  assert.equal(in1.verdict, 'not tested', in1.reason);
  assert.match(in1.reason, /not judged, because a control of spec R14-6 failed or could not be sent/);
  assert.equal(in4.verdict, 'not tested', in4.reason);
  const clean = schemaVerdicts([p({})], res, tools as never).find((x) => x.requirement === 'MWS-IN-4' && x.write_path.tool === 'ticket_update')!;
  assert.equal(clean.verdict, 'held');
  assert.ok(clean.notes.some((n) => /Only the refusals of the schema probes/.test(n)));
});

test('R10-8: MWS-IN-5 is violated only on a declared fixed constraint; otherwise seen, not judged', () => {
  const tools = [{ name: 'ticket_update' }];
  const base = M('    try_values: [ { arg: title, length: 150 } ]\n').resources[0]!;
  const fixed = M('    try_values: [ { arg: title, length: 150 } ]\n    fixed_constraints: [ { arg: title, pattern: "at most \\\\d+ characters", reason: "a fixed length limit" } ]\n').resources[0]!;
  const o = [{ tool: 'ticket_update', arg: 'title', value: 'x…', valid: true, ok: false, isError: true, names_arg: true, step: 's', text: 'Invalid title: must be at most 100 characters.' }];
  const seen = in5Verdicts(o, base, tools as never)[0]!;
  assert.equal(seen.verdict, 'not observed');
  assert.ok(seen.notes.some((n) => /Seen, not judged/.test(n) && /at most 100 characters/.test(n)));
  assert.equal(in5Verdicts(o, fixed, tools as never)[0]!.verdict, 'violated');
  const quiet = [{ ...o[0]!, ok: true, isError: false, names_arg: false, text: 'Updated.', stored: false }];
  assert.ok(in5Verdicts(quiet, base, tools as never)[0]!.notes.some((n) => /value is not stored/.test(n)), 'a success that did not store the value counts as refused');
});

test('R10-9: a catalog-only statement leaves out credentials in the command', () => {
  assert.equal(safeCommand(['node', 'server.js', '--token', 'abc123', '--api-key=xyz', '--port', '8080']), 'node server.js --token (left out) --api-key=(left out) --port 8080');
  assert.equal(safeCommand(['npx', 'srv', 'ghp_1234567890abcdefghijklmnopqrstuvwxyz']), 'npx srv (left out)');
  assert.equal(safeCommand(['srv', 'https://user:pw@example.test/mcp?token=t1&x=1']), 'srv https://example.test/mcp?token=(left out)&x=1');
});

test('i8: an ignored field the tool can set is warned, and refused for a selector tool in opt-in mode', () => {
  const tools = [{ name: 'ticket_update', inputSchema: { type: 'object', properties: { id: {}, assignee: {}, note: {} } } }, { name: 'ticket_get' }, { name: 'ticket_create' }, { name: 'ticket_delete' }];
  const m = M('', '').resources[0]!;
  const man = { ...M(), resources: [{ ...m, read: { ...m.read, ignore: ['updated_at', 'note'] } }] } as never;
  const w = ignoreWarnings(man, tools as never);
  assert.equal(w.warnings.length, 1);
  assert.match(w.warnings[0]!, /note/);
  assert.equal(w.refuse.length, 0);
  const sel = { ...M(), resources: [{ ...m, read: { ...m.read, ignore: ['note'] }, scope: null, selector: { tool: 'tickets_delete', args: {}, narrow: null, send_empty_forms: true, forms: [] } }] } as never;
  assert.equal(ignoreWarnings(sel, tools as never).refuse.length, 1);
  assert.throws(() => buildPlan(sel, tools as never), /manifest refused/);
  const managed = { ...M(), resources: [{ ...m, read: { ...m.read, ignore: ['note'] }, server_managed: ['note'], selector: { tool: 'tickets_delete', args: {}, narrow: null, send_empty_forms: true, forms: [] } }] } as never;
  assert.equal(ignoreWarnings(managed, tools as never).refuse.length, 0);
});

test('declared-carryover: declared patterns that do not match other wording never give violated', async () => {
  const { CARRYOVER } = await import('./declared-carryover-cases.js');
  const { readSecondClause } = await import('../../src/checks/types.js');
  // tiny-tracker's own declared patterns (examples/tiny-tracker/writecheck.yaml), carried to other servers' wording.
  const TT = { outcome_unknown: 'not known whether', applied: '(?<!\\bnot )(?<!\\bnothing was )\\b(updated|applied|written|created)\\b' };
  const bad: string[] = [];
  for (const c of CARRYOVER) {
    const v = withP(TT, () => readSecondClause(call({ ok: false, isError: true, text: c.text }), ['assignee'], { assignee: 'zed' }));
    if (v.v === 'violated') bad.push(`${c.case} (truth ${c.truth}): ${c.text}`);
    if (v.v === 'unread') assert.match(v.why, /needs reading/);
  }
  assert.deepEqual(bad, []);
  // A positive match of a pattern that means a violation still decides.
  const sf = withP({ ...TT, not_applied: '\\bfailed\\b|\\bno change was made\\b' }, () => readSecondClause(call({ ok: false, isError: true, text: 'The update failed.' }), ['assignee'], { assignee: 'zed' }));
  assert.equal(sf.v, 'violated');
  const both = withP({ ...TT, not_applied: '\\bfailed\\b' }, () => readSecondClause(call({ ok: false, isError: true, text: 'Update failed after the request was sent; the change may or may not have been made.' }), ['assignee'], { assignee: 'zed' }));
  assert.notEqual(both.v, 'violated', 'an error that also says the outcome may not be known is not a stated failure');
});

test('k1: a record given losses twice (its own check, then the bracket) keeps every lost bystander in bystanders_lost', async () => {
  const { withLoss } = await import('../../src/checks/targeting.js');
  const { result } = await import('../../src/report/verdicts.js');
  const r0 = result('MWS-TGT-1', { resource: 'ticket', tool: 't', arm: 'mcp' } as never, { id: 'x', version: '1' }, 'violated', 'r');
  const r1 = withLoss(r0, [{ gone: ['"inbox"/"B1"'], changed: [], unavailable: null }], false);
  const r2 = withLoss(r1, [], false, [{ gone: ['"inbox"/"B2"'], changed: [], unavailable: null }]);
  assert.deepEqual(r2.numbers['bystanders_lost'], ['"inbox"/"B1"', '"inbox"/"B2"']);
});
