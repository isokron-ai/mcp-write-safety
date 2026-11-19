// DEFECT read-only-strict-true -- MWS-CFG-1 (MUST)
// A read-only or safety setting whose value the server does not recognize
// stops the server. It never starts with writes on.
//
// WRONG ON PURPOSE. Correct code: correctConfigRules.parseReadOnly in
// src/mcp/config.ts.
//
// What goes wrong: only the exact string "true" turns read-only mode on.
// TRACKER_READ_ONLY=yes, =1 or =enabled all start the server with every write
// tool available, and nothing says so.
//
// Mirrors: GitHub GH-08 (`GITHUB_READ_ONLY=yes` leaves read-only mode off).
//   https://isokron.ai/research/github-mcp-server-audit?utm_source=tiny-tracker-source&utm_medium=source#findings-register

import type { Defect } from "./types.js";

export const defect: Defect = {
  name: "read-only-strict-true",
  requirement: "MWS-CFG-1",
  summary: "only TRACKER_READ_ONLY=true turns read-only on; yes, 1 or a typo start the server with writes on",
  mirrors: "GitHub GH-08",
  replaces: "correctConfigRules.parseReadOnly (src/mcp/config.ts)",
  apply(build) {
    build.configRules.parseReadOnly = (raw) => raw === "true"; // DEFECT: anything else means "off"
  },
};
