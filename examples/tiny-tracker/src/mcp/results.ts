// How tools answer. Every result has one plain sentence for the model and a
// structured receipt for programs. Failures are always `isError: true`, and
// every failure says whether anything was written.

import type { CallToolResult } from "@modelcontextprotocol/server";
import type { ApiResponse } from "./api.js";
import { renderText } from "./text.js";

export type Structured = Record<string, unknown>;

/**
 * The result shape "write-result/0.1" (the draft MWS Annex B-9; mcp-writecheck adopts it with
 * `results: { shape: write-result/0.1 }`). Every write tool's result carries it as `structuredContent.mws`, on success
 * and on error, beside the tool's own output; the first text block says the outcome in words and a second carries the
 * serialized structuredContent, so a client that forwards only `content` shows the same facts to the model.
 */
export type Outcome = "applied" | "not_applied" | "partial" | "unknown" | "accepted";
export type Repeat = "no" | "yes" | "same_key" | "same_version" | "read_first";
/** An identifier or a version, in the JSON type the tools' arguments take (tiny-tracker: ticket ids are strings, versions integers). */
export type IdV = string | number;
export interface ConflictMember { current_version?: IdV; checked_by?: "backend" | "server"; current_state?: Record<string, unknown>; omitted?: string[]; held_by?: string }
export interface ShapeItem { index?: number; step?: string; id?: IdV; version?: IdV; outcome: "applied" | "not_applied" | "not_attempted" | "unknown"; code?: string; message?: string; conflict?: ConflictMember }
export interface WriteResult {
  shape: "write-result/0.1";
  outcome: Outcome;
  repeat?: Repeat;
  operation?: string;
  object?: { type?: string; id?: IdV; version?: IdV; scope?: string; parent?: { type?: string; id?: IdV; version?: IdV } };
  changed?: string[];
  replayed?: true;
  items?: ShapeItem[];
  applied_count?: number;
  code?: string;
  message?: string;
  argument?: string;
  argument_errors?: Array<{ argument: string; code?: string; message?: string }>;
  conflict?: ConflictMember;
  read_with?: { tool: string; arguments: Record<string, unknown> };
  version_argument?: string;
}

/**
 * What a write tool tells the helpers about the call, so that every result it gives, error or not, carries the shape.
 * `guard`: what keeps a repeat from applying twice, where the call carries one (its idempotency key, or the version it
 * read); it decides the `repeat` of an unknown outcome. `read`: the read that shows the object's state now.
 */
export interface WriteContext {
  operation: string;
  type: string;
  id?: string;
  /** The scope argument's value, where the tool has one (B-9: object.scope is the scope argument, never a parent). */
  scope?: string;
  /** For an object written inside another (a comment on a ticket). */
  parent?: { type: string; id: IdV };
  guard: "key" | "version" | null;
  read: { tool: string; arguments: Record<string, unknown> };
  /** The write tool's version argument, where it has one. */
  versionArgument?: string;
}

/** A field name, or a path with dots, as a JSON Pointer. */
export const pointer = (field: string): string => "/" + field.split(".").map((s) => s.replace(/~/g, "~0").replace(/\//g, "~1")).join("/");

function mws(outcome: Outcome, w: WriteContext | undefined, fields: Omit<WriteResult, "shape" | "outcome">): WriteResult {
  const object = w && (w.id !== undefined || fields.object) ? { type: w.type, ...(w.id !== undefined ? { id: w.id } : {}), ...(w.scope !== undefined ? { scope: w.scope } : {}), ...(w.parent ? { parent: { ...w.parent } } : {}), ...fields.object } : fields.object;
  const out: Record<string, unknown> = { shape: "write-result/0.1", outcome, ...(w ? { operation: w.operation } : {}) };
  for (const [k, v] of Object.entries({ ...fields, object })) if (v !== undefined) out[k] = v;
  if (w?.versionArgument && out["version_argument"] === undefined) out["version_argument"] = w.versionArgument;
  return out as unknown as WriteResult;
}

/**
 * An applied write: the object, its new version (as the backend gives it: an integer), the fields changed ([] for a no-op).
 * On a call with a key, a replay describes the keyed write and adds replayed: true (this call applied nothing); `changed` is
 * left out where the server does not know what the first call changed. `repeat` is the guard the call carried, else no.
 */
export function applied(w: WriteContext, o: { id?: string; version?: IdV; changed?: string[]; replayed?: boolean; items?: ShapeItem[]; parentVersion?: IdV } = {}): WriteResult {
  return mws("applied", w, {
    repeat: w.guard === "key" ? "same_key" : w.guard === "version" ? "same_version" : "no",
    object: { ...(o.id !== undefined ? { id: o.id } : {}), ...(o.version !== undefined ? { version: o.version } : {}), ...(w.parent && o.parentVersion !== undefined ? { parent: { ...w.parent, version: o.parentVersion } } : {}) },
    changed: o.changed?.map(pointer),
    replayed: o.replayed ? true : undefined,
    items: o.items,
  });
}

/** A refusal: nothing was written. A conflict asks for a read first; any other refusal would meet the same answer again. */
export function notApplied(w: WriteContext, code: string, extra: Omit<WriteResult, "shape" | "outcome"> = {}): WriteResult {
  return mws("not_applied", w, { repeat: code === "conflict" ? "read_first" : "no", code, ...(code === "conflict" ? { read_with: w.read } : {}), ...extra });
}

/** An open outcome: a request that changes state may have been applied. Repeat only with the call's own guard, else read first. */
export function unknownOutcome(w: WriteContext, code: string): WriteResult {
  return mws("unknown", w, { repeat: w.guard === "key" ? "same_key" : w.guard === "version" ? "same_version" : "read_first", code, read_with: w.read });
}

/** Puts the shape on a result: `structuredContent.mws`, and the serialized structuredContent as a further text block. */
export function withShape<T extends CallToolResult>(r: T, m: WriteResult | undefined): T {
  if (!m) return r;
  const structuredContent = { ...(r.structuredContent ?? {}), mws: m };
  return { ...r, content: [...(r.content ?? []), { type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
}

export function ok(text: string, structured: Structured, m?: WriteResult): CallToolResult {
  return withShape({ content: [{ type: "text", text }], structuredContent: structured }, m);
}

export function fail(text: string, structured: Structured = {}, m?: WriteResult): CallToolResult {
  return withShape({ content: [{ type: "text", text }], structuredContent: { written: false, ...structured }, isError: true }, m);
}

/**
 * A refused conditional write. One sentence, with or without the shape: it says that nothing was changed and which read to
 * make, by the kits' rules (src/mcp/text.ts), and never restates the state. The current version and a compact current
 * state (fields and labels, never the comment history) are in the structured body, and the serialized JSON block carries
 * them to a client that forwards only the content: a caller that resends its old value with the new version would
 * overwrite the other writer's change (MWS-CONC-6, Guidance; B-9, "Text").
 */
export function conflict(what: string, current: { version: number } | undefined, w?: WriteContext): CallToolResult {
  const version = current?.version;
  const compact = current ? Object.fromEntries(Object.entries(current as Record<string, unknown>).filter(([k]) => k !== "comments")) : undefined;
  const member: ConflictMember = { ...(version !== undefined ? { current_version: version } : {}), checked_by: "backend", ...(compact ? { current_state: compact, omitted: ["/comments"] } : {}) };
  const shape = w ? notApplied(w, "conflict", { conflict: member }) : undefined;
  // Without a write context (the older defects) the same facts give the same sentence, without a read tool to name.
  const text = renderText(shape ?? { shape: "write-result/0.1", outcome: "not_applied", repeat: "read_first", code: "conflict", conflict: member }, { summary: `${what} changed since the version you read` });
  const structuredContent = { conflict: true, written: false, reread_required: true, current_version: version, current: compact };
  const r: CallToolResult = { content: [{ type: "text", text }], structuredContent, isError: true };
  return shape ? withShape(r, shape) : { ...r, content: [...r.content, { type: "text", text: JSON.stringify(structuredContent) }] };
}

/** Names as a JSON list with a space after each comma: ["content", "v3"] (P-8). */
export function quotedNames(names: string[]): string {
  return JSON.stringify(names).replaceAll('","', '", "');
}

/** Maps a backend refusal to a tool error. Never includes the request (it holds the bearer token). */
export function fromBackend(res: ApiResponse, what: string, w?: WriteContext): CallToolResult {
  const body = (res.body ?? {}) as { error?: string; message?: string; field?: string; reason?: string; current?: { version: number } };
  // A read tool's error carries no shape; a write tool's always does: a refusal is not_applied, no answer or a 5xx unknown.
  const no = (code: string, extra: Omit<WriteResult, "shape" | "outcome"> = {}) => (w ? notApplied(w, code, { ...(body.message ? { message: body.message } : {}), ...extra }) : undefined);
  switch (res.status) {
    case 404:
      return fail(`Not found: ${what}${body.message && body.message !== what ? ` (${body.message})` : ""}. Nothing was written.`, { not_found: true }, no("not_found"));
    case 409:
      return fail(`${what}: ${body.message ?? "conflict"}. Nothing was written.`, { error: body.error }, no(body.error ?? "already_exists"));
    case 412:
      return conflict(what, body.current, w);
    case 422:
      return fail(body.field
        ? `Invalid ${body.field}: ${body.reason}. Nothing was written.`
        : `Refused: ${body.message ?? "invalid request"}. Nothing was written.`, { field: body.field, error: body.error },
      no(body.field ? "invalid_argument" : (body.error ?? "refused"), body.field ? { argument: pointer(body.field) } : {}));
    case 400:
    case 401:
    case 413:
    case 428:
      return fail(`${what}: the backend refused the request (${body.message ?? res.status}). Nothing was written.`,
        { error: body.error }, no(res.status === 428 ? "version_required" : (body.error ?? "refused")));
    case 0:
      return fail(`The tracker backend could not be reached or the connection broke. It is not known whether `
        + `the change was applied; read ${what} before retrying.`, { written: "unknown", error: "connection_failed" }, w ? unknownOutcome(w, "no_answer") : undefined);
    default:
      return fail(`The tracker backend answered ${res.status} (${body.error ?? "error"}). `
        + `It is not known whether the change was applied; read ${what} before retrying.`, { written: "unknown" }, w ? unknownOutcome(w, "backend_error") : undefined);
  }
}
