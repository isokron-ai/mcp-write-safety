/**
 * MWS-IN-5, the differential reading (lane F7): from the calls of the search alone, which refusals rest on a fixed constraint
 * on the value of one argument. Pure: no server, no clock, so `recheck` gives the same answer from the same evidence.
 *
 * The reading decides from outcomes (accepted or refused), never from what a refusal's text says (spec 7.3, rule 11). A
 * refusal counts as a fixed single-argument constraint only where all of these hold:
 *
 *   (a) neighbour   a neighbouring value of the same argument was accepted in the same context: on an order (a string's
 *                   length, a number, an array's item count), a value on the other side of the refusal; for a character class,
 *                   a plain value of the same length;
 *   (b) repeat      the refusal repeats in a fresh context: on a fresh scratch object of the tester's (or a fresh create), with
 *                   another argument varied where the tool has one the tester may vary;
 *   (c) boundary    on an order, every accepted value lies on one side and every refused value on the other (monotonic), and the
 *                   boundary between them is found by bisection (exact where the last accepted and the first refused value are
 *                   neighbours, otherwise a range).
 *
 * Excluded before the reading (never a fixed constraint): an unknown outcome (a timeout, a broken connection, a task), a
 * JSON-RPC error the MCP specification defines for the case, and a refusal whose text names a rate limit, the state of the
 * backend (not found, exists, conflict, version, in progress, not empty) or the caller's identity (permission, forbidden).
 * These text patterns can only take a refusal out of the reading; they never make one count.
 *
 * Each refusal is also classified as EmRest does (error-message analysis): whether it names the argument, what kind of rule it
 * gives (length, range, format, characters, count) and whether it states the bound the search found. The class is recorded
 * as an observation; it never decides.
 */

import { short } from '../core/util.js';
import { mcpDefinedError } from './types.js';
import type { Dim } from './in5gen.js';

export type Phase = 'search' | 'bisect' | 'repeat' | 'declared';

export interface In5Call {
  arg: string;
  cls: string;
  /** The value, shortened for the record (a long string as `x…` with its length). */
  value: string;
  dim?: Dim;
  n?: number;
  plain_len?: number;
  phase: Phase;
  /** `A`: the search context (one scratch object, or the base call); `B`: the fresh context of the repeat. */
  context: 'A' | 'B';
  /** For a repeat: the other arguments varied, and the fresh object, where there is one. */
  varied?: string[];
  ok: boolean;
  isError: boolean;
  rpc_error: { code: number; message: string } | null;
  text: string | null;
  step: string;
  indeterminate?: boolean;
  /** A value the declaration lists (try_values): whether a success left it stored (false counts as refused; spec R10-8). */
  stored?: boolean | null;
}

export interface FixedDecl {
  arg: string;
  pattern: string;
  reason: string;
}

export interface Constraint {
  arg: string;
  /** maxLength, minLength, maximum, minimum, maxItems, minItems; `pattern` for a character class; `declared` by the declaration. */
  keyword: 'maxLength' | 'minLength' | 'maximum' | 'minimum' | 'maxItems' | 'minItems' | 'pattern' | 'declared';
  /** The boundary found (the last value accepted), for an order; null for a character class. */
  bound: number | null;
  /** Exact where the last accepted and the first refused value are neighbours; otherwise the range [accepted, refused). */
  exact: boolean;
  accepted_at: number | null;
  refused_at: number | null;
  /** The character class refused, for `pattern`. */
  cls?: string;
  reading_by: 'tester (differential probe)' | 'declaration';
  /** The declaration's reason, for `declared`. */
  reason?: string;
  steps: string[];
  text: string;
  refusal: RefusalClass;
}

export interface RefusalClass {
  names_arg: boolean;
  kind: 'length' | 'range' | 'count' | 'format' | 'characters' | 'required' | 'type' | 'unstated';
  states_bound: boolean | null;
  /** A server failure (a 5xx status or a runtime internal) rather than a validation answer; recorded, not excluded. */
  server_failure: boolean;
}

export interface Reading {
  confirmed: Constraint[];
  /** Refusals the reading did not count, each with why (quoted in full in the record: "seen, not judged"). */
  seen: { call: In5Call; why: string }[];
  excluded: { call: In5Call; why: string }[];
}

const RATE = /\b429\b|rate[ -]?limit|too many requests|throttl|quota exceeded|slow down/i;
const STATE = /not[ _-]?found|no such|does not exist|doesn't exist|already exists|\bexists\b|duplicate|conflict|\b409\b|\b412\b|\b428\b|precondition|changed since|\bversion\b|in progress|\blocked\b|\bstale\b|not empty|still has/i;
const IDENTITY = /permission|forbidden|unauthori[sz]ed|\b401\b|\b403\b|not allowed to|access denied|insufficient (scope|privilege|right)/i;
const SERVER_FAIL = /\b5\d\d\b|internal (server )?error|panic:|Traceback|exception\b/i;

const textOf = (c: Pick<In5Call, 'text' | 'rpc_error'>): string => `${c.text ?? ''} ${c.rpc_error?.message ?? ''}`.trim();

/** Was the call refused (spec MWS-IN-5: an error result; for a declared value also a success that did not store it)? */
export const refusedCall = (c: In5Call): boolean => !c.ok || (c.phase === 'declared' && c.stored === false);

/** Why a call is taken out of the reading, or null. */
export function excludedWhy(c: In5Call): string | null {
  if (c.indeterminate) return 'the outcome is unknown (a timeout, a broken connection or a result that is not complete)';
  if (!refusedCall(c)) return null;
  const d = mcpDefinedError(c.rpc_error);
  if (d) return `a JSON-RPC error that MCP defines for the case (${d})`;
  const t = textOf(c);
  if (RATE.test(t)) return 'the refusal names a rate limit';
  if (IDENTITY.test(t)) return "the refusal names the caller's identity or permissions";
  if (STATE.test(t)) return 'the refusal names the state of the backend (an object found or not, a version, a conflict)';
  return null;
}

/** EmRest-style class of a refusal's text (an observation, never a decision). */
export function classify(c: In5Call, bound: number | null = null): RefusalClass {
  const t = textOf(c);
  const esc = c.arg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const names = new RegExp(`(^|[^A-Za-z0-9_])${esc}($|[^A-Za-z0-9_])`).test(t);
  const kind: RefusalClass['kind'] = /\b(characters?|chars?|long|length|short)\b/i.test(t)
    ? 'length'
    : /\b(items?|elements?|entries)\b/i.test(t)
      ? 'count'
      : /\b(at (most|least)|greater|less|between|range|maximum|minimum|too (large|small|big))\b/i.test(t)
        ? 'range'
        : /\b(format|date|email|uri|url|uuid)\b/i.test(t)
          ? 'format'
          : /\b(character|letters?|digits?|alphanumeric|ascii|unicode|allowed)\b/i.test(t)
            ? 'characters'
            : /\brequired\b/i.test(t)
              ? 'required'
              : /\b(type|expected (a |an )?(string|number|integer|array|boolean))\b/i.test(t)
                ? 'type'
                : 'unstated';
  return { names_arg: names, kind, states_bound: bound === null ? null : new RegExp(`(^|\\D)${bound}(\\D|$)`).test(t), server_failure: SERVER_FAIL.test(t) || (c.rpc_error !== null && c.rpc_error.code === -32603) };
}

const KEYWORDS: Record<Dim, { upper: Constraint['keyword']; lower: Constraint['keyword'] }> = {
  length: { upper: 'maxLength', lower: 'minLength' },
  value: { upper: 'maximum', lower: 'minimum' },
  items: { upper: 'maxItems', lower: 'minItems' },
};

/** One point of an order: the outcome of every judged call at one position. */
interface Pt {
  n: number;
  acc: In5Call[];
  ref: In5Call[];
}

function points(calls: In5Call[]): Pt[] {
  const m = new Map<number, Pt>();
  for (const c of calls) {
    if (c.n === undefined) continue;
    const p = m.get(c.n) ?? { n: c.n, acc: [], ref: [] };
    (refusedCall(c) ? p.ref : p.acc).push(c);
    m.set(c.n, p);
  }
  return [...m.values()].sort((a, b) => a.n - b.n);
}

/**
 * Where the search should look next, from the search context's calls of one argument on one order: the upper candidate
 * (last accepted below the first refused) and the lower one (first accepted above the last refused). Used by the run to
 * bisect and to choose the value to repeat, and by the reading.
 */
export function boundaryOf(calls: In5Call[], dim: Dim): { upper: { acc: number; ref: number } | null; lower: { acc: number; ref: number } | null; mixed: number[] } {
  const pts = points(calls.filter((c) => c.dim === dim && c.context === 'A' && excludedWhy(c) === null));
  const mixed = pts.filter((p) => p.acc.length && p.ref.length).map((p) => p.n);
  const clean = pts.filter((p) => !(p.acc.length && p.ref.length));
  const accN = clean.filter((p) => p.acc.length).map((p) => p.n);
  const refN = clean.filter((p) => p.ref.length).map((p) => p.n);
  let upper: { acc: number; ref: number } | null = null;
  let lower: { acc: number; ref: number } | null = null;
  const upRef = refN.filter((r) => accN.some((a) => a < r));
  if (upRef.length) {
    const r = Math.min(...upRef);
    upper = { acc: Math.max(...accN.filter((a) => a < r)), ref: r };
  }
  const loRef = refN.filter((r) => accN.some((a) => a > r));
  if (loRef.length) {
    const r = Math.max(...loRef);
    lower = { acc: Math.min(...accN.filter((a) => a > r)), ref: r };
  }
  return { upper, lower, mixed };
}

/** The next value to try between an accepted and a refused position, or null where they are neighbours (integers). */
export function bisectNext(acc: number, ref: number): number | null {
  if (Math.abs(ref - acc) <= 1) return null;
  return Math.floor((acc + ref) / 2);
}

const quote = (c: In5Call): string => short(textOf(c), 2000);

/** The differential reading of one tool's calls (see the header). */
export function readIn5(calls: In5Call[], fixed: FixedDecl[] = []): Reading {
  const out: Reading = { confirmed: [], seen: [], excluded: [] };
  const counted = new Set<In5Call>();
  for (const c of calls) {
    const why = excludedWhy(c);
    if (why) out.excluded.push({ call: c, why });
  }
  const judged = calls.filter((c) => excludedWhy(c) === null);
  const args = [...new Set(calls.map((c) => c.arg))];
  for (const arg of args) {
    const mine = judged.filter((c) => c.arg === arg);
    // The declaration (fixed_constraints): a refusal whose text its pattern matches rests on a fixed constraint, as the
    // declaration states (spec MWS-IN-5); no differential reading is needed for it.
    for (const c of mine.filter(refusedCall)) {
      const fc = fixed.find((f) => f.arg === arg && safeTest(f.pattern, textOf(c)));
      if (!fc || out.confirmed.some((k) => k.arg === arg && k.keyword === 'declared')) continue;
      out.confirmed.push({ arg, keyword: 'declared', bound: null, exact: false, accepted_at: null, refused_at: c.n ?? null, reading_by: 'declaration', reason: fc.reason, steps: [c.step], text: quote(c), refusal: classify(c) });
      counted.add(c);
    }
    for (const dim of ['length', 'value', 'items'] as Dim[]) {
      const b = boundaryOf(mine, dim);
      const repeats = mine.filter((c) => c.dim === dim && c.context === 'B');
      for (const side of ['upper', 'lower'] as const) {
        const cand = b[side];
        if (!cand) continue;
        const onRefusedSide = (n: number) => (side === 'upper' ? n >= cand.ref : n <= cand.ref);
        const search = mine.filter((c) => c.dim === dim && c.context === 'A');
        const refusedHere = search.filter((c) => refusedCall(c) && c.n !== undefined && onRefusedSide(c.n));
        const accBeyond = search.filter((c) => !refusedCall(c) && c.n !== undefined && onRefusedSide(c.n));
        const at = search.find((c) => refusedCall(c) && c.n === cand.ref)!;
        const nb = search.find((c) => !refusedCall(c) && c.n === cand.acc)!;
        // (c) monotonic: no value beyond the refusal was accepted, and no position gave both answers.
        if (accBeyond.length || b.mixed.some((n) => onRefusedSide(n))) {
          for (const c of refusedHere) if (!counted.has(c)) out.seen.push({ call: c, why: `not monotonic: on ${dim} a value beyond the refused ${cand.ref} was also accepted (${[...accBeyond.map((x) => x.n), ...b.mixed].slice(0, 4).join(', ')}), so the refusal does not rest on a bound` });
          refusedHere.forEach((c) => counted.add(c));
          continue;
        }
        // (b) the refusal repeats in the fresh context, on the refused side.
        const rep = repeats.filter((c) => c.n !== undefined && onRefusedSide(c.n));
        const repRef = rep.find(refusedCall);
        if (!rep.length || !repRef || rep.some((c) => !refusedCall(c))) {
          const why = !rep.length ? 'the repeat in a fresh context was not sent (the per-tool budget, or no fresh context could be made)' : 'the refusal did not repeat in a fresh context, so it may depend on the state of the object or on another argument';
          for (const c of refusedHere) if (!counted.has(c)) out.seen.push({ call: c, why });
          refusedHere.forEach((c) => counted.add(c));
          continue;
        }
        const exact = Math.abs(cand.ref - cand.acc) === 1;
        const kw = KEYWORDS[dim][side];
        out.confirmed.push({ arg, keyword: kw, bound: cand.acc, exact, accepted_at: cand.acc, refused_at: cand.ref, reading_by: 'tester (differential probe)', steps: [at.step, nb.step, repRef.step], text: quote(at), refusal: classify(at, cand.acc) });
        refusedHere.forEach((c) => counted.add(c));
      }
    }
    // Character classes: the neighbour is the plain value of the same length, in the same context.
    for (const c of mine.filter((x) => x.context === 'A' && x.cls.startsWith('chars.') && refusedCall(x))) {
      if (counted.has(c)) continue;
      counted.add(c);
      const nb = mine.find((x) => x.context === 'A' && x.cls === 'plain' && x.n === c.plain_len && !refusedCall(x));
      if (!nb) {
        out.seen.push({ call: c, why: `no plain value of the same length (${c.plain_len}) was accepted in the same context, so the refusal is not shown to rest on the characters` });
        continue;
      }
      const rep = mine.filter((x) => x.context === 'B' && x.cls === c.cls);
      const repRef = rep.find(refusedCall);
      if (!rep.length || !repRef || rep.some((x) => !refusedCall(x))) {
        out.seen.push({ call: c, why: !rep.length ? 'the repeat in a fresh context was not sent (the per-tool budget, or no fresh context could be made)' : 'the refusal did not repeat in a fresh context' });
        continue;
      }
      out.confirmed.push({ arg, keyword: 'pattern', bound: null, exact: false, accepted_at: c.plain_len ?? null, refused_at: null, cls: c.cls, reading_by: 'tester (differential probe)', steps: [c.step, nb.step, repRef.step], text: quote(c), refusal: classify(c) });
    }
    // Every other refusal of the search: listed, seen, not judged.
    for (const c of mine.filter((x) => refusedCall(x) && x.context === 'A' && !counted.has(x))) {
      counted.add(c);
      const hasOrderNeighbour = c.dim !== undefined && mine.some((x) => x.dim === c.dim && x.context === 'A' && !refusedCall(x));
      out.seen.push({ call: c, why: c.dim === undefined ? 'a value with no neighbour on an order or of a plain class, so the reading cannot tell it from a refusal for another reason' : hasOrderNeighbour ? 'the refusal is not at a boundary the search could confirm' : `no other value of ${c.arg} on the same order was accepted in the same context` });
    }
  }
  return out;
}

function safeTest(pattern: string, text: string): boolean {
  try {
    return new RegExp(pattern, 'i').test(text);
  } catch {
    return false;
  }
}

/** A short, plain statement of one confirmed constraint (for the record's reason). */
export function describe(k: Constraint): string {
  if (k.keyword === 'declared') return `${k.arg}: a refusal the declaration states rests on a fixed constraint (${k.reason})`;
  if (k.keyword === 'pattern') return `${k.arg}: ${k.cls!.slice(6).replace('_', ' ')} characters refused, while a plain value of the same length (${k.accepted_at}) was accepted (an undeclared pattern)`;
  const rng = k.exact ? `${k.keyword} ${k.bound}` : `${k.keyword} between ${Math.min(k.accepted_at!, k.refused_at!)} and ${Math.max(k.accepted_at!, k.refused_at!)}`;
  const unit = k.keyword.endsWith('Length') ? 'characters' : k.keyword.endsWith('Items') ? 'items' : '';
  return `${k.arg}: ${rng} (${k.accepted_at}${unit ? ` ${unit}` : ''} accepted, ${k.refused_at}${unit ? ` ${unit}` : ''} refused)`;
}
