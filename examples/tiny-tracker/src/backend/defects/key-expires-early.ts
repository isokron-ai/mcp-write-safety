// BACKEND DEFECT: key-expires-early (FX-KEY-1)
//
// What goes wrong: the tools state a retention of 7 days, but key records are
// kept for a thousandth of it (about 10 minutes). Inside the stated window a
// repeat meets a tombstone (refuse) or applies again (forget).
//
// Correct version: keyExpiry in ../expiry.ts, with the stated retention.

import type { BackendDefect } from "./index.js";

export const keyExpiresEarly: BackendDefect = {
  name: "key-expires-early",
  summary: "Key records are kept a thousandth of the stated retention",
  context: "FX-KEY-1",
  seams: ["keyExpiry"],
  requires: ["retention"],
  apply() {
    // Acted on in src/backend/durability.ts (the retention is divided by 1000).
  },
};
