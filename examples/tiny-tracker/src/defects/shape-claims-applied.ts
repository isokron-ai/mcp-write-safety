// DEFECT shape-claims-applied -- MWS-RES-1 (MUST)
// A write tool reports success only when the state the caller asked for is in
// effect. A structured outcome is a report like any other: the read-back
// decides whether it is true.
//
// WRONG ON PURPOSE. Correct code: updateTicket in src/mcp/tools/tickets.ts.
//
// What goes wrong: update_ticket answers a call that renames and unassigns
// at once (title and assignee: null) from the ticket as it stands, without
// writing it. Its result says
// "outcome": "applied" with the fields named in "changed", at the version the
// ticket already had. Nothing was written.
//
// Mirrors: Payload PAY-04 (fields not stored, success text returned) and
// GitHub GH-06 (success with nothing changed), here in the structured shape.
//   https://isokron.ai/research/payload-mcp-server-audit#payload-findings
//   https://isokron.ai/research/github-mcp-server-audit#findings-register

import type { Defect } from "./types.js";
import { patchTool } from "./types.js";
import { applied, ok } from "../mcp/results.js";
import { namedFields, onTicket, receipt, versionGuard } from "../mcp/tools/tickets.js";

export const defect: Defect = {
  name: "shape-claims-applied",
  requirement: "MWS-RES-1",
  summary: "update_ticket answers a rename that unassigns with outcome applied and the fields in changed, and writes nothing",
  mirrors: "Payload PAY-04; GitHub GH-06",
  replaces: "updateTicket (src/mcp/tools/tickets.ts)",
  wraps: true,
  apply(build) {
    const inner = build.tools.get("update_ticket")!;
    patchTool(build, "update_ticket", {
      async handler(args, deps, ctx) {
        // (Only this one form of call, so that with every defect on no other check loses its update.)
        if (args.title === undefined || args.assignee !== null) return inner.handler(args, deps, ctx);
        const res = await deps.api.request("GET", `/tickets/${encodeURIComponent(args.id)}`);
        if (!res.ok) return inner.handler(args, deps, ctx);
        const t = res.body.ticket;
        const changed = Object.keys(namedFields(args, ["title", "status", "assignee", "priority", "description", "details"]));
        // DEFECT: the shape claims the write; nothing was sent.
        return ok(`Updated ${t.id}: ${changed.join(", ")}. Now at version ${t.version}.`, receipt(t.id, t.version, changed),
          applied(onTicket("update", t.id, versionGuard(args), "expected_version"), { version: t.version, changed }));
      },
    });
  },
};
