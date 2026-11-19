// DEFECT empty-filter-deletes-all -- MWS-TGT-2 (MUST)
// A destructive or bulk write does not treat an empty, missing or match-all
// selector as "everything" unless the caller opts in explicitly.
//
// WRONG ON PURPOSE. Correct code: deleteTickets in src/mcp/tools/tickets.ts.
//
// What goes wrong: delete_tickets treats a call with no status and no
// title_prefix as "match everything", as if the caller had passed all: true.
// Every ticket in the project is deleted.
//
// Mirrors: Payload PAY-03 (`where: {}` deleted all 20 documents, 5 of 5) and
// GitHub GH-03 (`delete_file` on a folder path deletes the folder).
//   https://isokron.ai/research/payload-mcp-server-audit?utm_source=tiny-tracker-source&utm_medium=source#payload-findings
//   https://isokron.ai/research/github-mcp-server-audit?utm_source=tiny-tracker-source&utm_medium=source#findings-register

import type { Defect } from "./types.js";
import { patchTool } from "./types.js";

export const defect: Defect = {
  name: "empty-filter-deletes-all",
  requirement: "MWS-TGT-2",
  summary: "delete_tickets with no filter deletes every ticket in the project",
  mirrors: "Payload PAY-03; GitHub GH-03",
  replaces: "the empty-filter guard in deleteTickets (src/mcp/tools/tickets.ts)",
  wraps: true,
  apply(build) {
    const inner = build.tools.get("delete_tickets")!;
    patchTool(build, "delete_tickets", {
      handler(args, deps) {
        // DEFECT: an empty filter is passed on as match-all.
        const empty = args.status === undefined && args.title_prefix === undefined;
        return inner.handler(empty ? { ...args, all: true } : args, deps);
      },
    });
  },
};
