// VARIANT settle-by-client-reference -- correct, not a defect (MWS-RETRY-2, MWS-RES-1; review G6)
//
// For a backend with no idempotency key and no lookup: the server writes a
// reference derived from the caller's key into the created object, and settles
// a lost answer by reading it back.
//
// The reference is a label `ref-<24 hex>` (the first 96 bits of SHA-256 of the
// key): the backend has no free field for it (an `external_id` field is an open
// question for the owner). Before creating, the server looks for a ticket in the
// project carrying the reference; a repeat finds it and is answered as a replay,
// also after a restart of the server.
//
// A lost answer is settled by the same read: found, the create applied. Not
// found is NOT final (a held request can still arrive; there is no fence), so it
// is reported unknown with repeat read_first, never not_applied.
//
// Switched on with TRACKER_VARIANTS=settle-by-client-reference.

import { createHash } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { Build, Deps } from "../mcp/types.js";
import { applied, fail, fromBackend, notApplied, ok, unknownOutcome, type WriteContext } from "../mcp/results.js";
import { receipt } from "../mcp/tools/tickets.js";

export const refLabel = (key: string) => `ref-${createHash("sha256").update(key, "utf8").digest("hex").slice(0, 24)}`;

async function findByRef(deps: Deps, project: string | undefined, ref: string): Promise<{ id: string; version: number; project: string } | undefined | null> {
  const res = await deps.api.request("GET", "/tickets", { query: { project } });
  if (!res.ok) return null;
  return (res.body.tickets as Array<{ id: string; version: number; project: string; labels: Array<{ name: string }> }>).find((t) => t.labels.some((l) => l.name === ref));
}

export function applySettleByClientReference(build: Build): void {
  const correct = build.tools.get("create_ticket")!;
  build.tools.set("create_ticket", {
    ...correct,
    async handler(args, deps: Deps) {
      const { idempotency_key: key, ...fields } = args;
      if (key === undefined) return correct.handler(args, deps) as Promise<CallToolResult>;
      const project = args.project ?? deps.config.defaultProject;
      const w: WriteContext = { operation: "create", type: "ticket", ...(project !== undefined ? { scope: project } : {}), guard: "key", read: { tool: "list_tickets", arguments: project !== undefined ? { project } : {} } };
      const changed = Object.keys(fields).filter((k) => k !== "project");
      const ref = refLabel(key);
      const labels: string[] = [...(fields.labels ?? [])];
      if (labels.length >= 20) return fail("A keyed create needs one free label for its reference (at most 19 labels); nothing was written.", { error: "no_label_slot" }, notApplied(w, "no_label_slot"));
      const found = await findByRef(deps, project, ref);
      if (found) {
        return ok(`Ticket ${found.id} was already created by an earlier call with this idempotency_key; nothing new was written (replay).`,
          { ...receipt(found.id, found.version, [], true), project: found.project }, applied({ ...w, scope: found.project }, { id: found.id, version: found.version, changed, replayed: true }));
      }
      const res = await deps.api.request("POST", "/tickets", { body: { ...fields, project, labels: [...labels, ref] } });
      if (res.status === 0) {
        const settled = await findByRef(deps, project, ref);
        if (settled) {
          return ok(`Created ticket ${settled.id} in project ${settled.project} (version ${settled.version}). The backend's answer was lost; the ticket was found by its reference.`,
            { ...receipt(settled.id, settled.version, ["created", ...Object.keys(fields)]), project: settled.project, settled_by: "reference" },
            applied({ ...w, scope: settled.project }, { id: settled.id, version: settled.version, changed }));
        }
        return fail(`The tracker backend's answer was lost and no ticket with this call's reference (${ref}) is there yet. It is not known whether the create will apply; `
          + `list the project's tickets before retrying.`, { written: "unknown", error: "connection_failed" }, { ...unknownOutcome(w, "no_answer"), repeat: "read_first" });
      }
      if (!res.ok) return fromBackend(res, `project ${project}`, w);
      const t = res.body.ticket;
      return ok(`Created ticket ${t.id} in project ${t.project} (version ${t.version}).`,
        { ...receipt(t.id, t.version, ["created", ...Object.keys(fields)]), project: t.project },
        applied({ ...w, scope: t.project }, { id: t.id, version: t.version, changed }));
    },
  });
}
