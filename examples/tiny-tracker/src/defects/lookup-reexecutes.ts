// DEFECT lookup-reexecutes -- MWS-ANN-1 (MUST), and fixture property FX-LOOK-2
// A tool declared readOnlyHint: true leaves the state unchanged; a lookup
// never executes or repeats a write.
//
// WRONG ON PURPOSE. Correct code: getOperation in src/mcp/tools/operations.ts,
// which reads GET /operations/:key and reports a miss as "no record of this key
// now".
//
// What goes wrong: get_operation looks the key up, and when the backend has no
// record of it, "recovers" by sending a create with that key, so that the
// backend's keyed-replay rule answers with "the" outcome. On a key that was
// never used, or whose request is still on its way, that creates a ticket: a
// tool declared read-only writes, and a lookup turns a write that was never
// applied into one that was (and can race the original into a duplicate).
//
// Mirrors: no published finding; the research plan's R2 defect list.

import type { Defect } from "./types.js";
import { patchTool } from "./types.js";
import { fromBackend, ok } from "../mcp/results.js";
import { enc } from "../mcp/tools/common.js";

export const defect: Defect = {
  name: "lookup-reexecutes",
  requirement: "MWS-ANN-1",
  summary: "get_operation sends a create with the key when the backend has no record of it, so a read-only lookup writes",
  mirrors: "none published; the research plan's R2 defect list (FX-LOOK-2)",
  replaces: "getOperation (src/mcp/tools/operations.ts)",
  requires: ["execution-records", "lookup"],
  apply(build) {
    const correct = build.tools.get("get_operation")!;
    patchTool(build, "get_operation", {
      async handler(args, deps, ctx) {
        const key = args.idempotency_key as string;
        const found = await deps.api.request("GET", `/operations/${enc(key)}`);
        if (found.status !== 404) return correct.handler(args, deps, ctx);
        // DEFECT: a miss is "settled" by executing a write with the key.
        const res = await deps.api.request("POST", "/tickets", {
          body: { project: deps.config.defaultProject ?? "inbox", title: `recovered ${key}` }, idempotencyKey: key,
        });
        if (!res.ok) return fromBackend(res, `the record of idempotency_key ${JSON.stringify(key)}`);
        return ok(`The write with idempotency_key ${JSON.stringify(key)} was applied (ticket ${res.body.ticket.id}).`,
          { found: true, ticket: res.body.ticket.id });
      },
    });
  },
};
