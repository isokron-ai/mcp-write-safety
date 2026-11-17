// Crash fault points (0.3.0, review B7): a process stops at a named point of
// the commit path, and the supervisor restarts it.
//
// The points are named by process × position × action (src/fault-points.ts):
//   backend/before-commit/crash      after the pending key record, before the
//                                    synchronous section: nothing is validated
//                                    or written (a pending record is left, and
//                                    becomes `aborted` at the next start)
//   backend/after-commit/crash       after the ledger, before the reply: the write
//                                    is applied, journalled and in the ledger,
//                                    and never answered; the MCP layer sees a
//                                    reset connection
//   mcp/after-backend-reply/crash    in the MCP process, after the backend
//                                    answered: the lost response, server-side
//
// A crash point can be armed only under `tiny-tracker all --supervise` (CMP-63):
// in the one-process layout it would stop both layers, and nothing would
// restart them. Arming lives in the supervisor's state folder, never on argv; a
// `once` fault is consumed (durably) before the process exits, so the restarted
// child does not crash again.
//
// This file owns the crash action only. Arming at run time (POST
// /_fixture/faults), selectors, the other actions (drop, close, delay, error)
// and the ledger's fault events belong to the fault controller; it calls
// `onFire` here before the process stops, so a firing reaches the ledger first.
// The backend points use the frozen fault hooks (BackendOptions.faults); the
// MCP point is composed in front of the fault controller's onResult.

import type { BackendFaultHooks } from "../backend/http.js";
import type { ServerExtras } from "../mcp/server.js";
import type { ArmingStore, FaultFiring } from "../supervision.js";

/** The exit status of a process stopped by a crash fault (EX_SOFTWARE). The supervisor restarts on any unplanned exit. */
export const CRASH_EXIT_CODE = 70;

export const CRASH_POINTS = {
  backendBeforeCommit: "backend/before-commit/crash",
  backendAfterCommit: "backend/after-commit/crash",
  mcpAfterBackendReply: "mcp/after-backend-reply/crash",
} as const;

export interface CrashOptions {
  arming: ArmingStore;
  /** This process's boot id (the build descriptor's), stamped on the firing. */
  bootId: string | null;
  wallNow: () => Date;
  /** Called synchronously when a fault fires, before the process stops (the ledger's fault event). */
  onFire?: (firing: FaultFiring) => void;
  /** What stopping means. Default: write one line to stderr and exit with CRASH_EXIT_CODE. Tests replace it. */
  stop?: (firing: FaultFiring) => never;
}

function defaultStop(firing: FaultFiring): never {
  process.stderr.write(`tiny-tracker: fault ${firing.point} fired${firing.seq === null ? "" : ` at commit ${firing.seq}`}; stopping this process\n`);
  process.exit(CRASH_EXIT_CODE);
}

/** Checks one point and stops the process when it is armed. */
export function crashCheck(options: CrashOptions, point: string, seq: number | null): void {
  const firing = { at: options.wallNow().toISOString(), boot_id: options.bootId, seq };
  const fault = options.arming.take(point, firing);
  if (!fault) return;
  const full: FaultFiring = { point, ...firing };
  options.onFire?.(full);
  (options.stop ?? defaultStop)(full);
}

/**
 * The backend's two crash points, as the backend fault hooks (BackendOptions.faults, frozen in seams v2).
 *   beforeCommit  backend/before-commit: after the pending key record, before the synchronous section; nothing is
 *                 validated or written, so the firing has no commit sequence.
 *   afterCommit   backend/after-commit: after journal, apply and ledger, before the reply; the firing names tx.seq.
 * `next` is the fault controller's own hooks (stream B: delay, drop, error); the crash check runs first, and a
 * point that does not crash hands on to it.
 */
export function backendCrashHooks(options: CrashOptions, next: BackendFaultHooks = {}): BackendFaultHooks {
  return {
    async beforeCommit(ctx) {
      crashCheck(options, CRASH_POINTS.backendBeforeCommit, null);
      if (next.beforeCommit) await next.beforeCommit(ctx);
    },
    async afterCommit(ctx) {
      crashCheck(options, CRASH_POINTS.backendAfterCommit, ctx.tx.seq);
      return next.afterCommit ? next.afterCommit(ctx) : undefined;
    },
  };
}

/** The MCP crash point, composed in front of the fault controller's onResult (the frozen hook; the wrapper is not edited). */
export function mcpCrashOnResult(options: CrashOptions, next?: ServerExtras["onResult"]): NonNullable<ServerExtras["onResult"]> {
  return async (tool, result, ctx) => {
    crashCheck(options, CRASH_POINTS.mcpAfterBackendReply, null);
    return next ? next(tool, result, ctx) : result;
  };
}
