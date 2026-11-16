// DEFECT update-adds-defaults -- MWS-UPD-1 (MUST)
// An update changes only the fields its arguments name.
//
// WRONG ON PURPOSE. Correct code: updateTicket in src/mcp/tools/tickets.ts.
//
// What goes wrong: update_ticket fills in the defaults of create_ticket
// (status "open", priority 3) before sending the PATCH, as happens when an
// update reuses the create schema and its defaults. A caller who changes only
// the title also reopens the ticket and resets its priority, and is told the
// update succeeded.
//
// Mirrors: Grafana GF-03 (omitted alert-rule fields reset to defaults, 3 of 3)
// and PostHog G1 (nested defaults the caller did not send).
//   https://isokron.ai/research/grafana-mcp-server-audit#findings-register

import type { Defect } from "./types.js";
import { patchTool } from "./types.js";

export const defect: Defect = {
  name: "update-adds-defaults",
  requirement: "MWS-UPD-1",
  summary: "update_ticket resets status and priority to create-time defaults when the caller omits them",
  mirrors: "Grafana GF-03; PostHog G1",
  replaces: "updateTicket (src/mcp/tools/tickets.ts)",
  wraps: true,
  apply(build) {
    const correct = build.tools.get("update_ticket")!;
    patchTool(build, "update_ticket", {
      // DEFECT: defaults the caller never sent are merged under the caller's arguments.
      handler: (args, deps) => correct.handler({ status: "open", priority: 3, ...args }, deps),
    });
  },
};
