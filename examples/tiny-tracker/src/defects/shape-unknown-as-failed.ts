// DEFECT shape-unknown-as-failed -- MWS-RES-2 (MUST)
// An error whose outcome is open says that it is not known whether the change
// was applied; it does not report a write that may have been applied as one
// that was not.
//
// WRONG ON PURPOSE. Correct code: fromBackend and unknownOutcome() in
// src/mcp/results.ts.
//
// What goes wrong: every write tool keeps its words ("It is not known whether
// the change was applied"), but its shape turns the open outcome into a
// settled refusal: "outcome": "not_applied", "repeat": "no". A program that
// reads the shape believes nothing was written, while the backend applied it.
//
// Mirrors: the unknown-outcome study (an error that passes on the transport
// error, or says the write failed, invites a duplicate) and GitHub GH-05 (an
// edit stayed applied although the call reported an error).
//   https://isokron.ai/research/github-mcp-server-audit#findings-register

import type { Defect } from "./types.js";
import { patchTool, rewriteShape } from "./types.js";

export const defect: Defect = {
  name: "shape-unknown-as-failed",
  requirement: "MWS-RES-2",
  summary: "every write tool's shape reports an open outcome as not_applied (the text still says it is not known)",
  mirrors: "GitHub GH-05; the unknown-outcome study",
  replaces: "unknownOutcome() in fromBackend (src/mcp/results.ts)",
  wraps: true,
  apply(build) {
    for (const [name, tool] of build.tools) {
      if (!tool.mutates) continue;
      const inner = tool.handler;
      patchTool(build, name, {
        async handler(args, deps, ctx) {
          const r = await inner(args, deps, ctx);
          // DEFECT: an open outcome is reported as a settled refusal.
          return rewriteShape(r, (m) => {
            if (m.outcome === "unknown") { m.outcome = "not_applied"; m.repeat = "no"; }
          });
        },
      });
    }
  },
};
