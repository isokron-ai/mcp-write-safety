// DEFECT shape-missing-failed -- MWS-ATOM-1 (MUST)
// A multi-item write that is not applied completely names which items were
// applied and which were not.
//
// WRONG ON PURPOSE. Correct code: bulkUpdateTickets in src/mcp/tools/bulk.ts
// (one all-or-nothing batch, every item in "items").
//
// What goes wrong: bulk_update_tickets patches the tickets one by one. When
// one fails, the result is an error, but its shape says "outcome": "applied"
// and lists only the tickets that were updated: the item that failed is not
// in "items", so the outcome covers it and the shape reports it as applied.
//
// Mirrors: Kubernetes K8S-01 (apply stops at the first refusal and does not
// say what was applied) and Payload PAY-05 (bulk update reports success when
// some documents failed).
//   https://isokron.ai/research/kubernetes-mcp-server-audit?utm_source=tiny-tracker-source&utm_medium=source#findings-register
//   https://isokron.ai/research/payload-mcp-server-audit?utm_source=tiny-tracker-source&utm_medium=source#payload-findings

import type { Defect } from "./types.js";
import { patchTool } from "./types.js";
import { applied as appliedShape, fail, ok, type WriteContext } from "../mcp/results.js";
import { namedFields } from "../mcp/tools/tickets.js";

export const defect: Defect = {
  name: "shape-missing-failed",
  requirement: "MWS-ATOM-1",
  summary: "bulk_update_tickets writes one by one; on a failure its shape lists only the applied tickets, under outcome applied",
  mirrors: "Kubernetes K8S-01; Payload PAY-05",
  replaces: "bulkUpdateTickets (src/mcp/tools/bulk.ts)",
  apply(build) {
    patchTool(build, "bulk_update_tickets", {
      async handler(args, { api }) {
        const w: WriteContext = { operation: "update", type: "ticket", scope: args.project, guard: null, read: { tool: "list_tickets", arguments: { project: args.project } } };
        const set = namedFields(args, ["status", "assignee"]);
        if (Object.keys(set).length === 0) return fail("Name status and/or assignee to set. Nothing was written.");
        const ids: string[] = [...new Set(args.ids as string[])];
        const done: Array<{ id: string; version: number }> = [];
        const failed: Array<{ id: string; reason: string }> = [];
        for (const id of ids) {
          const res = await api.request("PATCH", `/tickets/${encodeURIComponent(id)}`, { body: set });
          if (res.ok) done.push({ id, version: res.body.ticket.version });
          else failed.push({ id, reason: res.body?.message ?? `status ${res.status}` });
        }
        // DEFECT: the items list only what was applied, and the outcome says applied; nothing names the failures.
        const m = appliedShape(w, { items: done.map((d) => ({ index: ids.indexOf(d.id), id: d.id, version: d.version, outcome: "applied" as const })) });
        const text = `Updated ${done.map((d) => d.id).join(", ") || "nothing"}${failed.length ? `; ${failed.map((f) => `${f.id} failed (${f.reason})`).join(", ")}` : ""}.`;
        const r = ok(text, { applied: done, failed, not_applied: failed.map((f) => f.id) }, m);
        return failed.length ? { ...r, isError: true } : r;
      },
    });
  },
};
