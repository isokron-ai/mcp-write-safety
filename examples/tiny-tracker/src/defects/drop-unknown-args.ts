// DEFECT drop-unknown-args -- MWS-IN-2 (MUST)
// An argument the schema does not define is rejected, not dropped.
//
// WRONG ON PURPOSE. Correct code: correctValidation.checkUnknown in
// src/mcp/validate.ts.
//
// What goes wrong: unknown arguments are silently removed, the default of
// many schema libraries. A misspelled `asignee` disappears, the rest of the
// call goes through, and the caller is told it succeeded.
//
// Mirrors: GitHub GH-06 (misspelled parameters dropped, success), Payload
// PAY-11, Kubernetes K8S-09.
//   https://isokron.ai/research/github-mcp-server-audit#findings-register

import type { Defect } from "./types.js";

export const defect: Defect = {
  name: "drop-unknown-args",
  requirement: "MWS-IN-2",
  summary: "arguments the schema does not define are silently dropped",
  mirrors: "GitHub GH-06; Payload PAY-11; Kubernetes K8S-09",
  replaces: "correctValidation.checkUnknown (src/mcp/validate.ts)",
  apply(build) {
    build.validation.checkUnknown = (schema, value) => {
      // DEFECT: strip instead of refuse.
      const known = Object.keys(schema.properties ?? {});
      return { value: Object.fromEntries(Object.entries(value).filter(([k]) => known.includes(k))), issues: [] };
    };
  },
};
