// DEFECT error-as-text -- MWS-RES-2 (MUST)
// A failure is a tool execution error with `isError: true`.
//
// WRONG ON PURPOSE. Correct code: addComment in src/mcp/tools/comments.ts,
// which returns fromBackend() (src/mcp/results.ts).
//
// What goes wrong: add_comment returns a backend refusal as ordinary text
// without `isError`. A client or model that checks `isError` treats the
// failed call as a success.
//
// Mirrors: Payload PAY-05 (a bulk failure without `isError`, 5 of 5) and
// PAY-01 (an opt-out refusal returned as plain text).
//   https://isokron.ai/research/payload-mcp-server-audit?utm_source=tiny-tracker-source&utm_medium=source#payload-findings

import type { Defect } from "./types.js";
import { patchTool } from "./types.js";
import { ok } from "../mcp/results.js";

export const defect: Defect = {
  name: "error-as-text",
  requirement: "MWS-RES-2",
  summary: "add_comment returns a backend refusal as plain text without isError",
  mirrors: "Payload PAY-05, PAY-01",
  replaces: "addComment (src/mcp/tools/comments.ts)",
  apply(build) {
    patchTool(build, "add_comment", {
      async handler({ id, body, idempotency_key }, { api }) {
        const res = await api.request("POST", `/tickets/${encodeURIComponent(id)}/comments`,
          { body: { body }, idempotencyKey: idempotency_key });
        // DEFECT: the failure is text in a normal result; isError is never set.
        if (!res.ok) return { content: [{ type: "text", text: `Could not add comment: ${res.body?.message}` }] };
        const { comment, ticket } = res.body;
        return ok(`Added comment ${comment.id} to ${id}.`,
          { id: comment.id, ticket: id, version: ticket.version, changed: ["comments"], replayed: res.replayed });
      },
    });
  },
};
