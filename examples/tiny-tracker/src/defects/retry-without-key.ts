// DEFECT retry-without-key -- MWS-RETRY-2 (MUST)
// A write repeated with the same idempotency key is applied at most once,
// whether the second application comes from the caller's repeat or from the
// server's own retry.
//
// WRONG ON PURPOSE. Correct code: createTicket in src/mcp/tools/tickets.ts,
// which sends the key with every backend request and never retries a create
// on its own.
//
// What goes wrong: when the connection to the backend breaks during a create,
// create_ticket "helpfully" sends the create once more, without the key. The
// first request had already been applied, so the backend now holds two
// tickets, and the caller is told about the second one only.
//
// Mirrors: no published finding yet; it is the case the MWS-RETRY-2 text names
// ("whether the second application came from the repeat or from the server's
// own retry of the first call"), found by its proxy-assisted step.

import type { Defect } from "./types.js";
import { patchTool } from "./types.js";
import { fail, fromBackend, ok } from "../mcp/results.js";
import { receipt } from "../mcp/tools/tickets.js";

export const defect: Defect = {
  name: "retry-without-key",
  requirement: "MWS-RETRY-2",
  summary: "create_ticket re-sends a create without its idempotency_key after a broken connection, so the ticket is created twice",
  mirrors: "none published; the MWS-RETRY-2 proxy-assisted step",
  replaces: "createTicket (src/mcp/tools/tickets.ts)",
  apply(build) {
    patchTool(build, "create_ticket", {
      async handler(args, { api, config }) {
        const { idempotency_key, ...fields } = args;
        const project = args.project ?? config.defaultProject;
        let res = await api.request("POST", "/tickets", { body: { ...fields, project }, idempotencyKey: idempotency_key });
        // DEFECT: a broken connection does not mean the create was not applied; the retry drops the key as well.
        if (res.status === 0) res = await api.request("POST", "/tickets", { body: { ...fields, project } });
        if (res.status === 422 && res.body?.error === "idempotency_key_reused") {
          return fail("This idempotency_key was already used with different arguments; nothing was written.", { error: "idempotency_key_reused" });
        }
        if (!res.ok) return fromBackend(res, `project ${project}`);
        const t = res.body.ticket;
        if (res.replayed) {
          return ok(`Ticket ${t.id} was already created by an earlier call with this idempotency_key; nothing new was written (replay).`,
            { ...receipt(t.id, t.version, [], true), project: t.project });
        }
        return ok(`Created ticket ${t.id} in project ${t.project} (version ${t.version}).`,
          { ...receipt(t.id, t.version, ["created", ...Object.keys(fields)]), project: t.project });
      },
    });
  },
};
