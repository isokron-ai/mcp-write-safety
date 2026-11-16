/**
 * The barrier pair: two writes released together. Both server processes (or sessions) are started
 * and initialized first, the write budget is reserved for both halves, the shared rate limit is
 * waited once, then both requests are issued in the same event-loop turn. Mode `separate` uses two
 * server processes (two independent clients); `same` sends both requests to one process. The client
 * side of the overlap is measured: min(end) − max(start) > 0 means both were in flight together.
 */

import type { Driver } from './driver.js';
import type { Half } from './experiment.js';
import type { CallResult, HttpResult, Session } from './session.js';
import type { Env } from './template.js';
import { readRef } from './conditions.js';
import { setPath } from './util.js';

export type HalfResult = CallResult | HttpResult | { exception: string; step: string };

export interface PairResult {
  kind: 'pair';
  step: string;
  mode: 'same' | 'separate';
  a: HalfResult;
  b: HalfResult;
  servers: { a: string | null; b: string | null };
  /** Client side: min(end) − max(start); > 0 means the two requests were in flight together. */
  overlap_ms: number | null;
  start_skew_ms: number | null;
}

const okResult = (r: HalfResult): r is CallResult | HttpResult => !('exception' in r);
export const halfOk = (r: HalfResult): boolean => okResult(r) && r.ok;
/** The client does not know what happened: a timeout, a broken connection, an exception. */
export const halfIndeterminate = (r: HalfResult): boolean => !okResult(r) || (r.kind === 'call' ? r.timed_out || r.transport_error !== null : r.status === null);

/** The value a half writes: a variable or earlier result named by the half (`VA`), read from the environment. */
const valueOf = (ref: string, env: Env): unknown => readRef(ref, env);

export async function pair(s: Session, d: Driver, a: Half, b: Half, env: Env, o: { mode: 'same' | 'separate'; step: string; labels: { a: string; b: string; same: string } }): Promise<PairResult> {
  const label = (h: Half, which: 'a' | 'b'): string | null => (h.kind === 'update' ? (h.server ?? (o.mode === 'same' ? o.labels.same : o.labels[which])) : null);
  const la = label(a, 'a');
  const lb = label(b, 'b');
  for (const l of [la, lb]) if (l) await s.connect(l);
  // The budget is checked for both halves before the release, so a refusal never fires half a pair.
  s.reserveWrites(2, `pair ${o.step}`);
  await s.pace();
  const fire = async (h: Half, which: 'a' | 'b', l: string | null): Promise<HalfResult> => {
    const step = `${o.step}.${which}`;
    try {
      const field = d.fields[h.field];
      const value = valueOf(h.value, env);
      if (h.kind === 'control_patch') return await d.controlPatch(field, value, step, { paced: true, counted: true });
      if (h.kind === 'control_write') {
        const b = env[h.base] as { obj: unknown; version: unknown };
        return await d.controlWrite(setPath(b.obj, field.path, value), b.version, step, { paced: true, counted: true });
      }
      const base = h.base ? (env[h.base] as { obj: unknown; version: unknown }) : null;
      return await d.update(l!, field, value, { step, base, paced: true, counted: true });
    } catch (e) {
      return { exception: (e as Error).message, step };
    }
  };
  // The barrier: both promises are created before either is awaited.
  const pa = fire(a, 'a', la);
  const pb = fire(b, 'b', lb);
  const [ra, rb] = await Promise.all([pa, pb]);
  let overlap: number | null = null;
  let skew: number | null = null;
  if (okResult(ra) && okResult(rb)) {
    overlap = Math.min(ra.t_end_ms, rb.t_end_ms) - Math.max(ra.t_start_ms, rb.t_start_ms);
    skew = Math.abs(ra.t_start_ms - rb.t_start_ms);
  }
  return { kind: 'pair', step: o.step, mode: o.mode, a: ra, b: rb, servers: { a: la, b: lb }, overlap_ms: overlap, start_skew_ms: skew };
}
