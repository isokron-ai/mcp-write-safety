// DEFECT missing-annotations -- MWS-ANN-4 (SHOULD)
// Every tool sets readOnlyHint explicitly, and every state-changing tool sets
// destructiveHint explicitly.
//
// WRONG ON PURPOSE. Correct code: removeLabel's annotations in
// src/mcp/tools/labels.ts.
//
// What goes wrong: remove_label has no annotations. The protocol defaults are the
// cautious ones, so nothing unsafe follows, but clients must treat a harmless
// additive tool as possibly destructive, and a reader cannot tell whether the
// author thought about it.
//
// Mirrors: Payload PAY-08 (0 of 12 tools annotated on 3.x).
//   https://isokron.ai/research/payload-mcp-server-audit?utm_source=tiny-tracker-source&utm_medium=source#payload-findings

import type { Defect } from "./types.js";
import { patchTool } from "./types.js";

export const defect: Defect = {
  name: "missing-annotations",
  requirement: "MWS-ANN-4",
  summary: "remove_label declares no annotations",
  mirrors: "Payload PAY-08",
  replaces: "removeLabel annotations (src/mcp/tools/labels.ts)",
  apply(build) {
    patchTool(build, "remove_label", { annotations: undefined }); // DEFECT
  },
};
