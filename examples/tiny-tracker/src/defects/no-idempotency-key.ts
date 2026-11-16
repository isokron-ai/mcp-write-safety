// DEFECT no-idempotency-key -- MWS-RETRY-1 (SHOULD)
// A tool that creates something and is not naturally idempotent accepts a
// caller-supplied idempotency key.
//
// WRONG ON PURPOSE. Correct code: addComment in src/mcp/tools/comments.ts.
//
// What goes wrong: add_comment offers no idempotency_key. Under MCP
// 2026-07-28 a client whose stream breaks must re-issue the call with a new
// request id; without a key, the re-issued call posts the comment twice and
// nothing can tell the two apart. (This defect sits on add_comment so that
// create_ticket keeps its key for the MWS-RETRY-2 defects when all defects
// are on.)
//
// Mirrors: GitHub "other observations" (a retry after a lost response creates
// a duplicate issue or comment) and Kubernetes K8S-05 (a client timeout hides
// the outcome).
//   https://isokron.ai/research/github-mcp-server-audit#other-observations
//   https://isokron.ai/research/kubernetes-mcp-server-audit#findings-register

import type { Defect } from "./types.js";
import { patchTool } from "./types.js";

export const defect: Defect = {
  name: "no-idempotency-key",
  requirement: "MWS-RETRY-1",
  summary: "add_comment has no idempotency_key argument",
  mirrors: "GitHub other observations; Kubernetes K8S-05",
  replaces: "addComment's input schema (src/mcp/tools/comments.ts)",
  apply(build) {
    const tool = build.tools.get("add_comment")!;
    // DEFECT: the key is not part of the schema (so it is refused as an unknown argument).
    const { idempotency_key: _dropped, ...properties } = tool.input.properties!;
    patchTool(build, "add_comment", {
      description: "Add a comment to a ticket. Returns the new comment's id.",
      input: { ...tool.input, properties },
    });
  },
};
