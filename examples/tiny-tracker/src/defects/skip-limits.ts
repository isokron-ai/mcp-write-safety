// DEFECT skip-limits -- MWS-IN-3 (MUST)
// Bounds and enums the schema advertises are enforced.
//
// WRONG ON PURPOSE. Correct code: correctValidation.checkLimits in
// src/mcp/validate.ts.
//
// What goes wrong: only types are checked; enums, lengths and ranges are
// advertised in tools/list but not enforced. update_ticket's status enum
// leaves out "archived" (an admin-only state of the backend), yet
// `status: "archived"` goes through and archives the ticket.
//
// Mirrors: GitHub GH-12 (advertised bounds not enforced), Grafana GF-18,
// Kubernetes K8S-11, Payload PAY-12.
//   https://isokron.ai/research/github-mcp-server-audit#findings-register

import type { Defect } from "./types.js";

export const defect: Defect = {
  name: "skip-limits",
  requirement: "MWS-IN-3",
  summary: "advertised enums, lengths and ranges are not enforced",
  mirrors: "GitHub GH-12; Grafana GF-18; Kubernetes K8S-11; Payload PAY-12",
  replaces: "correctValidation.checkLimits (src/mcp/validate.ts)",
  apply(build) {
    build.validation.checkLimits = () => []; // DEFECT: nothing beyond the type is checked
  },
};
