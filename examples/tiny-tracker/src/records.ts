// The records the 0.2.0 and 0.3.0 streams serve, as TypeScript types (frozen
// field names). They mirror schemas/*-1.schema.json member for member;
// test/interfaces.test.ts checks that every required schema member is here and
// nothing else is. A new member is an addition to both, never a rename.

import type { ServedDigest } from "./digest.js";

export type RecordObject = { type: "ticket" | "project" | "comment" | "label"; id: string };

export interface RequestRef {
  method: string;
  path: string;
  key: string | null;
  /** Lower-case hex SHA-256 of the backend fingerprint `METHOD path canonicalJson(body)`. */
  fingerprint_hash: string;
}

export interface ExecutionRecord {
  record: "execution-record/1";
  /** X-<n>, from the commit point's sequence. */
  id: string;
  principal: string;
  run: string | null;
  operation_tag: string | null;
  boot_id: string;
  /** The store's commit sequence (the journal line number from 0.3.0); id is X-<seq>. Not the ledger's sequence. */
  seq: number;
  request: RequestRef & { method: "POST" | "PUT" | "PATCH" | "DELETE" };
  objects: RecordObject[];
  /** Domain dev.writesafety.tiny-tracker/execution-result/1 over the committed response body. */
  result: ServedDigest;
  committed_at: string;
  clock_offset_ms: number;
}

export type OperationState = "pending" | "completed" | "aborted" | "expired";

export interface OperationRecord {
  record: "operation-record/1";
  key: string;
  principal: string;
  run: string | null;
  state: OperationState;
  fingerprint_hash: string;
  created_at: string;
  completed_at: string | null;
  expires_at: string | null;
  clock_offset_ms: number;
  execution_id: string | null;
  result_digest: string | null;
  status: number | null;
}

export type LedgerKind = "start" | "execution" | "replay" | "refusal" | "fault-armed" | "fault-fired" | "run-allocated" | "run-reset";

export interface LedgerEntry {
  entry: "ledger-entry/1";
  seq: number;
  at: string;
  clock_offset_ms: number;
  boot_id: string;
  kind: LedgerKind;
  principal: string | null;
  run: string | null;
  operation_tag: string | null;
  request: RequestRef | null;
  status: number | null;
  execution_id: string | null;
  objects: Array<{ type: string; id: string }>;
  fault: { point: string; selector: Record<string, unknown>; fired_on_seq: number | null } | null;
}

/** The execution record id of a commit: X-<the store's commit sequence>. */
export const executionId = (seq: number) => `X-${seq}`;

/** Field lists, in schema order, for the shape test and for writers that build records member by member. */
export const RECORD_FIELDS = {
  "execution-record": ["record", "id", "principal", "run", "operation_tag", "boot_id", "seq", "request", "objects", "result", "committed_at", "clock_offset_ms"],
  "operation-record": ["record", "key", "principal", "run", "state", "fingerprint_hash", "created_at", "completed_at", "expires_at", "clock_offset_ms", "execution_id", "result_digest", "status"],
  "ledger-entry": ["entry", "seq", "at", "clock_offset_ms", "boot_id", "kind", "principal", "run", "operation_tag", "request", "status", "execution_id", "objects", "fault"],
} as const satisfies Record<string, ReadonlyArray<string>>;

// Compile-time check: the field lists name exactly the members of the types.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _exec: Same<(typeof RECORD_FIELDS)["execution-record"][number], keyof ExecutionRecord> = true;
const _op: Same<(typeof RECORD_FIELDS)["operation-record"][number], keyof OperationRecord> = true;
const _ledger: Same<(typeof RECORD_FIELDS)["ledger-entry"][number], keyof LedgerEntry> = true;
void _exec; void _op; void _ledger;
