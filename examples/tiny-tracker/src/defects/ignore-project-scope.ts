// DEFECT ignore-project-scope -- MWS-TGT-1 (MUST)
// A write affects exactly the objects its arguments identify. A scope argument
// is honored or rejected, never ignored.
//
// WRONG ON PURPOSE. Correct code: createTicket in src/mcp/tools/tickets.ts.
//
// What goes wrong: create_ticket builds the request from the server's
// configured default project and never reads the `project` argument it
// advertises. Every ticket lands in the default project, and the result
// still says "Created".
//
// Mirrors: Kubernetes K8S-20 (`helm_install` ignores its `namespace`).
//   https://isokron.ai/research/kubernetes-mcp-server-audit#findings-register

import type { Defect } from "./types.js";
import { patchTool } from "./types.js";

export const defect: Defect = {
  name: "ignore-project-scope",
  requirement: "MWS-TGT-1",
  summary: "create_ticket ignores its project argument and always writes to the default project",
  mirrors: "Kubernetes K8S-20",
  replaces: "createTicket (src/mcp/tools/tickets.ts)",
  wraps: true,
  apply(build) {
    const correct = build.tools.get("create_ticket")!;
    patchTool(build, "create_ticket", {
      // DEFECT: the caller's project is replaced by the configured default.
      handler: (args, deps) => correct.handler({ ...args, project: deps.config.defaultProject }, deps),
    });
  },
};
