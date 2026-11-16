// DEFECT comment-marked-read-only -- MWS-ANN-1 (MUST)
// A tool declared `readOnlyHint: true` changes no state.
//
// WRONG ON PURPOSE. Correct code: addComment's annotations in
// src/mcp/tools/comments.ts.
//
// What goes wrong: add_comment is annotated read-only ("it does not change the
// ticket's fields"). Clients that auto-approve read-only tools let it post
// comments without asking. Note that this server's read-only mode is not
// fooled (it uses its own record, see MWS-CFG-3); clients are.
//
// Mirrors: rule 9 of the published MCP development rules (annotations must be
// honest); a write tool that claims to be read-only is the most harmful
// annotation error, because clients may run such tools without asking.
//   https://isokron.ai/mcp-development

import type { Defect } from "./types.js";
import { patchTool } from "./types.js";

export const defect: Defect = {
  name: "comment-marked-read-only",
  requirement: "MWS-ANN-1",
  summary: "add_comment is annotated readOnlyHint: true but creates a comment",
  mirrors: "rule 9 (honest annotations); no single published finding",
  replaces: "addComment annotations (src/mcp/tools/comments.ts)",
  apply(build) {
    // DEFECT: the claim says read-only; the tool writes.
    patchTool(build, "add_comment", { annotations: { readOnlyHint: true, openWorldHint: false } });
  },
};
