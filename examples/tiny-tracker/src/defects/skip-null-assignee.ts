// DEFECT skip-null-assignee -- MWS-RES-1 (MUST)
// A tool reports success only when the requested change is in effect. A call
// that changed nothing says so or is an error.
//
// WRONG ON PURPOSE. Correct code: updateTicket and namedFields in
// src/mcp/tools/tickets.ts.
//
// What goes wrong: update_ticket keeps only truthy arguments, so
// `assignee: null` (unassign) is skipped while the other fields are written.
// The answer says the update succeeded; the ticket is still assigned.
//
// Mirrors: GitHub GH-06 (an empty title skipped, success reported) and
// Grafana GF-08 (`remove` on a missing key reports success).
//   https://isokron.ai/research/github-mcp-server-audit?utm_source=tiny-tracker-source&utm_medium=source#findings-register
//   https://isokron.ai/research/grafana-mcp-server-audit?utm_source=tiny-tracker-source&utm_medium=source#findings-register

import type { Defect } from "./types.js";
import { patchTool } from "./types.js";

export const defect: Defect = {
  name: "skip-null-assignee",
  requirement: "MWS-RES-1",
  summary: "update_ticket drops assignee: null (unassign), writes the rest and reports success",
  mirrors: "GitHub GH-06; Grafana GF-08",
  replaces: "namedFields in updateTicket (src/mcp/tools/tickets.ts)",
  wraps: true,
  apply(build) {
    const inner = build.tools.get("update_ticket")!;
    patchTool(build, "update_ticket", {
      // DEFECT: falsy values (null, "") are treated as "not given".
      handler: (args, deps) => inner.handler(Object.fromEntries(Object.entries(args).filter(([, v]) => v)), deps),
    });
  },
};
