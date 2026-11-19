// DEFECT vague-validation-error -- MWS-IN-4 (MUST)
// A validation failure is a tool execution error that names the field and the
// reason.
//
// WRONG ON PURPOSE. Correct code: correctValidation.describe in
// src/mcp/validate.ts.
//
// What goes wrong: every validation failure becomes "Invalid input", without
// the field or the reason. The call is still refused, but the caller cannot
// tell what to fix and tends to retry blindly or give up.
//
// Mirrors: Payload PAY-13 (the reason dropped) and GitHub GH-13 (a raw decode
// error instead of a field and a reason).
//   https://isokron.ai/research/payload-mcp-server-audit?utm_source=tiny-tracker-source&utm_medium=source#payload-findings

import type { Defect } from "./types.js";

export const defect: Defect = {
  name: "vague-validation-error",
  requirement: "MWS-IN-4",
  summary: "validation failures say only 'Invalid input', without the field or the reason",
  mirrors: "Payload PAY-13; GitHub GH-13",
  replaces: "correctValidation.describe (src/mcp/validate.ts)",
  apply(build) {
    build.validation.describe = () => ({ message: "Invalid input" }); // DEFECT: field and reason dropped
  },
};
