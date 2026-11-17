// The MCP layer's answers for the 0.3.0 key states (design rule 4, decision
// 0004). A keyed call's result describes the write the key identifies, even
// where this call applied nothing:
//
//   409 in_progress   the keyed write is still being applied: outcome unknown,
//                     code in_progress, repeat same_key (never not_applied)
//   410 key_expired   the keyed write was applied, its stored answer is gone
//                     (seams v2.1, B10): outcome applied, replayed: true,
//                     repeat read_first, with the execution record id from the
//                     tombstone (Tiny-Tracker-Execution names it too)
//   409 key_fenced    a run reset or a lookup closed the key with no write
//                     behind it: nothing was applied and nothing can be; use a
//                     new key
//
// The backend gives these answers only with the inflight and retention
// features, so the 0.1.0 surface never meets them.

import type { CallToolResult } from "@modelcontextprotocol/server";
import type { ApiResponse } from "./api.js";
import type { Build } from "./types.js";
import { applied, fail, notApplied, ok, unknownOutcome, type WriteContext } from "./results.js";
import { DEFAULT_RETENTION_MS, retentionSentence } from "../backend/expiry.js";

/** The answer for a keyed state, or undefined when the response is not one. */
export function keyedStateResult(res: ApiResponse, what: string, w?: WriteContext): CallToolResult | undefined {
  if (res.status !== 409 && res.status !== 410) return undefined;
  const body = (res.body ?? {}) as { error?: string; message?: string; execution_id?: string; result_digest?: string; committed_at?: string; objects?: Array<{ type: string; id: string }>; fenced_at?: string };
  if (res.status === 410 && body.error !== "key_expired") return undefined;
  if (body.error === "in_progress") {
    return fail("An earlier call with this idempotency_key is still being applied; this call wrote nothing. "
      + "Repeat it later with the same idempotency_key to get its result.", { written: "unknown", error: "in_progress" },
    w ? { ...unknownOutcome(w, "in_progress"), repeat: "same_key" } : undefined);
  }
  if (body.error === "key_expired") {
    const primary = w ? body.objects?.find((o) => o.type === w.type) : undefined;
    const ctx = w && primary && w.id === undefined && !w.parent ? { ...w, id: primary.id } : w;
    return ok(`The earlier call with this idempotency_key was applied (${body.execution_id}), but its stored answer is gone: `
      + `the key's retention is over. Nothing new was written; read ${what} to see it now.`,
    { replayed: true, written: false, execution_id: body.execution_id, result_digest: body.result_digest, committed_at: body.committed_at, objects: body.objects ?? [] },
    ctx ? { ...applied(ctx, { replayed: true }), repeat: "read_first", code: "key_expired", read_with: ctx.read } : undefined);
  }
  if (body.error === "key_fenced") {
    return fail(`This idempotency_key is closed (${body.message ?? "fenced"}). Nothing was written, and nothing can be written with it. `
      + "Use a new idempotency_key.", { error: "key_fenced" }, w ? notApplied(w, "key_fenced", { argument: "/idempotency_key" }) : undefined);
  }
  return undefined;
}

/**
 * With the retention feature, every key-accepting tool states the retention (FX-KEY-2), and so do the server instructions
 * (0.4.0). `retentionMs` is the configured retention when the process knows it (`all`, `stdio`, or `server` given
 * --key-retention); otherwise the default.
 */
export function applyRetentionStatement(build: Build, features: readonly string[], retentionMs: number = DEFAULT_RETENTION_MS): void {
  if (!features.includes("retention")) return;
  build.retention = retentionSentence(retentionMs);
  for (const [name, tool] of build.tools) {
    const props = (tool.input as { properties?: Record<string, unknown> }).properties ?? {};
    if (!("idempotency_key" in props)) continue;
    build.tools.set(name, { ...tool, description: `${tool.description} ${retentionSentence(retentionMs)}` });
  }
}
