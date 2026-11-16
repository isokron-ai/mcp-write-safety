// DEFECT set-labels-non-destructive -- MWS-ANN-5 (SHOULD)
// A tool declared `destructiveHint: false` performs only additive updates, as
// the MCP schema states. (Replacing a list the caller passed whole is not
// MWS-ANN-2, which forbids only removing data the arguments did not name.)
//
// WRONG ON PURPOSE. Correct code: setLabels' annotations in
// src/mcp/tools/labels.ts.
//
// What goes wrong: set_labels replaces the whole label list, removing labels
// that are not listed, but is annotated as non-destructive. A client that
// asks before destructive calls will not ask before this one.
//
// Mirrors: GitHub GH-07 (label replace annotated non-destructive) and
// Kubernetes K8S-02 (a force-apply over an existing Service).
//   https://isokron.ai/research/github-mcp-server-audit#findings-register
//   https://isokron.ai/research/kubernetes-mcp-server-audit#findings-register

import type { Defect } from "./types.js";
import { patchTool } from "./types.js";
import { writes } from "../mcp/tools/common.js";

export const defect: Defect = {
  name: "set-labels-non-destructive",
  requirement: "MWS-ANN-5",
  summary: "set_labels removes unlisted labels but is annotated destructiveHint: false",
  mirrors: "GitHub GH-07; Kubernetes K8S-02",
  replaces: "setLabels annotations (src/mcp/tools/labels.ts)",
  apply(build) {
    patchTool(build, "set_labels", { annotations: writes({ destructive: false, idempotent: true }) }); // DEFECT
  },
};
