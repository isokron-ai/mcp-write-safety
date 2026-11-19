// BACKEND DEFECT: replay-digest-mismatch (fixture property FX-DIG-2)
//
// A replay serves the same execution record id, canonical bytes and digest as
// the first answer.
//
// WRONG ON PURPOSE. Correct code: memoryKeyRecords in ../seams.ts, which keeps
// the committed response body and answers every repeat with exactly it.
//
// What goes wrong: the key record keeps the result, but a repeat re-renders it
// on the way out with a later updated_at, the way a handler that re-reads and
// re-serializes "the same" answer does. The replay names the same ticket and
// the same execution record, yet its bytes differ from the first answer's, so
// the digest a caller recomputes from the replay (and the operation record's
// result_digest) differ from the execution record's (contract A3's digest
// equality).
//
// Mirrors: no published finding; the research plan's R1 defect list.

import type { BackendDefect } from "./index.js";

export const replayDigestMismatch: BackendDefect = {
  name: "replay-digest-mismatch",
  summary: "a repeat re-renders the stored answer with a later updated_at, so its bytes and digest differ from the committed result",
  context: "FX-DIG-2",
  seams: ["keyRecord"],
  requires: ["execution-records"],
  apply(ops) {
    const correct = ops.keyRecord;
    ops.keyRecord = {
      ...correct,
      put: (scope, key, reply) => correct.put(scope, key, reply),
      dropRun: (scope, run) => correct.dropRun(scope, run),
      get(scope, key) {
        const found = correct.get(scope, key);
        if (found?.state !== "completed") return found;
        const stored = found.reply;
        const body = structuredClone(stored.body) as { ticket?: { updated_at?: string }; project?: { updated_at?: string } };
        // DEFECT: "the same" answer, rendered again: updated_at moves on. A fixed step (the stored time plus 1 ms), not
        // the clock's now, so the replay's bytes always differ from the first answer's, even within one millisecond
        // (G1 review: a clock read made FX-DIG-2 hold whenever the replay landed in the same millisecond).
        const later = (t: string | undefined) => (t === undefined ? t : new Date(Date.parse(t) + 1).toISOString());
        if (body?.ticket) body.ticket.updated_at = later(body.ticket.updated_at);
        if (body?.project) body.project.updated_at = later(body.project.updated_at);
        return { state: "completed", reply: { ...stored, body } };
      },
    };
  },
};
