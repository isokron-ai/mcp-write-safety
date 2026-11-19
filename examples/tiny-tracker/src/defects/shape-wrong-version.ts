// DEFECT shape-wrong-version -- MWS-RES-4 (SHOULD)
// A write returns a receipt with the object's new version.
//
// WRONG ON PURPOSE. Correct code: updateTicket and applied() in
// src/mcp/tools/tickets.ts and src/mcp/results.ts.
//
// What goes wrong: update_ticket's text says the right version, but the
// structured receipt ("mws.object.version") gives the version the ticket had
// before the write. A program that sends that version with its next write is
// refused, or worse, reads it as proof that its own write was not applied.
//
// Mirrors: none published; a structured receipt built from the request
// instead of the backend's answer (the same class as Grafana B1, B2).
//   https://isokron.ai/research/grafana-mcp-server-audit?utm_source=tiny-tracker-source&utm_medium=source#findings-register

import type { Defect } from "./types.js";
import { patchTool, rewriteShape } from "./types.js";

export const defect: Defect = {
  name: "shape-wrong-version",
  requirement: "MWS-RES-4",
  summary: "update_ticket's structured receipt gives the version before the write; the text gives the right one",
  mirrors: "Grafana B1, B2 (class)",
  replaces: "applied() in updateTicket (src/mcp/tools/tickets.ts)",
  wraps: true,
  apply(build) {
    const inner = build.tools.get("update_ticket")!;
    patchTool(build, "update_ticket", {
      async handler(args, deps, ctx) {
        const r = await inner.handler(args, deps, ctx);
        // DEFECT: the receipt's version is the one before the write.
        return rewriteShape(r, (m) => {
          if (m.outcome === "applied" && m.object?.version !== undefined && (m.changed ?? []).length) m.object.version = Number(m.object.version) - 1;
        });
      },
    });
  },
};
