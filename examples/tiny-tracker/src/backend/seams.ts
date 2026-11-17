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

/** A completed keyed POST, kept to answer its repeats. */
export interface StoredReply {
  fingerprint: string;
  status: number;
  body: unknown;
  headers: Record<string, string>;
  /** The run that made it, for run-scoped reset; never part of the lookup. */
  run: string | null;
  /** Commit-point sequence number of the commit that made it. */
  seq: number;
  committedAt: string;
  clockOffsetMs: number;
}

/** Seam keyRecord (wired): read and complete key records. Called only inside the commit section, or just before it with no await between. */
export interface KeyRecordSeam {
  get(scope: KeyScope, key: string): StoredReply | undefined;
  put(scope: KeyScope, key: string, reply: StoredReply): void;
  /** Removes every record one principal's run made (run-scoped reset; run tags are scoped per principal); returns how many. */
  dropRun(scope: KeyScope, run: string): number;
}

/** 0.3.0 (inflight, retention): the pending and tombstone states. */
export interface InflightKeyRecordSeam extends KeyRecordSeam {
  /** Writes the pending record before the commit section; a same-key call meanwhile answers in_progress. */
  begin(scope: KeyScope, key: string, fingerprint: string, run: string | null): void;
  /** A pending record with no commit (refused, or found at start): nothing applied. */
  abort(scope: KeyScope, key: string): void;
  /** What an expired record keeps (decision 0004). */
  tombstone(scope: KeyScope, key: string): { fingerprintHash: string; executionId: string; resultDigest: string; committedAt: string } | undefined;
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
  /** Replays the journal into the store; throws on any bad line but a torn last one. */
  load(): void;
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
    get: (scope, key) => records.get(id(scope, key)),
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
