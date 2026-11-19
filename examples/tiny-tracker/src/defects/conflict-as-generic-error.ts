// DEFECT conflict-as-generic-error -- MWS-CONC-6 (SHOULD)
// A conflict error tells the caller to read the object again before it
// retries, or carries the object's current state.
//
// WRONG ON PURPOSE. Correct code: setLabels in src/mcp/tools/labels.ts, which
// returns conflict() from src/mcp/results.ts (current version and state, and
// "re-read it and retry").
//
// What goes wrong: set_labels answers a version conflict with "Request failed
// with status 412. Nothing was written." It is an error and says nothing was
// applied (MWS-CONC-4 is met), but the caller learns neither the current state
// nor that it must read again, so it cannot retry correctly.
//
// Mirrors: the Payload conflict-recovery runs (the vendor build gave no usable
// conflict signal in 15 of 15) and, as the passing reference, PostHog's "what
// held up" (a conflict that said nothing had been written).
//   https://isokron.ai/research/payload-mcp-server-audit?utm_source=tiny-tracker-source&utm_medium=source#conflict-recovery
//   https://isokron.ai/research/posthog-mcp-server-audit?utm_source=tiny-tracker-source&utm_medium=source#what-held-up

import type { Defect } from "./types.js";
import { patchTool } from "./types.js";
import { ok } from "../mcp/results.js";
import { receipt } from "../mcp/tools/tickets.js";

export const defect: Defect = {
  name: "conflict-as-generic-error",
  requirement: "MWS-CONC-6",
  summary: "set_labels reports a version conflict as 'Request failed with status 412. Nothing was written.', without the current state or a re-read hint",
  mirrors: "Payload conflict recovery; PostHog what held up (passing reference)",
  replaces: "setLabels' error mapping (src/mcp/tools/labels.ts, src/mcp/results.ts)",
  apply(build) {
    patchTool(build, "set_labels", {
      async handler({ id, labels, expected_version, force }, { api }) {
        // (Kept from the correct tool: without a version the caller must say force: true.)
        if (expected_version === undefined && force !== true) {
          return { content: [{ type: "text", text: "Pass expected_version (from get_ticket), or force: true to replace the labels without that check. Nothing was written." }], isError: true };
        }
        const res = await api.request("PATCH", `/tickets/${encodeURIComponent(id)}`, { body: { labels }, ifMatch: force === true ? undefined : expected_version });
        // DEFECT: one generic message for every refusal, conflicts included.
        if (!res.ok) return { content: [{ type: "text", text: `Request failed with status ${res.status}. Nothing was written.` }], isError: true };
        const { ticket, changed } = res.body;
        return ok(`Set labels of ${id}. Now at version ${ticket.version}.`, receipt(id, ticket.version, changed, res.replayed));
      },
    });
  },
};
