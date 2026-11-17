// BACKEND DEFECT: lost-update (demonstrates the `platform` verdict)
//
// Requirement context: MWS-CONC-3. With this defect the backend's own PATCH
// loses one of two concurrent updates to different fields, so the same loss
// shows through the MCP server *and* through the REST API called directly.
// A tester must then report `platform`, not `violated`: the MCP layer is no
// worse than the platform it wraps.
//
// Mirrors: PostHog C1 (the platform API itself lost 6 of 11 concurrent
// updates); the specification's NF-1 cites a second platform case.
//   https://isokron.ai/research/posthog-mcp-server-audit#findings-register
//
// What goes wrong: the handler takes a copy of the ticket, waits (standing
// in for a slow storage round trip), writes the copy back and then applies
// the patch to it. The precondition is checked before the wait, so it cannot
// catch a write that lands during it; that write is overwritten by the stale
// copy. Everything else (fields, labels, the list of changed fields) is
// handled by the correct code; only the timing is wrong.
//
// Correct version: Store.patchTicket in ../store.ts, which reads, checks and
// writes with no await in between.

import { setTimeout as sleep } from "node:timers/promises";
import type { BackendDefect } from "./index.js";
import { ApiError } from "../store.js";

export const lostUpdate: BackendDefect = {
  name: "lost-update",
  summary: "PATCH copies the record, waits, writes the stale copy back, then patches it; concurrent updates are lost",
  context: "MWS-CONC-3",
  seams: ["patchTicket"],
  requires: [],
  apply(ops) {
    ops.patchTicket = async (store, id, fields, ifMatch) => {
      const snapshot = store.getTicket(id); // a copy
      if (typeof ifMatch === "number" && ifMatch !== snapshot.version) {
        throw new ApiError(412, "precondition_failed", `ticket ${id} is at version ${snapshot.version}`, { current: snapshot });
      }
      await sleep(50); // DEFECT: another write can land here ...
      store.tickets.set(id, snapshot); // ... and is overwritten by the stale copy
      return store.patchTicket(id, fields);
    };
  },
};
