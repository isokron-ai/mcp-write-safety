// DEFECT in-progress-reported-not-applied -- MWS-RES-2 (MUST); needs the inflight feature
// A failure says what remains applied; a keyed call's result describes the
// write the key identifies (Annex B-9: in_progress is outcome unknown).
//
// WRONG ON PURPOSE. Correct code: keyedStateResult in src/mcp/keyed-states.ts,
// which answers a 409 in_progress as outcome unknown, code in_progress, repeat
// same_key.
//
// What goes wrong: create_ticket reports the backend's "still being applied"
// as an ordinary refusal: outcome not_applied, "nothing was written", repeat
// no. The keyed write it describes is about to apply; a caller that believes
// the answer and creates again with a new key makes a duplicate.
//
// Mirrors: none published; review B1 (the realistic bug once in-flight keys
// exist).

import type { Defect } from "./types.js";
import { patchTool, rewriteShape } from "./types.js";

export const defect: Defect = {
  name: "in-progress-reported-not-applied",
  requirement: "MWS-RES-2",
  summary: "create_ticket reports a same-key call during a pending one as not applied, though the keyed write is about to apply",
  mirrors: "none published; review B1",
  replaces: "keyedStateResult (src/mcp/keyed-states.ts) for create_ticket",
  wraps: true,
  requires: ["inflight"],
  apply(build) {
    const inner = build.tools.get("create_ticket")!;
    patchTool(build, "create_ticket", {
      async handler(args, deps, ctx) {
        const r = await inner.handler(args, deps, ctx);
        const sc = (r as { structuredContent?: { mws?: { code?: string } } }).structuredContent;
        if (sc?.mws?.code !== "in_progress") return r;
        // DEFECT: the keyed write's open outcome is reported as nothing applied.
        const out = rewriteShape(r, (m) => { m.outcome = "not_applied"; m.repeat = "no"; delete m.read_with; });
        const res = out as { content?: Array<{ type: string; text?: string }> };
        if (res.content?.[0]?.type === "text") res.content[0] = { type: "text", text: "Another call with this idempotency_key is running; nothing was written." };
        return out;
      },
    });
  },
};
