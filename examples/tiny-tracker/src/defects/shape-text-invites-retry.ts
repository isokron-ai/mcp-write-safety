// DEFECT shape-text-invites-retry -- MWS-RES-2 (MUST)
// An error whose outcome is open does not tell the caller to repeat the call,
// except after a read that it names or with the key or version that the call
// carried, in its text as in its structured result: a correct shape does not
// make up for a text that invites a blind repeat (spec 7.3, rule 11; B-9, "Text").
//
// WRONG ON PURPOSE. Correct code: fromBackend in src/mcp/results.ts.
//
// What goes wrong: when the backend's answer is lost, update_ticket and
// replace_ticket keep the correct shape ("outcome": "unknown", a read to make
// first) and still say the outcome is not known, but their sentence ends
// "Please retry the call." A caller that reads only the text repeats the write
// without reading first, and undoes another writer's change made in between.
//
// Mirrors: the unknown-outcome study (an error that invites a repeat after a
// lost answer leads to a duplicate or a lost update) and GitHub GH-05.
//   https://isokron.ai/research/github-mcp-server-audit#findings-register

import type { Defect } from "./types.js";
import { patchTool } from "./types.js";

export const defect: Defect = {
  name: "shape-text-invites-retry",
  requirement: "MWS-RES-2",
  summary: "after a lost backend answer, update_ticket and replace_ticket say \"Please retry the call\" while the shape says unknown and read first",
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
          // DEFECT: the sentence invites a blind repeat; the shape (and its mirror) stay correct.
          const [, ...rest] = r.content ?? [];
          return { ...r, content: [{ type: "text", text: `The tracker backend did not answer about ${args.id}. It is not known whether the change was applied. Please retry the call.` }, ...rest] } as never;
        },
      });
    }
  },
};
