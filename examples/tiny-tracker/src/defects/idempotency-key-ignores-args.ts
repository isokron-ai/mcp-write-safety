// DEFECT idempotency-key-ignores-args -- MWS-RETRY-2 (MUST), second clause
// A reused key with different arguments is refused, not answered as a replay.
//
// WRONG ON PURPOSE. Correct code: createTicket in src/mcp/tools/tickets.ts,
// which leaves keys to the backend; the backend compares the whole request.
//
// What goes wrong: create_ticket keeps its own cache of answers keyed by
// idempotency_key alone. A second call with the same key but a different
// title gets the first call's answer, marked as a replay. The caller believes
// its new ticket exists; it was never created.
//
// Mirrors: no published finding yet; added with the two negative idempotency
// cases (a new key is not a replay; a reused key with different arguments is
// refused) adopted for MWS-RETRY-2.

import type { CallToolResult } from "@modelcontextprotocol/server";
import type { Defect } from "./types.js";
import { patchTool } from "./types.js";

export const defect: Defect = {
  name: "idempotency-key-ignores-args",
  requirement: "MWS-RETRY-2",
  summary: "create_ticket answers any call with a seen idempotency_key from a cache, even with different arguments",
  mirrors: "none published; the MWS-RETRY-2 negative case",
  replaces: "createTicket (src/mcp/tools/tickets.ts)",
  wraps: true,
  apply(build) {
    const correct = build.tools.get("create_ticket")!;
    const answers = new Map<string, CallToolResult>(); // DEFECT: keyed by the key only, not by the request
    patchTool(build, "create_ticket", {
      async handler(args, deps) {
        const key = args.idempotency_key as string | undefined;
        if (key !== undefined && answers.has(key)) {
          const first = answers.get(key)!;
          return { ...first, structuredContent: { ...(first.structuredContent ?? {}), replayed: true } };
        }
        const result = (await correct.handler(args, deps)) as CallToolResult;
        if (key !== undefined && !result.isError) answers.set(key, result);
        return result;
      },
    });
  },
};
