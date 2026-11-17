/**
 * The evaluators against fakes: each takes recorded observations and must give the verdict the
 * requirement's rule says, including the cases that must not be flagged (the non-findings).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { annotationVerdicts, namedBy } from '../../src/checks/annotations.js';
import { identifiesChange, saysUnknown } from '../../src/checks/types.js';
import { usePatterns } from '../../src/checks/says.js';
import { versionLeftOutRuns } from '../../src/checks/stale.js';
import { parseStructured } from '../../src/core/util.js';
import { annVerdicts } from '../../src/checks/catalog.js';
import { pairsExperiment, pairsVerdicts } from '../../src/checks/pairs.js';
import { gatedVerdicts, type GatedObs } from '../../src/checks/gated.js';
import { readbackVerdicts, type CaseObs } from '../../src/checks/readback.js';
import { keptValue, meaningOf, protectedProps, refusalProblem, schemaVerdicts, probeCases, validFor, type ProbeObs } from '../../src/checks/schema.js';
import { staleExperiment, staleVerdicts } from '../../src/checks/stale.js';
import type { ExperimentOutcome } from '../../src/core/exec.js';
import { recount } from '../../src/core/exec.js';
import type { Experiment } from '../../src/core/experiment.js';
import { parseManifestText } from '../../src/core/manifest.js';

const M = (extra = '', mode = 'field_patch', update = '{ id: "{{id}}", "{{field}}": "{{value}}" }') =>
  parseManifestText(
    `mws: "0.9"
server: { stdio: [node, s.js] }
target: { environment: test, confirm: t }
resources:
  - name: ticket
    create: { tool: ticket_create, args: { title: "{{prefix}}t" }, id: id }
    read: { tool: ticket_get, args: { id: "{{id}}" }, object: ticket, ignore: [updated_at] }
    update: { tool: ticket_update, mode: ${mode}, args: ${update} }
    fields: [ { path: assignee, values: [ann, bob] }, { path: status, values: [blocked, closed] } ]
    version: { read: version }
    cleanup: delete
    delete: { tool: ticket_delete, args: { id: "{{id}}" } }
${extra}`,
    'm.yaml',
  );

const CONTROL = `    control:
      base: http://127.0.0.1:1
      read: { http: [GET, "/t/{{id}}"] }
      patch: { http: [PATCH, "/t/{{id}}"], body: { "{{field}}": "{{value}}" } }
      write: { http: [PUT, "/t/{{id}}"], body: "{{object}}" }`;

function outcome(exp: Experiment, counts: Record<string, Record<string, number>>, stopped: string | null = null): ExperimentOutcome {
  const arms: ExperimentOutcome['arms'] = {};
  for (const [k, c] of Object.entries(counts)) arms[k] = { role: exp.arms.find((a) => a.name === k)!.role, description: '', reps_planned: c['reps'] ?? 0, counts: c, reps: [] };
  return { experiment: exp, arms, verdict: { criterion: '', verdict: 'inconclusive', reproduced_rule: false, not_reproduced_rule: false, overlapping_rules: false, values: {} }, simulated: [], stopped };
}

test('barrier pairs: a loss is violated; the same loss through the API is platform; none is never held', () => {
  const res = M(CONTROL).resources[0]!;
  const exp = pairsExperiment(res, 30, 'separate');
  const ok = { validity: { valid: 1, both_kept: 1 } };
  const v = pairsVerdicts(outcome(exp, { ...ok, test: { valid: 30, overlapped: 30, silent_loss: 19, both_ok: 30 }, control: { valid: 30, silent_loss: 0 } }), res, false);
  assert.equal(v[0]!.verdict, 'violated');
  assert.match(v[0]!.reason, /19 of 30/);
  const p = pairsVerdicts(outcome(exp, { ...ok, test: { valid: 30, overlapped: 30, silent_loss: 6 }, control: { valid: 30, silent_loss: 6 } }), res, false);
  assert.equal(p[0]!.verdict, 'platform');
  const n = pairsVerdicts(outcome(exp, { ...ok, test: { valid: 30, overlapped: 30, silent_loss: 0 }, control: { valid: 30, silent_loss: 0 } }), res, true);
  assert.equal(n[0]!.verdict, 'not observed');
  assert.equal(n[0]!.numbers['pairs_overlapped'], 30);
  assert.equal(n[0]!.numbers['loss_rate_upper_95_rule_of_three'], 0.1);
  assert.match(n[0]!.reason, /does not show the server is safe/);
  assert.ok(n[0]!.notes.some((x) => /separate record \(scenario held-request\)/.test(x)), 'with a gate, the pairs record points at the forced one');
  const lo = pairsVerdicts(outcome(exp, { ...ok, test: { valid: 30, overlapped: 14, silent_loss: 0 } }), res, false);
  assert.equal(lo[0]!.verdict, 'not tested');
  assert.match(lo[0]!.reason, /too few overlapped pairs: 14 of 30/, 'spec 8.2 rule 6: 30 overlapped pairs before not observed');
  const dep = pairsVerdicts(outcome(exp, { validity: { valid: 1, both_kept: 0 }, test: { valid: 30, overlapped: 30, silent_loss: 30 } }), res, false);
  assert.equal(dep[0]!.verdict, 'not tested', 'fields that are not independent cannot give a concurrency verdict');
  for (const c of [v, p, n, lo, dep]) assert.notEqual(c[0]!.verdict, 'held');
});

test('stale write: violated, platform, held, and CONC-1 only with a control', () => {
  const res = M(CONTROL, 'full_replace', '{ id: "{{id}}", ticket: "{{object}}" }').resources[0]!;
  const exp = staleExperiment(res, 3);
  const ok = { validity: { valid: 1, both_kept: 1 } };
  const by = (r: ReturnType<typeof staleVerdicts>, id: string) => r.find((x) => x.requirement === id)!;
  const won = staleVerdicts(outcome(exp, { ...ok, test: { valid: 3, stale_won: 3, rejected: 0 }, control: { valid: 3, conflict: 3, stale_2xx_lost: 0 } }), res);
  assert.equal(by(won, 'MWS-CONC-2').verdict, 'violated');
  assert.equal(by(won, 'MWS-CONC-1').verdict, 'violated');
  assert.equal(by(won, 'MWS-CONC-4').verdict, 'not tested');
  const plat = staleVerdicts(outcome(exp, { ...ok, test: { valid: 3, stale_won: 3 }, control: { valid: 3, conflict: 0, stale_2xx_lost: 3 } }), res);
  assert.equal(by(plat, 'MWS-CONC-2').verdict, 'platform');
  assert.equal(by(plat, 'MWS-CONC-1').verdict, 'not applicable', 'spec MWS-CONC-1: the backend did not apply the declared control');
  assert.match(by(plat, 'MWS-CONC-1').reason, /the backend did not apply the declared control/);
  const held = staleVerdicts(outcome(exp, { ...ok, test: { valid: 3, stale_won: 0, rejected: 3, rejected_tool_error: 3, applied_despite_refusal: 0 }, control: { valid: 3, conflict: 3 } }), res);
  assert.equal(by(held, 'MWS-CONC-2').verdict, 'held');
  assert.equal(by(held, 'MWS-CONC-1').verdict, 'held');
  assert.equal(by(held, 'MWS-CONC-4').verdict, 'held');
  const rpc = staleVerdicts(outcome(exp, { ...ok, test: { valid: 3, rejected: 3, rejected_tool_error: 0 }, control: { valid: 3, conflict: 3 } }), res);
  assert.equal(by(rpc, 'MWS-CONC-4').verdict, 'violated');
  const noCtl = M('', 'full_replace', '{ id: "{{id}}", ticket: "{{object}}" }').resources[0]!;
  const nc = staleVerdicts(outcome(staleExperiment(noCtl, 3), { ...ok, test: { valid: 3, stale_won: 1 } }), noCtl);
  assert.equal(by(nc, 'MWS-CONC-2').verdict, 'violated', 'row 4: applied, no control arm (spec MWS-CONC-2 verdicts)');
  assert.equal(by(nc, 'MWS-CONC-2').attribution, 'unresolved', 'spec 8.2 rule 3');
  assert.equal(by(won, 'MWS-CONC-2').attribution, 'server');
  assert.equal(by(plat, 'MWS-CONC-2').attribution, 'platform');
  assert.equal(by(held, 'MWS-CONC-2').attribution, null);
  assert.equal(nc.find((x) => x.requirement === 'MWS-CONC-1'), undefined, 'no CONC-1 verdict without a control');
  const stopped = staleVerdicts(outcome(exp, {}, 'stopped: rate limited'), res);
  assert.ok(stopped.every((r) => r.verdict === 'not tested'));
});

test('barrier pairs: a pair whose answer shows a conflict (declared patterns.conflict) is not "both reported success" (MWS-CONC-3)', () => {
  const res = M().resources[0]!;
  const exp = pairsExperiment(res, 40, 'separate');
  // Raw-statement tool: the second writer's version precondition matched 0 rows; the answer has no isError.
  const half = (text: string) => ({ ok: true, isError: false, text, data: null, tool: 'ticket_update', shape: null });
  const rep = (i: number, bText: string) => ({ rep: i, valid: true, pairs: 1, overlapped: 1, steps: { race: `test.r${i}.race` }, env: { race: { both_ok: true, a: half('modified 1'), b: half(bText) }, final: { ok: true, obj: { assignee: 'bob', status: 'blocked' } } } });
  const run = (bText: string) => {
    const out = recount(exp, { validity: { role: 'validity', description: '', reps_planned: 1, counts: { valid: 1, both_kept: 1 }, reps: [] }, test: { role: 'test', description: '', reps_planned: 40, counts: {}, reps: Array.from({ length: 40 }, (_, i) => rep(i, bText)) } }, [], null);
    out.arms['validity']!.counts = { valid: 1, both_kept: 1 };
    return pairsVerdicts(out, res, false)[0]!;
  };
  try {
    usePatterns({ patterns: { conflict: String.raw`\bmatched 0\b` } } as never);
    const shown = run('matched 0, modified 0');
    assert.notEqual(shown.verdict, 'violated', 'the declared conflict pattern reads the answer as a refusal, not a success');
    assert.equal(shown.verdict, 'not observed');
    assert.equal(shown.numbers['lost'], 0);
    assert.equal(shown.numbers['conflict_shown'], 40);
    assert.ok(shown.notes.some((n) => /is MWS-CONC-4's to judge in its own trials/.test(n)));
    // An answer the declared pattern does not match is still a reported success: the loss stays violated.
    const silent = run('ok');
    assert.equal(silent.verdict, 'violated');
    assert.match(silent.reason, /40 of 40 pairs/);
  } finally {
    usePatterns(null);
  }
  // Without a declaration only the built-in words read "not applied" as a conflict: that decides nothing (rule 11).
  const dflt = run('nothing was written');
  assert.equal(dflt.verdict, 'not tested');
  assert.match(dflt.reason, /needs reading/);
});

test('barrier pairs, mixed runs (review): one silent loss among shown conflicts stays violated; a structured conflict: true is a signal (MWS-CONC-3)', () => {
  const res = M().resources[0]!;
  const exp = pairsExperiment(res, 40, 'separate');
  const half = (text: string, data: unknown = null) => ({ ok: true, isError: false, text, data, tool: 'ticket_update', shape: null });
  const run = (texts: (string | Record<string, unknown>)[]) => {
    const reps = texts.map((t, i) => ({ rep: i, valid: true, pairs: 1, overlapped: 1, steps: { race: `test.r${i}.race` }, env: { race: { both_ok: true, a: half('modified 1'), b: typeof t === 'string' ? half(t) : half('ok', t) }, final: { ok: true, obj: { assignee: 'bob', status: 'blocked' } } } }));
    const out = recount(exp, { validity: { role: 'validity', description: '', reps_planned: 1, counts: {}, reps: [] }, test: { role: 'test', description: '', reps_planned: 40, counts: {}, reps } }, [], null);
    out.arms['validity']!.counts = { valid: 1, both_kept: 1 };
    return pairsVerdicts(out, res, false)[0]!;
  };
  try {
    usePatterns({ patterns: { conflict: String.raw`\bmatched 0\b` } } as never);
    const r = run([...Array<string>(39).fill('matched 0'), 'ok']);
    assert.equal(r.verdict, 'violated');
    assert.equal(r.numbers['lost'], 1);
    assert.equal(r.numbers['conflict_shown'], 39);
    assert.equal(r.steps[0], 'test.r39.race', 'the witness is the counted loss, not a shown conflict');
    assert.match(r.reason, /1 of 40 pairs/);
  } finally {
    usePatterns(null);
  }
  const d = run([...Array<string>(39).fill('nothing was written'), 'ok']);
  assert.equal(d.verdict, 'violated');
  assert.equal(d.numbers['lost'], 1);
  assert.equal(d.numbers['needs_reading'], 39);
  assert.ok(d.notes.some((n) => /39 further pair\(s\).*built-in words/.test(n)));
  const s = run(Array.from({ length: 40 }, () => ({ conflict: true })));
  assert.equal(s.verdict, 'not observed', 'a structured conflict: true shows the conflict without any pattern');
  assert.equal(s.numbers['conflict_shown'], 40);
  assert.equal(s.numbers['lost'], 0);
});

test('held request: a trial whose answer shows a conflict (declared patterns.conflict) is not "both reported success" (MWS-CONC-3)', () => {
  const res = M().resources[0]!;
  // Raw-statement tool: the held writer's version precondition matched 0 rows on release; the answer has no isError.
  const cb = (step: string, text: string) => ({ step, ok: true, isError: false, rpc_error: null, text, data: null, indeterminate: false, tool: 'ticket_update', shape: null });
  const trial = (i: number, schedule: 'hold A, run B' | 'hold B, run A', holderText: string) => ({ schedule, held: { seq: 10 + i, method: 'PATCH', path: '/t/T1' }, released: 'after the other writer finished' as const, holder: cb(`h${i}`, holderText), other: cb(`o${i}`, 'modified 1'), kept: { holder: false, other: true }, steps: [`h${i}`, `o${i}`] });
  const run = (holderText: string) => {
    const o: GatedObs = { routing: 'r', learned: [], trials: [0, 1, 2, 3].map((i) => trial(i, i % 2 ? 'hold B, run A' : 'hold A, run B', holderText)), control: null, independent: true, conc1: null, res2: null, atom: null };
    return gatedVerdicts(o, res).find((x) => x.requirement === 'MWS-CONC-3')!;
  };
  try {
    usePatterns({ patterns: { conflict: String.raw`\bmatched 0\b` } } as never);
    const shown = run('matched 0, modified 0');
    assert.equal(shown.verdict, 'held', 'the declared conflict pattern reads the answer as a refusal, not a success');
    assert.equal(shown.numbers['lost'], 0);
    assert.equal(shown.numbers['conflict_shown'], 4);
    assert.ok(shown.notes.some((n) => /is MWS-CONC-4's to judge in its own trials/.test(n)));
    assert.ok(shown.notes.some((n) => /holder answered without isError but showed a conflict/.test(n)));
    // An answer the declared pattern does not match is still a reported success: the loss stays violated.
    const silent = run('ok');
    assert.equal(silent.verdict, 'violated');
    assert.match(silent.reason, /4 of 4 forced trials/);
  } finally {
    usePatterns(null);
  }
  // Without a declaration only the built-in words read "nothing was written" as a conflict: that decides nothing (rule 11).
  const dflt = run('nothing was written');
  assert.equal(dflt.verdict, 'not tested');
  assert.match(dflt.reason, /needs reading/);
  assert.equal(dflt.numbers['needs_reading'], 4);
});

test('CONC-3: an answer that showed a conflict while its own change took effect and the other writer lost is recorded, not counted (review item 3)', () => {
  const res = M().resources[0]!;
  // assignee (writer A, field 0) = bob is in effect; status (writer B, field 1) stays blocked, so B's change is lost.
  const exp = pairsExperiment(res, 40, 'separate');
  const half = (text: string) => ({ ok: true, isError: false, text, data: null, tool: 'ticket_update', shape: null });
  const pairs = (aText: string, bText: string) => {
    const reps = Array.from({ length: 40 }, (_, i) => ({ rep: i, valid: true, pairs: 1, overlapped: 1, steps: { race: `test.r${i}.race` }, env: { race: { both_ok: true, a: half(aText), b: half(bText) }, final: { ok: true, obj: { assignee: 'bob', status: 'blocked' } } } }));
    const out = recount(exp, { validity: { role: 'validity', description: '', reps_planned: 1, counts: {}, reps: [] }, test: { role: 'test', description: '', reps_planned: 40, counts: {}, reps } }, [], null);
    out.arms['validity']!.counts = { valid: 1, both_kept: 1 };
    return pairsVerdicts(out, res, false)[0]!;
  };
  // Held request: the holder's change is absent, the other's present.
  const cb = (step: string, text: string) => ({ step, ok: true, isError: false, rpc_error: null, text, data: null, indeterminate: false, tool: 'ticket_update', shape: null });
  const held = (holderText: string, otherText: string) => {
    const trials = [0, 1, 2, 3].map((i) => ({ schedule: (i % 2 ? 'hold B, run A' : 'hold A, run B') as 'hold A, run B' | 'hold B, run A', held: { seq: i, method: 'PATCH', path: '/t/T1' }, released: 'after the other writer finished' as const, holder: cb(`h${i}`, holderText), other: cb(`o${i}`, otherText), kept: { holder: false, other: true }, steps: [] }));
    return gatedVerdicts({ routing: 'r', learned: [], trials, control: null, independent: true, conc1: null, res2: null, atom: null }, res).find((x) => x.requirement === 'MWS-CONC-3')!;
  };
  try {
    usePatterns({ patterns: { conflict: String.raw`\bmatched 0\b` } } as never);
    const truthful = pairs('modified 1', 'matched 0');
    assert.equal(truthful.numbers['conflict_shown_own_applied'], 0, 'B said refused and its change is absent');
    const falseRefusal = pairs('matched 0', 'ok');
    assert.equal(falseRefusal.verdict, 'not observed', 'not a CONC-3 loss under the spec text');
    assert.equal(falseRefusal.numbers['conflict_shown'], 40);
    assert.equal(falseRefusal.numbers['conflict_shown_own_applied'], 40);
    assert.ok(falseRefusal.notes.some((n) => /false refusal/.test(n)));
    assert.equal(held('matched 0', 'ok').numbers['conflict_shown_own_applied'], 0);
    const h = held('ok', 'matched 0');
    assert.equal(h.verdict, 'held');
    assert.equal(h.numbers['conflict_shown_own_applied'], 4);
    assert.ok(h.notes.some((n) => /false refusal/.test(n)));
  } finally {
    usePatterns(null);
  }
});

test('recount re-derives the counters from recorded repetitions', () => {
  const res = M().resources[0]!;
  const exp = pairsExperiment(res, 2, 'separate');
  const rep = (lost: boolean, i: number) => ({ rep: i, valid: true, pairs: 1, overlapped: 1, steps: {}, env: { race: { both_ok: true, a: { ok: true }, b: { ok: true } }, final: { ok: true, obj: { assignee: 'bob', status: lost ? 'blocked' : 'closed' } } } });
  const out = recount(exp, { test: { role: 'test', description: '', reps_planned: 2, counts: {}, reps: [rep(true, 0), rep(false, 1)] } }, [], null);
  assert.equal(out.arms['test']!.counts['silent_loss'], 1);
  assert.equal(out.arms['test']!.counts['overlapped'], 2);
});

const tc = (o: Partial<NonNullable<CaseObs['tool']>>): CaseObs['tool'] => ({ ok: true, isError: false, rpc_error: null, text: null, diff: [], applied: true, settled: true, reads: 1, steps: ['s'], ...o });

test('read-after-write: unrelated change, silent no-op and change-despite-error; what the API also does is platform', () => {
  const res = M().resources[0]!;
  const by = (r: ReturnType<typeof readbackVerdicts>, id: string) => r.find((x) => x.requirement === id)!;
  const bad = readbackVerdicts(
    [
      { case: 'set_field', value: 'bob', tool: tc({ diff: [{ path: 'assignee', kind: 'changed' }, { path: 'status', kind: 'changed' }] }), control: { status: 200, diff: [{ path: 'assignee', kind: 'changed' }], applied: true } },
      { case: 'empty_value', value: '', tool: tc({ applied: false }), control: { status: 200, diff: [], applied: true } },
      { case: 'invalid_type', value: 12345, tool: tc({ ok: false, isError: true, diff: [{ path: 'assignee', kind: 'changed' }] }), control: null },
    ],
    res,
  );
  assert.equal(by(bad, 'MWS-UPD-1').verdict, 'violated');
  assert.equal(by(bad, 'MWS-RES-1').verdict, 'violated');
  // Note 19 (rule 11): the second clause of MWS-RES-2 is read by declared patterns only.
  assert.equal(by(bad, 'MWS-RES-2').verdict, 'not tested');
  usePatterns({ patterns: { applied: 'was updated', outcome_unknown: 'not known whether' } } as never);
  const badDecl = readbackVerdicts([{ case: 'invalid_type', value: 12345, tool: tc({ ok: false, isError: true, diff: [{ path: 'assignee', kind: 'changed' }] }), control: null }], res);
  usePatterns(null);
  assert.equal(by(badDecl, 'MWS-RES-2').verdict, 'not tested', 'declared-carryover: the error has no text, so no declared pattern that means a violation matches');
  const plat = readbackVerdicts([{ case: 'set_field', value: 'bob', tool: tc({ diff: [{ path: 'assignee', kind: 'changed' }, { path: 'labels', kind: 'changed' }] }), control: { status: 200, diff: [{ path: 'assignee', kind: 'changed' }, { path: 'labels', kind: 'changed' }], applied: true } }, { case: 'empty_value', value: '', tool: tc({ applied: false }), control: { status: 200, diff: [], applied: false } }], res);
  assert.equal(by(plat, 'MWS-UPD-1').verdict, 'platform');
  assert.equal(by(plat, 'MWS-RES-1').verdict, 'platform');
  const good = readbackVerdicts([{ case: 'set_field', value: 'bob', tool: tc({ diff: [{ path: 'assignee', kind: 'changed' }] }), control: null }, { case: 'invalid_type', value: 1, tool: tc({ ok: false, isError: true }), control: null }], res);
  assert.deepEqual(good.map((r) => r.verdict), ['held', 'held', 'held']);
  const full = M('', 'full_replace', '{ id: "{{id}}", ticket: "{{object}}" }').resources[0]!;
  assert.equal(readbackVerdicts([{ case: 'set_field', value: 'bob', tool: tc({ diff: [{ path: 'status', kind: 'changed' }] }), control: null }], full).find((r) => r.requirement === 'MWS-UPD-1'), undefined, 'UPD-1 does not apply to a full_replace tool');
});

const probe = (o: Partial<ProbeObs>): ProbeObs => ({ tool: 'ticket_update', role: 'update', prop: 'priority', name: 'non_numeric_string', requirement: 'MWS-IN-1', value: '"abc"', sent: 'abc', type: 'integer', required: false, ok: false, isError: true, rpc_error: null, text: 'invalid arguments: priority must be an integer', step: 's', ...o });

test('schema probes: accepted is violated; a refusal must be a tool error naming the field; a status in the result is set aside', () => {
  const res = M().resources[0]!;
  const tools = [{ name: 'ticket_get' }, { name: 'ticket_update' }];
  const by = (r: ReturnType<typeof schemaVerdicts>, id: string, tool = 'ticket_update') => r.find((x) => x.requirement === id && x.write_path.tool === tool)!;
  // NF-21: "5" used as 5 keeps the meaning: never MWS-IN-1, always MWS-IN-6.
  const kept = schemaVerdicts([probe({ ok: true, isError: false, name: 'numeric_string', sent: '5', meaning: meaningOf('5', 5, 'integer', false, { known: true, value: 2 }) }), probe({})], res, tools);
  assert.equal(by(kept, 'MWS-IN-1').verdict, 'held');
  assert.equal(by(kept, 'MWS-IN-6').verdict, 'violated');
  const unsure = schemaVerdicts([probe({ ok: true, isError: false, meaning: null })], res, tools);
  assert.equal(by(unsure, 'MWS-IN-1').verdict, 'not tested', 'the value used could not be established');
  const r = schemaVerdicts([probe({ ok: true, isError: false, name: 'null', sent: null, meaning: meaningOf(null, 0, 'integer', false, { known: true, value: 2 }) }), probe({}), probe({ prop: 'mwsc_undefined_argument', requirement: 'MWS-IN-2', ok: true, isError: false }), probe({ prop: 'status', requirement: 'MWS-IN-3', name: 'not_in_enum', ok: true, isError: false, text: '{"status": 404}' })], res, tools);
  assert.equal(by(r, 'MWS-IN-1').verdict, 'violated', 'null used as 0');
  assert.equal(by(r, 'MWS-IN-6').verdict, 'violated');
  assert.equal(by(r, 'MWS-IN-2').verdict, 'violated');
  assert.equal(by(r, 'MWS-IN-3').verdict, 'not tested', 'the only IN-3 case was set aside (status in result)');
  assert.ok(by(r, 'MWS-IN-3').notes.some((n) => /STATUS_IN_RESULT/.test(n)));
  assert.equal(by(r, 'MWS-IN-4').verdict, 'held');
  // The meaning rule, case by case (spec MWS-IN-1).
  const k = { known: true, value: 'old' };
  assert.equal(meaningOf('false', true, 'boolean', false, k).kind, 'changes');
  assert.equal(meaningOf('false', false, 'boolean', false, k).kind, 'keeps');
  assert.equal(meaningOf(1, true, 'boolean', false, k).kind, 'observation', '1 used as true is an observation');
  assert.equal(meaningOf('yes', true, 'boolean', false, k).kind, 'observation');
  assert.equal(meaningOf(5, '5', 'string', false, k).kind, 'keeps');
  assert.equal(meaningOf({ a: 1 }, '[object Object]', 'string', false, k).kind, 'changes');
  assert.equal(meaningOf(0.5, 0, 'integer', false, k).kind, 'changes');
  assert.equal(meaningOf(null, 'old', 'string', false, k).kind, 'keeps', 'null treated as not sent');
  assert.equal(meaningOf(null, 'x', 'string', true, k).kind, 'changes', 'null for a required argument replaced');
  assert.equal(meaningOf('', 0, 'integer', false, k).kind, 'changes');
  assert.equal(meaningOf('abc', 7, 'integer', false, k).kind, 'changes');
  assert.equal(meaningOf(true, 'old', 'string', false, k).kind, 'changes', 'a value other than null dropped');
  assert.equal(meaningOf(0, false, 'boolean', false, { known: true, value: false }).kind, 'unknown', 'a conversion that lands on the stored value cannot be told from a drop (review)');
  assert.equal(meaningOf(null, 'kept', 'string', true, { known: true, value: 'kept' }).kind, 'observation', 'null for a required argument treated as unset');
  assert.equal(validFor({ type: 'integer', multipleOf: 5 }, 7), false);
  assert.equal(validFor({ type: 'array', maxItems: 1 }, [1, 2]), false);
  assert.ok(!probeCases({ type: 'object', properties: { n: { type: 'integer', multipleOf: 1 } } }, new Set()).some((c) => c.name === 'not_multiple'), 'no integer is not a multiple of 1');
  assert.equal(saysUnknown({ text: "assignee 'zed' is unknown", data: null }), false);
  assert.equal(saysUnknown({ text: 'The connection broke; it may have succeeded. Read the ticket before retrying.', data: null }), true);
  assert.equal(identifiesChange({ text: 'assignee: nothing was written', data: null }, 'assignee'), false);
  assert.equal(keptValue('5', 'number'), 5);
  assert.equal(keptValue('5x', 'number'), undefined);
  const pc = probeCases({ type: 'object', properties: { b: { type: 'boolean' }, n: { type: ['integer', 'null'] }, s: { type: 'string', pattern: '^[a-z]+$' }, title: { type: 'string' } } }, new Set());
  assert.deepEqual(pc.filter((c) => c.prop === 'b' && c.requirement === 'MWS-IN-1').map((c) => c.value), ['false', 'true', 'yes', 0, 1, null, { a: 1 }, [1]]);
  assert.ok(!pc.some((c) => c.prop === 'n' && c.value === null), 'a probe of a declared type is skipped');
  assert.ok(pc.some((c) => c.prop === 'n' && c.value === 0.5));
  assert.ok(pc.some((c) => c.prop === 's' && c.name === 'pattern_mismatch'));
  assert.ok(pc.some((c) => c.name === 'misspelled_argument' && c.prop === 'ttle') && pc.some((c) => c.name === 'undefined_argument'));
  const union = probeCases({ type: 'object', properties: { id: { type: ['string', 'number'] } } }, new Set()).filter((c) => c.requirement === 'MWS-IN-1').map((c) => c.value);
  assert.ok(!union.some((v) => typeof v === 'number' || typeof v === 'string'), 'a value of any declared type is never a wrong-type probe (CLI-BUGS item 3)');
  assert.ok(union.some((v) => v === true) && union.some((v) => v === null));
  assert.deepEqual(parseStructured('Resource from collection "tasks":\n{"id": 8, "title": "x"}'), { id: 8, title: 'x' });
  assert.deepEqual(parseStructured('Updated.\n\n```json\n{"id": 8}\n```\n'), { id: 8 });
  assert.equal(validFor({ type: 'string', maxLength: 200 }, 'x'.repeat(150)), true);
  assert.equal(validFor({ type: 'integer', minimum: 1 }, 0), false);
  assert.match(refusalProblem(probe({ rpc_error: { code: -32603, message: 'x' } }))!, /JSON-RPC error \(-32603\)/);
  assert.equal(refusalProblem(probe({ text: 'TypeError: Cannot read properties of undefined (priority)' })), null, 'runtime internals are guidance, not the requirement');
  assert.match(refusalProblem(probe({ rpc_error: { code: -32602, message: 'priority: bad' } }))!, /JSON-RPC error \(-32602\) instead of a tool execution error/);
  assert.match(refusalProblem(probe({ text: 'bad request' }))!, /does not name/);
  const cases = probeCases({ type: 'object', properties: { id: { type: 'string' }, n: { type: 'integer', minimum: 1, maximum: 5 }, s: { type: 'string', enum: ['a'] } }, required: ['id'] }, new Set(['id']));
  assert.ok(!cases.some((c) => c.prop === 'id'), 'protected properties are never probed');
  assert.deepEqual([...new Set(cases.map((c) => c.requirement))].sort(), ['MWS-IN-1', 'MWS-IN-2', 'MWS-IN-3']);
});

test('annotations: only an explicit optimistic claim can be violated', () => {
  const res = M().resources[0]!;
  const v = annotationVerdicts(
    [
      { tool: 'ticket_list', role: 'list', annotations: { readOnlyHint: true }, ann1: { calls: 2, changed: [{ path: 'seen', kind: 'added' }], steps: ['s'] } },
      { tool: 'ticket_get', role: 'read', annotations: { readOnlyHint: true }, ann1: { calls: 2, changed: [], steps: [] } },
      { tool: 'ticket_update', role: 'update', annotations: { destructiveHint: false, idempotentHint: true }, ann2: { replaced: true, unnamed: [], detail: 'it replaced assignee: ann → bob', steps: ['s'] }, ann3: { first_ok: true, second_ok: true, changed: [], steps: [] } },
      { tool: 'ticket_delete', role: 'delete', annotations: {} },
      { tool: 'label_add', role: 'call', annotations: { destructiveHint: false }, ann2: { replaced: true, unnamed: ['labels[0]'], detail: 'it changed or removed labels[0]', steps: ['s'] } },
    ],
    [],
    res,
  );
  const f = (tool: string, id: string) => v.find((x) => x.write_path.tool === tool && x.requirement === id)!.verdict;
  assert.equal(f('ticket_list', 'MWS-ANN-1'), 'violated');
  assert.equal(f('ticket_get', 'MWS-ANN-1'), 'not observed');
  assert.equal(f('ticket_update', 'MWS-ANN-2'), 'not observed', 'overwriting the field the call names is not MWS-ANN-2');
  assert.equal(f('ticket_update', 'MWS-ANN-5'), 'violated', 'but it is not additive');
  assert.equal(f('label_add', 'MWS-ANN-2'), 'violated', 'removing an element the call did not name');
  assert.equal(f('label_add', 'MWS-ANN-5'), 'violated');
  assert.ok(!v.some((x) => ['MWS-ANN-1', 'MWS-ANN-2', 'MWS-ANN-3', 'MWS-ANN-5'].includes(x.requirement) && x.verdict === 'held'), 'spec 8.2 rule 8');
  assert.equal(f('ticket_update', 'MWS-ANN-3'), 'not observed', 'spec 8.2 rule 8: a claim about all state is never held');
  assert.equal(f('ticket_delete', 'MWS-ANN-1'), 'not applicable');
  assert.equal(f('ticket_delete', 'MWS-ANN-2'), 'not applicable', 'the cautious default is never a violation');
  assert.equal(namedBy({ id: 'T1', label: 'a' }, { labels: ['a', 'b'] }, 'labels[0]'), true);
  assert.equal(namedBy({ id: 'T1', label: 'd' }, { labels: ['a', 'b'] }, 'labels[0]'), false);
  assert.equal(namedBy({ id: 'T1', title: 'x' }, { title: 'y' }, 'title'), true);
  assert.equal(namedBy({ id: 'T1', comment_id: 'C2' }, { comments: [{ id: 'C2', body: 'b' }] }, 'comments[0].body'), true);
  const cat = annVerdicts([{ name: 'a', annotations: { readOnlyHint: true } }, { name: 'b', annotations: { readOnlyHint: false } }, { name: 'c' }]);
  assert.deepEqual(cat.map((r) => r.verdict), ['held', 'violated', 'violated']);
});

test('schema probes on a write tool never touch the selector, the id or a scope argument', () => {
  const schema = { type: 'object', properties: { where: { type: 'object' }, path: { type: 'string' }, assignee: { type: 'string' }, project_id: { type: 'integer' }, note: { type: 'string' } } };
  const p = protectedProps({ where: { id: 'T7' }, path: 'tickets/T7', assignee: 'ann' }, 'assignee', ['T7', 'mwsc-r-'], schema);
  assert.ok(p.has('where') && p.has('path') && p.has('project_id'));
  assert.ok(!p.has('assignee') && !p.has('note'));
  assert.ok(protectedProps({ assignee: 'mwsc-r-x' }, 'assignee', ['mwsc-r-'], schema).has('assignee'), 'the field under test is protected too if it carries the prefix');
});

test('MWS-CONC-2 second run (0852410): only whole-object and delete tools with an optional version; never a field patch', () => {
  const m = (mode: string) =>
    parseManifestText(
      `mws: "0.9"
server: { stdio: [node, s.js] }
target: { environment: test, confirm: t }
resources:
  - name: ticket
    create: { tool: ticket_create, args: { title: "{{prefix}}t" }, id: id }
    read: { tool: ticket_get, args: { id: "{{id}}" }, object: ticket }
    update: { tool: ticket_update, mode: ${mode}, args: ${mode === 'full_replace' ? '{ id: "{{id}}", ticket: "{{object}}", v: "{{?version}}" }' : '{ id: "{{id}}", "{{field}}": "{{value}}", v: "{{?version}}" }'} }
    fields: [ { path: assignee, values: [ann, bob] }, { path: status, values: [blocked, closed] } ]
    version: { read: version, arg: v, optional: true, override: force }
    delete: { tool: ticket_delete, args: { id: "{{id}}", v: "{{?version}}" } }
    cleanup: delete
`,
      'm.yaml',
    ).resources[0]!;
  const fp = versionLeftOutRuns(m('field_patch'));
  assert.deepEqual(fp.map((r) => r.tool), ['ticket_delete'], 'the field-patch update gets no second run (NF-12)');
  assert.deepEqual(fp[0]!.bare, { id: '{{id}}' }, 'neither the version nor the override is sent');
  const fr = versionLeftOutRuns(m('full_replace'));
  assert.deepEqual(fr.map((r) => `${r.kind}:${r.tool}`).sort(), ['delete:ticket_delete', 'write:ticket_update']);
});
