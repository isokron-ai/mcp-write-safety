// Read-only tools over the backend's evidence (feature lookup, 0.2.0; review
// G3): a caller that holds only an idempotency key can learn, with its own
// credentials and through MCP alone, whether the write it identifies was
// applied and what the committed result was (B-5's lookup by key; contract
// A3's K-only recovery).
//
//   get_operation  the operation record of a key, in the caller's scope
//   get_execution  one execution record: the committed result's canonical
//                  bytes and digest
//
// Neither tool writes anything, on any answer. A key with no record answers
// "no record of this key now", which says nothing about whether a write was
// applied (B-9 rule 4, review B9): a request still on its way can land later.

import type { ExecutionRecord, OperationRecord } from "../../records.js";
import type { ToolDef } from "../types.js";
import { fromBackend, ok } from "../results.js";
import { enc, object, readOnly, S } from "./common.js";

export const getOperation: ToolDef = {
  name: "get_operation",
  title: "Look a write up by its idempotency key",
  description: "Look up the write an idempotency_key identifies, among the writes made with your credentials: whether it was applied, "
    + "the execution record that holds its committed result, and the result's digest. Changes nothing. "
    + "When there is no record of the key, that does not mean nothing was written.",
  input: object({ idempotency_key: { ...S.idempotencyKey, description: "The idempotency_key the write was sent with." } }, ["idempotency_key"]),
  mutates: false,
  annotations: readOnly,
  async handler({ idempotency_key: key }, { api }) {
    const res = await api.request("GET", `/operations/${enc(key)}`);
    if (res.status === 404 && res.body?.error === "no_record") {
      // Rule 4: the miss is reported as a miss, never as "not applied".
      return ok(`No record of this key now (idempotency_key ${JSON.stringify(key)}). This does not mean nothing was written: `
        + "a request sent with this key may still be on its way. Before writing again, list the objects the write would have made.",
      { found: false, idempotency_key: key, message: "no record of this key now" });
    }
    if (!res.ok) return fromBackend(res, `the record of idempotency_key ${JSON.stringify(key)}`);
    const op = res.body as OperationRecord;
    return ok(`The write with idempotency_key ${JSON.stringify(op.key)} was applied once (state ${op.state}, status ${op.status}), `
      + `as execution ${op.execution_id}, committed at ${op.completed_at}.\n`
      + `result_digest: ${op.result_digest}\n`
      + `Read the committed result with get_execution and the arguments ${JSON.stringify({ id: op.execution_id })}.`,
    { found: true, operation: op });
  },
};

export const getExecution: ToolDef = {
  name: "get_execution",
  title: "Read an execution record",
  description: "Read one execution record (an id such as X-3, from get_operation): the write as committed, with the result's canonical bytes "
    + "and their SHA-256 digest. Only records of writes made with your credentials are shown. Changes nothing.",
  input: object({ id: { type: "string", pattern: "^X-[1-9][0-9]*$", description: "Execution record id, e.g. X-3." } }, ["id"]),
  mutates: false,
  annotations: readOnly,
  async handler({ id }, { api }) {
    const res = await api.request("GET", `/executions/${enc(id)}`);
    if (!res.ok) return fromBackend(res, `execution record ${id}`);
    const x = res.body as ExecutionRecord;
    return ok(`Execution ${x.id}: ${x.request.method} ${x.request.path}${x.request.key !== null ? ` with idempotency_key ${JSON.stringify(x.request.key)}` : ""}, `
      + `committed at ${x.committed_at}; objects: ${x.objects.map((o) => `${o.type} ${o.id}`).join(", ") || "none"}.\n`
      + `result digest (${x.result.alg}, ${x.result.domain}): ${x.result.digest}\n`
      + `canonical result: ${x.result.canonical}`,
    { execution: x });
  },
};
