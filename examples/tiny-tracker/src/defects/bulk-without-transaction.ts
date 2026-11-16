// DEFECT bulk-without-transaction -- MWS-ATOM-2 (SHOULD)
// Where the backend supports a transaction, a multi-resource write is
// all-or-nothing.
//
// WRONG ON PURPOSE. Correct code: deleteTickets in src/mcp/tools/tickets.ts,
// which deletes the matching tickets in one transactional /batch request.
//
// What goes wrong: delete_tickets deletes the matching tickets one by one.
// When one of them changed after it was listed (so it may no longer match),
// its delete is refused, but the ones before it are already gone. The report
// names what was deleted, what failed and what was not attempted, yet the
// caller is left with half a bulk delete although the backend offered an
// all-or-nothing batch.
//
// Mirrors: the rule-6 class in the Kubernetes audit (K8S-01: apply stops at
// the first refusal with earlier items applied); Payload's "what held up"
// shows the passing behavior (a server killed mid-write rolled back, 0 of 3).
//   https://isokron.ai/research/kubernetes-mcp-server-audit#findings-register
//   https://isokron.ai/research/payload-mcp-server-audit#what-held-up

import type { Defect } from "./types.js";
import { patchTool } from "./types.js";
import { fail, fromBackend, ok } from "../mcp/results.js";
import { namedFields } from "../mcp/tools/tickets.js";

export const defect: Defect = {
  name: "bulk-without-transaction",
  requirement: "MWS-ATOM-2",
  summary: "delete_tickets deletes one ticket at a time and leaves earlier deletes in place when a later one fails",
  mirrors: "Kubernetes K8S-01 class; Payload rollback (what held up)",
  replaces: "deleteTickets (src/mcp/tools/tickets.ts)",
  apply(build) {
    patchTool(build, "delete_tickets", {
      async handler(args, { api }) {
        const filter = namedFields(args, ["status", "title_prefix"]) as Record<string, string>;
        if (Object.keys(filter).length === 0 && args.all !== true) {
          return fail(`Refusing to delete every ticket in ${args.project}: give a filter or set all: true. Nothing was deleted.`);
        }
        const list = await api.request("GET", "/tickets", { query: { project: args.project, ...filter } });
        if (!list.ok) return fromBackend(list, `project ${args.project}`);
        const matches = list.body.tickets as Array<{ id: string; version: number }>;
        const deleted: string[] = [];
        // DEFECT: no transaction; each ticket is its own delete.
        for (const [i, t] of matches.entries()) {
          const res = await api.request("DELETE", `/tickets/${encodeURIComponent(t.id)}`, { ifMatch: t.version });
          if (!res.ok) {
            const rest = matches.slice(i + 1).map((m) => m.id);
            return fail(`Deleted ${deleted.join(", ") || "nothing"}; ${t.id} failed (${res.body?.message}). `
              + `Not attempted: ${rest.join(", ") || "none"}.`,
            { written: deleted.length > 0, deleted, failed: [{ id: t.id, reason: res.body?.message }], not_applied: rest });
          }
          deleted.push(t.id);
        }
        return ok(`Deleted ${deleted.length} ticket(s): ${deleted.join(", ") || "none"}.`, { deleted });
      },
    });
  },
};
