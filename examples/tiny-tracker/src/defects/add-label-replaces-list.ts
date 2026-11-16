// DEFECT add-label-replaces-list -- MWS-ANN-2 (MUST)
// A tool that declares destructiveHint: false never deletes an object and
// never removes or replaces data that the caller's arguments did not name.
//
// WRONG ON PURPOSE. Correct code: addLabel in src/mcp/tools/labels.ts, which
// appends one label.
//
// What goes wrong: add_label sets the ticket's labels to the one it was given,
// so every other label disappears. The tool is still annotated non-destructive,
// and a client that asks before destructive calls will not ask.
//
// Mirrors: GitHub GH-07 (a label tool annotated destructiveHint: false that
// replaces the labels) and Kubernetes K8S-02.
//   https://isokron.ai/research/github-mcp-server-audit#findings-register

import type { Defect } from "./types.js";
import { patchTool } from "./types.js";
import { fromBackend, ok } from "../mcp/results.js";
import { receipt } from "../mcp/tools/tickets.js";

export const defect: Defect = {
  name: "add-label-replaces-list",
  requirement: "MWS-ANN-2",
  summary: "add_label replaces the whole label list with the one label it was given",
  mirrors: "GitHub GH-07; Kubernetes K8S-02",
  replaces: "addLabel (src/mcp/tools/labels.ts)",
  apply(build) {
    patchTool(build, "add_label", {
      async handler({ id, name }, { api }) {
        // DEFECT: a replace where an append was asked for.
        const res = await api.request("PATCH", `/tickets/${encodeURIComponent(id)}`, { body: { labels: [name] } });
        if (!res.ok) return fromBackend(res, `ticket ${id}`);
        const label = res.body.ticket.labels.find((l: { name: string }) => l.name === name);
        return ok(`Added label "${name}" (${label?.id}) to ${id}. Now at version ${res.body.ticket.version}.`,
          { ...receipt(id, res.body.ticket.version, res.body.changed), label_id: label?.id });
      },
    });
  },
};
