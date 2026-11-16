/**
 * MWS-RETRY-2 verdicts (spec 098621b; DECISIONS R8-1, R8-2, R8-3): pure functions over recorded observations, one per
 * step, so that `recheck` and the unit tests apply them to evidence without a server. Governing rule: never a false
 * `violated`, never a false `held`; where the tester cannot decide, `not tested` with the reason and what to declare.
 *
 * The trace is what the tester reads to count applications of a keyed write: for a create, the objects that carry the
 * call's own marker (through the resource's list tool); for an update, the version of a scratch object, where the
 * declaration says the version steps once per applied write (`version_steps`, Annex E). It is read before the first
 * call and after each answer, and counted from before the first call.
 */

import { ruleOfThree } from '../core/stats.js';
import { deepEqual, short } from '../core/util.js';
import { VIOLATED_CAVEAT } from '../report/verdicts.js';
import { fromDeclaration, outcomeByField, saidBy, says } from './says.js';
import { decidedByShape, patternData, quoteField, reservedCode, shapeOf } from './shape.js';
import { identifiesChange, identifiesChangeText, mentions, saysUnknownText, textStatement, valueMentioned, type CallBrief, mayBeUnknown, mayIdentify } from './types.js';

/** One keyed call as observed. */
export interface CallObs extends CallBrief {
  /** The id the answer gives (at idempotency.id), or null. */
  id: unknown;
  /** The version the answer gives (at the resource's version.read), or null. */
  version: unknown;
  /** The declared replay indicator (replay_marker or replay_text): true or false; null where none is declared. */
  replay_marked: boolean | null;
  t_start_ms: number;
  t_end_ms: number;
  /** The arguments sent (with the key, where it is an argument); absent in older evidence. */
  args?: unknown;
}

/** One read of the trace. */
export interface TraceRead {
  step: string;
  ok: boolean;
  /** create: the objects carrying the call's marker. */
  count: number | null;
  /** create: their ids. */
  ids: unknown[];
  /** update: the scratch object's version. */
  version: unknown;
  /** update: a digest of the object without the declared ignored fields (a change without a countable version). */
  digest: string | null;
  t_ms: number;
  reason?: string;
}

/** What the verdicts need from the declaration. */
export interface Decl {
  kind: 'create' | 'update';
  /** The trace can count applications: a create (with a list), or an update with version_steps. */
  countable: boolean;
  /** A create of a name the caller chose (the resource's key block): it cannot take effect a second time. */
  caller_named: boolean;
  /** The update's arguments carry the version the first call consumed. */
  carries_version: boolean;
  own_checks: ('name' | 'version' | 'content')[];
  backend_key: boolean | null;
  key_record_survives: { graceful: boolean | null; kill: boolean | null } | null;
  key_lifetime: { ms: number; quote: string } | null;
  /** update: the changed fields and their values, to tell whether an error identifies the applied change. */
  update_fields: Record<string, unknown>;
  /** The version field (update), to tell whether an error names the new version. */
  version_path: string | null;
  /** The declaration names a replay indicator; the replay pattern is then not used (the indicator decides). */
  replay_declared: boolean;
}

export type StepVerdictWord = 'violated' | 'held' | 'not tested' | 'not observed';
export interface StepVerdict {
  verdict: StepVerdictWord;
  reason: string;
  notes: string[];
  steps: string[];
}

const V = (verdict: StepVerdictWord, reason: string, o: { notes?: string[]; steps?: string[] } = {}): StepVerdict => ({ verdict, reason, notes: o.notes ?? [], steps: o.steps ?? [] });

export const NOTE_OUTCOME = 'outcome not established';
export const NOTE_KEY_RECORD = 'key record not kept';

const strings = (v: unknown, out: string[]): string[] => {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) strings(x, out);
  return out;
};

/**
 * What an answer says, for the patterns (spec 7.3, rule 11): its text, and the string values of its structured content
 * and of a text that is JSON, never the field names (a field named `replayed` set to false says nothing about a replay).
 */
export function textOf(c: Pick<CallBrief, 'text' | 'data' | 'rpc_error'> & Partial<Pick<CallBrief, 'tool' | 'shape'>>): string {
  const parts: string[] = [];
  if (c.text) {
    try {
      strings(JSON.parse(c.text), parts);
    } catch {
      parts.push(c.text);
    }
  }
  // why: B-9 v2: only the free words of an adopted shape are read by patterns.
  strings(patternData(c), parts);
  if (c.rpc_error?.message) parts.push(c.rpc_error.message);
  return [...new Set(parts)].join(' ').trim();
}
const quote = (c: CallObs | null): string => (c ? JSON.stringify(short(c.text ?? c.rpc_error?.message ?? (c.data === null ? '' : JSON.stringify(c.data)), 160)) : '(no answer)');
const form = (c: CallObs): string => (c.rpc_error ? `a JSON-RPC error (${c.rpc_error.code})` : c.isError ? 'a tool execution error (isError: true)' : 'a success');

/** A refusal that says nothing about the write itself (a rate limit, an unavailable backend), decided by the `unavailable` pattern; an answer that says the outcome is unknown says something about the write. */
export function saysNothingAboutWrite(c: CallObs): boolean {
  // why: B-9: the reserved codes unavailable and not_permitted (writes disabled, read-only mode, forbidden) are such refusals,
  // decided by the adopted shape (no patterns.unavailable needed): neither says anything about the earlier call with the key.
  if (!c.ok && (reservedCode(shapeOf(c)) === 'unavailable' || reservedCode(shapeOf(c)) === 'not_permitted')) return true;
  return !c.ok && says('unavailable', textOf(c)) && !saysUnknownDeclared(c);
}

/** The answer says the outcome is not known, by a declared patterns.outcome_unknown (rule 11: the default alone decides nothing). */
// why: an adopted result shape whose outcome is well formed says it (rule 11, B-9 v2); else a declared outcome field, else a declared pattern.
// R14-5: the shape and the text are read on their own; either one that says the outcome is not known says it.
export const saysUnknownDeclared = (c: CallObs): boolean => shapeOf(c)?.outcome === 'unknown' || outcomeByField(c)?.outcome === 'unknown' || (outcomeByField(c) === null && fromDeclaration('outcome_unknown') && saysUnknownText(c));

/**
 * A statement in the text, by a declared pattern, that the write failed, that the earlier call failed, or that the outcome is not
 * known (rule 11, R14-5): beside an adopted shape that identifies the applied change, it keeps the answer from giving the outcome.
 */
const textContradicts = (c: CallObs): boolean => !c.ok && ((fromDeclaration('not_applied') && says('not_applied', textOf(c))) || (fromDeclaration('earlier_failed') && says('earlier_failed', textOf(c))) || (fromDeclaration('outcome_unknown') && saysUnknownText(c)));

/** The record's line for an answer that says the outcome is not known: the adopted result shape's member, or the declared pattern. */
const unknownNote = (c: CallObs): string => (shapeOf(c)?.outcome === 'unknown' ? decidedByShape([['outcome', 'unknown'], ['code', shapeOf(c)!.code]], c) : saidBy('outcome_unknown', textOf(c)));

/**
 * A refusal whose reading is left to a declared pattern (review of note 8, (A); spec 7.3 rule 11): it
 * gives no outcome, says nothing of an unknown outcome, and names neither the key, the object nor an argument it was sent.
 * Whether it "says nothing about the write itself" (a rate limit, an unavailable backend) was decided only by the default
 * `unavailable` pattern not matching, so where the declaration gives no `patterns.unavailable` the step gives `not tested`,
 * quoting the text, instead of `violated`. A declared pattern decides as before.
 */
export function undecidedRefusal(c: CallObs, _key: string, _ids: unknown[], _fields: Record<string, unknown> = {}): boolean {
  // why: gate-2 re-run on 378f32f, review of note 19 (7): whether a refusal "says nothing about the write itself" is a reading;
  // naming the object or an argument does not settle it ("Failed to insert ticket 'x': database connection lost"). Without a
  // declared patterns.unavailable, and unless a declared outcome_unknown pattern reads it, every such refusal is undecided.
  // why: an adopted shape with a well-formed outcome or a reserved code says what the refusal is; it is not left undecided.
  if (shapeOf(c)?.outcome || reservedCode(shapeOf(c))) return false;
  // why: gate-2 safety re-run on 0295ed6 (F4), owner's decision S1 (R11-1): with patterns.unavailable declared, a refusal it does
  // not match ("Request refused.") is still undecided; only a positive match of a declared pattern reads a refusal.
  if (c.ok || c.indeterminate || saysUnknownDeclared(c)) return false;
  const t = textOf(c);
  const read = (['unavailable', 'repeat_refused', 'applied', 'not_applied', 'earlier_failed', 'replay', 'in_progress'] as const).some((k) => fromDeclaration(k) && says(k, t));
  return !read && outcomeByField(c) === null;
}
const undecidedV = (step: string, c: CallObs, steps: string[]): StepVerdict =>
  V('not tested', `${step}: the repeat was refused (${quote(c)}) and no declared pattern reads it; whether it is a refusal that says nothing about the write itself (a rate limit, an unavailable backend), one that says the outcome is not known, or one that identifies the change needs reading (patterns.unavailable, patterns.outcome_unknown, patterns.applied; a default pattern alone decides nothing, spec 7.3, rule 11)`, { steps, notes: [saidBy('unavailable', textOf(c)), saidBy('outcome_unknown', textOf(c))] });

/**
 * Applications of the write between two reads of the trace: for a create, the objects with the marker that were added;
 * for an update, the version's steps. Null where it cannot be counted.
 */
export function applications(t0: TraceRead, t: TraceRead, d: Decl): number | null {
  if (!t0.ok || !t.ok) return null;
  if (d.kind === 'create') return t0.count === null || t.count === null ? null : t.count - t0.count;
  if (!d.countable) return null;
  const a = Number(t0.version);
  const b = Number(t.version);
  return typeof t0.version === 'number' || typeof t.version === 'number' || (/^\d+$/.test(String(t0.version)) && /^\d+$/.test(String(t.version))) ? (Number.isFinite(a) && Number.isFinite(b) ? b - a : null) : null;
}

/** Did the trace change between two reads (a create added an object; an update changed the version or the object)? Null: unknown. */
export function changed(t0: TraceRead, t: TraceRead, d: Decl): boolean | null {
  if (!t0.ok || !t.ok) return null;
  if (d.kind === 'create') return t0.count === null || t.count === null ? null : t.count !== t0.count;
  if (t0.version !== null && t0.version !== undefined && t.version !== null && t.version !== undefined) return !deepEqual(t0.version, t.version);
  if (t0.digest !== null && t.digest !== null) return t0.digest !== t.digest;
  return null;
}

/**
 * Does an error identify the change the trace shows applied (the created object, or the update's field or new version)?
 * Decided by a declared patterns.applied only (gate-2 re-run on 378f32f, note 19, R1; rule 11); see readsApplied.
 */
export function identifiesApplied(c: CallObs, d: Decl, trace: TraceRead | null): boolean {
  if (c.ok) return false;
  if (d.kind === 'create') return (trace?.ids ?? []).some((id) => identifiesChange(c, String(id), id));
  const fields = Object.entries(d.update_fields).some(([p, v]) => identifiesChange(c, p, v));
  return fields || (!!d.version_path && trace !== null && trace.version !== null && trace.version !== undefined && identifiesChange(c, d.version_path, trace.version));
}

/** identifiesApplied read in the text and the declared patterns alone (rule 11, R14-5). */
function identifiesAppliedText(c: CallObs, d: Decl, trace: TraceRead | null): boolean {
  if (d.kind === 'create') return (trace?.ids ?? []).some((id) => identifiesChangeText(c, String(id), id));
  const fields = Object.entries(d.update_fields).some(([p, v]) => identifiesChangeText(c, p, v));
  return fields || (!!d.version_path && trace !== null && trace.version !== null && trace.version !== undefined && identifiesChangeText(c, d.version_path, trace.version));
}

/**
 * What an error says of the applied change, under rule 11: true or false where the declaration's patterns.applied decided it;
 * null where only the tester's default reading could (it decides nothing).
 */
export function readsApplied(c: CallObs, d: Decl, trace: TraceRead | null): boolean | null {
  if (c.ok) return false;
  // why: rule-11 coverage package: a declared outcome field decides before any text is read.
  const f = outcomeByField(c);
  // why: rule 11, point 13 (R14-5): a declared text failure beside the field is read on its own; the field does not repair it.
  if (f) return f.outcome === 'applied' && !textContradicts(c);
  // why: an adopted result shape the answer carries well formed decides like a declared pattern (rule 11); a forbidden statement
  // in the text beside it is read on its own and is not repaired by it (R14-5).
  if (shapeOf(c)?.outcome) return identifiesApplied(c, d, trace) && !textContradicts(c);
  return fromDeclaration('applied') ? identifiesApplied(c, d, trace) : null;
}

/** The first answer gave the outcome: a success, or an error that identifies the applied change (null: an error only a default reading could decide). */
export function gaveOutcome(c: CallObs | null, d: Decl, trace: TraceRead | null): boolean | null {
  if (!c || c.indeterminate) return false;
  return c.ok ? true : readsApplied(c, d, trace);
}
const unreadFirst = (step: string, a1: CallObs, d: Decl, t1: TraceRead | null): string => `${step}: the first call applied the write and was answered with an error (${quote(a1)}); whether it identifies the applied change is decided by patterns.applied, which the declaration does not give. The tester's default reading ${identifiesApplied(a1, d, t1) ? 'reads it as identifying the change' : 'does not read it as identifying the change'}, and a default pattern alone decides nothing (spec 7.3, rule 11): declare patterns.applied, or read it`;

/**
 * Does the repeat give the outcome of the first call? A success with the same identifier, where the first answer gave
 * one, and the same version, where it gave one (a replay indicator, another sentence or an empty changed-fields list
 * is not a different result); or an error that identifies the applied change and reports it as applied. Where the
 * first call gave no answer with the outcome, a success that names the object or version the trace shows applied.
 * null: a success that cannot be compared (it carries no identifier where one is needed).
 */
export function givesOutcome(first: CallObs | null, second: CallObs, d: Decl, trace: TraceRead | null): { gives: boolean | null; why: string } {
  if (second.indeterminate) return { gives: false, why: 'the repeat has no answer (a timeout or a broken connection)' };
  // why: note 19, R2: "where the first answer was a success, the second is a success too" — an error is not, whatever it says.
  if (!second.ok && first && first.ok) return { gives: false, why: `the first answer was a success and the repeat was ${form(second)}` };
  if (!second.ok) {
    const r = readsApplied(second, d, trace);
    // why: note 19, R1 (rule 11): whether an error identifies the applied change is read by a declared pattern only.
    const fo = outcomeByField(second);
    if (fo) return r ? { gives: true, why: `the repeat is an error whose declared outcome field says the write was applied (${fo.line})` } : { gives: false, why: `the repeat is an error whose declared outcome field says ${fo.outcome === 'unknown' ? 'the outcome is not known' : 'the write was not applied'} (${fo.line})` };
    if (r === null) return { gives: null, why: `the repeat was ${form(second)}, and whether it identifies the applied change is decided by patterns.applied, which the declaration does not give (the tester's default reading ${identifiesApplied(second, d, trace) ? 'reads it as identifying the change' : 'does not'}; spec 7.3, rule 11)` };
    // why: an adopted result shape is a structured statement: an error whose shape does not identify the applied change says so.
    if (shapeOf(second)?.outcome) return r ? { gives: true, why: `the repeat is an error that identifies the applied change (by its adopted result shape: ${quoteField('outcome', shapeOf(second)!.outcome)})` } : { gives: false, why: `the repeat was ${form(second)} that does not identify the applied change (by its adopted result shape: ${quoteField('outcome', shapeOf(second)!.outcome)}${textContradicts(second) ? '; and its text, by a declared pattern, says the write or the earlier call failed or that the outcome is not known' : ''})` };
    // why (declared-carryover): a declared pattern that does not match other wording decides nothing; the answer needs reading.
    return r ? { gives: true, why: 'the repeat is an error that identifies the applied change (by the declared patterns.applied)' } : { gives: null, why: `the repeat was ${form(second)} that the declared patterns.applied does not read as identifying the applied change; it needs reading` };
  }
  // why: validator on 59e3124 (rule 11, point 13, R14-5): a success repeat is read on its own statements too. Its adopted shape's
  // outcome describes the write the key identifies (B-9 v2, a repeat with a key), so one that is not applied (or accepted, for a
  // declared asynchronous operation) says the first call's write was not made; and a text that says by a declared pattern that
  // the write failed is not repaired by a correct shape, an id or a version.
  const so = shapeOf(second)?.outcome;
  if (so && so !== 'applied' && so !== 'accepted') return { gives: false, why: `the repeat is a success whose adopted result shape says ${quoteField('outcome', so)} for the write its key identifies, which is not the first call's outcome (rule 11, point 13)` };
  const tfail = textStatement(second, 'not_applied');
  if (tfail) return { gives: false, why: `the repeat is a success whose text says, by the declared patterns.not_applied, that the write failed or nothing was changed (${tfail}); an id, a version or a shape beside it does not repair it (rule 11, point 13)` };
  const idSame = (want: unknown): boolean | null => {
    if (second.id !== null && second.id !== undefined) return deepEqual(second.id, want);
    return mentions(second, want) ? true : null;
  };
  if (first && first.ok) {
    if (first.id !== null && first.id !== undefined) {
      const s = idSame(first.id);
      if (s !== true) return { gives: false, why: s === null ? `the first answer gave the id ${short(first.id, 40)} and the repeat gives none` : `the repeat gives the id ${short(second.id, 40)}, the first answer ${short(first.id, 40)}` };
    }
    if (first.version !== null && first.version !== undefined && !deepEqual(first.version, second.version)) return { gives: false, why: `the first answer gave version ${short(first.version, 20)} and the repeat ${second.version === null || second.version === undefined ? 'gives none' : `gives ${short(second.version, 20)}`}` };
    return { gives: true, why: 'the repeat is a success with the same result' };
  }
  if (d.kind === 'create') {
    const ids = trace?.ids ?? [];
    if (!ids.length) return { gives: null, why: 'the trace names no object to compare the success with' };
    if (second.id === null || second.id === undefined) {
      const m = ids.some((id) => mentions(second, id));
      return m ? { gives: true, why: 'the repeat is a success that names the object the first call created' } : { gives: null, why: 'the repeat is a success that carries no id at idempotency.id, so whether it names the object the first call created could not be told' };
    }
    return ids.some((id) => deepEqual(id, second.id)) ? { gives: true, why: 'the repeat is a success that names the object the first call created' } : { gives: false, why: `the repeat reports a success with the id ${short(second.id, 40)}, which is not the object the first call created` };
  }
  if (second.version === null || second.version === undefined || trace === null) return { gives: null, why: 'the repeat is a success that carries no version, so whether it gives the first call\'s change could not be told' };
  return deepEqual(second.version, trace.version) ? { gives: true, why: 'the repeat is a success with the version the first call produced' } : { gives: false, why: `the repeat reports version ${short(second.version, 20)}; the first call produced ${short(trace.version, 20)}` };
}

const traceFailed = (ts: (TraceRead | null | undefined)[]): string | null => {
  const bad = ts.find((t) => !t || !t.ok);
  if (bad === undefined) return null;
  return bad === null ? 'a read of the trace is missing' : `the trace could not be read (${bad.step}: ${bad.reason ?? 'the read failed'})`;
};

const maxApps = (t0: TraceRead, ts: (TraceRead | null | undefined)[], d: Decl): number | null => {
  let m: number | null = null;
  for (const t of ts) {
    if (!t) continue;
    const a = applications(t0, t, d);
    if (a === null) return null;
    m = m === null ? a : Math.max(m, a);
  }
  return m;
};

/**
 * The rule that a write with key K the trace counts as applied more than once is `violated`, over the reads that exist
 * (review of note 8, 11: in step (e) and its crash form it is "applied before any other rule", so before a failed restart,
 * an error or a missing read gives `not tested`). The largest count, where it is more than one; else null.
 */
const countedTwice = (t0: TraceRead | null, reads: (TraceRead | null | undefined)[], d: Decl): number | null => {
  if (!t0 || !t0.ok) return null;
  let m: number | null = null;
  for (const t of reads) {
    if (!t || !t.ok) continue;
    const a = applications(t0, t, d);
    if (a !== null && (m === null || a > m)) m = a;
  }
  return m !== null && m > 1 ? m : null;
};

const pendingNote = (c: CallObs | null): string | null => (c && c.result_type ? `The answer was a ${c.result_type} result; judging a task or input_required answer on its final result is not built in this preview, so the trial is not tested.` : null);

/**
 * The repeat after a first answer that gave the outcome, with one application counted (step (a); the proxy-assisted
 * step and step (e) refer to it): a repeat that gives the outcome is `held`; a refusal that says nothing about the
 * write is `not tested`; any other answer, including one that says the outcome is not known, is `violated`.
 */
function repeatAfterOutcome(step: string, a1: CallObs, a2: CallObs, d: Decl, t1: TraceRead, key = ''): StepVerdict {
  const steps = [a1.step, a2.step];
  if (a2.indeterminate) return V('not tested', `${step}: the repeat with the same key ${a2.result_type ? `was answered with a ${a2.result_type} result` : 'timed out or lost its connection'}, so its outcome is unknown (spec 7.3, rule 5)`, { notes: [pendingNote(a2)].filter((x): x is string => !!x) });
  const g = givesOutcome(a1, a2, d, t1);
  if (g.gives === true) return V('held', `${step}: the write was applied once, and the repeat with the same key gave the first call's outcome (${g.why})`, { steps });
  if (saysNothingAboutWrite(a2)) return V('not tested', `${step}: the repeat was refused with an answer that says nothing about the write itself (${quote(a2)}), so the condition was not forced`, { notes: [saidBy('unavailable', textOf(a2))] });
  if (undecidedRefusal(a2, key, [...(t1.ids ?? []), a1.id], d.update_fields)) return undecidedV(step, a2, steps);
  // A positive match of a pattern that means a violation still decides: the repeat says the outcome is not known, or that the write failed.
  // why: review: a failure that also identifies the applied change (by any reading) is not a positive statement that it failed.
  const failedD = !a2.ok && fromDeclaration('not_applied') && says('not_applied', textOf(a2)) && !mayBeUnknown(textOf(a2)) && !mayIdentifyApplied(a2, d, t1);
  if (g.gives === null && !a2.ok && !saysUnknownDeclared(a2) && !failedD) return V('not tested', `${step}: ${g.why}: ${quote(a2)}. Declare patterns.applied, or read it`, { steps, notes: [saidBy('applied', textOf(a2))] });
  const unknown = !a2.ok && saysUnknownDeclared(a2);
  return V('violated', `${step}: the first answer gave the outcome and the write was applied once, but the repeat with the same key ${unknown ? `said that the outcome is not known (${quote(a2)})` : g.gives === null ? `could not be shown to give it (${g.why})` : `did not give it: ${g.why} (${quote(a2)})`}`, { steps, notes: unknown ? [unknownNote(a2)] : [] });
}

// ---------------------------------------------------------------- steps (a), (b), (c)

export interface StepAObs {
  key: string;
  t0: TraceRead | null;
  a1: CallObs | null;
  t1: TraceRead | null;
  a2: CallObs | null;
  t2: TraceRead | null;
  skipped?: string;
  error?: string;
}

/** Step (a): A1 with key K, then A2 with K and the same arguments. */
export function judgeA(o: StepAObs, d: Decl): StepVerdict {
  if (o.skipped) return V('not tested', `step (a) not run: ${o.skipped}`);
  if (!d.countable) return V('not tested', 'step (a): the write leaves no trace the tester can count (an update needs idempotency.version_steps: true and the resource\'s version field, Annex E)');
  if (o.error && !o.a1) return V('not tested', `step (a) stopped: ${o.error}`);
  const bad = traceFailed([o.t0, o.t1, ...(o.a2 ? [o.t2] : [])]);
  if (bad) {
    const n = countedTwice(o.t0, [o.t1, o.t2], d);
    if (n) return V('violated', `step (a): the trace counts ${n} applications of the write with key ${o.key} (one key, the same arguments), although ${bad}`, { steps: [o.a1?.step, o.a2?.step].filter((s): s is string => !!s) });
    return V('not tested', `step (a): ${bad}`);
  }
  const t0 = o.t0!;
  const apps1 = applications(t0, o.t1!, d);
  const total = maxApps(t0, [o.t1, o.t2], d);
  if (apps1 === null || total === null) return V('not tested', 'step (a): the trace could not be counted');
  const steps = [o.a1?.step, o.a2?.step].filter((s): s is string => !!s);
  if (total > 1) return V('violated', `step (a): the trace counts ${total} applications of the write with key ${o.key} (one key, the same arguments)`, { steps });
  const a1 = o.a1!;
  if (a1.indeterminate) return V('not tested', `step (a): the first call ${a1.result_type ? `was answered with a ${a1.result_type} result` : 'timed out or lost its connection'}, and the write was applied at most once (spec 7.3, rule 5)`, { notes: [pendingNote(a1)].filter((x): x is string => !!x) });
  if (apps1 < 1) return V('not tested', `step (a): the first call with key ${o.key} did not apply the write (the trace counts none after it; the answer was ${form(a1)}: ${quote(a1)}), so there was no outcome to repeat`);
  const gave = gaveOutcome(a1, d, o.t1);
  if (gave === null) return V('not tested', unreadFirst('step (a)', a1, d, o.t1), { notes: [saidBy('applied', textOf(a1))] });
  if (!gave) return V('not tested', `step (a): the first call applied the write but was answered neither with a success nor with an error that identifies the applied change (${quote(a1)}); the proxy-assisted step is the forced form of this case`);
  if (!o.a2) return V('not tested', `step (a): the repeat was not sent${o.error ? ` (${o.error})` : ''}`);
  return repeatAfterOutcome('step (a)', a1, o.a2, d, o.t1!, o.key);
}

export interface StepBObs {
  key: string;
  t0: TraceRead | null;
  b: CallObs | null;
  t1: TraceRead | null;
  /** The first call of step (a): its id and version, and whether it applied the write. */
  earlier: { id: unknown; version: unknown; applied: boolean | null } | null;
  /** update: the call carried a version (a value in the version argument), so a declared version check could run; absent in older evidence. */
  version_sent?: boolean;
  skipped?: string;
  error?: string;
}

const ownCheck = (d: Decl): 'name' | 'version' | 'content' | null => {
  if (d.kind === 'create' && d.caller_named && d.own_checks.includes('name')) return 'name';
  if (d.own_checks.includes('version') && d.carries_version) return 'version';
  if (d.kind === 'create' && d.own_checks.includes('content')) return 'content';
  return null;
};

/** Step (b): the same write with a new key K2 must be treated as a new write: applied, or refused on its own merits. */
export function judgeB(o: StepBObs, d: Decl): StepVerdict {
  if (o.skipped) return V('not tested', `step (b) not run: ${o.skipped}`);
  if (o.earlier && o.earlier.applied === null) return V('not tested', 'step (b): whether the first call of step (a) applied the write is not known (its trace could not be read), so there was no known earlier write for a new key to be confused with');
  if (!o.earlier || !o.earlier.applied) return V('not tested', 'step (b): the first call of step (a) did not apply the write, so there was no earlier write for a new key to be confused with');
  if (!o.b) return V('not tested', `step (b) not run${o.error ? `: ${o.error}` : ''}`);
  const b = o.b;
  const steps = [b.step];
  if (b.indeterminate) return V('not tested', `step (b): the call with a new key ${b.result_type ? `was answered with a ${b.result_type} result` : 'timed out or lost its connection'}, so its outcome is unknown (spec 7.3, rule 5)`, { notes: [pendingNote(b)].filter((x): x is string => !!x) });
  const bad = traceFailed([o.t0, o.t1]);
  if (bad) return V('not tested', `step (b): ${bad}`);
  const text = textOf(b);
  const ch = changed(o.t0!, o.t1!, d);
  const own = ownCheck(d);
  // why (review of note 8, 1): a refusal by a check the declaration says the tool makes whatever the key is a refusal on its
  // own merits, "whatever its wording"; it is decided before any pattern reads the wording.
  if (!b.ok && own && ch !== true) {
    // why (re-review 7): an infrastructure refusal (a 502, a rate limit) is not the own check; the default may decide here, since it only gives not tested.
    if (says('unavailable', text)) return V('not tested', `step (b): the write with a new key was refused with an answer that says nothing about the write itself (${quote(b)}), so the condition was not forced`, { notes: [saidBy('unavailable', text)] });
    return V('held', `step (b): the write with a new key was refused on its own merits, by the ${own} check the declaration says the tool makes whatever the key (${quote(b)}); it was treated as a new write`, { steps });
  }
  // why: rule 11, B-9: replayed: true in an adopted result shape marks a replay, like a declared replay indicator.
  if (shapeOf(b)?.replayed === true) return V('violated', `step (b): the write with a new key ${o.key} was answered as a replay of the earlier call (${quoteField('replayed', true)} in its adopted result shape)`, { steps, notes: [decidedByShape([['replayed', true]], b)] });
  if (b.replay_marked === true) return V('violated', `step (b): the write with a new key ${o.key} was answered as a replay of the earlier call (the declared replay indicator is set)`, { steps });
  // Rule 11: a pattern decides `violated` only where the declaration gives it; the default alone gives `not tested` below.
  const replaySaid = !d.replay_declared && says('replay', text);
  const repeatSaid = !b.ok && says('repeat_refused', text);
  if (replaySaid && fromDeclaration('replay')) return V('violated', `step (b): the write with a new key ${o.key} was answered as a replay of the earlier call (${quote(b)})`, { steps, notes: [saidBy('replay', text)] });
  if (repeatSaid && fromDeclaration('repeat_refused')) return V('violated', `step (b): the write with a new key ${o.key} was refused because it repeats an earlier call (${quote(b)})`, { steps, notes: [saidBy('repeat_refused', text)] });
  if (ch === null) return V('not tested', 'step (b): the trace could not tell whether the write was applied');
  // why (review 2): a create the declared content check finds a duplicate cannot take effect a second time: a success with the
  // earlier object is not told from a replay. Where the trace shows a new object, the check did not find one.
  const dupOk = d.caller_named || (d.own_checks.includes('content') && !ch);
  if (d.kind === 'create' && b.ok && !dupOk && o.earlier.id !== null && o.earlier.id !== undefined && b.id !== null && b.id !== undefined && deepEqual(b.id, o.earlier.id)) return V('violated', `step (b): the write with a new key ${o.key} was answered with the earlier call's object (${short(b.id, 40)}) where a new object could have been made`, { steps, notes: replaySaid ? [saidBy('replay', text)] : [] });
  if (ch && d.kind === 'update' && b.ok && o.earlier.version !== null && o.earlier.version !== undefined && deepEqual(b.version, o.earlier.version)) return V('violated', `step (b): the write with a new key ${o.key} changed the object but was answered with the earlier call's version (${short(o.earlier.version, 20)}), as a replay`, { steps });
  if (replaySaid || repeatSaid) {
    const k = replaySaid ? 'replay' : 'repeat_refused';
    const what = replaySaid ? 'answered as a replay of the earlier call' : 'refused because it repeats an earlier call';
    const declare = replaySaid ? 'declare patterns.replay, or the replay indicator (idempotency.replay_marker or replay_text)' : 'declare patterns.repeat_refused';
    return V('not tested', `step (b): whether the write with a new key ${o.key} was ${what} could not be decided: only the tester's default pattern for ${k.replace('_', ' ')} matched its answer (${quote(b)}), and a default pattern alone does not decide a violation (spec 7.3, rule 11); ${declare}, or read it`, { steps, notes: [saidBy(k, text)] });
  }
  if (ch) return V('held', `step (b): the write with a new key was applied as a new write (${d.kind === 'create' ? 'one more object carries the marker' : 'the version changed'}) and was not answered as a replay`, { steps });
  if (!b.ok) {
    if (saysNothingAboutWrite(b)) return V('not tested', `step (b): the write with a new key was refused with an answer that says nothing about the write itself (${quote(b)}), so the condition was not forced`, { notes: [saidBy('unavailable', text)] });
    const hint = d.kind === 'create' && d.caller_named ? 'idempotency.own_checks: [name]' : d.kind === 'update' ? 'idempotency.own_checks: [version] (with the version sent in idempotency.args)' : 'idempotency.own_checks (name, version or content)';
    return V('not tested', `step (b): the write with a new key was refused (${quote(b)}), and the tester cannot tell whether that was on its own merits or because it repeats the earlier call; if the tool or its backend makes that check whatever the key, declare ${hint}`, { steps });
  }
  // A success that applied nothing.
  if (d.kind === 'update') return V('not tested', `step (b): the update with a new key sets the values the object already has, so it cannot take effect a second time, and the version did not change; a success that does not say it is a replay cannot be told from one (NF-5, NF-24)`, { steps });
  if (d.caller_named || d.own_checks.includes('content')) return V('not tested', `step (b): the create with a new key names ${d.caller_named ? 'a name the caller chose that now exists' : 'content a duplicate check finds'}, so it cannot take effect a second time; a success that does not say it is a replay cannot be told from one (NF-5, NF-24)`, { steps });
  return V('not tested', `step (b): the create with a new key was answered as a success (${quote(b)}) and the trace counts no new object; the answer does not say whether it was a replay, so the step cannot be judged`, { steps });
}

export interface StepCObs {
  key: string;
  /**
   * The argument changed and its two values, or null when none could be changed. `valid`: whether the changed arguments
   * validate against the tool's input schema (true, false, or 'unknown' where the validator cannot tell); absent in older evidence.
   */
  vary: { arg: string; from: unknown; to: unknown; valid?: boolean | 'unknown' } | null;
  t0: TraceRead | null;
  c: CallObs | null;
  t1: TraceRead | null;
  /** null: the trace could not be read, so whether it applied is not known. */
  earlier_applied: boolean | null;
  skipped?: string;
  error?: string;
}

/** Step (c): key K again with different arguments (that a fresh key would apply) must be refused, the object unchanged. */
export function judgeC(o: StepCObs, d: Decl): StepVerdict {
  if (o.skipped) return V('not tested', `step (c) not run: ${o.skipped}`);
  if (!o.vary) return V('not tested', 'step (c): no argument could be changed (declare idempotency.vary: an argument whose changed value the tool would apply under a fresh key)');
  // why (review of note 8, 8): the changed arguments must be ones the tool would apply under a fresh key; arguments its input
  // schema refuses would be refused whatever the key, so a refusal of them shows nothing about the key.
  if (o.vary.valid === false) return V('not tested', `step (c): the changed arguments (${o.vary.arg} ${short(o.vary.to, 40)} instead of ${short(o.vary.from, 40)}) do not validate against the tool's input schema, so the tool would not apply them under a fresh key either; declare idempotency.vary (an argument whose changed value the tool would apply)`);
  if (o.earlier_applied === null) return V('not tested', 'step (c): whether the first call of step (a) applied the write is not known (its trace could not be read), so the key may not have been recorded');
  if (!o.earlier_applied) return V('not tested', 'step (c): the first call of step (a) did not apply the write, so the key may not have been recorded');
  if (!o.c) return V('not tested', `step (c) not run${o.error ? `: ${o.error}` : ''}`);
  const c = o.c;
  const steps = [c.step];
  if (c.indeterminate) return V('not tested', `step (c): the call ${c.result_type ? `was answered with a ${c.result_type} result` : 'timed out or lost its connection'}, so its outcome is unknown (spec 7.3, rule 5)`);
  const bad = traceFailed([o.t0, o.t1]);
  if (bad) return V('not tested', `step (c): ${bad}`);
  const ch = changed(o.t0!, o.t1!, d);
  if (ch === null) return V('not tested', 'step (c): the trace could not tell whether the write was applied');
  if (ch) return V('violated', `step (c): key ${o.key} reused with ${o.vary.arg} ${short(o.vary.to, 40)} instead of ${short(o.vary.from, 40)} was applied (${c.ok ? 'and answered as a success' : `and answered with ${form(c)}`})`, { steps });
  if (c.ok) return V('violated', `step (c): key ${o.key} reused with ${o.vary.arg} ${short(o.vary.to, 40)} instead of ${short(o.vary.from, 40)} was answered as a success${c.replay_marked ? ', as a replay of the earlier call' : ''} (${quote(c)}); it must be refused`, { steps });
  if (saysNothingAboutWrite(c)) return V('not tested', `step (c): the call was refused with an answer that says nothing about the write itself (${quote(c)}), so the condition was not forced`, { notes: [saidBy('unavailable', textOf(c))] });
  if (says('unavailable', textOf(c))) return V('not tested', `step (c): the call was refused with an answer that reads as an infrastructure refusal (${quote(c)}), not a refusal of the key reused, so the condition was not forced`, { notes: [saidBy('unavailable', textOf(c))] });
  if (validationRefusal(c, o.vary)) return V('not tested', `step (c): key ${o.key} reused with ${o.vary.arg} ${short(o.vary.to, 40)} was refused with an answer that reads as a refusal of the arguments themselves (${quote(c)}), not of the key reused, so whether the tool would apply them under a fresh key is not shown; declare idempotency.vary (an argument whose changed value the tool would apply)`, { steps });
  if (o.vary.valid === 'unknown') return V('held', `step (c): key ${o.key} reused with different arguments was refused (${form(c)}) and nothing was applied; MWS-RES-2 judges the form of the refusal`, { steps, notes: ['Whether the changed arguments validate against the tool\'s input schema could not be decided (it uses a keyword the tester does not evaluate); the refusal does not read as a refusal of the arguments.'] });
  return V('held', `step (c): key ${o.key} reused with different arguments was refused (${form(c)}) and nothing was applied; MWS-RES-2 judges the form of the refusal`, { steps });
}

const KEY_REUSE = /\b(idempoten\w*|keys?|re-?used?|already used|different (arguments|payload|parameters|request|body))\b/i;
const VALIDATION = /\b(invalid|validation|must (be|match|have|contain)|(is|are) required|too (long|short|large|small|many|few)|exceeds?|not allowed|expected (a|an|one of)|out of range|does not match|not (a )?valid|unknown (argument|property|field|parameter)|additional propert\w*)\b/i;

/**
 * Does a refusal in step (c) read as a refusal of the arguments themselves (a validation error), not of the key reused
 * (review of note 8, 8)? A JSON-RPC invalid-params error, or an answer with validation wording that names the changed
 * argument or its value, and that does not speak of the key or of different arguments. Deciding it can only give `not tested`.
 */
export function validationRefusal(c: CallObs, vary: { arg: string; to: unknown }): boolean {
  if (c.ok) return false;
  // why: B-9 v2: idempotency_key_reused says the refusal is of the key reused, not of the arguments themselves.
  if (reservedCode(shapeOf(c)) === 'idempotency_key_reused') return false;
  if (reservedCode(shapeOf(c)) === 'invalid_argument' || reservedCode(shapeOf(c)) === 'version_required') return true;
  const text = textOf(c);
  if (KEY_REUSE.test(text)) return false;
  if (c.rpc_error?.code === -32602) return true;
  return VALIDATION.test(text) && (mentions(c, vary.arg) || mentions(c, vary.to));
}

/** One record for steps (a), (b) and (c): `violated` if any is, `held` if all three forced their condition and held, else `not tested` naming the steps. */
export function combineABC(a: StepVerdict, b: StepVerdict, c: StepVerdict): StepVerdict {
  const all = [['a', a], ['b', b], ['c', c]] as const;
  const notes = all.flatMap(([n, v]) => [`Step (${n}): ${v.verdict}. ${v.reason.replace(/^step \([abc]\)(:| not run:| stopped:)?\s*/i, '')}`, ...v.notes]);
  const steps = all.flatMap(([, v]) => v.steps);
  const bad = all.filter(([, v]) => v.verdict === 'violated');
  if (bad.length) return V('violated', `${bad.map(([, v]) => v.reason).join('; ')}.`, { notes, steps });
  const open = all.filter(([, v]) => v.verdict !== 'held');
  if (!open.length) return V('held', 'Steps (a), (b) and (c) each forced their condition and held: the repeat with the same key was applied once and gave the first outcome, a new key was a new write, and the key reused with different arguments was refused.', { notes, steps });
  return V('not tested', `Not every step forced its condition: ${open.map(([n, v]) => `step (${n}) ${v.reason.replace(/^step \([abc]\)(:| not run:| stopped:)?\s*/i, '')}`).join('; ')}${all.some(([, v]) => v.verdict === 'held') ? `; ${all.filter(([, v]) => v.verdict === 'held').map(([n]) => `step (${n})`).join(' and ')} held` : ''}.`, { notes, steps });
}

// ---------------------------------------------------------------- step (d)

export interface PairObs {
  key: string;
  t0: TraceRead | null;
  x: CallObs | null;
  y: CallObs | null;
  t1: TraceRead | null;
  error?: string;
}

export interface StepDObs {
  pairs: PairObs[];
  /** The pairs the run could send at most (limits.pairs). */
  limit: number;
  stop: 'overlapped' | 'limit' | 'error';
  skipped?: string;
  error?: string;
}

/** Spec 8.2, rule 6. */
export const MIN_OVERLAPPED_PAIRS = 30;

export const overlapMs = (x: CallObs, y: CallObs): number => Math.min(x.t_end_ms, y.t_end_ms) - Math.max(x.t_start_ms, y.t_start_ms);

/** One pair: a loss (applied more than once), counted as overlapped, or excluded; a pair that did not overlap is judged by step (a)'s rules and can only add `violated`. */
export function judgePair(p: PairObs, d: Decl): { outcome: 'loss' | 'counted' | 'excluded' | 'violated'; overlapped: boolean; apps: number | null; why: string } {
  if (!p.x || !p.y) return { outcome: 'excluded', overlapped: false, apps: null, why: p.error ?? 'the pair was not sent' };
  const ov = overlapMs(p.x, p.y) > 0;
  const bad = traceFailed([p.t0, p.t1]);
  if (bad) return { outcome: 'excluded', overlapped: ov, apps: null, why: bad };
  const apps = applications(p.t0!, p.t1!, d);
  if (apps === null) return { outcome: 'excluded', overlapped: ov, apps, why: 'the trace could not be counted' };
  if (apps > 1) return { outcome: 'loss', overlapped: ov, apps, why: `the trace counts ${apps} applications of the write with key ${p.key}` };
  if (apps < 1) return { outcome: 'excluded', overlapped: ov, apps, why: 'neither call applied the write (spec: not counted toward rule 6)' };
  if (p.x.indeterminate || p.y.indeterminate) return { outcome: 'excluded', overlapped: ov, apps, why: 'a call of the pair timed out or lost its connection (spec 7.3, rule 5)' };
  if (ov) return { outcome: 'counted', overlapped: true, apps, why: 'applied once' };
  // Not overlapped: judged as step (a), with the call that ended first as the first call; only `violated` is kept.
  const [first, second] = p.x.t_end_ms <= p.y.t_end_ms ? [p.x, p.y] : [p.y, p.x];
  const firstApplied = d.kind === 'create' ? first.id !== null && first.id !== undefined && p.t1!.ids.some((id) => deepEqual(id, first.id)) : first.version !== null && first.version !== undefined && deepEqual(first.version, p.t1!.version);
  if (first.ok && firstApplied) {
    const r = repeatAfterOutcome('a pair that did not overlap', first, second, d, p.t1!, p.key);
    if (r.verdict === 'violated') return { outcome: 'violated', overlapped: false, apps, why: r.reason };
  }
  return { outcome: 'excluded', overlapped: false, apps, why: 'the two calls did not overlap (judged as step (a); it adds no violation)' };
}

/** Step (d): pairs with one fresh key each, sent at the same moment; not forced, so `violated`, `not observed` or `not tested`. */
export function judgeD(o: StepDObs, d: Decl): StepVerdict & { numbers: Record<string, unknown> } {
  if (o.skipped) return { ...V('not tested', `step (d) not run: ${o.skipped}`), numbers: {} };
  if (!d.countable) return { ...V('not tested', 'step (d): the write leaves no trace the tester can count (an update needs idempotency.version_steps: true and the resource\'s version field, Annex E)'), numbers: {} };
  const judged = o.pairs.map((p) => ({ p, j: judgePair(p, d) }));
  const run = o.pairs.filter((p) => p.x && p.y).length;
  const overlapped = judged.filter(({ j }) => j.overlapped && (j.outcome === 'counted' || j.outcome === 'loss')).length;
  const losses = judged.filter(({ j }) => j.outcome === 'loss' || j.outcome === 'violated');
  const excluded = judged.filter(({ j }) => j.outcome === 'excluded').length;
  const numbers = { pairs: run, pairs_overlapped: overlapped, pairs_applied_more_than_once: judged.filter(({ j }) => j.outcome === 'loss').length, pairs_excluded: excluded, pairs_limit: o.limit, stopped_at: o.stop };
  const how = o.stop === 'overlapped' ? `stopped at ${MIN_OVERLAPPED_PAIRS} overlapped pairs` : o.stop === 'limit' ? `stopped at the ${o.limit} pairs limits.pairs allows` : `stopped by an error${o.error ? ` (${o.error})` : ''}`;
  const notes = [`Simultaneous repeat: ${run} pair(s) sent, each with a fresh key and the same arguments on two connections at the same moment; ${overlapped} overlapped, ${excluded} excluded; ${how}.`];
  if (losses.length) {
    const first = losses[0]!;
    return { ...V('violated', `Simultaneous repeat: in ${losses.length} of ${run} pair(s) the write with one key was applied more than once (${first.j.why}).`, { notes: [...notes, VIOLATED_CAVEAT, 'The calls were deliberately made simultaneous; the result says nothing about how often this happens in normal use (spec 8.2, rule 9).'], steps: [first.p.x?.step, first.p.y?.step].filter((s): s is string => !!s) }), numbers };
  }
  if (overlapped >= MIN_OVERLAPPED_PAIRS) {
    const b = ruleOfThree(overlapped)!;
    return { ...V('not observed', `Simultaneous repeat: no write was applied more than once in ${overlapped} overlapped pair(s) of ${run}; a rate of about ${(b.approx * 100).toFixed(1)}% (3/${overlapped}) cannot be ruled out at 95% confidence. This does not show that the server is safe under concurrency.`, { notes }), numbers: { ...numbers, rule_of_three: b.approx } };
  }
  return { ...V('not tested', `Simultaneous repeat: too few overlapped pairs (${overlapped} of ${run} sent; ${MIN_OVERLAPPED_PAIRS} are needed for "not observed", spec 8.2 rule 6), and no write was applied more than once.`, { notes }), numbers };
}

// ---------------------------------------------------------------- proxy-assisted step, step (e), its crash form

export interface ProxyObs {
  skipped?: string;
  error?: string;
  routing: string;
  /** The request faulted: the last mutating request of the learning pass. */
  learned: { method: string; path: string; nth: number } | null;
  key: string;
  t0: TraceRead | null;
  a1: CallObs | null;
  hit: boolean;
  t1: TraceRead | null;
  a2: CallObs | null;
  t2: TraceRead | null;
  /** Mutating backend requests after the cut that undid the write (a delete of the created object). */
  undo: { method: string; path: string }[];
}

const silentBackendKey = (d: Decl): string => (d.backend_key === null ? 'The declaration is silent on whether the backend offers an idempotency key that answers a repeat with the first result, or a lookup of a write by its key (idempotency.backend_key, Annex E).' : 'The declaration says the backend offers no idempotency key or lookup by key that the tool could use (idempotency.backend_key: false).');

/** Might an error name the applied change by any reading (review of a6b111e: used only to withhold violated)? */
export function mayIdentifyApplied(c: CallObs, d: Decl, trace: TraceRead | null): boolean {
  if (c.ok) return false;
  if (d.kind === 'create') return (trace?.ids ?? []).some((id) => mayIdentify(c, String(id), id));
  const fields = Object.entries(d.update_fields).some(([p, v]) => mayIdentify(c, p, v));
  return fields || (!!d.version_path && trace !== null && trace.version !== null && trace.version !== undefined && mayIdentify(c, d.version_path, trace.version));
}

/** The repeat after a first call whose outcome the server did not receive (the proxy-assisted step; the crash form with `crash`). */
function repeatWithoutOutcome(step: string, a2: CallObs, d: Decl, trace: TraceRead, steps: string[], crash: boolean, key = ''): StepVerdict {
  const g = givesOutcome(null, a2, d, trace);
  if (g.gives === true) return V('held', `${step}: the write was applied once, and the repeat with the same key gave the outcome (${g.why})`, { steps });
  if (g.gives === null && a2.ok) return V('not tested', `${step}: the write was applied once and the repeat was a success, but ${g.why}`, { steps });
  const positive = !a2.ok && (saysUnknownDeclared(a2) || (fromDeclaration('not_applied') && says('not_applied', textOf(a2)) && !mayBeUnknown(textOf(a2)) && !mayIdentifyApplied(a2, d, trace)));
  if (g.gives === null && !a2.ok && d.backend_key === true && !positive) return V('not tested', `${step}: ${g.why}: ${quote(a2)}. Declare patterns.applied, or read it`, { steps, notes: [saidBy('applied', textOf(a2))] });
  // why: note 19, R4: in the crash form "a refusal that says nothing about the write itself ... gives not tested"; whether a
  // refusal that names nothing says nothing about the write is decided by a declared patterns.unavailable only (rule 11).
  if (crash && undecidedRefusal(a2, key, trace.ids ?? [], d.update_fields)) return undecidedV(step, a2, steps);
  if (saysNothingAboutWrite(a2) && (crash || d.backend_key === true)) return V('not tested', `${step}: the repeat was refused with an answer that says nothing about the write itself (${quote(a2)}), so the condition was not forced`, { notes: [saidBy('unavailable', textOf(a2))] });
  const unknown = !a2.ok && saysUnknownDeclared(a2);
  const said = unknown ? `said that the outcome is not known (${quote(a2)})` : `applied nothing and did not give the outcome (${quote(a2)})`;
  if (d.backend_key === true && undecidedRefusal(a2, key, trace.ids ?? [], d.update_fields)) return undecidedV(step, a2, steps);
  if (d.backend_key === true) return V('violated', `${step}: the write was applied once and the server did not receive the backend's answer; the repeat with the same key ${said}, while the declaration says the backend offers an idempotency key or a lookup by key that the tool could use, so the server could have established the outcome`, { steps, notes: unknown ? [unknownNote(a2)] : [] });
  return V('held', `${step}: held, with the note "${NOTE_OUTCOME}": the write was applied once; the server did not receive the backend's answer to the first call, and the repeat with the same key ${said}. What the answer says is judged by MWS-RES-1 and MWS-RES-2. ${silentBackendKey(d)}`, { steps, notes: [`Note: ${NOTE_OUTCOME}.`, ...(unknown ? [unknownNote(a2)] : []), ...(saysNothingAboutWrite(a2) ? [saidBy('unavailable', textOf(a2))] : [])] });
}

/** The proxy-assisted step: the backend commits the first write, its answer is cut, the server is not told; then A2 with K. */
export function judgeProxy(o: ProxyObs, d: Decl): StepVerdict {
  const routing = [...(o.routing ? [`Routing: ${o.routing}.`] : []), ...(o.learned ? [`Schedule: the ${o.learned.nth === 1 ? 'first' : `#${o.learned.nth}`} ${o.learned.method} ${o.learned.path} of the first call was let through to the backend and its answer cut (commit_then_reset); later requests passed unchanged.`] : [])];
  const add = (v: StepVerdict): StepVerdict => ({ ...v, notes: [...routing, ...v.notes] });
  if (o.skipped) return add(V('not tested', `Proxy-assisted step not run: ${o.skipped}`));
  if (!d.countable) return add(V('not tested', 'Proxy-assisted step: the write leaves no trace the tester can count (an update needs idempotency.version_steps: true and the resource\'s version field, Annex E)'));
  // why (review of note 8, 11): counted more than once is violated wherever a read shows it, before the step gives up.
  const early = (why: string): StepVerdict => {
    const n = o.undo.length ? null : countedTwice(o.t0, [o.t1, o.t2], d);
    return add(n ? V('violated', `Proxy-assisted step: the trace counts ${n} applications of the write with key ${o.key}, although ${why}`, { steps: [o.a1?.step, o.a2?.step].filter((s): s is string => !!s) }) : V('not tested', `Proxy-assisted step${why.startsWith('stopped') ? ' ' : ': '}${why}`));
  };
  if (o.error && !o.a2) return early(`stopped: ${o.error}`);
  if (!o.hit) return early('the fault was not applied (the first call sent other backend requests than in the learning pass)');
  const bad = traceFailed([o.t0, o.t1, o.t2]);
  if (bad) return early(bad);
  const t0 = o.t0!;
  const apps1 = applications(t0, o.t1!, d);
  const total = maxApps(t0, [o.t1, o.t2], d);
  const inEffect = applications(t0, o.t2!, d);
  if (apps1 === null || total === null || inEffect === null) return add(V('not tested', 'Proxy-assisted step: the trace could not be counted'));
  const steps = [o.a1?.step, o.a2?.step].filter((s): s is string => !!s);
  if (o.undo.length) {
    if (inEffect > 1) return add(V('violated', `Proxy-assisted step: after the cut the server undid a write (${o.undo.map((u) => `${u.method} ${u.path}`).join(', ')}), yet ${inEffect} applications of the write with key ${o.key} are in effect after the repeat`, { steps }));
    return add(V('not tested', `Proxy-assisted step: the server undid the first write after the cut (${o.undo.map((u) => `${u.method} ${u.path}`).join(', ')}, seen at the interposer), so the trial did not force the condition`));
  }
  if (total > 1) return add(V('violated', `Proxy-assisted step: the trace counts ${total} applications of the write with key ${o.key}${apps1 > 1 ? ', the second before the repeat was sent (the server\'s own retry of the first call)' : ''}`, { steps }));
  if (apps1 < 1) return add(V('not tested', 'Proxy-assisted step: the interposer let the first write through to the backend, but the trace counts no application after it, so the trial did not force the condition'));
  const a2 = o.a2;
  if (!a2 || a2.indeterminate) return add(V('not tested', `Proxy-assisted step: the repeat itself ${a2?.result_type ? `was answered with a ${a2.result_type} result` : 'timed out or lost its connection'} (spec 7.3, rule 5)`));
  // why: review of note 19 (3): a first answer the default reading would call outcome-giving decides nothing; one it does not is
  // the cut answer the step expects (the server could not have known the outcome), and the step goes on.
  if (o.a1 && gaveOutcome(o.a1, d, o.t1) === null && identifiesApplied(o.a1, d, o.t1)) return add(V('not tested', unreadFirst('Proxy-assisted step', o.a1, d, o.t1), { notes: [saidBy('applied', textOf(o.a1))] }));
  if (o.a1 && gaveOutcome(o.a1, d, o.t1)) return add(repeatAfterOutcome('Proxy-assisted step (the first answer gave the outcome, judged as step (a))', o.a1, a2, d, o.t1!, o.key));
  return add(repeatWithoutOutcome('Proxy-assisted step', a2, d, o.t1!, steps, false, o.key));
}

export interface RestartInfo {
  stop_requested: 'graceful' | 'kill';
  stop_used: 'graceful' | 'kill';
  ended_by: string;
  t_stop_ms: number;
  t_stopped_ms: number;
  t_ready_ms: number | null;
  started: boolean;
  reason: string | null;
}

export interface RestartObs {
  skipped?: string;
  error?: string;
  key: string;
  t0: TraceRead | null;
  a1: CallObs | null;
  t1: TraceRead | null;
  restart: RestartInfo | null;
  /** The trace after the restart, before the repeat. */
  tr: TraceRead | null;
  a2: CallObs | null;
  t2: TraceRead | null;
  /** After the settle interval (where the declaration states one). */
  t3: TraceRead | null;
  /** Time between the first answer (crash form: the commit) and the repeat. */
  gap_ms: number | null;
  settle_ms: number;
}

export interface CrashObs extends RestartObs {
  routing: string;
  learned: { method: string; path: string; nth: number } | null;
  hit: boolean;
  /** The server answered the first call before it was stopped: not a trial of the crash form. */
  answered_before_stop: boolean;
  /** Mutating backend requests after the commit that undid the write (a delete of a created object); absent in older evidence. */
  undo?: { method: string; path: string }[];
}

const restartFacts = (o: RestartObs): string[] => (o.restart ? [`Restart: the tester stopped the server (${o.restart.stop_requested} stop asked; ${o.restart.stop_used === 'kill' ? (o.restart.stop_requested === 'graceful' ? 'it did not exit by itself and was killed, which counts as a kill' : 'killed') : 'it exited'}; ended by ${o.restart.ended_by}) and started it again with the same environment${o.restart.t_ready_ms !== null ? `, ready ${Math.round(o.restart.t_ready_ms - o.restart.t_stopped_ms)} ms after the stop` : ''}.`, ...(o.gap_ms !== null ? [`Time between the first ${'routing' in o ? 'commit' : 'answer'} and the repeat: ${Math.round(o.gap_ms)} ms.`] : [])] : []);

/** The checks shared by step (e) and its crash form before the counting rule: the stated key lifetime, then a backend that lost state. */
function restartPreamble(step: string, o: RestartObs, d: Decl, applied: TraceRead | null): StepVerdict | null {
  if (d.key_lifetime && o.gap_ms !== null && d.key_lifetime.ms < o.gap_ms) return V('not tested', `${step}: the tool's description states that a key is remembered for ${d.key_lifetime.ms} ms (${JSON.stringify(d.key_lifetime.quote)}), less than the ${Math.round(o.gap_ms)} ms measured between the first ${'routing' in o ? 'commit' : 'answer'} and the repeat; how long a key is remembered is not tested (Known limitations)`);
  if (applied && o.t0) {
    const t0 = o.t0;
    const a = applications(t0, applied, d);
    const after = [o.tr, o.t2, o.t3].filter((t): t is TraceRead => !!t && t !== applied);
    for (const t of after) {
      const x = applications(t0, t, d);
      if (a !== null && a >= 1 && x !== null && x < a) return V('not tested', `${step}: the first call applied the write, but the trace read at ${t.step} no longer counts that application: the backend lost state in the restart, so the trial did not force the condition`);
    }
  }
  return null;
}

/** Step (e): A1 with K, answered; the tester stops and starts the server; A2 with K as soon as tools/list answers. */
export function judgeRestart(o: RestartObs, d: Decl): StepVerdict {
  const add = (v: StepVerdict): StepVerdict => ({ ...v, notes: ['Method: black-box (launch).', ...restartFacts(o), ...v.notes] });
  if (o.skipped) return add(V('not tested', `Restart step (e) not run: ${o.skipped}`));
  if (!d.countable) return add(V('not tested', 'Restart step (e): the write leaves no trace the tester can count (an update needs idempotency.version_steps: true and the resource\'s version field, Annex E)'));
  // why (review of note 8, 11): in step (e) counted more than once is applied before any other rule, wherever a read shows it.
  const early = (why: string): StepVerdict => {
    // why (re-review 8): the spec's order holds here too: the stated lifetime, then lost state, then counted twice.
    const pre = restartPreamble('Restart step (e)', o, d, o.t1?.ok ? o.t1 : null);
    if (pre) return add(pre);
    const n = countedTwice(o.t0, [o.t1, o.tr, o.t2, o.t3], d);
    return add(n ? V('violated', `Restart step (e): the trace counts ${n} applications of the write with key ${o.key}, although ${why}`, { steps: [o.a1?.step, o.a2?.step].filter((s): s is string => !!s) }) : V('not tested', `Restart step (e)${why.startsWith('stopped') ? ' ' : ': '}${why}`));
  };
  if (o.restart && !o.restart.started) return early(`the server ${o.restart.reason ?? 'did not start again'}`);
  if (o.error && !o.a2) return early(`stopped: ${o.error}`);
  const bad = traceFailed([o.t0, o.t1, o.tr, o.t2, ...(o.t3 ? [o.t3] : [])]);
  if (bad) return early(bad);
  const pre = restartPreamble('Restart step (e)', o, d, o.t1);
  if (pre) return add(pre);
  const t0 = o.t0!;
  const apps1 = applications(t0, o.t1!, d);
  const total = maxApps(t0, [o.t1, o.tr, o.t2, o.t3], d);
  if (apps1 === null || total === null) return add(V('not tested', 'Restart step (e): the trace could not be counted'));
  const steps = [o.a1?.step, o.a2?.step].filter((s): s is string => !!s);
  if (total > 1) return add(V('violated', `Restart step (e): the trace counts ${total} applications of the write with key ${o.key}: after the restart the repeat applied it again`, { steps }));
  const a1 = o.a1!;
  const gave = a1.indeterminate || apps1 < 1 ? false : gaveOutcome(a1, d, o.t1);
  if (gave === null) return add(V('not tested', unreadFirst('Restart step (e)', a1, d, o.t1), { notes: [saidBy('applied', textOf(a1))] }));
  if (!gave) return add(V('not tested', `Restart step (e): the first call ${a1.indeterminate ? 'has no answer with an outcome (spec 7.3, rule 5)' : apps1 < 1 ? 'did not apply the write' : `applied the write but was answered neither with a success nor with an error that identifies the applied change (${quote(a1)})`}, and the write was applied at most once, so the condition was not forced`));
  const a2 = o.a2;
  if (!a2 || a2.indeterminate) return add(V('not tested', `Restart step (e): the repeat ${a2?.result_type ? `was answered with a ${a2.result_type} result` : 'timed out or lost its connection'} (spec 7.3, rule 5)`));
  const g = givesOutcome(a1, a2, d, o.t1);
  if (g.gives === true) return add(V('held', `Restart step (e): the write was applied once, and after the restart the repeat with the same key gave the first call's outcome (${g.why})`, { steps }));
  if (saysNothingAboutWrite(a2)) return add(V('not tested', `Restart step (e): the repeat was refused with an answer that says nothing about the write itself (${quote(a2)}), so the condition was not forced`, { notes: [saidBy('unavailable', textOf(a2))] }));
  const kind = o.restart?.stop_used ?? 'graceful';
  // why: note 19 (rule 11): an error that may give the outcome, read only by a default, decides nothing where the verdict turns on it.
  if (g.gives === null && !a2.ok && (d.key_record_survives?.[kind] === true || d.backend_key === true)) return add(V('not tested', `Restart step (e): ${g.why}: ${quote(a2)}. Declare patterns.applied, or read it`, { steps, notes: [saidBy('applied', textOf(a2))] }));
  const survives = d.key_record_survives ? d.key_record_survives[kind] : null;
  const said = `the repeat applied nothing and ${!a2.ok && saysUnknownDeclared(a2) ? 'said that the outcome is not known' : a2.ok ? `answered ${g.why}` : 'did not give the outcome'} (${quote(a2)})`;
  if ((survives === true || d.backend_key === true) && undecidedRefusal(a2, o.key, [...(o.t1!.ids ?? []), a1.id], d.update_fields)) return add(undecidedV('Restart step (e)', a2, steps));
  if (survives === true) return add(V('violated', `Restart step (e): the write was applied once; after a ${kind === 'kill' ? 'kill' : 'graceful stop'} ${said}, while the declaration says the tool's key record survives a restart after a ${kind === 'kill' ? 'kill' : 'graceful stop'}, so the server could have established the outcome`, { steps }));
  if (d.backend_key === true) return add(V('violated', `Restart step (e): the write was applied once; after the restart ${said}, while the declaration says the backend offers an idempotency key or a lookup by key that the tool could use, so the server could have established the outcome`, { steps }));
  const silent = survives === null ? `The declaration is silent on whether the tool's key record survives a restart after a ${kind === 'kill' ? 'kill' : 'graceful stop'} (idempotency.key_record_survives.${kind}, Annex E).` : `The declaration says the tool's key record does not survive a restart after a ${kind === 'kill' ? 'kill' : 'graceful stop'}.`;
  return add(V('held', `Restart step (e): held, with the note "${NOTE_KEY_RECORD}": the write was applied once; after the restart ${said}. What the answer says is judged by MWS-RES-1 and MWS-RES-2. ${silent}`, { steps, notes: [`Note: ${NOTE_KEY_RECORD}.`, silent, ...(!a2.ok && saysUnknownDeclared(a2) ? [unknownNote(a2)] : [])] }));
}

/** The crash form of step (e): the backend commits A1, its answer is held at the interposer, the server is stopped before it answers and started again; then A2 with K. */
export function judgeCrash(o: CrashObs, d: Decl): StepVerdict {
  const routing = [`Method: proxy-assisted (launch).${o.routing ? ` Routing: ${o.routing}.` : ''}`, ...(o.learned ? [`Schedule: the ${o.learned.nth === 1 ? 'first' : `#${o.learned.nth}`} ${o.learned.method} ${o.learned.path} of the first call was let through to the backend and its answer held (commit_then_hang); the server was stopped while it was held, started again with the interposer in place, and later requests passed unchanged.`] : [])];
  const add = (v: StepVerdict): StepVerdict => ({ ...v, notes: [...routing, ...restartFacts(o), ...v.notes] });
  if (o.skipped) return add(V('not tested', `Crash form of step (e) not run: ${o.skipped}`));
  if (!d.countable) return add(V('not tested', 'Crash form of step (e): the write leaves no trace the tester can count (an update needs idempotency.version_steps: true and the resource\'s version field, Annex E)'));
  if (o.answered_before_stop) return add(V('not tested', 'Crash form of step (e): the server answered the first call before it was stopped, so that trial is not a trial of the crash form, and no trial was completed'));
  if (!o.hit) return add(V('not tested', 'Crash form of step (e): the fault was not applied (the first call sent other backend requests than in the learning pass), so no trial was completed'));
  const undo = o.undo ?? [];
  const undone = undo.map((u) => `${u.method} ${u.path}`).join(', ');
  // why (review of note 8, 11): counted more than once is applied before any other rule, wherever a read shows it.
  const early = (why: string): StepVerdict => {
    // why (re-review 8): the stated lifetime, then lost state, then counted twice.
    const pre = restartPreamble('Crash form of step (e)', o, d, o.tr?.ok ? o.tr : null);
    if (pre) return add(pre);
    const n = undo.length ? null : countedTwice(o.t0, [o.tr, o.t2, o.t3], d);
    return add(n ? V('violated', `Crash form of step (e): the trace counts ${n} applications of the write with key ${o.key}, although ${why}`, { steps: [o.a1?.step, o.a2?.step].filter((s): s is string => !!s) }) : V('not tested', `Crash form of step (e)${why.startsWith('stopped') ? ' ' : ': '}${why}`));
  };
  if (o.restart && !o.restart.started) return early(`the server ${o.restart.reason ?? 'did not start again'}`);
  if (o.error && !o.a2) return early(`stopped: ${o.error}`);
  const bad = traceFailed([o.t0, o.tr, o.t2, ...(o.t3 ? [o.t3] : [])]);
  if (bad) return early(bad);
  const pre = restartPreamble('Crash form of step (e)', o, d, o.tr);
  if (pre) return add(pre);
  const t0 = o.t0!;
  const appsR = applications(t0, o.tr!, d);
  const total = maxApps(t0, [o.tr, o.t2, o.t3], d);
  const inEffect = applications(t0, o.t3 ?? o.t2!, d);
  if (appsR === null || total === null || inEffect === null) return add(V('not tested', 'Crash form of step (e): the trace could not be counted'));
  const steps = [o.a1?.step, o.a2?.step].filter((s): s is string => !!s);
  // why (review of note 8, 7): as in the proxy-assisted step, a write the server undid (seen at the interposer) did not force
  // the condition, unless more than one application is in effect after the repeat.
  if (undo.length) {
    if (inEffect > 1) return add(V('violated', `Crash form of step (e): after the restart the server undid a write (${undone}), yet ${inEffect} applications of the write with key ${o.key} are in effect after the repeat`, { steps }));
    return add(V('not tested', `Crash form of step (e): the server undid the first write after the restart (${undone}, seen at the interposer), so the trial did not force the condition`));
  }
  if (total > 1) return add(V('violated', `Crash form of step (e): the trace counts ${total} applications of the write with key ${o.key}`, { steps }));
  if (appsR < 1) return add(V('not tested', 'Crash form of step (e): the interposer let the first write through to the backend, but the trace read after the restart counts no application, so the trial did not force the condition'));
  const a2 = o.a2;
  if (!a2 || a2.indeterminate) return add(V('not tested', `Crash form of step (e): the repeat itself ${a2?.result_type ? `was answered with a ${a2.result_type} result` : 'timed out or lost its connection'} (spec 7.3, rule 5)`));
  return add(repeatWithoutOutcome('Crash form of step (e)', a2, d, o.tr!, steps, true, o.key));
}

/**
 * The MWS-RES-2 cross-record (steps (e) and its crash form only): the trace shows the first call applied the write and
 * it is still in effect when the repeat is answered, and the repeat says the earlier call with key K failed or did not
 * apply the write. An answer that only says nothing was applied, or that the key is not known, is not such a trial; nor
 * is one that identifies the write that remains applied, or says that it is not known whether it was applied (the
 * second clause then holds). Rule 11: the cross-record is `violated` only where the declaration's earlier_failed pattern
 * decided what the answer says; where only the default matched, there is no cross-record and the step's record carries a
 * note quoting the text (review of note 8, 3).
 */
function cross(o: RestartObs, form: 'restart' | 'crash', d: Decl): { v: StepVerdict | null; note: string | null } {
  const none = { v: null, note: null };
  if (o.skipped || !o.a2 || o.a2.indeterminate || !o.t0 || !o.t2) return none;
  if ('answered_before_stop' in o && ((o as CrashObs).answered_before_stop || !(o as CrashObs).hit)) return none;
  const applied = form === 'restart' ? o.t1 : o.tr;
  if (!applied) return none;
  const a = applications(o.t0, applied, d);
  const inEffect = applications(o.t0, o.t2, d);
  if (a === null || a < 1 || inEffect === null || inEffect < 1) return none;
  const text = textOf(o.a2);
  // why: B-9 v2 (a repeat with a key): outcome describes the write the key identifies, so not_applied on the repeat states that
  // the earlier call did not apply it, judged under MWS-RES-2 (this replaces patterns.earlier_failed where the shape is read).
  // key_not_known (unknown) is not such a statement. The text is read on its own as well (rule 11, R14-5).
  const sh = shapeOf(o.a2);
  if (sh?.outcome === 'not_applied') {
    const step = form === 'restart' ? 'MWS-RETRY-2 step (e) (restart; black-box, launch)' : 'the crash form of MWS-RETRY-2 step (e) (restart during the first call; proxy-assisted, launch)';
    return { v: V('violated', `A trial made with launch, in ${step}: the trace shows that the first call with key ${o.key} applied the write and that it is still in effect, yet the repeat's adopted result shape says the keyed write was not applied (${quoteField('outcome', 'not_applied')}${sh.code ? `, ${quoteField('code', sh.code)}` : ''}); on a call with a key the outcome describes the write the key identifies (second clause).`, { steps: [o.a1?.step, o.a2.step].filter((s): s is string => !!s), notes: [decidedByShape([['outcome', 'not_applied'], ['code', sh.code], ['replayed', sh.replayed]], o.a2), 'This trial is judged only as MWS-RETRY-2 step (e) states; MWS-RES-2\'s own procedure was not run here.'] }), note: null };
  }
  if (!says('earlier_failed', text)) return none;
  // why: an answer that identifies the applied write, or says it is not known whether it was applied, meets the second clause.
  // why: review of note 19 (6): only declared patterns decide; a violation needs applied and outcome_unknown declared, neither matching.
  // why: rule 11 (R14-5): the text is read on its own; a shape that says unknown or applied does not repair a text that says the earlier call failed.
  const declA = fromDeclaration('applied');
  const declU = fromDeclaration('outcome_unknown');
  if ((declA && identifiesAppliedText(o.a2, d, o.t2)) || (declU && saysUnknownText(o.a2))) return none;
  const step = form === 'restart' ? 'MWS-RETRY-2 step (e) (restart; black-box, launch)' : 'the crash form of MWS-RETRY-2 step (e) (restart during the first call; proxy-assisted, launch)';
  // why: validator re-run on f573a24 (r5-pending-failed-declared): the declared earlier_failed pattern is itself a positive match
  // of a violation; it decides unless the answer may identify the write by any reading or may say the outcome is unknown.
  if (fromDeclaration('earlier_failed') && !mayIdentifyApplied({ ...o.a2, ok: false }, d, o.t2) && !mayBeUnknown(text)) return { v: V('violated', `A trial made with launch, in ${step}: the trace shows that the first call with key ${o.key} applied the write and that it is still in effect, yet the answer to the repeat says, by the declared patterns.earlier_failed, that the earlier call failed or did not apply it (${JSON.stringify(short(o.a2.text ?? o.a2.rpc_error?.message ?? '', 160))}); it neither identifies the write that remains applied nor says that the outcome is not known (MWS-RES-2, second clause).`, { steps: [o.a2.step].filter(Boolean) as string[], notes: [saidBy('earlier_failed', text)] }), note: null };
  if (fromDeclaration('earlier_failed')) return { v: null, note: `MWS-RES-2 (a trial in ${step}): the write is still in effect and the answer to the repeat (${quote(o.a2)}) says, by the declared patterns.earlier_failed, that the earlier call failed; whether it also identifies the write or says the outcome is not known is decided by patterns.applied and patterns.outcome_unknown, which the declaration does not both give, so no MWS-RES-2 record was made (spec 7.3, rule 11). ${saidBy('earlier_failed', text)}` };
  if (!fromDeclaration('earlier_failed')) return { v: null, note: `MWS-RES-2 (a trial in ${step}): the write is still in effect, and the answer to the repeat (${quote(o.a2)}) matches only the tester's default pattern for earlier failed, which alone does not decide a violation (spec 7.3, rule 11), so no MWS-RES-2 record was made; declare patterns.earlier_failed, or read it. ${saidBy('earlier_failed', text)}` };
  return { v: V('violated', `A trial made with launch, in ${step}: the trace shows that the first call with key ${o.key} applied the write and that it is still in effect, yet the answer to the repeat says that the earlier call failed or did not apply it (${JSON.stringify(short(o.a2.text ?? o.a2.rpc_error?.message ?? '', 160))}); the answer neither identifies the write that remains applied nor says that it is not known whether it was applied (second clause).`, { steps: [o.a1?.step, o.a2.step].filter((s): s is string => !!s), notes: [saidBy('earlier_failed', text), 'This trial is judged only as MWS-RETRY-2 step (e) states; MWS-RES-2\'s own procedure was not run here.'] }), note: null };
}

/** The MWS-RES-2 cross-record, or null. */
export const res2Cross = (o: RestartObs, form: 'restart' | 'crash', d: Decl): StepVerdict | null => cross(o, form, d).v;
/** The note for the step's record where only the default earlier_failed pattern matched (no cross-record), or null. */
export const res2CrossNote = (o: RestartObs, form: 'restart' | 'crash', d: Decl): string | null => cross(o, form, d).note;
