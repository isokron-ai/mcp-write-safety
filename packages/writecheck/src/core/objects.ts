/**
 * Creating the run's own objects. Every create is announced in the ledger first; its result is
 * recorded after. An id the server returns is not trusted: it is read back through the read tool
 * and must be an object carrying this run's prefix before anything updates or deletes it. An id
 * that does not verify is recorded as an unknown outcome (the prefix sweep may still find the real
 * object) and is never written to.
 */

import { baseVars, objectFrom } from './driver.js';
import type { Ledger } from './ledger.js';
import type { ResourceSpec } from './manifest.js';
import { BudgetExhausted, Interrupted, type CallResult, type Session } from './session.js';
import { render, type Env } from './template.js';
import { getPath, short } from './util.js';

export interface Created {
  ok: boolean;
  id: unknown;
  call: CallResult | null;
  reason: string;
  intent: number;
}

/** A list read (read.items) that answered with a list: only then does the object's absence from it mean it is gone. */
export const listed = (res: ResourceSpec, data: unknown): boolean => !!res.read.items && Array.isArray(getPath(data, res.read.items));

/** A read failure that says the object does not exist (not a timeout, not some other error). */
const NOT_FOUND = /not[ _-]?found|\b404\b|no such|does not exist|doesn't exist/i;
export const definitelyGone = (r: { ok: boolean; timed_out: boolean; transport_error: string | null; text: string | null; rpc_error: { message: string } | null }): boolean =>
  !r.ok && !r.timed_out && r.transport_error === null && NOT_FOUND.test(r.text ?? r.rpc_error?.message ?? '');
/**
 * A read answered without isError whose content is no object, only a sentence that says it was not found or that nothing
 * matched (Payload's shapes):
 * the object is gone. Such a sentence is never taken for the object.
 */
export const notFoundWithoutError = (r: { ok: boolean; timed_out: boolean; transport_error: string | null; text: string | null }, obj: unknown): boolean =>
  r.ok && !r.timed_out && r.transport_error === null && (obj === null || obj === undefined) && (NOT_FOUND.test(r.text ?? '') || EMPTY_LIST.test(r.text ?? ''));
/** An answer that says it found nothing: "Total: 0 documents", "0 results" (Payload's read through `where`, P1 of the 169b0cb re-run). */
const EMPTY_LIST = /\b(total|count|found)\W{0,3}0\b|\b0 (documents|results|items|objects|records|matches)\b|^\s*\[\s*\]\s*$/im;

/**
 * Is the object gone, from a read-back? true: a definite not-found (or a list read that answered
 * without it); false: it read back; null: the read's outcome is unknown (a timeout, a broken
 * connection, another error), which must never be judged either way.
 */
export function goneFrom(res: ResourceSpec, r: { ok: boolean; obj: unknown; call: { ok: boolean; timed_out: boolean; transport_error: string | null; text: string | null; rpc_error: { message: string } | null } | null }): boolean | null {
  const c = r.call;
  if (!c || c.timed_out || c.transport_error !== null) return null;
  if (definitelyGone(c)) return true;
  // why: Payload N3: a list read whose answer has no list at all says nothing about the object.
  if (c.ok && r.obj === null && listed(res, (c as { data?: unknown }).data)) return true;
  if (notFoundWithoutError(c, r.obj)) return true;
  return r.ok ? false : null;
}

/**
 * The answer the read tool gives for an id that does not exist (`missing_id`, else one made from the run prefix), with the id
 * masked, once per resource and session; null where that answer is no use as a pattern: it timed out, broke, is a JSON-RPC
 * error, holds an object, or carries the run prefix.
 *
 * why: gate-2 re-run on 6b028ec (note 14 items 6 and 7, T5 and T9): servers answer a read of a missing id without isError in
 * shapes no wording list covers (`{"ticket": null}`, `{"docs": [], "totalDocs": 0}`, an empty content, "None", "0 tickets").
 * The server's own answer for an id that never existed is the pattern: a read-back that gives the same answer (the id masked)
 * shows the object is gone, and nothing else does.
 */
const notFoundAnswers = new WeakMap<object, Map<string, Promise<string | null>>>();
const fingerprint = (r: { ok: boolean; text: string | null }, id: unknown): string => {
  const s = id === null || id === undefined ? '' : String(id);
  const t = (r.text ?? '').trim();
  return `${r.ok ? 'ok' : 'error'}|${s ? t.split(s).join('\u0000') : t}`;
};

export function notFoundAnswer(session: Session, res: ResourceSpec, prefix: string, label: string, sample: unknown): Promise<string | null> {
  let m = notFoundAnswers.get(session);
  if (!m) notFoundAnswers.set(session, (m = new Map()));
  let p = m.get(res.name);
  if (!p) {
    p = (async () => {
      const missing = res.missing_id ?? (typeof sample === 'number' ? 2_000_000_000 + Math.floor(Math.random() * 100_000_000) : `${prefix}missing-${Math.random().toString(16).slice(2, 10)}`);
      try {
        const r = await session.call(label, res.read.tool, render(res.read.args, baseVars(res, prefix, { id: missing })), { write: false, step: session.stepId(`notfound.${res.name}`) });
        // why: review: only an answer without isError is a pattern; a failed read can be any failure (a 429, a 500) worded the
        // same way for every id, and an error is judged by its wording (definitelyGone) as before.
        if (r.timed_out || r.transport_error !== null || r.rpc_error || !r.ok) return null;
        if (objectFrom(res, r.data, missing) !== null) return null;
        const fp = fingerprint(r, missing);
        if (fp.includes(prefix)) return null;
        return fp;
      } catch {
        return null;
      }
    })();
    m.set(res.name, p);
  }
  return p;
}

/** Does a read-back of `id` give the server's answer for an id that does not exist? (Never true for an answer that holds the object.) */
export async function goneByAnswer(session: Session, res: ResourceSpec, prefix: string, label: string, r: CallResult | null | undefined, id: unknown): Promise<boolean> {
  if (!r || r.timed_out || r.transport_error !== null || r.rpc_error || !r.ok) return false;
  if (objectFrom(res, r.data, id) !== null) return false;
  const fp = await notFoundAnswer(session, res, prefix, label, id);
  return fp !== null && fp === fingerprint(r, id);
}

/** Whether the read tool takes the object's id (a read by id), as opposed to a list that ignores it. */
export const readsById = (res: ResourceSpec): boolean => /\{\{\s*(json:)?id\b/.test(JSON.stringify(res.read.args ?? null));

/** The id in a create result: by path in the structured result, or by the regex's first group over the text. */
export function idFromResult(res: ResourceSpec, r: CallResult, path: string | null = res.create?.id ?? null): unknown {
  if (path) {
    const v = getPath(r.data, path);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  const re = res.create?.id_regex;
  if (re && r.text) {
    const m = new RegExp(re).exec(r.text);
    if (m && m[1]) return /^\d+$/.test(m[1]) ? Number(m[1]) : m[1];
  }
  return null;
}

/** Does the object read back under `id` carry the run prefix (at name_path, or anywhere in its JSON)? */
export async function verifyOwn(session: Session, res: ResourceSpec, id: unknown, prefix: string, label: string, step: string): Promise<{ ok: boolean; name: string | null; reason: string }> {
  const r = await session.call(label, res.read.tool, render(res.read.args, baseVars(res, prefix, { id })), { step, write: false });
  if (!r.ok) return { ok: false, name: null, reason: `the returned id ${short(id, 60)} did not read back (${short(r.text ?? r.rpc_error?.message ?? 'error', 120)})` };
  const obj = objectFrom(res, r.data, id);
  if (obj === null) return { ok: false, name: null, reason: `the returned id ${short(id, 60)} is not in the read result` };
  const name = res.create?.name_path ? getPath(obj, res.create.name_path) : null;
  const carries = typeof name === 'string' ? name.includes(prefix) : JSON.stringify(obj ?? null).includes(prefix);
  return carries ? { ok: true, name: typeof name === 'string' ? name : null, reason: '' } : { ok: false, name: null, reason: `the object read back under id ${short(id, 60)} does not carry this run's prefix ${prefix}` };
}

/** Create one object through a tool, with the ledger around it and the id verified. */
export async function createVerified(session: Session, ledger: Ledger, res: ResourceSpec, prefix: string, o: { tool: string; args: unknown; purpose: string; label: string; step: string; meta?: Record<string, unknown>; idPath?: string | null; env?: Env; paced?: boolean; counted?: boolean }): Promise<Created> {
  const intent = ledger.intent(res.name, o.tool, o.purpose);
  let r: CallResult;
  try {
    r = await session.call(o.label, o.tool, o.args, { step: o.step, ...(o.meta ? { meta: o.meta } : {}), ...(o.paced ? { paced: true } : {}), ...(o.counted ? { counted: true } : {}) });
  } catch (e) {
    // why: an interrupted run or an exhausted budget refuses before anything is sent; any other throw leaves the outcome open.
    if (e instanceof Interrupted || e instanceof BudgetExhausted) ledger.append({ kind: 'create_failed', intent, resource: res.name, reason: `not sent: ${(e as Error).message}` });
    else ledger.append({ kind: 'create_unknown', intent, resource: res.name, reason: (e as Error).message });
    throw e;
  }
  if (r.timed_out || r.transport_error) {
    ledger.append({ kind: 'create_unknown', intent, resource: res.name, reason: r.timed_out ? 'the create timed out; it may have been applied' : `transport error: ${r.transport_error}` });
    return { ok: false, id: null, call: r, reason: 'outcome unknown', intent };
  }
  if (!r.ok) {
    // why: gate-2 re-run on 378f32f (note 19, R7): an error can come after the backend applied the create. The marker the
    // create carried goes into the ledger, so that clean-up looks for such an object by it and removes it.
    const marker = createMarker(o.args, prefix);
    ledger.append({ kind: 'create_failed', intent, resource: res.name, reason: short(r.text ?? r.rpc_error?.message ?? 'error', 200), ...(marker ? { marker } : {}) });
    return { ok: false, id: null, call: r, reason: `the create failed: ${short(r.text ?? r.rpc_error?.message ?? 'error', 200)}`, intent };
  }
  const id = idFromResult(res, r, o.idPath === undefined ? (res.create?.id ?? null) : o.idPath);
  if (id === null) {
    ledger.append({ kind: 'create_unknown', intent, resource: res.name, reason: 'the create reported success but its result carries no id the manifest can find' });
    return { ok: false, id: null, call: r, reason: 'no id in the create result', intent };
  }
  let v: { ok: boolean; name: string | null; reason: string };
  try {
    v = await verifyOwn(session, res, id, prefix, o.label, session.stepId(`${o.step}.verify`));
  } catch (e) {
    ledger.append({ kind: 'create_unknown', intent, resource: res.name, reason: `created as ${short(id, 60)}, but the id could not be verified: ${(e as Error).message}` });
    throw e;
  }
  if (!v.ok) {
    ledger.append({ kind: 'create_unknown', intent, resource: res.name, reason: v.reason });
    return { ok: false, id, call: r, reason: v.reason, intent };
  }
  ledger.append({ kind: 'created', intent, resource: res.name, id, name: v.name, via: 'result' });
  return { ok: true, id, call: r, reason: '', intent };
}

/** The run's marker a create carried: the first string argument that starts with the run prefix (`{{marker}}`, `{{key}}`). */
export function createMarker(args: unknown, prefix: string): string | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  for (const v of Object.values(args as Record<string, unknown>)) if (typeof v === 'string' && v.startsWith(prefix) && v.length > prefix.length) return v;
  return null;
}

/** An object's listed name is the marker, or the marker followed by a separator (never another marker that extends it: -cr5 vs -cr55). */
export const nameIsMarker = (name: unknown, marker: string): boolean => typeof name === 'string' && (name === marker || (name.startsWith(marker) && /^[^A-Za-z0-9]/.test(name.slice(marker.length))));

/** Record an object created outside the tool under test (through the control), with the same ledger discipline. */
export async function createViaControl(session: Session, ledger: Ledger, res: ResourceSpec, prefix: string, o: { create: () => Promise<{ ok: boolean; id: unknown; status: number | null; error: string | null }>; purpose: string; label: string; step: string }): Promise<Created> {
  const intent = ledger.intent(res.name, 'control.create', o.purpose);
  let c: { ok: boolean; id: unknown; status: number | null; error: string | null };
  try {
    c = await o.create();
  } catch (e) {
    if (e instanceof Interrupted || e instanceof BudgetExhausted) ledger.append({ kind: 'create_failed', intent, resource: res.name, reason: `not sent: ${(e as Error).message}` });
    else ledger.append({ kind: 'create_unknown', intent, resource: res.name, reason: (e as Error).message });
    throw e;
  }
  if (c.status === null) {
    ledger.append({ kind: 'create_unknown', intent, resource: res.name, reason: `the control create got no answer (${c.error ?? 'no status'}); it may have been applied` });
    return { ok: false, id: null, call: null, reason: 'outcome unknown', intent };
  }
  if (!c.ok || c.id === null) {
    ledger.append(c.ok ? { kind: 'create_unknown', intent, resource: res.name, reason: 'the control create answered without an id at control.create.id' } : { kind: 'create_failed', intent, resource: res.name, reason: `HTTP ${c.status}` });
    return { ok: false, id: null, call: null, reason: c.ok ? 'no id in the control answer' : `the control create failed (HTTP ${c.status})`, intent };
  }
  const v = await verifyOwn(session, res, c.id, prefix, o.label, session.stepId(`${o.step}.verify`));
  if (!v.ok) {
    ledger.append({ kind: 'create_unknown', intent, resource: res.name, reason: v.reason });
    return { ok: false, id: c.id, call: null, reason: v.reason, intent };
  }
  ledger.append({ kind: 'created', intent, resource: res.name, id: c.id, name: v.name, via: 'result' });
  return { ok: true, id: c.id, call: null, reason: '', intent };
}
