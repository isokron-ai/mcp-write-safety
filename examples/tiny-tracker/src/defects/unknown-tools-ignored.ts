// DEFECT unknown-tools-ignored -- MWS-CFG-4 (SHOULD)
// A server refuses to start when a tool allow-list names a tool it can never
// offer.
//
// WRONG ON PURPOSE. Correct code: correctConfigRules.resolveToolList in
// src/mcp/config.ts.
//
// What goes wrong: names in TRACKER_TOOLS that match no tool are skipped. A
// typo in the allow-list starts the server with fewer tools than the operator
// intended (or, in a deny-list, more), and nothing says so.
//
// Mirrors: GitHub GH-10 and Kubernetes K8S-14 (unknown names in a tool list
// accepted silently).
//   https://isokron.ai/research/github-mcp-server-audit#findings-register
//   https://isokron.ai/research/kubernetes-mcp-server-audit#findings-register

import type { Defect } from "./types.js";

export const defect: Defect = {
  name: "unknown-tools-ignored",
  requirement: "MWS-CFG-4",
  summary: "unknown names in TRACKER_TOOLS are skipped instead of stopping the server",
  mirrors: "GitHub GH-10; Kubernetes K8S-14",
  replaces: "correctConfigRules.resolveToolList (src/mcp/config.ts)",
  apply(build) {
    build.configRules.resolveToolList = (raw, known) => {
      if (raw === undefined || raw.trim() === "") return null;
      // DEFECT: unknown names are filtered out silently.
      return raw.split(",").map((s) => s.trim()).filter((n) => known.includes(n));
    };
  },
};
