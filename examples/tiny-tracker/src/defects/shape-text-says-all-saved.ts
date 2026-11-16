// DEFECT shape-text-says-all-saved -- MWS-ATOM-1 (MUST)
// A multi-item write that is not applied completely does not report success,
// in its text as in its structured result: a correct shape does not make up
// for a sentence that says the whole write took effect (spec R15-3, rule 11).
//
// WRONG ON PURPOSE. Correct code: bulkUpdateTickets in src/mcp/tools/bulk.ts
// (one all-or-nothing batch, every item in "items").
//
// What goes wrong: bulk_update_tickets patches the tickets one by one. When
// one fails, the result is an error and its shape is right ("outcome":
// "partial", each ticket in "items" with its own outcome), but its sentence
// says "All 3 tickets saved". A caller that reads only the text believes the
// whole write took effect.
//
// Mirrors: Payload PAY-05 (bulk update reports success when some documents
// failed) and Kubernetes K8S-01 (apply stops at the first refusal).
//   https://isokron.ai/research/payload-mcp-server-audit#payload-findings
//   https://isokron.ai/research/kubernetes-mcp-server-audit#findings-register

import type { Defect } from "./types.js";
import { patchTool } from "./types.js";
import { applied as appliedShape, fail, ok, type WriteContext } from "../mcp/results.js";
import { namedFields } from "../mcp/tools/tickets.js";

export const defect: Defect = {
  name: "shape-text-says-all-saved",
  requirement: "MWS-ATOM-1",
  summary: "bulk_update_tickets writes one by one; after a partial apply its shape is right but its sentence says all tickets were saved",
  mirrors: "Payload PAY-05; Kubernetes K8S-01",
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
        // The shape is right: every ticket in items with its own outcome, and the whole write partial (or not applied).
        const items = ids.map((id, index) => {
          const d = done.find((x) => x.id === id);
          return d ? { index, id, version: d.version, outcome: "applied" as const } : { index, id, outcome: "not_applied" as const, code: "not_found" };
        });
        const base = appliedShape(w, { items });
        const m = failed.length ? { ...base, outcome: (done.length ? "partial" : "not_applied") as "partial" | "not_applied" } : base;
        // DEFECT: the sentence says the whole write took effect, whatever happened.
        const r = ok(`All ${ids.length} tickets saved: ${ids.join(", ")}.`, { applied: done, failed, not_applied: failed.map((f) => f.id) }, m);
        return failed.length ? { ...r, isError: true } : r;
      },
    });
  },
};
