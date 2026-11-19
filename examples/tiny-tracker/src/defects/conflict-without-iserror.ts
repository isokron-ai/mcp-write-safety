// DEFECT conflict-without-iserror -- MWS-CONC-4 (MUST)
// A write refused because of a conflict is not applied and is returned as a
// tool execution error (isError: true) that says the write was not applied.
//
// WRONG ON PURPOSE. Correct code: updateTicket in src/mcp/tools/tickets.ts,
// which returns conflict() from src/mcp/results.ts.
//
// What goes wrong: update_ticket and set_labels return the conflict as an ordinary result. The
// text says nothing was written, but isError is not set, so a client that
// checks isError takes the refused write for a success.
//
// Mirrors: Payload PAY-01 (with the lock override off, the refusal came back
// as plain text without isError, 3 of 3).
//   https://isokron.ai/research/payload-mcp-server-audit?utm_source=tiny-tracker-source&utm_medium=source#payload-findings

import type { Defect } from "./types.js";
import { patchTool } from "./types.js";

export const defect: Defect = {
  name: "conflict-without-iserror",
  requirement: "MWS-CONC-4",
  summary: "update_ticket and set_labels return a version conflict as an ordinary result, without isError",
  mirrors: "Payload PAY-01",
  replaces: "updateTicket's conflict result (src/mcp/tools/tickets.ts, src/mcp/results.ts)",
  wraps: true,
  apply(build) {
    // Both tools, so that with every defect on the defect still shows on set_labels, whose stale write no other defect changes.
    for (const name of ["update_ticket", "set_labels"]) {
      const inner = build.tools.get(name)!;
      patchTool(build, name, {
        async handler(args, deps, ctx) {
          const r = await inner.handler(args, deps, ctx);
          // DEFECT: the conflict's isError is dropped.
          const res = r as { isError?: boolean; structuredContent?: { conflict?: boolean }; content?: { text?: string }[] };
          const text = (res.content ?? []).map((c) => c.text ?? "").join(" ");
          // (A conflict in any form: with every defect on, conflict-as-generic-error has already reworded it.)
          if (res.structuredContent?.conflict || (res.isError && /\b412\b|conflict/i.test(text))) return { ...r, isError: false } as never;
          return r;
        },
      });
    }
  },
};
