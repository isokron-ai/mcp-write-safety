// BACKEND DEFECT: digest-of-current-state (fixture property FX-DIG-1)
//
// An execution record's digest is over the result as committed, not the
// object's current state.
//
// WRONG ON PURPOSE. Correct code: correctDigest in ../execution.ts, which
// hashes the committed response body the commit point handed to the record.
//
// What goes wrong: the digest seam looks the written ticket up and hashes the
// state it has when the record is read. Right after the write the two agree;
// after any later update to the ticket the served digest changes, so a delayed
// recovery (contract A5) finds a digest that no longer equals the one served
// at commit, and the record no longer describes the write it names.
//
// Mirrors: no published finding; the research plan's R1 defect list (a
// "receipt" built by re-reading the object).

import type { BackendDefect } from "./index.js";

export const digestOfCurrentState: BackendDefect = {
  name: "digest-of-current-state",
  summary: "the execution record's digest is taken over the ticket's current state, so it changes after a later update",
  context: "FX-DIG-1",
  seams: ["digest"],
  requires: ["execution-records"],
  apply(ops) {
    // It changes what is hashed and leaves how to the seam in place, so it composes with another digest defect.
    const inner = ops.digest;
    ops.digest = {
      resultDigest(body) {
        const b = (body ?? null) as { ticket?: { id?: string } } | null;
        const id = b?.ticket?.id;
        // DEFECT: the object as it is now, not as the write committed it.
        const current = typeof id === "string" && ops.store.tickets.has(id) ? { ...b, ticket: ops.store.getTicket(id) } : body;
        return inner.resultDigest(current);
      },
    };
  },
};
