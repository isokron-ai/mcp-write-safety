/**
 * The echo filter of MWS-RES-3 and MWS-RES-4: what in a write's answer counts as the server's evidence of the effect.
 *
 * A tool that answers with its own request (a SQL tool that returns the statement it ran, a tool that returns the arguments
 * it was sent) carries the identifier and the values the call named, whether or not anything was written. Such an echo is
 * not a receipt.
 *
 * The rule:
 *   - a value the tester credits (an identifier, a version, a field's name or new value) that does NOT appear verbatim in the
 *     call's arguments counts as before;
 *   - a value that DOES appear verbatim in the arguments counts only where the answer also carries server data: data the
 *     request did not contain that states something of the backend (see serverData), or an adopted result shape (B-9),
 *     which is the server's own statement about the write;
 *   - an answer with nothing but the request's content, fixed words (`ok`, `success`, `executed`, prose without a number) and
 *     facts about the call itself (how long it took, a status code, the operation's name) shows no effect, and the record is
 *     `not tested`, never `held` (and never `violated`: an echo is not a missing receipt).
 *
 * A true receipt that repeats a request value beside server state ("T-1 updated: title = New, version 4") still holds. The
 * filter only demotes an answer that is the request and nothing of the backend's own.
 */

import { isObj } from '../core/util.js';
import { mentions, type CallBrief } from './types.js';
import { shapeOf } from './shape.js';

/** The arguments as stored in an observation: past this size they are not kept, and the filter does not apply. */
const MAX_ARGS = 32 * 1024;

/** The arguments a call sent, as kept in the observation (null past the size limit: no filter, as in older evidence). */
export function keptArgs(args: unknown): unknown {
  if (args === undefined) return null;
  const s = JSON.stringify(args ?? null);
  return s.length > MAX_ARGS ? { clipped: true, bytes: s.length } : args;
}

/** Every key and scalar value of the arguments, one per line: what "appears verbatim in the request" is searched in. */
export function requestHay(args: unknown): string | null {
  if (args === null || args === undefined) return null;
  if (isObj(args) && args['clipped'] === true && typeof args['bytes'] === 'number' && Object.keys(args).length === 2) return null;
  const out: string[] = [];
  const walk = (x: unknown): void => {
    if (x === null || x === undefined) return;
    if (Array.isArray(x)) x.forEach(walk);
    else if (isObj(x))
      for (const [k, v] of Object.entries(x)) {
        out.push(k);
        walk(v);
      }
    else out.push(String(x));
  };
  walk(args);
  return out.join('\n');
}

/** Does the value appear verbatim in the request, as a whole token (as `mentions` reads an answer)? */
export const inRequest = (hay: string, v: unknown): boolean => mentions({ text: hay, data: null }, v);

/** Words that acknowledge a call without reporting anything of the backend's own state. */
const ACK = /^(ok|okay|success|successful|successfully|succeeded|done|executed|complete|completed|finished|processed|acknowledged|accepted|applied|saved|updated|created|inserted|written|true|false|yes|no|null|none|undefined|text|json)$/i;

/**
 * Keys under which a structured value states something of the backend, read by the key's words (`rowsAffected` → rows,
 * affected; `updated_at` → updated, at): a count of what the write touched, an identifier, a version, a state, or the time of
 * a write. A key that is a field of the object as the tester read it back counts too.
 */
const wordsOf = (key: string): string[] => key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const COUNT_WORD = /^(count|rowcount|rows|affected|changes|changed|inserted|updated|deleted|modified|matched|upserted)$/;
const ID_WORD = /^(id|uid|uuid|rowid|version|revision|rev|etag|generation|seq|sequence)$/;
/** An identifier of the call, not of anything the backend holds (request_id, trace_id, session_id). */
const CALL_WORD = /^(request|req|trace|span|session|correlation|connection|conn|call|invocation|message|msg|rpc|client|user|tenant)$/;
const STATE_WORD = /^(status|state|phase|stage)$/;
const WRITTEN_WORD = /^(created|updated|modified|changed|deleted|written|inserted|mtime|ctime)$/;
const WRITE_STEM = /^(creat|updat|modif|chang|delet|writ|insert)/;
const TIME_WORD = /^(at|on|time|date|ts|timestamp)$/;
type KeyKind = 'count' | 'id' | 'state' | 'time' | 'field' | null;
function keyKind(key: string, objectKeys: readonly string[]): KeyKind {
  const w = wordsOf(key);
  const last = w.at(-1) ?? '';
  const prev = w.at(-2) ?? '';
  if (COUNT_WORD.test(last)) return 'count';
  if (ID_WORD.test(last)) return CALL_WORD.test(prev) ? null : 'id';
  if (STATE_WORD.test(last)) return 'state';
  if (WRITTEN_WORD.test(last) || (TIME_WORD.test(last) && WRITE_STEM.test(prev))) return 'time';
  return objectKeys.includes(key) ? 'field' : null;
}
/** Keys that only carry a result (`result`, `data`, `message`): their scalar is read as free text is. */
const CARRIER_KEY = /^(result|results|data|value|output|text|content|message|detail|details|info|summary)$/i;

/** A duration in a free text ("12 ms", "0.3s"): how long the call took is not the backend's state. */
const DURATION = /(^|[^A-Za-z0-9_.-])\d+(?:\.\d+)?\s*(?:ns|µs|us|ms|msec|millis|milliseconds?|s|secs?|seconds?)(?![A-Za-z0-9_-])/gi;
/** A status code in a free text ("HTTP 200", "status: 200", "200 OK", "exit code 0"): how the call was answered, not what the backend holds. */
const STATUS_CODE = /\b(?:http|status|code|errno|exit)(?:[\s_-]*code)?\s*[:=]?\s*\d{1,3}\b|\b\d{3}\s+OK\b/gi;
/** A count stated in words ("1 row", "2 documents"): the server's figure even where the number is also in the request. */
const COUNT_PHRASE = /\b\d+\s+(?:rows?|records?|documents?|docs?|items?|entries|objects?)\b/gi;

/** A date or a time of day in a free text. It counts only right after a word that names a write ("updated_at 2026-…"): the time an answer was made, or a log line's stamp, is not the backend's state. */
const STAMP = /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?|(?<![A-Za-z0-9_.-])\d{1,2}:\d{2}(?::\d{2})?(?![A-Za-z0-9_-])/g;
const AFTER_WRITE_WORD = /(creat|updat|modif|chang|writ|insert|delet)[a-z]*[\s_]*(at|on|time|date)?[\s:=]*$/i;

/** Tokens of a free text that could carry server state: they hold a digit (a count, an id, a version, the time of a write). */
const tokens = (s: string): string[] =>
  (s.replace(STAMP, (m, at: number) => (AFTER_WRITE_WORD.test(s.slice(Math.max(0, at - 32), at)) ? m : ' ')).replace(DURATION, '$1 ').replace(STATUS_CODE, ' ').match(/[A-Za-z0-9][A-Za-z0-9_.:/-]*/g) ?? []).map((t) => t.replace(/[.:/-]+$/, '')).filter((t) => /\d/.test(t));

/** The text as a JSON object or array, where it is one (a text block that mirrors the structured content). */
function jsonOf(text: string): unknown {
  const t = text.trim();
  if (!/^[[{]/.test(t)) return undefined;
  try {
    const v: unknown = JSON.parse(t);
    return typeof v === 'object' && v !== null ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The server data in an answer (at most `max` items, each quoted with where it was found): what it carries that the request
 * did not contain and that states something of the backend. Empty: the answer is the request's content, fixed words, and
 * facts about the call itself.
 *
 *   - an adopted result shape (B-9);
 *   - in structured content (and in a text that is JSON), a number or a one-word string under a key that names a count, an
 *     identifier, a version, a state or the time of a write, or under a field of the object as read back (`objectKeys`):
 *     where the arguments do not hold the value, and for a count also where the request nowhere names its key (a count of
 *     1 beside a priority of 1). Under any other key (how long the call took, a status code, the name of the operation or
 *     of the database, a size, an identifier of the call such as request_id) a value is not server data;
 *   - in free text (the text blocks, a string of several words, a scalar under a key that only carries a result): a token
 *     with a digit that the arguments do not hold (a generated id, a version), a count stated in words ("1 row") that the
 *     request does not contain, and a date or time right after a word that names a write ("updated_at 2026-…"). A duration
 *     ("12 ms"), a status code ("HTTP 200") and any other date or time (when the answer was made) are not server data.
 */
export function serverData(b: Pick<CallBrief, 'text' | 'data'> & Partial<Pick<CallBrief, 'tool' | 'shape' | 'hay'>>, hay: string, max = 3, objectKeys: readonly string[] = []): string[] {
  const out: string[] = [];
  const add = (s: string) => {
    if (out.length < max && !out.includes(s)) out.push(s);
  };
  // why: an adopted result shape (B-9) is the server's own statement about the write, made by declaration (rule 11), not an echo.
  const sh = shapeOf(b);
  if (sh) add(`an adopted result shape (structuredContent.mws${sh.outcome ? `, outcome ${JSON.stringify(sh.outcome)}` : ''})`);
  const lower = hay.toLowerCase();
  const free = (s: string, where: string): void => {
    for (const m of s.match(COUNT_PHRASE) ?? []) if (!lower.includes(m.toLowerCase())) add(`${where}: ${JSON.stringify(m)}`);
    for (const t of tokens(s)) if (!inRequest(hay, t)) add(`${where}: ${JSON.stringify(t)}`);
  };
  const walk = (x: unknown, path: string): void => {
    if (out.length >= max || x === null || x === undefined || typeof x === 'boolean') return;
    if (Array.isArray(x)) return x.forEach((y, i) => walk(y, `${path}[${i}]`));
    if (isObj(x)) {
      for (const [k, v] of Object.entries(x)) walk(v, path ? `${path}.${k}` : k);
      return;
    }
    const where = path || '(value)';
    const key = path.replace(/(\[\d+\])+$/, '').split('.').pop() ?? '';
    if (typeof x === 'string' && (/\s/.test(x) || x.length > 200)) return free(x, where);
    if (key === '' || CARRIER_KEY.test(key)) return free(String(x), where);
    // why: the answer of an echoing tool also carries facts about the call (duration_ms, statusCode, operation, database,
    // request_id): they are not in the request, and they say nothing of what the backend now holds. Only a key that names
    // backend state counts.
    const kind = keyKind(key, objectKeys);
    if (kind === null) return;
    if (typeof x === 'number') {
      // why: a small count can coincide with a number the request holds (count: 1 beside priority 1); under a count's key that the
      // request nowhere names (as a key, or inside a statement it sent) it is the server's figure all the same. An identifier or
      // a version gets no such pass: `id: 42` after a request with `ticket_id: 42` is the request's own value under another name.
      // A number under a state key is a status code (status: 200), not a state.
      if (kind !== 'state' && Number.isFinite(x) && (!inRequest(hay, String(x)) || (kind === 'count' && !inRequest(hay, key)))) add(`${where}: ${x}`);
    } else if (typeof x === 'string' && x && !ACK.test(x) && !(kind === 'state' && /^\d+$/.test(x)) && !inRequest(hay, x)) add(`${where}: ${JSON.stringify(x)}`);
  };
  const clipped = isObj(b.data) && b.data['clipped'] === true;
  if (!clipped) walk(b.data, '');
  const text = clipped ? (b.hay ?? '') : (b.text ?? '');
  // why: a text block that is the JSON of the structured content is read by key, as the structured content is; read as free
  // text its numbers would all count (the 12 of "duration_ms": 12).
  const doc = clipped ? undefined : jsonOf(text);
  if (doc !== undefined) walk(doc, '');
  else free(text, 'the text');
  return out;
}

/** How the answer stands for the echo filter: the request it is read against, and the server data it carries. */
export interface Echo {
  /** null: the arguments were not kept (older evidence, or too large); the filter does not apply. */
  hay: string | null;
  server: string[];
}

/** `objectKeys`: the fields of the object as the tester read it back, where it did (a value under one of them is the object's state). */
export function echoOf(b: Pick<CallBrief, 'text' | 'data'> & Partial<Pick<CallBrief, 'tool' | 'shape' | 'hay'>>, args: unknown, objectKeys: readonly string[] | null = null): Echo {
  const hay = requestHay(args);
  return { hay, server: hay === null ? [] : serverData(b, hay, 3, objectKeys ?? []) };
}

/**
 * Does the answer carry the value as evidence (yes), carry it only as an echo of the request (echo), or not at all (no)?
 * `found`: whether the answer mentions it, as the caller read it (a mention, a shape member, a field name or value).
 */
export function credit(found: boolean, e: Echo, v: unknown): 'yes' | 'echo' | 'no' {
  if (!found) return 'no';
  // why: rule above: a value in the request counts only beside data the request did not contain.
  if (e.hay === null || !inRequest(e.hay, v) || e.server.length) return 'yes';
  return 'echo';
}

/** The record's line on a value counted only because the answer carries server data besides the echo. */
export function echoNote(e: Echo, echoed: string[]): string | null {
  if (!echoed.length || e.hay === null) return null;
  return `Echo filter (MWS-RES-3, RES-4): ${echoed.join(', ')} ${echoed.length > 1 ? 'appear' : 'appears'} verbatim in the call's arguments; counted because the answer also carries data the request did not contain (${e.server.join('; ')}).`;
}

/** The reason of a record left open because the answer only echoes the request. */
export function echoReason(tool: string, echoed: string[]): string {
  return `${tool}'s answer carries ${echoed.join(', ')} only as an echo of the request: ${echoed.length > 1 ? 'they appear' : 'it appears'} verbatim in the call's arguments, and the answer carries nothing of the backend's own that the request did not contain (no server-reported count, generated id, version, state or time of the write), so it does not show the effect; an echo is not a receipt`;
}

/**
 * The items of one receipt read through the echo filter. `any(label, alternatives)`: each alternative is whether the answer
 * names the item that way and the value it names it by (an identifier, a field's name, its new value). The item is present
 * where any alternative is found; it is kept apart in `echoOnly` where every way it is found is an echo of the request.
 */
export class Tally {
  readonly echoOnly: string[] = [];
  /** Items found by a value from the request, counted because the answer carries server data too. */
  readonly counted: string[] = [];
  constructor(readonly e: Echo) {}
  any(label: string, alts: [boolean, unknown][]): boolean {
    let echo = false;
    for (const [found, v] of alts) {
      const k = credit(found, this.e, v);
      if (k === 'yes') {
        if (this.e.hay !== null && inRequest(this.e.hay, v)) this.counted.push(label);
        return true;
      }
      if (k === 'echo') echo = true;
    }
    if (echo) this.echoOnly.push(label);
    return echo;
  }
  /** The record's notes line where an item was counted beside server data; null otherwise. */
  note(): string | null {
    return echoNote(this.e, this.counted);
  }
}
