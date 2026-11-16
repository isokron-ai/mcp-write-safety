// DEFECT comment-id-dropped -- MWS-RES-3 (MUST)
// A create returns the identifier of what it made.
//
// WRONG ON PURPOSE. Correct code: addComment in src/mcp/tools/comments.ts.
//
// What goes wrong: add_comment's answer is reduced to "Comment added", without
// the new comment's id. The caller cannot refer to what it just created, and
// after a retry cannot tell whether it made one comment or two. (This defect
// sits on a second create tool so that create_ticket keeps working for every
// other check when all defects are on.)
//
// Mirrors: GitHub GH-05 (the new pull request's number and URL lost).
//   https://isokron.ai/research/github-mcp-server-audit#findings-register

import type { Defect } from "./types.js";
import { patchTool } from "./types.js";

export const defect: Defect = {
  name: "comment-id-dropped",
  requirement: "MWS-RES-3",
  summary: "add_comment does not return the id of the comment it created",
  mirrors: "GitHub GH-05",
  replaces: "addComment's answer (src/mcp/tools/comments.ts)",
  wraps: true,
  apply(build) {
    const inner = build.tools.get("add_comment")!;
    patchTool(build, "add_comment", {
      async handler(args, deps) {
        const result = await inner.handler(args, deps);
        if (result.isError) return result;
        // DEFECT: the answer keeps the ticket but drops the new comment's id.
        const { id: _dropped, ...rest } = (result.structuredContent ?? {}) as Record<string, unknown>;
        // (The write-result shape loses the id too, in structuredContent and in its mirror.)
        const mws = rest.mws as { object?: Record<string, unknown> } | undefined;
        if (mws?.object) { const { id: _gone, ...object } = mws.object; rest.mws = { ...mws, object }; }
        return { content: [{ type: "text", text: `Comment added to ${args.id}.` }, ...(rest.mws ? [{ type: "text" as const, text: JSON.stringify(rest) }] : [])], structuredContent: rest };
      },
    });
  },
};
