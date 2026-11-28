// Research modes (scripts/sim/same-key-inflight): how create_ticket answers a call whose idempotency_key belongs to a call
// that is still being applied (the backend's 409 in_progress). Off unless TRACKER_SAME_KEY_ANSWER names one, and the CLI
// takes it only with --fixture-control and the inflight feature, so the release build never meets it. Evidence only: these
// modes exist to measure what different answers lead clients to do; none is a judgement of which answer is right.
//
//   A  "Conflict: nothing was written by this call."   outcome not_applied, code conflict (repeat read_first, read_with)
//   B  the correct build's own answer                   outcome unknown, code in_progress, repeat same_key (no change)
//   C  "409 Conflict: a request with this idempotency_key is in progress."   isError, no structuredContent, no outcome
//   D  the call waits for the first call with its key in this process to finish, then answers as a repeat after it:
//      a success is read again from the backend (its replay); a failure is the first call's own answer
//   E  "Failed."                                        outcome not_applied, code failed, repeat no
//
// A, C and E rewrite only the in_progress answer; every other answer of create_ticket is the correct build's.

import type { CallToolResult } from "@modelcontextprotocol/server";
import type { Build, ToolDef } from "./types.js";

export const SAME_KEY_ANSWER_ENV = "TRACKER_SAME_KEY_ANSWER";
export const SAME_KEY_ANSWERS = ["A", "B", "C", "D", "E"] as const;
export type SameKeyAnswer = (typeof SAME_KEY_ANSWERS)[number];
const TOOL = "create_ticket";

/** The mode TRACKER_SAME_KEY_ANSWER names; null when unset or empty. Throws on any other value (fail closed). */
export function parseSameKeyAnswer(raw: string | undefined): SameKeyAnswer | null {
  if (raw === undefined || raw === "") return null;
  if (!(SAME_KEY_ANSWERS as readonly string[]).includes(raw)) {
    throw new Error(`${SAME_KEY_ANSWER_ENV} must be one of ${SAME_KEY_ANSWERS.join(", ")} (got ${JSON.stringify(raw.slice(0, 40))})`);
  }
  return raw as SameKeyAnswer;
}

type Mws = Record<string, unknown>;
const mwsOf = (r: unknown): Mws | undefined => (r as { structuredContent?: { mws?: Mws } }).structuredContent?.mws;

/** An error result with the shape mirrored as the correct build writes it (the prose block, then the JSON block). */
function shaped(text: string, structured: Record<string, unknown>, mws: Mws): CallToolResult {
  const structuredContent = { ...structured, mws };
  return { content: [{ type: "text", text }, { type: "text", text: JSON.stringify(structuredContent) }], structuredContent, isError: true };
}

function rewriteInProgress(mode: "A" | "C" | "E", r: CallToolResult): CallToolResult {
  const m = mwsOf(r);
  if (m?.code !== "in_progress") return r;
  if (mode === "A") return shaped("Conflict: nothing was written by this call.", { written: false, error: "conflict" }, { ...m, outcome: "not_applied", code: "conflict", repeat: "read_first" });
  if (mode === "E") {
    const { read_with: _drop, ...rest } = m;
    return shaped("Failed.", { written: false, error: "failed" }, { ...rest, outcome: "not_applied", code: "failed", repeat: "no" });
  }
  return { content: [{ type: "text", text: "409 Conflict: a request with this idempotency_key is in progress." }], isError: true };
}

/** D: a call whose key a call in this process is still applying waits for it, then answers as a repeat after it. */
function blockAndReplay(inner: ToolDef["handler"]): ToolDef["handler"] {
  const running = new Map<string, { args: string; done: ReturnType<ToolDef["handler"]> }>();
  return async (args, deps, ctx) => {
    const key = typeof args?.idempotency_key === "string" ? (args.idempotency_key as string) : undefined;
    if (key === undefined) return inner(args, deps, ctx);
    const same = JSON.stringify(args);
    const first = running.get(key);
    if (first) {
      const r = (await first.done.catch(() => undefined)) as CallToolResult | undefined;
      // why: the first call's failure is the keyed write's result; a success is answered by the backend's own replay.
      if (r && r.isError === true && first.args === same) return r;
      return inner(args, deps, ctx);
    }
    const done: ReturnType<ToolDef["handler"]> = Promise.resolve().then(() => inner(args, deps, ctx));
    running.set(key, { args: same, done });
    try {
      return await done;
    } finally {
      if (running.get(key)?.done === done) running.delete(key);
    }
  };
}

/** Switches the mode on for create_ticket. B is the correct build and changes nothing. */
export function applySameKeyAnswer(build: Build, mode: SameKeyAnswer | null): void {
  if (mode === null || mode === "B") return;
  const tool = build.tools.get(TOOL);
  if (!tool) throw new Error(`${SAME_KEY_ANSWER_ENV} needs the ${TOOL} tool`);
  const inner = tool.handler.bind(tool);
  if (mode === "D") {
    build.tools.set(TOOL, { ...tool, handler: blockAndReplay(inner) });
    return;
  }
  const rewrite: "A" | "C" | "E" = mode;
  build.tools.set(TOOL, { ...tool, handler: async (args, deps, ctx) => rewriteInProgress(rewrite, (await inner(args, deps, ctx)) as CallToolResult) });
}
