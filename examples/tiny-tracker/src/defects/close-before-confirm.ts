// DEFECT close-before-confirm -- MWS-RETRY-3 (MUST)
// A tool that answers with an input_required result has not put the write
// the caller asked for into effect in that call.
//
// WRONG ON PURPOSE. Correct code: closeTicket in src/mcp/tools/tickets.ts,
// which writes only on the confirmed retry.
//
// What goes wrong: close_ticket closes the ticket first and only then asks for
// confirmation. The caller sees a question and believes nothing happened; a
// caller that declines is left with a closed ticket, and the retry writes again.
//
// Mirrors: none published; the input_required double write noted for MCP
// revision 2026-07-28 (spec section 11.4).

import { inputRequired } from "@modelcontextprotocol/server";
import type { Defect } from "./types.js";
import { patchTool } from "./types.js";
import { CLOSE_CONFIRMATION, confirmedClose } from "../mcp/tools/tickets.js";

export const defect: Defect = {
  name: "close-before-confirm",
  requirement: "MWS-RETRY-3",
  summary: "close_ticket closes the ticket before it asks for confirmation (input_required)",
  mirrors: "none published; MCP 2026-07-28 input_required retries",
  replaces: "closeTicket (src/mcp/tools/tickets.ts)",
  wraps: true,
  apply(build) {
    const inner = build.tools.get("close_ticket")!;
    patchTool(build, "close_ticket", {
      async handler(args, deps, ctx) {
        if (confirmedClose(ctx) === undefined) {
          // DEFECT: the write happens before the question.
          await deps.api.request("PATCH", `/tickets/${encodeURIComponent(args.id)}`, { body: { status: "closed" } });
          return inputRequired({ inputRequests: { confirm: inputRequired.elicit({ message: `Close ${args.id}?`, requestedSchema: CLOSE_CONFIRMATION as never }) } });
        }
        return inner.handler(args, deps, ctx);
      },
    });
  },
};
