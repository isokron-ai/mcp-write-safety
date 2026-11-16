/**
 * MWS-RETRY-2 (spec 098621b; DECISIONS R8-1 to R8-3): every verdict branch of every step, including the answers that
 * must NOT be `violated` (a correct server is never accused) and the ones that must NOT be `held`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_PATTERNS, says, usePatterns } from '../../src/checks/says.js';
import { identifiesChange, mentions, res2Judge, saysUnknown } from '../../src/checks/types.js';
import { applications, combineABC, judgeA, judgeB, judgeC, judgeCrash, judgeD, judgePair, judgeProxy, judgeRestart, NOTE_KEY_RECORD, NOTE_OUTCOME, res2Cross, res2CrossNote, type CallObs, type CrashObs, type Decl, type PairObs, type ProxyObs, type RestartObs, type StepAObs, type TraceRead } from '../../src/checks/retry2.js';
import { declOf, idempotencyVerdicts, keyedUpdateArgs, undoneBy, variedArgs, versionSent } from '../../src/checks/idempotency.js';
import { Driver } from '../../src/core/driver.js';
import { parseManifestText } from '../../src/core/manifest.js';

/**
 * Review of note 19 (7): whether a refusal says nothing about the write is read only by a declared patterns.unavailable. These
 * tests exercise the step logic with the default unavailable pattern declared; the rule-11 tests without it use withNone.
 */
const BASE = { unavailable: DEFAULT_PATTERNS.unavailable };
function resetP(): void {
  usePatterns({ patterns: BASE } as never);
}
function withNone<T>(f: () => T): T {
  usePatterns(null);
  try {
    return f();
  } finally {
    resetP();
  }
}
resetP();

/** Rule 11 (note 19): a reading of an error decides only through a declared pattern; these tests declare the one they read by. */
const APPLIED = { applied: String.raw`\b(was created|was updated|were updated|already set|updated to)\b` };
const withP = <T>(p: Record<string, string>, f: () => T): T => {
  usePatterns({ patterns: { ...BASE, ...p } } as never);
  try {
    return f();
  } finally {
    resetP();
  }
};

const D = (o: Partial<Decl> = {}): Decl => ({ kind: 'create', countable: true, caller_named: false, carries_version: false, own_checks: [], backend_key: null, key_record_survives: null, key_lifetime: null, update_fields: {}, version_path: null, replay_declared: false, ...o });
const U = (o: Partial<Decl> = {}): Decl => D({ kind: 'update', update_fields: { title: 'mwsc-x' }, version_path: 'version', ...o });

let seq = 0;
/** A create trace with n objects carrying the marker (ids T1..Tn). */
const T = (n: number, o: Partial<TraceRead> = {}): TraceRead => ({ step: `trace.${++seq}`, ok: true, count: n, ids: Array.from({ length: n }, (_, i) => `T${i + 1}`), version: null, digest: null, t_ms: seq, ...o });
/** An update trace at version v. */
const TV = (v: number, o: Partial<TraceRead> = {}): TraceRead => ({ step: `trace.${++seq}`, ok: true, count: null, ids: [], version: v, digest: `d${v}`, t_ms: seq, ...o });
const C = (o: Partial<CallObs> = {}): CallObs => ({ step: `call.${++seq}`, ok: true, isError: false, rpc_error: null, text: 'Created ticket T1 (version 1).', data: { id: 'T1', version: 1 }, indeterminate: false, id: 'T1', version: 1, replay_marked: null, t_start_ms: 0, t_end_ms: 10, ...o });
const ERR = (text: string, o: Partial<CallObs> = {}): CallObs => C({ ok: false, isError: true, text, data: null, id: null, version: null, ...o });

const A = (o: Partial<StepAObs>): StepAObs => ({ key: 'K', t0: T(0), a1: C(), t1: T(1), a2: C({ replay_marked: true }), t2: T(1), ...o });

test('step (a): one application and the same result is held; a replay marker or another sentence is not a different result', () => {
  assert.equal(judgeA(A({}), D()).verdict, 'held');
  assert.equal(judgeA(A({ a2: C({ text: 'Ticket T1 was already created (replay).', replay_marked: true }) }), D()).verdict, 'held');
  // The id only in the text still counts as the same identifier.
  assert.equal(judgeA(A({ a2: C({ id: null, text: 'Already done: T1' }) }), D()).verdict, 'held');
});

test('step (a): counted twice is violated, whatever caused it (the server\'s own retry included)', () => {
  assert.equal(judgeA(A({ t2: T(2) }), D()).verdict, 'violated');
  assert.equal(judgeA(A({ t1: T(2), t2: T(2) }), D()).verdict, 'violated', 'the first call itself applied twice');
  // Before rule 5: a timed-out first call with two applications is still violated.
  assert.equal(judgeA(A({ a1: C({ indeterminate: true, ok: false }), t2: T(2) }), D()).verdict, 'violated');
});

test('step (a): the conditions that were not forced are not tested, never violated', () => {
  assert.equal(judgeA(A({ t1: T(0), a1: ERR('Invalid title. Nothing was written.') }), D()).verdict, 'not tested', 'the first call did not apply');
  assert.equal(judgeA(A({ t1: T(0), t2: T(1), a1: ERR('Invalid title.') }), D()).verdict, 'not tested', 'applied by the repeat only');
  assert.equal(judgeA(A({ a1: ERR('The backend could not be reached. It is not known whether the change was applied.') }), D()).verdict, 'not tested', 'applied, answered neither success nor identifying error');
  assert.equal(judgeA(A({ a1: C({ ok: false, indeterminate: true }) }), D()).verdict, 'not tested', 'the first call timed out');
  assert.equal(judgeA(A({ a2: C({ ok: false, indeterminate: true }) }), D()).verdict, 'not tested', 'the repeat timed out (rule 5)');
  assert.equal(judgeA(A({ a1: C({ indeterminate: true, ok: false, result_type: 'input_required' }) }), D()).verdict, 'not tested', 'input_required is not finished here');
  const un = judgeA(A({ a2: ERR('Rate limited: try again later. Nothing was written.') }), D());
  assert.equal(un.verdict, 'not tested', 'a refusal that says nothing about the write');
  assert.ok(un.notes.some((n) => /unavailable/.test(n)), 'rule 11: the pattern that decided it is named');
  assert.equal(judgeA(A({ t1: { ...T(1), ok: false, reason: 'list failed' } }), D()).verdict, 'not tested', 'the trace could not be read');
  assert.equal(judgeA(A({}), U({ countable: false })).verdict, 'not tested', 'an update without version_steps leaves no trace');
});

test('step (a): after a first answer that gave the outcome, any other repeat is violated (unknown, a refusal, another id or version)', () => {
  // F4 / S1: only a declared pattern reads a refusal; an unread one is not tested.
  assert.equal(judgeA(A({ a2: ERR('It is not known whether the change was applied.') }), D()).verdict, 'not tested');
  const unk = withP({ outcome_unknown: 'not known whether' }, () => judgeA(A({ a2: ERR('It is not known whether the change was applied.') }), D()));
  assert.equal(unk.verdict, 'violated');
  assert.ok(withP({ outcome_unknown: DEFAULT_PATTERNS.outcome_unknown }, () => judgeA(A({ a2: ERR('It is not known whether the change was applied.') }), D())).notes.some((n) => /outcome unknown/.test(n)));
  assert.equal(withP({ repeat_refused: 'idempotency key is locked' }, () => judgeA(A({ a2: ERR('Refused: this idempotency key is locked.') }), D())).verdict, 'violated');
  assert.equal(judgeA(A({ a2: C({ id: 'T9', text: 'Created ticket T9.' }) }), D()).verdict, 'violated');
  assert.equal(judgeA(A({ a2: C({ version: 2 }) }), D()).verdict, 'violated');
  // An identifying error as the first answer gives the outcome; a repeat that repeats it has the outcome too (declared patterns.applied).
  const ident = ERR('Ticket T1 was created, but adding its labels failed.');
  assert.equal(withP(APPLIED, () => judgeA(A({ a1: ident, a2: ident }), D())).verdict, 'held');
  assert.equal(withP(APPLIED, () => judgeA(A({ a1: ident, a2: C() }), D())).verdict, 'held');
  // Note 19, R1: without the declared pattern the error is not read either way.
  const r1 = judgeA(A({ a1: ident, a2: ERR('Ticket T1 was created by the earlier call (its status is unchanged since then); the labels step failed.') }), D());
  assert.equal(r1.verdict, 'not tested', r1.reason);
  assert.match(r1.reason, /patterns\.applied/);
  // Note 19, R2: after a first success, an error repeat is not a success, whatever its words.
  assert.equal(withP(APPLIED, () => judgeA(A({ a2: ERR('Ticket T1 was created with the title x.') }), D())).verdict, 'violated');
});

test('step (a) for an update with version_steps: the version counts applications', () => {
  const a = (o: Partial<StepAObs>) => judgeA({ key: 'K', t0: TV(3), a1: C({ id: null, version: 4, text: 'Updated, version 4.' }), t1: TV(4), a2: C({ id: null, version: 4, text: 'Updated, version 4 (replay).' }), t2: TV(4), ...o }, U());
  assert.equal(a({}).verdict, 'held');
  assert.equal(a({ t2: TV(5) }).verdict, 'violated');
  assert.equal(a({ t1: TV(3), t2: TV(3) }).verdict, 'not tested', 'not applied');
  assert.equal(applications(TV(3), TV(5), U()), 2);
  assert.equal(applications(TV(3), TV(5), U({ countable: false })), null);
});

const B = (o: Partial<Parameters<typeof judgeB>[0]>) => judgeB({ key: 'K2', t0: T(1), b: C({ id: 'T2', text: 'Created ticket T2.' }), t1: T(2), earlier: { id: 'T1', version: 1, applied: true }, ...o }, D());

test('step (b): a new key applied as a new write is held; a replay of the earlier call or a refusal because it repeats is violated', () => {
  assert.equal(B({}).verdict, 'held');
  assert.equal(B({ b: C({ id: 'T1', replay_marked: true }), t1: T(1) }).verdict, 'violated', 'declared replay indicator');
  const rp = B({ b: C({ id: 'T1', text: 'Already processed; replayed.' }), t1: T(1) });
  assert.equal(rp.verdict, 'violated', 'replay pattern');
  assert.ok(rp.notes.some((n) => /pattern for replay/.test(n)));
  // The patterns read what the answer says, never its field names; with an indicator declared, the indicator decides.
  assert.equal(B({ b: C({ id: 'T2', text: '{"id":"T2","replayed":false}', data: { id: 'T2', replayed: false } }) }).verdict, 'held');
  assert.equal(judgeB({ key: 'K2', t0: T(1), b: C({ id: 'T2', text: 'Created T2; this is not a replay.', replay_marked: false }), t1: T(2), earlier: { id: 'T1', version: 1, applied: true } }, D({ replay_declared: true })).verdict, 'held');
  assert.equal(B({ b: C({ id: 'T1', text: 'Created ticket T1.' }), t1: T(1) }).verdict, 'violated', 'the first call\'s id where a new object could have been made');
  assert.equal(B({ b: C({ id: 'T1', text: 'Created ticket T1.' }), t1: T(2) }).verdict, 'violated', 'a new object made, yet answered with the earlier id');
  // Rule 11: the default repeat_refused pattern alone gives not tested, quoting the text; a declared pattern decides.
  const rr = B({ b: ERR('Refused: this call was already received.'), t1: T(1) });
  assert.equal(rr.verdict, 'not tested', 'refused because it repeats, by the default pattern only');
  assert.ok(rr.notes.some((n) => /repeat refused/.test(n)));
  assert.match(rr.reason, /patterns\.repeat_refused/);
  assert.equal(withPatterns({ repeat_refused: 'already received' }, () => B({ b: ERR('Refused: this call was already received.'), t1: T(1) }).verdict), 'violated', 'refused because it repeats, by the declared pattern');
});

test('step (b): refusals on their own merits are never violated; undecidable ones are not tested with what to declare', () => {
  const dupName = ERR('Project mwsc-p1 already exists; nothing was changed. Choose another key.');
  const named = (o: Partial<Decl>) => judgeB({ key: 'K2', t0: T(1), b: dupName, t1: T(1), earlier: { id: 'mwsc-p1', version: 1, applied: true } }, D({ caller_named: true, ...o }));
  assert.equal(named({ own_checks: ['name'] }).verdict, 'held', 'the declared name check refused it');
  const nt = named({});
  assert.equal(nt.verdict, 'not tested', 'without the declaration it is not tested, never violated');
  assert.match(nt.reason, /own_checks: \[name\]/);
  assert.equal(judgeB({ key: 'K2', t0: TV(4), b: ERR('Conflict: the ticket changed since version 3. Nothing was written.'), t1: TV(4), earlier: { id: null, version: 4, applied: true } }, U({ carries_version: true, own_checks: ['version'] })).verdict, 'held', 'a stale version refused by the declared version check');
  assert.equal(B({ b: ERR('Too many requests; try again later.'), t1: T(1) }).verdict, 'not tested', 'unavailable');
  assert.equal(B({ b: ERR('Something went wrong.'), t1: T(1) }).verdict, 'not tested', 'a refusal whose reason cannot be decided');
});

test('step (b): a write that cannot take effect a second time, answered without saying replay, is not tested (NF-5, NF-24)', () => {
  // A skipped no-op update under a new key: the version did not change.
  const noop = judgeB({ key: 'K2', t0: TV(4), b: C({ id: null, version: 4, text: 'No change: already had these values.' }), t1: TV(4), earlier: { id: null, version: 4, applied: true } }, U());
  assert.equal(noop.verdict, 'not tested');
  assert.match(noop.reason, /NF-5, NF-24/);
  // The same update applied again (the version stepped): a new write, held.
  assert.equal(judgeB({ key: 'K2', t0: TV(4), b: C({ id: null, version: 5, text: 'Updated, version 5.' }), t1: TV(5), earlier: { id: null, version: 4, applied: true } }, U()).verdict, 'held');
  // ...but answered with the earlier call's version: a replay answer.
  assert.equal(judgeB({ key: 'K2', t0: TV(4), b: C({ id: null, version: 4, text: 'Updated.' }), t1: TV(5), earlier: { id: null, version: 4, applied: true } }, U()).verdict, 'violated');
  // A create of a name the caller chose that exists, answered with the existing object (B-6).
  assert.equal(judgeB({ key: 'K2', t0: T(1), b: C({ id: 'mwsc-p1', text: 'Project mwsc-p1.' }), t1: T(1), earlier: { id: 'mwsc-p1', version: 1, applied: true } }, D({ caller_named: true })).verdict, 'not tested');
  assert.equal(B({ b: C({ id: 'T7' }), t1: T(1) }).verdict, 'not tested', 'a success with no new object and another id');
  assert.equal(B({ earlier: { id: 'T1', version: 1, applied: false } }).verdict, 'not tested', 'no earlier write');
  assert.equal(B({ b: C({ indeterminate: true, ok: false }) }).verdict, 'not tested');
});

const Cc = (o: Partial<Parameters<typeof judgeC>[0]>) => judgeC({ key: 'K', vary: { arg: 'title', from: 'mwsc-a', to: 'mwsc-a-changed' }, t0: T(1), c: ERR('This idempotency_key was already used with different arguments; nothing was written.'), t1: T(1), earlier_applied: true, ...o }, D());

test('step (c): a refusal in any form with the object unchanged is held; a success or an application is violated', () => {
  assert.equal(Cc({}).verdict, 'held');
  assert.equal(Cc({ c: C({ ok: false, isError: false, rpc_error: { code: -32602, message: 'key reused with a different payload' }, text: null, data: null }) }).verdict, 'held', 'a JSON-RPC error is accepted');
  assert.equal(Cc({ c: C({ replay_marked: true }) }).verdict, 'violated', 'answered with the earlier result');
  assert.equal(Cc({ c: C({ id: 'T2' }), t1: T(2) }).verdict, 'violated', 'applied');
  assert.equal(Cc({ c: ERR('Failed.'), t1: T(2) }).verdict, 'violated', 'applied and answered with an error');
  assert.equal(Cc({ c: ERR('Service unavailable, try again later.') }).verdict, 'not tested');
  assert.equal(Cc({ vary: null }).verdict, 'not tested');
  assert.equal(Cc({ earlier_applied: false }).verdict, 'not tested');
  assert.equal(Cc({ c: C({ ok: false, indeterminate: true }) }).verdict, 'not tested');
});

test('steps (a) to (c) share one record: violated if any, held only if all three held, else not tested naming the steps', () => {
  const h = { verdict: 'held' as const, reason: 'step (a): ok', notes: [], steps: [] };
  const n = { verdict: 'not tested' as const, reason: 'step (b): undecided', notes: [], steps: [] };
  const v = { verdict: 'violated' as const, reason: 'step (c): applied', notes: [], steps: ['s'] };
  assert.equal(combineABC(h, h, h).verdict, 'held');
  const nt = combineABC(h, n, h);
  assert.equal(nt.verdict, 'not tested');
  assert.match(nt.reason, /step \(b\) undecided/);
  assert.equal(combineABC(h, n, v).verdict, 'violated');
  assert.equal(combineABC(h, n, v).notes.filter((x) => /^Step \([abc]\)/.test(x)).length, 3, 'the record states what each step showed');
});

const P = (o: Partial<PairObs> = {}): PairObs => ({ key: 'Kp', t0: T(0), x: C({ t_start_ms: 0, t_end_ms: 10 }), y: C({ t_start_ms: 1, t_end_ms: 11, replay_marked: true }), t1: T(1), ...o });

test('step (d): a pair applied twice is a loss; neither applied is not counted; a pair that did not overlap is judged as step (a)', () => {
  assert.equal(judgePair(P(), D()).outcome, 'counted');
  assert.equal(judgePair(P({ t1: T(2) }), D()).outcome, 'loss');
  assert.equal(judgePair(P({ t1: T(0) }), D()).outcome, 'excluded');
  const apart = (y: Partial<CallObs>) => judgePair(P({ y: C({ t_start_ms: 20, t_end_ms: 30, ...y }) }), D());
  assert.equal(apart({}).outcome, 'excluded', 'not overlapped and the outcome given: adds nothing');
  assert.equal(withP({ outcome_unknown: 'not known whether' }, () => apart({ ok: false, isError: true, text: 'It is not known whether the write was applied.', id: null, data: null })).outcome, 'violated', 'not overlapped: step (a) rules');
  // An answer that says the first is still in progress is correct for an overlapped pair.
  assert.equal(judgePair(P({ y: ERR('A request with this key is still in progress.', { t_start_ms: 1, t_end_ms: 5 }) }), D()).outcome, 'counted');
});

test('step (d): violated with the rule-9 wording; not observed only with 30 overlapped pairs, with the bound and the words; else not tested', () => {
  const many = (n: number, loss = -1) => Array.from({ length: n }, (_, i) => P({ t1: T(i === loss ? 2 : 1) }));
  const v = judgeD({ pairs: many(5, 2), limit: 40, stop: 'limit' }, D());
  assert.equal(v.verdict, 'violated');
  assert.ok(v.notes.some((n) => /deliberately made simultaneous/.test(n)));
  const no = judgeD({ pairs: many(30), limit: 40, stop: 'overlapped' }, D());
  assert.equal(no.verdict, 'not observed');
  assert.match(no.reason, /does not show that the server is safe under concurrency/);
  assert.match(no.reason, /3\/30/);
  assert.equal(no.numbers['pairs_overlapped'], 30);
  const few = judgeD({ pairs: many(10), limit: 10, stop: 'limit' }, D());
  assert.equal(few.verdict, 'not tested');
  assert.match(few.reason, /too few overlapped pairs/);
  assert.ok(!['held'].includes(judgeD({ pairs: many(40), limit: 40, stop: 'overlapped' }, D()).verdict), 'never held');
});

const PX = (o: Partial<ProxyObs> = {}): ProxyObs => ({ routing: 'loopback gate', learned: { method: 'POST', path: '/tickets', nth: 1 }, key: 'K', t0: T(0), a1: ERR('The backend could not be reached. It is not known whether the change was applied.', { written: 'unknown' } as never), hit: true, t1: T(1), a2: C({ replay_marked: true }), t2: T(1), undo: [], ...o });

test('proxy-assisted step: the repeat that gives the outcome is held without the note; one that applies nothing is held with the note, or violated where the backend offers a key', () => {
  const ok = judgeProxy(PX(), D());
  assert.equal(ok.verdict, 'held');
  assert.ok(!ok.reason.includes(NOTE_OUTCOME));
  const unk = ERR('It is not known whether the earlier call with this key was applied; nothing was written.');
  const silent = judgeProxy(PX({ a2: unk }), D());
  assert.equal(silent.verdict, 'held');
  assert.ok(silent.reason.includes(`"${NOTE_OUTCOME}"`), 'a held with the note is never quoted without it');
  assert.match(silent.reason, /declaration is silent/);
  assert.equal(judgeProxy(PX({ a2: unk }), D({ backend_key: false })).verdict, 'held');
  assert.equal(judgeProxy(PX({ a2: unk }), D({ backend_key: true })).verdict, 'not tested', 'rule 11: whether the error gives the outcome is not read without a declared pattern');
  assert.equal(withP({ ...APPLIED, outcome_unknown: 'not known whether' }, () => judgeProxy(PX({ a2: unk }), D({ backend_key: true }))).verdict, 'violated', 'a positive match: it says the outcome is not known');
  assert.equal(withP(APPLIED, () => judgeProxy(PX({ a2: unk }), D({ backend_key: true }))).verdict, 'not tested', 'declared-carryover: no declared pattern that means a violation matches');
  assert.equal(judgeProxy(PX({ a2: ERR('Refused.') }), D()).verdict, 'held', 'applies nothing and says nothing: held with the note');
  assert.equal(judgeProxy(PX({ a2: C({ id: 'T9' }) }), D({ backend_key: true })).verdict, 'violated', 'a success for an object it did not make');
  assert.equal(judgeProxy(PX({ a2: C({ id: null, text: 'Done.', data: null }) }), D({ backend_key: true })).verdict, 'not tested', 'a success without an id cannot be compared');
});

test('proxy-assisted step: counted twice is violated (the server\'s own retry included); not forced is not tested', () => {
  assert.equal(judgeProxy(PX({ a1: C({ id: 'T2' }), t1: T(2), t2: T(2) }), D()).verdict, 'violated', 'the server re-sent the create without the key');
  assert.equal(judgeProxy(PX({ t2: T(2) }), D()).verdict, 'violated');
  assert.equal(judgeProxy(PX({ hit: false }), D()).verdict, 'not tested');
  assert.equal(judgeProxy(PX({ t1: T(0), t2: T(0) }), D()).verdict, 'not tested', 'trace 0 after the commit');
  assert.equal(judgeProxy(PX({ a2: C({ indeterminate: true, ok: false }) }), D()).verdict, 'not tested', 'the repeat timed out');
  assert.equal(judgeProxy(PX({ a1: C({ ok: false, indeterminate: true, timed_out: true } as never), a2: C() }), D()).verdict, 'held', 'a timeout of the first call is the condition forced, not excluded');
  assert.equal(judgeProxy(PX({ undo: [{ method: 'DELETE', path: '/tickets/T1' }], t2: T(1) }), D()).verdict, 'not tested', 'the server undid the write');
  assert.equal(judgeProxy(PX({ undo: [{ method: 'DELETE', path: '/tickets/T1' }], t2: T(2) }), D()).verdict, 'violated', 'undone, yet two in effect');
  assert.equal(judgeProxy(PX({ skipped: 'no backend.gate' }), D()).verdict, 'not tested');
  // A first answer that gave the outcome: judged as step (a).
  assert.equal(withP({ outcome_unknown: 'not known whether' }, () => judgeProxy(PX({ a1: C(), a2: ERR('It is not known whether it was applied.') }), D())).verdict, 'violated');
  assert.equal(judgeProxy(PX({ a2: ERR('Rate limited; try again later.') }), D({ backend_key: true })).verdict, 'not tested', 'unavailable never gives a false violated');
  assert.ok(judgeProxy(PX(), D()).notes.some((n) => /^Routing: /.test(n)), 'spec 7.3 rule 7: the routing and the schedule');
});

const R = (o: Partial<RestartObs> = {}): RestartObs => ({ key: 'K', t0: T(0), a1: C(), t1: T(1), restart: { stop_requested: 'graceful', stop_used: 'graceful', ended_by: 'SIGTERM', t_stop_ms: 100, t_stopped_ms: 200, t_ready_ms: 600, started: true, reason: null }, tr: T(1), a2: C({ replay_marked: true }), t2: T(1), t3: null, gap_ms: 700, settle_ms: 0, ...o });
const honest = ERR('The result of the earlier call with this idempotency_key was not kept (the server restarted); nothing was written. List your tickets to find it.');

test('step (e): checked in order: stated lifetime, lost state, counted twice, then the repeat', () => {
  assert.equal(judgeRestart(R(), D()).verdict, 'held');
  const life = judgeRestart(R({ t2: T(2) }), D({ key_lifetime: { ms: 500, quote: 'keys are kept for half a second' } }));
  assert.equal(life.verdict, 'not tested', 'a stated lifetime shorter than the gap comes first');
  assert.match(life.reason, /half a second/);
  assert.equal(judgeRestart(R({ tr: T(0), t2: T(1) }), D()).verdict, 'not tested', 'the backend lost state in the restart');
  assert.equal(judgeRestart(R({ t2: T(0) }), D()).verdict, 'not tested', 'lost after the repeat');
  assert.equal(judgeRestart(R({ t2: T(2) }), D()).verdict, 'violated', 'the write applied again after the restart');
  assert.equal(judgeRestart(R({ t2: T(2), a2: C({ ok: false, indeterminate: true }) }), D()).verdict, 'violated', 'before rule 5: holds even where the repeat timed out');
  assert.equal(judgeRestart(R({ a1: ERR('Not known whether applied.'), t2: T(1) }), D()).verdict, 'not tested', 'A1 applied without an outcome');
  assert.equal(judgeRestart(R({ t1: T(0), tr: T(0), t2: T(0) }), D()).verdict, 'not tested', 'A1 did not apply');
  assert.equal(judgeRestart(R({ restart: null, skipped: 'the declaration gives no server.restart' }), D()).verdict, 'not tested');
});

test('step (e): a repeat that applies nothing is held with "key record not kept", or violated where the declaration says the record survives or the backend offers a key', () => {
  const h = judgeRestart(R({ a2: honest }), D());
  assert.equal(h.verdict, 'held');
  assert.ok(h.reason.includes(`"${NOTE_KEY_RECORD}"`), 'never quoted without the note');
  assert.match(h.reason, /declaration is silent on whether the tool's key record survives a restart after a graceful stop/);
  assert.equal(withP({ not_applied: 'nothing was written' }, () => judgeRestart(R({ a2: honest }), D({ key_record_survives: { graceful: true, kill: null } }))).verdict, 'violated');
  assert.equal(judgeRestart(R({ a2: honest }), D({ key_record_survives: { graceful: null, kill: true } })).verdict, 'held', 'the declaration is about the other kind of stop');
  const killed = R({ a2: honest, restart: { stop_requested: 'graceful', stop_used: 'kill', ended_by: 'SIGKILL', t_stop_ms: 0, t_stopped_ms: 5000, t_ready_ms: 5400, started: true, reason: null } });
  assert.equal(withP({ not_applied: 'nothing was written' }, () => judgeRestart(killed, D({ key_record_survives: { graceful: null, kill: true } }))).verdict, 'violated', 'a graceful stop that ended in a kill counts as a kill');
  assert.ok(judgeRestart(killed, D()).notes.some((n) => /counts as a kill/.test(n)));
  assert.equal(withP({ not_applied: 'nothing was written' }, () => judgeRestart(R({ a2: honest }), D({ backend_key: true }))).verdict, 'violated');
  assert.equal(judgeRestart(R({ a2: ERR('Service unavailable; try again later.') }), D({ backend_key: true })).verdict, 'not tested');
  assert.ok(judgeRestart(R(), D()).notes.some((n) => /Time between the first answer and the repeat: 700 ms/.test(n)), 'the record states the gap');
});

const X = (o: Partial<CrashObs> = {}): CrashObs => ({ ...R({ a1: C({ ok: false, indeterminate: true, transport_error: 'the server exited' } as never), t1: null }), routing: 'loopback gate', learned: { method: 'POST', path: '/tickets', nth: 1 }, hit: true, answered_before_stop: false, ...o });

test('crash form: judged as the proxy-assisted step with its note; unavailable is not tested; the key-record declaration does not change it', () => {
  assert.equal(judgeCrash(X(), D()).verdict, 'held');
  const n = withP({ not_applied: 'nothing was written' }, () => judgeCrash(X({ a2: honest }), D({ key_record_survives: { graceful: true, kill: true } })));
  assert.equal(n.verdict, 'held');
  assert.ok(n.reason.includes(`"${NOTE_OUTCOME}"`));
  assert.equal(withP({ ...APPLIED, not_applied: 'nothing was written' }, () => judgeCrash(X({ a2: honest }), D({ backend_key: true }))).verdict, 'violated');
  assert.equal(withP(APPLIED, () => judgeCrash(X({ a2: honest }), D({ backend_key: true }))).verdict, 'not tested', 'declared-carryover: no positive match');
  // Note 19, R4: a bare refusal in the crash form is not tested without a declared patterns.unavailable.
  assert.equal(withNone(() => judgeCrash(X({ a2: ERR('Request refused.') }), D())).verdict, 'not tested');
  assert.equal(judgeCrash(X({ a2: ERR('Too many requests.') }), D()).verdict, 'not tested');
  assert.equal(judgeCrash(X({ t2: T(2) }), D()).verdict, 'violated');
  assert.equal(judgeCrash(X({ answered_before_stop: true }), D()).verdict, 'not tested');
  assert.equal(judgeCrash(X({ hit: false }), D()).verdict, 'not tested');
  assert.equal(judgeCrash(X({ tr: T(0), t2: T(0) }), D()).verdict, 'not tested', 'nothing applied after the commit');
  assert.equal(judgeCrash(X({ tr: T(1), t2: T(0) }), D()).verdict, 'not tested', 'the backend lost state');
  assert.ok(judgeCrash(X(), D()).notes[0]!.startsWith('Method: proxy-assisted (launch)'));
});

test('the MWS-RES-2 cross-record: only an answer that says the earlier call failed, while the write is in effect', () => {
  const lie = ERR('The earlier call with this idempotency_key failed; nothing was written. Retry with a new key.');
  // Rule 11: the declaration's earlier_failed pattern decides (review of note 8, 3).
  usePatterns({ patterns: { ...BASE, ...APPLIED, outcome_unknown: 'not known whether', earlier_failed: 'earlier call with this idempotency_key failed' } } as never);
  const v = res2Cross(R({ a2: lie }), 'restart', D());
  assert.equal(v?.verdict, 'violated');
  assert.match(v!.reason, /step \(e\)/);
  assert.equal(res2Cross(X({ a2: lie }), 'crash', D())?.verdict, 'violated');
  assert.equal(res2Cross(R({ a2: honest }), 'restart', D()), null, 'saying nothing was applied, or the result was not kept, is not such a trial');
  assert.equal(res2Cross(R({ a2: ERR('Unknown idempotency key; nothing was written.') }), 'restart', D()), null);
  assert.equal(res2Cross(R({ a2: lie, t2: T(0) }), 'restart', D()), null, 'the write no longer in effect');
  assert.equal(res2Cross(R({ a2: lie, t1: T(0), tr: T(0), t2: T(0) }), 'restart', D()), null, 'the first call did not apply');
  assert.equal(res2Cross(X({ a2: lie, answered_before_stop: true }), 'crash', D()), null);
  resetP();
});

test('manifest: the idempotency declaration (Annex E) and server.restart', () => {
  const m = parseManifestText(
    `mws: "0.9"
server: { stdio: [node, s.js], restart: { stop: graceful } }
target: { environment: test, confirm: t }
resources:
  - name: ticket
    create: { tool: ticket_create, args: { title: "{{marker}}" }, id: id }
    read: { tool: ticket_get, args: { id: "{{id}}" } }
    list: { tool: ticket_list, args: {}, items: items, name: title }
    cleanup: delete
    delete: { tool: ticket_delete, args: { id: "{{id}}" } }
    idempotency: { key: { arg: k }, kind: update, version_steps: true, vary: title, own_checks: [name, version], backend_key: true, key_record_survives: { kill: false }, key_lifetime: { ms: 60000, quote: "keys are kept for one minute" } }
patterns: { repeat_refused: "dup", unavailable: "busy", earlier_failed: "earlier failed" }
`,
    'm.yaml',
  );
  const i = m.resources[0]!.idempotency!;
  assert.deepEqual([i.kind, i.version_steps, i.vary, i.own_checks, i.backend_key, i.key_record_survives, i.key_lifetime], ['update', true, 'title', ['name', 'version'], true, { graceful: null, kill: false }, { ms: 60000, quote: 'keys are kept for one minute' }]);
  assert.deepEqual(m.server.restart, { stop: 'graceful' });
  assert.equal(m.patterns.earlier_failed, 'earlier failed');
  const def = parseManifestText(`mws: "0.9"\nserver: { stdio: [node, s.js] }\ntarget: { environment: test, confirm: t }\nresources:\n  - name: r\n    create: { tool: c, args: {}, id: id }\n    read: { tool: g, args: {} }\n    idempotency: { key: { arg: k } }\n`, 'm.yaml').resources[0]!.idempotency!;
  assert.deepEqual([def.kind, def.version_steps, def.own_checks, def.backend_key, def.key_record_survives], ['create', false, [], null, null]);
  assert.throws(() => parseManifestText(`mws: "0.9"\nserver: { url: "http://127.0.0.1:1/mcp", restart: { stop: kill } }\ntarget: { environment: test, confirm: t }\nresources:\n  - name: r\n    create: { tool: c, args: {}, id: id }\n    read: { tool: g, args: {} }\n`, 'm.yaml'), /restart/);
  assert.throws(() => parseManifestText(`mws: "0.9"\nserver: { stdio: [node, s.js] }\ntarget: { environment: test, confirm: t }\nresources:\n  - name: r\n    create: { tool: c, args: {}, id: id }\n    read: { tool: g, args: {} }\n    idempotency: { key: { arg: k }, own_checks: [colour] }\n`, 'm.yaml'), /own_checks/);
});

const MAN = (idem: string, server = 'stdio: [node, s.js]') =>
  parseManifestText(
    `mws: "0.9"
server: { ${server} }
target: { environment: test, confirm: t }
resources:
  - name: ticket
    create: { tool: ticket_create, args: { title: "{{marker}}" }, id: id }
    read: { tool: ticket_get, args: { id: "{{id}}" } }
    list: { tool: ticket_list, args: {}, items: items, name: title }
    cleanup: delete
    delete: { tool: ticket_delete, args: { id: "{{id}}" } }
    idempotency: ${idem}
`,
    'm.yaml',
  );

test('the records: one per step group, with distinct scenarios; steps that cannot run say what they need', () => {
  const res = MAN('{ key: { arg: idempotency_key }, replay_marker: replayed }').resources[0]!;
  const a = A({});
  const rs = idempotencyVerdicts({ a, b: { key: 'K2', t0: T(1), b: C({ id: 'T2' }), t1: T(2), earlier: { id: 'T1', version: 1, applied: true } }, c: { key: 'K', vary: { arg: 'title', from: 'x', to: 'x-changed' }, t0: T(2), c: ERR('Key reused with different arguments; nothing was written.'), t1: T(2), earlier_applied: true }, d: { pairs: [P()], limit: 1, stop: 'limit' } }, res);
  assert.deepEqual(rs.map((r) => [r.scenario.id, r.verdict]), [
    ['idempotency-replay', 'held'],
    ['idempotency-replay.concurrent', 'not tested'],
    ['idempotency-replay.proxy', 'not tested'],
    ['idempotency-replay.restart', 'not tested'],
    ['idempotency-replay.restart-crash', 'not tested'],
  ]);
  assert.match(rs[2]!.reason, /backend\.gate/);
  assert.match(rs[3]!.reason, /server\.restart/);
  assert.ok(rs.every((r) => r.requirement === 'MWS-RETRY-2' && r.write_path.tool === 'ticket_create'));
  const v = idempotencyVerdicts({ a: A({ t2: T(2) }) }, res);
  assert.equal(v[0]!.verdict, 'violated', 'one step violated: the shared record is violated');
  const stopped = idempotencyVerdicts({ stopped: 'stopped: rate limited' }, res);
  assert.match(stopped[0]!.reason, /rate limited/);
  // The MWS-RES-2 cross-record is its own record, for the same write path.
  usePatterns({ patterns: { ...BASE, ...APPLIED, outcome_unknown: 'not known whether', earlier_failed: 'earlier call with this key failed' } } as never);
  const x = idempotencyVerdicts({ restart: R({ a2: ERR('The earlier call with this key failed; nothing was written.') }) }, res, { gated: false, restart: { stop: 'graceful' }, launchable: true });
  resetP();
  const r2 = x.find((r) => r.requirement === 'MWS-RES-2')!;
  assert.equal(r2.verdict, 'violated');
  assert.equal(r2.scenario.id, 'idempotency-replay.restart.res2');
  assert.equal(x.find((r) => r.scenario.id === 'idempotency-replay.restart')!.verdict, 'held', 'RETRY-2 itself: the write was applied once and the repeat applied nothing');
  assert.ok(x.find((r) => r.scenario.id === 'idempotency-replay.restart')!.reason.includes(NOTE_KEY_RECORD));
});

test('step (c): the argument changed keeps its type; the declared vary wins over the marker', () => {
  assert.deepEqual(variedArgs({ title: 'mwsc-m1', n: 2 }, { vary: null, marker: 'mwsc-m1', scope: null, prefix: 'mwsc-' })?.args, { title: 'mwsc-m1-changed', n: 2 });
  assert.deepEqual(variedArgs({ key: 'mwsc-m1', name: 'mwsc-m1' }, { vary: 'key', marker: 'mwsc-m1', scope: null, prefix: 'mwsc-' })?.to, 'mwsc-m1-changed');
  assert.deepEqual(variedArgs({ title: 'x', n: 2 }, { vary: 'n', marker: 'm', scope: null, prefix: 'p' })?.to, 3);
  assert.equal(variedArgs({ project: 'mwsc-s' }, { vary: null, marker: 'mwsc-m', scope: 'mwsc-s', prefix: 'mwsc-' }), null, 'never the scope');
});

// ---------------------------------------------------------------- review of note 8 (spec 098621b; rule 11: a default pattern alone never decides `violated`)

/** Run with the declaration's patterns set, then back to the defaults. */
function withPatterns<R>(p: Record<string, string>, fn: () => R): R {
  usePatterns({ patterns: { ...BASE, ...p } } as never);
  try {
    return fn();
  } finally {
    resetP();
  }
}

test('review 1: step (b), a refusal by a declared own check is on its own merits whatever its wording, before any pattern', () => {
  const named = (text: string) => judgeB({ key: 'K2', t0: T(1), b: ERR(text), t1: T(1), earlier: { id: 'P1', version: 1, applied: true } }, D({ caller_named: true, own_checks: ['name'] }));
  for (const text of ['Project key P1 has already been used; nothing was changed.', 'A project with this name was already submitted.', 'Duplicate request: project MW-1 exists.']) assert.equal(named(text).verdict, 'held', text);
  const content = judgeB({ key: 'K2', t0: T(1), b: ERR('Duplicate submission: an item with this content exists.'), t1: T(1), earlier: { id: 'T1', version: 1, applied: true } }, D({ own_checks: ['content'] }));
  assert.equal(content.verdict, 'held', content.reason);
  // A refusal that says nothing about the write is still not tested under an own check.
  assert.equal(named('Too many requests; try again later.').verdict, 'not tested');
  // Without the declaration the wording is read: a default pattern alone gives not tested (review 9), a declared one violated.
  assert.equal(judgeB({ key: 'K2', t0: T(1), b: ERR('Duplicate request: this key was already used.'), t1: T(1), earlier: { id: 'T1', version: 1, applied: true } }, D()).verdict, 'not tested');
});

test('review 2: step (b), a success with the earlier id for a create a declared content check finds a duplicate is not tested (NF-5, NF-24)', () => {
  const d = D({ own_checks: ['content'] });
  const same = judgeB({ key: 'K2', t0: T(1), b: C({ id: 'T1', text: 'Item T1' }), t1: T(1), earlier: { id: 'T1', version: 1, applied: true } }, d);
  assert.equal(same.verdict, 'not tested', same.reason);
  assert.match(same.reason, /NF-5, NF-24/);
  // A new object made, yet answered with the earlier id: the check did not find a duplicate, so the answer is a replay's.
  assert.equal(judgeB({ key: 'K2', t0: T(1), b: C({ id: 'T1', text: 'Item T1' }), t1: T(2), earlier: { id: 'T1', version: 1, applied: true } }, d).verdict, 'violated');
});

test('review 9: step (b), the default replay pattern alone gives not tested quoting the text; a declared pattern or the structure decides violated; negations do not match', () => {
  // No id, no new object, a replay sentence only the default pattern recognizes.
  const b = C({ id: null, data: null, text: 'Already processed (replayed).' });
  const nt = B({ b, t1: T(1) });
  assert.equal(nt.verdict, 'not tested', nt.reason);
  assert.match(nt.reason, /patterns\.replay/);
  assert.match(nt.reason, /Already processed/);
  assert.ok(nt.notes.some((n) => /default pattern for replay/.test(n)));
  assert.equal(withPatterns({ replay: 'replayed' }, () => B({ b, t1: T(1) }).verdict), 'violated', 'a declared pattern decides');
  // Applied as a new write, but the default pattern reads "replayed": not tested, never violated.
  assert.equal(B({ b: C({ id: 'T2', text: 'Created T2 (replayed from cache).' }) }).verdict, 'not tested');
  // Negated forms are not a replay.
  assert.equal(B({ b: C({ id: 'T2', text: 'Created T2. This was not a replay.' }) }).verdict, 'held');
  assert.equal(B({ b: C({ id: 'T2', text: 'Created T2; replayed: false' }) }).verdict, 'held');
  // NF-24: an update that sets the values already set, said "already applied", is not tested, never violated.
  const nf24 = judgeB({ key: 'K2', t0: TV(4), b: C({ id: null, version: 4, text: 'Already applied: the ticket had these values.' }), t1: TV(4), earlier: { id: null, version: 4, applied: true } }, U());
  assert.equal(nf24.verdict, 'not tested', nf24.reason);
  // The structure still decides: the first call's id where a new object could have been made.
  assert.equal(B({ b: C({ id: 'T1', text: 'Created ticket T1.' }), t1: T(1) }).verdict, 'violated');
});

test('review 10: the default outcome_unknown pattern is about whether the write was applied, not any check that could not be made', () => {
  const unk = (text: string) => saysUnknown({ text, data: null });
  assert.equal(unk('Refused: could not verify the webhook URL.'), false);
  assert.equal(unk('Backend unavailable: could not verify the request signature.'), false);
  assert.equal(unk('Unable to verify the caller.'), false);
  assert.equal(unk('We could not determine whether the change was applied.'), true);
  assert.equal(unk('Cannot tell if the update went through.'), true);
  assert.equal(unk('We could not confirm the update was saved.'), true);
  // A refusal that says nothing about the write: not tested, never violated after an outcome.
  assert.equal(judgeA(A({ a2: ERR('Backend unavailable: could not verify the request signature.') }), D()).verdict, 'not tested');
});

test('review 5: identifiesChange reads a negated verb as no change, and a change named in another clause still identifies it', () => {
  const id = (text: string, path: string, value?: unknown) => identifiesChange({ text, data: null }, path, value);
  for (const text of ['Error: title was not updated (backend timeout).', 'The title was not set.', 'title wasn\'t stored', 'title was not deleted', 'No change was made to the title.', 'title: no change', 'Nothing was committed for title.', 'Nothing was stored; the title remains unchanged.', 'title has not been saved yet']) assert.equal(id(text, 'title', 'mwsc-x'), false, text);
  assert.equal(id('Ticket T1 was not created.', 'T1', 'T1'), false);
  for (const text of ['The title could not be saved right now.', 'The title cannot be updated.', 'title can\'t be stored', 'title would not have been saved']) assert.equal(id(text, 'title'), false, text);
  assert.equal(id('Ticket T1 was not made, nothing was written.', 'T1', 'T1'), false);
  // A partial message: the change that stayed applied is identified even though another part was not applied.
  assert.equal(id('The title was updated; the labels were not updated.', 'title'), true);
  assert.equal(id('The title was updated, nothing else changed.', 'title'), true);
  assert.equal(id('Ticket T1 was created, but adding its labels failed.', 'T1', 'T1'), true);
  // Callers: step (a) does not take "title was not updated" as the outcome of an update that applied (not tested, not violated).
  const du = U();
  const a = { key: 'K', t0: TV(3), a1: ERR('Error: title was not updated (backend timeout).'), t1: TV(4), a2: ERR('It is not known whether the earlier call was applied.'), t2: TV(4) };
  assert.equal(judgeA(a, du).verdict, 'not tested');
  // ...and a repeat that says so after a success does not give the outcome (violated), while one that names the applied change does (held).
  assert.equal(withP({ not_applied: 'was not updated' }, () => judgeA({ ...a, a1: C({ id: null, version: 4, text: 'Updated, version 4.' }), a2: ERR('Error: title mwsc-x was not updated.') }, du)).verdict, 'violated');
  // Note 19, R2: after a first success the repeat must be a success too; an error, however it reads, is not.
  assert.equal(withP(APPLIED, () => judgeA({ ...a, a1: C({ id: null, version: 4, text: 'Updated, version 4.' }), a2: ERR('Error: the title was already set to mwsc-x (version 4); labels were not updated.') }, du)).verdict, 'violated');
  // MWS-RES-2: an error that says the change that stayed was not made does not identify it.
  // (B) and re-review 6: the field's name alone is not a value it names, so the error says nothing of the change: violated.
  assert.equal(withP({ ...APPLIED, outcome_unknown: 'not known whether', not_applied: 'was not updated' }, () => res2Judge(C({ ok: false, isError: true, text: 'Error: title was not updated.', data: null }), ['title'], 'backend', 'w')).verdict, 'violated');
  assert.equal(withP({ ...APPLIED, outcome_unknown: 'not known whether' }, () => res2Judge(C({ ok: false, isError: true, text: 'Error: title was not updated.', data: null }), ['title'], 'backend', 'w')).verdict, 'not tested', 'declared-carryover: needs reading');
  // With the new value named and no declared pattern, it cannot be read: not tested.
  assert.equal(res2Judge(C({ ok: false, isError: true, text: 'Error: title mwsc-x was not updated.', data: null }), ['title'], 'backend', 'w', { title: 'mwsc-x' }).verdict, 'not tested');
  assert.equal(withP({ ...APPLIED, outcome_unknown: 'not known whether' }, () => res2Judge(C({ ok: false, isError: true, text: 'The title was updated; the labels were not updated.', data: null }), ['title'], 'backend', 'w')).verdict, 'held');
});

test('review 3: the MWS-RES-2 cross-record is never violated for an answer that identifies the applied write or says its outcome is unknown, nor on a default pattern alone', () => {
  const ef = { ...APPLIED, outcome_unknown: 'not known whether', earlier_failed: '\\b(previous|earlier) (request|call|attempt)\\b.*\\bfail' };
  const unknown = ERR('The previous request with this key failed before completing; it is not known whether it was applied. Nothing was written now.');
  const ident = ERR('The previous attempt failed to return an answer, but ticket T1 was created and remains applied.');
  const lie = ERR('The earlier call with this idempotency_key failed; nothing was written. Retry with a new key.');
  withPatterns(ef, () => {
    assert.equal(res2Cross(R({ a2: unknown }), 'restart', D()), null, 'says the outcome is unknown');
    assert.equal(res2Cross(R({ a2: ident }), 'restart', D()), null, 'identifies the applied write');
    assert.equal(res2Cross(R({ a2: lie }), 'restart', D())?.verdict, 'violated', 'a declared pattern decides');
  });
  // The default earlier_failed pattern alone: no cross-record, and a note on the restart record quoting the text.
  assert.equal(res2Cross(R({ a2: lie }), 'restart', D()), null);
  const note = res2CrossNote(R({ a2: lie }), 'restart', D());
  assert.ok(note && /patterns\.earlier_failed/.test(note) && /earlier call with this idempotency_key failed/.test(note), String(note));
  assert.equal(res2Cross(R({ a2: unknown }), 'restart', D()), null, 'no record on default patterns');
  const res = MAN('{ key: { arg: idempotency_key } }').resources[0]!;
  const x = idempotencyVerdicts({ restart: R({ a2: lie }) }, res, { gated: false, restart: { stop: 'graceful' }, launchable: true });
  assert.ok(!x.some((r) => r.requirement === 'MWS-RES-2'), 'no MWS-RES-2 record on the default pattern');
  assert.ok(x.find((r) => r.scenario.id === 'idempotency-replay.restart')!.notes.some((n) => /patterns\.earlier_failed/.test(n)));
});

test('review 4: a success whose data or wording only the default not_applied pattern reads as a failure is not a third-clause violation', () => {
  // NF-19: an accepted operation whose data holds "fails" is still not tested.
  const acc = res2Judge(C({ text: 'Accepted; the change is queued.', data: { id: 'T-1', description: 'login fails on Safari' } }), [], 'backend', 'w', {}, { async: true });
  assert.equal(acc.verdict, 'not tested', acc.reason);
  // Prose that only the default pattern reads as a failure blocks NF-19 only as not tested, quoting it.
  const acc2 = res2Judge(C({ text: 'Accepted; the change is queued. It cannot be undone.', data: null }), [], 'backend', 'w', {}, { async: true });
  assert.equal(acc2.verdict, 'not tested', acc2.reason);
  assert.match(acc2.reason, /patterns\.not_applied/);
  assert.equal(withPatterns({ not_applied: 'update failed' }, () => res2Judge(C({ text: 'Accepted; the update failed.', data: null }), [], 'backend', 'w', {}, { async: true }).verdict), 'violated');
});

test('review 7: the crash form applies the undo scan; the scan matches the deleted path\'s last segment exactly', () => {
  // The restarted server deleted the committed T1 and the repeat created T2: one application in effect, undone first.
  const obj = (id: string): TraceRead => T(1, { ids: [id] });
  const crash = X({ tr: obj('T1'), a2: C({ id: 'T2', text: 'Created ticket T2' }), t2: obj('T2'), undo: [{ method: 'DELETE', path: '/tickets/T1' }] });
  const nt = judgeCrash(crash, D({ backend_key: true }));
  assert.equal(nt.verdict, 'not tested', nt.reason);
  assert.match(nt.reason, /undid/);
  assert.equal(judgeCrash({ ...crash, t2: T(2, { ids: ['T2', 'T3'] }) }, D()).verdict, 'violated', 'undone, yet two in effect');
  // Exact: T-1 is not the last segment of /tickets/T-12.
  assert.deepEqual(undoneBy([{ method: 'DELETE', path: '/tickets/T-12' }, { method: 'DELETE', path: '/tickets/T-1?force=true' }, { method: 'DELETE', path: '/tickets/T-1/' }, { method: 'GET', path: '/tickets/T-1' }, { method: 'DELETE', path: '/projects/p%2FT-1' }], ['T-1']), [{ method: 'DELETE', path: '/tickets/T-1?force=true' }, { method: 'DELETE', path: '/tickets/T-1/' }]);
  assert.deepEqual(undoneBy([{ method: 'DELETE', path: '/tickets/T-12' }], ['T-1']), []);
});

test('review 11: counted more than once is violated before a failed restart, an error or a missing read gives not tested', () => {
  const failed = { stop_requested: 'graceful' as const, stop_used: 'graceful' as const, ended_by: 'SIGTERM', t_stop_ms: 0, t_stopped_ms: 1, t_ready_ms: null, started: false, reason: 'did not start again' };
  assert.equal(judgeRestart(R({ t1: T(2), restart: failed, tr: T(2), a2: null, t2: null }), D()).verdict, 'violated', 'the restart failed');
  assert.equal(judgeRestart(R({ t1: T(1), restart: failed, tr: T(1), a2: null, t2: null }), D()).verdict, 'not tested');
  assert.equal(judgeRestart(R({ t1: T(2), tr: T(2), error: 'the repeat could not be sent', a2: null, t2: null }), D()).verdict, 'violated', 'an error');
  assert.equal(judgeRestart(R({ t1: T(2), tr: T(2), t2: { ...T(2), ok: false, reason: 'list failed' } }), D()).verdict, 'violated', 'a read that failed');
  assert.equal(judgeProxy(PX({ t1: T(2), error: 'the repeat could not be sent', a2: null, t2: null }), D()).verdict, 'violated', 'proxy: an error');
  assert.equal(judgeProxy(PX({ t1: T(2), hit: false }), D()).verdict, 'violated', 'proxy: the fault missed, yet the key applied twice');
  assert.equal(judgeProxy(PX({ t1: T(1), error: 'the repeat could not be sent', a2: null, t2: null }), D()).verdict, 'not tested');
  assert.equal(judgeCrash(X({ restart: failed, tr: T(2), a2: null, t2: null }), D()).verdict, 'violated', 'crash: the restart failed');
  assert.equal(judgeA(A({ t1: T(2), t2: { ...T(2), ok: false, reason: 'list failed' } }), D()).verdict, 'violated', 'step (a): a read that failed');
});

const UPD = parseManifestText(
  `mws: "0.9"
server: { stdio: [node, s.js] }
target: { environment: test, confirm: t }
resources:
  - name: ticket
    create: { tool: ticket_create, args: { title: "{{marker}}" }, id: id }
    read: { tool: ticket_get, args: { id: "{{id}}" } }
    version: { read: version, arg: expected_version }
    cleanup: delete
    delete: { tool: ticket_delete, args: { id: "{{id}}" } }
    idempotency: { tool: ticket_update, args: { id: "{{id}}", title: "{{marker}}", expected_version: "{{version}}" }, key: { arg: idempotency_key }, kind: update, version_steps: true, own_checks: [version] }
`,
  'm.yaml',
).resources[0]!;

test('review 6: the keyed update is rendered with the object\'s version, and own_checks: [version] is credited only where a version was sent', () => {
  const drv = new Driver(null as never, null as never, UPD, 'mwsc-x-', {});
  drv.id = 'T1';
  const sent = keyedUpdateArgs(UPD, drv, 'mwsc-x-m1', 4) as Record<string, unknown>;
  assert.deepEqual(sent, { id: 'T1', title: 'mwsc-x-m1', expected_version: 4 });
  assert.equal(versionSent(UPD, sent), true);
  assert.equal(versionSent(UPD, keyedUpdateArgs(UPD, drv, 'mwsc-x-m1', null)), false, 'the version could not be read: none sent');
  assert.equal(declOf(UPD, {}, false).carries_version, false);
  assert.equal(declOf(UPD, {}, true).carries_version, true);
  const b = { key: 'K2', t0: TV(4), b: ERR('Conflict: the ticket changed since version 3. Nothing was written.'), t1: TV(4), earlier: { id: null, version: 4, applied: true } };
  const stepB = (version_sent: boolean | undefined) => idempotencyVerdicts({ b: { ...b, ...(version_sent === undefined ? {} : { version_sent }) } }, UPD)[0]!.notes.find((n) => n.startsWith('Step (b):'))!;
  assert.match(stepB(true), /^Step \(b\): held\..*version check/);
  assert.match(stepB(false), /^Step \(b\): not tested\./, 'no version was sent: the version check never ran, so it is not credited');
  assert.match(stepB(undefined), /^Step \(b\): not tested\./, 'older evidence without the fact: not credited');
});

test('review 8: step (c) needs changed arguments the tool would apply under a fresh key; otherwise not tested, never held', () => {
  const invalid = Cc({ vary: { arg: 'title', from: 'mwsc-a', to: 'mwsc-a-changed', valid: false } });
  assert.equal(invalid.verdict, 'not tested', invalid.reason);
  assert.match(invalid.reason, /input schema/);
  const v = { arg: 'title', from: 'mwsc-a', to: 'mwsc-a-changed', valid: true as const };
  assert.equal(Cc({ vary: v, c: ERR('Invalid arguments: title must be at most 10 characters.') }).verdict, 'not tested', 'a validation refusal');
  assert.equal(Cc({ vary: v, c: C({ ok: false, isError: false, rpc_error: { code: -32602, message: 'Invalid params' }, text: null, data: null }) }).verdict, 'not tested', 'a JSON-RPC invalid-params error that does not speak of the key');
  assert.equal(Cc({ vary: v }).verdict, 'held', 'a refusal of the key reused with other arguments');
  assert.equal(Cc({ vary: v, c: C({ ok: false, isError: false, rpc_error: { code: -32602, message: 'key reused with a different payload' }, text: null, data: null }) }).verdict, 'held');
  assert.equal(Cc({ vary: v, c: C({ id: 'T2' }), t1: T(2) }).verdict, 'violated', 'applied: violated whatever the schema says');
});

// ---------------------------------------------------------------- review of note 8: (A) and (B)

test('(A) after an outcome, a refusal that gives no outcome, says nothing of unknown and names neither the key, the object nor an argument is not tested unless patterns.unavailable is declared', () => {
  const vague = ERR('Something went wrong.');
  const a = withNone(() => judgeA(A({ a2: vague }), D()));
  assert.equal(a.verdict, 'not tested', a.reason);
  assert.match(a.reason, /patterns\.unavailable/);
  assert.match(a.reason, /Something went wrong/);
  assert.equal(withPatterns({ unavailable: 'busy' }, () => judgeA(A({ a2: vague }), D()).verdict), 'not tested', 'F4 / S1: a declared unavailable pattern that does not match decides nothing');
  assert.equal(withPatterns({ unavailable: 'went wrong' }, () => judgeA(A({ a2: vague }), D()).verdict), 'not tested', 'a declared unavailable pattern that matches');
  // Naming the key, the object or an argument it was sent, or saying unknown: the spec's verdict.
  assert.equal(withPatterns({ repeat_refused: 'idempotency key is locked' }, () => judgeA(A({ a2: ERR('Refused: this idempotency key is locked.') }), D())).verdict, 'violated');
  assert.equal(judgeA(A({ a2: ERR('Ticket T1 is locked.') }), D()).verdict, 'not tested', 'F4 / S1: naming the object is no reading');
  assert.equal(judgeA(A({ a2: ERR('The title mwsc-x was refused.', { args: { title: 'mwsc-x', idempotency_key: 'K' } }) }), D()).verdict, 'not tested', 'F4 / S1: naming an argument it was sent is no reading');
  assert.equal(withPatterns({ not_applied: 'was refused' }, () => judgeA(A({ a2: ERR('The title mwsc-x was refused.', { args: { title: 'mwsc-x', idempotency_key: 'K' } }) }), D())).verdict, 'violated', 'a declared pattern reads it');
  assert.equal(withPatterns({ outcome_unknown: 'not known whether' }, () => judgeA(A({ a2: ERR('It is not known whether the change was applied.') }), D())).verdict, 'violated');
  assert.equal(withNone(() => judgeA(A({ a2: C({ ok: false, isError: false, rpc_error: { code: -32603, message: 'Internal error' }, text: null, data: null, id: null }) }), D())).verdict, 'not tested', 'a JSON-RPC error too');
  // The proxy-assisted step and the crash form with backend_key, step (e) with a surviving key record or backend_key.
  assert.equal(withNone(() => judgeProxy(PX({ a2: vague }), D({ backend_key: true }))).verdict, 'not tested');
  assert.equal(withP({ ...APPLIED, not_applied: 'refused' }, () => judgeProxy(PX({ a2: ERR('Ticket T1: refused.') }), D({ backend_key: true }))).verdict, 'violated');
  assert.equal(withP(APPLIED, () => judgeProxy(PX({ a2: ERR('Ticket T1: refused.') }), D({ backend_key: true }))).verdict, 'not tested', 'declared-carryover: no positive match');
  assert.equal(withNone(() => judgeCrash(X({ a2: vague }), D({ backend_key: true }))).verdict, 'not tested');
  assert.equal(withNone(() => judgeRestart(R({ a2: vague }), D({ key_record_survives: { graceful: true, kill: null } }))).verdict, 'not tested');
  assert.equal(withNone(() => judgeRestart(R({ a2: vague }), D({ backend_key: true }))).verdict, 'not tested');
  assert.equal(judgeRestart(R({ a2: honest }), D({ backend_key: true })).verdict, 'not tested', 'F4 / S1: naming the key is no reading');
});

test('(B) MWS-RES-2 second clause: an error that names a changed field or the object but cannot be read is not tested unless outcome_unknown is declared; a bare error is violated', () => {
  const e = (text: string) => C({ ok: false, isError: true, text, data: null, id: null });
  const named = res2Judge(e('Could not save the title mwsc-new right now.'), ['title'], 'backend', 'w', { title: 'mwsc-new' });
  assert.equal(named.verdict, 'not tested', named.reason);
  assert.match(named.reason, /patterns\.outcome_unknown/);
  assert.match(named.reason, /Could not save the title/);
  assert.equal(res2Judge(e('Ticket T-7 could not be saved.'), ['title'], 'backend', 'w', {}, { object: 'T-7' }).verdict, 'not tested', 'the object');
  // Note 19 (rule 11): without declared patterns no error is read, not even one that names nothing; with them it is.
  assert.equal(res2Judge(e('Internal error'), ['title'], 'backend', 'w').verdict, 'not tested', 'no declared pattern');
  assert.equal(withP({ ...APPLIED, outcome_unknown: 'not sure whether' }, () => res2Judge(e('Internal error'), ['title'], 'backend', 'w').verdict), 'not tested', 'declared-carryover: names nothing, matches nothing: needs reading');
  assert.equal(withP({ ...APPLIED, outcome_unknown: 'not sure whether', not_applied: 'invalid arguments' }, () => res2Judge(e('invalid arguments: title must be a string'), ['title'], 'backend', 'w').verdict), 'violated', 'worded as a refusal of the value, while the change stayed');
  assert.equal(withP({ ...APPLIED, outcome_unknown: 'not sure whether' }, () => res2Judge(e('invalid arguments: title must be a string'), ['title'], 'backend', 'w').verdict), 'not tested', 'declared-carryover: no declared not_applied pattern matches');
  assert.equal(withPatterns({ outcome_unknown: 'not sure whether' }, () => res2Judge(e('Could not save the title mwsc-new right now.'), ['title'], 'backend', 'w', { title: 'mwsc-new' }).verdict), 'not tested', 'patterns.applied is not declared: whether it identifies the change is not read');
  assert.equal(withP({ ...APPLIED, outcome_unknown: 'not sure whether', not_applied: 'could not save' }, () => res2Judge(e('Could not save the title mwsc-new right now.'), ['title'], 'backend', 'w', { title: 'mwsc-new' }).verdict), 'violated', 'the declared patterns decide');
  assert.equal(withP({ ...APPLIED, outcome_unknown: 'not sure whether' }, () => res2Judge(e('Could not save the title mwsc-new right now.'), ['title'], 'backend', 'w', { title: 'mwsc-new' }).verdict), 'not tested', 'declared-carryover: no positive match');
  assert.equal(withPatterns({ ...APPLIED, outcome_unknown: 'not known whether', not_applied: 'was not updated' }, () => res2Judge(e('Error: title was not updated.'), ['title'], 'backend', 'w').verdict), 'violated', 'a declared not_applied pattern says it failed while it stayed applied');
  assert.equal(mentions({ text: 'Title updated', data: null }, 'title'), true, 'mentions is case-insensitive');
});

// ---------------------------------------------------------------- re-review of 3ccc803..eddcc14

test('re-review 2: the default outcome_unknown accepts an honest "could not confirm the update", not "could not verify the webhook URL"', () => {
  const unk = (text: string) => saysUnknown({ text, data: null });
  for (const t of ['Could not confirm the update.', 'Unable to confirm the update was saved.', 'Unable to verify that the change took effect.', 'Backend timed out; could not confirm the write.']) assert.equal(unk(t), true, t);
  assert.equal(unk('Refused: could not verify the webhook URL.'), false);
  assert.equal(unk('Backend unavailable: could not verify the request signature.'), false);
  assert.equal(res2Judge(C({ ok: false, isError: true, text: 'Could not confirm the update.', data: null }), ['title'], 'backend', 'w').verdict, 'not tested', 'rule 11: the default outcome_unknown alone decides nothing');
  assert.equal(withP({ outcome_unknown: DEFAULT_PATTERNS.outcome_unknown }, () => res2Judge(C({ ok: false, isError: true, text: 'Could not confirm the update.', data: null }), ['title'], 'backend', 'w')).verdict, 'held');
});

test('re-review 3: a positive verb is credited only in a clause with no negation, failure or before-state wording', () => {
  const id = (text: string, path: string, value?: unknown) => identifiesChange({ text, data: null }, path, value);
  const kept = 'Update was not applied; the previous title was kept.';
  const old = 'Nothing was changed; the title remains "Old".';
  for (const t of [kept, old, 'The title was unable to be updated.', 'Failed: title updated to nothing.']) assert.equal(id(t, 'title', 'New'), false, t);
  assert.equal(id('The title was updated; the labels were not updated.', 'title'), true);
  assert.equal(id('Ticket T1 was created, but adding its labels failed.', 'T1', 'T1'), true);
  for (const t of [kept, old]) assert.equal(withP({ ...APPLIED, outcome_unknown: 'not known whether', not_applied: 'was not applied|nothing was changed' }, () => res2Judge(C({ ok: false, isError: true, text: t, data: null }), ['title'], 'backend', 'w', { title: 'New' })).verdict, 'violated', t);
  for (const t of [kept, old]) assert.equal(withP({ ...APPLIED, outcome_unknown: 'not known whether' }, () => res2Judge(C({ ok: false, isError: true, text: t, data: null }), ['title'], 'backend', 'w', { title: 'New' })).verdict, 'not tested', t);
  // RETRY-2 step (a): such a repeat does not give the outcome (never held).
  for (const t of [kept, old]) assert.notEqual(judgeA({ key: 'K', t0: TV(3), a1: C({ id: null, version: 4, text: 'Updated, version 4.' }), t1: TV(4), a2: ERR(t), t2: TV(4) }, U()).verdict, 'held', t);
  // The cross-record: the answer does not identify the applied write.
  withPatterns({ ...APPLIED, outcome_unknown: 'not known whether', earlier_failed: 'earlier call failed' }, () => {
    const o = R({ t0: TV(3), a1: C({ id: null, version: 4 }), t1: TV(4), tr: TV(4), a2: ERR('The earlier call failed; the previous title was kept.'), t2: TV(4) });
    assert.equal(res2Cross(o, 'restart', U())?.verdict, 'violated');
  });
});

test('re-review 4: a declared not_applied pattern reads a JSON-only answer; the default does not', () => {
  const json = { status: 'accepted', error: 'Update failed: the backend did not answer' };
  const b = C({ text: JSON.stringify(json), data: json });
  assert.equal(res2Judge(b, [], 'backend', 'w', {}, { async: true }).verdict, 'not tested');
  assert.equal(withPatterns({ not_applied: 'update failed' }, () => res2Judge(b, [], 'backend', 'w', {}, { async: true }).verdict), 'violated');
});

test('re-review 5, 6: what a refusal or an error names is read from values, case-sensitively, never from argument names or data keys', () => {
  // (A): "request ID" is not the argument id; a data key is not a name.
  assert.equal(withNone(() => judgeA(A({ a2: ERR('Internal error (request ID 7f3a)', { args: { id: 'T9', title: 'mwsc-x', idempotency_key: 'K' } }) }), D())).verdict, 'not tested');
  assert.equal(withNone(() => judgeA(A({ a2: ERR('Internal error', { data: { title: null }, args: { title: 'mwsc-x' } }) }), D())).verdict, 'not tested');
  assert.equal(withNone(() => judgeA(A({ a2: ERR('Ticket t1 is locked.') }), D())).verdict, 'not tested', 'the object id is matched exactly');
  // (B): "HTTP status 500" does not name the field status; a data key is not a name.
  assert.equal(withP({ ...APPLIED, outcome_unknown: 'not known whether' }, () => res2Judge(C({ ok: false, isError: true, text: 'HTTP status 500', data: null }), ['status'], 'backend', 'w', { status: 'closed' })).verdict, 'not tested', 'not credited as identifying; matches nothing: needs reading');
  assert.equal(withP({ ...APPLIED, outcome_unknown: 'not known whether', not_applied: 'could not open' }, () => res2Judge(C({ ok: false, isError: true, text: 'Could not open connection', data: { title: null } }), ['title'], 'backend', 'w', { title: 'mwsc-new' })).verdict, 'violated');
  assert.equal(withP({ ...APPLIED, outcome_unknown: 'not known whether' }, () => res2Judge(C({ ok: false, isError: true, text: 'Could not open connection', data: { title: null } }), ['title'], 'backend', 'w', { title: 'mwsc-new' })).verdict, 'not tested');
  assert.equal(withP({ ...APPLIED, outcome_unknown: 'not known whether', not_applied: 'could not be saved' }, () => res2Judge(C({ ok: false, isError: true, text: 'Ticket t-7 could not be saved.', data: null }), ['title'], 'backend', 'w', {}, { object: 'T-7' })).verdict, 'violated', 'the object id is matched exactly');
});

test('re-review 7: an infrastructure refusal is not tested in step (b) under an own check and in step (c); the default unavailable covers 5xx and 429 wording', () => {
  for (const t of ['Upstream returned 502 Bad Gateway', '503 Service Unavailable', 'Gateway Timeout', 'The request timed out.', 'HTTP 429', '429 Too Many Requests']) assert.equal(says('unavailable', t), true, t);
  const bad = ERR('Upstream returned 502 Bad Gateway');
  assert.equal(judgeB({ key: 'K2', t0: T(1), b: bad, t1: T(1), earlier: { id: 'P1', version: 1, applied: true } }, D({ caller_named: true, own_checks: ['name'] })).verdict, 'not tested');
  assert.equal(Cc({ c: bad }).verdict, 'not tested');
});

test('re-review 8: a stated key lifetime shorter than the gap comes before counted twice, also where the step stops early', () => {
  const life = D({ key_lifetime: { ms: 500, quote: 'keys are kept for half a second' } });
  const r = judgeRestart(R({ t1: T(2), t2: { ...T(2), ok: false, reason: 'list failed' }, gap_ms: 700 }), life);
  assert.equal(r.verdict, 'not tested', r.reason);
  assert.match(r.reason, /half a second/);
  const x = judgeCrash(X({ tr: T(2), t2: { ...T(2), ok: false, reason: 'list failed' }, gap_ms: 700 }), life);
  assert.equal(x.verdict, 'not tested', x.reason);
  assert.equal(judgeRestart(R({ t1: T(2), tr: T(2), t2: { ...T(2), ok: false, reason: 'list failed' }, gap_ms: 300 }), life).verdict, 'violated', 'within the lifetime');
});
