// DEFECT read-merge-put -- MWS-CONC-3 (MUST)
// Two concurrent writes to different parts of one object do not both report
// success while one change is lost.
//
// WRONG ON PURPOSE. Correct code: updateTicket in src/mcp/tools/tickets.ts,
// which sends one per-field PATCH.
//
// What goes wrong: update_ticket reads the whole ticket, merges the caller's
// fields into it and writes the whole ticket back with PUT. The backend
// refuses a PUT without a version, so when the caller gave none the tool adds
// force=true. Two callers changing different fields at the same time both
// read the old ticket; the second PUT puts back the field the first changed.
// Both are told they succeeded.
//
// Mirrors: GitHub GH-01 (issue fields lost in 19 of 30 concurrent pairs) and
// Grafana GF-01 (30 of 30).
//   https://isokron.ai/research/github-mcp-server-audit#findings-register
//   https://isokron.ai/research/grafana-mcp-server-audit#findings-register

import type { Defect } from "./types.js";
import { patchTool } from "./types.js";
import { fail, fromBackend, ok } from "../mcp/results.js";
import { namedFields, receipt } from "../mcp/tools/tickets.js";

export const defect: Defect = {
  name: "read-merge-put",
  requirement: "MWS-CONC-3",
  summary: "update_ticket reads, merges and force-PUTs the whole ticket, losing concurrent changes to other fields",
  mirrors: "GitHub GH-01; Grafana GF-01",
  replaces: "updateTicket (src/mcp/tools/tickets.ts)",
  apply(build) {
    patchTool(build, "update_ticket", {
      async handler(args, { api }) {
        const fields = namedFields(args);
        if (Object.keys(fields).length === 0) return fail("Name at least one field to change. Nothing was written.");
        // (Kept from the correct tool: without a version the caller must say force: true.)
        if (args.expected_version === undefined && args.force !== true) {
          return fail("Pass expected_version (from get_ticket), or force: true to write without that check. Nothing was written.", { field: "expected_version" });
        }
        const path = `/tickets/${encodeURIComponent(args.id)}`;
        const read = await api.request("GET", path);
        if (!read.ok) return fromBackend(read, `ticket ${args.id}`);
        const { title, status, assignee, priority } = read.body.ticket;
        // DEFECT: the whole ticket is written back from a read that may already be stale,
        // and without a caller version the backend's check is forced off.
        const res = await api.request("PUT", path, {
          body: { title, status, assignee, priority, ...fields },
          ifMatch: args.expected_version,
          query: { force: args.expected_version === undefined ? "true" : undefined },
        });
        if (!res.ok) return fromBackend(res, `ticket ${args.id}`);
        const { ticket, changed } = res.body;
        if (res.replayed) return ok(`Already applied to ${ticket.id} (replay).`, receipt(ticket.id, ticket.version, [], true));
        return ok(changed.length ? `Updated ${ticket.id}: ${changed.join(", ")}. Now at version ${ticket.version}.`
          : `No change: ${ticket.id} already had these values.`, receipt(ticket.id, ticket.version, changed));
      },
    });
  },
};
