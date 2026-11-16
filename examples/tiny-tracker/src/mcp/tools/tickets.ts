import { inputRequired } from "@modelcontextprotocol/server";
import type { ToolDef } from "../types.js";
import { applied, fail, fromBackend, notApplied, ok, type WriteContext } from "../results.js";
import { enc, object, readOnly, S, writes } from "./common.js";

const FIELDS = ["title", "status", "assignee", "priority"] as const;
/** update_ticket also sets the free-text description and the nested details (a merge of the sub-fields named). */
const UPDATE_FIELDS = [...FIELDS, "description", "details"] as const;

/** Picks the fields the caller named. A field set to null is named; an absent one is not. */
export function namedFields(args: Record<string, unknown>, keys: readonly string[] = FIELDS): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (Object.prototype.hasOwnProperty.call(args, key)) out[key] = args[key];
  return out;
}

/** The compact receipt every ticket write returns (MWS-RES-4): identity, new version, fields changed. */
export function receipt(id: string, version: number, changed: string[], replayed = false) {
  return { id, version, changed, replayed };
}

/** The write context of a call on one ticket (the read that shows it is get_ticket). */
export function onTicket(operation: string, id: string, guard: WriteContext["guard"], versionArgument?: string): WriteContext {
  return { operation, type: "ticket", id, guard, read: { tool: "get_ticket", arguments: { id } }, ...(versionArgument ? { versionArgument } : {}) };
}

/** A call that carries the version it read is guarded by it, unless the version check is turned off with force. */
export const versionGuard = (a: { expected_version?: number; force?: boolean }): WriteContext["guard"] => (a.expected_version !== undefined && a.force !== true ? "version" : null);

/**
 * P-8 (conflict-wording study, re-pilot 3; spec R12-1): label names are quoted, each with its stable id beside it in
 * JSON, and the version is on its own line ("labels urgent=L-1, v4=L-2" misled a model once even after a full re-read).
 */
export function showTicket(t: any) {
  const labels = (t.labels as any[]).map((l) => ({ name: l.name, id: l.id }));
  return ok(`${t.id} in ${t.project}: ${JSON.stringify(t.title)} (status ${t.status}, priority ${t.priority}, assignee ${t.assignee == null ? "none" : JSON.stringify(t.assignee)}, `
    + `${t.comments.length} comment(s))\n`
    + `labels: [${labels.map((l) => `{"name": ${JSON.stringify(l.name)}, "id": ${JSON.stringify(l.id)}}`).join(", ")}]\n`
    + `current expected_version: ${t.version}`, t);
}

/** One list_tickets line (P-8): T-3 [docs] open "Fix the docs"; current expected_version: 3 */
export function listLine(t: { id: string; project: string; status: string; title: string; version: number }): string {
  return `${t.id} [${t.project}] ${t.status} ${JSON.stringify(t.title)}; current expected_version: ${t.version}`;
}

export const listTickets: ToolDef = {
  name: "list_tickets",
  title: "List tickets",
  description: "List tickets, optionally filtered by project, status and title prefix.",
  input: object({ project: S.projectKey, status: S.status, title_prefix: { type: "string", minLength: 1, maxLength: 200 } }),
  mutates: false,
  annotations: readOnly,
  async handler(args, { api }) {
    const res = await api.request("GET", "/tickets", { query: args });
    if (!res.ok) return fromBackend(res, "tickets");
    const tickets = (res.body.tickets as any[]).map(({ id, project, title, status, assignee, priority, version }) =>
      ({ id, project, title, status, assignee, priority, version }));
    // P-8 (spec R12-1): the title is quoted as a JSON string and the version given on its own, so neither can be read as the other.
    return ok(tickets.map((t) => listLine(t)).join("\n") || "No tickets.",
      { tickets });
  },
};

export const getTicket: ToolDef = {
  name: "get_ticket",
  title: "Get a ticket",
  description: "Read one ticket with its labels (each with a stable label id), comments and current version.",
  input: object({ id: S.ticketId }, ["id"]),
  mutates: false,
  annotations: readOnly,
  async handler({ id }, { api }) {
    const res = await api.request("GET", `/tickets/${enc(id)}`);
    // The not-found answer names the argument (id), like a validation error would (MWS-IN-4).
    if (!res.ok) return fromBackend(res, `ticket with id ${id}`);
    return showTicket(res.body.ticket);
  },
};

export const createTicket: ToolDef = {
  name: "create_ticket",
  title: "Create a ticket",
  description: "Create a ticket in a project (default: the server's default project). "
    + "Pass an idempotency_key so that retrying after a lost answer does not create a second ticket.",
  input: object({
    project: S.projectKey, title: S.title, status: S.status, assignee: S.assignee, priority: S.priority,
    description: S.description, details: S.details,
    labels: { type: "array", items: S.labelName, maxItems: 20 }, idempotency_key: S.idempotencyKey,
  }, ["title"]),
  mutates: true,
  annotations: writes({ destructive: false, idempotent: false }),
  async handler(args, { api, config }) {
    const { idempotency_key, ...fields } = args;
    // The scope argument is honored; the default applies only when the caller gave none (MWS-TGT-1).
    const project = args.project ?? config.defaultProject;
    // Before the create there is no id: an open outcome is settled by listing the project. The key guards a repeat.
    const w: WriteContext = { operation: "create", type: "ticket", ...(project !== undefined ? { scope: project } : {}), guard: idempotency_key !== undefined ? "key" : null,
      read: { tool: "list_tickets", arguments: project !== undefined ? { project } : {} } };
    const res = await api.request("POST", "/tickets", { body: { ...fields, project }, idempotencyKey: idempotency_key });
    if (res.status === 422 && res.body?.error === "idempotency_key_reused") {
      return fail("This idempotency_key was already used with different arguments; nothing was written. "
        + "If you are retrying the same create, send exactly the same arguments as the first call; list your tickets "
        + "before using a new key, or you may create a duplicate.", { error: "idempotency_key_reused" }, notApplied(w, "idempotency_key_reused", { argument: "/idempotency_key" }));
    }
    if (!res.ok) return fromBackend(res, project === undefined ? "ticket" : `project ${project}`, w);
    const t = res.body.ticket;
    const done = { ...w, scope: t.project };
    if (res.replayed) {
      return ok(`Ticket ${t.id} was already created by an earlier call with this idempotency_key; nothing new was written (replay).`,
        { ...receipt(t.id, t.version, [], true), project: t.project }, applied(done, { id: t.id, version: t.version, changed: Object.keys(fields).filter((k) => k !== "project"), replayed: true }));
    }
    return ok(`Created ticket ${t.id} in project ${t.project} (version ${t.version}).`,
      { ...receipt(t.id, t.version, ["created", ...Object.keys(fields)]), project: t.project },
      applied(done, { id: t.id, version: t.version, changed: Object.keys(fields).filter((k) => k !== "project") }));
  },
};

export const updateTicket: ToolDef = {
  name: "update_ticket",
  title: "Update ticket fields",
  description: "Change only the fields you name; every other field keeps its value. Set assignee to null to unassign. "
    + "Pass expected_version (from get_ticket): if the ticket changed since, nothing is written and you are told. "
    + "force: true writes the named fields without that check; use it only when told to.",
  input: object({
    id: S.ticketId, title: S.title, status: S.status, assignee: S.assignee, priority: S.priority,
    description: S.description, details: S.details,
    expected_version: S.expectedVersion,
    force: { type: "boolean", description: "Write the named fields even if the ticket changed since you read it. Default false." },
  }, ["id"]),
  mutates: true,
  annotations: writes({ destructive: true, idempotent: true }),
  async handler(args, { api }) {
    const w = onTicket("update", args.id, versionGuard(args), "expected_version");
    const fields = namedFields(args, UPDATE_FIELDS);
    if (Object.keys(fields).length === 0) {
      return fail("Name at least one field to change (title, status, assignee, priority, description, details). Nothing was written.", {}, notApplied(w, "no_fields"));
    }
    // The version check is on unless the caller turns it off explicitly (MWS-CONC-2; spec NF-7): leaving out
    // expected_version is not an override.
    if (args.expected_version === undefined && args.force !== true) {
      return fail("Pass expected_version (from get_ticket), or force: true to write without that check. Nothing was written.",
        { field: "expected_version" }, notApplied(w, "version_required", { argument: "/expected_version" }));
    }
    // One per-field PATCH: no read-modify-write, so a concurrent change to another field cannot be lost.
    const res = await api.request("PATCH", `/tickets/${enc(args.id)}`, { body: fields, ifMatch: args.force === true ? undefined : args.expected_version });
    if (!res.ok) return fromBackend(res, `ticket ${args.id}`, w);
    const { ticket, changed } = res.body;
    if (res.replayed) {
      return ok(`This change was already applied to ${ticket.id} (now version ${ticket.version}); nothing new was written (replay).`,
        receipt(ticket.id, ticket.version, [], true), applied(w, { version: ticket.version, replayed: true }));
    }
    if (changed.length === 0) {
      return ok(`No change: ${ticket.id} already had these values (version ${ticket.version}).`, receipt(ticket.id, ticket.version, []), applied(w, { version: ticket.version, changed: [] }));
    }
    return ok(`Updated ${ticket.id}: ${changed.join(", ")}. Now at version ${ticket.version}.`,
      receipt(ticket.id, ticket.version, changed), applied(w, { version: ticket.version, changed }));
  },
};

export const replaceTicket: ToolDef = {
  name: "replace_ticket",
  title: "Replace a ticket's fields",
  description: "Write all four fields (title, status, assignee, priority) at once, from a version you read. "
    + "If the ticket changed since expected_version, nothing is written. force: true overwrites anyway; use it only when told to.",
  input: object({
    id: S.ticketId, expected_version: S.expectedVersion, title: S.title, status: S.status, assignee: S.assignee,
    priority: S.priority, force: { type: "boolean", description: "Overwrite even if the ticket changed. Default false." },
  }, ["id", "expected_version", "title", "status", "assignee", "priority"]),
  mutates: true,
  annotations: writes({ destructive: true, idempotent: true }),
  async handler(args, { api }) {
    const force = args.force === true; // the override is explicit and off by default (MWS-CONC-1)
    const w = onTicket("replace", args.id, versionGuard(args), "expected_version");
    const res = await api.request("PUT", `/tickets/${enc(args.id)}`, {
      body: namedFields(args),
      ifMatch: force ? undefined : args.expected_version,
      query: { force: force ? "true" : undefined },
    });
    if (!res.ok) return fromBackend(res, `ticket ${args.id}`, w);
    const { ticket, changed } = res.body;
    if (res.replayed) {
      return ok(`This replace was already applied to ${ticket.id} (version ${ticket.version}); nothing new was written (replay).`,
        receipt(ticket.id, ticket.version, [], true), applied(w, { version: ticket.version, replayed: true }));
    }
    return ok(`Replaced ${ticket.id}${changed.length ? `: ${changed.join(", ")} changed` : " (no field changed)"}. `
      + `Now at version ${ticket.version}.`, receipt(ticket.id, ticket.version, changed), applied(w, { version: ticket.version, changed }));
  },
};

export const deleteTicket: ToolDef = {
  name: "delete_ticket",
  title: "Delete a ticket",
  description: "Delete one ticket. Pass expected_version (from get_ticket): if the ticket changed since, nothing is deleted. "
    + "force: true deletes without that check; use it only when told to.",
  input: object({
    id: S.ticketId, expected_version: S.expectedVersion,
    force: { type: "boolean", description: "Delete even if the ticket changed since you read it. Default false." },
  }, ["id"]),
  mutates: true,
  annotations: writes({ destructive: true, idempotent: true }),
  async handler({ id, expected_version, force }, { api }) {
    const w = onTicket("delete", id, versionGuard({ expected_version, force }), "expected_version");
    // The version check is on unless the caller turns it off explicitly (MWS-CONC-2, second run; spec NF-7).
    if (expected_version === undefined && force !== true) {
      return fail(`Pass expected_version (from get_ticket), or force: true to delete without that check. Nothing was deleted.`, { field: "expected_version" }, notApplied(w, "version_required", { argument: "/expected_version" }));
    }
    // The caller's version is sent as is (MWS-CONC-2); it is never refreshed here.
    const res = await api.request("DELETE", `/tickets/${enc(id)}`, { ifMatch: force === true ? undefined : expected_version });
    if (!res.ok) return fromBackend(res, `ticket ${id}`, w);
    return ok(`Deleted ${id}.`, { id, deleted: true }, applied(w));
  },
};

export const deleteTickets: ToolDef = {
  name: "delete_tickets",
  title: "Delete matching tickets",
  description: "Delete the tickets in one project that match a filter (status and/or title_prefix). "
    + "With no filter nothing is deleted unless you also pass all: true. All-or-nothing.",
  input: object({
    project: S.projectKey, status: S.status, title_prefix: { type: "string", minLength: 1, maxLength: 200 },
    all: { type: "boolean", description: "Required to delete every ticket in the project when no filter is given." },
  }, ["project"]),
  mutates: true,
  annotations: writes({ destructive: true, idempotent: true }),
  async handler(args, { api }) {
    // A write by selector: a repeat deletes what matches then. The read that shows the state is the project's list.
    const w: WriteContext = { operation: "delete", type: "ticket", scope: args.project, guard: null, read: { tool: "list_tickets", arguments: { project: args.project } } };
    const filter = namedFields(args, ["status", "title_prefix"]);
    if (Object.keys(filter).length === 0 && args.all !== true) {
      // An empty selector never means "everything" by default (MWS-TGT-2).
      return fail(`Refusing to delete every ticket in ${args.project}: give a filter (status, title_prefix) or set all: true. `
        + "Nothing was deleted.", { refused: "empty_filter" }, notApplied(w, "empty_filter"));
    }
    const list = await api.request("GET", "/tickets", { query: { project: args.project, ...filter } as Record<string, string> });
    // The listing changes nothing, so its failure leaves nothing applied: a settled refusal of the delete.
    if (!list.ok) return list.status === 0 || list.status >= 500
      ? fail(`Could not list the tickets in ${args.project} (${list.status || "no answer"}). Nothing was deleted.`, { error: "list_failed" }, notApplied(w, "not_sent"))
      : fromBackend(list, `project ${args.project}`, w);
    const matches = list.body.tickets as Array<{ id: string; version: number }>;
    if (matches.length === 0) return ok("No tickets matched; nothing was deleted.", { deleted: [] }, { ...applied(w, { changed: [] }), applied_count: 0 } as never);
    // One all-or-nothing batch holds at most 100 operations: say so in terms of this tool's arguments.
    if (matches.length > 100) {
      return fail(`The filter matches ${matches.length} tickets; one call deletes at most 100, all or nothing. `
        + "Narrow the filter (status, title_prefix) and call again. Nothing was deleted.", { refused: "too_many_matches", matches: matches.length }, notApplied(w, "too_many_matches"));
    }
    // Delete exactly what matched, at the version that matched, in one all-or-nothing batch.
    const res = await api.request("POST", "/batch", {
      body: { ops: matches.map((t) => ({ op: "delete", id: t.id, project: args.project, if_match: t.version })) },
    });
    if (res.status === 412 || res.status === 404) {
      // A conflict over several tickets: B-9's conflict member holds one object's state, so the item that stopped the
      // batch is named in items and the caller is told to list again (repeat: read_first).
      return fail(`A matching ticket changed or disappeared while deleting (${res.body.message}). Nothing was deleted; `
        + "list again and retry.", { conflict: true, reread_required: true },
      notApplied(w, "conflict", { items: matches.map((t) => conflictItem(t.id, res)) }));
    }
    if (!res.ok) return fromBackend(res, `project ${args.project}`, w);
    const ids = matches.map((t) => t.id);
    return ok(`Deleted ${ids.length} ticket(s) from ${args.project}: ${ids.join(", ")}.`, { deleted: ids },
      { ...applied(w, { items: ids.map((id, index) => ({ index, id, outcome: "applied" as const })) }), applied_count: ids.length } as never);
  },
};

/** One matched ticket of a refused batch delete: the one that stopped it, with its own conflict (B-9 v2, Items); the rest not attempted. */
function conflictItem(id: string, res: { status: number; body: any }) {
  if (id !== res.body.id) return { id, outcome: "not_attempted" as const };
  const cur = res.body.current as Record<string, unknown> | undefined;
  return {
    id, outcome: "not_applied" as const, code: res.status === 412 ? "conflict" : "not_found", message: res.body.message,
    ...(res.status === 412 && cur ? { conflict: { current_version: cur["version"] as number, checked_by: "backend" as const, current_state: Object.fromEntries(Object.entries(cur).filter(([k]) => k !== "comments")), omitted: ["/comments"] } } : {}),
  };
}

/** The confirmation close_ticket asks for (an embedded elicitation, MCP revision 2026-07-28). */
export const CLOSE_CONFIRMATION = {
  type: "object",
  properties: { confirm: { type: "boolean", description: "true to close the ticket" } },
  required: ["confirm"],
} as const;

/** The confirmed answer in a retried request, or undefined. */
export function confirmedClose(ctx: any): boolean | undefined {
  const r = ctx?.mcpReq?.inputResponses?.confirm;
  if (!r || r.action !== "accept") return r ? false : undefined;
  return r.content?.confirm === true;
}

export const closeTicket: ToolDef = {
  name: "close_ticket",
  title: "Close a ticket (asks for confirmation)",
  description: "Close a ticket. The server first asks you to confirm (an input_required result); nothing is written "
    + "until you retry with the confirmation.",
  input: object({ id: S.ticketId }, ["id"]),
  mutates: true,
  annotations: writes({ destructive: true, idempotent: true }),
  async handler({ id }, { api }, ctx) {
    const w = onTicket("close", id, null);
    const confirmed = confirmedClose(ctx);
    // Nothing is written before the confirmation (MWS-RETRY-3): the write happens only on the retry.
    if (confirmed === undefined) {
      return inputRequired({ inputRequests: { confirm: inputRequired.elicit({ message: `Close ${id}?`, requestedSchema: CLOSE_CONFIRMATION as never }) } });
    }
    if (!confirmed) return fail(`Not confirmed; ${id} was not closed. Nothing was written.`, {}, notApplied(w, "not_confirmed"));
    const res = await api.request("PATCH", `/tickets/${enc(id)}`, { body: { status: "closed" } });
    if (!res.ok) return fromBackend(res, `ticket ${id}`, w);
    const { ticket, changed } = res.body;
    return ok(changed.length ? `Closed ${id}. Now at version ${ticket.version}.` : `No change: ${id} was already closed.`, receipt(id, ticket.version, changed), applied(w, { version: ticket.version, changed }));
  },
};
