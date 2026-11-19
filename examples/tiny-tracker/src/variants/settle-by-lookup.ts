// VARIANT settle-by-lookup -- correct, not a defect (MWS-RES-1, MWS-RES-2; Annex B-5's other branch; review B9)
//
// When the backend's answer to a keyed create is lost (the connection broke),
// the outcome is open. This variant settles it: it asks the backend for the
// key's record, behind a fence (POST /operations/:key/fence, feature inflight).
// In one synchronous step the backend either returns the key's record or, when
// it has none, closes the key, so the original request is refused if it is
// still on its way and arrives later. Only then is a miss final:
//
//   record found       applied, with the ticket as committed, when the record's
//                      fingerprint_hash is this call's; a record of another
//                      request under the same key is not_applied,
//                      idempotency_key_reused (as the backend's 422)
//   key fenced         not applied, and it can no longer be (use a new key)
//   still in progress  unknown, in_progress, repeat with the same key
//   lookup failed      unknown, as without the variant
//
// A lookup without the fence cannot say not_applied on a miss: a held request
// can land after it (that is the settle-miss-reported-not-applied defect).
//
// Switched on with TRACKER_VARIANTS=settle-by-lookup; needs the inflight
// feature on the backend (CMP-51).

import type { CallToolResult } from "@modelcontextprotocol/server";
import type { Build, Deps } from "../mcp/types.js";
import { applied, fail, notApplied, ok, unknownOutcome, type WriteContext } from "../mcp/results.js";
import { receipt } from "../mcp/tools/tickets.js";
import { enc } from "../mcp/tools/common.js";
import { fingerprintHash } from "../digest.js";

/**
 * Whether the fence's record is this call's request (G2 fold-in 1): the record's fingerprint_hash against the hash of
 * the body this call sent (POST /tickets, as JSON carries it), under the principal the backend named. A record with no
 * fingerprint_hash is not taken as this call's.
 */
export function sameRequest(answer: { principal?: unknown; fingerprint_hash?: unknown }, sent: unknown): boolean {
  if (typeof answer.principal !== "string" || typeof answer.fingerprint_hash !== "string") return false;
  return fingerprintHash(answer.principal, "POST", "/tickets", JSON.parse(JSON.stringify(sent ?? null))) === answer.fingerprint_hash;
}

/** fence: the correct variant. peek: a lookup with no fence (only the settle-miss-reported-not-applied defect). */
export function applySettleByLookup(build: Build, mode: "fence" | "peek" = "fence"): void {
  const correct = build.tools.get("create_ticket")!;
  build.tools.set("create_ticket", {
    ...correct,
    async handler(args, deps: Deps, ctx?: unknown) {
      const first = await correct.handler(args, deps, ctx) as CallToolResult;
      const key = args.idempotency_key as string | undefined;
      if (key === undefined || (first.structuredContent as { error?: string } | undefined)?.error !== "connection_failed") return first;
      const { idempotency_key: _k, ...fields } = args;
      const project = args.project ?? deps.config.defaultProject;
      const w: WriteContext = { operation: "create", type: "ticket", ...(project !== undefined ? { scope: project } : {}), guard: "key", read: { tool: "list_tickets", arguments: project !== undefined ? { project } : {} } };
      const changed = Object.keys(fields).filter((k) => k !== "project");
      const res = await deps.api.request("POST", `/operations/${enc(key)}/fence`, { body: { fence: mode === "fence" } });
      const state = (res.body as { state?: string } | undefined)?.state;
      if (res.status === 200 && (state === "completed" || state === "expired") && !sameRequest(res.body as object, { ...fields, project })) {
        // The key holds another request's write: this call's request was not applied under it (the backend refuses it
        // 422 idempotency_key_reused if it is still on its way).
        return fail("The tracker backend's answer was lost, and this idempotency_key was already used with different arguments; "
          + "this call's request was not written. If you are retrying the same create, send exactly the same arguments as the first call; "
          + "list your tickets before using a new key, or you may create a duplicate.",
        { error: "idempotency_key_reused", settled_by: "lookup" }, notApplied(w, "idempotency_key_reused", { argument: "/idempotency_key" }));
      }
      if (res.status === 200 && state === "completed") {
        const t = (res.body as { body: { ticket: { id: string; version: number; project: string } } }).body.ticket;
        return ok(`Created ticket ${t.id} in project ${t.project} (version ${t.version}). The backend's answer was lost; the write was found by its idempotency_key.`,
          { ...receipt(t.id, t.version, ["created", ...Object.keys(fields)]), project: t.project, settled_by: "lookup" },
          applied({ ...w, scope: t.project }, { id: t.id, version: t.version, changed }));
      }
      if (res.status === 200 && state === "expired") {
        const objects = (res.body as { objects?: Array<{ type: string; id: string }> }).objects ?? [];
        const id = objects.find((o) => o.type === "ticket")?.id;
        return ok(`The write with this idempotency_key was applied${id ? ` (ticket ${id})` : ""}, but its stored answer is gone. Read the project's tickets to see it now.`,
          { written: true, settled_by: "lookup", objects }, { ...applied(id ? { ...w, id } : w, {}), repeat: "read_first", read_with: w.read });
      }
      if ((res.status === 200 && state === "fenced") || (mode === "peek" && res.status === 404)) {
        // fence: final, the key is closed. peek (the defect): NOT final, a held request can still land.
        return fail("The tracker backend's answer was lost and the backend has no write with this idempotency_key; nothing was written"
          + (mode === "fence" ? ", and the key is now closed so the lost request cannot apply later. Use a new idempotency_key to try again." : "."),
        { settled_by: "lookup" }, { ...notApplied(w, mode === "fence" ? "key_fenced" : "not_found"), argument: "/idempotency_key" });
      }
      if (res.status === 409 && (res.body as { error?: string } | undefined)?.error === "in_progress") {
        return fail("The tracker backend's answer was lost and the write with this idempotency_key is still being applied. "
          + "Repeat the call later with the same idempotency_key to get its result.", { written: "unknown", error: "in_progress" }, { ...unknownOutcome(w, "in_progress"), repeat: "same_key" });
      }
      return first;
    },
  });
}
