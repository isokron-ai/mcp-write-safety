// The fixture clock (0.3.0, feature `clock`; PLAN R4, review G7).
//
// It implements the frozen Clock interface (src/clock.ts). Two named domains:
//   wall     the process clock, offset 0. Every build without the clock
//            feature runs on it.
//   fixture  wall time plus an offset that only the control listener moves
//            (POST /_fixture/clock), for retention rehearsals.
// `now()` is in the clock's domain and gives every record time; `wallNow()` is
// always wall time and gives the times a schema says are wall time. Every
// event and record carries `offsetMs()` as clock_offset_ms, and the build
// descriptor names the domain and the offset, so a run whose evidence shows
// domain "wall", offset 0 and control off provably ran on wall time. The clock
// feature cannot start without --fixture-control (CMP-60), and the control
// listener is never part of a published delayed-recovery run.
//
// The offset only moves forward, in steps of at most MAX_STEP_MS, to at most
// MAX_OFFSET_MS (X5). Under --supervise the offset is kept in the supervisor's
// state folder: the backend child writes it, the MCP child reads it, and it
// survives a restart of either. With durable (0.4.0) every move is also a
// journal line, written before the offset is stored, and the journal puts the
// offset back at load, so it survives a restart of the whole server too.

import { clockPath, readJson, writeJsonDurable } from "../supervision.js";
import type { Clock } from "../clock.js";

export const MAX_STEP_MS = 366 * 24 * 3600 * 1000;
export const MAX_OFFSET_MS = 10 * 366 * 24 * 3600 * 1000;

/** Where the offset is kept. */
export interface OffsetStore {
  get(): number;
  set(offsetMs: number): void;
}

export function memoryOffset(initial = 0): OffsetStore {
  let v = initial;
  return { get: () => v, set: (n) => { v = n; } };
}

/** The offset in the supervisor's state folder (clock.json). Read on every call: it is one small file, and another process may move it. */
export function folderOffset(stateDir: string): OffsetStore {
  const path = clockPath(stateDir);
  return {
    get: () => {
      const v = readJson<{ offset_ms?: unknown }>(path)?.offset_ms;
      return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0;
    },
    set: (n) => writeJsonDurable(path, { offset_ms: n }),
  };
}

export class ClockError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export interface ClockMove {
  /** The offset before and after, in milliseconds. */
  from_ms: number;
  to_ms: number;
  /** Wall time of the move. */
  at: string;
}

/** The time source: injectable so tests and the record checks can pin wall time. */
export type WallSource = () => number;

export class FixtureClock implements Clock {
  readonly domain = "fixture" as const;
  private readonly listeners: Array<(move: ClockMove) => void> = [];

  constructor(private readonly store: OffsetStore = memoryOffset(), private readonly wall: WallSource = Date.now) {}

  now(): Date {
    return new Date(this.wall() + this.store.get());
  }

  wallNow(): Date {
    return new Date(this.wall());
  }

  offsetMs(): number {
    return this.store.get();
  }

  /**
   * Called with each move before the offset is stored (0.4.0: the durable journal writes its clock line here). A throw
   * stops the move: the offset stays, and the route answers 503 journal_unavailable.
   */
  beforeMove: ((move: ClockMove) => void) | undefined;

  /**
   * Puts back an offset the journal recorded (0.4.0, at load, before anything is served). Forward only: an offset kept
   * elsewhere that is already further (the supervisor's state folder) stays.
   */
  restore(offsetMs: number): void {
    if (!Number.isSafeInteger(offsetMs) || offsetMs < 0 || offsetMs > MAX_OFFSET_MS) throw new ClockError(500, "bad_offset", `a restored clock offset must be an integer from 0 to ${MAX_OFFSET_MS}`);
    if (offsetMs > this.store.get()) this.store.set(offsetMs);
  }

  /** Called on every move (the ledger records control actions). Listeners run synchronously, after the offset is stored. */
  onMove(listener: (move: ClockMove) => void): void {
    this.listeners.push(listener);
  }

  /** Moves the clock forward. Throws ClockError on a step or total outside the caps. */
  advance(ms: number): ClockMove {
    if (!Number.isSafeInteger(ms) || ms < 1 || ms > MAX_STEP_MS) {
      throw new ClockError(400, "bad_advance", `advance_ms must be an integer from 1 to ${MAX_STEP_MS} (366 days); the clock only moves forward`);
    }
    const from = this.store.get();
    const to = from + ms;
    if (to > MAX_OFFSET_MS) throw new ClockError(409, "offset_cap", `the offset may not pass ${MAX_OFFSET_MS} ms (about 10 years); it is ${from} ms`);
    const move: ClockMove = { from_ms: from, to_ms: to, at: this.wallNow().toISOString() };
    if (this.beforeMove) {
      try {
        this.beforeMove(move);
      } catch (e) {
        throw new ClockError(503, "journal_unavailable", `the clock move could not be journalled: ${(e as Error).message}; the clock did not move`);
      }
    }
    this.store.set(to);
    for (const l of this.listeners) l(move);
    return move;
  }
}

/** The body GET and POST /_fixture/clock answer with. */
export function clockState(clock: Clock) {
  return { domain: clock.domain, offset_ms: clock.offsetMs(), now: clock.now().toISOString(), wall_now: clock.wallNow().toISOString() };
}

/**
 * The /_fixture/clock route of the control listener. Returns undefined when this build has no fixture clock
 * (the listener then answers as before). The control listener has already checked the token, the Host, Origin
 * and the content type.
 *   GET  -> 200 { domain, offset_ms, now, wall_now }
 *   POST { "advance_ms": N } -> 200 { domain, offset_ms, now, wall_now, moved: { from_ms, to_ms, at } }
 */
export async function clockRoute(clock: Clock, method: string, readBody: () => Promise<unknown>): Promise<{ status: number; body: unknown } | undefined> {
  if (!(clock instanceof FixtureClock)) return undefined;
  if (method === "GET") return { status: 200, body: clockState(clock) };
  if (method !== "POST") return { status: 405, body: { error: "method_not_allowed", message: "GET or POST" } };
  const body = await readBody();
  if (!body || typeof body !== "object" || Array.isArray(body)) return { status: 400, body: { error: "bad_body", message: "expected {\"advance_ms\": N}" } };
  const extra = Object.keys(body).filter((k) => k !== "advance_ms");
  if (extra.length) return { status: 400, body: { error: "bad_body", message: `unknown member(s): ${extra.join(", ")}; expected {"advance_ms": N}` } };
  try {
    const moved = clock.advance((body as { advance_ms?: unknown }).advance_ms as number);
    return { status: 200, body: { ...clockState(clock), moved } };
  } catch (e) {
    if (e instanceof ClockError) return { status: e.status, body: { error: e.code, message: e.message } };
    throw e;
  }
}
