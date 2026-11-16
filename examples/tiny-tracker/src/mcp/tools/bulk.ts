import type { ToolDef } from "../types.js";
import { applied as appliedShape, fail, fromBackend, notApplied, ok, type WriteContext } from "../results.js";
import { object, S, writes } from "./common.js";
import { namedFields } from "./tickets.js";

export const bulkUpdateTickets: ToolDef = {
  name: "bulk_update_tickets",
  title: "Update several tickets",
  description: "Set status and/or assignee on several tickets of one project. All-or-nothing: if any ticket cannot be "
    + "updated, none is, and the result says which ticket stopped it.",
  input: object({
    project: S.projectKey,
    ids: { type: "array", items: S.ticketId, minItems: 1, maxItems: 50 },
    status: S.status, assignee: S.assignee,
  }, ["project", "ids"]),
  mutates: true,
  annotations: writes({ destructive: true, idempotent: true }),
  async handler(args, { api }) {
    const w: WriteContext = { operation: "update", type: "ticket", scope: args.project, guard: null, read: { tool: "list_tickets", arguments: { project: args.project } } };
    const set = namedFields(args, ["status", "assignee"]);
    if (Object.keys(set).length === 0) return fail("Name status and/or assignee to set. Nothing was written.", {}, notApplied(w, "no_fields"));
    const ids: string[] = [...new Set(args.ids as string[])];
    // One transactional batch (MWS-ATOM-2); every ticket must be in the named project (MWS-TGT-1).
    const res = await api.request("POST", "/batch", {
      body: { ops: ids.map((id) => ({ op: "patch", id, project: args.project, set })) },
    });
    if (res.ok) {
      const applied = res.body.results.map((r: any) => ({ id: r.id, version: r.version, changed: r.changed }));
      return ok(`Updated ${applied.length} ticket(s) in ${args.project}: `
        + applied.map((a: any) => `${a.id} v${a.version}${a.changed.length ? "" : " (no change)"}`).join(", ") + ".",
      { applied, failed: [], not_applied: [] },
      appliedShape(w, { items: applied.map((a: any, index: number) => ({ index, id: a.id, version: a.version, outcome: "applied" as const })) }));
    }
    // No answer, or a server error: the batch may have been applied; say so rather than guess.
    if (res.status >= 500 || res.status === 0) return fromBackend(res, "the tickets", w);
    // The batch was refused as a whole: report every item's real outcome (MWS-ATOM-1).
    const failedId = res.body.id as string | undefined;
    const failed = failedId ? [{ id: failedId, reason: res.body.message }] : [];
    const notAppliedIds = ids.filter((id) => id !== failedId);
    return fail(`Nothing was changed: ${res.body.message}. The update is all-or-nothing, so none of `
      + `${ids.join(", ")} was updated.`, { applied: [], failed, not_applied: notAppliedIds },
    notApplied(w, failedId ? (res.body.error ?? "refused") : "refused", {
      ...(res.body.message ? { message: res.body.message } : {}),
      // All or nothing: the item that stopped the batch is not_applied with its reason; no request was sent for the rest.
      items: ids.map((id, index) => (id === failedId ? { index, id, outcome: "not_applied" as const, code: res.body.error ?? "refused", message: res.body.message } : { index, id, outcome: "not_attempted" as const })),
    }));
  },
};
