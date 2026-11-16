// DEFECT bulk-misreports-partial -- MWS-ATOM-1 (MUST)
// A multi-item write reports each item's outcome exactly. The result names
// what was applied and what was left behind.
//
// WRONG ON PURPOSE. Correct code: bulkUpdateTickets in src/mcp/tools/bulk.ts.
//
// What goes wrong: bulk_update_tickets uses the backend's all-or-nothing
// batch, but its error report was written for a one-by-one loop: it says the
// tickets before the failing one were updated. In fact the batch applied
// nothing. The caller is told about changes that do not exist.
//
// Mirrors: Kubernetes K8S-01 (apply stops at the first refusal and does not
// say what was applied) and K8S-06 / K8S-15 (items dropped with success).
//   https://isokron.ai/research/kubernetes-mcp-server-audit#findings-register

import type { Defect } from "./types.js";
import { patchTool } from "./types.js";
import { fail, fromBackend, ok } from "../mcp/results.js";
import { namedFields } from "../mcp/tools/tickets.js";

export const defect: Defect = {
  name: "bulk-misreports-partial",
  requirement: "MWS-ATOM-1",
  summary: "bulk_update_tickets claims the items before a failing one were applied when the batch applied nothing",
  mirrors: "Kubernetes K8S-01, K8S-06, K8S-15",
  replaces: "bulkUpdateTickets (src/mcp/tools/bulk.ts)",
  apply(build) {
    patchTool(build, "bulk_update_tickets", {
      async handler(args, { api }) {
        const set = namedFields(args, ["status", "assignee"]);
        if (Object.keys(set).length === 0) return fail("Name status and/or assignee to set. Nothing was written.");
        const ids: string[] = [...new Set(args.ids as string[])];
        const res = await api.request("POST", "/batch", { body: { ops: ids.map((id) => ({ op: "patch", id, project: args.project, set })) } });
        if (res.ok) return ok(`Updated ${ids.length} ticket(s).`, { applied: res.body.results, failed: [], not_applied: [] });
        if (res.status >= 500) return fromBackend(res, "the tickets");
        // DEFECT: assumes the items before the failing index were applied. The batch applied none.
        const index = ids.indexOf(res.body.id);
        const applied = ids.slice(0, index).map((id) => ({ id }));
        return fail(`Updated ${applied.map((a) => a.id).join(", ") || "nothing"}; stopped at ${res.body.id}: ${res.body.message}.`,
          { applied, failed: [{ id: res.body.id, reason: res.body.message }], not_applied: ids.slice(index + 1) });
      },
    });
  },
};
