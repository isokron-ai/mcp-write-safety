// DEFECT idempotency-key-dropped -- MWS-RETRY-2 (MUST)
// Where a tool accepts an idempotency key, the same write sent again is
// applied once, and the second answer says it is a replay.
//
// WRONG ON PURPOSE. Correct code: createTicket in src/mcp/tools/tickets.ts.
//
// What goes wrong: create_ticket accepts idempotency_key but never sends it to
// the backend. The schema promises retry safety; a re-issued call still
// creates a second ticket and says "Created".
//
// Mirrors: the same retry findings as MWS-RETRY-1; writesafe's
// `replayed: true` is the passing reference.
//   https://isokron.ai/research/github-mcp-server-audit?utm_source=tiny-tracker-source&utm_medium=source#other-observations

import type { Defect } from "./types.js";
import { patchTool } from "./types.js";
import { fromBackend, ok } from "../mcp/results.js";
import { receipt } from "../mcp/tools/tickets.js";

export const defect: Defect = {
  name: "idempotency-key-dropped",
  requirement: "MWS-RETRY-2",
  summary: "create_ticket accepts idempotency_key but does not forward it, so a retry creates a duplicate",
  mirrors: "GitHub other observations; Kubernetes K8S-05",
  replaces: "createTicket (src/mcp/tools/tickets.ts)",
  apply(build) {
    patchTool(build, "create_ticket", {
      async handler(args, { api, config }) {
        // DEFECT: idempotency_key is destructured away and never sent.
        const { idempotency_key: _unused, ...fields } = args;
        const project = args.project ?? config.defaultProject;
        const res = await api.request("POST", "/tickets", { body: { ...fields, project } });
        if (!res.ok) return fromBackend(res, `project ${project}`);
        const t = res.body.ticket;
        return ok(`Created ticket ${t.id} in project ${t.project} (version ${t.version}).`,
          { ...receipt(t.id, t.version, ["created"]), project: t.project });
      },
    });
  },
};
