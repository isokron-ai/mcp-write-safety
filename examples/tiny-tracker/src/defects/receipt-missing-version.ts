// DEFECT receipt-missing-version -- MWS-RES-4 (SHOULD)
// A write returns a receipt that identifies the object written, the fields
// changed and, where the resource has a version, its new version.
//
// WRONG ON PURPOSE. Correct code: updateTicket and receipt() in
// src/mcp/tools/tickets.ts.
//
// What goes wrong: update_ticket answers only "Updated T-12." The caller does
// not learn which fields changed or the new version, so it reads the ticket
// again before its next versioned write.
//
// Mirrors: Grafana B1 and B2 (a receipt with the applied operations and the
// stored state removed the verify reads callers otherwise made).
//   https://isokron.ai/research/grafana-mcp-server-audit#findings-register

import type { Defect } from "./types.js";
import { patchTool } from "./types.js";

export const defect: Defect = {
  name: "receipt-missing-version",
  requirement: "MWS-RES-4",
  summary: "update_ticket's answer omits the fields changed and the new version",
  mirrors: "Grafana B1, B2",
  replaces: "updateTicket's receipt (src/mcp/tools/tickets.ts)",
  wraps: true,
  apply(build) {
    const inner = build.tools.get("update_ticket")!;
    patchTool(build, "update_ticket", {
      async handler(args, deps, ctx) {
        const r = (await inner.handler(args, deps, ctx)) as { isError?: boolean; structuredContent?: { id?: string; replayed?: boolean } };
        if (r.isError) return r as never;
        // DEFECT: identity only; no changed fields, no version.
        const id = r.structuredContent?.id ?? args.id;
        return { content: [{ type: "text", text: `Updated ${id}.` }], structuredContent: { id, ...(r.structuredContent?.replayed ? { replayed: true } : {}) } };
      },
    });
  },
};
