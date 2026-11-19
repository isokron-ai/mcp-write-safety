// DEFECT delete-refetches-version -- MWS-CONC-2 (MUST)
// A write made from an earlier read is refused with a conflict when the object
// changed since that read. Tools that delete accept the version the caller read.
//
// WRONG ON PURPOSE. Correct code: deleteTicket in src/mcp/tools/tickets.ts.
//
// What goes wrong: delete_ticket accepts expected_version but, "to avoid
// spurious conflicts", reads the ticket's current version right before the
// DELETE and sends that instead. The precondition can then never fail, so a
// ticket someone edited after the caller's read is deleted anyway.
//
// Mirrors: GitHub GH-02 (`delete_file` takes no sha) and Grafana GF-19 (a
// stale body replaced an edit, 3 of 3).
//   https://isokron.ai/research/github-mcp-server-audit?utm_source=tiny-tracker-source&utm_medium=source#findings-register
//   https://isokron.ai/research/grafana-mcp-server-audit?utm_source=tiny-tracker-source&utm_medium=source#findings-register

import type { Defect } from "./types.js";
import { patchTool } from "./types.js";
import { fail, fromBackend, ok } from "../mcp/results.js";

export const defect: Defect = {
  name: "delete-refetches-version",
  requirement: "MWS-CONC-2",
  summary: "delete_ticket replaces the caller's expected_version with the current one, so stale deletes succeed",
  mirrors: "GitHub GH-02; Grafana GF-19",
  replaces: "deleteTicket (src/mcp/tools/tickets.ts)",
  apply(build) {
    patchTool(build, "delete_ticket", {
      async handler({ id, expected_version, force }, { api }) {
        // (Kept from the correct tool: without a version the caller must say force: true.)
        if (expected_version === undefined && force !== true) {
          return fail("Pass expected_version (from get_ticket), or force: true to delete without that check. Nothing was deleted.", { field: "expected_version" });
        }
        let version: number | undefined;
        if (expected_version !== undefined) {
          // DEFECT: the caller's version is thrown away and refreshed here.
          const current = await api.request("GET", `/tickets/${encodeURIComponent(id)}`);
          version = current.version;
        }
        const res = await api.request("DELETE", `/tickets/${encodeURIComponent(id)}`, { ifMatch: version });
        if (!res.ok) return fromBackend(res, `ticket ${id}`);
        return ok(`Deleted ${id}.`, { id, deleted: true });
      },
    });
  },
};
