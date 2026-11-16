// DEFECT create-marked-idempotent -- MWS-ANN-3 (MUST)
// A tool declared `idempotentHint: true` has no further effect when called
// again with the same arguments.
//
// WRONG ON PURPOSE. Correct code: createTicket's annotations in
// src/mcp/tools/tickets.ts.
//
// What goes wrong: create_ticket is annotated idempotent, presumably because
// it accepts an idempotency key. The key is optional; without it every call
// makes a new ticket. A client that retries idempotent tools freely will
// create duplicates.
//
// Mirrors: Kubernetes K8S-12 (`vm_clone` declared idempotent creates a new
// clone per call).
//   https://isokron.ai/research/kubernetes-mcp-server-audit#findings-register

import type { Defect } from "./types.js";
import { patchTool } from "./types.js";
import { writes } from "../mcp/tools/common.js";

export const defect: Defect = {
  name: "create-marked-idempotent",
  requirement: "MWS-ANN-3",
  summary: "create_ticket is annotated idempotentHint: true; repeated calls without a key make new tickets",
  mirrors: "Kubernetes K8S-12",
  replaces: "createTicket annotations (src/mcp/tools/tickets.ts)",
  apply(build) {
    patchTool(build, "create_ticket", { annotations: writes({ destructive: false, idempotent: true }) }); // DEFECT
  },
};
