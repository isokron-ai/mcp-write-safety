// Operation lookup by idempotency key (feature lookup, 0.2.0; B-5's "a way to
// look the write up by its idempotency key", contract A3's K-only recovery).
//
// A key's record is scoped to the principal that sent it, never to a run
// (docs/INTERFACES.md, D5): a caller that holds only the key, from a later run
// or a fresh process, finds it with its own token, and no other principal can.
// Scoping by the caller's authentication is what A3's "using only K" allows.
//
// A miss answers "no record of this key now". It never means nothing was
// written (B-9 rule 4, review B9): a request still on its way can land after
// the lookup, and from 0.3.0 a record can expire. Only a found record settles
// an outcome.
//
// The lookup seam finds the stored reply; the operation record is built from
// it and from the execution record of the commit that made it. Its
// result_digest is taken over the stored reply through the digest seam, so a
// stored answer that drifts from the committed result shows as a digest that
// differs from the execution record's (FX-DIG-2).

import type { ExecutionRecord, OperationRecord } from "../records.js";
import { executionId } from "../records.js";
import type { ExecutionLog } from "./execution.js";
import type { DigestSeam, EvidenceSource, KeyRecordSeam, KeyScope, LookupSeam, StoredReply } from "./seams.js";

/** The text of a miss, on the API, the evidence namespace and the get_operation tool (rule 4). */
export const NO_RECORD = "no record of this key now";

/** What a miss adds, so nobody reads it as "not applied". */
export const NO_RECORD_NOTE = "this does not mean nothing was written: a request still on its way can land later";

/** The correct lookup: the key record of exactly this key, in exactly this principal's scope. Reads the seam on every call. */
export function correctLookup(keyRecord: () => KeyRecordSeam): LookupSeam {
  // Seams v2.1: get answers a state. Only a completed record is found here. The pending, fenced and expired states
  // arrive with the 0.3.0 key-record seam (the 0.2.0 memory seam answers completed only); 0.3.0 maps them onto the
  // operation record's state (pending; fenced as aborted; expired from the tombstone).
  return {
    find: (scope, key) => {
      const found = keyRecord().get(scope, key);
      return found?.state === "completed" ? found.reply : undefined;
    },
  };
}

/** The operation record of one key, from its stored reply and the execution record of the commit that made it. */
export function operationRecord(scope: KeyScope, key: string, stored: StoredReply, execution: ExecutionRecord | undefined, digest: DigestSeam): OperationRecord {
  return {
    record: "operation-record/1",
    key,
    principal: scope.principal,
    run: stored.run,
    // 0.2.0 has no pending state: a key record exists only once its write is committed (pending, aborted and expired
    // arrive with the inflight and retention features in 0.3.0).
    state: "completed",
    fingerprint_hash: execution?.request.fingerprint_hash ?? "",
    created_at: stored.committedAt,
    completed_at: stored.committedAt,
    expires_at: null,
    clock_offset_ms: stored.clockOffsetMs,
    execution_id: executionId(stored.seq),
    result_digest: digest.resultDigest(structuredClone(stored.body)).digest,
    status: stored.status,
  };
}

export interface EvidenceParts {
  executions: ExecutionLog;
  /** Read on every call: the seams in use (a backend defect may have replaced them). */
  lookup: () => LookupSeam;
  digest: () => DigestSeam;
  /** False without the lookup feature: operation() then finds nothing. */
  lookupOn: boolean;
  /** The configured principal ids, in configuration order. */
  principals: readonly string[];
}

/** One evidence answer: a status and a JSON body. */
export interface EvidenceAnswer {
  status: number;
  body: unknown;
}

/**
 * The read side of the evidence (docs/INTERFACES.md §1.5), plus the frozen rule for reading it across principals
 * (§1.4): stream A provides it, the evidence namespace (stream B) serves it with `serve`, and the backend API serves
 * the caller's own records.
 */
export interface EvidenceReader extends EvidenceSource {
  /** The configured principal ids. */
  readonly principals: readonly string[];
  /**
   * Answers GET /executions/:id and GET /operations/:key for the evidence token, or undefined for any other path.
   * Operations: the principal is `?principal=<id>`, required when more than one principal is configured (400
   * principal_required), the single configured one otherwise; an id that is not configured is 400 unknown_principal;
   * the answer names `principal`, and a key with no record in that scope is 404 ("no record of this key now").
   * Executions (seams v2.1): `?principal=` is optional; when given and not the record's principal (or not configured)
   * the answer is the unknown-id 404 not_found. The evidence token may read any principal's records.
   */
  serve(pathname: string, query: URLSearchParams): EvidenceAnswer | undefined;
}

/** The principal an evidence read is for, or the 400 answer (§1.4). */
export function evidencePrincipal(query: URLSearchParams, principals: readonly string[]): string | EvidenceAnswer {
  const asked = query.get("principal");
  if (asked === null) {
    if (principals.length === 1) return principals[0];
    return { status: 400, body: { error: "principal_required", message: `more than one principal is configured; name one with ?principal=<id> (${principals.join(", ")})`, principals: [...principals] } };
  }
  if (!principals.includes(asked)) return { status: 400, body: { error: "unknown_principal", message: `no principal ${asked} is configured`, principal: asked } };
  return asked;
}

export function evidenceSource(parts: EvidenceParts): EvidenceReader {
  const source: EvidenceReader = {
    principals: [...parts.principals],
    execution: (id) => parts.executions.record(id),
    operation(scope, key) {
      if (!parts.lookupOn) return undefined;
      const stored = parts.lookup().find(scope, key);
      if (!stored) return undefined;
      // The record describes the write it was made by: its own key and principal. On the correct build they are the
      // key and principal asked for; a lookup defect that returns another key's record (FX-LOOK-1) or another
      // principal's (FX-LOOK-3) shows as a record that names them.
      const execution = parts.executions.bySeq(stored.seq);
      return operationRecord({ principal: execution?.principal ?? scope.principal }, execution?.request.key ?? key, stored, execution, parts.digest());
    },
    executions: () => parts.executions.all(),
    serve(pathname, query) {
      const m = /^\/(executions|operations)\/([^/]+)$/.exec(pathname);
      if (!m) return undefined;
      const id = decodeURIComponent(m[2]);
      if (m[1] === "operations" && !parts.lookupOn) return undefined;
      if (m[1] === "executions") {
        // Seams v2.1 (§1.4): execution ids are global, so ?principal= is optional here under any number of principals.
        // A record of another principal, or an id that is not configured, answers exactly as an unknown id: nothing leaks.
        const asked = query.get("principal");
        const x = source.execution(id);
        return x && (asked === null || x.principal === asked) ? { status: 200, body: x }
          : { status: 404, body: { error: "not_found", message: `no execution record ${id}` } };
      }
      const principal = evidencePrincipal(query, parts.principals);
      if (typeof principal !== "string") return principal;
      const op = source.operation({ principal }, id);
      return op ? { status: 200, body: op }
        : { status: 404, body: { error: "no_record", message: `${NO_RECORD}; ${NO_RECORD_NOTE}`, key: id, principal } };
    },
  };
  return source;
}
