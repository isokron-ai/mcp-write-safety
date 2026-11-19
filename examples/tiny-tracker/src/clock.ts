// The clock every time comes from (frozen interface; design rule 8).
//
// Nothing in the backend or the fixture layer reads the system clock itself:
// each is given a Clock. `now()` is the clock's own domain, used for every
// record time (created_at, committed_at, expires_at, a run's created_at).
// `wallNow()` is wall time, used only where a schema says wall time (a ledger
// entry's `at`, the descriptor's started_at). The fixture clock (0.3.0, feature
// clock) implements this interface and is moved only through the control
// listener; `offsetMs()` is what every record carries as clock_offset_ms.

export interface Clock {
  /** "wall": offset 0. "fixture": moved on the control listener. */
  readonly domain: "wall" | "fixture";
  now(): Date;
  wallNow(): Date;
  /** Milliseconds this clock is ahead of wall time; 0 for the wall clock. */
  offsetMs(): number;
}

export const wallClock: Clock = {
  domain: "wall",
  now: () => new Date(),
  wallNow: () => new Date(),
  offsetMs: () => 0,
};
