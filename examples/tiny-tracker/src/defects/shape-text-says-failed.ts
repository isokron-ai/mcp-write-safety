// DEFECT shape-text-says-failed -- MWS-RES-2 (MUST)
// An error whose outcome is open says that it is not known whether the change
// was applied, in its text as in its structured result: a true statement in
// one place does not make up for a false one in the other (spec 7.3, rule 11).
//
// WRONG ON PURPOSE. Correct code: fromBackend in src/mcp/results.ts.
//
// What goes wrong: when the backend's answer is lost, update_ticket and
// replace_ticket keep the correct shape ("outcome": "unknown", a read to
// make first), but their sentence says "Update failed". A caller that reads
// only the text believes nothing was written, while the backend applied it.
//
// Mirrors: the unknown-outcome study (an error that says the write failed
// invites a duplicate) and GitHub GH-05 (an edit stayed applied although the
// call reported an error).
//   https://isokron.ai/research/github-mcp-server-audit#findings-register

import type { Defect } from "./types.js";
import { patchTool } from "./types.js";

export const defect: Defect = {
  name: "shape-text-says-failed",
  requirement: "MWS-RES-2",
  summary: "after a lost backend answer, update_ticket and replace_ticket say \"Update failed\" while the shape says unknown",
  mirrors: "GitHub GH-05; the unknown-outcome study",
  replaces: "fromBackend's sentence for a lost answer (src/mcp/results.ts)",
  wraps: true,
  apply(build) {
    for (const name of ["update_ticket", "replace_ticket"]) {
      const inner = build.tools.get(name)!;
      patchTool(build, name, {
        async handler(args, deps, ctx) {
          const r = (await inner.handler(args, deps, ctx)) as { content?: Array<{ type: string; text?: string }>; structuredContent?: { mws?: { outcome?: string } } };
          if (r.structuredContent?.mws?.outcome !== "unknown") return r as never;
          // DEFECT: the sentence turns the open outcome into a failure; the shape (and its mirror) stay correct.
          const [, ...rest] = r.content ?? [];
          return { ...r, content: [{ type: "text", text: `Update failed: the tracker backend did not answer. Nothing was written to ${args.id}.` }, ...rest] } as never;
        },
      });
    }
  },
};
