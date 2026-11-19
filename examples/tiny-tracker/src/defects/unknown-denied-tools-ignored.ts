// DEFECT unknown-denied-tools-ignored -- MWS-CFG-2 (MUST)
// A server refuses to start, or starts with every write tool disabled, when a
// tool deny-list names a tool it can never offer.
//
// WRONG ON PURPOSE. Correct code: correctConfigRules.resolveDenyList in
// src/mcp/config.ts.
//
// What goes wrong: names in TRACKER_DENY_TOOLS that match no tool are skipped.
// A typo meant to switch off a dangerous tool leaves that tool on, and nothing
// says so.
//
// Mirrors: GitHub GH-10 (misspelled entries in an exclusion list were silent)
// and Kubernetes K8S-14.
//   https://isokron.ai/research/github-mcp-server-audit?utm_source=tiny-tracker-source&utm_medium=source#findings-register

import type { Defect } from "./types.js";

export const defect: Defect = {
  name: "unknown-denied-tools-ignored",
  requirement: "MWS-CFG-2",
  summary: "unknown names in TRACKER_DENY_TOOLS are skipped, so the server starts with every tool on",
  mirrors: "GitHub GH-10; Kubernetes K8S-14",
  replaces: "correctConfigRules.resolveDenyList (src/mcp/config.ts)",
  apply(build) {
    build.configRules.resolveDenyList = (raw, known) => {
      if (raw === undefined || raw.trim() === "") return null;
      // DEFECT: unknown names are filtered out silently.
      return raw.split(",").map((s) => s.trim()).filter((n) => known.includes(n));
    };
  },
};
