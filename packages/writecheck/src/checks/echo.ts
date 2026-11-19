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
 *   - a value that DOES appear verbatim in the arguments counts only where the answer also carries data the request did not
 *     contain: a number or an identifier-like token the arguments do not hold (a server-reported count:1, a generated id, a
 *     version, a timestamp), or an adopted result shape (B-9), which is the server's own statement about the write;
 *   - an answer with nothing but the request's content and fixed words (`ok`, `success`, `executed`, prose without a number)
 *     shows no effect, and the record is `not tested`, never `held` (and never `violated`: an echo is not a missing receipt).
 *
 * A true receipt that repeats a request value beside server state ("T-1 updated: title = New, version 4") still holds. The
 * filter is narrow on purpose: any server datum lifts it, so it only demotes an answer that is the request and nothing else.
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

/** The keys the arguments use, at any depth. */
function requestKeys(args: unknown): Set<string> {
  const out = new Set<string>();
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (isObj(x))
      for (const [k, v] of Object.entries(x)) {
        out.add(k);
        walk(v);
      }
  };
  walk(args);
  return out;
}

/** Does the value appear verbatim in the request, as a whole token (as `mentions` reads an answer)? */
export const inRequest = (hay: string, v: unknown): boolean => mentions({ text: hay, data: null }, v);

/** Words that acknowledge a call without reporting anything of the backend's own state. */
const ACK = /^(ok|okay|success|successful|succeeded|done|executed|complete|completed|accepted|applied|saved|updated|created|inserted|written|true|false|yes|no|null|none|undefined|text|json)$/i;

/** Tokens of a free text that could carry server state: they hold a digit (a count, an id, a version, a time). */
const tokens = (s: string): string[] => (s.match(/[A-Za-z0-9][A-Za-z0-9_.:/-]*/g) ?? []).map((t) => t.replace(/[.:/-]+$/, '')).filter((t) => /\d/.test(t));

/**
 * The data in an answer that the request did not contain (at most `max` items, each quoted with where it was found). Empty:
 * the answer is the request's content and fixed words alone.
 */
export function serverData(b: Pick<CallBrief, 'text' | 'data'> & Partial<Pick<CallBrief, 'tool' | 'shape' | 'hay'>>, hay: string, max = 3, reqKeys: Set<string> = new Set()): string[] {
  const out: string[] = [];
  const add = (s: string) => {
    if (out.length < max && !out.includes(s)) out.push(s);
  };
  // why: an adopted result shape (B-9) is the server's own statement about the write, made by declaration (rule 11), not an echo.
  const sh = shapeOf(b);
  if (sh) add(`an adopted result shape (structuredContent.mws${sh.outcome ? `, outcome ${JSON.stringify(sh.outcome)}` : ''})`);
  const clipped = isObj(b.data) && b.data['clipped'] === true;
  const walk = (x: unknown, path: string): void => {
    if (out.length >= max || x === null || x === undefined || typeof x === 'boolean') return;
    if (Array.isArray(x)) x.forEach((y, i) => walk(y, `${path}[${i}]`));
    else if (isObj(x)) for (const [k, v] of Object.entries(x)) walk(v, path ? `${path}.${k}` : k);
    else if (typeof x === 'number') {
      // why: a small count can coincide with a number the request holds (count: 1 beside priority 1); under a key the request does
      // not use that names a count, a version or an id, it is the server's figure all the same.
      const key = path.replace(/\[\d+\]$/, '').split('.').pop() ?? '';
      const counted = /(count|rows|affected|changes|changed|inserted|updated|deleted|version|revision|rev|etag|seq|id)$/i.test(key) && !reqKeys.has(key);
      if (Number.isFinite(x) && (counted || !inRequest(hay, String(x)))) add(`${path || '(value)'}: ${x}`);
    } else if (typeof x === 'string') {
      if (/\s/.test(x) || x.length > 200) {
        for (const t of tokens(x)) if (!inRequest(hay, t)) add(`${path || '(value)'}: ${JSON.stringify(t)}`);
      } else if (x && !ACK.test(x) && !inRequest(hay, x)) add(`${path || '(value)'}: ${JSON.stringify(x)}`);
    }
  };
  if (!clipped) walk(b.data, '');
  for (const t of tokens(clipped ? (b.hay ?? '') : (b.text ?? ''))) if (!inRequest(hay, t)) add(`the text: ${JSON.stringify(t)}`);
  return out;
}

/** How the answer stands for the echo filter: the request it is read against, and the server data it carries. */
export interface Echo {
  /** null: the arguments were not kept (older evidence, or too large); the filter does not apply. */
  hay: string | null;
  server: string[];
}

export function echoOf(b: Pick<CallBrief, 'text' | 'data'> & Partial<Pick<CallBrief, 'tool' | 'shape' | 'hay'>>, args: unknown): Echo {
  const hay = requestHay(args);
  return { hay, server: hay === null ? [] : serverData(b, hay, 3, requestKeys(args)) };
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
  return `${tool}'s answer carries ${echoed.join(', ')} only as an echo of the request: ${echoed.length > 1 ? 'they appear' : 'it appears'} verbatim in the call's arguments, and the answer carries nothing the request did not contain (no server-reported count, generated id, version or other server state), so it does not show the effect; an echo is not a receipt`;
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
