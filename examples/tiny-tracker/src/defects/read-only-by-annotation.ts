// DEFECT read-only-by-annotation -- MWS-CFG-3 (MUST)
// Read-only mode is enforced by the server on every state-changing tool. It
// does not depend on what the tools' annotations say.
//
// WRONG ON PURPOSE. Correct code: correctConfigRules.isEnabled in
// src/mcp/config.ts, which uses the server's own `mutates` flag.
//
// What goes wrong: read-only mode removes only the tools annotated as
// destructive. Tools that write without destroying (create_ticket,
// add_comment, add_label, create_project) stay available, so a "read-only"
// server still writes.
//
// Mirrors: PostHog R6 (read-only mode decided by an annotation).
//   https://isokron.ai/research/posthog-mcp-server-audit#findings-register

import type { Defect } from "./types.js";

export const defect: Defect = {
  name: "read-only-by-annotation",
  requirement: "MWS-CFG-3",
  summary: "read-only mode hides only tools annotated destructive; additive write tools still work",
  mirrors: "PostHog R6",
  replaces: "correctConfigRules.isEnabled (src/mcp/config.ts)",
  apply(build) {
    build.configRules.isEnabled = (tool, config) => {
      if (config.tools && !config.tools.includes(tool.name)) return false;
      // DEFECT: read-only is decided from an annotation, and only the destructive one.
      if (config.readOnly && tool.annotations?.destructiveHint === true) return false;
      return true;
    };
  },
};
