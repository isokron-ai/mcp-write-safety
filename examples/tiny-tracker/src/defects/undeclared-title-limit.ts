// DEFECT undeclared-title-limit -- MWS-IN-5 (SHOULD)
// A tool's input schema declares each fixed constraint on one argument that
// the server or its backend enforces.
//
// WRONG ON PURPOSE. Correct code: updateTicket in src/mcp/tools/tickets.ts,
// whose schema (title: maxLength 200) matches what it accepts.
//
// What goes wrong: update_ticket refuses titles over 100 characters, while
// its schema still advertises 200. A caller that follows the schema is
// refused with no way to know in advance.
//
// Mirrors: Payload PAY-12 (the schemas omitted field limits, so values valid
// by the schema were refused).
//   https://isokron.ai/research/payload-mcp-server-audit#payload-findings

import type { Defect } from "./types.js";
import { patchTool } from "./types.js";
import { fail } from "../mcp/results.js";

export const defect: Defect = {
  name: "undeclared-title-limit",
  requirement: "MWS-IN-5",
  summary: "update_ticket refuses titles over 100 characters while its schema says 200",
  mirrors: "Payload PAY-12",
  replaces: "updateTicket's limits (src/mcp/tools/tickets.ts)",
  wraps: true,
  apply(build) {
    const inner = build.tools.get("update_ticket")!;
    patchTool(build, "update_ticket", {
      async handler(args, deps, ctx) {
        // DEFECT: a limit the schema does not declare.
        if (typeof args.title === "string" && args.title.length > 100) {
          return fail("Invalid title: must be at most 100 characters. Nothing was written.", { field: "title" });
        }
        return inner.handler(args, deps, ctx);
      },
    });
  },
};
