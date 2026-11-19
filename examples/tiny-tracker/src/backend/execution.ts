// Execution records (feature execution-records, 0.2.0; design rule 5, review
// G2). Not a receipt: the MWS receipt is the compact result every write tool
// returns. An execution record is the backend's own account of one applied
// write, as committed:
//
//   id          X-<seq>, from the store's commit sequence (one per applied
//               write, never reused; the journal line number from 0.3.0)
//   principal   whose token authorized the write (design rule 7)
//   run, operation_tag
//               the tags the request carried (Tiny-Tracker-Run and
//               Tiny-Tracker-Operation), stamped by the MCP layer's request
//               client outside every handler (design rule 3), so a defect in a
//               handler cannot drop them
//   request     method, path, key and fingerprint_hash (request-fingerprint/1)
//   result      the committed response body's canonical bytes (RFC 8785) and
//               their SHA-256 under the execution-result/1 domain tag
//
// The record is built from the CommittedTransaction the commit point hands to
// every sink, so it holds post-state as committed (every server-generated value
// included) and never the object's state at the time it is read. A replay
// serves the record of the write it answers for: the same id, bytes and digest.
//
// Everything in a record comes from the CommittedTransaction (seams v2):
// committed_at is tx.committedAt (the section's one clock read), the
// fingerprint hash is tx.request.fingerprintHash, the boot id is tx.bootId.
// A run reset (kind "run-reset") is a commit with no execution record, so
// execution ids skip its seq.
//
// The digest is taken through the `digest` seam each time a record is served.
// The correct seam hashes the committed body, which never changes, so the
// served digest is stable; a backend defect that replaces the seam shows on the
// next read (FX-DIG-1, FX-DIG-3).

import { digestOf, DOMAINS, type ServedDigest } from "../digest.js";
import { executionId, type ExecutionRecord, type RecordObject } from "../records.js";
import type { CommitSink, CommittedTransaction } from "./commit.js";
import type { DigestSeam } from "./seams.js";

/** The response header that names the execution record of a committed write (and, on a replay, of the write it answers for). */
export const EXECUTION_HEADER = "Tiny-Tracker-Execution";

/** The correct digest seam: RFC 8785 bytes of the committed body under dev.writesafety.tiny-tracker/execution-result/1. */
export const correctDigest: DigestSeam = {
  resultDigest: (body: unknown): ServedDigest => digestOf(DOMAINS.executionResult, body ?? null),
};

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
};

/** What a record needs of a commit, kept frozen. */
// A write commit's request is never null (seams v2.1: only a run reset has request null, and it has no record).
type Kept = Pick<CommittedTransaction, "seq" | "principal" | "attribution" | "bootId" | "objects" | "body" | "committedAt" | "clockOffsetMs"> & { request: NonNullable<CommittedTransaction["request"]> };

/**
 * The execution records of one backend process: a commit sink with role observer (told after the ledger; the ledger
 * links by execution_id = X-<seq>, which it names from the transaction alone). It keeps what the record needs of
 * each write commit, frozen, and builds the record when it is read.
 */
export class ExecutionLog implements CommitSink {
  readonly name = "execution-records";
  readonly role = "observer" as const;
  private readonly entries = new Map<number, Kept>();

  /** `digest` is read on every call, so a backend defect that replaces the seam is the one in use. */
  constructor(private readonly digest: () => DigestSeam) {}

  onCommit(tx: CommittedTransaction): void {
    if (tx.kind !== "write" || tx.request === null) return;
    const { seq, principal, attribution, bootId, request, objects, body, committedAt, clockOffsetMs } = tx;
    this.entries.set(seq, deepFreeze(structuredClone({ seq, principal, attribution, bootId, request, objects, body, committedAt, clockOffsetMs })));
  }

  /** The record of X-<seq>, or undefined. */
  record(id: string): ExecutionRecord | undefined {
    const m = /^X-([1-9][0-9]*)$/.exec(id);
    return m ? this.bySeq(Number(m[1])) : undefined;
  }

  bySeq(seq: number): ExecutionRecord | undefined {
    const entry = this.entries.get(seq);
    return entry ? this.build(entry) : undefined;
  }

  /** Every record in commit order. */
  *all(): Iterable<ExecutionRecord> {
    for (const seq of [...this.entries.keys()].sort((a, b) => a - b)) yield this.build(this.entries.get(seq)!);
  }

  private build(tx: Kept): ExecutionRecord {
    return {
      record: "execution-record/1",
      id: executionId(tx.seq),
      principal: tx.principal,
      run: tx.attribution.run,
      operation_tag: tx.attribution.operation,
      boot_id: tx.bootId,
      seq: tx.seq,
      request: { method: tx.request.method as ExecutionRecord["request"]["method"], path: tx.request.path, key: tx.request.key, fingerprint_hash: tx.request.fingerprintHash },
      objects: tx.objects.map((o): RecordObject => ({ type: o.type, id: o.id })),
      result: this.digest().resultDigest(structuredClone(tx.body)),
      committed_at: tx.committedAt,
      clock_offset_ms: tx.clockOffsetMs,
    };
  }
}
