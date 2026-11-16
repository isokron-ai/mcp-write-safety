import type { ToolDef } from "../types.js";
import { applied, fail, fromBackend, notApplied, ok } from "../results.js";
import { enc, object, S, writes } from "./common.js";
import { onTicket, receipt, versionGuard } from "./tickets.js";

export const addLabel: ToolDef = {
  name: "add_label",
  title: "Add a label",
  description: "Add one label to a ticket. Adding a label the ticket already has changes nothing. Returns the label's stable id.",
  input: object({ id: S.ticketId, name: S.labelName }, ["id", "name"]),
  mutates: true,
  annotations: writes({ destructive: false, idempotent: true }),
  async handler({ id, name }, { api }) {
    const w = onTicket("add_label", id, null);
    const res = await api.request("POST", `/tickets/${enc(id)}/labels`, { body: { name } });
    if (!res.ok) return fromBackend(res, `ticket ${id}`, w);
    const { ticket, label, created } = res.body;
    if (!created) {
      return ok(`${id} already has label "${name}" (${label.id}); nothing changed.`,
        { ...receipt(id, ticket.version, []), label_id: label.id }, applied(w, { version: ticket.version, changed: [] }));
    }
    return ok(`Added label "${name}" (${label.id}) to ${id}. Now at version ${ticket.version}.`,
      { ...receipt(id, ticket.version, ["labels"]), label_id: label.id }, applied(w, { version: ticket.version, changed: ["labels"] }));
  },
};

export const removeLabel: ToolDef = {
  name: "remove_label",
  title: "Remove a label",
  description: "Remove one label from a ticket by its label id (from get_ticket). The id stays valid when other labels change.",
  input: object({ id: S.ticketId, label_id: { type: "string", pattern: "^L-[0-9]+$" } }, ["id", "label_id"]),
  mutates: true,
  annotations: writes({ destructive: true, idempotent: true }),
  async handler({ id, label_id }, { api }) {
    const w = onTicket("remove_label", id, null);
    // Addressed by stable id, not by position (MWS-UPD-2).
    const res = await api.request("DELETE", `/tickets/${enc(id)}/labels/${enc(label_id)}`);
    if (!res.ok) return fromBackend(res, `label ${label_id} on ${id}`, w);
    return ok(`Removed label ${label_id} from ${id}. Now at version ${res.body.ticket.version}.`,
      receipt(id, res.body.ticket.version, ["labels"]), applied(w, { version: res.body.ticket.version, changed: ["labels"] }));
  },
};

export const setLabels: ToolDef = {
  name: "set_labels",
  title: "Replace all labels",
  description: "Replace a ticket's whole label list with the names given; labels not listed are removed. "
    + "Pass the expected_version you read; if the ticket changed since, nothing is written. force: true replaces "
    + "the list without that check; use it only when told to. To add or remove one label, use add_label or remove_label.",
  input: object({
    id: S.ticketId, labels: { type: "array", items: S.labelName, maxItems: 20 }, expected_version: S.expectedVersion,
    force: { type: "boolean", description: "Replace the list even if the ticket changed. Default false." },
  }, ["id", "labels"]),
  mutates: true,
  // It removes labels that are not listed, so it is destructive (MWS-ANN-2).
  annotations: writes({ destructive: true, idempotent: true }),
  async handler({ id, labels, expected_version, force }, { api }) {
    const w = onTicket("set_labels", id, versionGuard({ expected_version, force }), "expected_version");
    // A whole-list replace without the version would drop labels another writer added (MWS-CONC-1): the check is
    // the default, and skipping it needs the explicit override.
    if (expected_version === undefined && force !== true) {
      return fail("Pass expected_version (from get_ticket), or force: true to replace the labels without that check. "
        + "Nothing was written.", { field: "expected_version" }, notApplied(w, "version_required", { argument: "/expected_version" }));
    }
    const res = await api.request("PATCH", `/tickets/${enc(id)}`, { body: { labels }, ifMatch: force === true ? undefined : expected_version });
    if (!res.ok) return fromBackend(res, `ticket ${id}`, w);
    const { ticket, changed } = res.body;
    if (res.replayed) {
      return ok(`These labels were already set on ${id} (version ${ticket.version}); nothing new was written (replay).`,
        receipt(id, ticket.version, [], true), applied(w, { version: ticket.version, replayed: true }));
    }
    return ok(changed.length ? `Set labels of ${id} to ${labels.join(", ") || "(none)"}. Now at version ${ticket.version}.`
      : `No change: ${id} already had exactly these labels.`, receipt(id, ticket.version, changed), applied(w, { version: ticket.version, changed }));
  },
};
