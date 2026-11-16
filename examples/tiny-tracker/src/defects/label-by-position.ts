// DEFECT label-by-position -- MWS-UPD-2 (SHOULD)
// A tool that edits one element of a list addresses it by a stable identifier.
//
// WRONG ON PURPOSE. Correct code: removeLabel in src/mcp/tools/labels.ts.
//
// What goes wrong: remove_label takes the label's position in the list as the
// caller last saw it. If another label was removed since that read, the
// position now points at a different label, and that one is removed instead.
// (The schema has to change for this defect: the argument is a position, not
// a label id. The tool's own read-then-write is guarded by If-Match, so the
// only defect is the positional address.)
//
// Mirrors: Grafana GF-02 (the wrong panel edited because panels were addressed
// by position, 5 of 5) and Payload PAY-06 (row ids refused).
//   https://isokron.ai/research/grafana-mcp-server-audit#findings-register

import type { Defect } from "./types.js";
import { patchTool } from "./types.js";
import { fromBackend, ok } from "../mcp/results.js";
import { object, S, writes } from "../mcp/tools/common.js";
import { receipt } from "../mcp/tools/tickets.js";

export const defect: Defect = {
  name: "label-by-position",
  requirement: "MWS-UPD-2",
  summary: "remove_label removes the label at a list position, which shifts when the list changes",
  mirrors: "Grafana GF-02; Payload PAY-06",
  replaces: "removeLabel (src/mcp/tools/labels.ts)",
  apply(build) {
    patchTool(build, "remove_label", {
      description: "Remove the label at a position (0-based, in the order get_ticket shows).",
      // Honest for this behavior: removing "position 0" twice removes two labels.
      annotations: writes({ destructive: true, idempotent: false }),
      input: object({ id: S.ticketId, position: { type: "integer", minimum: 0, maximum: 19 } }, ["id", "position"]),
      async handler({ id, position }, { api }) {
        const read = await api.request("GET", `/tickets/${encodeURIComponent(id)}`);
        if (!read.ok) return fromBackend(read, `ticket ${id}`);
        // DEFECT: the position is applied to the list as it is now, not as the caller read it.
        const names: string[] = read.body.ticket.labels.map((l: { name: string }) => l.name);
        names.splice(position, 1);
        const res = await api.request("PATCH", `/tickets/${encodeURIComponent(id)}`, { body: { labels: names }, ifMatch: read.version });
        if (!res.ok) return fromBackend(res, `ticket ${id}`);
        return ok(`Removed the label at position ${position} from ${id}.`, receipt(id, res.body.ticket.version, res.body.changed));
      },
    });
  },
};
