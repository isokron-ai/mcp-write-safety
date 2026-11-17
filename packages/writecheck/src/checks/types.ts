/**
 * What every check is: a scenario with an id and a version, the requirements it can decide, and
 * three steps kept apart on purpose.
 *
 *   plan      from the manifest and the catalog only: the calls it would make, how many writes, and
 *             the requirements it will not decide (with the reason). Makes no tool calls.
 *   collect   the calls, in the test tenant; returns plain JSON observations (step results, counts).
 *   evaluate  observations → results. Pure: no server, no clock. `recheck` runs only this step over a
 *             recorded run, so a rule fixed later can be applied to old evidence.
 */

import type { CallResult, Carried } from '../core/session.js';
import type { Driver } from '../core/driver.js';
import type { Ledger } from '../core/ledger.js';
import type { Manifest, ResourceSpec, ReviewSpec } from '../core/manifest.js';
import type { Session } from '../core/session.js';
import type { Gate } from '../gate/gate.js';
import type { RequirementId } from '../requirements.js';
import { short } from '../core/util.js';
import { result, type Result, type WritePath } from '../report/verdicts.js';
import { fromDeclaration, outcomeByField, patternOf, saidBy, says } from './says.js';
import { DEFAULT_PATTERNS } from './says.js';
import { adoptedBy, readText, decidedByShape, effectiveRepeat, patternData, quoteField, readShape, shapeFallbackNote, shapeIdentifies, shapeOf, type ShapeCapture, type WriteResult } from './shape.js';

export interface Tool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: Record<string, unknown>;
  [k: string]: unknown;
}

/** Input-schema properties of a tool whose names say it takes an idempotency key (dogfood C4, SH-3). */
export function offeredKeys(tools: { name: string; inputSchema?: unknown }[], tool: string | undefined): string[] {
  const props = Object.keys(((tools.find((t) => t.name === tool)?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties) ?? {});
  return props.filter((p) => /^(idempotency[_-]?key|idempotencyKey|request[_-]?id|requestId|client[_-]?(token|request[_-]?id)|clientToken|dedup(e|lication)?[_-]?key)$/i.test(p));
}

export interface PlanContext {
  manifest: Manifest;
  tools: Tool[];
  /** Answers to review-only clauses (the manifest's review block, or a --review file); null: none given. */
  review?: ReviewSpec | null;
  /** Whether the run has a backend gate (proxy-assisted tests). */
  gated?: boolean;
}

export interface RunContext extends PlanContext {
  session: Session;
  driver: Driver;
  ledger: Ledger;
  prefix: string;
  /** Fresh labels for server processes or sessions this check starts. */
  label(prefix: string): string;
  /** The backend gate, when the manifest configures one. */
  gate: Gate | null;
  /** The tester's environment (control credentials, launch settings). */
  env: NodeJS.ProcessEnv;
  /** Drivers of the other resources (scopes are created through them). */
  drivers: Map<string, Driver>;
  /** A fresh marker carrying the run prefix, unique in the run (titles, names, keys). */
  marker(tag: string): string;
}

export interface PlannedCheck {
  check: string;
  version: string;
  resource: string;
  /** False: collect is not called; `notRun` holds every result this check gives. */
  runs: boolean;
  /** One line per call or group of calls, in order (what `plan` prints). */
  calls: string[];
  /** Writes it will make at most (counted against the budget). */
  writes: number;
  /** Objects it will create (each goes through the ledger and the cleanup policy). */
  creates: number;
  /** Results decided without a call: not applicable, or not tested with the reason. */
  notRun: Result[];
}

export interface Observation {
  check: string;
  version: string;
  resource: string;
  data: unknown;
}

export interface CheckModule {
  id: string;
  version: string;
  requirements: RequirementId[];
  /** Runs only on resources with an update block (the object under test and its two fields). */
  needsUpdate?: boolean;
  plan(ctx: PlanContext, res: ResourceSpec): PlannedCheck;
  collect(ctx: RunContext, res: ResourceSpec): Promise<Observation>;
  evaluate(obs: Observation, ctx: PlanContext): Result[];
}

export const wp = (resource: string, tool: string): WritePath => ({ resource, tool, arm: 'mcp' });

export function notRun(check: { id: string; version: string }, ids: RequirementId[], w: WritePath, verdict: 'not tested' | 'not applicable', reason: string): Result[] {
  return ids.map((id) => result(id, w, { id: check.id, version: check.version }, verdict, reason));
}

export const toolByName = (tools: Tool[], name: string): Tool | undefined => tools.find((t) => t.name === name);

export const annotations = (t: Tool | undefined): Record<string, unknown> => (t && t.annotations && typeof t.annotations === 'object' ? t.annotations : {});

/** A check about the server as a whole (launch settings, the credential scan): it runs once, after the resources. */
export interface GlobalCheck {
  id: string;
  version: string;
  requirements: RequirementId[];
  plan(ctx: PlanContext): PlannedCheck;
  collect(ctx: Omit<RunContext, 'driver'> & { scan: ScanLog }): Promise<Observation>;
  evaluate(obs: Observation, ctx: PlanContext): Result[];
}

/** What the credential scan saw in raw results during the run: where, never the value. */
export interface ScanHit {
  step: string;
  tool: string;
  isError: boolean;
  kind: 'credential' | 'canary' | 'token_url' | 'pattern';
  /** The environment variable or URL parameter name, or the pattern's name. */
  name: string;
}
export interface ScanLog {
  results: { step: string; tool: string; isError: boolean }[];
  hits: ScanHit[];
}

export const sw = (tool: string): WritePath => ({ resource: '(server)', tool, arm: 'mcp' });

/** The input schema's top-level properties of a tool, and whether it forbids others. */
export function schemaProps(t: Tool | undefined): { props: Record<string, unknown>; closed: boolean } {
  const s = t && typeof t.inputSchema === 'object' && t.inputSchema !== null ? (t.inputSchema as Record<string, unknown>) : {};
  const props = typeof s['properties'] === 'object' && s['properties'] !== null ? (s['properties'] as Record<string, unknown>) : {};
  return { props, closed: s['additionalProperties'] === false };
}

/** A call's answer, kept small for observations: never the raw content beyond a short text. */
export interface CallBrief {
  step: string;
  ok: boolean;
  isError: boolean;
  rpc_error: { code: number; message: string } | null;
  text: string | null;
  /** The structured result, clipped (for report paths and receipts). */
  data: unknown;
  indeterminate: boolean;
  /** The whole answer as searchable text, kept only when text or data was clipped (at most 256 KB). */
  hay?: string;
  /** For a tool that adopts a result shape: `hay` with the shape reduced to its free words (what the patterns read; B-9 v2). */
  phay?: string;
  /** The result's resultType where it is not `complete` (revision 2026-07-28), such as input_required. */
  result_type?: string;
  /** The tool called (an adopted result shape is per tool); absent in older evidence. */
  tool?: string;
  /** What the answer carried of a result shape (src/checks/shape.ts); absent where it carried none. */
  shape?: ShapeCapture | null;
  /** Whether the call carried an idempotency key and a version, where the trial recorded it (B-9: same_key / same_version); absent in older evidence. */
  carried?: Carried;
  /** `data` is the JSON document a wrapped result carried as a string in structuredContent.result, and why it was decoded; absent otherwise. */
  decoded?: CallResult['decoded'];
}

export function brief(r0: { step: string; ok: boolean; isError: boolean; rpc_error: { code: number; message: string } | null; text: string | null; data: unknown; timed_out: boolean; transport_error: string | null; result_type?: string | null; tool?: string; shape?: ShapeCapture | null; prose_text?: string | null; carried?: Carried; decoded?: CallResult['decoded'] }, max = 2000): CallBrief {
  // why: B-9 v2: for a tool that adopts the shape, the text kept is what the patterns read (readText); `shape` is kept even when null.
  const r = { ...r0, text: readText(r0) };
  const d = JSON.stringify(r.data ?? null);
  const clipped = (r.text?.length ?? 0) > max || d.length > max * 2;
  // why: an identifier past the clip must still be found (MWS-RES-3, RES-4, ATOM-1); the full answer is kept for the search only then.
  return { step: r.step, ok: r.ok, isError: r.isError, rpc_error: r.rpc_error, text: r.text === null ? null : r.text.length > max ? `${r.text.slice(0, max)}…` : r.text, data: d.length > max * 2 ? { clipped: true, bytes: d.length } : r.data, indeterminate: r.timed_out || r.transport_error !== null || (!!r.result_type && r.result_type !== 'complete'), ...(clipped ? { hay: `${r.text ?? ''}\n${d}`.slice(0, 256 * 1024) } : {}), ...(clipped && adoptedBy(r.tool ?? null) && isObjLike(r.data) && 'mws' in r.data ? { phay: `${r.text ?? ''}\n${JSON.stringify(patternData({ tool: r.tool, data: r.data }))}`.slice(0, 256 * 1024) } : {}), ...(r.result_type && r.result_type !== 'complete' ? { result_type: r.result_type } : {}), ...(r.tool ? { tool: r.tool } : {}), ...(r.shape !== undefined ? { shape: r.shape } : {}), ...(r.carried ? { carried: r.carried } : {}), ...(r.decoded ? { decoded: r.decoded } : {}) };
}

const isObjLike = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/**
 * The answer as the text patterns read it (B-9 v2, "Free words and the serialized block"): for a tool that adopts a result
 * shape, `structuredContent.mws` is reduced to its free words, and so is the search text kept for a clipped answer.
 */
export function forPatterns<T extends Pick<CallBrief, 'text' | 'data'> & Partial<Pick<CallBrief, 'tool' | 'shape' | 'phay'>> & { hay?: string }>(b: T): T {
  return { ...b, data: patternData(b), ...(b.hay !== undefined ? { hay: b.phay ?? b.hay } : {}) };
}

/** Does a value appear in a call's answer (text or structured), as a whole token? */
export function mentions(b: Pick<CallBrief, 'text' | 'data'> & Partial<Pick<CallBrief, 'tool' | 'shape'>> & { rpc_error?: { message: string } | null; hay?: string }, v: unknown): boolean {
  if (v === null || v === undefined || v === '') return false;
  const needle = typeof v === 'string' ? v : JSON.stringify(v);
  // why: a JSON-RPC error is an error form too; its message can name what stayed applied.
  const hay = `${b.hay ?? `${b.text ?? ''}\n${JSON.stringify(b.data ?? null)}`}\n${b.rpc_error?.message ?? ''}`;
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // why (review of note 8, (B)): "Title" names the field title.
  return new RegExp(`(^|[^A-Za-z0-9_-])${esc}($|[^A-Za-z0-9_-])`, 'i').test(hay);
}

/** The name a field path is mentioned by: its last segment, without an index (`labels[1]` → labels). */
export const lastSeg = (p: string): string => p.replace(/\[[^\]]*\]/g, '').split('.').filter(Boolean).pop() ?? p;

/**
 * Changes that are not additive, for MWS-ANN-2: a scalar changed or removed, or an element of a list
 * that is no longer anywhere in the list. Lists compare as multisets, so an insert into a sorted or
 * newest-first list is additive.
 */
export function nonAdditive(before: unknown, after: unknown, path = ''): string[] {
  const isO = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
  // why: dogfood C3: a field that was empty (null or absent) and now holds a value gained data; nothing was replaced.
  if (before === null || before === undefined) return [];
  if (Array.isArray(before)) {
    if (!Array.isArray(after)) return [path || '(root)'];
    const left = after.map((x) => JSON.stringify(x));
    const lost: string[] = [];
    before.forEach((x, i) => {
      const k = left.indexOf(JSON.stringify(x));
      if (k >= 0) left.splice(k, 1);
      else lost.push(`${path}[${i}]`);
    });
    return lost;
  }
  if (isO(before)) {
    if (!isO(after)) return [path || '(root)'];
    return Object.keys(before).flatMap((k) => (Object.hasOwn(after, k) ? nonAdditive(before[k], after[k], path ? `${path}.${k}` : k) : [path ? `${path}.${k}` : k]));
  }
  return JSON.stringify(before) === JSON.stringify(after) ? [] : [path || '(root)'];
}

/** The verbs that report a change as made, in the forms a negation can take ("was not updated", "nothing was stored"). */
const MADE = String.raw`(written|applied|saved|stored|changed|updated|created|set|deleted|removed|made|committed|kept|added|recorded|persisted|completed|processed|done)`;
/**
 * The phrases that say a change was NOT made (review of note 8, 5): a negated verb ("was not updated", "wasn't set", "has
 * not been saved yet", "not created"), "nothing (else) was …", "no change(s) …", "nothing to update", "no longer in
 * effect", and "remains unchanged". They are taken out of the text before it is read for a change that was made, so a
 * partial answer ("the title was updated; the labels were not updated") still identifies the title.
 */
const NEGATED = new RegExp(
  [
    String.raw`(\bnot|\bnever|\bcannot|n['’]t)\s+(yet\s+)?(be\s+|been\s+|have been\s+)?(yet\s+)?${MADE}\b`,
    String.raw`\b(unable|failed|fails|impossible) to\s+(be\s+)?${MADE}\b`,
    String.raw`\bnothing\s+(else\s+|at all\s+)?((was|were|has been|had been|have been|is|got)\s+)?${MADE}\b`,
    String.raw`\bnothing (to|was there to) (write|update|change|apply|save|set|delete|create)\b`,
    String.raw`\bno\s+(other\s+)?(changes?|updates?|writes?|objects?|data)\b(\s+((was|were|has been|have been|had been|is|are)\s+)?${MADE}\b)?`,
    String.raw`\bno longer\s+(in effect|${MADE})\b`,
    String.raw`\b(remains?|remained|stayed|stays|left|is|was|were|are)\s+(unchanged|untouched|the same|as (it|they) (was|were))\b`,
  ].join('|'),
  'i',
);

/**
 * Does an error identify a change that stayed applied (spec MWS-RES-2, ATOM-1)? It must name the
 * field (or carry its new value) and say that something was applied or kept; naming the field alone
 * ("assignee must be a string") reads as a refusal, not as a report of what remains. A phrase that
 * says a change was not made ("title was not updated", "T1 was not created", "nothing was stored")
 * reports nothing as applied.
 */
/**
 * Might the answer identify the change by any reading (the declared pattern, the tester's built-in one, or the new value named
 * at all)? Used only to withhold `violated` (review of a6b111e): a failure that may name what stayed applied is read, never accused.
 * Read in the text alone (rule 11, R14-5): an adopted result shape is read on its own, and it does not withhold a violation the
 * text gives.
 */
export function mayIdentify(b0: Pick<CallBrief, 'text' | 'data'> & Partial<Pick<CallBrief, 'tool' | 'shape' | 'phay'>> & { rpc_error?: { message: string } | null; hay?: string }, path: string, value?: unknown): boolean {
  if (identifiesChangeText(b0, path, value, true)) return true;
  if (value === undefined || value === null || value === '') return false;
  const b = forPatterns(b0);
  // the new value named in a clause that says nothing of a negation or a failure ('title is now "New"', 'New title set.')
  const hay = `${b.hay ?? `${b.text ?? ''} ${JSON.stringify(b.data ?? null)}`} ${b.rpc_error?.message ?? ''}`;
  // (read by sentence: "Ticket T1: refused." names the object in a refusal, not as applied)
  return hay.split(/[;.!?]\s|[;!?]|\n/).some((c) => !NEGATED.test(c) && !UNDONE.test(c) && mentions({ text: c, data: null }, value));
}

export function identifiesChange(b: Pick<CallBrief, 'text' | 'data'> & Partial<Pick<CallBrief, 'tool' | 'shape'>> & { rpc_error?: { message: string } | null; hay?: string }, path: string, value?: unknown, anyReading = false): boolean {
  // why: rule 11: an adopted result shape that the result carries well formed decides like a declared pattern (src/checks/shape.ts).
  const shaped = shapeOf(b);
  if (shaped) return shapeIdentifies(shaped, path, value);
  return identifiesChangeText(b, path, value, anyReading);
}

/**
 * identifiesChange read in the text and the patterns alone (rule 11, R14-5: the shape and the text are read on their own). Of an
 * adopted shape only its free words are read here (patternData): its member names and fixed values are not sentences.
 */
export function identifiesChangeText(b0: Pick<CallBrief, 'text' | 'data'> & Partial<Pick<CallBrief, 'tool' | 'shape' | 'phay'>> & { rpc_error?: { message: string } | null; hay?: string }, path: string, value?: unknown, anyReading = false): boolean {
  const b = forPatterns(b0);
  const named = mentions(b, lastSeg(path)) || (value !== undefined && value !== null && value !== '' && mentions(b, value));
  if (!named) return false;
  const hay = `${b.hay ?? `${b.text ?? ''} ${JSON.stringify(patternData(b) ?? null)}`} ${b.rpc_error?.message ?? ''}`;
  // why (re-review 3): a verb that reports a change is credited only in a clause that says nothing of a negation, a failure or
  // the state before ("Update was not applied; the previous title was kept" identifies nothing). A verb that may describe the
  // state before ("kept", "remains", "stayed", "in effect") is credited only with the new value in the same clause, where the
  // caller gives it ('the title remains "Old"' does not identify a title changed to "New").
  const v = value !== undefined && value !== null && value !== '' ? value : undefined;
  // why: gate-2 re-run on 378f32f (note 19, rule 11): a declared patterns.applied decides, in a clause that names the field,
  // its new value or (for a create) the object; the built-in reading below is only the default.
  // Review of note 19 (4, 13): read in what the answer says (never a field name of its data), and an object named by its id is
  // matched by the whole id, never by a last path segment of it.
  if (fromDeclaration('applied')) {
    const field = v !== undefined && path === String(v) ? null : lastSeg(path);
    const declared = saidStrings(b).split(CLAUSE).some((c) => ((field !== null && field !== '' && mentions({ text: c, data: null }, field)) || (v !== undefined && mentions({ text: c, data: null }, v))) && says('applied', c));
    if (declared || !anyReading) return declared;
  }
  return hay.split(CLAUSE).some((c) => {
    if (NEGATED.test(c) || UNDONE.test(c)) return false;
    if (STRONG.test(c)) return true;
    return WEAK.test(c) && (v === undefined || mentions({ text: c, data: null }, v));
  });
}

/** Clause boundaries: sentence and clause punctuation, and "and" / "but" / "however". */
const CLAUSE = /[;.,:!?]\s|[;:!?]|\n|\s(?:and|but|however|although|though)\s/i;
/** A clause about a failure, or about the state before the call. */
const UNDONE = /\b(not|never|nothing|cannot|unable|fail\w*|refused|rejected|denied|unchanged|untouched|as before|as it was)\b|n['’]t\b|\b(previous|old|original|prior|former)\s+\w+\s+(was|were|is|are|remains?|stayed|kept)\b/i;
/** A verb that reports a change as made. */
const STRONG = /\b(applied|written|saved|stored|created|added|updated|took effect|succeeded|already (set|changed)|was (set|changed|updated))\b/i;
/** A verb that may report a change in effect, or the state before it. */
const WEAK = /\b(kept|remains?|stayed|in effect)\b/i;

/** Does an error say that it is not known whether a change was applied (spec MWS-RES-2, second clause)? */
export function saysUnknown(b: Pick<CallBrief, 'text' | 'data'> & Partial<Pick<CallBrief, 'tool' | 'shape'>> & { rpc_error?: { message: string } | null; hay?: string }): boolean {
  const shaped = shapeOf(b);
  if (shaped?.outcome) return shaped.outcome === 'unknown';
  return saysUnknownText(b);
}

/** saysUnknown read in the text and the patterns alone. */
export function saysUnknownText(b0: Pick<CallBrief, 'text' | 'data'> & Partial<Pick<CallBrief, 'tool' | 'shape' | 'phay'>> & { rpc_error?: { message: string } | null; hay?: string }): boolean {
  const b = forPatterns(b0);
  const hay = `${b.hay ?? `${b.text ?? ''} ${JSON.stringify(b.data)}`} ${b.rpc_error?.message ?? ''}`;
  return says('outcome_unknown', hay);
}

/** The resultType values the tester recognizes (revision 2026-07-28, and the task handle of the Tasks extension). */
export const KNOWN_RESULT_TYPES = ['complete', 'input_required', 'task'];

/**
 * A JSON-RPC error that the MCP specification itself requires or defines for the case (spec R6-2: MWS-IN-4 and the
 * third clause of MWS-RES-2 do not judge it), or that rejects a request as not conforming (spec 7.3, rule 9: the
 * tester's error, never a verdict). Decided from the code and the message; null where it is none of these.
 */
export function mcpDefinedError(e: { code: number; message: string } | null | undefined): string | null {
  if (!e) return null;
  const m = e.message ?? '';
  if (e.code === -32042) return 'a URL elicitation that is required first (revision 2025-11-25)';
  if (e.code === -32600) return 'a request the server says does not satisfy the request schema (spec 7.3, rule 9)';
  if (/\b(unknown tool|no such tool|tool (not found|does not exist|is not available))\b/i.test(m)) return 'an unknown tool';
  if (/\b(unsupported protocol version|protocol version\b.*\bnot supported)\b/i.test(m)) return 'an unsupported protocol version';
  if (/\bheaders?\b/i.test(m) && /\b(mismatch|do(es)? not match|doesn't match|disagrees?)\b/i.test(m)) return 'a header that does not match the body';
  if (/\bmissing (the )?(required )?(_meta|meta field)/i.test(m)) return 'a missing required _meta field';
  if (/\b(missing|lacks?|requires?|not declared?)\b.*\bcapabilit(y|ies)\b/i.test(m)) return 'a missing client capability';
  if (/\b(must be (called|invoked|run) as a task|task(-augmented)? (call |execution |request )?(is )?required)\b/i.test(m)) return 'a tool that must be called as a task (revision 2025-11-25)';
  return null;
}

/** The strings an answer says: its text (the string values of a text that is JSON), the string values of its data, and a JSON-RPC message; never field names. */
export function saidStrings(b: Pick<CallBrief, 'text' | 'data'> & Partial<Pick<CallBrief, 'tool' | 'shape'>> & { rpc_error?: { message: string } | null }): string {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  if (b.text) {
    try {
      walk(JSON.parse(b.text));
    } catch {
      out.push(b.text);
    }
  }
  // why: B-9 v2: member names and fixed values of an adopted shape are not sentences; only its free words are read by patterns.
  walk(patternData(b));
  if (b.rpc_error?.message) out.push(b.rpc_error.message);
  return [...new Set(out)].join(' \n ');
}

/**
 * Does an answer carry a value as an exact token (re-review 5, 6)? Case-sensitive, in what the answer says (saidStrings),
 * never in a field name: "request ID 7f3a" does not name the argument id, nor "HTTP status 500" the field status.
 */
export function valueMentioned(b: Pick<CallBrief, 'text' | 'data'> & { rpc_error?: { message: string } | null }, v: unknown): boolean {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return false;
  const needle = typeof v === 'string' ? v : typeof v === 'number' ? String(v) : JSON.stringify(v);
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_-])${esc}($|[^A-Za-z0-9_-])`).test(saidStrings(b));
}

/**
 * Rule 11, point 13 (R14-5) beside an adopted result shape: what the text states of the write, read by a declared pattern only,
 * in what the answer says (saidStrings: the shape's free words and the rest of the answer, never a member name or fixed value).
 * A false statement here gives its verdict even where the shape beside it is correct. Null: no declared pattern reads it.
 * `trial`: where the statement only opens a trial whose judge reads the outcome-unknown guard itself (res2Judge), the tester's
 * built-in maybe-unknown reading does not cancel the declared one (validator on 59e3124, finding 5): the trial says so on record.
 */
export function textStatement(b: Pick<CallBrief, 'text' | 'data'> & Partial<Pick<CallBrief, 'tool' | 'shape'>> & { rpc_error?: { message: string } | null }, kind: 'applied' | 'not_applied', o: { trial?: boolean } = {}): string | null {
  if (!fromDeclaration(kind)) return null;
  const t = saidStrings(b);
  if (!says(kind, t) || (kind === 'not_applied' && !o.trial && mayBeUnknown(t))) return null;
  return saidBy(kind, t);
}

/**
 * MWS-ATOM-1 (spec R15-3): does the content say that the whole write took effect, with every item or step applied? Read by the
 * declared patterns.applied_all only, as B-9 "Free words and the serialized block" provides: the text blocks other than the
 * serialized block, and the free words of a shape (saidStrings of what the patterns read). Null: no match, or no usable pattern.
 */
export function appliedAllSaid(b: Pick<CallBrief, 'text' | 'data'> & Partial<Pick<CallBrief, 'tool' | 'shape' | 'phay'>> & { rpc_error?: { message: string } | null }): string | null {
  if (appliedAllUnread()) return null;
  const t = saidStrings(forPatterns(b));
  return says('applied_all', t) ? saidBy('applied_all', t) : null;
}

/** Where MWS-ATOM-1 cannot read a statement that the whole write took effect (no pattern, or one that cannot be applied as written), the line a held record carries; else null. */
export function appliedAllUnread(): string | null {
  if (!fromDeclaration('applied_all')) return 'The content was not read for a statement that the whole write took effect: the declaration gives no patterns.applied_all (spec MWS-ATOM-1, Verdicts; R15-3).';
  try {
    if (new RegExp(patternOf('applied_all'), 'i').test('')) return 'The content was not read for a statement that the whole write took effect: the declared patterns.applied_all matches an empty text, so it cannot be applied as written (spec MWS-ATOM-1, Verdicts; R15-3).';
  } catch {
    return 'The content was not read for a statement that the whole write took effect: the declared patterns.applied_all is not a usable regular expression (spec MWS-ATOM-1, Verdicts; R15-3).';
  }
  return null;
}

/** The text a not_applied pattern reads in a success: a declared pattern reads every string the answer says; the default only its prose (re-review 4). */
export const notAppliedText = (b: Pick<CallBrief, 'text' | 'data'> & Partial<Pick<CallBrief, 'tool' | 'shape'>> & { rpc_error?: { message: string } | null }): string => (fromDeclaration('not_applied') ? saidStrings(b) : proseOf(b.text));

/**
 * The prose of a result's text (review of note 8, 4): the text without the JSON it carries. A text that is JSON as a whole
 * is data, not prose, and a JSON object or array inside prose ("Updated. {…}") is taken out; what a result says is read in
 * what is left (spec 7.3, rule 11), never in a value of its data.
 */
export function proseOf(text: string | null | undefined): string {
  const t = (text ?? '').trim();
  if (!t) return '';
  try {
    JSON.parse(t);
    return '';
  } catch {
    /* prose */
  }
  let out = '';
  let i = 0;
  while (i < t.length) {
    const ch = t[i]!;
    if (ch === '{' || ch === '[') {
      const end = jsonEnd(t, i);
      if (end > i) {
        try {
          JSON.parse(t.slice(i, end + 1));
          out += ' ';
          i = end + 1;
          continue;
        } catch {
          /* not JSON: keep it */
        }
      }
    }
    out += ch;
    i++;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** The index of the bracket that closes the one at `i` (strings respected), or -1. */
function jsonEnd(t: string, i: number): number {
  let depth = 0;
  let str = false;
  for (let k = i; k < t.length; k++) {
    const c = t[k]!;
    if (str) {
      if (c === '\\') k++;
      else if (c === '"') str = false;
      continue;
    }
    if (c === '"') str = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return k;
    }
  }
  return -1;
}

/** Any reading, the declared one or the tester's default, that a text says the outcome is not known (a guard: it only withholds a violated). */
export const mayBeUnknown = (text: string): boolean => {
  try {
    return says('outcome_unknown', text) || new RegExp(DEFAULT_PATTERNS.outcome_unknown, 'i').test(text);
  } catch {
    return true;
  }
};

/**
 * The second clause of MWS-RES-2 read under rule 11 (gate-2 re-run on 378f32f, note 19): changes stayed applied after an
 * error; does the error identify each, or say the outcome is not known? Only declared patterns decide: `held` where the
 * declared outcome_unknown pattern matches or the declared applied pattern identifies every change; `violated` where both
 * are declared and neither does; otherwise `unread` (the record is `not tested`, the text quoted, and the default reading
 * given as a note). The tester's built-in reading never decides a verdict on its own.
 */
export type SecondClause = { v: 'held' | 'violated' | 'unread'; why: string; notes: string[]; kind?: string; /** The shape side may state a forbidden repeat that is not yet decided: no held from either side. */ blocksHeld?: boolean };

/**
 * Options for the shape side of the second clause (B-9 v2, "How a tester uses it"): whether the call carried an idempotency key
 * or a version (undefined: not known to the tester, taken as given), and whether the text names a read tool or the object to
 * read (`maybe`: it names the object, and whether as the read to make first needs a declared patterns.read_named).
 */
export type ShapeReadOptions = { carriedKey?: boolean; carriedVersion?: boolean; textNamesRead?: boolean | 'maybe'; /** The lost-answer trial of MWS-RES-2: a declared patterns.write_failed reads the error's statement that the write failed. */ lostAnswer?: boolean };

/** The pattern kind that reads an error's statement that the write failed: write_failed in the lost-answer trial where declared, else not_applied (f573a24). */
export const failedKind = (lostAnswer = false): 'write_failed' | 'not_applied' => (lostAnswer && fromDeclaration('write_failed') ? 'write_failed' : 'not_applied');

export function readSecondClause(b: Pick<CallBrief, 'text' | 'data'> & Partial<Pick<CallBrief, 'tool' | 'shape' | 'carried'>> & { rpc_error?: { message: string } | null; hay?: string }, changed: string[], values: Record<string, unknown> = {}, o: ShapeReadOptions = {}): SecondClause & { shape?: SecondClause; text?: SecondClause } {
  const sr = readShape(b);
  const fb = shapeFallbackNote(b);
  const t = readSecondClauseByPatterns(b, changed, values, !!o.lostAnswer);
  if (sr.status !== 'ok') return fb ? { ...t, notes: [fb, ...t.notes], text: t } : { ...t, text: t };
  // why: rule 11 (R14-5): where the shape and the text state different things, each is read on its own; a forbidden
  // statement in either gives violated, and a true statement in one does not make up for a false one in the other.
  // why: B-9: same_key / same_version on a call that carried neither is read as yes; where the trial recorded what the call
  // carried, that decides it; otherwise the shape side gives no held (it cannot tell).
  const sv = secondClauseByShape(b, sr.v, changed, values, { ...o, carriedKey: o.carriedKey ?? b.carried?.key, carriedVersion: o.carriedVersion ?? b.carried?.version });
  const sides = { shape: sv, text: t };
  if (sv.v === 'violated' || t.v === 'violated') {
    const parts = [sv.v === 'violated' ? `by the adopted result shape, ${sv.why}` : '', t.v === 'violated' ? `by the declared patterns, ${t.why}` : ''].filter(Boolean);
    return { v: 'violated', why: parts.join('; and '), notes: [...(sv.v === 'violated' ? sv.notes : []), ...(t.v === 'violated' ? t.notes : [])], ...(sv.v === 'violated' && sv.kind ? { kind: sv.kind } : {}), ...sides };
  }
  // why: R14-5: where the shape may invite a repeat that the spec forbids and the tester cannot yet tell, a true text does not make up for it.
  if (sv.blocksHeld) return { ...sv, notes: [...sv.notes, ...t.notes], ...sides };
  if (sv.v === 'held') return { ...sv, notes: [...sv.notes, ...(t.v === 'unread' ? ['The text was not read by a declared pattern for this clause; the shape decided it, and no declared pattern reads a forbidden statement in the text.'] : [])], ...sides };
  return t.v === 'held' ? { ...t, ...sides } : { ...sv, notes: [...sv.notes, ...t.notes], ...sides };
}

/**
 * The second clause read from an adopted result shape (spec 7.3, rule 11; B-9 v2). `outcome: "unknown"` says the outcome is
 * not known (held), unless `repeat`, as given or as read under "How a tester uses it", is `yes`: it tells the caller to repeat
 * the open write without a read first and without a key or a version, the kind `retry-invited` (violated). `same_key`,
 * `same_version` and `read_first` are the repeats the requirement allows where they name what they say (the follow-through repeat
 * with the version is not built here, and the record says so). Otherwise each change that stayed applied must be identified:
 * under `applied`, listed in `changed` (JSON Pointers) or the object named; under `partial`, listed in `changed` or an item listed
 * as applied. `not_applied` with a change in effect is a stated failure.
 */
function secondClauseByShape(b: Partial<Pick<CallBrief, 'tool' | 'shape'>> & Pick<CallBrief, 'text' | 'data'>, s: WriteResult, changed: string[], values: Record<string, unknown>, o: ShapeReadOptions): SecondClause {
  const rf: [string, unknown][] = [['outcome', s.outcome], ['repeat', s.repeat], ['read_with', s.read_with], ['object', s.object], ['code', s.code]];
  // why: B-9 v2: repeat is read as the tester can check it; a read_first that names no read, or a same_key the call did not carry, is yes.
  const rep = effectiveRepeat(s, { carriedKey: o.carriedKey, carriedVersion: o.carriedVersion, textNamesRead: o.textNamesRead === true });
  // why: rule 11: whether the text names the object as the read to make is a reading; where only that would keep read_first from
  // reading as yes, the shape side needs reading, and no held is given from either side.
  const maybeRead = rep === 'yes' && o.textNamesRead === 'maybe' && effectiveRepeat(s, { carriedKey: o.carriedKey, carriedVersion: o.carriedVersion, textNamesRead: true }) !== 'yes';
  const asRead = s.repeat !== 'yes' ? ', read as "yes": it names no read, key or version the tester can check' : '';
  const open = !s.outcome || s.outcome === 'unknown';
  if (open && maybeRead) return { v: 'unread', why: `its adopted result shape says ${quoteField('repeat', 'read_first')} with neither a listed read_with nor object.id, and whether the text names the object as the read to make first is decided by patterns.read_named, which the declaration does not give (spec 7.3, rule 11)`, notes: [decidedByShape(rf, b)], blocksHeld: true };
  // why: B-9 v2: same_key / same_version name the key or version only where the call carried one; where the tester does not know
  // whether it did, the repeat is neither allowed nor forbidden as far as it can tell: no held.
  if (open && (s.repeat === 'same_key' || s.repeat === 'same_version') && (s.repeat === 'same_key' ? o.carriedKey : o.carriedVersion) === undefined) return { v: 'unread', why: `its adopted result shape says ${quoteField('repeat', s.repeat)}, and whether the call carried ${s.repeat === 'same_key' ? 'an idempotency key' : 'a version'} is not known to the tester, so whether the repeat it allows is guarded is not known (B-9 v2: on a call that carried none it means "yes")`, notes: [decidedByShape(rf, b)], blocksHeld: true };
  // why: MWS-RES-2 and B-9 v2: same_version on a call that carried a version names it, and the follow-through (the repeat sent once
  // with that version, no fault, then read back) decides whether it guards the repeat; it is not built, so no held (as for the text).
  if (open && rep === 'same_version') return { v: 'unread', why: `it says the outcome is not known and allows a repeat with the version the call carried (${quoteField('outcome', 'unknown')}, ${quoteField('repeat', 'same_version')}); the follow-through that would show whether that version guards the repeat is not built in this preview`, notes: [decidedByShape(rf, b)], blocksHeld: true };
  // why: B-9 v2 (SF-3): a repeat: yes with no well-formed outcome still invites a repeat of an open write (changes are in effect).
  if (!s.outcome) {
    if (rep === 'yes' && s.repeat !== undefined) return { v: 'violated', why: `${changed.join(', ')} stayed changed, the outcome member decides nothing, and it tells the caller to send the same call again (${quoteField('repeat', s.repeat)}${asRead})`, notes: [decidedByShape(rf, b)], kind: 'retry-invited' };
    return { v: 'unread', why: 'its adopted result shape has no well-formed outcome, so it neither identifies the change nor says the outcome is unknown', notes: [decidedByShape(rf, b)] };
  }
  if (s.outcome === 'unknown') {
    const by = decidedByShape(rf, b);
    if (rep === 'yes') return { v: 'violated', why: `it says the outcome is not known and tells the caller to send the same call again (${quoteField('repeat', s.repeat)}${asRead}), naming no read and no guard`, notes: [by], kind: 'retry-invited' };
    return { v: 'held', why: `says that it is not known whether the change was applied (${quoteField('outcome', 'unknown')}${s.repeat ? `, ${quoteField('repeat', s.repeat)}` : ''}${s.read_with ? `, ${quoteField('read_with', s.read_with)}` : ''})`, notes: [by] };
  }
  if (s.outcome === 'accepted') return { v: 'unread', why: `its adopted result shape says the operation was accepted for later processing (${quoteField('outcome', 'accepted')}) while changes stayed applied; an error that says so neither identifies the change nor says the outcome is unknown, and B-9 gives accepted only without isError`, notes: [decidedByShape(rf, b)] };
  const unnamed = changed.filter((p) => !shapeIdentifies(s, p, values[p]));
  const fields: [string, unknown][] = [['outcome', s.outcome], ['changed', s.changed], ['object', s.object], ['items', s.items]];
  if (!unnamed.length) return { v: 'held', why: `identifies what stayed applied (${fields.filter(([, v]) => v !== undefined).map(([k, v]) => quoteField(k, v)).join(', ')})`, notes: [decidedByShape(fields, b)] };
  // why: B-9 v2: "a missing member says nothing": under partial without changed or items, nothing is stated about the field.
  if (s.outcome === 'partial' && s.changed === undefined && !(s.items ?? []).length) return { v: 'unread', why: `its adopted result shape says ${quoteField('outcome', 'partial')} with neither changed nor items, so it does not state whether ${unnamed.join(', ')} stayed applied`, notes: [decidedByShape(fields, b)] };
  if (s.outcome === 'not_applied') return { v: 'violated', why: `${unnamed.join(', ')} stayed changed, and the adopted result shape says no change is in effect (${quoteField('outcome', 'not_applied')})`, notes: [decidedByShape(fields, b)], kind: 'stated-failure' };
  return { v: 'violated', why: `${unnamed.join(', ')} stayed changed, and the adopted result shape does not identify it (${fields.filter(([, v]) => v !== undefined).map(([k, v]) => quoteField(k, v)).join(', ')}), nor says that the outcome is unknown`, notes: [decidedByShape(fields, b)] };
}

function readSecondClauseByPatterns(b: Pick<CallBrief, 'text' | 'data'> & Partial<Pick<CallBrief, 'tool' | 'shape'>> & { rpc_error?: { message: string } | null; hay?: string }, changed: string[], values: Record<string, unknown> = {}, lostAnswer = false): { v: 'held' | 'violated' | 'unread'; why: string; notes: string[] } {
  const text = `${b.text ?? ''} ${b.rpc_error?.message ?? ''}`.trim();
  const declU = fromDeclaration('outcome_unknown');
  const declA = fromDeclaration('applied');
  const unknown = saysUnknownText(b);
  const unnamed = changed.filter((p) => !identifiesChangeText(b, p, values[p]));
  // why: review of a6b111e: violated is withheld for a change the answer may name by any reading.
  const unnamedAny = changed.filter((p) => !mayIdentify(b, p, values[p]));
  // why: rule-11 coverage package: a declared outcome field decides before any text is read.
  const f = outcomeByField(b);
  // why: spec R14-5, rule 11 point 13: a false statement in the text or in the field gives its verdict, and a true one in the other
  // does not repair it. A declared text failure, while a change stayed, is read even where the field says unknown or applied.
  const textFails = fromDeclaration('not_applied') && says('not_applied', text) && unnamedAny.length > 0 && !mayBeUnknown(text);
  if (f && f.outcome !== 'not_applied' && textFails) return { v: 'violated', why: `${unnamedAny.join(', ')} stayed changed, and by the declared patterns.not_applied the text says the write failed or nothing was changed (rule 11, point 13: the declared outcome field saying ${f.outcome.replace('_', ' ')} does not repair it)`, notes: [f.line, saidBy('not_applied', text)] };
  if (f?.outcome === 'unknown') return { v: 'held', why: 'says, in the declared outcome field, that it is not known whether the change was applied', notes: [f.line] };
  if (f?.outcome === 'applied') return { v: 'held', why: 'says, in the declared outcome field, that the change was applied', notes: [f.line] };
  // why: review: a field that says not applied, beside text that may say the outcome is unknown or that names every change, is read.
  if (f?.outcome === 'not_applied' && unnamedAny.length > 0 && !mayBeUnknown(text)) return { v: 'violated', why: `${unnamedAny.join(', ')} stayed changed, and the declared outcome field says the write was not applied`, notes: [f.line] };
  if (f?.outcome === 'not_applied') return { v: 'unread', why: `${changed.join(', ')} stayed changed; the declared outcome field says the write was not applied, but the text may say the outcome is not known or name what stayed applied, so the answer contradicts itself and needs reading: ${JSON.stringify(short(text, 200))}`, notes: [f.line] };
  if (declU && unknown) return { v: 'held', why: 'says it is not known whether the change was applied', notes: [saidBy('outcome_unknown', text)] };
  if (declA && !unnamed.length) return { v: 'held', why: 'identifies what stayed applied', notes: [saidBy('applied', text)] };
  // why (rule 11, "declared-carryover"): declared patterns that both fail to match other wording
  // are no evidence of a violation. violated needs a positive match of a pattern that means one: a declared not_applied (the
  // error says the write failed or nothing was changed) while a change stayed, and no reading, declared or default, that the
  // outcome is not known.
  // why: review: violated needs a change the answer does not identify; where it names every change (by any reading), it is read.
  // why: D-3 (owner, 15 Nov): in the lost-answer trial the statement is read by its own kind, write_failed, where declared.
  const fk = failedKind(lostAnswer);
  if (fromDeclaration(fk) && says(fk, text) && !unknown && !mayBeUnknown(text) && unnamedAny.length > 0) return { v: 'violated', why: `${unnamedAny.join(', ')} stayed changed, and by the declared patterns.${fk} the error says the write failed or nothing was changed, without identifying it or saying the outcome is not known`, notes: [saidBy(fk, text), ...(declA ? [saidBy('applied', text)] : [])] };
  const def = !unnamed.length ? 'reads it as identifying the change' : unknown ? 'reads it as saying the outcome is not known' : 'reads neither an identification of the change nor an unknown outcome in it';
  return {
    v: 'unread',
    why: `${(unnamed.length ? unnamed : changed).join(', ')} stayed changed, and the error needs reading: no declared pattern says that it identifies the change (patterns.applied), that the outcome is not known (patterns.outcome_unknown), or that the write failed (patterns.not_applied). The tester's default reading ${def}, and a default pattern alone decides nothing (spec 7.3, rule 11): ${JSON.stringify(short(text, 200))}. Declare the patterns, or read it`,
    notes: [`Default reading (not relied on): ${def}.`, saidBy('applied', text), saidBy('outcome_unknown', text)],
  };
}

/**
 * The verdict of MWS-RES-2 for one failed write, by the three clauses of the current text: (1) not a success;
 * (2) every change that stayed applied identified, or the outcome said to be unknown; (3) a backend or rule
 * failure returned as a tool execution error, not a JSON-RPC error. `cause` is what the tester knows about the
 * failure; where it is unknown, a JSON-RPC error is judged on the first two clauses and the third is not tested.
 * `changed` holds the paths that stayed changed (null: the object did not read back). `o.async`: the declaration
 * lists the operation as completed asynchronously by the backend (NF-19).
 */
export function res2Judge(b: CallBrief, changed: string[] | null, cause: 'backend' | 'rule' | 'unknown', what: string, values: Record<string, unknown> = {}, o: { async?: boolean; object?: unknown } = {}): { verdict: 'violated' | 'held' | 'not tested'; reason: string; notes: string[] } {
  // why: spec R7-4: a resultType the tester does not recognize is invalid under MCP; the trial is indeterminate.
  if (b.result_type && !KNOWN_RESULT_TYPES.includes(b.result_type)) return { verdict: 'not tested', reason: `${what}: the result has resultType ${JSON.stringify(b.result_type)}, which the tester does not recognize; it is invalid under the MCP specification, so the trial is indeterminate (spec 7.3, rule 5)`, notes: [] };
  if (b.result_type && b.result_type !== 'complete') return { verdict: 'not tested', reason: `${what}: the answer was a ${b.result_type} result, which is neither a success nor an error; judging the final result (after a retry, or the terminal task) is not built in this preview`, notes: [] };
  if (b.indeterminate) return { verdict: 'not tested', reason: `${what}: the outcome is unknown (a timeout or a broken connection)`, notes: [] };
  // why: B-9 v2: of an adopted result shape the patterns read only its free words (a pattern for "accepted" does not match `"outcome":"accepted"`).
  const pb = forPatterns(b);
  const content = `${pb.hay ?? `${pb.text ?? ''} ${pb.data === null || pb.data === undefined ? '' : JSON.stringify(pb.data)}`}`;
  if (b.ok) {
    // why (review of note 8, 4): "says that the write failed" is read in the result's prose, never in a value of its data
    // ("login fails on Safari" in a description), and a default not_applied pattern alone decides nothing (rule 11).
    const prose = notAppliedText(b);
    const fo = outcomeByField(b);
    if (fo?.outcome === 'not_applied' && !o.async) return { verdict: 'violated', reason: `${what}; the result has no isError: true, and its declared outcome field says that the write was not applied (third clause).`, notes: [fo.line] };
    const failed = says('not_applied', prose);
    // why: NF-19 (R6-6): only for an operation the declaration lists as completed asynchronously; otherwise "accepted" is a success.
    if (o.async && says('accepted', content)) {
      if (!failed) return { verdict: 'not tested', reason: `${what}: the result says the operation was accepted or is pending, and the declaration lists it as completed asynchronously by the backend (NF-19), so this trial adds no verdict`, notes: [saidBy('accepted', content)] };
      if (!fromDeclaration('not_applied')) return { verdict: 'not tested', reason: `${what}: the result says the operation was accepted or is pending (NF-19, an operation the declaration lists as completed asynchronously), and only the tester's default pattern for not applied reads its text as saying the write failed: ${JSON.stringify(short(prose, 200))}; a default pattern alone does not decide (spec 7.3, rule 11): declare patterns.not_applied, or read it`, notes: [saidBy('accepted', content), saidBy('not_applied', prose)] };
    }
    // why: rule 11 (R14-5): the adopted shape and the text are read on their own; a forbidden statement in either gives the
    // verdict. A text that says the write failed is the third clause whatever the shape says, so it is read first.
    const shaped = shapeOf(b);
    const so = shaped?.outcome;
    if (failed && fromDeclaration('not_applied') && shaped) return { verdict: 'violated', reason: `${what}; the result has no isError: true, and its content says that the write failed: ${JSON.stringify(short(prose, 200))} (third clause)${so ? `; its adopted result shape says ${quoteField('outcome', so)}, which does not make up for the text` : ''}.`, notes: [saidBy('not_applied', prose), ...(so ? [decidedByShape([['outcome', so]], b)] : [])] };
    if (so === 'accepted' && o.async) return { verdict: 'not tested', reason: `${what}: its adopted result shape says the operation was accepted for later processing (${quoteField('outcome', 'accepted')}), and the declaration lists it as completed asynchronously by the backend (NF-19), so this trial adds no verdict`, notes: [decidedByShape([['outcome', 'accepted']], b)] };
    const OUT: Record<string, string> = { unknown: 'that it is not known whether the write was applied', not_applied: 'that the write was not applied', partial: 'that the write was applied in part' };
    if (so && OUT[so]) return { verdict: 'violated', reason: `${what}; the result has no isError: true, and its adopted result shape says ${OUT[so]} (${quoteField('outcome', so)}) (third clause).`, notes: [decidedByShape([['outcome', so]], b)] };
    // why: B-9: accepted, for an operation the declaration does not list as asynchronous, is read as a report of success (NF-19).
    if (so) return { verdict: 'violated', reason: `${what}, and the tool reported it as a success (first clause: no isError, and its adopted result shape says ${quoteField('outcome', so)}${so === 'accepted' ? ', which for an operation the declaration does not list as asynchronous is a report of success (NF-19)' : ''}).`, notes: [decidedByShape([['outcome', so]], b)] };
    const fb = shapeFallbackNote(b);
    if (failed && fromDeclaration('not_applied')) return { verdict: 'violated', reason: `${what}; the result has no isError: true, and its content says that the write failed: ${JSON.stringify(short(prose, 200))} (third clause).`, notes: [...(fb ? [fb] : []), saidBy('not_applied', prose)] };
    return { verdict: 'violated', reason: `${what}, and the tool reported it as a success (first clause: no isError)${failed ? `; its text ${JSON.stringify(short(prose, 200))} matches the default pattern for not applied, which alone does not decide the third clause (spec 7.3, rule 11)` : ''}.`, notes: failed ? [saidBy('not_applied', prose)] : [] };
  }
  if (changed === null) return { verdict: 'not tested', reason: `${what}: the object did not read back around the call`, notes: [] };
  const defined = mcpDefinedError(b.rpc_error);
  // why: R6-2: an error MCP defines for the case, returned where no change was made, adds no verdict to this record.
  if (defined && !changed.length) return { verdict: 'not tested', reason: `${what}: the answer was a JSON-RPC error that the MCP specification defines for the case (${defined}: ${JSON.stringify(b.rpc_error!.message.slice(0, 160))}), and no change was made, so this trial adds no verdict`, notes: [] };
  // why: gate-2 re-run on 378f32f (note 19, rule 11): what the error says is decided by declared patterns only.
  const second = changed.length ? readSecondClause(b, changed, values) : { v: 'held' as const, why: 'and nothing stayed applied', notes: [] as string[] };
  if (second.v === 'violated') return { verdict: 'violated', reason: `${what}; ${second.why} (second clause).`, notes: second.notes };
  if (b.rpc_error && cause !== 'unknown' && !defined) return { verdict: 'violated', reason: `${what}, and the tool returned the ${cause === 'backend' ? 'backend\'s refusal' : 'refusal'} as a JSON-RPC error (${b.rpc_error.code}), a protocol error, not as a tool execution error with isError: true (third clause).`, notes: second.notes };
  if (second.v === 'unread') return { verdict: 'not tested', reason: `${what}; ${second.why}.`, notes: second.notes };
  const notes = defined ? [`The third clause was not judged: the answer was a JSON-RPC error that the MCP specification defines for the case (${defined}); the first two clauses apply because a change was made.`] : b.rpc_error ? ['The third clause was not tested: the answer was a JSON-RPC error and the tester could not establish whether its cause was the backend, a rule the tool applies, or a fault in the server.'] : [];
  return { verdict: 'held', reason: `${what}; the answer was an error${b.rpc_error ? ' (a JSON-RPC error)' : ' (isError: true)'}${changed.length ? ` that ${second.why}` : ' and nothing stayed applied'}.`, notes: [...second.notes, ...notes] };
}
