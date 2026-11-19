// The execution ledger (feature `ledger`, R6): an append-only list of every
// backend write attempt, an effect counter that does not depend on the code
// under test.
//
// The ledger is a CommitSink with role "ledger" (docs/INTERFACES.md §1.1). The
// store tells it of every commit, replay and refusal inside the commit
// section, at step 4 of the frozen order: after the write is applied, before
// the reply. If an append throws, the store stops (fail-stop): memory and the
// evidence would disagree, so nothing more is answered.
//
// What it records sits below every MCP-layer defect: the backend's own view of
// the request (principal, method, path, key, the request fingerprint) and the
// run and operation tags the server wrapper stamped from request _meta (rule 3),
// never what a handler chose to send. Besides writes it records the fixture's
// own actions: its start, fault arming and firing (G9) and run allocation. A
// run reset is a commit (kind run-reset) and reaches the ledger as one, with
// tx.reset; a write whose journal append failed reaches it as a refusal with
// code journal_unavailable and is written as kind journal-unavailable. Entries
// are never edited or removed.
//
// The ledger keeps its own sequence (`seq`, from 1). An execution entry links
// to the store's commit sequence by `execution_id` (X-<commit seq>); a replay
// names the execution it answers for. Ledger and execution records are
// cross-checked, never merged.
//
// The ledger is an oracle: it has no defects (owner decision 5). Its tests
// recount it against /export.

import type { CommitSink, CommittedTransaction, ObjectRef, RefusedTransaction, ReplayedTransaction, TxMeta } from "../backend/commit.js";
import { objectsOf } from "../backend/commit.js";
import type { Clock } from "../clock.js";
import { executionId, type LedgerEntry, type LedgerKind, type RequestRef } from "../records.js";

/** At most this many entries per process (X5). An append beyond it fails, and the store stops. */
export const MAX_LEDGER_ENTRIES = 100_000;

/** The largest page GET /ledger serves in one answer (X5); the export serves everything. */
export const MAX_LEDGER_PAGE = 10_000;

export class LedgerError extends Error {}

/** What a reader may filter on. Every filter is an exact match; `after` is a ledger sequence number. */
export interface LedgerFilter {
  key?: string;
  run?: string;
  principal?: string;
  operation?: string;
  kind?: LedgerKind;
  after?: number;
  limit?: number;
  /** With `principal`: also the entries that belong to no principal (start, fault arming). */
  includeUnscoped?: boolean;
}

/** The fault fields a fault entry carries (the controller in faults.ts builds them). */
export interface FaultRef {
  point: string;
  selector: Record<string, unknown>;
}

const HASH = /^[0-9a-f]{64}$/;

/**
 * The request as the records give it: fingerprint_hash is TxRequest.fingerprintHash, computed once by the HTTP layer
 * (docs/INTERFACES.md §1.1). A run reset has no request (null, seams v2.1), and a request the HTTP layer did not hash
 * is not a client request: the entry has request null.
 */
function requestRef(meta: TxMeta): RequestRef | null {
  // Seams v2.1: a run reset's meta has request null (commit and refusal).
  const r = meta.request;
  if (r === null || !HASH.test(r.fingerprintHash)) return null;
  return { method: r.method, path: r.path, key: r.key, fingerprint_hash: r.fingerprintHash };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

type EntryFields = Omit<LedgerEntry, "entry" | "seq" | "at" | "clock_offset_ms" | "boot_id"> & { at?: string; clock_offset_ms?: number };

export class Ledger implements CommitSink {
  readonly name = "ledger";
  readonly role = "ledger" as const;
  private readonly entries: LedgerEntry[] = [];
  /** Set once an append failed: every later append fails the same way, so the store stops at its next event. */
  private failure: LedgerError | undefined;

  constructor(readonly bootId: string, private readonly clock: Clock, private readonly maxEntries = MAX_LEDGER_ENTRIES) {
    this.append({ kind: "start", principal: null, run: null, operation_tag: null, request: null, status: null, execution_id: null, objects: [], fault: null });
  }

  /** The number of entries; also the sequence number of the last one. */
  get size(): number {
    return this.entries.length;
  }

  private append(fields: EntryFields): LedgerEntry {
    if (this.failure) throw this.failure;
    if (this.entries.length >= this.maxEntries) {
      this.failure = new LedgerError(`the ledger is full (${this.maxEntries} entries per process)`);
      throw this.failure;
    }
    // Members in schema order (RECORD_FIELDS["ledger-entry"]).
    const entry: LedgerEntry = {
      entry: "ledger-entry/1",
      seq: this.entries.length + 1,
      at: fields.at ?? this.clock.wallNow().toISOString(),
      clock_offset_ms: fields.clock_offset_ms ?? this.clock.offsetMs(),
      boot_id: this.bootId,
      kind: fields.kind,
      principal: fields.principal,
      run: fields.run,
      operation_tag: fields.operation_tag,
      request: fields.request,
      status: fields.status,
      execution_id: fields.execution_id,
      objects: fields.objects.map((o) => ({ type: o.type, id: o.id })),
      fault: fields.fault,
    };
    this.entries.push(deepFreeze(entry));
    return entry;
  }

  private fromTx(kind: LedgerKind, tx: CommittedTransaction | ReplayedTransaction | RefusedTransaction, executionIdValue: string | null, objects: ObjectRef[]): LedgerEntry {
    if (tx.bootId !== this.bootId) {
      this.failure = new LedgerError(`an event from boot ${tx.bootId} reached the ledger of boot ${this.bootId}`);
      throw this.failure;
    }
    return this.append({
      kind, at: tx.at, clock_offset_ms: tx.clockOffsetMs, principal: tx.principal, run: tx.attribution.run, operation_tag: tx.attribution.operation,
      request: requestRef(tx), status: tx.status, execution_id: executionIdValue, objects, fault: null,
    });
  }

  // ---- CommitSink (the frozen commit path, step 4) ----

  onCommit(tx: CommittedTransaction): void {
    if (tx.kind === "run-reset") {
      // From the reset's own commit event: the principal and run it dropped, and the objects removed.
      const r = tx.reset!;
      this.append({ kind: "run-reset", at: tx.at, clock_offset_ms: tx.clockOffsetMs, principal: r.principal, run: r.run, operation_tag: null,
        request: null, status: tx.status, execution_id: null, objects: r.objects, fault: null });
      return;
    }
    this.fromTx("execution", tx, executionId(tx.seq), tx.objects);
  }

  onReplay(tx: ReplayedTransaction): void {
    this.fromTx("replay", tx, executionId(tx.originalSeq), (tx.request ? objectsOf(tx.request.path, tx.body) : []));
  }

  onRefusal(tx: RefusedTransaction): void {
    this.fromTx(tx.code === "journal_unavailable" ? "journal-unavailable" : "refusal", tx, null, []);
  }

  // ---- the fixture's own actions ----

  faultArmed(fault: FaultRef): LedgerEntry {
    return this.append({ kind: "fault-armed", principal: null, run: null, operation_tag: null, request: null, status: null, execution_id: null, objects: [],
      fault: { point: fault.point, selector: { ...fault.selector }, fired_on_seq: null } });
  }

  /**
   * A fault fired. `on` is the ledger entry the fault fired on (the latest entry carrying the call's run and operation
   * tags), or undefined when the call is untagged or no such entry exists.
   */
  faultFired(fault: FaultRef, tags: { run: string | null; operation: string | null }, on: LedgerEntry | undefined): LedgerEntry {
    return this.append({ kind: "fault-fired", principal: on?.principal ?? null, run: tags.run, operation_tag: tags.operation, request: on?.request ?? null,
      status: on?.status ?? null, execution_id: on?.execution_id ?? null, objects: on ? [...on.objects] : [],
      fault: { point: fault.point, selector: { ...fault.selector }, fired_on_seq: on?.seq ?? null } });
  }

  runAllocated(principal: string, run: string): LedgerEntry {
    return this.append({ kind: "run-allocated", principal, run, operation_tag: null, request: null, status: null, execution_id: null, objects: [], fault: null });
  }

  // ---- reading ----

  /** The latest write-attempt entry carrying both tags (what a fault fired on). Needs both tags: an untagged call names no entry. */
  latestTagged(run: string | null, operation: string | null): LedgerEntry | undefined {
    if (run === null || operation === null) return undefined;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e.request !== null && e.run === run && e.operation_tag === operation) return e;
    }
    return undefined;
  }

  /** Entries in sequence order. Entries are frozen: a reader cannot change the ledger. */
  list(filter: LedgerFilter = {}): LedgerEntry[] {
    const out: LedgerEntry[] = [];
    const limit = filter.limit ?? Number.POSITIVE_INFINITY;
    for (let i = filter.after ?? 0; i < this.entries.length && out.length < limit; i++) {
      const e = this.entries[i];
      if (filter.key !== undefined && e.request?.key !== filter.key) continue;
      if (filter.run !== undefined && e.run !== filter.run) continue;
      if (filter.principal !== undefined && e.principal !== filter.principal && !(filter.includeUnscoped && e.principal === null)) continue;
      if (filter.operation !== undefined && e.operation_tag !== filter.operation) continue;
      if (filter.kind !== undefined && e.kind !== filter.kind) continue;
      out.push(e);
    }
    return out;
  }
}
