// DEFECT ignore-unknown-args-with-notice -- MWS-IN-7 (SHOULD)
// A tool rejects an argument that its input schema does not define.
//
// WRONG ON PURPOSE. Correct code: correctValidation.checkUnknown in
// src/mcp/validate.ts.
//
// What goes wrong: an argument the schema does not define is ignored instead
// of refused. The answer names it and says it was not used, so the caller is
// told (MWS-IN-2 is met), but a misspelled field is still a write that went
// through without the change the caller meant.
//
// Mirrors: the lenient default of several SDKs and validation libraries,
// which strip unknown properties (spec MWS-IN-7, known limitations).

import type { Defect } from "./types.js";
import { patchTool } from "./types.js";
import type { CallToolResult } from "@modelcontextprotocol/server";

export const defect: Defect = {
  name: "ignore-unknown-args-with-notice",
  requirement: "MWS-IN-7",
  summary: "arguments the schema does not define are ignored, and the answer says so, instead of being refused",
  mirrors: "SDK defaults that strip unknown properties",
  replaces: "correctValidation.checkUnknown (src/mcp/validate.ts)",
  wraps: true,
  apply(build) {
    // The names ignored in the call being validated; the handler runs right after its arguments are validated.
    let ignored: string[] = [];
    const inner = build.validation.checkUnknown;
    build.validation.checkUnknown = (schema, value, path) => {
      const r = inner(schema, value, path);
      if (path.length === 0) ignored = [];
      // Wraps the check in place: a build that already drops unknown arguments silently stays silent.
      if (r.issues.length === 0) return r;
      const known = Object.keys(schema.properties ?? {});
      // DEFECT: strip instead of refuse.
      if (path.length === 0) ignored = Object.keys(value).filter((k) => !known.includes(k));
      return { value: Object.fromEntries(Object.entries(value).filter(([k]) => known.includes(k))), issues: [] };
    };
    for (const tool of [...build.tools.values()]) {
      patchTool(build, tool.name, {
        async handler(args, deps, ctx) {
          const names = ignored;
          ignored = [];
          const res = await tool.handler(args, deps, ctx);
          if (!names.length || !res || !Array.isArray((res as { content?: unknown }).content)) return res;
          const r = res as { content: { type: string; text: string }[] };
          return { ...res, content: [...r.content, { type: "text", text: `Ignored argument${names.length > 1 ? "s" : ""} ${names.join(", ")}: not defined by ${tool.name}, so not used.` }] } as CallToolResult;
        },
      });
    }
  },
};
