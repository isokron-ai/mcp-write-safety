/**
 * What a result says (spec 7.3, rule 11): where a procedure asks what a result says, the tester decides it by
 * patterns stated in the declaration or by a person's reading, and the record quotes the text relied on and
 * says which of the two decided it. The declaration's `patterns` block gives the patterns; for a kind it does
 * not give, the default below is used, and it is printed with the declaration in the results (MANIFEST.md
 * lists them), so the patterns that decided a record are always part of the declaration shown.
 */

import type { Manifest, OutcomeField } from '../core/manifest.js';
import { getPath, parsePath } from '../core/util.js';

export type SaysKind = 'applied_all' | 'not_applied' | 'write_failed' | 'repeat_invited' | 'not_used' | 'outcome_unknown' | 'in_progress' | 'replay' | 'accepted' | 'repeat_refused' | 'unavailable' | 'earlier_failed' | 'applied' | 'no_tools' | 'retry_invited' | 'read_named' | 'version_required' | 'refused_value' | 'conflict';

/** The default patterns (case-insensitive), used where the declaration's `patterns` block gives none for a kind. */
export const DEFAULT_PATTERNS: Record<SaysKind, string> = {
  // The whole write took effect, with every item or step applied (MWS-ATOM-1, spec R15-3). Declared only: the default matches
  // nothing, and where the declaration gives none MWS-ATOM-1 does not ask what the content says about the whole write.
  applied_all: String.raw`(?!)`,
  // The write failed, or nothing was changed (MWS-RES-2: a result whose content says the write failed).
  not_applied: String.raw`\b(fail(ed|ure|s)?|could not|couldn't|cannot|unable to|did not (succeed|complete|apply|take effect)|(was|were|is|has|have) not (been )?(applied|written|saved|stored|updated|created|deleted|changed|made)|not applied|nothing (was |has been |is )?(written|changed|applied|saved|updated|deleted)|no changes? (was |were )?(made|written|applied)|rolled back|reverted)\b`,
  // An error that says the write failed or was not applied, read only in the lost-answer trial of MWS-RES-2, where the outcome
  // is open (kind stated-failure). Its own kind, so that a pattern declared for it is not also read in a success (not_applied).
  // Where the declaration gives none, the lost-answer trial reads a declared not_applied as before.
  write_failed: String.raw`\b(fail(ed|ure)|could not (apply|save|write|update|create|delete)|(was|were|has|have) not (been )?(applied|written|saved|stored|updated|created|deleted|changed|made)|not applied|nothing (was |has been )?(written|changed|applied|saved|updated|deleted)|no changes? (was |were )?(made|written|applied)|rolled back)\b`,
  // An error that invites the caller to send the call again without a read first and without the key or the version the call
  // carried, read only in the lost-answer trial of MWS-RES-2 (kind retry-invited). A declared pattern of this kind is the
  // declarer's statement that what it matches is such an invitation; retry_invited (below) is read with the tester's checks
  // for a named read, key or version.
  repeat_invited: String.raw`\b((please|you can|you may|just|simply) (retry|try again|resend|re-send|repeat (it|the (call|request))|send (it|the (call|request)) again)|(retry|try again|resend|re-send) (the (call|request|write) )?(now|later|shortly|in a moment))\b`,
  // An argument named in the answer and said not to be used (MWS-IN-2).
  not_used: String.raw`\b(not used|unused|ignored|had no effect|(was|were) not applied|dropped|not recogni[sz]ed and (was |were )?(ignored|not used))\b`,
  // The outcome is said to be unknown (MWS-RES-2, MWS-RETRY-2): about whether the write was applied, not any check that could not be made.
  outcome_unknown: String.raw`\b(not known whether|unknown whether|not sure whether|uncertain whether|(outcome|result|state|status of the (write|change|update)) (is|was|remains) (unknown|not known|uncertain)|may (or may not )?have (been (applied|written|saved|made)|succeeded|gone through)|might have (been (applied|written)|succeeded)|((could|can) ?not|couldn't|can't|unable to) (confirm|determine|tell|verify|know)( \S+){0,4}? (whether|if|that)|((could|can) ?not|couldn't|can't|unable to) (confirm|determine|tell|verify)( (the|this|that|your|its))? (write|update|change|request|operation|call|save|deletion|creation|it)(?=\s*([.;,:!)]|$)| (was|were|had|has|have|went|took|succeeded|completed|applied|is|got)\b))\b`,
  in_progress: String.raw`\b(still in progress|already in progress|in flight|being processed)\b`,
  // why: a negated form ("not a replay", "replayed: false") says the opposite (review of note 8, 9).
  replay: String.raw`(?<!(\bnot|\bnever|\bno|n't)\s+((a|an|been|being)\s+)?)\b(replay(ed)?|already (applied|processed|done)|duplicate request|same (request|key) as before)\b(?!["']?\s*[:=]\s*["']?(false|no|0)\b)`,
  // An operation said to be accepted or pending (NF-19).
  accepted: String.raw`\b(accepted|pending|queued|scheduled|enqueued|will be (applied|processed|completed))\b`,
  // A refusal because the call repeats an earlier call or key (MWS-RETRY-2 step (b): violated for a new key).
  repeat_refused: String.raw`\b(duplicate (request|call|submission)|(request|call|key|idempotency[ _-]?key) (was |has )?already (been )?(used|seen|received|submitted|processed)|repeats? an? (earlier|previous) (request|call)|already (submitted|received))\b`,
  // A refusal that says nothing about the write itself: a rate limit, an unavailable backend, try again later, a 5xx or 429 (MWS-RETRY-2).
  unavailable: String.raw`\b(rate[- ]?limit(ed|s)?|too many requests|try again later|retry later|temporarily unavailable|(service|backend|server) (is )?(currently )?(unavailable|down|overloaded)|unavailable|could not be reached|could not reach|could not connect|connection (refused|failed)|overloaded|throttl(ed|ing)|bad gateway|gateway time-?out|service unavailable|timed out|upstream|(http |status )?(429|502|503|504))\b`,
  // A change reported as made or still in effect, in a clause that names the field, its new value or the object (MWS-RES-2
  // second clause, MWS-RETRY-2 step (a), MWS-ATOM-1). The default is a summary of the tester's built-in reading (a verb that
  // reports a change, outside a negated or failed clause); alone it decides nothing (rule 11).
  applied: String.raw`\b(applied|written|saved|stored|created|added|updated|took effect|succeeded|was (set|changed)|remains? (applied|in effect)|kept)\b`,
  // An error from tools/list given because no tool is enabled (MWS-CFG-4, R7-6): not a refusal of the list.
  no_tools: String.raw`\bno tools?\b.*\b(enabled|available|offered|left|registered)\b|\bnothing (is )?enabled\b`,
  // An invitation to repeat the same write (MWS-RES-2, R9-1: retry-invited): an instruction, a suggestion or a permission.
  retry_invited: String.raw`\b(try (it )?again|please retry|you (can|may) retry|retry (the|this|your) (call|request|write|update)|re-?send (the|this) (call|request)|send (it|the request) again|repeat the (call|request))\b`,
  // A read named for the caller to make first, before a repeat (MWS-RES-2, R9-1); the read tool's name decides without it.
  read_named: String.raw`\b(read|get|fetch|check|look up|list)\b[^.]{0,60}\b(first|before (you )?(retry|repeat|try)(ing)?)\b`,
  // A refusal of a write sent without a version because a version or an explicit override is needed (MWS-CONC-2, version left out).
  version_required: String.raw`conflict|changed since|version (is )?(required|missing|needed)|(requires?|needs?|must (pass|send|give)) (an? |the )?(expected[ _])?version`,
  // An error that refuses the probed value itself (MWS-IN-1 to IN-4, R10-3), where it does not name the argument.
  refused_value: String.raw`\b(invalid|validation|must (be|match|have|contain|not)|(is|are) required|too (long|short|large|small|many|few)|exceeds?|not allowed|expected (a|an|one of)|out of range|does not match|not (a )?valid)\b`,
  // A write answered without an error that says it was refused because of a concurrency control (MWS-CONC-2 row 1, CONC-4:
  // a refused conflict returned as an ordinary result); read only where no structured signal shows it (spec Annex E).
  conflict: String.raw`conflict|changed since|nothing was (written|changed|applied|deleted)|not (written|applied|deleted)`,
  // The answer says the earlier call with this key failed or did not apply the write (MWS-RETRY-2 step (e): a trial of MWS-RES-2).
  earlier_failed: String.raw`\b(earlier|previous|prior|first|original) (call|request|attempt|write)( with (this|the same) (idempotency[ _-]?)?key)? (failed|did not (succeed|apply|go through|complete|take effect)|(was|has) not (been )?(applied|written|completed|made)|was rolled back|had no effect)\b`,
};

let current: Partial<Record<SaysKind, string>> = {};
let field: OutcomeField | null = null;

/** Set the declaration's patterns (and outcome field) for the evaluation that follows (run and recheck call this before evaluating). */
export function usePatterns(m: (Pick<Manifest, 'patterns'> & { outcome_field?: OutcomeField | null }) | null | undefined): void {
  current = { ...(m?.patterns ?? {}) };
  field = m?.outcome_field ?? null;
}

export type FieldOutcome = { outcome: 'applied' | 'not_applied' | 'unknown'; line: string };

/**
 * The declared outcome field (rule-11 coverage package): where the declaration names one and the result's structured content
 * carries one of its values at the path, the outcome it states, with the record's line; else null (nothing decided).
 */
export function outcomeByField(b: { data?: unknown; extracted?: { refusals: boolean } | null }): FieldOutcome | null {
  if (!field || b.data === null || b.data === undefined) return null;
  // why: review of PR #14 (5): a document decode.extract took out of the text states no outcome unless declared (refusals: true).
  if (b.extracted && !b.extracted.refusals) return null;
  let v: unknown;
  try {
    v = getPath(b.data, parsePath(field.path));
  } catch {
    return null;
  }
  if (v === undefined || (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean')) return null;
  const f = field;
  const outcome = f.applied.includes(v) ? 'applied' : f.not_applied.includes(v) ? 'not_applied' : f.unknown.includes(v) ? 'unknown' : null;
  if (!outcome) return null;
  return { outcome, line: `What the result says about the write's outcome was decided by the declared outcome field outcome_field.path ${JSON.stringify(f.path)} = ${JSON.stringify(v)} (${outcome.replace('_', ' ')}), in the result's structured content (rule-11 coverage package).` };
}

export const patternOf = (k: SaysKind): string => current[k] ?? DEFAULT_PATTERNS[k];
export const fromDeclaration = (k: SaysKind): boolean => current[k] !== undefined;

/**
 * Echoed data (gate-2 safety re-run on 0295ed6, F3): a JSON object or list inside the text, such as the request echoed back,
 * is not something the result says. Removed (innermost first) before a pattern is read.
 */
export function withoutEcho(text: string): string {
  let t = text;
  for (let i = 0; i < 8; i++) {
    const n = t.replace(/\{[^{}]*"[^{}]*\}|\[[^[\]]*"[^[\]]*\]/g, ' ');
    if (n === t) break;
    t = n;
  }
  // why: an answer that is all JSON (a structured answer, or its text and data together) is what the result says, not an echo
  // inside prose; it is read whole.
  return /[A-Za-z]{2,}/.test(t) ? t : text;
}

const CLAUSE_END = /[.;!?\n]|,\s|:\s/;
const NEGATION = /\b(not|never|no|without|neither|nor)\b|n['’]t\b/i;

/**
 * Does a text match the pattern for a kind? F3: a match counts only outside echoed data, and only where the words before it in
 * the same clause carry no negation ("was not ignored" is not "ignored"); a pattern that itself says "not" is read whole.
 */
export function says(k: SaysKind, text: string): boolean {
  let rx: RegExp;
  try {
    rx = new RegExp(patternOf(k), 'gi');
  } catch {
    return false;
  }
  const t = withoutEcho(text);
  for (const m of t.matchAll(rx)) {
    const before = t.slice(0, m.index ?? 0);
    const clause = before.split(CLAUSE_END).pop() ?? '';
    const lead = clause.trim().split(/\s+/).slice(-3).join(' ');
    if (!NEGATION.test(lead)) return true;
    if (m[0] === '') break;
  }
  return false;
}

/** The rule-11 line for a record: the text relied on, quoted, and which patterns decided it. */
export function saidBy(k: SaysKind, text: string, max = 200): string {
  const q = text.length > max ? `${text.slice(0, max)}…` : text;
  return `What the result says (${k.replace('_', ' ')}) was decided by ${fromDeclaration(k) ? `the declaration's pattern patterns.${k}` : `the default pattern for ${k} (the declaration gives none; MANIFEST.md lists it)`}, on the text ${JSON.stringify(q)} (spec 7.3, rule 11).`;
}

/** The patterns in effect, for the results header (the declaration as used). */
export function patternsInEffect(): Record<SaysKind, { pattern: string; from: 'declaration' | 'default' }> {
  const out = {} as Record<SaysKind, { pattern: string; from: 'declaration' | 'default' }>;
  for (const k of Object.keys(DEFAULT_PATTERNS) as SaysKind[]) out[k] = { pattern: patternOf(k), from: fromDeclaration(k) ? 'declaration' : 'default' };
  return out;
}
