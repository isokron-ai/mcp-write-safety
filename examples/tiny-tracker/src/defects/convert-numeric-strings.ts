// DEFECT convert-numeric-strings -- MWS-IN-6 (SHOULD)
// A tool rejects an argument whose value is not of the type its schema
// declares, rather than convert or drop it.
//
// WRONG ON PURPOSE. Correct code: correctValidation.checkType in
// src/mcp/validate.ts.
//
// What goes wrong: a string that is exactly a number ("5") is accepted for an
// integer or number argument and used as that number. The meaning is kept, so
// MWS-IN-1 is not broken (NF-21), but the schema's type is not enforced: this
// is the lenient behavior of several SDK defaults.
//
// Mirrors: PostHog X1 (generated schemas that converted values) in its
// harmless form.
//   https://isokron.ai/research/posthog-mcp-server-audit?utm_source=tiny-tracker-source&utm_medium=source#findings-register

import type { Defect } from "./types.js";
import { correctValidation } from "../mcp/validate.js";

export const defect: Defect = {
  name: "convert-numeric-strings",
  requirement: "MWS-IN-6",
  summary: "a numeric string (\"5\") is accepted for a number argument and used as 5",
  mirrors: "PostHog X1 (harmless form)",
  replaces: "correctValidation.checkType (src/mcp/validate.ts)",
  wraps: true,
  apply(build) {
    // Wraps whatever check is in place, so that with every defect on it does not hide coerce-types.
    const inner = build.validation.checkType;
    build.validation.checkType = (schema, value, path) => {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      // DEFECT: a numeric string is converted instead of refused.
      if ((types.includes("integer") || types.includes("number")) && typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) {
        return correctValidation.checkType(schema, Number(value), path);
      }
      return inner(schema, value, path);
    };
  },
};
