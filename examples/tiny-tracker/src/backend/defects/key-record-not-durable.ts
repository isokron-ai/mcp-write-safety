// BACKEND DEFECT: key-record-not-durable (FX-DUR-1; trips MWS-RETRY-2 when the backend restarts)
//
// What goes wrong: the journal keeps every effect, but each commit line leaves
// its key record out, so key records live only in memory. Within one process a
// repeat is answered from memory as usual; after a whole-stack restart the data
// is back and the key is not, so a repeat of a keyed create applies again.
//
// Correct version: Journal.onCommit in ../journal.ts writes the key record in
// the commit line itself (FX-DUR-2), and the replay restores it.
//
// The behaviour lives where the seam is (src/backend/durability.ts reads the
// name); this file registers the defect, its seam and its requirement.

import type { BackendDefect } from "./index.js";

export const keyRecordNotDurable: BackendDefect = {
  name: "key-record-not-durable",
  summary: "The journal keeps the effects but not the key records; after a restart a keyed repeat applies again",
  context: "FX-DUR-1",
  seams: ["journal"],
  requires: ["durable"],
  apply() {
    // Acted on in src/backend/durability.ts (the journal leaves the key record out of each commit line).
  },
};
