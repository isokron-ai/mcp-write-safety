// DEFECT force-by-default -- MWS-CONC-1 (MUST)
// Where the backend offers a concurrency control, the tool does not disable it
// by default. An override is an explicit argument, off by default.
//
// WRONG ON PURPOSE. Correct code: replaceTicket in src/mcp/tools/tickets.ts.
//
// What goes wrong: replace_ticket's `force` override defaults to true, so the
// backend's version check is skipped unless the caller knows to switch it off.
// A replace made from a stale read silently overwrites the newer ticket.
//
// Mirrors: Grafana GF-01 (`Overwrite: true` set unconditionally) and Payload
// PAY-01 / PAY-02 (`overrideLock` defaults to true; REST refuses with 423).
//   https://isokron.ai/research/grafana-mcp-server-audit#findings-register
//   https://isokron.ai/research/payload-mcp-server-audit#payload-findings

import type { Defect } from "./types.js";
import { patchTool } from "./types.js";

export const defect: Defect = {
  name: "force-by-default",
  requirement: "MWS-CONC-1",
  summary: "replace_ticket overwrites without the version check unless the caller passes force: false",
  mirrors: "Grafana GF-01; Payload PAY-01, PAY-02",
  replaces: "replaceTicket (src/mcp/tools/tickets.ts)",
  wraps: true,
  apply(build) {
    const correct = build.tools.get("replace_ticket")!;
    patchTool(build, "replace_ticket", {
      // DEFECT: the override is on unless the caller turns it off.
      handler: (args, deps) => correct.handler({ force: true, ...args }, deps),
    });
  },
};
