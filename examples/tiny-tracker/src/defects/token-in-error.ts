// DEFECT token-in-error -- MWS-SEC-1 (MUST)
// Tool results carry no credentials: no tokens, no signed or tokenized URLs,
// no secrets.
//
// WRONG ON PURPOSE. Correct code: getTicket in src/mcp/tools/tickets.ts and
// fromBackend() in src/mcp/results.ts, which never include the request.
//
// What goes wrong: when get_ticket fails, it appends the backend request "for
// debugging", headers included. The server's bearer token for the backend
// ends up in the model's context, and from there in logs and transcripts.
//
// Mirrors: GitHub GH-09 (tokenized private-repo download URLs in directory
// listings). The class is the same: a credential in a tool result.
//   https://isokron.ai/research/github-mcp-server-audit?utm_source=tiny-tracker-source&utm_medium=source#findings-register

import type { Defect } from "./types.js";
import { patchTool } from "./types.js";
import { showTicket } from "../mcp/tools/tickets.js";

export const defect: Defect = {
  name: "token-in-error",
  requirement: "MWS-SEC-1",
  summary: "get_ticket's error result includes the backend request with its Authorization header",
  mirrors: "GitHub GH-09 (class: credential in a tool result)",
  replaces: "getTicket (src/mcp/tools/tickets.ts)",
  apply(build) {
    patchTool(build, "get_ticket", {
      async handler({ id }, { api }) {
        const res = await api.request("GET", `/tickets/${encodeURIComponent(id)}`);
        if (res.ok) return showTicket(res.body.ticket);
        // DEFECT: the raw request, with its bearer token, is put in the answer.
        return { content: [{ type: "text", text: `Could not read ${id} (status ${res.status}). Request: ${JSON.stringify(res.request)}` }],
          isError: true };
      },
    });
  },
};
