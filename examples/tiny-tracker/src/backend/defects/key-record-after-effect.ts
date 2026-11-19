// BACKEND DEFECT: key-record-after-effect (FX-DUR-2; the persistence gap, done wrong)
//
// What goes wrong: the effect is journalled in its commit line, and the key
// record in a second line written after the write is applied. Between the two
// there is a moment where the effect is durable and the key is not; a crash
// there (the crash-between-effect-and-record demonstration) leaves a ticket
// whose key is unknown after the restart, and the repeat creates a second one.
//
// Correct version: Journal.onCommit in ../journal.ts writes the effect and the
// key record in one line, so there is no point between them.

import type { BackendDefect } from "./index.js";

export const keyRecordAfterEffect: BackendDefect = {
  name: "key-record-after-effect",
  summary: "The effect and its key record are journalled in two lines; a crash between them loses the key",
  context: "FX-DUR-2",
  seams: ["journal"],
  requires: ["durable"],
  apply() {
    // Acted on in src/backend/durability.ts (a key line after the commit line).
  },
};
