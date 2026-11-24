// Typed signatures of the backend's seams (frozen interface). A seam is a
// named place a backend defect may replace (src/backend/defects/index.ts,
// BACKEND_SEAMS). patchTicket, inputRules and keyRecord are wired; the others
// are the contracts the 0.2.0 and 0.3.0 streams implement.
//
// Key records are scoped by principal (KeyScope). The run is recorded on
// every record but is not part of the scope: a key-only recovery after a
// delay may come from a later run of the same caller (see docs/INTERFACES.md,
// D5).

import type { ServedDigest } from "../digest.js";
import type { CommitSink } from "./commit.js";

export interface KeyScope {
  principal: string;
}

/** A completed keyed POST, kept to answer its repeats. Built from the commit by storedReplyOf (src/backend/commit.ts). */
export interface StoredReply {
  fingerprint: string;
  status: number;
  body: unknown;
  headers: Record<string, string>;
  /** The run that made it, for run-scoped reset; never part of the lookup. */
  run: string | null;
  /** Commit-point sequence number of the commit that made it. */
  seq: number;
  /** The commit's committedAt (one record-clock read per commit), never a second clock read. */
  committedAt: string;
  clockOffsetMs: number;
}

/** What an expired key record keeps (decision 0004): enough to say the write was applied and where its receipt is. */
export interface KeyTombstone {
  /** The records' fingerprint_hash of the write the key identified (TxRequest.fingerprintHash). */
  fingerprintHash: string;
  /** Its execution record, X-<seq>. */
  executionId: string;
  /** The served result digest of its committed body. */
  resultDigest: string;
  committedAt: string;
}

/**
 * What a key-record lookup finds (seams v2.1). The keyed path in http.ts answers each state in a frozen order:
 * completed → replay (same fingerprint) or 422 idempotency_key_reused; pending → 409 in_progress; fenced → 409
 * key_fenced; expired → the B10 answer (decision 0004); undefined → begin. Only an InflightKeyRecordSeam returns
 * "pending" and "fenced", and only one with a retention returns "expired".
 */
export type KeyRecordState =
  | { state: "completed"; reply: StoredReply }
  | { state: "pending"; /** The pending record's created_at (record clock). */ since: string }
  | {
    /**
     * The key's pending record was ended by a run reset (dropRun). The key stays fenced for the life of the store (a
     * journal `fence` line keeps it across a restart): every later call with it is refused 409 key_fenced, nothing
     * begins, and the write that held it, if it reaches its commit section, is refused the same way and applies nothing.
     */
    state: "fenced";
    /** The run whose reset fenced it ("" for a lookup fence made without a run tag). */
    run: string;
    /**
     * Additive (0.3.0): what fenced it. "reset" (the default when absent): a run reset ended its pending record.
     * "lookup": settle-by-lookup's fence (review B9), a lookup that found no record closed the key.
     */
    by?: "reset" | "lookup";
  }
  | { state: "expired"; tombstone: KeyTombstone };

/** Seam keyRecord (wired): read and complete key records. Called only inside the commit section, or just before it with no await between. */
export interface KeyRecordSeam {
  get(scope: KeyScope, key: string): KeyRecordState | undefined;
  put(scope: KeyScope, key: string, reply: StoredReply): void;
  /**
   * Removes every completed record one principal's run made (run-scoped reset; run tags are scoped per principal) and
   * returns how many. An InflightKeyRecordSeam also fences that run's pending records (they are not counted): each
   * pending record becomes { state: "fenced" }, and under durable a journal `fence` line, naming the pending line it
   * ends, is written (decision 0003; no `aborted` line). The write the record was held for re-checks its own record
   * after the before-commit hook, just before its commit section; finding it fenced, it is refused 409 key_fenced,
   * applies nothing, and does not call abort (the fence already ended the record). So a write in flight when its run
   * is reset never lands after the reset, and the journal never has a commit naming an ended pending line.
   */
  dropRun(scope: KeyScope, run: string): number;
}

/** Why a pending key record ended with nothing applied (the journal's aborted line carries it). */
export type AbortReason = "refused" | "journal_unavailable" | "fault" | "internal_error" | "orphan_at_start";
export const ABORT_REASONS: readonly AbortReason[] = ["refused", "journal_unavailable", "fault", "internal_error", "orphan_at_start"];

/** 0.3.0 (inflight, retention): the pending and tombstone states. */
export interface InflightKeyRecordSeam extends KeyRecordSeam {
  /**
   * Writes the pending record (a journal `pending` line under durable) before the commit section, before the
   * backend/before-commit fault hook. A same-key call meanwhile finds { state: "pending" } and answers 409 in_progress.
   * `put` completes it. A begin that throws leaves no pending record of its own: the keyed path does not call abort for
   * it (abort could end another request's record). abort must still tolerate a key with no pending record.
   */
  begin(scope: KeyScope, key: string, fingerprint: string, run: string | null): void;
  /**
   * Ends a pending record with no commit: refused (an ApiError or a reply of 300 and above from the section),
   * journal_unavailable (the journal append failed), fault (the before-commit fault hook threw, an armed ApiError
   * included; the ledger still records that ApiError as a refusal), internal_error (any other throw), orphan_at_start
   * (found at load, written by the journal before serving).
   * It never throws: it runs in a `finally`, where a throw would hide the answer already decided (a 503, say). An
   * implementation catches its own errors, logs them and returns.
   */
  abort(scope: KeyScope, key: string, reason: AbortReason): void;
  /** What an expired record keeps (decision 0004). */
  tombstone(scope: KeyScope, key: string): KeyTombstone | undefined;
}

/** True when a key-record seam has the 0.3.0 pending state (the keyed path then calls begin and abort). */
export function isInflight(seam: KeyRecordSeam): seam is InflightKeyRecordSeam {
  const s = seam as Partial<InflightKeyRecordSeam>;
  return typeof s.begin === "function" && typeof s.abort === "function";
}

/** Seam digest (0.2.0, execution-records): the served digest of a committed response body. */
export interface DigestSeam {
  resultDigest(body: unknown): ServedDigest;
}

/** Seam lookup (0.2.0, lookup): find a key's record within the caller's scope; undefined is "no record of this key now". */
export interface LookupSeam {
  find(scope: KeyScope, key: string): StoredReply | undefined;
}

/** Seam journal (0.3.0, durable): a commit sink that also loads committed post-state at start. */
export interface JournalSeam extends CommitSink {
  /**
   * Replays the journal into the store; throws on any bad line but a torn last one. `run-alloc` lines go back into the
   * run registry (RunRegistry.restore), so ownership checks hold after a restart.
   */
  load(): void;
  /**
   * Appends a `run-alloc` line (seams v2.1) and flushes it; called by RunRegistry.onAllocate before the run is
   * registered or answered. A throw refuses the allocation (503 journal_unavailable, or lease_lost), nothing registered.
   * Nothing is cut from the file: an append that fails once its write has begun stops the journal (decision 0003
   * section 5, as revised in 0.4.0).
   */
  recordRun(run: { run_id: string; principal: string; created_at: string; label: string | null }): void;
  close(): void;
}

/** Seam keyExpiry (0.3.0, retention): the stated retention, in the injected clock's domain. */
export interface KeyExpirySeam {
  retentionMs: number;
  expiresAt(committedAt: Date): Date;
  isExpired(reply: StoredReply, now: Date): boolean;
}

/** The in-memory key records of 0.1.0, moved behind the seam: no expiry, scoped by principal. */
export function memoryKeyRecords(): KeyRecordSeam {
  const records = new Map<string, StoredReply>();
  const id = (scope: KeyScope, key: string) => `${scope.principal}\u0000${key}`;
  return {
    get: (scope, key) => {
      const reply = records.get(id(scope, key));
      return reply && { state: "completed", reply };
    },
    put: (scope, key, reply) => void records.set(id(scope, key), reply),
    dropRun(scope, run) {
      let n = 0;
      for (const [k, v] of records) if (v.run === run && k.startsWith(`${scope.principal}\u0000`)) { records.delete(k); n++; }
      return n;
    },
  };
}

/**
 * What the evidence namespace and the get_operation and get_execution tools read (stream A provides it, stream B
 * serves it). Records are built from CommittedTransactions; see src/records.ts.
 */
export interface EvidenceSource {
  execution(id: string): import("../records.js").ExecutionRecord | undefined;
  operation(scope: KeyScope, key: string): import("../records.js").OperationRecord | undefined;
  /** Every execution record in commit order, for the export and the recount. */
  executions(): Iterable<import("../records.js").ExecutionRecord>;
}
