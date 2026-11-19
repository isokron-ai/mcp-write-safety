// DEFECT settle-miss-reported-not-applied -- MWS-RES-1 (MUST); needs the inflight feature
// Success (and "nothing applied") only when the state asked about is so.
//
// WRONG ON PURPOSE. Correct code: the settle-by-lookup variant
// (src/variants/settle-by-lookup.ts), which looks the key up behind a fence.
//
// What goes wrong: after a lost backend answer, create_ticket looks the key up
// with no fence and, finding no record, reports not_applied. A miss is final
// only if the original request can no longer arrive: a request held on its way
// lands after the lookup, and the ticket the server said was not created exists.
// Shown with a request held, the lookup run, then the request released.
//
// Mirrors: none published; review B9.

import type { Defect } from "./types.js";
import { applySettleByLookup } from "../variants/settle-by-lookup.js";

export const defect: Defect = {
  name: "settle-miss-reported-not-applied",
  requirement: "MWS-RES-1",
  summary: "After a lost backend answer, a lookup miss with no fence is reported as not applied, though the held request can still land",
  mirrors: "none published; review B9",
  replaces: "applySettleByLookup(build, \"fence\") (src/variants/settle-by-lookup.ts)",
  requires: ["inflight"],
  apply(build) {
    // DEFECT: peek instead of fence.
    applySettleByLookup(build, "peek");
  },
};
