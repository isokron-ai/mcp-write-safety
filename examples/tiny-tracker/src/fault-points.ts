// Fault points, named by process × position × action (review B7).
//
// This is data only: which points exist and which combinations are legal.
// The fault controller that arms and fires them lives in the fixture layer
// and arrives in 0.2.0 (one point: mcp / after-backend-reply / drop) and
// 0.3.0 (the crash points, with a supervisor). A point's arming state is
// kept by the supervisor or in the data dir, never on argv, so a `once`
// fault does not re-arm when a child restarts.

export const FAULT_PROCESSES = ["mcp", "backend"] as const;
export const FAULT_POSITIONS = ["before-commit", "after-commit", "after-backend-reply", "after-effect-before-key"] as const;
export const FAULT_ACTIONS = ["drop", "close", "crash", "delay", "error"] as const;

export type FaultProcess = (typeof FAULT_PROCESSES)[number];
export type FaultPosition = (typeof FAULT_POSITIONS)[number];
export type FaultAction = (typeof FAULT_ACTIONS)[number];

/**
 * The backend commit path (frozen order, src/backend/commit.ts and Store.commit):
 *   pending   before the section, may await: BackendOps.beforePatch (a defect's wait), then the pending key record
 *             (keyed writes under inflight, 0.3.0);
 *   validate, journal, apply, ledger   the one synchronous section (validate and compute is the `mutate` call; the
 *             journal append, the apply and the ledger follow with no await);
 *   reply     after the section.
 * Fault positions are named against it, and run as BackendOptions.faults hooks (never inside the section):
 *   backend before-commit  after the pending record, before the section: nothing validated or written (delay fits here);
 *   backend after-commit   after the section (journalled, applied, in the ledger), before the reply: unanswered;
 *   mcp after-backend-reply  in the MCP process, after the backend's reply arrived, before the MCP answer.
 *   backend after-effect-before-key  inside the section, keyed writes only: the write is journalled and applied, and its
 *             key record is not yet kept (G2 fold-in 11). The correct durable build keeps the key record in the
 *             commit line, so it is already durable there; under key-record-after-effect (or key-record-not-durable)
 *             it is not, and the process dies with the effect kept and the key lost.
 */
export const COMMIT_STEPS = ["pending", "validate", "journal", "apply", "ledger", "reply"] as const;

/** The steps inside the one synchronous commit section (no await between them). */
export const SECTION_STEPS = ["validate", "journal", "apply", "ledger"] as const;

export interface FaultPoint {
  /** process/position/action, e.g. "mcp/after-backend-reply/drop". */
  id: string;
  process: FaultProcess;
  position: FaultPosition;
  action: FaultAction;
  /** The release that builds it; null where it is legal but not planned. */
  since: string | null;
  /** What a caller sees, and what the fault demonstrates. */
  note: string;
}

const point = (process: FaultProcess, position: FaultPosition, action: FaultAction, since: string | null, note: string): FaultPoint =>
  ({ id: `${process}/${position}/${action}`, process, position, action, since, note });

/**
 * The legal points. `after-backend-reply` exists only in the MCP process: the backend has no reply to wait for.
 * A backend crash after commit gives the MCP layer a reset connection (an `unknown` answer to the client); an
 * MCP-process crash after the backend replied is the lost response the contract describes. They are different
 * faults with different expected classes.
 */
export const FAULT_POINTS: readonly FaultPoint[] = [
  point("mcp", "after-backend-reply", "drop", "0.2.0", "The backend committed and answered; the MCP server never answers the client. The lost response, server-side."),
  point("mcp", "after-backend-reply", "close", "0.3.0", "As drop, but the connection to the client is closed without a body."),
  point("mcp", "after-backend-reply", "crash", "0.3.0", "The MCP process exits after the backend answered; needs --supervise (the backend stays up)."),
  point("mcp", "after-backend-reply", "delay", "0.3.0", "The answer to the client is held for a set time (capped)."),
  point("mcp", "before-commit", "error", null, "The MCP server answers an error before it calls the backend: nothing is written."),
  point("backend", "before-commit", "crash", "0.3.0", "The backend exits before the commit section: nothing is written."),
  point("backend", "before-commit", "delay", "0.3.0", "A delay after the pending record and before the one commit section (rule 9); opens the in-flight window."),
  point("backend", "after-commit", "crash", "0.3.0", "The backend exits after the commit, before it answers: the MCP layer sees a reset connection."),
  point("backend", "after-commit", "error", "0.3.0", "The backend commits, then answers 500: an indeterminate answer."),
  point("backend", "after-commit", "drop", "0.3.0", "The backend commits and never answers (capped hold)."),
  point("backend", "after-effect-before-key", "crash", "0.3.0", "Keyed writes, with durable: the backend exits after the write is journalled and applied, before its key record is kept apart from it. The correct build keeps it in the commit line, so the retry replays; under key-record-after-effect the retry applies a second time. Needs --supervise."),
];

// ---- stream B ----
/**
 * The points this version can arm (on the control listener, or at start once stream E's --fault lands). Each needs an
 * action in src/fixture/faults.ts (FAULT_ACTIONS). Stream E appends the 0.3.0 points.
 */
export const BUILT_FAULT_POINTS: readonly string[] = [
  "mcp/after-backend-reply/drop",
  // ---- 0.3.0 integration (stream E): the crash points, under `tiny-tracker all --supervise` only (CMP-63) ----
  "backend/before-commit/crash", "backend/after-commit/crash", "mcp/after-backend-reply/crash",
  // ---- G2 fold-in 11: the point between the effect and the key record, so key-record-after-effect shows from outside ----
  "backend/after-effect-before-key/crash",
];
// ---- end stream B ----

export function faultPoint(id: string): FaultPoint | undefined {
  return FAULT_POINTS.find((p) => p.id === id);
}

/**
 * Fault-like names from the research plan that the point table replaces. They stay recognized so that the
 * compatibility table can explain what to use instead.
 */
export const RETIRED_FAULT_NAMES: Record<string, string> = {
  "drop-response-after-commit": "mcp/after-backend-reply/drop",
  "crash-after-commit": "mcp/after-backend-reply/crash or backend/after-commit/crash (name the process)",
  "crash-before-commit": "backend/before-commit/crash",
  "slow-commit": "backend/before-commit/delay",
  "backend-error-after-commit": "backend/after-commit/error",
};

/**
 * Fault demonstrations that are only meaningful against one defect or variant (review G4). Each maps a
 * demonstration name to what must be active for it.
 */
export const FAULT_DEMOS: Record<string, { since: string; needsOneOf: string[]; note: string }> = {
  "crash-between-effect-and-record": {
    since: "0.3.0",
    needsOneOf: ["defect:key-record-after-effect", "variant:key-store-honest"],
    note: "Built as the point backend/after-effect-before-key/crash (G2 fold-in 11). The correct durable build writes the effect and the key record in one journal line, so a crash there loses nothing.",
  },
  "power-cut": {
    since: "0.3.0",
    needsOneOf: ["feature:durable"],
    note: "Discards journal lines not yet flushed; only meaningful with a journal.",
  },
};
