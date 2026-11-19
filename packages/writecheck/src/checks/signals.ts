/**
 * Structured signals, read before any text (rule-11 coverage package; made strict by the owner's decision on review item S1,
 * 15 Nov 2026, under R11-1).
 *
 * A conflict refusal (MWS-CONC-2) and a refusal of a probed value (MWS-IN-4, R10-3) count by a signal only where the server
 * returns it as a structured field: the result's structured content (or a whole-JSON answer the session parses as such), a
 * JSON-RPC error code, an HTTP status or an error code at the top level of that object or of its `error` object. Text is never
 * read for a signal: an HTTP status, a Kubernetes message or an SDK validation string inside free text decides nothing (a
 * built-in reading may only add a note, R11-1). Where no structured signal is found, the existing reading follows (the
 * argument named, a declared pattern); otherwise the record needs reading.
 */

export interface Signal {
  /** The source, as printed in the record. */
  source: string;
  /** Always a structured field or a JSON-RPC code. */
  kind: 'structured';
  /** The field it was found in. */
  quote: string;
}

import { reservedCode, shapeOf, type ShapeCapture } from './shape.js';

type Answer = { text: string | null; data?: unknown; rpc_error?: { code: number; message: string } | null; hay?: string; tool?: string; shape?: ShapeCapture | null; extracted?: { refusals: boolean } | null };
/** Kept for the callers' signature; the reading is the same for a success and an error (structured content only). */
type Mode = { success?: boolean };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The objects a signal is looked for in: the structured content and its `error` object, top level only (review: a status or
 * code deeper in an echoed object is the object's own data, not the answer's).
 */
function objectsOf(a: Answer, _m: Mode = {}): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  // why: CLI feature A: a document the manifest's decode.extract took out of the text classifies a refusal only where declared (refusals: true).
  if (a.extracted && !a.extracted.refusals) return out;
  if (isObj(a.data)) {
    out.push(a.data);
    if (isObj(a.data['error'])) out.push(a.data['error']);
  }
  return out;
}

const STATUS_KEYS = new Set(['status', 'statuscode', 'status_code', 'http_status', 'httpstatus', 'code']);
const CODE_KEYS = new Set(['code', 'error_code', 'errorcode', 'error']);

function statusField(a: Answer, codes: number[], m: Mode = {}): Signal | null {
  for (const o of objectsOf(a, m))
    for (const [k, v] of Object.entries(o)) {
      // why: review: `code` counts only as a number; a three-digit string under `code` is an identifier as often as a status.
      const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{3}$/.test(v) && k.toLowerCase() !== 'code' ? Number(v) : null;
      if (n !== null && codes.includes(n) && STATUS_KEYS.has(k.toLowerCase())) return { source: `HTTP status ${n} in the field ${k}`, kind: 'structured', quote: `"${k}": ${JSON.stringify(v)}` };
    }
  return null;
}

function codeField(a: Answer, values: string[], what: string, m: Mode = {}): Signal | null {
  for (const o of objectsOf(a, m))
    for (const [k, v] of Object.entries(o)) if (typeof v === 'string' && CODE_KEYS.has(k.toLowerCase()) && values.includes(v.toLowerCase())) return { source: `${what} code ${JSON.stringify(v)} in the field ${k}`, kind: 'structured', quote: `"${k}": ${JSON.stringify(v)}` };
  return null;
}

const CONFLICT_CODES = ['conflict', 'version_conflict', 'precondition_failed', 'edit_conflict', 'stale_version', 'version_mismatch'];

/**
 * A code that an adopted result shape reserves (B-9 v2), where the tool adopts the shape and the result carries it well formed:
 * a structured member, so it counts as a signal (spec 7.3, rule 11). A code the version does not reserve is free content.
 */
function shapeCode(a: Answer, codes: string[]): Signal | null {
  const code = reservedCode(shapeOf(a));
  return code && codes.includes(code) ? { source: `the adopted result shape's reserved code ${JSON.stringify(code)} (mws.code)`, kind: 'structured', quote: `"mws.code": ${JSON.stringify(code)}` } : null;
}

/** MWS-CONC-2: does the structured content carry a conflict (409, 412, a Status reason Conflict, a conflict code, conflict: true)? */
export function conflictSignal(a: Answer, m: Mode = {}): Signal | null {
  // why: B-9 v2: an adopted result shape's code conflict is a refusal because the object changed since the state the call carried.
  // `locked` is a control that is not a version (MWS-CONC-1), so it does not show a stale version refused.
  const sh = shapeCode(a, ['conflict']);
  if (sh) return sh;
  for (const o of objectsOf(a, m)) {
    for (const [k, v] of Object.entries(o)) {
      if (k === 'conflict' && v === true) return { source: 'the field conflict: true', kind: 'structured', quote: '"conflict": true' };
      // why: the form of a Kubernetes Status; any backend may answer in it, so the source names the form and no product.
      if (k === 'reason' && v === 'Conflict' && (o['kind'] === 'Status' || o['code'] === 409)) return { source: 'a status object with reason Conflict', kind: 'structured', quote: '"reason": "Conflict"' };
    }
  }
  return statusField(a, [409, 412], m) ?? codeField(a, CONFLICT_CODES, 'a conflict', m);
}

/** MWS-CONC-2, the version-left-out run: a 428 or a precondition-required code in the structured content. */
export function versionRequiredSignal(a: Answer): Signal | null {
  return shapeCode(a, ['version_required']) ?? statusField(a, [428]) ?? codeField(a, ['precondition_required', 'version_required', 'missing_version'], 'a version-required');
}

/** MWS-IN-4 / R10-3: a validation signal: JSON-RPC -32602 as the error's code, or a validation code or 422 in the structured content. */
export function rejectSignal(a: Answer): Signal | null {
  if (a.rpc_error?.code === -32602) return { source: 'JSON-RPC error -32602 (invalid params)', kind: 'structured', quote: 'code -32602' };
  return codeField(a, ['invalid', 'invalid_argument', 'invalid_arguments', 'invalid_params', 'validation_error', 'invalid_input', 'unprocessable_entity'], 'a validation') ?? statusField(a, [422]);
}

/** The line a record carries for a signal (the source and the quote). */
export const signalLine = (s: Signal): string => `Decided by a structured signal, before any text reading: ${s.source} (${JSON.stringify(s.quote)}).`;
