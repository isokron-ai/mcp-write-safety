// DEFECT coerce-types -- MWS-IN-1 (MUST)
// A value of the wrong type is rejected, not coerced.
//
// WRONG ON PURPOSE. Correct code: correctValidation.checkType in
// src/mcp/validate.ts.
//
// What goes wrong: the type check converts instead of refusing, the way
// `Boolean(x)` and `Number(x)` (or a schema library's "coerce" mode) do.
// `"false"` becomes true, `null` becomes 0. Sent to delete_tickets,
// `all: "false"` deletes every ticket in the project.
//
// Mirrors: PostHog X1 (`"false"` read as true, `null` as 0).
//   https://isokron.ai/research/posthog-mcp-server-audit?utm_source=tiny-tracker-source&utm_medium=source#findings-register

import type { Defect } from "./types.js";
import { correctValidation } from "../mcp/validate.js";

export const defect: Defect = {
  name: "coerce-types",
  requirement: "MWS-IN-1",
  summary: "values are coerced to the declared type (\"false\" becomes true, null becomes 0, an object becomes \"[object Object]\")",
  mirrors: "PostHog X1",
  replaces: "correctValidation.checkType (src/mcp/validate.ts)",
  apply(build) {
    build.validation.checkType = (schema, value, path) => {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      // DEFECT: convert whatever arrived instead of refusing it.
      if (types.includes("boolean") && typeof value !== "boolean") return { value: Boolean(value), issues: [] };
      if ((types.includes("integer") || types.includes("number")) && typeof value !== "number") {
        return { value: Number(value), issues: [] };
      }
      if (types.includes("string") && value !== null && typeof value !== "string") return { value: String(value), issues: [] };
      return correctValidation.checkType(schema, value, path);
    };
  },
};
