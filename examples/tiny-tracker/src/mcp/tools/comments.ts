import type { ToolDef } from "../types.js";
import { applied, fromBackend, ok, type WriteContext } from "../results.js";
import { enc, object, S, writes } from "./common.js";

export const addComment: ToolDef = {
  name: "add_comment",
  title: "Add a comment",
  description: "Add a comment to a ticket. Returns the new comment's id. "
    + "Pass an idempotency_key so that retrying after a lost answer does not post the comment twice.",
  input: object({
    id: S.ticketId, body: { type: "string", minLength: 1, maxLength: 5000 }, idempotency_key: S.idempotencyKey,
  }, ["id", "body"]),
  mutates: true,
  annotations: writes({ destructive: false, idempotent: false }),
  async handler({ id, body, idempotency_key }, { api }) {
    // A nested create: the object is the comment, its parent the ticket (B-9 v2 object.parent); get_ticket shows whether it was added.
    const w: WriteContext = { operation: "create", type: "comment", parent: { type: "ticket", id }, guard: idempotency_key !== undefined ? "key" : null, read: { tool: "get_ticket", arguments: { id } } };
    const res = await api.request("POST", `/tickets/${enc(id)}/comments`, { body: { body }, idempotencyKey: idempotency_key });
    if (res.status === 422 && res.body?.error === "idempotency_key_reused") {
      return fromBackend(res, "comment", w);
    }
    if (!res.ok) return fromBackend(res, `ticket ${id}`, w);
    const { comment, ticket } = res.body;
    return ok(res.replayed
      ? `Comment ${comment.id} was already added by an earlier call with this idempotency_key; nothing new was written (replay).`
      : `Added comment ${comment.id} to ${id}. Ticket now at version ${ticket.version}.`,
    { id: comment.id, ticket: id, version: ticket.version, changed: res.replayed ? [] : ["comments"], replayed: res.replayed },
    applied(w, { id: comment.id, parentVersion: ticket.version, changed: ["body"], replayed: res.replayed }));
  },
};
